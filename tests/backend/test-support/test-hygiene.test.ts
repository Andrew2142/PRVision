import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const TESTS_ROOT = path.resolve(__dirname, "..");
const SETUP_FILE = path.join(TESTS_ROOT, "helpers", "setup.ts");

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : tsFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Offending lines as "relative/path.ts:line: text", ignoring this file (its patterns are built from parts). */
function scan(pattern: RegExp, exclude: readonly string[] = []): string[] {
  const hits: string[] = [];
  for (const file of tsFiles(TESTS_ROOT)) {
    if (file === __filename || exclude.includes(file)) {
      continue;
    }
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (pattern.test(line)) {
          hits.push(`${path.relative(TESTS_ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  return hits;
}

test("no file under tests/backend constructs PipelineStepError with an object as first argument", () => {
  assert.deepEqual(scan(new RegExp(["new Pipeline", "StepError\\(\\s*\\{"].join(""))), []);
});

test("no file under tests/backend assigns process.env after the preload", () => {
  // 14 §10: plain and ??= assignments to env variables, and env deletions; comparisons such as `=== "1"` are fine.
  const env = ["process", "env"].join("\\.");
  const assignment = new RegExp(`${env}\\.[A-Z_][A-Z0-9_]*\\s*(\\?\\?)?=(?!=)`);
  const deletion = new RegExp(`delete\\s+${env}`);
  assert.deepEqual(scan(assignment, [SETUP_FILE]), []);
  assert.deepEqual(scan(deletion, [SETUP_FILE]), []);
});
