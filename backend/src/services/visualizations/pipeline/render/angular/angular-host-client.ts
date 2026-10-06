/**
 * Parent side of the Angular host (15 §5.7.7): one long-lived child per side and render run, forked lazily in its
 * own process group with an allow-listed environment and a heap cap. Builds are sequential; each one is bounded
 * by ANGULAR_BUILD_TIMEOUT_MS. A child that dies is replaced by the next build. Timeout, cancellation and stop
 * kill the whole process group (SIGTERM, then SIGKILL after 2 s), and a global registry kills live children when
 * the worker exits.
 *
 * Like 10's Vite host this is a long-lived IPC child, so it is forked directly (argument array, own process group,
 * group kill, `CHILD_PROCESS_BASE_ENV` as the only base of the environment) instead of through `runProcess`.
 */
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  ANGULAR_BUILD_TIMEOUT_MS,
  ANGULAR_HOST_MAX_OLD_SPACE_MB,
  ANGULAR_HOST_START_TIMEOUT_MS,
  ANGULAR_HOST_STOP_TIMEOUT_MS,
  CHILD_PROCESS_BASE_ENV,
  LOG_TEXT_MAX_LENGTH
} from "../../../../../config-consts";
import { createLogger } from "../../../../../utilities";
import type { RenderSide } from "../render-types";
import {
  isAngularHostEvent,
  type AngularHostEvent,
  type AngularHostLogLevel,
  type AngularHostVersions
} from "./angular-host-protocol";

const log = createLogger("render");

const KILL_GRACE_MS = 2_000;
const KILL_EXIT_WAIT_MS = 1_000;
const BUILD_LOG_ENTRIES_MAX = 500;
const OUTPUT_LINES_MAX = 2_000;

/** One builder log entry of a build. */
export interface AngularBuildLogEntry {
  level: AngularHostLogLevel;
  message: string;
}

/** What the parent asks the child to build (the child adds `buildId`). */
export interface AngularBuildRequest {
  buildKey: string;
  projectName: string;
  builderName: string;
  options: Record<string, unknown>;
  projectExtensions: Record<string, unknown>;
}

/** Result of one build request. Never thrown. */
export type AngularBuildOutcome =
  | { status: "success"; outputDir: string; durationMs: number; logs: AngularBuildLogEntry[] }
  /** The builder ran and reported errors (diagnostics are in `logs`). */
  | { status: "failed"; durationMs: number; logs: AngularBuildLogEntry[] }
  /**
   * The build tools are unusable on this side. `sticky` (Architect could not be loaded) repeats for every build;
   * otherwise (child exited, did not start in time) the next build starts a new child.
   */
  | { status: "unavailable"; sticky: boolean; message: string; durationMs: number; logs: AngularBuildLogEntry[] }
  | { status: "timeout"; message: string; durationMs: number; logs: AngularBuildLogEntry[] }
  | { status: "cancelled"; durationMs: number; logs: AngularBuildLogEntry[] };

/** The build host one side of a render run uses (tests substitute a fake). */
export interface AngularBuildHost {
  readonly side: RenderSide;
  /** Installed versions reported by the current child, or null before the first successful start. */
  versions(): AngularHostVersions | null;
  /** Runs one build; starts (or restarts) the child when needed. Never throws. */
  build(request: AngularBuildRequest, signal: AbortSignal): Promise<AngularBuildOutcome>;
  /** Shuts the child down (group kill after ANGULAR_HOST_STOP_TIMEOUT_MS). Idempotent; never throws. */
  stop(): Promise<void>;
}

