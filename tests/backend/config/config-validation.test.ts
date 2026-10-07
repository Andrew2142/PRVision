import assert from "node:assert/strict";
import test from "node:test";
import * as config from "../../../backend/src/config-consts";
import {
  ConfigValidationError,
  collectConfigValidationErrors,
  validateConfig,
  type ConfigSnapshot
} from "../../../backend/src/config-consts/config-validation";

const VALID_REQUIRED = {
  DATABASE_URL: "postgres://prvision:prvision@127.0.0.1:5434/prvision",
  REDIS_URL: "redis://127.0.0.1:6380",
  PRVISION_SECRET_KEY: Buffer.alloc(32, 3).toString("base64")
};

function errorsFor(overrides: Partial<ConfigSnapshot>): string[] {
  return collectConfigValidationErrors({ ...VALID_REQUIRED, ...overrides });
}

test("collectConfigValidationErrors accepts the default constants with valid required values", () => {
  assert.deepEqual(errorsFor({}), []);
  validateConfig(VALID_REQUIRED);
});

test("collectConfigValidationErrors reports missing DATABASE_URL, REDIS_URL, PRVISION_SECRET_KEY", () => {
  const errors = errorsFor({ DATABASE_URL: "", REDIS_URL: "", PRVISION_SECRET_KEY: "" });
  for (const name of ["DATABASE_URL", "REDIS_URL", "PRVISION_SECRET_KEY"]) {
    assert.ok(
      errors.some((error) => error.startsWith(`${name} is required`)),
      name
    );
  }
  assert.throws(
    () => validateConfig({ ...VALID_REQUIRED, DATABASE_URL: "" }),
    (error: unknown) => error instanceof ConfigValidationError && error.errors.length === 1
  );
  assert.ok(errorsFor({ DATABASE_URL: "mysql://x@y/z" }).some((error) => error.startsWith("DATABASE_URL must use")));
  assert.ok(errorsFor({ REDIS_URL: "http://127.0.0.1:6380" }).some((error) => error.startsWith("REDIS_URL must use")));
});

test("collectConfigValidationErrors allows HOST 0.0.0.0 only inside the container", () => {
  assert.deepEqual(errorsFor({ IN_CONTAINER: true, APP_HOST: "0.0.0.0" }), []);
  assert.equal(errorsFor({ IN_CONTAINER: true, APP_HOST: "192.168.1.5" }).length, 1);
  assert.equal(errorsFor({ IN_CONTAINER: false, APP_HOST: "0.0.0.0" }).length, 1);
});

test("collectConfigValidationErrors rejects a non-loopback HOST", () => {
  const errors = errorsFor({ APP_HOST: "0.0.0.0" });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /HOST "0\.0\.0\.0" is not a loopback address/);
  assert.deepEqual(errorsFor({ APP_HOST: "::1" }), []);
  assert.deepEqual(errorsFor({ APP_HOST: "localhost" }), []);
  assert.equal(errorsFor({ FRONTEND_URL: "http://evil.test:4210" }).length, 1);
  assert.equal(errorsFor({ FRONTEND_URL: "http://localhost:4210/app" }).length, 1);
});

test("collectConfigValidationErrors rejects a short or non-base64 secret key", () => {
  for (const key of [Buffer.alloc(10, 1).toString("base64"), "not base64 at all!", "%%%%"]) {
    const errors = errorsFor({ PRVISION_SECRET_KEY: key });
    assert.deepEqual(errors, ["PRVISION_SECRET_KEY must be base64 of at least 32 bytes (run npm run setup:env)."]);
  }
});

test('collectConfigValidationErrors rejects a relative data dir and "/"', () => {
  assert.equal(errorsFor({ DATA_DIR: "relative/dir" }).length, 1);
  assert.equal(errorsFor({ DATA_DIR: "/" }).length, 1);
});

