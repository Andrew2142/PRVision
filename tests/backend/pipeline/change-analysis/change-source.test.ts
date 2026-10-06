import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ANALYSIS_MAX_FILE_BYTES, CODE_DIFF_MAX_LINES } from "../../../../backend/src/config-consts";
import {
  ChangeSource,
  CODE_DIFF_TRUNCATION_MARKER,
  buildUnifiedDiff,
  classifySourcePath,
  hasGeneratedMarker,
  normalizeEntries,
  truncateDiff
} from "../../../../backend/src/services/visualizations/pipeline/change-source";
import { PipelineStepError, type PreparedWorkspace } from "../../../../backend/src/types/visualization-pipeline";
import { GitCommandError } from "../../../../backend/src/utilities/services/git-client";
import { makeWorktrees, stubGitClient } from "./helpers/worktree-fixture";

function workspace(overrides: Partial<PreparedWorkspace>): PreparedWorkspace {
  return {
    visualizationId: 1,
    repositoryPath: "/clone",
    baseDir: "/data/worktrees/1/base",
    headDir: "/data/worktrees/1/head",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sourceType: "local_branch",
    dependencyDrift: false,
    ...overrides
  };
}

test("normalizes POSIX paths, dedupes and sorts entries", () => {
  const out = normalizeEntries([
    { status: "M", path: "src\\b.ts" },
    { status: "A", path: "src/a.ts" },
    { status: "D", path: "src/b.ts" }
  ]);
  assert.deepEqual(out, [
    { path: "src/a.ts", status: "A" },
    { path: "src/b.ts", status: "M" }
  ]);
});

test("maps C to A, T and U to M, keeps R previousPath and drops X", () => {
  const out = normalizeEntries([
    { status: "C", score: 90, path: "src/copy.ts", previousPath: "src/orig.ts" },
    { status: "T", path: "src/t.ts" },
    { status: "U", path: "src/u.ts" },
    { status: "R", score: 92, path: "src/new.ts", previousPath: "src/old.ts" },
    { status: "X", path: "src/x.ts" }
  ]);
  assert.deepEqual(out, [
    { path: "src/copy.ts", status: "A" },
    { path: "src/new.ts", status: "R", previousPath: "src/old.ts" },
    { path: "src/t.ts", status: "M" },
    { path: "src/u.ts", status: "M" }
  ]);
});

test("strips base/ and head/ prefixes from no-index output", () => {
  const out = normalizeEntries(
    [
      { status: "R", score: 100, path: "head/src/c/B.tsx", previousPath: "base/src/c/A.tsx" },
      { status: "M", path: "base/src/m.ts" },
      { status: "A", path: "head/src/new.ts" },
      { status: "D", path: "base/src/old.ts" }
    ],
    ["base/", "head/"]
  );
  assert.deepEqual(out, [
    { path: "src/c/B.tsx", status: "R", previousPath: "src/c/A.tsx" },
    { path: "src/m.ts", status: "M" },
    { path: "src/new.ts", status: "A" },
    { path: "src/old.ts", status: "D" }
  ]);
});

test("maps GitCommandError aborted to ANALYSIS_CANCELLED and others to ANALYSIS_GIT_DIFF_FAILED", async () => {
  const signal = new AbortController().signal;
  const aborted = new ChangeSource(
    stubGitClient(new GitCommandError("git diff failed (aborted)", "aborted", "diff", null, "")),
    workspace({}),
    signal
  );
  await assert.rejects(aborted.listChanges(), (error: unknown) => {
    assert.ok(error instanceof PipelineStepError);
    assert.equal(error.code, "ANALYSIS_CANCELLED");
    assert.equal(error.stage, "analyzing");
    assert.equal(error.userMessage, "Cancelled.");
    return true;
  });
  const failed = new ChangeSource(
    stubGitClient(new GitCommandError("git diff failed (unknown_revision)", "unknown_revision", "diff", 128, "bad")),
    workspace({}),
    signal
  );
  await assert.rejects(failed.listChanges(), (error: unknown) => {
    assert.ok(error instanceof PipelineStepError);
    assert.equal(error.code, "ANALYSIS_GIT_DIFF_FAILED");
    assert.equal(error.userMessage, "Could not list the changed files (git diff failed).");
    assert.match(error.message, /^ANALYSIS_GIT_DIFF_FAILED: /);
    return true;
  });
});

