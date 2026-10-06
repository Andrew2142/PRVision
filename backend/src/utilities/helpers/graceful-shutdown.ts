import type http from "node:http";
import { createLogger, flushLogger } from "../loggers/logger";

const log = createLogger("shutdown");

/** One resource to close during shutdown. Must be a no-op for a resource that was never opened. */
export interface ShutdownStep {
  name: string;
  close: () => Promise<void>;
}

export interface GracefulShutdownOptions {
  role: "api" | "worker";
  timeoutMs: number;
  /** Test seam; defaults to `process`. */
  processLike?: Pick<NodeJS.Process, "on" | "exit">;
}

export interface ShutdownController {
  /** Idempotent: closes every step in order, flushes logs and exits with `exitCode` (1 if a step failed). */
  shutdown(exitCode: number, reason: string): Promise<void>;
}

/**
 * Installs SIGINT/SIGTERM and crash handlers and returns the controller that closes the given steps
 * sequentially, in order, under a hard timeout (04 §9.11). Called at the very start of bootstrap so a signal or
 * a boot failure also closes whatever is already open.
 *
 * @param steps - Resources to close, in order (API: http server, queues, redis, postgres).
 * @param options - Role (for logs), hard timeout and the injectable process.
 */
export function installGracefulShutdown(
  steps: readonly ShutdownStep[],
  options: GracefulShutdownOptions
): ShutdownController {
  const proc = options.processLike ?? process;
  const { role } = options;
  let inFlight: Promise<void> | null = null;
  let exited = false;

  const exitOnce = (code: number): void => {
    if (exited) {
      return;
    }
    exited = true;
    proc.exit(code);
  };

  const run = async (exitCode: number, reason: string): Promise<void> => {
    log.info({ event: "process.shutdown.started", role, reason }, "Shutting down");
    const forceTimer = setTimeout(() => {
      log.error({ event: "process.shutdown.timeout", role, reason }, "Shutdown timed out");
      exitOnce(1);
    }, options.timeoutMs);
    forceTimer.unref();

    let code = exitCode;
    for (const step of steps) {
      try {
        await step.close();
        log.info({ event: "process.shutdown.step_completed", role, step: step.name }, "Shutdown step completed");
      } catch (error: unknown) {
        code = 1;
        log.error({ event: "process.shutdown.step_failed", role, step: step.name, err: error }, "Shutdown step failed");
      }
    }
    clearTimeout(forceTimer);
    await flushLogger();
    exitOnce(code);
  };

  const shutdown = (exitCode: number, reason: string): Promise<void> => {
    inFlight ??= run(exitCode, reason);
    return inFlight;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (inFlight) {
      log.warn({ event: "process.shutdown.forced", role, reason: signal }, "forced exit");
      exitOnce(1);
      return;
    }
    shutdown(0, signal).catch((error: unknown) => {
      log.fatal({ event: "process.shutdown.step_failed", role, err: error }, "Shutdown step failed");
      exitOnce(1);
    });
  };

  const onCrash = (error: unknown): void => {
    log.fatal({ event: "process.crashed", role, err: error }, "Unhandled error");
    // After an uncaught exception the process state is suspect: the force timer guarantees the exit.
    shutdown(1, "crash").catch(() => {
      exitOnce(1);
    });
  };

  proc.on("SIGINT", onSignal);
  proc.on("SIGTERM", onSignal);
  proc.on("unhandledRejection", onCrash);
  proc.on("uncaughtException", onCrash);

  return { shutdown };
}

/**
 * Stops accepting connections, closes idle keep-alive sockets (Node >= 19) and, after `graceMs`, every
 * remaining connection. Resolves when the server has closed; a server that is not running resolves at once.
 */
export async function closeHttpServer(server: http.Server, graceMs = 5_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const graceTimer = setTimeout(() => {
      server.closeAllConnections();
    }, graceMs);
    graceTimer.unref();
    server.close((error?: Error) => {
      clearTimeout(graceTimer);
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Maps a boot failure to a one-line actionable hint. Reads only `code`, `name`, `port` and `hint` from the
 * error (never its message, which can contain a connection string).
 */
export function describeBootError(error: unknown): { hint: string | null } {
  const candidate = asErrorFields(error);
  if (!candidate) {
    return { hint: null };
  }
  if (candidate.name === "ConfigValidationError") {
    return { hint: "Fix .env (see .env.example) or run npm run setup:env" };
  }
  if (candidate.name === "DatabaseNotReadyError" && typeof candidate.hint === "string") {
    return { hint: candidate.hint };
  }
  if (candidate.code === "EADDRINUSE") {
    const port = typeof candidate.port === "number" ? candidate.port : "3100";
    return { hint: `Port ${port} in use; another PRVision API running?` };
  }
  if (candidate.code === "ECONNREFUSED") {
    return { hint: "Is Docker running? npm run infra:up" };
  }
  // AggregateError (pg/ioredis may wrap several ECONNREFUSED attempts) or a wrapped cause.
  if (Array.isArray(candidate.errors) && candidate.errors.length > 0) {
    return describeBootError(candidate.errors[0]);
  }
  if (candidate.cause !== undefined && candidate.cause !== error) {
    return describeBootError(candidate.cause);
  }
  return { hint: null };
}

interface ErrorFields {
  name?: unknown;
  code?: unknown;
  port?: unknown;
  hint?: unknown;
  errors?: unknown;
  cause?: unknown;
}

function asErrorFields(error: unknown): ErrorFields | null {
  return typeof error === "object" && error !== null ? error : null;
}