test("collectConfigValidationErrors rejects queue contract drift", () => {
  const errors = errorsFor({
    VISUALIZATION_WORKER_CONCURRENCY: 2,
    WORKER_LOCK_DURATION_MS: 60_000,
    QUEUE_PREFIX: "other"
  });
  assert.equal(errors.length, 3);
  assert.ok(errors.some((error) => error.startsWith("VISUALIZATION_WORKER_CONCURRENCY must be 1")));
  assert.ok(errors.some((error) => error.startsWith("WORKER_LOCK_DURATION_MS must be 300000")));
  assert.ok(errorsFor({ SHUTDOWN_TIMEOUT_MS: 5_000 }).some((error) => error.includes("WORKER_CLOSE_TIMEOUT_MS")));
  assert.ok(errorsFor({ MAX_PAGE_SIZE: 500 }).length > 0);
});

test("collectConfigValidationErrors rejects a NaN PORT and an unknown LOG_LEVEL", () => {
  assert.deepEqual(errorsFor({ APP_PORT: Number.NaN }), ["PORT must be an integer between 1 and 65535."]);
  assert.equal(errorsFor({ APP_PORT: 70_000 }).length, 1);
  assert.match(errorsFor({ LOG_LEVEL: "verbose" })[0]!, /^LOG_LEVEL "verbose" is not allowed/);
  assert.equal(errorsFor({ NODE_ENV: "staging" }).length, 1);
});

test("collectConfigValidationErrors error text never contains the secret value or the database password", () => {
  const secret = "c2hvcnQtc2VjcmV0"; // base64, too short
  const errors = collectConfigValidationErrors({
    DATABASE_URL: "mysql://prvision:hunter2-password@127.0.0.1/x",
    REDIS_URL: "http://user:redis-pass@127.0.0.1",
    PRVISION_SECRET_KEY: secret
  });
  assert.equal(errors.length, 3);
  const text = errors.join("\n");
  for (const value of [secret, "hunter2-password", "redis-pass"]) {
    assert.ok(!text.includes(value), `${value} leaked`);
  }
  assert.throws(
    () => validateConfig({ DATABASE_URL: "not a url :// hunter2" }),
    (error: unknown) => error instanceof ConfigValidationError && !error.message.includes("hunter2")
  );
});

