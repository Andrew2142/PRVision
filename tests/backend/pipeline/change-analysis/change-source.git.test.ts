import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  ChangeSource,
  workingTreeTriggerCandidates,
  type WorkingTreeTriggerScope
} from "../../../../backend/src/services/visualizations/pipeline/change-source";
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

function workingTreeSource(
  wt: { root: string; baseDir: string; headDir: string },
  sourceRoot: string,
  scope: WorkingTreeTriggerScope | null
): ChangeSource {
  return new ChangeSource(
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
    new AbortController().signal,
    sourceRoot,
    scope
  );
}

test(
  "working-tree changes include the trigger files outside the source root (16 §8.5.3)",
  { skip: noGit },
  async (t) => {
    const wt = await makeWorktrees({
      base: {
        "apps/web/src/main.ts": "a",
        "tailwind.config.js": "module.exports = { theme: {} };",
        "postcss.config.cjs": "module.exports = {};",
        "apps/web/index.html": "<html></html>",
        "apps/web/.postcssrc.json": "{}",
        "styles/global.css": "body { margin: 0 }",
        "apps/web/tailwind.config.ts": "export default { theme: { colors: {} } };",
        "README.md": "a"
      },
      head: {
        "apps/web/src/main.ts": "b",
        "tailwind.config.js": "module.exports = { theme: {} };",
        "postcss.config.cjs": "module.exports = { plugins: [] };",
        "apps/web/index.html": "<html lang=en></html>",
        "apps/angular.json": "{}",
        "styles/global.css": "body { margin: 1px }",
        "apps/web/tailwind.config.ts": "export default { theme: { colors: {} } };",
        "README.md": "b"
      }
    });
    t.after(() => wt.cleanup());
    const scope: WorkingTreeTriggerScope = {
      appRoot: "apps/web",
      viteConfigPath: null,
      globalStylePaths: ["/styles/global.css", "bootstrap/dist/css/bootstrap.css"]
    };
    assert.deepEqual(await workingTreeSource(wt, "apps/web/src", scope).listChanges(), [
      { path: "apps/angular.json", status: "A" },
      { path: "apps/web/.postcssrc.json", status: "D" },
      { path: "apps/web/index.html", status: "M" },
      { path: "apps/web/src/main.ts", status: "M" },
      { path: "postcss.config.cjs", status: "M" },
      { path: "styles/global.css", status: "M" }
    ]);
    // Without a scope (non-trigger callers) only the source root is compared, as before.
    assert.deepEqual(await workingTreeSource(wt, "apps/web/src", null).listChanges(), [
      { path: "apps/web/src/main.ts", status: "M" }
    ]);
  }
);

test(
  "working-tree trigger files: an unchanged tailwind.config.js produces no entry and a symlinked candidate is ignored",
  { skip: noGit },
  async (t) => {
    const wt = await makeWorktrees({
      base: { "src/main.tsx": "a", "tailwind.config.js": "same", "elsewhere.js": "x" },
      head: { "src/main.tsx": "a", "tailwind.config.js": "same", "elsewhere.js": "y" }
    });
    t.after(() => wt.cleanup());
    await fs.symlink(path.join(wt.headDir, "elsewhere.js"), path.join(wt.headDir, "postcss.config.js"));
    await fs.symlink(path.join(wt.baseDir, "elsewhere.js"), path.join(wt.baseDir, "index.html"));
    await fs.writeFile(path.join(wt.headDir, "index.html"), "<html></html>");
    const scope: WorkingTreeTriggerScope = { appRoot: ".", viteConfigPath: "vite.config.ts", globalStylePaths: [] };
    assert.deepEqual(await workingTreeSource(wt, "src", scope).listChanges(), []);
    assert.deepEqual(
      workingTreeTriggerCandidates(scope).filter((candidate) => !candidate.includes("config")),
      [
        ".postcssrc",
        ".postcssrc.cjs",
        ".postcssrc.js",
        ".postcssrc.json",
        ".postcssrc.mjs",
        ".postcssrc.yaml",
        ".postcssrc.yml",
        "angular.json",
        "index.html",
        "src/index.html"
      ]
    );
  }
);
