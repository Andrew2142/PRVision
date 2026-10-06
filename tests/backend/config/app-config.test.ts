import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  API_PREFIX,
  APP_HOST,
  APP_PORT,
  ARTIFACTS_ROUTE,
  CHILD_PROCESS_BASE_ENV,
  CHILD_PROCESS_ENV_ALLOWED_PREFIXES,
  CHILD_PROCESS_ENV_ALLOWLIST,
  DATABASE_URL,
  DATA_DIR,
  FRONTEND_URL,
  IS_TEST,
  PRVISION_SECRET_KEY,
  REDIS_URL,
  resolveDataDir
} from "../../../backend/src/config-consts";
import { optionalEnv, optionalIntegerEnv, pickEnv } from "../../../backend/src/utilities/helpers/env";

const isUnset = (name: string): boolean => (process.env[name] ?? "").trim() === "";

test("app.config PORT defaults to 3100", { skip: !isUnset("PORT") }, () => {
  assert.equal(APP_PORT, 3100);
});

test("app.config HOST defaults to 127.0.0.1", { skip: !isUnset("HOST") }, () => {
  assert.equal(APP_HOST, "127.0.0.1");
});

test("app.config FRONTEND_URL defaults to http://localhost:4210", { skip: !isUnset("FRONTEND_URL") }, () => {
  assert.equal(FRONTEND_URL, "http://localhost:4210");
});

test("app.config IS_TEST is true under the test preload", () => {
  assert.equal(IS_TEST, true);
});

test("app.config DATA_DIR is the resolved PRVISION_DATA_DIR", () => {
  assert.equal(DATA_DIR, resolveDataDir(process.env.PRVISION_DATA_DIR ?? "~/.prvision"));
  assert.ok(path.isAbsolute(DATA_DIR));
});

test("app.config required env constants mirror the environment", () => {
  assert.equal(DATABASE_URL, (process.env.DATABASE_URL ?? "").trim());
  assert.equal(REDIS_URL, (process.env.REDIS_URL ?? "").trim());
  assert.equal(PRVISION_SECRET_KEY, (process.env.PRVISION_SECRET_KEY ?? "").trim());
});

test("app.config route prefixes match 00 §9", () => {
  assert.equal(API_PREFIX, "/api");
  assert.equal(ARTIFACTS_ROUTE, "/artifacts");
});

test("resolveDataDir expands ~ and normalises", () => {
  assert.equal(resolveDataDir("~"), os.homedir());
  assert.equal(resolveDataDir("~/x/y"), path.join(os.homedir(), "x", "y"));
  assert.equal(resolveDataDir("/tmp/a/../b"), "/tmp/b");
});

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name];
  try {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
    fn();
  } finally {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = saved;
    }
  }
}

test("optionalEnv trims and treats blank as unset", () => {
  withEnv("PRVISION_SCAFFOLD_TEST", "  value  ", () => {
    assert.equal(optionalEnv("PRVISION_SCAFFOLD_TEST"), "value");
  });
  withEnv("PRVISION_SCAFFOLD_TEST", "   ", () => {
    assert.equal(optionalEnv("PRVISION_SCAFFOLD_TEST"), undefined);
  });
  withEnv("PRVISION_SCAFFOLD_TEST", undefined, () => {
    assert.equal(optionalEnv("PRVISION_SCAFFOLD_TEST"), undefined);
  });
});

test("optionalIntegerEnv returns NaN instead of throwing", () => {
  withEnv("PRVISION_SCAFFOLD_TEST", "4210", () => {
    assert.equal(optionalIntegerEnv("PRVISION_SCAFFOLD_TEST"), 4210);
  });
  withEnv("PRVISION_SCAFFOLD_TEST", "12abc", () => {
    assert.ok(Number.isNaN(optionalIntegerEnv("PRVISION_SCAFFOLD_TEST")));
  });
  withEnv("PRVISION_SCAFFOLD_TEST", undefined, () => {
    assert.equal(optionalIntegerEnv("PRVISION_SCAFFOLD_TEST"), undefined);
  });
});

test("pickEnv selects names and prefixes", () => {
  withEnv("LC_PRVISION_TEST", "x", () => {
    const picked = pickEnv(["PATH"], ["LC_"]);
    assert.equal(picked.LC_PRVISION_TEST, "x");
    assert.equal(picked.PATH, process.env.PATH);
    assert.equal(picked.PRVISION_SECRET_KEY, undefined);
  });
});

test("CHILD_PROCESS_BASE_ENV contains only allow-listed names and no PRVision secrets", () => {
  const allowed: readonly string[] = CHILD_PROCESS_ENV_ALLOWLIST;
  for (const name of Object.keys(CHILD_PROCESS_BASE_ENV)) {
    assert.ok(
      allowed.includes(name) || CHILD_PROCESS_ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix)),
      name
    );
  }
  for (const secret of ["PRVISION_SECRET_KEY", "DATABASE_URL", "REDIS_URL", "NODE_OPTIONS"]) {
    assert.equal(CHILD_PROCESS_BASE_ENV[secret], undefined, secret);
  }
  assert.ok(Object.isFrozen(CHILD_PROCESS_BASE_ENV));
});
