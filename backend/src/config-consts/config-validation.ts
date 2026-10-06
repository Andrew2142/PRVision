// Imports the config-consts barrel, so the barrel must not re-export this file (02 §6.7): import it by path.
import * as currentConfig from ".";

type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;

/**
 * Snapshot of every config constant. Literal types are widened (`VISUALIZATION_WORKER_CONCURRENCY: number`, not
 * `1`) so tests can pass the invalid values the validator exists to reject.
 */
export type ConfigSnapshot = { [K in keyof typeof currentConfig]: Widen<(typeof currentConfig)[K]> };
export type ConfigValidationOverrides = Partial<ConfigSnapshot>;

/** Every configuration problem found at boot. Messages name the variable and rule, never a secret value. */
export class ConfigValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`PRVision config validation failed:\n- ${errors.join("\n- ")}`);
    this.name = "ConfigValidationError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_URL_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const MIN_SECRET_KEY_BYTES = 32;
const MAX_ALLOWED_PAGE_SIZE = 100;

/** Levels pino accepts (an unknown LOG_LEVEL is reported here; the logger falls back to "info"). */
export const LOG_LEVELS: readonly string[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/**
 * Returns every configuration problem. Reads the config-consts snapshot (the only env readers), optionally
 * overridden for tests.
 *
 * @param overrides - Values replacing the current constants.
 */
export function collectConfigValidationErrors(overrides: ConfigValidationOverrides = {}): string[] {
  const c: ConfigSnapshot = { ...currentConfig, ...overrides };
  const errors: string[] = [];

  assertOneOf(errors, "NODE_ENV", c.NODE_ENV, ["development", "test", "production"]);
  assertPort(errors, "PORT", c.APP_PORT);
  if (!LOOPBACK_HOSTS.has(c.APP_HOST)) {
    errors.push(
      `HOST "${c.APP_HOST}" is not a loopback address; HOST must be 127.0.0.1, ::1 or localhost (PRVision has no authentication).`
    );
  }
  assertHttpUrl(errors, "FRONTEND_URL", c.FRONTEND_URL);
  assertUrlWithProtocol(errors, "DATABASE_URL", c.DATABASE_URL, ["postgres:", "postgresql:"]);
  assertUrlWithProtocol(errors, "REDIS_URL", c.REDIS_URL, ["redis:", "rediss:"]);
  assertSecretKey(errors, "PRVISION_SECRET_KEY", c.PRVISION_SECRET_KEY);
  assertAbsoluteDataDir(errors, "PRVISION_DATA_DIR", c.DATA_DIR);
  assertOneOf(errors, "LOG_LEVEL", c.LOG_LEVEL, LOG_LEVELS);

  assertPositiveInteger(errors, "DB_POOL_MAX", c.DB_POOL_MAX);
  assertPositiveInteger(errors, "SHUTDOWN_TIMEOUT_MS", c.SHUTDOWN_TIMEOUT_MS);
  if (c.SHUTDOWN_TIMEOUT_MS <= c.WORKER_CLOSE_TIMEOUT_MS) {
    errors.push("SHUTDOWN_TIMEOUT_MS must be greater than WORKER_CLOSE_TIMEOUT_MS.");
  }
  assertPositiveInteger(errors, "GIT_DEFAULT_TIMEOUT_MS", c.GIT_DEFAULT_TIMEOUT_MS);
  assertPositiveInteger(errors, "GIT_FETCH_TIMEOUT_MS", c.GIT_FETCH_TIMEOUT_MS);
  assertPositiveInteger(errors, "GIT_WORKTREE_TIMEOUT_MS", c.GIT_WORKTREE_TIMEOUT_MS);
  assertPositiveInteger(errors, "GIT_MAX_BUFFER_BYTES", c.GIT_MAX_BUFFER_BYTES);

  // Queue contract (00 §10, §14.6) is fixed: fail loudly if a value drifts.
  assertEquals(errors, "QUEUE_PREFIX", c.QUEUE_PREFIX, "prvision");
  assertEquals(errors, "VISUALIZATION_QUEUE", c.VISUALIZATION_QUEUE, "visualizations");
  assertEquals(errors, "VISUALIZATION_JOB", c.VISUALIZATION_JOB, "visualize");
  assertEquals(errors, "VISUALIZATION_JOB_ID_PREFIX", c.VISUALIZATION_JOB_ID_PREFIX, "viz-");
  assertEquals(errors, "VISUALIZATION_WORKER_CONCURRENCY", c.VISUALIZATION_WORKER_CONCURRENCY, 1);
  assertEquals(errors, "VISUALIZATION_JOB_ATTEMPTS", c.VISUALIZATION_JOB_ATTEMPTS, 1);
  assertEquals(errors, "WORKER_LOCK_DURATION_MS", c.WORKER_LOCK_DURATION_MS, 300_000);
  assertEquals(errors, "WORKER_MAX_STALLED_COUNT", c.WORKER_MAX_STALLED_COUNT, 0);
  assertEquals(errors, "CANCEL_KEY_PREFIX", c.CANCEL_KEY_PREFIX, "prvision:cancel:");
  assertPositiveInteger(errors, "CANCEL_KEY_TTL_SECONDS", c.CANCEL_KEY_TTL_SECONDS);
  assertPositiveInteger(errors, "CANCEL_POLL_INTERVAL_MS", c.CANCEL_POLL_INTERVAL_MS);

  assertPositiveInteger(errors, "DEFAULT_PAGE_SIZE", c.DEFAULT_PAGE_SIZE);
  if (c.DEFAULT_PAGE_SIZE > c.MAX_PAGE_SIZE || c.MAX_PAGE_SIZE > MAX_ALLOWED_PAGE_SIZE) {
    errors.push("DEFAULT_PAGE_SIZE must be <= MAX_PAGE_SIZE <= 100.");
  }
  // [05]/[10] append assertions for ai.config.ts / render.config.ts constants here.
  return errors;
}

/**
 * Throws ConfigValidationError listing every problem. Called first at API and worker boot, before any
 * connection is opened, and by `npm run validate:config`.
 */
export function validateConfig(overrides: ConfigValidationOverrides = {}): void {
  const errors = collectConfigValidationErrors(overrides);
  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }
}

