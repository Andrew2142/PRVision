/**
 * Backend test preload (sheet 14 §5.4.1), loaded with -r before every test file and before any backend module.
 * Replaces sheet 02's placeholder: same values except LOG_LEVEL (debug, so logs reach logTestStream), plus the
 * real-data-dir pointer, the stale-temp sweep and the network guard.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installNetworkGuard } from "./network-guard";
// Same as app.ts/worker.ts: class-transformer decorators (@Type in dtos/shared) call Reflect.getMetadata at class
// definition, so any test that loads the dtos barrel (directly or through services/controllers) needs it first.
import "reflect-metadata";

const STALE_TEMP_MS = 2 * 60 * 60 * 1000;
const TEMP_PREFIXES = ["prvision-test-", "prvision-it-", "prvision-detect-"];

// Remember the developer's real data dir before isolating, so integration tests can find the fixture repo.
process.env.PRVISION_REAL_DATA_DIR ??= process.env.PRVISION_DATA_DIR ?? path.join(os.homedir(), ".prvision");

// Everything below must be set before the first backend import: config-consts evaluates every constant ONCE,
// when it is first imported (00 §14.12). Tests never change these values afterwards (see "Config in tests").
process.env.NODE_ENV = "test"; // env.ts skips .env when NODE_ENV=test: tests are hermetic
// Logs are produced (so tests can assert on them) but go to logTestStream (04 §9.10, 00 §14.10), which drops
// them unless a test subscribed or PRVISION_TEST_LOG_STDOUT=1.
process.env.LOG_LEVEL ??= "debug";
// Never connected to by unit tests; present so validateConfig() passes in tests that call it.
process.env.DATABASE_URL ??= "postgres://prvision:prvision@127.0.0.1:5433/prvision_test";
process.env.REDIS_URL ??= "redis://127.0.0.1:6380/15";
// Deterministic, obviously fake 32-byte key. Never a real key.
process.env.PRVISION_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

// Unit and integration tests never touch ~/.prvision: every test file process gets its own data dir.
const sessionDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prvision-test-session-")));
process.env.PRVISION_DATA_DIR = sessionDataDir;
process.on("exit", () => {
  if (process.env.PRVISION_KEEP_TEST_ARTIFACTS === "1") {
    process.stderr.write(`[setup] kept test data dir: ${sessionDataDir}\n`);
    return;
  }
  fs.rmSync(sessionDataDir, { recursive: true, force: true });
});

// Sweep temp dirs left by crashed runs (older than 2 h). Cheap: one readdir per test file.
for (const name of fs.readdirSync(os.tmpdir())) {
  if (!TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    continue;
  }
  const full = path.join(os.tmpdir(), name);
  try {
    if (Date.now() - fs.statSync(full).mtimeMs > STALE_TEMP_MS) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {
    // Owned by a concurrent process or already gone: nothing to sweep.
  }
}

installNetworkGuard();