/** Test seams for `AngularHostClient` (production code uses the defaults). */
export interface AngularHostClientOverrides {
  entryPath?: string;
  startTimeoutMs?: number;
  buildTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Absolute path of the child entry: `.ts` under ts-node (dev, tests), `.js` from `dist`. */
export function angularHostEntryPath(): string {
  return path.join(__dirname, `angular-host-process${path.extname(__filename)}`);
}

/** The backend tsconfig.json, resolved from this module's own location (never the target repo's). */
function backendTsconfigPath(): string {
  return path.resolve(__dirname, "../../../../../../tsconfig.json");
}

/**
 * Environment of the Angular host child (15 §5.7.7): the allow-listed base plus fixed values. `CI` is never set,
 * and nothing else from the parent is copied, so DATABASE_URL, REDIS_URL and PRVISION_* never reach the builder.
 *
 * @param base - Allow-listed parent variables (default CHILD_PROCESS_BASE_ENV).
 * @param entryIsTypeScript - Adds the ts-node settings when the entry is `.ts`.
 */
export function buildAngularChildEnv(
  base: Readonly<Record<string, string>> = CHILD_PROCESS_BASE_ENV,
  entryIsTypeScript: boolean = angularHostEntryPath().endsWith(".ts")
): Record<string, string> {
  const { CI: _ci, ...rest } = base;
  return {
    ...rest,
    NG_CLI_ANALYTICS: "false",
    NG_FORCE_TTY: "false",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NODE_OPTIONS: `--max-old-space-size=${String(ANGULAR_HOST_MAX_OLD_SPACE_MB)}`,
    ...(entryIsTypeScript ? { TS_NODE_TRANSPILE_ONLY: "true", TS_NODE_PROJECT: backendTsconfigPath() } : {})
  };
}

/**
 * Node flags of the child, built from scratch (never copied from process.execArgv). The ts-node hook is resolved
 * to an absolute path because the child's cwd is the target repository.
 */
export function angularChildExecArgv(entryPath: string = angularHostEntryPath()): string[] {
  const args = [`--max-old-space-size=${String(ANGULAR_HOST_MAX_OLD_SPACE_MB)}`];
  if (entryPath.endsWith(".ts")) {
    args.push("-r", require.resolve("ts-node/register/transpile-only"));
  }
  return args;
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function killGroupSync(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone (ESRCH).
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isAlive(child)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/** SIGTERM to the group, SIGKILL after KILL_GRACE_MS; always SIGKILLs the group at the end (grandchildren). */
async function terminateGroup(child: ChildProcess): Promise<void> {
  if (isAlive(child)) {
    killGroupSync(child, "SIGTERM");
    if (!(await waitForExit(child, KILL_GRACE_MS))) {
      killGroupSync(child, "SIGKILL");
    }
  }
  killGroupSync(child, "SIGKILL");
  await waitForExit(child, KILL_EXIT_WAIT_MS);
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  return `exit code ${String(code)}, signal ${String(signal)}`;
}

function truncateForLog(text: string): string {
  return text.length > LOG_TEXT_MAX_LENGTH ? `${text.slice(0, LOG_TEXT_MAX_LENGTH)}…` : text;
}

type StartResult =
  | { ok: true; child: ChildProcess; versions: AngularHostVersions }
  | { ok: false; sticky: boolean; message: string; cancelled: boolean };

/** Angular host for one side of a render run. */
export class AngularHostClient implements AngularBuildHost {
  /** Live children of every client, killed with SIGKILL on process "exit". */
  private static readonly live = new Set<ChildProcess>();

  /** Number of children that have not been stopped yet. */
  static liveCount(): number {
    return AngularHostClient.live.size;
  }

  /** Synchronously SIGKILLs every live child's process group (process "exit" handler). */
  static killAllSync(): void {
    for (const child of AngularHostClient.live) {
      killGroupSync(child, "SIGKILL");
    }
  }

  private child: ChildProcess | null = null;
  private currentVersions: AngularHostVersions | null = null;
  private fatal: string | null = null;
  private buildCounter = 0;
  private stopped = false;
  private readonly entryPath: string;
  private readonly startTimeoutMs: number;
  private readonly buildTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  /**
   * @param side - The side this host builds.
   * @param workspaceRoot - `<worktree>/<appRoot>` (holds angular.json); the child's cwd.
   * @param overrides - Test seams.
   */
  constructor(
    readonly side: RenderSide,
    readonly workspaceRoot: string,
    overrides: AngularHostClientOverrides = {}
  ) {
    this.entryPath = overrides.entryPath ?? angularHostEntryPath();
    this.startTimeoutMs = overrides.startTimeoutMs ?? ANGULAR_HOST_START_TIMEOUT_MS;
    this.buildTimeoutMs = overrides.buildTimeoutMs ?? ANGULAR_BUILD_TIMEOUT_MS;
    this.stopTimeoutMs = overrides.stopTimeoutMs ?? ANGULAR_HOST_STOP_TIMEOUT_MS;
  }

  versions(): AngularHostVersions | null {
    return this.currentVersions;
  }

  /** PID of the current child (tests). */
  pid(): number | null {
    return this.child?.pid ?? null;
  }

  async build(request: AngularBuildRequest, signal: AbortSignal): Promise<AngularBuildOutcome> {
    const startedAt = Date.now();
    const elapsed = (): number => Date.now() - startedAt;
    if (signal.aborted || this.stopped) {
      return { status: "cancelled", durationMs: 0, logs: [] };
    }
    if (this.fatal !== null) {
      return { status: "unavailable", sticky: true, message: this.fatal, durationMs: 0, logs: [] };
    }
    if (this.child === null || !isAlive(this.child)) {
      const started = await this.startChild(signal);
      if (!started.ok) {
        if (started.cancelled) {
          return { status: "cancelled", durationMs: elapsed(), logs: [] };
        }
        if (started.sticky) {
          this.fatal = started.message;
        }
        return {
          status: "unavailable",
          sticky: started.sticky,
          message: started.message,
          durationMs: elapsed(),
          logs: []
        };
      }
      this.child = started.child;
      this.currentVersions = started.versions;
    }
    return this.runBuild(this.child, request, signal, startedAt);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child === null) {
      return;
    }
    try {
      if (isAlive(child) && child.connected) {
        try {
          child.send({ type: "shutdown" });
        } catch {
          // Channel already closed; fall through to the group kill.
        }
        await waitForExit(child, this.stopTimeoutMs);
      }
      await terminateGroup(child);
    } catch (error) {
      log.warn({ event: "render.cleanup.failed", side: this.side, err: error }, "Stopping an Angular host failed");
    } finally {
      AngularHostClient.live.delete(child);
    }
  }

  private async discard(child: ChildProcess): Promise<void> {
    if (this.child === child) {
      this.child = null;
    }
    await terminateGroup(child);
    AngularHostClient.live.delete(child);
  }

  private async startChild(signal: AbortSignal): Promise<StartResult> {
    const child = fork(this.entryPath, [], {
      cwd: this.workspaceRoot,
      env: buildAngularChildEnv(CHILD_PROCESS_BASE_ENV, this.entryPath.endsWith(".ts")),
      execArgv: angularChildExecArgv(this.entryPath),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
      detached: true
    });
    AngularHostClient.live.add(child);
    pipeOutput(child, this.side);
    child.on("error", (error: Error) => {
      log.warn({ event: "render.angular.host.exited", side: this.side, err: error }, "Angular host process error");
    });
    child.once("exit", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      AngularHostClient.live.delete(child);
      log.info(
        { event: "render.angular.host.exited", side: this.side, pid: child.pid, code, signal: exitSignal },
        "Angular host exited"
      );
    });
    const result = await waitForReady(child, signal, this.startTimeoutMs, this.side);
    if (!result.ok) {
      await this.discard(child);
      return result;
    }
    log.info(
      { event: "render.angular.host.started", side: this.side, pid: child.pid, versions: result.versions },
      "Angular host started"
    );
    return result;
  }

  private runBuild(
    child: ChildProcess,
    request: AngularBuildRequest,
    signal: AbortSignal,
    startedAt: number
  ): Promise<AngularBuildOutcome> {
    this.buildCounter += 1;
    const buildId = `${request.buildKey}#${String(this.buildCounter)}`;
    const logs: AngularBuildLogEntry[] = [];
    const elapsed = (): number => Date.now() - startedAt;
    return new Promise<AngularBuildOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: AngularBuildOutcome, kill: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        signal.removeEventListener("abort", onAbort);
        if (!kill) {
          resolve(outcome);
          return;
        }
        const resolveAfterKill = async (): Promise<void> => {
          try {
            await this.discard(child);
          } finally {
            resolve(outcome);
          }
        };
        resolveAfterKill().catch((error: unknown) => {
          log.warn({ event: "render.cleanup.failed", side: this.side, err: error }, "Killing an Angular host failed");
        });
      };
      const onMessage = (raw: unknown): void => {
        if (!isAngularHostEvent(raw)) {
          return;
        }
        if (raw.type === "log" && raw.buildId === buildId) {
          if (logs.length < BUILD_LOG_ENTRIES_MAX) {
            logs.push({ level: raw.level, message: raw.message });
          }
          return;
        }
        if (raw.type === "result" && raw.buildId === buildId) {
          if (raw.success && raw.outputDir !== null) {
            finish({ status: "success", outputDir: raw.outputDir, durationMs: elapsed(), logs }, false);
          } else {
            finish({ status: "failed", durationMs: elapsed(), logs }, false);
          }
        }
      };
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        finish(
          {
            status: "unavailable",
            sticky: false,
            message: `The Angular build process exited (${exitText(code, exitSignal)}).`,
            durationMs: elapsed(),
            logs
          },
          true
        );
      };
      const onAbort = (): void => {
        finish({ status: "cancelled", durationMs: elapsed(), logs }, true);
      };
      const timer = setTimeout(() => {
        finish(
          {
            status: "timeout",
            message: `The Angular build did not finish within ${String(Math.round(this.buildTimeoutMs / 1000))} s.`,
            durationMs: elapsed(),
            logs
          },
          true
        );
      }, this.buildTimeoutMs);
      child.on("message", onMessage);
      child.once("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        child.send({
          type: "build",
          buildId,
          projectName: request.projectName,
          builderName: request.builderName,
          options: request.options,
          projectExtensions: request.projectExtensions
        });
      } catch (error) {
        finish(
          {
            status: "unavailable",
            sticky: false,
            message: `The Angular build process could not be reached: ${String(error)}`,
            durationMs: elapsed(),
            logs
          },
          true
        );
      }
    });
  }
}

