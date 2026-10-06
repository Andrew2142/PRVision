/**
 * WorkspacePrepareService against real git (07 §9): real GitClient, real worktrees under the per-process test data
 * dir (tests/backend/helpers/setup.ts), throw-away clones. Skipped when git is missing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  WorkspacePrepareService,
  type WorkspacePrepareInput
} from "../../../backend/src/services/visualizations/pipeline/workspace-prepare-service";
import { ArtifactStore, GitClient } from "../../../backend/src/utilities";
import { ConsoleRecorder } from "../helpers/console-recorder";
import { makeTempDir } from "../helpers/temp-dir";
import { createBranchRepo, gitAvailable, withTempGitRepo, type TempGitRepo } from "./helpers/temp-git-repo";

const skip = gitAvailable() ? false : "git is not installed";
let nextId = 100;

function templatesDir(t: TestContext): string {
  const dir = makeTempDir("templates");
  t.after(dir.cleanup);
  fs.writeFileSync(path.join(dir.path, "index.html"), "<div id=root></div>");
  return dir.path;
}

function setup(
  t: TestContext,
  repo: TempGitRepo
): {
  service: WorkspacePrepareService;
  console: ConsoleRecorder;
  input(overrides: Partial<WorkspacePrepareInput>): WorkspacePrepareInput;
  cleanup(id: number, prNumber?: number | null): Promise<void>;
} {
  fs.mkdirSync(path.join(repo.path, "node_modules"), { recursive: true }); // git-ignored, like an installed clone
  const service = new WorkspacePrepareService({
    git: new GitClient(),
    artifacts: new ArtifactStore(),
    harnessTemplatesDir: templatesDir(t)
  });
  const consoleRecorder = new ConsoleRecorder();
  const cleanup = (id: number, prNumber: number | null = null): Promise<void> =>
    service.cleanup({ visualizationId: id, repositoryPath: repo.path, prNumber });
  return {
    service,
    console: consoleRecorder,
    input: (overrides) => ({
      visualizationId: (nextId += 1),
      sourceType: "local_branch",
      prNumber: null,
      baseRef: "main",
      headRef: "feature/restyle",
      repository: {
        id: 1,
        localPath: repo.path,
        githubOwner: null,
        githubRepo: null,
        viteConfigPath: "vite.config.ts"
      },
      console: consoleRecorder,
      signal: new AbortController().signal,
      ...overrides
    }),
    cleanup
  };
}

const headOf = (dir: string): string =>
  execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test(
  "WorkspacePrepareService (real git) local_branch: base and head worktrees are at the expected commits",
  { skip },
  async (t) => {
    const { repo, branchPoint, featureTip, mainTip } = createBranchRepo(t);
    const h = setup(t, repo);
    const input = h.input({});
    const workspace = await h.service.prepare(input);
    t.after(() => h.cleanup(input.visualizationId));

    assert.equal(workspace.baseSha, branchPoint, "base is the merge-base, not the main tip");
    assert.notEqual(workspace.baseSha, mainTip);
    assert.equal(workspace.baseSha, repo.git("merge-base", mainTip, featureTip));
    assert.equal(workspace.headSha, featureTip);
    assert.equal(headOf(workspace.baseDir), branchPoint);
    assert.equal(headOf(workspace.headDir), featureTip);
    assert.match(fs.readFileSync(path.join(workspace.headDir, "src/components/Button.tsx"), "utf8"), /className="b"/);
    assert.equal(fs.existsSync(path.join(workspace.baseDir, "src/components/Badge.tsx")), false);
    assert.equal(fs.readlinkSync(path.join(workspace.headDir, "node_modules")), path.join(repo.path, "node_modules"));
    assert.ok(fs.existsSync(path.join(workspace.baseDir, ".prvision-harness", "index.html")));
    h.console.assertStagesAreStatusNames();
  }
);

test(
  "WorkspacePrepareService (real git) working_tree: head contains staged, unstaged and untracked changes; base equals HEAD",
  { skip },
  async (t) => {
    const repo = withTempGitRepo(t, {
      files: {
        "src/App.tsx": "app v1\n",
        "src/Staged.tsx": "staged v1\n",
        "src/Gone.tsx": "gone\n",
        "package.json": "{}\n"
      }
    });
    const headSha = repo.sha();
    repo.dirty({ modify: { "src/Staged.tsx": "staged v2\n" }, stage: true });
    repo.dirty({
      modify: { "src/App.tsx": "app v2\n" },
      untracked: { "src/New.tsx": "new file\n" },
      remove: ["src/Gone.tsx"]
    });
    const before = repo.snapshot();
    const h = setup(t, repo);
    const input = h.input({ sourceType: "working_tree", baseRef: "main", headRef: "working-tree" });
    const workspace = await h.service.prepare(input);

    assert.equal(workspace.baseSha, headSha);
    assert.equal(workspace.headSha, null);
    assert.equal(headOf(workspace.baseDir), headSha);
    assert.equal(fs.readFileSync(path.join(workspace.baseDir, "src/App.tsx"), "utf8"), "app v1\n");
    assert.equal(fs.readFileSync(path.join(workspace.headDir, "src/App.tsx"), "utf8"), "app v2\n");
    assert.equal(fs.readFileSync(path.join(workspace.headDir, "src/Staged.tsx"), "utf8"), "staged v2\n");
    assert.equal(fs.readFileSync(path.join(workspace.headDir, "src/New.tsx"), "utf8"), "new file\n");
    assert.equal(fs.existsSync(path.join(workspace.headDir, "src/Gone.tsx")), false);
    assert.ok(h.console.has("info", "Applied uncommitted changes: 3 tracked file change(s), 1 untracked file(s)."));
    const during = repo.snapshot();
    assert.deepEqual({ ...during, worktrees: "" }, { ...before, worktrees: "" }, "working copy and index untouched");
    await h.cleanup(input.visualizationId);
    assert.deepEqual(repo.snapshot(), before);
  }
);

test(
  "WorkspacePrepareService (real git) working_tree: an untracked symlink escaping the repo is skipped",
  { skip },
  async (t) => {
    const repo = withTempGitRepo(t, { files: { "src/App.tsx": "app\n" } });
    const outside = makeTempDir("outside");
    t.after(outside.cleanup);
    fs.writeFileSync(path.join(outside.path, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside.path, "secret.txt"), path.join(repo.path, "escape-absolute"));
    fs.symlinkSync("../../outside-relative", path.join(repo.path, "src", "escape-relative"));
    fs.symlinkSync("App.tsx", path.join(repo.path, "src", "Alias.tsx"));
    const h = setup(t, repo);
    const input = h.input({ sourceType: "working_tree", baseRef: "main", headRef: "working-tree" });
    const workspace = await h.service.prepare(input);
    t.after(() => h.cleanup(input.visualizationId));

    assert.equal(fs.existsSync(path.join(workspace.headDir, "escape-absolute")), false);
    assert.equal(fs.existsSync(path.join(workspace.headDir, "src", "escape-relative")), false);
    assert.equal(
      fs.readlinkSync(path.join(workspace.headDir, "src", "Alias.tsx")),
      "App.tsx",
      "in-repo symlinks are kept"
    );
    assert.ok(h.console.has("warn", "Skipped symlink escape-absolute (points outside the repository)."));
    assert.ok(h.console.has("warn", "Skipped symlink src/escape-relative (points outside the repository)."));
  }
);

test(
  "WorkspacePrepareService (real git) after cleanup the clone has no extra worktrees, no refs/prvision/*, and an unchanged git status",
  { skip },
  async (t) => {
    const { repo, featureTip } = createBranchRepo(t);
    repo.dirty({ untracked: { "notes.txt": "user notes\n" } });
    const before = repo.snapshot();
    const h = setup(t, repo);
    const input = h.input({});
    const workspace = await h.service.prepare(input);
    // What a PR fetch leaves behind (07 §5.13.2), created directly so the test needs no network.
    repo.git("update-ref", "refs/prvision/pr-12", featureTip);
    repo.git("update-ref", "refs/prvision/pr-12-base", featureTip);
    assert.equal(
      repo
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree ")).length,
      3
    );

    await h.cleanup(input.visualizationId, 12);
    assert.equal(repo.git("for-each-ref", "refs/prvision"), "");
    assert.deepEqual(await new GitClient().worktreeList(repo.path), [repo.path]);
    assert.equal(fs.existsSync(path.dirname(workspace.baseDir)), false, "worktree root removed");
    assert.ok(fs.existsSync(path.join(repo.path, "node_modules")), "the user's node_modules is intact");
    assert.deepEqual(repo.snapshot(), before);
  }
);

test(
  "WorkspacePrepareService (real git) worktree creation does not run a post-checkout hook in the repo",
  { skip },
  async (t) => {
    const { repo } = createBranchRepo(t);
    const markerDir = makeTempDir("hook-marker");
    t.after(markerDir.cleanup);
    const marker = path.join(markerDir.path, "hook-ran");
    repo.git("config", "--unset", "core.hooksPath"); // let .git/hooks apply, as in a normal clone
    const hook = path.join(repo.path, ".git", "hooks", "post-checkout");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    execFileSync("git", ["-C", repo.path, "checkout", "-q", "feature/restyle"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
    });
    execFileSync("git", ["-C", repo.path, "checkout", "-q", "main"], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
    });
    assert.ok(fs.existsSync(marker), "sanity: the hook runs for a plain checkout");
    fs.rmSync(marker);

    const h = setup(t, repo);
    const input = h.input({});
    await h.service.prepare(input);
    t.after(() => h.cleanup(input.visualizationId));
    assert.equal(fs.existsSync(marker), false, "PRVision's worktree add never runs hooks");
  }
);
