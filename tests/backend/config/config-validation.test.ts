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
