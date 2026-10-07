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
  if (!LOOPBACK_HOSTS.has(c.APP_HOST) && !(c.IN_CONTAINER && c.APP_HOST === "0.0.0.0")) {
    errors.push(
      `HOST "${c.APP_HOST}" is not a loopback address; HOST must be 127.0.0.1, ::1 or localhost (PRVision has no authentication). Only the Docker image (PRVISION_CONTAINER=1) may use 0.0.0.0.`
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
  collectHarnessLibraryErrors(errors, c);
  return errors;
}

/** Sheet 16 §16.6: harness library, states, live mode, prices and export/import constants. */
function collectHarnessLibraryErrors(errors: string[], c: ConfigSnapshot): void {
  // Queues of 00 §21 item 7 are part of the queue contract, like the visualization queue.
  assertEquals(errors, "LIBRARY_SCAN_QUEUE", c.LIBRARY_SCAN_QUEUE, "harness-scans");
  assertEquals(errors, "LIBRARY_SCAN_JOB", c.LIBRARY_SCAN_JOB, "scan");
  assertEquals(errors, "LIBRARY_SCAN_JOB_ID_PREFIX", c.LIBRARY_SCAN_JOB_ID_PREFIX, "scan-");
  assertEquals(errors, "LIBRARY_REPAIR_QUEUE", c.LIBRARY_REPAIR_QUEUE, "harness-repairs");
  assertEquals(errors, "LIBRARY_REPAIR_JOB", c.LIBRARY_REPAIR_JOB, "repair");
  assertEquals(errors, "LIBRARY_REPAIR_JOB_ID_PREFIX", c.LIBRARY_REPAIR_JOB_ID_PREFIX, "repair-");
  assertEquals(errors, "LIVE_SESSION_QUEUE", c.LIVE_SESSION_QUEUE, "live-sessions");
  assertEquals(errors, "LIVE_SESSION_JOB", c.LIVE_SESSION_JOB, "live");
  assertEquals(errors, "LIVE_SESSION_JOB_ID_PREFIX", c.LIVE_SESSION_JOB_ID_PREFIX, "live-");
  assertEquals(errors, "LIBRARY_CANCEL_KEY_PREFIX", c.LIBRARY_CANCEL_KEY_PREFIX, "prvision:library-cancel:");
  assertEquals(errors, "LIBRARY_SCAN_WORKER_CONCURRENCY", c.LIBRARY_SCAN_WORKER_CONCURRENCY, 1);
  assertEquals(errors, "LIBRARY_REPAIR_WORKER_CONCURRENCY", c.LIBRARY_REPAIR_WORKER_CONCURRENCY, 1);

  // State allowance and ordinals are literals in DB CHECKs (16 §6.2, §6.6).
  if (c.STATE_ALLOWANCE_MIN !== 1 || c.STATE_ALLOWANCE_MAX !== 5) {
    errors.push("STATE_ALLOWANCE_MIN must be 1 and STATE_ALLOWANCE_MAX must be 5 (they are literals in DB CHECKs).");
  }
  if (c.STATE_ALLOWANCE_DEFAULT < c.STATE_ALLOWANCE_MIN || c.STATE_ALLOWANCE_DEFAULT > c.STATE_ALLOWANCE_MAX) {
    errors.push("STATE_ALLOWANCE_DEFAULT must be between STATE_ALLOWANCE_MIN and STATE_ALLOWANCE_MAX.");
  }
  if (c.MAX_STATE_ORDINALS !== 10) {
    errors.push("MAX_STATE_ORDINALS must be 10 (the DB CHECK allows ordinals 0–9).");
  }

  // Live mode (D10).
  if (c.LIVE_IDLE_TIMEOUT_MS !== 600_000) {
    errors.push("LIVE_IDLE_TIMEOUT_MS must be 600000 (10 minutes, D10).");
  }
  if (c.LIVE_HEARTBEAT_LOSS_MS < 2 * c.LIVE_HEARTBEAT_INTERVAL_MS) {
    errors.push("LIVE_HEARTBEAT_LOSS_MS must be at least 2 × LIVE_HEARTBEAT_INTERVAL_MS.");
  }
  if (c.LIVE_IDLE_TIMEOUT_MS <= c.LIVE_HEARTBEAT_LOSS_MS) {
    errors.push("LIVE_IDLE_TIMEOUT_MS must be greater than LIVE_HEARTBEAT_LOSS_MS.");
  }
  if (!Number.isInteger(c.LIVE_MAX_SESSIONS) || c.LIVE_MAX_SESSIONS < 1 || c.LIVE_MAX_SESSIONS > 4) {
    errors.push("LIVE_MAX_SESSIONS must be an integer between 1 and 4.");
  }

  // Render budget (16 §9.2).
  if (c.RENDER_PAGE_CONCURRENCY !== 2 * c.RENDER_ITEM_CONCURRENCY) {
    errors.push("RENDER_PAGE_CONCURRENCY must be 2 × RENDER_ITEM_CONCURRENCY.");
  }
  if (
    c.RENDER_STAGE_TIMEOUT_MS > c.RENDER_STAGE_TIMEOUT_MAX_MS ||
    c.RENDER_STAGE_TIMEOUT_MAX_MS >= c.VISUALIZATION_MAX_RUNTIME_MS
  ) {
    errors.push("RENDER_STAGE_TIMEOUT_MS ≤ RENDER_STAGE_TIMEOUT_MAX_MS < VISUALIZATION_MAX_RUNTIME_MS must hold.");
  }

  // Prices (16 §6.13, E17).
  const prices: Record<string, Record<string, number>> = c.AI_MODEL_PRICES_USD_PER_MTOK;
  for (const [model, price] of Object.entries(prices)) {
    const fields = ["input", "output", "cacheRead", "cacheWrite"].map((field) => price[field]);
    if (!fields.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
      errors.push(
        `AI_MODEL_PRICES_USD_PER_MTOK["${model}"] must have finite positive input, output, cacheRead and cacheWrite.`
      );
    }
  }
  if (!Object.prototype.hasOwnProperty.call(prices, c.AI_PRICE_FALLBACK_MODEL)) {
    errors.push("AI_PRICE_FALLBACK_MODEL must be a model of AI_MODEL_PRICES_USD_PER_MTOK.");
  }
  if (!Object.prototype.hasOwnProperty.call(prices, c.AI_DEFAULT_MODEL)) {
    errors.push("AI_DEFAULT_MODEL must be a model of AI_MODEL_PRICES_USD_PER_MTOK.");
  }

  // Spending cap, export/import and estimates.
  if (!(c.LIBRARY_SPEND_CAP_MIN_USD > 0 && c.LIBRARY_SPEND_CAP_MIN_USD < c.LIBRARY_SPEND_CAP_MAX_USD)) {
    errors.push("0 < LIBRARY_SPEND_CAP_MIN_USD < LIBRARY_SPEND_CAP_MAX_USD must hold.");
  }
  if (c.LIBRARY_EXPORT_VERSION !== 1) {
    errors.push("LIBRARY_EXPORT_VERSION must be 1.");
  }
  if (c.LIBRARY_EXPORT_MAX_BYTES !== bodyLimitBytes(c.LIBRARY_IMPORT_BODY_LIMIT)) {
    errors.push("LIBRARY_EXPORT_MAX_BYTES must equal LIBRARY_IMPORT_BODY_LIMIT in bytes.");
  }
  if (c.LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS >= c.LIBRARY_ESTIMATE_TIMEOUT_MS) {
    errors.push("LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS must be less than LIBRARY_ESTIMATE_TIMEOUT_MS.");
  }

  const positiveIntegers: Array<[string, number]> = [
    ["ANALYSIS_MAX_CANDIDATES", c.ANALYSIS_MAX_CANDIDATES],
    ["STATE_NAME_MAX_CHARS", c.STATE_NAME_MAX_CHARS],
    ["STATE_MAX_STEPS", c.STATE_MAX_STEPS],
    ["STATE_STEP_TEXT_MAX_CHARS", c.STATE_STEP_TEXT_MAX_CHARS],
    ["STATE_STEP_NTH_MAX", c.STATE_STEP_NTH_MAX],
    ["STATE_STEP_TIMEOUT_MS", c.STATE_STEP_TIMEOUT_MS],
    ["RENDER_ITEM_CONCURRENCY", c.RENDER_ITEM_CONCURRENCY],
    ["RENDER_PAGE_CONCURRENCY", c.RENDER_PAGE_CONCURRENCY],
    ["RENDER_STAGE_MS_PER_PAGE", c.RENDER_STAGE_MS_PER_PAGE],
    ["RENDER_GROUP_STARTUP_ALLOWANCE_MS", c.RENDER_GROUP_STARTUP_ALLOWANCE_MS],
    ["ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS", c.ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS],
    ["RENDER_STAGE_TIMEOUT_MAX_MS", c.RENDER_STAGE_TIMEOUT_MAX_MS],
    ["RENDER_GROUP_MAX_ITEMS", c.RENDER_GROUP_MAX_ITEMS],
    ["LIBRARY_INVENTORY_MAX_COMPONENTS", c.LIBRARY_INVENTORY_MAX_COMPONENTS],
    ["LIBRARY_INVENTORY_MAX_FILES", c.LIBRARY_INVENTORY_MAX_FILES],
    ["LIBRARY_INVENTORY_BUDGET_MS", c.LIBRARY_INVENTORY_BUDGET_MS],
    ["LIBRARY_RECHECK_MAX_COMPONENTS", c.LIBRARY_RECHECK_MAX_COMPONENTS],
    ["LIBRARY_SCAN_BATCH_SIZE", c.LIBRARY_SCAN_BATCH_SIZE],
    ["LIBRARY_ESTIMATE_MIN_SAMPLES", c.LIBRARY_ESTIMATE_MIN_SAMPLES],
    ["LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE", c.LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE],
    ["LIBRARY_ESTIMATE_SECONDS_PER_HARNESS", c.LIBRARY_ESTIMATE_SECONDS_PER_HARNESS],
    ["VISUALIZATION_MAX_RUNTIME_MS", c.VISUALIZATION_MAX_RUNTIME_MS],
    ["LIBRARY_SCAN_MAX_RUNTIME_MS", c.LIBRARY_SCAN_MAX_RUNTIME_MS],
    ["LIBRARY_REPAIR_MAX_RUNTIME_MS", c.LIBRARY_REPAIR_MAX_RUNTIME_MS],
    ["LIVE_IDLE_TIMEOUT_MS", c.LIVE_IDLE_TIMEOUT_MS],
    ["LIVE_HEARTBEAT_INTERVAL_MS", c.LIVE_HEARTBEAT_INTERVAL_MS],
    ["LIVE_HEARTBEAT_LOSS_MS", c.LIVE_HEARTBEAT_LOSS_MS],
    ["LIVE_POLL_INTERVAL_MS", c.LIVE_POLL_INTERVAL_MS],
    ["LIVE_MAX_SESSION_MS", c.LIVE_MAX_SESSION_MS],
    ["LIVE_START_TIMEOUT_MS", c.LIVE_START_TIMEOUT_MS],
    ["LIVE_MAX_HOSTS_PER_SIDE", c.LIVE_MAX_HOSTS_PER_SIDE],
    ["LIBRARY_EXPORT_MAX_BYTES", c.LIBRARY_EXPORT_MAX_BYTES],
    ["LIBRARY_IMPORT_MAX_ENTRIES", c.LIBRARY_IMPORT_MAX_ENTRIES],
    ["LIBRARY_ESTIMATE_TIMEOUT_MS", c.LIBRARY_ESTIMATE_TIMEOUT_MS],
    ["LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS", c.LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS],
    ["LIBRARY_ESTIMATE_CACHE_MS", c.LIBRARY_ESTIMATE_CACHE_MS]
  ];
  for (const [name, value] of positiveIntegers) {
    assertPositiveInteger(errors, name, value);
  }
}

/** Bytes of an express/body-parser limit string such as "64mb" or "512kb"; NaN when malformed. */
function bodyLimitBytes(limit: string): number {
  const match = /^(\d+)(b|kb|mb|gb)$/i.exec(limit.trim());
  if (!match?.[1] || !match[2]) {
    return Number.NaN;
  }
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  return Number(match[1]) * (units[match[2].toLowerCase()] ?? Number.NaN);
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
