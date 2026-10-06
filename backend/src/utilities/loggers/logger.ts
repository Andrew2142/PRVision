import { Writable } from "node:stream";
import pino, { type Logger, type LoggerOptions } from "pino";
import { IS_DEVELOPMENT, IS_TEST, LOG_LEVEL, LOG_TEST_STDOUT, PRVISION_SECRET_KEY } from "../../config-consts";
import { AuthContext } from "../context/auth-context";

/** Keys whose values are replaced by "[REDACTED]" wherever they appear (one level of nesting via "*."). */
export const REDACT_PATHS: string[] = [
  "token",
  "*.token",
  "githubToken",
  "*.githubToken",
  "apiKey",
  "*.apiKey",
  "anthropicApiKey",
  "*.anthropicApiKey",
  "githubTokenEncrypted",
  "*.githubTokenEncrypted",
  "anthropicApiKeyEncrypted",
  "*.anthropicApiKeyEncrypted",
  "password",
  "*.password",
  "secret",
  "*.secret",
  "secretKey",
  "*.secretKey",
  "authorization",
  "*.authorization",
  "Authorization",
  "*.Authorization",
  "auth",
  "*.auth",
  "cookie",
  "*.cookie",
  "headers.authorization",
  "*.headers.authorization",
  "req.headers.authorization",
  "headers.cookie",
  "err.request.headers.authorization",
  "err.response.headers.authorization",
  "env",
  "*.env",
  "databaseUrl",
  "redisUrl",
  "DATABASE_URL",
  "REDIS_URL",
  "PRVISION_SECRET_KEY",
  'headers["x-api-key"]',
  '*.headers["x-api-key"]'
];

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/(authorization:\s*(basic|bearer|token)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[REDACTED]@"], // credentials in URLs (incl. postgres://user:pass@)
  [/(x-access-token:)[^\s@"']+/gi, "$1[REDACTED]"],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]"]
];

/**
 * Scrubs known secret shapes from free text (stderr, AI errors, messages persisted to the DB), plus the literal
 * value of PRVISION_SECRET_KEY should it ever appear.
 *
 * @param text - Free text that may contain a secret.
 * @returns The text with every recognized secret replaced by a marker.
 */
export function redactSecrets(text: string): string {
  const scrubbed = SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
  return PRVISION_SECRET_KEY.length >= 16 ? scrubbed.split(PRVISION_SECRET_KEY).join("[REDACTED]") : scrubbed;
}

/** Test destination (00 §14.10): under NODE_ENV=test the root logger writes here instead of stdout. */
export interface LogTestStream {
  /** Registers a listener for every log line (a JSON string); returns the unsubscribe function. */
  subscribe(listener: (line: string) => void): () => void;
}

const testListeners = new Set<(line: string) => void>();
const testDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    const line = chunk.toString();
    for (const listener of testListeners) {
      listener(line);
    }
    if (LOG_TEST_STDOUT) {
      process.stdout.write(line);
    }
    callback();
  }
});

/** Subscribe in tests to assert log output (pino child loggers cannot be patched after import). */
export const logTestStream: LogTestStream = {
  subscribe(listener) {
    testListeners.add(listener);
    return () => {
      testListeners.delete(listener);
    };
  }
};

const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const HTTP_OBJECT_KEYS = ["request", "response", "config", "headers"];
const REDACTED_ERROR_KEYS = ["message", "stack", "stderr", "stdout"];

/** `err` serializer: pino's, minus HTTP request/response objects, with free text scrubbed. */
function serializeError(error: unknown): unknown {
  // Non-Error values (an abort reason string, a plain object) are logged as-is after redaction.
  if (typeof error === "string") {
    return redactSecrets(error);
  }
  if (typeof error !== "object" || error === null) {
    return error;
  }
  const serialized = pino.stdSerializers.err(error as Error) as unknown as Record<string, unknown>;
  for (const key of HTTP_OBJECT_KEYS) {
    Reflect.deleteProperty(serialized, key);
  }
  for (const key of REDACTED_ERROR_KEYS) {
    const value = serialized[key];
    if (typeof value === "string") {
      serialized[key] = redactSecrets(value);
    }
  }
  return serialized;
}

const options: LoggerOptions = {
  // An invalid LOG_LEVEL must not crash at import (pino throws on unknown levels): fall back to "info";
  // validateConfig() then reports the bad value at boot.
  level: VALID_LEVELS.has(LOG_LEVEL) ? LOG_LEVEL : "info",
  base: { app: "prvision", pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  serializers: { err: serializeError },
  mixin: () => {
    const requestId = AuthContext.getRequestId();
    return requestId ? { requestId } : {};
  }
};
if (IS_DEVELOPMENT) {
  options.transport = {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,app" }
  };
}

/** Root logger. JSON to stdout (production), pino-pretty (development), logTestStream (test). */
export const logger: Logger = IS_TEST ? pino(options, testDestination) : pino(options);

/**
 * Creates the logger of one module. Every line carries `{ module }` plus the given bindings.
 *
 * @param module - Module name, e.g. "queue" or "git".
 * @param bindings - Extra fields for every line (e.g. `{ visualizationId }` in the worker).
 */
export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...bindings });
}

/** Flushes buffered log lines (called by graceful shutdown before exit). */
export async function flushLogger(): Promise<void> {
  await new Promise<void>((resolve) => {
    logger.flush(() => {
      resolve();
    });
  });
}
