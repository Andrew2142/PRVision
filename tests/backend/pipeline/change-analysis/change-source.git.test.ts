import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { ChangeSource } from "../../../../backend/src/services/visualizations/pipeline/change-source";
import { GitClient } from "../../../../backend/src/utilities/services/git-client";
import { makeWorktrees } from "./helpers/worktree-fixture";

const noGit = spawnSync("git", ["--version"]).status !== 0 ? "git is not available" : false;

test("real git diff --no-index lists working-tree changes with renames", { skip: noGit }, async (t) => {
  const body = Array.from({ length: 20 }, (_, i) => `export const v${String(i)} = ${String(i)};`).join("\n");
  const wt = await makeWorktrees({
    base: { "src/c/A.tsx": body, "src/m.ts": "a", "src/old.ts": "gone" },
    head: { "src/c/B.tsx": body, "src/m.ts": "b", "src/new.ts": "new" }
  });
  t.after(() => wt.cleanup());
  const source = new ChangeSource(
    new GitClient(),
    {
      visualizationId: 1,
      repositoryPath: wt.root,
      baseDir: wt.baseDir,
      headDir: wt.headDir,
      baseSha: "a".repeat(40),
      headSha: null,
      sourceType: "working_tree",
      dependencyDrift: false
    },
    new AbortController().signal
  );
  assert.deepEqual(await source.listChanges(), [
    { path: "src/c/B.tsx", status: "R", previousPath: "src/c/A.tsx" },
    { path: "src/m.ts", status: "M" },
    { path: "src/new.ts", status: "A" },
    { path: "src/old.ts", status: "D" }
  ]);
});