test("uses no-index for working_tree and diffNameStatus for commit modes", async (t) => {
  const wt = await makeWorktrees({ base: { "src/a.ts": "1" }, head: { "src/a.ts": "2" } });
  t.after(() => wt.cleanup());
  const signal = new AbortController().signal;
  const commit = stubGitClient([{ status: "M", path: "src/a.ts" }]);
  await new ChangeSource(commit, workspace({ baseDir: wt.baseDir, headDir: wt.headDir }), signal).listChanges();
  assert.equal(commit.calls.length, 1);
  assert.equal(commit.calls[0]?.method, "diffNameStatus");
  assert.deepEqual(commit.calls[0].args, [wt.headDir, "a".repeat(40), "b".repeat(40), { renames: true }, { signal }]);

  const working = stubGitClient([{ status: "M", path: "base/src/a.ts" }]);
  const out = await new ChangeSource(
    working,
    workspace({ baseDir: wt.baseDir, headDir: wt.headDir, sourceType: "working_tree", headSha: null }),
    signal
  ).listChanges();
  assert.equal(working.calls[0]?.method, "diffNameStatusNoIndex");
  assert.deepEqual(working.calls[0].args, [
    path.dirname(wt.baseDir),
    "base/src",
    "head/src",
    { renames: true },
    { signal }
  ]);
  assert.deepEqual(out, [{ path: "src/a.ts", status: "M" }]);
});

test("lists all files as added when base lacks src", async (t) => {
  const wt = await makeWorktrees({
    base: { "README.md": "x" },
    head: { "src/b.tsx": "b", "src/a/a.ts": "a", "src/.hidden/x.ts": "h" }
  });
  t.after(() => wt.cleanup());
  const git = stubGitClient([]);
  const out = await new ChangeSource(
    git,
    workspace({ baseDir: wt.baseDir, headDir: wt.headDir, sourceType: "working_tree", headSha: null }),
    new AbortController().signal
  ).listChanges();
  assert.equal(git.calls.length, 0);
  assert.deepEqual(out, [
    { path: "src/a/a.ts", status: "A" },
    { path: "src/b.tsx", status: "A" }
  ]);
});

test("classifySourcePath table", () => {
  const opts = { sourceRoot: "src" };
  const row = (p: string) => {
    const c = classifySourcePath(p, opts);
    return [c.role, c.inGraph, c.analysable, c.excludeReason];
  };
  assert.deepEqual(row("lib/x.ts"), ["source", false, false, "outside src/"]);
  assert.deepEqual(row("src/node_modules/x.ts"), ["source", false, false, "ignored directory"]);
  assert.deepEqual(row("src/.storybook/x.ts"), ["source", false, false, "ignored directory"]);
  assert.deepEqual(row("src/types/global.d.ts"), ["source", false, false, "declaration file"]);
  assert.deepEqual(row("src/assets/logo.svg"), ["source", false, false, "unsupported extension"]);
  assert.deepEqual(row("src/components/Button.test.tsx"), ["test", true, false, "test file"]);
  assert.deepEqual(row("src/__tests__/a.ts"), ["test", true, false, "test file"]);
  assert.deepEqual(row("src/setupTests.ts"), ["test", true, false, "test file"]);
  assert.deepEqual(row("src/components/Button.stories.tsx"), ["story", true, false, "story file"]);
  assert.deepEqual(row("src/docs/Intro.mdx"), ["story", false, false, "story file"]);
  assert.deepEqual(row("src/api/__generated__/types.ts"), ["generated", true, false, "generated file"]);
  assert.deepEqual(row("src/api/client.gen.ts"), ["generated", true, false, "generated file"]);
  assert.deepEqual(row("src/components/Button.tsx"), ["source", true, true, null]);
  assert.equal(classifySourcePath("src/a.module.scss", opts).language, "style");
  assert.equal(classifySourcePath("src/a.mjs", opts).language, "script");
});

test("detects generated marker in file header", () => {
  assert.equal(hasGeneratedMarker("// @generated by codegen\nexport const a = 1;"), true);
  assert.equal(hasGeneratedMarker("/* Auto-generated. DO NOT EDIT */"), true);
  assert.equal(hasGeneratedMarker(`${"x".repeat(600)} @generated`), false);
  assert.equal(hasGeneratedMarker("export const a = 1;"), false);
});

