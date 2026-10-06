import assert from "node:assert/strict";
import test from "node:test";
import {
  PathOutsideRootError,
  expandHome,
  isPathInside,
  normalizeRepoRelativePath,
  resolveInside,
  toPosixPath
} from "../../../backend/src/utilities/helpers/paths";

test("expandHome expands ~ and ~/x only", () => {
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("~/code/app", "/home/u"), "/home/u/code/app");
  assert.equal(expandHome("~other/app", "/home/u"), "~other/app");
  assert.equal(expandHome("/abs/~/x", "/home/u"), "/abs/~/x");
  assert.equal(expandHome("rel", "/home/u"), "rel");
});

test("isPathInside handles prefixes (/a/b vs /a/bc)", () => {
  assert.equal(isPathInside("/a/b", "/a/b"), true);
  assert.equal(isPathInside("/a/b", "/a/b/c"), true);
  assert.equal(isPathInside("/a/b", "/a/bc"), false);
  assert.equal(isPathInside("/a/b", "/a"), false);
  assert.equal(isPathInside("/a/b", "/a/b/../c"), false);
  assert.equal(isPathInside("/a/b", "/a/b/..foo"), true);
});

test("resolveInside rejects ../ escapes and NUL", () => {
  assert.equal(resolveInside("/root", "x", "y.txt"), "/root/x/y.txt");
  assert.throws(() => resolveInside("/root", "../etc/passwd"), PathOutsideRootError);
  assert.throws(() => resolveInside("/root", "a/../../b"), PathOutsideRootError);
  assert.throws(() => resolveInside("/root", "/etc"), PathOutsideRootError);
  assert.throws(() => resolveInside("/root", "a\0b"), PathOutsideRootError);
});

test("normalizeRepoRelativePath strips ./ and rejects .., absolute, empty", () => {
  assert.equal(normalizeRepoRelativePath("./src/App.tsx"), "src/App.tsx");
  assert.equal(normalizeRepoRelativePath("src//components/./Button.tsx"), "src/components/Button.tsx");
  assert.equal(normalizeRepoRelativePath("src\\x.ts"), "src/x.ts");
  for (const bad of ["../x", "src/../../x", "/etc/passwd", "", ".", "a\0b", "C:/x"]) {
    assert.throws(() => normalizeRepoRelativePath(bad), PathOutsideRootError, `must reject ${JSON.stringify(bad)}`);
  }
});

test("toPosixPath converts backslashes", () => {
  assert.equal(toPosixPath("a\\b\\c"), "a/b/c");
});
