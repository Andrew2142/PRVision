/**
 * Parent side of the Vite host (10 §5.6.2): forks `vite-host-process` in its own process group with an
 * allow-listed environment, waits for `ready`, keeps a log ring buffer, and stops the child (and every
 * grandchild) with a process-group SIGKILL fallback. A global registry kills live children on process exit.
 *
 * This is a long-lived IPC child, so it is forked directly rather than through 04's `runProcess` (which runs
 * bounded commands to completion); it applies the same rules: argument array, own process group, group kill,
 * `CHILD_PROCESS_BASE_ENV` as the only base of the environment.
 */
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  CHILD_PROCESS_BASE_ENV,
  LOG_TEXT_MAX_LENGTH,
  VITE_HOST_LOG_BUFFER_SIZE,
  VITE_HOST_MAX_OLD_SPACE_MB,
  VITE_START_TIMEOUT_MS,
  VITE_STOP_TIMEOUT_MS
} from "../../../../config-consts";
import { createLogger } from "../../../../utilities";
import {
  isViteHostEvent,
  STICKY_START_FAILURES,
  type RenderSide,
  type ViteHostEvent,
  type ViteHostHandle,
  type ViteHostLogLevel,
  type ViteHostStartFailureKind,
  type ViteHostStartOptions,
  type ViteLogEntry
} from "./render-types";

export type { ViteHostHandle, ViteLogEntry } from "./render-types";

const log = createLogger("render");

const OUTPUT_LINES_MAX = 2_000;
const KILL_EXIT_WAIT_MS = 1_000;
const EXIT_LOG_TAIL = 5;
const REOPTIMIZE_PATTERN = /optimized dependencies changed|new dependencies optimized/i;

/** Debug-log free text is capped at LOG_TEXT_MAX_LENGTH (01 §5.8). */
function truncateForLog(text: string): string {
  return text.length > LOG_TEXT_MAX_LENGTH ? `${text.slice(0, LOG_TEXT_MAX_LENGTH)}…` : text;
}

/** Absolute path of the child entry: `.ts` under ts-node (dev, tests), `.js` from `dist`. */
export function hostEntryPath(): string {
  return path.join(__dirname, `vite-host-process${path.extname(__filename)}`);
}

/** The backend tsconfig.json, resolved from this module's own location (never the target repo's). */
export function backendTsconfigPath(): string {
  return path.resolve(__dirname, "../../../../../tsconfig.json");
}

/**
 * Environment of the Vite host child: the allow-listed base plus fixed Vite values. Never reads process.env and
 * copies nothing from the parent beyond `base`, so DATABASE_URL, REDIS_URL, PRVISION_*, ANTHROPIC_*, GITHUB_* and
 * NODE_OPTIONS are absent.
 *
 * @param base - Allow-listed parent variables (default CHILD_PROCESS_BASE_ENV).
 * @param entryIsTypeScript - Adds the ts-node settings when the entry is `.ts`.
 */
export function buildChildEnv(
  base: Readonly<Record<string, string>> = CHILD_PROCESS_BASE_ENV,
  entryIsTypeScript: boolean = hostEntryPath().endsWith(".ts")
): Record<string, string> {
  const fixed: Record<string, string> = {
    NODE_ENV: "development",
    BROWSER: "none",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    BROWSERSLIST_IGNORE_OLD_DATA: "1",
    ...(entryIsTypeScript ? { TS_NODE_TRANSPILE_ONLY: "true", TS_NODE_PROJECT: backendTsconfigPath() } : {})
  };
  return { ...base, ...fixed };
}

/**
 * Node flags of the child, built from scratch (never copied from process.execArgv: ts-node-dev and inspector
 * flags must not leak). The ts-node hook is resolved to an absolute path because the child's cwd is the target
 * repository, whose node_modules has no ts-node.
 *
 * @param entryPath - The host entry that will be forked.
 */
export function childExecArgv(entryPath: string = hostEntryPath()): string[] {
  const args = [`--max-old-space-size=${String(VITE_HOST_MAX_OLD_SPACE_MB)}`];
  if (entryPath.endsWith(".ts")) {
    args.push("-r", require.resolve("ts-node/register/transpile-only"));
  }
  return args;
}

/** A Vite host that could not be started. `sticky` failures repeat for every group on the same side. */
export class ViteHostStartError extends Error {
  override readonly name = "ViteHostStartError";

  constructor(
    message: string,
    readonly kind: ViteHostStartFailureKind | "timeout" | "exited" | "aborted",
    readonly detail: string | null
  ) {
    super(message);
  }

  get sticky(): boolean {
    return (
      this.kind !== "timeout" &&
      this.kind !== "exited" &&
      this.kind !== "aborted" &&
      STICKY_START_FAILURES.has(this.kind)
    );
  }
}