test("buildUnifiedDiff produces new/deleted/rename headers", () => {
  const added = buildUnifiedDiff({ oldPath: null, newPath: "src/a.ts", oldText: null, newText: "a\n" });
  assert.match(
    added.diff,
    /^diff --git a\/src\/a\.ts b\/src\/a\.ts\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/src\/a\.ts\n@@ /
  );
  const deleted = buildUnifiedDiff({ oldPath: "src/a.ts", newPath: null, oldText: "a\n", newText: null });
  assert.match(
    deleted.diff,
    /^diff --git a\/src\/a\.ts b\/src\/a\.ts\ndeleted file mode 100644\n--- a\/src\/a\.ts\n\+\+\+ \/dev\/null/
  );
  const renamed = buildUnifiedDiff({ oldPath: "src/Old.tsx", newPath: "src/New.tsx", oldText: "a\n", newText: "b\n" });
  assert.match(
    renamed.diff,
    /rename from src\/Old\.tsx\nrename to src\/New\.tsx\n--- a\/src\/Old\.tsx\n\+\+\+ b\/src\/New\.tsx/
  );
});

test("buildUnifiedDiff counts changed lines", () => {
  const out = buildUnifiedDiff({
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    oldText: "one\ntwo\nthree\n",
    newText: "one\n2\nthree\nfour\n"
  });
  assert.equal(out.changedLines, 3);
  assert.match(out.diff, /@@ -1,3 \+1,4 @@/);
});

test("truncateDiff keeps 400 lines and appends marker", () => {
  const diff = Array.from({ length: 450 }, (_, i) => `line ${String(i)}`).join("\n");
  const out = truncateDiff(diff, CODE_DIFF_MAX_LINES).split("\n");
  assert.equal(out.length, 401);
  assert.equal(out[399], "line 399");
  assert.equal(out[400], CODE_DIFF_TRUNCATION_MARKER(400, 450));
  assert.equal(out[400], "… [PRVision: diff truncated — showing 400 of 450 lines]");
  assert.equal(truncateDiff("a\nb", 400), "a\nb");
});

test("readText rejects symlinks and paths escaping the worktree", async (t) => {
  const wt = await makeWorktrees({ base: {}, head: { "src/real.ts": "export const a = 1;\r\n" } });
  t.after(() => wt.cleanup());
  await fs.writeFile(path.join(wt.root, "secret.txt"), "secret");
  await fs.symlink(path.join(wt.root, "secret.txt"), path.join(wt.headDir, "src", "link.ts"));
  const source = new ChangeSource(
    stubGitClient([]),
    workspace({ baseDir: wt.baseDir, headDir: wt.headDir }),
    new AbortController().signal
  );
  const link = await source.readText("head", "src/link.ts");
  assert.equal(link.text, null);
  assert.equal(link.unsafe, true);
  const escape = await source.readText("head", "../../../secret.txt");
  assert.equal(escape.text, null);
  assert.equal(escape.unsafe, true);
  const real = await source.readText("head", "src/real.ts");
  assert.equal(real.text, "export const a = 1;\n", "CRLF normalized");
});

test("readText flags files over size limit and binary files", async (t) => {
  const wt = await makeWorktrees({
    base: {},
    head: { "src/big.ts": "x".repeat(ANALYSIS_MAX_FILE_BYTES + 1), "src/bom.ts": "﻿export {}" }
  });
  t.after(() => wt.cleanup());
  await fs.writeFile(path.join(wt.headDir, "src", "bin.ts"), Buffer.from([0x61, 0x00, 0x62]));
  const source = new ChangeSource(
    stubGitClient([]),
    workspace({ baseDir: wt.baseDir, headDir: wt.headDir }),
    new AbortController().signal
  );
  const big = await source.readText("head", "src/big.ts");
  assert.deepEqual([big.text, big.tooLarge, big.binary], [null, true, false]);
  const bin = await source.readText("head", "src/bin.ts");
  assert.deepEqual([bin.text, bin.tooLarge, bin.binary], [null, false, true]);
  assert.equal((await source.readText("head", "src/bom.ts")).text, "export {}");
  assert.equal((await source.readText("head", "src/missing.ts")).text, null);
});