function assertNonEmpty(errors: string[], name: string, value: string): boolean {
  if (value.trim() === "") {
    errors.push(`${name} is required (run npm run setup:env).`);
    return false;
  }
  return true;
}

function assertPositiveInteger(errors: string[], name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${name} must be a positive integer.`);
  }
}

function assertPort(errors: string[], name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    errors.push(`${name} must be an integer between 1 and 65535.`);
  }
}

function assertOneOf(errors: string[], name: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) {
    errors.push(`${name} "${value}" is not allowed; must be one of: ${allowed.join(", ")}.`);
  }
}

function assertEquals(errors: string[], name: string, value: string | number, expected: string | number): void {
  if (value !== expected) {
    errors.push(`${name} must be ${JSON.stringify(expected)} (fixed by the queue contract, 00 §10).`);
  }
}

/** http(s) URL on a loopback host, without path, query or fragment. */
function assertHttpUrl(errors: string[], name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${name} must be a valid URL.`);
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push(`${name} must use http or https.`);
  }
  if (!LOOPBACK_URL_HOSTS.has(parsed.hostname)) {
    errors.push(`${name} must point to a loopback host (localhost or 127.0.0.1).`);
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search !== "" || parsed.hash !== "") {
    errors.push(`${name} must be an origin without path or query.`);
  }
}

/** Required URL with one of the protocols. Never echoes the value (it may contain a password). */
function assertUrlWithProtocol(errors: string[], name: string, value: string, protocols: readonly string[]): void {
  if (!assertNonEmpty(errors, name, value)) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${name} must be a valid URL.`);
    return;
  }
  if (!protocols.includes(parsed.protocol)) {
    errors.push(`${name} must use ${protocols.map((protocol) => protocol.replace(":", "://")).join(" or ")}.`);
  }
}

/** Base64 that decodes to at least 32 bytes. Never echoes the value. */
function assertSecretKey(errors: string[], name: string, value: string): void {
  if (!assertNonEmpty(errors, name, value)) {
    return;
  }
  const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
  if (!isBase64 || Buffer.from(value, "base64").length < MIN_SECRET_KEY_BYTES) {
    errors.push(`${name} must be base64 of at least 32 bytes (run npm run setup:env).`);
  }
}

function assertAbsoluteDataDir(errors: string[], name: string, value: string): void {
  if (!value.startsWith("/") || value === "/") {
    errors.push(`${name} must be an absolute directory other than "/".`);
  }
}
