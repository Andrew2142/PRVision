import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  RunWorkspaceRecreator,
  type RecreatorGit
} from "../../../backend/src/services/visualizations/run-workspace-recreator";
import type { SecretRead } from "../../../backend/src/services/settings/settings-store";
import { PipelineStepError } from "../../../backend/src/types/visualization-pipeline";
import { ArtifactStore } from "../../../backend/src/utilities/services/artifact-store";
import { GitClient } from "../../../backend/src/utilities/services/git-client";
import type { GitHubClient } from "../../../backend/src/utilities/services/github-client";
import { makeRepositoryModel, makeVisualizationModel } from "../helpers/factories";
import { makeTempDir } from "../helpers/temp-dir";
import { reactViteFiles, withTempGitRepo, type TempGitRepo } from "../helpers/temp-git-repo";

type PullRequest = Awaited<ReturnType<GitHubClient["getPullRequest"]>>;

const SIGNAL = new AbortController().signal;
let nextJob = 900;

function silentConsole(): {
  lines: string[];
  console: {
    info: (s: string, m: string) => Promise<void>;
    warn: (s: string, m: string) => Promise<void>;
    error: (s: string, m: string) => Promise<void>;
  };
} {
  const lines: string[] = [];
  const push = (_stage: string, message: string): Promise<void> => {
    lines.push(message);
    return Promise.resolve();
  };
  return { lines, console: { info: push, warn: push, error: push } };
}