test("ConfigSnapshot has no key for any test-only variable", () => {
  const keys = Object.keys(config);
  const values = Object.values(config).filter((value): value is string => typeof value === "string");
  const testOnly = [
    "PRVISION_IT_RENDER",
    "PRVISION_IT_AI",
    "PRVISION_INTEGRATION",
    "PRVISION_TEST_DATABASE_URL",
    "PRVISION_KEEP_TEST_ARTIFACTS",
    "PRVISION_REAL_DATA_DIR"
  ];
  for (const name of testOnly) {
    assert.ok(!keys.includes(name), `${name} must not be a config constant`);
  }
  assert.ok(!keys.some((key) => key.startsWith("PRVISION_IT_AI_") || key.startsWith("IT_")));
  // No config constant carries the value of a test-only variable (the preload sets PRVISION_REAL_DATA_DIR).
  const realDataDir = process.env.PRVISION_REAL_DATA_DIR;
  if (realDataDir !== undefined && realDataDir !== config.DATA_DIR) {
    assert.ok(!values.includes(realDataDir));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Sheet 16 §16.6: one failing override per rule
// ---------------------------------------------------------------------------------------------------------------

/** Asserts that the override produces exactly one error and that it matches `pattern`. */
function rejectsOnce(overrides: Partial<ConfigSnapshot>, pattern: RegExp): void {
  const errors = errorsFor(overrides);
  assert.equal(errors.length, 1, `${JSON.stringify(overrides)} → ${JSON.stringify(errors)}`);
  assert.match(errors[0] ?? "", pattern);
}

test("16 §16.6: the library and live queue contract is fixed", () => {
  const drift: Array<[keyof ConfigSnapshot, string | number]> = [
    ["LIBRARY_SCAN_QUEUE", "scans"],
    ["LIBRARY_SCAN_JOB", "scan-job"],
    ["LIBRARY_SCAN_JOB_ID_PREFIX", "s-"],
    ["LIBRARY_REPAIR_QUEUE", "repairs"],
    ["LIBRARY_REPAIR_JOB", "fix"],
    ["LIBRARY_REPAIR_JOB_ID_PREFIX", "r-"],
    ["LIVE_SESSION_QUEUE", "live"],
    ["LIVE_SESSION_JOB", "session"],
    ["LIVE_SESSION_JOB_ID_PREFIX", "l-"],
    ["LIBRARY_CANCEL_KEY_PREFIX", "prvision:cancel:"],
    ["LIBRARY_SCAN_WORKER_CONCURRENCY", 2],
    ["LIBRARY_REPAIR_WORKER_CONCURRENCY", 2]
  ];
  for (const [name, value] of drift) {
    rejectsOnce({ [name]: value }, new RegExp(`^${name} must be `));
  }
});

test("16 §16.6: state allowance bounds are the DB CHECK literals, the default lies between them, 10 ordinals", () => {
  rejectsOnce({ STATE_ALLOWANCE_MIN: 0 }, /^STATE_ALLOWANCE_MIN must be 1 and STATE_ALLOWANCE_MAX must be 5/);
  rejectsOnce({ STATE_ALLOWANCE_MAX: 6 }, /^STATE_ALLOWANCE_MIN must be 1 and STATE_ALLOWANCE_MAX must be 5/);
  rejectsOnce({ STATE_ALLOWANCE_DEFAULT: 6 }, /^STATE_ALLOWANCE_DEFAULT must be between/);
  rejectsOnce({ STATE_ALLOWANCE_DEFAULT: 0 }, /^STATE_ALLOWANCE_DEFAULT must be between/);
  rejectsOnce({ MAX_STATE_ORDINALS: 9 }, /^MAX_STATE_ORDINALS must be 10/);
});

test("16 §16.6: live mode timing and session limits", () => {
  rejectsOnce({ LIVE_IDLE_TIMEOUT_MS: 300_000 }, /^LIVE_IDLE_TIMEOUT_MS must be 600000/);
  rejectsOnce(
    { LIVE_HEARTBEAT_LOSS_MS: 59_999 },
    /^LIVE_HEARTBEAT_LOSS_MS must be at least 2 × LIVE_HEARTBEAT_INTERVAL_MS/
  );
  rejectsOnce({ LIVE_HEARTBEAT_LOSS_MS: 600_000 }, /^LIVE_IDLE_TIMEOUT_MS must be greater than LIVE_HEARTBEAT_LOSS_MS/);
  rejectsOnce({ LIVE_MAX_SESSIONS: 0 }, /^LIVE_MAX_SESSIONS must be an integer between 1 and 4/);
  rejectsOnce({ LIVE_MAX_SESSIONS: 5 }, /^LIVE_MAX_SESSIONS must be an integer between 1 and 4/);
  assert.deepEqual(errorsFor({ LIVE_MAX_SESSIONS: 4 }), []);
});

test("16 §16.6: render page concurrency and the dynamic stage budget bounds", () => {
  rejectsOnce({ RENDER_PAGE_CONCURRENCY: 3 }, /^RENDER_PAGE_CONCURRENCY must be 2 × RENDER_ITEM_CONCURRENCY/);
  rejectsOnce({ RENDER_STAGE_TIMEOUT_MAX_MS: 10 * 60_000 }, /^RENDER_STAGE_TIMEOUT_MS ≤ RENDER_STAGE_TIMEOUT_MAX_MS </);
  rejectsOnce({ RENDER_STAGE_TIMEOUT_MAX_MS: 90 * 60_000 }, /^RENDER_STAGE_TIMEOUT_MS ≤ RENDER_STAGE_TIMEOUT_MAX_MS </);
  rejectsOnce({ VISUALIZATION_MAX_RUNTIME_MS: 45 * 60_000 }, /< VISUALIZATION_MAX_RUNTIME_MS must hold/);
});

test("16 §16.6: every price entry has four finite positive numbers; fallback and default models are priced", () => {
  const prices = (patch: Record<string, unknown>): ConfigSnapshot["AI_MODEL_PRICES_USD_PER_MTOK"] => ({
    ...config.AI_MODEL_PRICES_USD_PER_MTOK,
    ...patch
  });
  for (const broken of [
    { input: 0, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    { input: 5, output: Number.NaN, cacheRead: 0.5, cacheWrite: 6.25 },
    { input: 5, output: 25, cacheRead: -1, cacheWrite: 6.25 },
    { input: 5, output: 25, cacheRead: 0.5 }
  ]) {
    rejectsOnce(
      { AI_MODEL_PRICES_USD_PER_MTOK: prices({ "claude-opus-4-6": broken }) },
      /^AI_MODEL_PRICES_USD_PER_MTOK\["claude-opus-4-6"\] must have finite positive/
    );
  }
  rejectsOnce({ AI_PRICE_FALLBACK_MODEL: "claude-unknown" }, /^AI_PRICE_FALLBACK_MODEL must be a model of/);
  rejectsOnce({ AI_DEFAULT_MODEL: "claude-unknown" }, /^AI_DEFAULT_MODEL must be a model of/);
});

test("16 §16.6: spend cap range, export version, export size, estimate budget", () => {
  rejectsOnce({ LIBRARY_SPEND_CAP_MIN_USD: 0 }, /^0 < LIBRARY_SPEND_CAP_MIN_USD < LIBRARY_SPEND_CAP_MAX_USD/);
  rejectsOnce({ LIBRARY_SPEND_CAP_MIN_USD: 20_000 }, /^0 < LIBRARY_SPEND_CAP_MIN_USD < LIBRARY_SPEND_CAP_MAX_USD/);
  rejectsOnce({ LIBRARY_EXPORT_VERSION: 2 }, /^LIBRARY_EXPORT_VERSION must be 1/);
  rejectsOnce(
    { LIBRARY_EXPORT_MAX_BYTES: 32 * 1024 * 1024 },
    /^LIBRARY_EXPORT_MAX_BYTES must equal LIBRARY_IMPORT_BODY_LIMIT/
  );
  rejectsOnce({ LIBRARY_IMPORT_BODY_LIMIT: "32mb" }, /^LIBRARY_EXPORT_MAX_BYTES must equal LIBRARY_IMPORT_BODY_LIMIT/);
  rejectsOnce({ LIBRARY_IMPORT_BODY_LIMIT: "a lot" }, /^LIBRARY_EXPORT_MAX_BYTES must equal LIBRARY_IMPORT_BODY_LIMIT/);
  assert.deepEqual(errorsFor({ LIBRARY_IMPORT_BODY_LIMIT: "65536KB" }), []);
  rejectsOnce(
    { LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS: 60_000 },
    /^LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS must be less than LIBRARY_ESTIMATE_TIMEOUT_MS/
  );
});

test("16 §16.6: every new size, count and timeout is a positive integer", () => {
  for (const name of [
    "ANALYSIS_MAX_CANDIDATES",
    "STATE_MAX_STEPS",
    "STATE_STEP_TIMEOUT_MS",
    "RENDER_GROUP_MAX_ITEMS",
    "LIBRARY_INVENTORY_MAX_COMPONENTS",
    "LIBRARY_SCAN_BATCH_SIZE",
    "LIBRARY_SCAN_MAX_RUNTIME_MS",
    "LIBRARY_REPAIR_MAX_RUNTIME_MS",
    "LIVE_POLL_INTERVAL_MS",
    "LIVE_MAX_HOSTS_PER_SIDE",
    "LIBRARY_IMPORT_MAX_ENTRIES",
    "LIBRARY_ESTIMATE_CACHE_MS"
  ] as const) {
    rejectsOnce({ [name]: 0 }, new RegExp(`^${name} must be a positive integer`));
    rejectsOnce({ [name]: 1.5 }, new RegExp(`^${name} must be a positive integer`));
  }
});