/** Test seams for `ViteHostClient.start` (production code uses the defaults). */
export interface ViteHostClientOverrides {
  entryPath?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function killGroupSync(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
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

class LiveViteHost implements ViteHostHandle {
  readonly origin: string;
  readonly viteVersion: string;
  readonly reactDomVersion: string;
  readonly tailwindMajor: 3 | 4 | null;
  readonly warnings: readonly string[];
  private readonly buffer: ViteLogEntry[] = [];
  private seq = 0;
  private stopping: Promise<void> | null = null;
  private exitText: string | null = null;

  constructor(
    private readonly child: ChildProcess,
    readonly side: RenderSide,
    readonly groupKey: string,
    readonly harnessUrlPath: string,
    ready: Extract<ViteHostEvent, { type: "ready" }>,
    earlyLogs: ReadonlyArray<{ level: ViteHostLogLevel; message: string; at: number }>,
    private readonly stopTimeoutMs: number
  ) {
    this.origin = ready.origin;
    this.viteVersion = ready.viteVersion;
    this.reactDomVersion = ready.reactDomVersion;
    this.tailwindMajor = ready.tailwindMajor;
    this.warnings = [...ready.warnings];
    for (const entry of earlyLogs) {
      this.push(entry.level, entry.message, entry.at);
    }
    child.on("message", (raw: unknown) => {
      if (isViteHostEvent(raw) && raw.type === "log") {
        this.push(raw.level, raw.message, raw.at);
      }
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitText = `exited with code ${String(code)} (signal ${String(signal)})`;
    });
  }

  private push(level: ViteHostLogLevel, message: string, at: number): void {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, level, message, at });
    if (this.buffer.length > VITE_HOST_LOG_BUFFER_SIZE) {
      this.buffer.shift();
    }
    if (level !== "info") {
      log.debug(
        {
          event: "render.vite_host.output",
          side: this.side,
          groupKey: this.groupKey,
          stream: level,
          line: truncateForLog(message)
        },
        "Vite host output"
      );
    }
  }

  isAlive(): boolean {
    return isAlive(this.child);
  }

  exitReason(): string | null {
    if (this.exitText !== null) {
      return this.exitText;
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return `exited with code ${String(this.child.exitCode)} (signal ${String(this.child.signalCode)})`;
    }
    return null;
  }

  currentSeq(): number {
    return this.seq;
  }

  logsSince(seq: number, level?: "warn" | "error"): ViteLogEntry[] {
    return this.buffer.filter(
      (entry) =>
        entry.seq > seq &&
        (level === undefined || entry.level === "error" || (level === "warn" && entry.level === "warn"))
    );
  }

  sawDepsReoptimizeSince(seq: number): boolean {
    return this.buffer.some((entry) => entry.seq > seq && REOPTIMIZE_PATTERN.test(entry.message));
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopNow();
    return this.stopping;
  }

  private async stopNow(): Promise<void> {
    try {
      if (isAlive(this.child)) {
        if (this.child.connected) {
          try {
            this.child.send({ type: "shutdown" });
          } catch {
            // Channel already closed; fall through to the group kill.
          }
        }
        await waitForExit(this.child, this.stopTimeoutMs);
      }
      // Always kill the group: plugin grandchildren (esbuild, Tailwind workers) may outlive the leader.
      killGroupSync(this.child);
      await waitForExit(this.child, KILL_EXIT_WAIT_MS);
    } catch (error) {
      log.warn({ event: "render.cleanup.failed", side: this.side, err: error }, "Stopping a Vite host failed");
    } finally {
      ViteHostClient.forget(this.child);
    }
  }
}

/** Starts Vite host children; tracks live ones so they can be killed on process exit. */
export class ViteHostClient {
  /** Live children, killed with SIGKILL on process "exit" (registered once). */
  private static readonly live = new Set<ChildProcess>();

  /** Number of children that have not been stopped yet. */
  static liveCount(): number {
    return ViteHostClient.live.size;
  }

  /** Removes a child from the registry (after it has been stopped). */
  static forget(child: ChildProcess): void {
    ViteHostClient.live.delete(child);
  }

  /** Synchronously SIGKILLs every live child's process group (process "exit" handler). */
  static killAllSync(): void {
    for (const child of ViteHostClient.live) {
      killGroupSync(child);
    }
  }