process.once("exit", () => {
  AngularHostClient.killAllSync();
});

function waitForReady(
  child: ChildProcess,
  signal: AbortSignal,
  startTimeoutMs: number,
  side: RenderSide
): Promise<StartResult> {
  return new Promise<StartResult>((resolve) => {
    let settled = false;
    const finish = (result: StartResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onMessage = (raw: unknown): void => {
      if (!isAngularHostEvent(raw)) {
        return;
      }
      const event: AngularHostEvent = raw;
      if (event.type === "ready") {
        finish({ ok: true, child, versions: event.versions });
      } else if (event.type === "fatal") {
        finish({ ok: false, sticky: true, cancelled: false, message: event.message });
      }
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      finish({
        ok: false,
        sticky: false,
        cancelled: false,
        message: `The Angular build process exited before it was ready (${exitText(code, exitSignal)}).`
      });
    };
    const onAbort = (): void => {
      finish({ ok: false, sticky: false, cancelled: true, message: "Cancelled." });
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        sticky: false,
        cancelled: false,
        message: `The Angular build tools for the ${side} side did not start within ${String(
          Math.round(startTimeoutMs / 1000)
        )} s.`
      });
    }, startTimeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function pipeOutput(child: ChildProcess, side: RenderSide): void {
  let lines = 0;
  for (const [stream, readable] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr]
  ] as const) {
    if (readable === null) {
      continue;
    }
    readable.setEncoding("utf8");
    let carry = "";
    readable.on("data", (chunk: string) => {
      const parts = `${carry}${chunk}`.split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) {
        if (lines >= OUTPUT_LINES_MAX) {
          continue; // keep draining
        }
        lines += 1;
        log.debug(
          { event: "render.angular.host.output", side, stream, line: truncateForLog(line) },
          "Angular host output"
        );
      }
    });
  }
}
