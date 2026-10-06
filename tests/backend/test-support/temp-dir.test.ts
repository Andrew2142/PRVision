import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTempDir, useTempDataDir } from "../helpers/temp-dir";

test("makeTempDir creates a unique realpath dir under os.tmpdir() named prvision-test-<label>-*, and cleanup removes it", () => {
  const first = makeTempDir("unit");
  const second = makeTempDir("unit");
  try {
    assert.notEqual(first.path, second.path);
    assert.equal(first.path, fs.realpathSync(first.path));
    assert.ok(first.path.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    assert.match(path.basename(first.path), /^prvision-test-unit-/);
    assert.ok(fs.statSync(first.path).isDirectory());
  } finally {
    first.cleanup();
    second.cleanup();
  }
  assert.equal(fs.existsSync(first.path), false);
  assert.equal(fs.existsSync(second.path), false);
});

test("useTempDataDir returns an empty dir and removes it in t.after without touching process.env", async (t) => {
  const envBefore = { ...process.env };
  let created = "";
  await t.test("inner", (inner) => {
    created = useTempDataDir(inner);
    assert.deepEqual(fs.readdirSync(created), []);
    fs.writeFileSync(path.join(created, "file.txt"), "x");
  });
  assert.notEqual(created, "");
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual({ ...process.env }, envBefore);
});
