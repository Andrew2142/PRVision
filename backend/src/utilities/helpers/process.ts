import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CHILD_PROCESS_BASE_ENV, CHILD_PROCESS_MAX_BUFFER_BYTES, PROCESS_KILL_GRACE_MS } from "../../config-consts";
import { createLogger } from "../loggers/logger";

const log = createLogger("process");

/** Options of runProcess (01 §5.9.3). */
export interface RunProcessOptions {
  cwd: string;
  /** Default CHILD_PROCESS_BASE_ENV (never raw process.env). */
  env?: Readonly<Record<string, string>>;
  /** Required: no unbounded children. */
  timeoutMs: number;
  /** Per stream; default CHILD_PROCESS_MAX_BUFFER_BYTES. */
  maxBufferBytes?: number;
  /** Written to stdin, which is then closed. */
  input?: string | Buffer;
  /** Default [0]. */
  allowedExitCodes?: readonly number[];
  signal?: AbortSignal;
  /** e.g. "git diff"; args are never logged. */
  logLabel?: string;
}

/** Result of a child that exited with an allowed code. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export type ProcessErrorKind = "spawn_failed" | "timeout" | "aborted" | "max_buffer" | "non_zero_exit";

/**
 * Failure of runProcess. `message` is "<label> failed (<kind>[, exit <code>])" and never contains argv, env or
 * output; `stdout`/`stderr` are raw (callers redact before persisting or logging).
 */
export class ProcessError extends Error {
  constructor(
    message: string,
    readonly kind: ProcessErrorKind,
    readonly command: string,
    readonly exitCode: number | null,
    readonly signalName: NodeJS.Signals | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly durationMs: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ProcessError";
  }
}

type KillReason = "timeout" | "aborted" | "max_buffer";

/**
 * Runs a child process with an argument array (never a shell), a mandatory timeout, per-stream output caps,
 * abort support and an allow-listed environment. The child gets its own process group, and a kill (timeout,
 * abort, buffer overflow) reaches the whole group: SIGTERM, then SIGKILL after PROCESS_KILL_GRACE_MS.
 *
 * @param command - Executable, resolved through the child's PATH.
 * @param args - Argument array, passed verbatim.
 * @param options - See RunProcessOptions.
 * @returns stdout/stderr (UTF-8), exit code and duration.
 * @throws ProcessError with kind spawn_failed | timeout | aborted | max_buffer | non_zero_exit.
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions
): Promise<ProcessResult> {
  const label = options.logLabel ?? path.basename(command);
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const maxBufferBytes = options.maxBufferBytes ?? CHILD_PROCESS_MAX_BUFFER_BYTES;
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  if (options.signal?.aborted) {
    log.debug({ event: "process.finished", label, exitCode: null, durationMs: 0, kind: "aborted" }, "process finished");
    throw new ProcessError(`${label} failed (aborted)`, "aborted", label, null, null, "", "", 0);
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? CHILD_PROCESS_BASE_ENV,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      shell: false
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killReason: KillReason | null = null;
    let closed = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };

    const kill = (reason: KillReason): void => {
      if (killReason !== null || closed) {
        return;
      }
      killReason = reason;
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        // The group may outlive the direct child (a grandchild ignoring SIGTERM): always SIGKILL the group.
        signalGroup("SIGKILL");
      }, PROCESS_KILL_GRACE_MS);
      graceTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      kill("timeout");
    }, options.timeoutMs);

    const onAbort = (): void => {
      kill("aborted");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (error: ProcessError | null, result: ProcessResult | null, exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      log.debug(
        {
          event: "process.finished",
          label,
          exitCode,
          durationMs: error?.durationMs ?? result?.durationMs ?? elapsed(),
          kind: error?.kind
        },
        "process finished"
      );
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        kill("max_buffer");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBufferBytes) {
        kill("max_buffer");
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (error: Error) => {
      // ENOENT/EACCES at spawn. "close" may not follow, so settle here.
      closed = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      finish(
        new ProcessError(
          `${label} failed (spawn_failed)`,
          "spawn_failed",
          label,
          null,
          null,
          stdout,
          stderr,
          elapsed(),
          {
            cause: error
          }
        ),
        null,
        null
      );
    });

    child.on("close", (code: number | null, signalName: NodeJS.Signals | null) => {
      closed = true;
      const durationMs = elapsed();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (killReason !== null) {
        // Keep the grace timer: grandchildren in the group may still be alive and must receive SIGKILL.
        finish(
          new ProcessError(
            `${label} failed (${killReason})`,
            killReason,
            label,
            code,
            signalName,
            stdout,
            stderr,
            durationMs
          ),
          null,
          code
        );
        return;
      }
      if (code !== null && allowedExitCodes.includes(code)) {
        finish(null, { stdout, stderr, exitCode: code, durationMs }, code);
        return;
      }
      const exitText = code === null ? `signal ${signalName ?? "unknown"}` : `exit ${code}`;
      finish(
        new ProcessError(
          `${label} failed (non_zero_exit, ${exitText})`,
          "non_zero_exit",
          label,
          code,
          signalName,
          stdout,
          stderr,
          durationMs
        ),
        null,
        code
      );
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // The child may exit before reading its input; EPIPE is expected then.
        if (error.code !== "EPIPE") {
          log.debug({ event: "process.finished", label, err: error }, "process stdin error");
        }
      });
      child.stdin.end(options.input);
    }
  });
}
