import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { LibraryWorkspace } from "../../../backend/src/services/harness-library/library-workspace";
import { PipelineStepError } from "../../../backend/src/types/visualization-pipeline";
import { ArtifactStore } from "../../../backend/src/utilities/services/artifact-store";
import { reactViteFiles, withTempGitRepo } from "../helpers/temp-git-repo";

function recordingConsole(): {
  lines: string[];
  console: { info: () => Promise<void>; warn: (s: string, m: string) => Promise<void>; error: () => Promise<void> };
} {
  const lines: string[] = [];
  return {
    lines,
    console: {
      info: () => Promise.resolve(),
      warn: (_stage: string, message: string) => {
        lines.push(message);
        return Promise.resolve();
      },
      error: () => Promise.resolve()
    }
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

test("resolveScanCommit uses the local default branch, then origin's, else fails with the 16 §10.3 message", async (t) => {
  const repo = withTempGitRepo(t, { files: reactViteFiles() });
  const main = repo.sha();
  const workspace = new LibraryWorkspace();
  assert.equal(await workspace.resolveScanCommit(repo.path, "main"), main);

  repo.createBareOrigin();
  repo.branch("feature");
  repo.git("branch", "-D", "main");
  assert.equal(await workspace.resolveScanCommit(repo.path, "main"), main, "refs/remotes/origin/main");

  await assert.rejects(
    workspace.resolveScanCommit(repo.path, "develop"),
    (error: unknown) =>
      error instanceof PipelineStepError &&
      error.stage === "preparing" &&
      error.userMessage === "The default branch develop was not found in the clone."
  );
});

test("prepare creates one detached worktree at the scan commit with node_modules linked; cleanup removes it", async (t) => {
  const repo = withTempGitRepo(t, {
    files: reactViteFiles({ ".prvision-harness/stale.txt": "committed" }),
    nodeModules: true
  });
  const sha = repo.sha();
  const before = repo.snapshot();
  const workspace = new LibraryWorkspace();
  const out = recordingConsole();
  const prepared = await workspace.prepare({
    jobId: 41,
    repository: {
      localPath: repo.path,
      defaultBranch: "main",
      framework: "react_vite",
      appRoot: ".",
      viteConfigPath: "vite.config.ts"
    },
    scanSha: sha,
    console: out.console,
    signal: new AbortController().signal
  });
  const root = path.join(new ArtifactStore().worktreesRoot(), "scan-41");
  assert.equal(prepared.root, root);
  assert.equal(prepared.headDir, path.join(root, "head"));
  assert.deepEqual(prepared.workspace, {
    visualizationId: 0,
    repositoryPath: repo.path,
    baseDir: prepared.headDir,
    headDir: prepared.headDir,
    baseSha: sha,
    headSha: sha,
    sourceType: "local_branch",
    dependencyDrift: false
  });
  assert.equal((await fs.lstat(path.join(prepared.headDir, "node_modules"))).isSymbolicLink(), true);
  assert.equal(
    await fs.realpath(path.join(prepared.headDir, "node_modules")),
    await fs.realpath(path.join(repo.path, "node_modules"))
  );
  assert.equal(
    await exists(path.join(prepared.headDir, ".prvision-harness")),
    false,
    "a committed harness dir is removed"
  );
  assert.deepEqual(out.lines, ["The repository contains a .prvision-harness entry; it was replaced."]);
  assert.ok(repo.git("worktree", "list").includes("scan-41"));

  await workspace.cleanup({
    jobId: 41,
    repository: { localPath: repo.path, appRoot: ".", viteConfigPath: "vite.config.ts" }
  });
  assert.equal(await exists(root), false);
  assert.equal(repo.git("worktree", "list").includes("scan-41"), false);
  assert.equal(await exists(path.join(repo.path, "node_modules")), true, "the user's node_modules is untouched");
  const after = repo.snapshot();
  assert.equal(after.status, before.status);
  assert.equal(after.branches, before.branches);
  assert.equal(after.nonPrvisionRefs, before.nonPrvisionRefs);
  assert.equal(after.indexHash, before.indexHash);
});

test("cleanup never throws, also without a repository or a worktree", async () => {
  const workspace = new LibraryWorkspace();
  await workspace.cleanup({ jobId: 77, repository: null });
  await workspace.cleanup({
    jobId: 78,
    repository: { localPath: "/does/not/exist", appRoot: ".", viteConfigPath: null }
  });
});