  /**
   * Forks a Vite host for one side and render group and waits for its `ready` message.
   *
   * @param options - Start options sent to the child.
   * @param harnessUrlPath - Root-relative URL of the harness page.
   * @param signal - Job signal; aborting kills the group.
   * @param overrides - Test seams (entry path, timeouts).
   * @returns A handle to the running host.
   * @throws ViteHostStartError (`start_failed` kinds, `timeout`, `exited`, `aborted`).
   */
  static async start(
    options: ViteHostStartOptions,
    harnessUrlPath: string,
    signal: AbortSignal,
    overrides: ViteHostClientOverrides = {}
  ): Promise<ViteHostHandle> {
    if (signal.aborted) {
      throw new ViteHostStartError("Cancelled", "aborted", null);
    }
    const entryPath = overrides.entryPath ?? hostEntryPath();
    const startTimeoutMs = overrides.startTimeoutMs ?? VITE_START_TIMEOUT_MS;
    const stopTimeoutMs = overrides.stopTimeoutMs ?? VITE_STOP_TIMEOUT_MS;
    const child = fork(entryPath, [], {
      cwd: options.viteRoot,
      env: buildChildEnv(CHILD_PROCESS_BASE_ENV, entryPath.endsWith(".ts")),
      execArgv: childExecArgv(entryPath),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
      detached: true
    });
    ViteHostClient.live.add(child);
    pipeOutput(child, options);
    child.on("error", (error: Error) => {
      log.warn({ event: "render.vite_host.start_failed", side: options.side, err: error }, "Vite host process error");
    });

    const earlyLogs: Array<{ level: ViteHostLogLevel; message: string; at: number }> = [];
    const startedAt = Date.now();
    try {
      const ready = await waitForReady(child, options, signal, startTimeoutMs, earlyLogs);
      const handle = new LiveViteHost(
        child,
        options.side,
        options.groupKey,
        harnessUrlPath,
        ready,
        earlyLogs,
        stopTimeoutMs
      );
      log.info(
        {
          event: "render.vite_host.ready",
          side: options.side,
          groupKey: options.groupKey,
          viteVersion: ready.viteVersion,
          origin: ready.origin,
          startMs: Date.now() - startedAt
        },
        "Vite host ready"
      );
      return handle;
    } catch (error) {
      killGroupSync(child);
      await waitForExit(child, KILL_EXIT_WAIT_MS);
      ViteHostClient.live.delete(child);
      const startError =
        error instanceof ViteHostStartError ? error : new ViteHostStartError(String(error), "exited", null);
      log.warn(
        {
          event: "render.vite_host.start_failed",
          side: options.side,
          groupKey: options.groupKey,
          kind: startError.kind,
          message: startError.message,
          detail: startError.detail === null ? null : truncateForLog(startError.detail)
        },
        "Vite host start failed"
      );
      throw startError;
    }
  }
}

process.once("exit", () => {
  ViteHostClient.killAllSync();
});

function pipeOutput(child: ChildProcess, options: ViteHostStartOptions): void {
  let lines = 0;
  let truncatedLogged = false;
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
          if (!truncatedLogged) {
            truncatedLogged = true;
            log.debug(
              {
                event: "render.vite_host.output",
                side: options.side,
                groupKey: options.groupKey,
                stream,
                line: "output truncated"
              },
              "Vite host output"
            );
          }
          continue; // keep draining
        }
        lines += 1;
        log.debug(
          {
            event: "render.vite_host.output",
            side: options.side,
            groupKey: options.groupKey,
            stream,
            line: truncateForLog(line)
          },
          "Vite host output"
        );
      }
    });
  }
}

function waitForReady(
  child: ChildProcess,
  options: ViteHostStartOptions,
  signal: AbortSignal,
  startTimeoutMs: number,
  earlyLogs: Array<{ level: ViteHostLogLevel; message: string; at: number }>
): Promise<Extract<ViteHostEvent, { type: "ready" }>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onMessage = (raw: unknown): void => {
      if (!isViteHostEvent(raw)) {
        return;
      }
      switch (raw.type) {
        case "ready":
          finish(() => {
            resolve(raw);
          });
          return;
        case "start_failed":
          finish(() => {
            reject(new ViteHostStartError(raw.message, raw.kind, raw.detail));
          });
          return;
        case "log":
          earlyLogs.push({ level: raw.level, message: raw.message, at: raw.at });
          if (earlyLogs.length > VITE_HOST_LOG_BUFFER_SIZE) {
            earlyLogs.shift();
          }
          return;
        case "closed":
          return;
      }
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      const lastErrors = earlyLogs
        .filter((entry) => entry.level === "error")
        .slice(-EXIT_LOG_TAIL)
        .map((entry) => entry.message);
      const reason = `exited with code ${String(code)} (signal ${String(exitSignal)})`;
      const lastError = lastErrors.at(-1)?.split("\n")[0] ?? "none";
      finish(() => {
        reject(
          new ViteHostStartError(
            `The Vite dev server process exited unexpectedly (${reason}). Last error: ${lastError}`,
            "exited",
            lastErrors.length > 0 ? lastErrors.join("\n") : null
          )
        );
      });
    };
    const onAbort = (): void => {
      finish(() => {
        reject(new ViteHostStartError("Cancelled", "aborted", null));
      });
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(
          new ViteHostStartError(
            `The Vite dev server for the ${options.side} side did not become ready within ${String(
              Math.round(startTimeoutMs / 1000)
            )} s.`,
            "timeout",
            null
          )
        );
      });
    }, startTimeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      child.send({ type: "start", options });
    } catch (error) {
      finish(() => {
        reject(new ViteHostStartError(`Could not start the Vite host: ${String(error)}`, "exited", null));
      });
    }
  });
}