function rootDir(): string {
  nextJob += 1;
  return path.join(new ArtifactStore().worktreesRoot(), `repair-${String(nextJob)}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** The real GitClient, with `origin` reported as the github.com remote of acme/shop (the URL points at a bare repo). */
function githubOriginGit(): RecreatorGit {
  const git = new GitClient();
  return {
    topLevel: (...args) => git.topLevel(...args),
    hasCommit: (...args) => git.hasCommit(...args),
    fetch: (...args) => git.fetch(...args),
    worktreeAdd: (...args) => git.worktreeAdd(...args),
    worktreeRemove: (...args) => git.worktreeRemove(...args),
    worktreePrune: (...args) => git.worktreePrune(...args),
    deleteRef: (...args) => git.deleteRef(...args),
    applyPatch: (...args) => git.applyPatch(...args),
    remoteUrl: (_cwd: string, remote?: string) =>
      Promise.resolve(remote === "origin" ? "https://github.com/acme/shop.git" : null)
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "Restyle",
    state: "open",
    merged: false,
    baseRef: "main",
    headRef: "feature/restyle",
    baseSha: "0".repeat(40),
    headSha: "0".repeat(40),
    isFork: false,
    headRepoFullName: "acme/shop",
    ...overrides
  } as PullRequest;
}

/** A repository with `main` (base) and a feature commit (head) on top. */
function twoCommitRepo(t: TestContext): { repo: TempGitRepo; base: string; head: string } {
  const repo = withTempGitRepo(t, { files: reactViteFiles(), nodeModules: true });
  const base = repo.sha();
  repo.branch("feature/restyle");
  const head = repo.commit("restyle", { "src/App.tsx": "export default function App() { return <p>new</p>; }\n" });
  repo.checkout("main");
  return { repo, base, head };
}

test("RunWorkspaceRecreator.recreate checks out base and head at the run's commits and links node_modules", async (t) => {
  const { repo, base, head } = twoCommitRepo(t);
  const before = repo.snapshot();
  const root = rootDir();
  const recreator = new RunWorkspaceRecreator();
  const recreated = await recreator.recreate({
    visualization: makeVisualizationModel({ id: 31, status: "completed", baseSha: base, headSha: head }),
    repository: makeRepositoryModel({ localPath: repo.path }),
    rootDir: root,
    console: silentConsole().console,
    signal: SIGNAL
  });
  const { workspace } = recreated;
  assert.equal(workspace.baseDir, path.join(root, "base"));
  assert.equal(workspace.headDir, path.join(root, "head"));
  assert.equal(workspace.baseSha, base);
  assert.equal(workspace.headSha, head);
  assert.equal(workspace.sourceType, "local_branch");
  assert.equal(workspace.visualizationId, 31);
  assert.match(await fs.readFile(path.join(workspace.headDir, "src/App.tsx"), "utf8"), /new/);
  assert.doesNotMatch(await fs.readFile(path.join(workspace.baseDir, "src/App.tsx"), "utf8"), /new/);
  for (const dir of [workspace.baseDir, workspace.headDir]) {
    assert.equal((await fs.lstat(path.join(dir, "node_modules"))).isSymbolicLink(), true);
  }

  await recreated.cleanup();
  assert.equal(await exists(root), false, "root removed");
  assert.equal(await exists(path.join(repo.path, "node_modules/react/package.json")), true, "user's node_modules kept");
  assert.deepEqual(repo.snapshot(), before, "the clone is unchanged after cleanup");
  await recreated.cleanup(); // idempotent, never throws
});

test("RunWorkspaceRecreator.recreate replays the working-tree snapshot onto a head worktree at base_sha", async (t) => {
  const repo = withTempGitRepo(t, { files: reactViteFiles(), nodeModules: true });
  const base = repo.sha();
  repo.dirty({
    modify: { "src/App.tsx": "export default function App() { return <p>uncommitted</p>; }\n" }
  });
  const patch = `${repo.git("diff", "--binary", "HEAD")}\n`;
  repo.git("checkout", "--", ".");
  const snapshots = makeTempDir("snapshots");
  t.after(() => {
    snapshots.cleanup();
  });
  const dir = path.join(snapshots.path, "44");
  await fs.mkdir(path.join(dir, "untracked/src"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ version: 1, baseSha: base, untracked: ["src/New.tsx"], createdAt: "2026-10-07T00:00:00.000Z" })
  );
  await fs.writeFile(path.join(dir, "changes.patch"), patch);
  await fs.writeFile(path.join(dir, "untracked/src/New.tsx"), "export const New = 1;\n");
  const before = repo.snapshot();

  const recreated = await new RunWorkspaceRecreator({ snapshotsRoot: snapshots.path }).recreate({
    visualization: makeVisualizationModel({
      id: 44,
      status: "completed",
      sourceType: "working_tree",
      baseRef: "main",
      headRef: "main",
      baseSha: base,
      headSha: null,
      workingTreeSnapshot: true
    }),
    repository: makeRepositoryModel({ localPath: repo.path }),
    rootDir: rootDir(),
    console: silentConsole().console,
    signal: SIGNAL
  });
  t.after(() => recreated.cleanup());
  assert.equal(recreated.workspace.headSha, null);
  assert.equal(recreated.workspace.baseSha, base);
  assert.match(await fs.readFile(path.join(recreated.workspace.headDir, "src/App.tsx"), "utf8"), /uncommitted/);
  assert.equal(
    await fs.readFile(path.join(recreated.workspace.headDir, "src/New.tsx"), "utf8"),
    "export const New = 1;\n"
  );
  assert.doesNotMatch(await fs.readFile(path.join(recreated.workspace.baseDir, "src/App.tsx"), "utf8"), /uncommitted/);
  await recreated.cleanup();
  assert.deepEqual(repo.snapshot(), before, "nothing written to the user's clone");
});

test("RunWorkspaceRecreator.recreate fails with the §11.1 message when the working-tree snapshot is gone", async (t) => {
  const repo = withTempGitRepo(t, { files: reactViteFiles() });
  const snapshots = makeTempDir("snapshots");
  t.after(() => {
    snapshots.cleanup();
  });
  const recreator = new RunWorkspaceRecreator({ snapshotsRoot: snapshots.path });
  for (const workingTreeSnapshot of [false, true]) {
    const root = rootDir();
    await assert.rejects(
      recreator.recreate({
        visualization: makeVisualizationModel({
          id: 45,
          status: "completed",
          sourceType: "working_tree",
          baseSha: repo.sha(),
          workingTreeSnapshot
        }),
        repository: makeRepositoryModel({ localPath: repo.path }),
        rootDir: root,
        console: silentConsole().console,
        signal: SIGNAL
      }),
      (error: unknown) =>
        error instanceof PipelineStepError &&
        error.stage === "preparing" &&
        error.userMessage === "The uncommitted changes of this run are no longer available. Start a new visualization."
    );
    assert.equal(await exists(root), false, `nothing created (workingTreeSnapshot ${String(workingTreeSnapshot)})`);
  }
});

test("RunWorkspaceRecreator.recreate fails without a base commit", async (t) => {
  const repo = withTempGitRepo(t, { files: reactViteFiles() });
  await assert.rejects(
    new RunWorkspaceRecreator().recreate({
      visualization: makeVisualizationModel({ status: "failed", baseSha: null, headSha: null }),
      repository: makeRepositoryModel({ localPath: repo.path }),
      rootDir: rootDir(),
      console: silentConsole().console,
      signal: SIGNAL
    }),
    (error: unknown) =>
      error instanceof PipelineStepError && error.userMessage === "This run has no base commit to recreate."
  );
});

test("RunWorkspaceRecreator.recreate fails with 'Commit <short> is no longer in the clone.' for a non-PR run", async (t) => {
  const { repo, base } = twoCommitRepo(t);
  const gone = "1234567890abcdef1234567890abcdef12345678";
  const root = rootDir();
  await assert.rejects(
    new RunWorkspaceRecreator().recreate({
      visualization: makeVisualizationModel({ status: "completed", baseSha: base, headSha: gone }),
      repository: makeRepositoryModel({ localPath: repo.path }),
      rootDir: root,
      console: silentConsole().console,
      signal: SIGNAL
    }),
    (error: unknown) =>
      error instanceof PipelineStepError && error.userMessage === "Commit 1234567 is no longer in the clone."
  );
  assert.equal(await exists(root), false, "partial results removed");
});

test("RunWorkspaceRecreator.recreate re-fetches a pull request whose head left the clone and deletes the temporary refs", async (t) => {
  const { repo, base, head } = twoCommitRepo(t);
  const bare = repo.createBareOrigin();
  t.after(() => {
    bare.cleanup();
  });
  bare.setPullRef(7, head);
  // The head commit leaves the clone (branch deleted, reflog expired, objects pruned).
  repo.git("branch", "-D", "feature/restyle");
  repo.git("update-ref", "-d", "refs/remotes/origin/feature/restyle");
  repo.git("reflog", "expire", "--expire=now", "--all");
  repo.git("gc", "--prune=now", "--quiet");
  assert.throws(() => repo.git("cat-file", "-e", `${head}^{commit}`), "precondition: head commit gone");
  const before = repo.snapshot();
  const pulls: number[] = [];
  const recreator = new RunWorkspaceRecreator({
    git: githubOriginGit(),
    readGithubToken: () => Promise.resolve<SecretRead>({ state: "present", value: "ghp_test" }),
    githubClientFactory: () => ({
      getPullRequest: (_owner: string, _repo: string, n: number) => {
        pulls.push(n);
        return Promise.resolve(pullRequest({ baseRef: "main", baseSha: base, headSha: head }));
      }
    })
  });
  const out = silentConsole();
  const recreated = await recreator.recreate({
    visualization: makeVisualizationModel({
      id: 46,
      status: "completed",
      sourceType: "github_pr",
      prNumber: 7,
      baseSha: base,
      headSha: head
    }),
    repository: makeRepositoryModel({ localPath: repo.path, githubOwner: "acme", githubRepo: "shop" }),
    rootDir: rootDir(),
    console: out.console,
    signal: SIGNAL
  });
  t.after(() => recreated.cleanup());
  assert.deepEqual(pulls, [7]);
  assert.match(await fs.readFile(path.join(recreated.workspace.headDir, "src/App.tsx"), "utf8"), /new/);
  assert.equal(repo.git("for-each-ref", "refs/prvision/"), "", "temporary PR refs deleted once the worktrees exist");
  assert.ok(out.lines.some((line) => line.startsWith('Fetched pull request #7 using remote "origin"')));
  await recreated.cleanup();
  assert.deepEqual(repo.snapshot(), before, "no branch, ref, index or worktree of the user changed");
});

test("RunWorkspaceRecreator.recreate reports a pull request that cannot be fetched again", async (t) => {
  const { repo, base } = twoCommitRepo(t);
  const bare = repo.createBareOrigin();
  t.after(() => {
    bare.cleanup();
  });
  const gone = "fedcba9876543210fedcba9876543210fedcba98";
  const root = rootDir();
  await assert.rejects(
    new RunWorkspaceRecreator({
      git: githubOriginGit(),
      readGithubToken: () => Promise.resolve<SecretRead>({ state: "absent" }),
      githubClientFactory: () => {
        throw new Error("no GitHub call without a token");
      }
    }).recreate({
      visualization: makeVisualizationModel({
        status: "completed",
        sourceType: "github_pr",
        prNumber: 8,
        baseSha: base,
        headSha: gone
      }),
      repository: makeRepositoryModel({ localPath: repo.path, githubOwner: "acme", githubRepo: "shop" }),
      rootDir: root,
      console: silentConsole().console,
      signal: SIGNAL
    }),
    (error: unknown) =>
      error instanceof PipelineStepError && error.userMessage.startsWith("Could not fetch pull request #8 from GitHub")
  );
  assert.equal(await exists(root), false);
  assert.equal(repo.git("for-each-ref", "refs/prvision/"), "", "no temporary ref left behind");
});
