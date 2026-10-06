import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { GIT_FETCH_TIMEOUT_MS } from "../../../backend/src/config-consts";
import {
  compareDependencies,
  prBaseRef,
  prRef,
  WorkspacePrepareService,
  type WorkspacePrepareDependencies,
  type WorkspacePrepareInput
} from "../../../backend/src/services/visualizations/pipeline/workspace-prepare-service";
import { PipelineStepError, type PreparedWorkspace } from "../../../backend/src/types/visualization-pipeline";
import {
  ArtifactStore,
  GitHubClient,
  GitHubClientError,
  type GitHubPullRequestDetail
} from "../../../backend/src/utilities";
import { ConsoleRecorder } from "../helpers/console-recorder";
import { makeTempDir, useTempDataDir } from "../helpers/temp-dir";
import { FakeGit, gitError, type CheckoutFiles } from "./helpers/fakes";

const TOKEN = "ghp_workspaceTestToken0123456789abcdef";
const BASE_TIP = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);
const PR_BASE = "4".repeat(40);
const PACKAGE_JSON = JSON.stringify({ dependencies: { react: "19.0.0" }, devDependencies: { vite: "7.0.0" } });

interface PrepareHarness {
  git: FakeGit;
  artifacts: ArtifactStore;
  dataDir: string;
  clone: string;
  templates: string;
  console: ConsoleRecorder;
  controller: AbortController;
  deps: Partial<WorkspacePrepareDependencies>;
  pr: GitHubPullRequestDetail;
  service(): WorkspacePrepareService;
  input(overrides?: Partial<WorkspacePrepareInput>): WorkspacePrepareInput;
}

function tempDir(t: TestContext, label: string): string {
  const dir = makeTempDir(label);
  t.after(dir.cleanup);
  return dir.path;
}

function setup(t: TestContext, checkout: CheckoutFiles = { "package.json": PACKAGE_JSON }): PrepareHarness {
  const dataDir = useTempDataDir(t);
  const artifacts = new ArtifactStore(dataDir);
  const clone = tempDir(t, "clone");
  fs.mkdirSync(path.join(clone, "node_modules", "react"), { recursive: true });
  fs.writeFileSync(path.join(clone, "node_modules", "react", "package.json"), "{}");
  const templates = tempDir(t, "templates");
  fs.writeFileSync(path.join(templates, "index.html"), "<div id=root></div>");
  fs.mkdirSync(path.join(templates, "lib"));
  fs.writeFileSync(path.join(templates, "lib", "entry.tsx"), "export {};");

  const git = new FakeGit();
  git.refs.set("refs/heads/main", BASE_TIP);
  git.refs.set("refs/heads/feature/x", HEAD);
  git.refs.set("HEAD", BASE_TIP);
  git.mergeBases.set(`${BASE_TIP}..${HEAD}`, MERGE_BASE);
  for (const sha of [BASE_TIP, HEAD, MERGE_BASE, PR_BASE]) {
    git.checkouts.set(sha, checkout);
  }
  const consoleRecorder = new ConsoleRecorder();
  const controller = new AbortController();
  const h: PrepareHarness = {
    git,
    artifacts,
    dataDir,
    clone,
    templates,
    console: consoleRecorder,
    controller,
    pr: {
      number: 12,
      title: "Restyle",
      authorLogin: "octo",
      headRef: "feature/x",
      baseRef: "main",
      updatedAt: "2026-01-01T00:00:00Z",
      draft: false,
      htmlUrl: "https://github.com/acme/web/pull/12",
      state: "open",
      merged: false,
      headSha: HEAD,
      baseSha: PR_BASE,
      headRepoFullName: "acme/web",
      isFork: false
    },
    deps: {},
    service: () => new WorkspacePrepareService(h.deps),
    input: (overrides = {}) => ({
      visualizationId: 5,
      sourceType: "local_branch",
      prNumber: null,
      baseRef: "main",
      headRef: "feature/x",
      repository: { id: 1, localPath: clone, githubOwner: null, githubRepo: null, viteConfigPath: "vite.config.ts" },
      console: consoleRecorder,
      signal: controller.signal,
      ...overrides
    })
  };
  h.deps = {
    git,
    artifacts,
    harnessTemplatesDir: templates,
    readGithubToken: () => Promise.resolve({ state: "present", value: TOKEN }),
    githubClientFactory: () => ({ getPullRequest: () => Promise.resolve(h.pr) })
  };
  return h;
}

function prInput(h: PrepareHarness): WorkspacePrepareInput {
  git(h).refs.set(prRef(12), HEAD);
  git(h).refs.set(prBaseRef(12), BASE_TIP);
  git(h).commits.add(PR_BASE);
  git(h).mergeBases.set(`${PR_BASE}..${HEAD}`, MERGE_BASE);
  git(h).remotes.set("origin", "git@github.com:acme/web.git");
  return h.input({
    sourceType: "github_pr",
    prNumber: 12,
    headRef: "feature/x",
    repository: { id: 1, localPath: h.clone, githubOwner: "acme", githubRepo: "web", viteConfigPath: "vite.config.ts" }
  });
}

function git(h: PrepareHarness): FakeGit {
  return h.git;
}

async function rejectsWithStepError(promise: Promise<unknown>, message: RegExp): Promise<PipelineStepError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof PipelineStepError, `expected PipelineStepError, got ${String(caught)}`);
  assert.equal(caught.stage, "preparing");
  assert.match(caught.userMessage, message);
  return caught;
}

// ---------------------------------------------------------------------------------------------------------------
// github_pr
// ---------------------------------------------------------------------------------------------------------------

test("WorkspacePrepareService.prepare github_pr fetches the pr-<n> and pr-<n>-base refspecs and uses merge-base(baseSha, head)", async (t) => {
  const h = setup(t);
  const workspace = await h.service().prepare(prInput(h));
  const fetches = h.git.callsOf("fetch");
  assert.equal(fetches.length, 1);
  assert.deepEqual(fetches[0]?.[1], {
    remote: "origin",
    refspecs: ["+refs/pull/12/head:refs/prvision/pr-12", "+refs/heads/main:refs/prvision/pr-12-base"],
    auth: undefined
  });
  assert.deepEqual(h.git.callsOf("mergeBase")[0]?.slice(1), [PR_BASE, HEAD]);
  assert.deepEqual(
    h.git.callsOf("worktreeAdd").map((args) => args.slice(1)),
    [
      [h.artifacts.worktreeDir(5, "base"), MERGE_BASE],
      [h.artifacts.worktreeDir(5, "head"), HEAD]
    ]
  );
  assert.deepEqual(workspace, {
    visualizationId: 5,
    repositoryPath: h.clone,
    baseDir: h.artifacts.worktreeDir(5, "base"),
    headDir: h.artifacts.worktreeDir(5, "head"),
    baseSha: MERGE_BASE,
    headSha: HEAD,
    sourceType: "github_pr",
    dependencyDrift: false
  } satisfies PreparedWorkspace);
  assert.ok(h.console.has("info", `PR #12: Restyle (main ← feature/x), head ${HEAD.slice(0, 7)}.`, "preparing"));
  assert.ok(h.console.has("info", 'Fetched pull request #12 using remote "origin" (your SSH key or public access).'));
});

test("WorkspacePrepareService.prepare github_pr tries the remote, then the headers from gitAuthHeaders in their order, and stops at the first success", async (t) => {
  const h = setup(t);
  let attempt = 0;
  h.git.on("fetch", () => {
    attempt += 1;
    return attempt < 3
      ? Promise.reject(gitError("auth_failed", "fatal: Authentication failed for 'https://github.com/acme/web.git/'"))
      : Promise.resolve();
  });
  await h.service().prepare(prInput(h));
  const headers = GitHubClient.gitAuthHeaders(TOKEN);
  const requests = h.git.callsOf("fetch").map((args) => args[1] as { remote: string; auth?: unknown });
  assert.deepEqual(
    requests.map((r) => [r.remote, r.auth]),
    [
      ["origin", undefined],
      ["https://github.com/acme/web.git", headers[0]],
      ["https://github.com/acme/web.git", headers[1]]
    ]
  );
  assert.ok(
    h.console.has(
      "warn",
      'Fetching with remote "origin" (your SSH key or public access) failed: fatal: Authentication failed'
    )
  );
  assert.ok(h.console.has("warn", "Fetching with the GitHub token failed"));
  assert.ok(h.console.has("info", "Fetched pull request #12 using the GitHub token (alternative auth 2)."));

  const noRemote = setup(t);
  const input = prInput(noRemote);
  noRemote.git.remotes.clear();
  await noRemote.service().prepare(input);
  assert.equal(
    (noRemote.git.callsOf("fetch")[0]?.[1] as { remote: string }).remote,
    "https://github.com/acme/web.git",
    "without a matching remote the first attempt is anonymous https"
  );
});

test("WorkspacePrepareService.prepare github_pr fails with an actionable message when every attempt fails; neither the message nor the labels contain the token", async (t) => {
  const h = setup(t);
  h.git.on("fetch", () =>
    Promise.reject(
      gitError(
        "auth_failed",
        "remote: Repository not found.\nfatal: repository 'https://github.com/acme/web.git/' not found"
      )
    )
  );
  const error = await rejectsWithStepError(
    h.service().prepare(prInput(h)),
    /^Could not fetch pull request #12 from GitHub \(remote: Repository not found\. \/ fatal: repository .+\)\. Check your SSH access, or give the GitHub token Contents: Read access to this repository\.$/
  );
  assert.equal(error.code, "auth_failed");
  assert.equal(h.git.callsOf("fetch").length, 3);
  assert.equal(error.userMessage.includes(TOKEN), false);
  h.console.assertNoSecrets([TOKEN, "AUTHORIZATION", Buffer.from(`x-access-token:${TOKEN}`).toString("base64")]);
  assert.equal(h.git.callsOf("worktreeAdd").length, 0);
});

test("WorkspacePrepareService.prepare github_pr falls back to the pr-<n>-base tip when baseSha is missing locally", async (t) => {
  const h = setup(t);
  const input = prInput(h);
  h.git.commits.clear();
  const workspace = await h.service().prepare(input);
  assert.deepEqual(h.git.callsOf("mergeBase")[0]?.slice(1), [BASE_TIP, HEAD]);
  assert.equal(workspace.baseSha, MERGE_BASE);
  assert.ok(h.console.has("warn", "The PR base commit is not available; using the current tip of main."));

  const moved = setup(t);
  const movedInput = prInput(moved);
  moved.pr = { ...moved.pr, headSha: "9".repeat(40) };
  await moved.service().prepare(movedInput);
  assert.ok(
    moved.console.has("warn", `The PR was updated after it was loaded; using the fetched head ${HEAD.slice(0, 7)}.`)
  );
});

test("WorkspacePrepareService.prepare github_pr warns for forks and for closed PRs", async (t) => {
  const h = setup(t);
  const input = prInput(h);
  h.pr = { ...h.pr, isFork: true, headRepoFullName: null, state: "closed", merged: true };
  await h.service().prepare(input);
  assert.ok(h.console.has("info", "This pull request is closed and merged; visualizing its last head commit."));
  assert.ok(
    h.console.has(
      "warn",
      "This pull request comes from a fork (deleted fork). Rendering runs its code, including vite.config, on this machine."
    )
  );

  const missingPr = setup(t);
  missingPr.deps.githubClientFactory = () => ({
    getPullRequest: () => Promise.reject(new GitHubClientError("Not found on GitHub", "not_found", 404, null, null))
  });
  await rejectsWithStepError(
    missingPr.service().prepare(prInput(missingPr)),
    /^Pull request #12 was not found in acme\/web/
  );
  const noToken = setup(t);
  noToken.deps.readGithubToken = () => Promise.resolve({ state: "unreadable" });
  await rejectsWithStepError(noToken.service().prepare(prInput(noToken)), /GitHub token is missing or unreadable/);
});

test("WorkspacePrepareService.prepare github_pr rejects a base branch name outside SAFE_REF", async (t) => {
  const h = setup(t);
  const input = prInput(h);
  h.pr = { ...h.pr, baseRef: "release#1" };
  await rejectsWithStepError(
    h.service().prepare(input),
    /^GitHub returned a base branch name PRVision cannot use: release#1\.$/
  );
  assert.equal(h.git.callsOf("fetch").length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// local_branch / working_tree
// ---------------------------------------------------------------------------------------------------------------

test("WorkspacePrepareService.prepare local_branch uses the merge-base of the two branch tips and warns when head has no unique commits", async (t) => {
  const h = setup(t);
  const workspace = await h.service().prepare(h.input());
  assert.deepEqual(
    h.git.callsOf("revParse").map((args) => args[1]),
    ["refs/heads/main", "refs/heads/feature/x"]
  );
  assert.equal(workspace.baseSha, MERGE_BASE);
  assert.equal(workspace.headSha, HEAD);
  assert.ok(
    h.console.has(
      "info",
      `Comparing feature/x (${HEAD.slice(0, 7)}) against its merge-base with main (${MERGE_BASE.slice(0, 7)}).`
    )
  );

  const merged = setup(t);
  merged.git.mergeBases.set(`${BASE_TIP}..${HEAD}`, HEAD);
  await merged.service().prepare(merged.input());
  assert.ok(merged.console.has("warn", "feature/x has no commits that are not already in main; nothing will differ."));

  const gone = setup(t);
  gone.git.refs.delete("refs/heads/feature/x");
  await rejectsWithStepError(gone.service().prepare(gone.input()), /^Branch "feature\/x" no longer exists\.$/);
  const unrelated = setup(t);
  unrelated.git.mergeBases.clear();
  await rejectsWithStepError(unrelated.service().prepare(unrelated.input()), /share no history/);
});

test("WorkspacePrepareService.prepare commit_range checks out base at baseSha and head at headSha with no merge-base step", async (t) => {
  const h = setup(t);
  h.git.commits.add(BASE_TIP);
  h.git.commits.add(HEAD);
  const workspace = await h
    .service()
    .prepare(h.input({ sourceType: "commit_range", baseRef: "feature/x", baseSha: BASE_TIP, headSha: HEAD }));
  assert.equal(workspace.baseSha, BASE_TIP);
  assert.equal(workspace.headSha, HEAD);
  assert.equal(workspace.sourceType, "commit_range");
  assert.deepEqual(
    h.git.callsOf("worktreeAdd").map((args) => [path.basename(String(args[1])), args[2]]),
    [
      ["base", BASE_TIP],
      ["head", HEAD]
    ]
  );
  assert.equal(h.git.callsOf("mergeBase").length, 0);
  assert.equal(h.git.callsOf("revParse").length, 0, "the stored commits are used as they are");
  assert.ok(h.console.has("info", `Comparing commits ${BASE_TIP.slice(0, 7)} → ${HEAD.slice(0, 7)} on feature/x.`));
});

test("WorkspacePrepareService.prepare commit_range fails clearly when a stored commit is gone or the shas are missing", async (t) => {
  const gone = setup(t);
  gone.git.commits.add(BASE_TIP);
  const error = await rejectsWithStepError(
    gone.service().prepare(gone.input({ sourceType: "commit_range", baseSha: BASE_TIP, headSha: HEAD })),
    /^Commit 2222222 no longer exists in the repository \(was feature\/x rewritten\?\)\.$/
  );
  assert.equal(error.code, "unknown_revision");
  assert.equal(gone.git.callsOf("worktreeAdd").length, 0);

  const legacy = setup(t);
  await rejectsWithStepError(
    legacy.service().prepare(legacy.input({ sourceType: "commit_range", baseSha: null, headSha: HEAD })),
    /has no stored commits/
  );
});

test("WorkspacePrepareService.prepare working_tree fails when there are no changes, on output_too_large, and over the untracked limits", async (t) => {
  const wt = (h: PrepareHarness): WorkspacePrepareInput =>
    h.input({ sourceType: "working_tree", baseRef: "main", headRef: "working-tree" });

  const clean = setup(t);
  await rejectsWithStepError(
    clean.service().prepare(wt(clean)),
    /^The working tree has no uncommitted changes anymore\.$/
  );

  const huge = setup(t);
  huge.git.on("diffBinaryHead", () => Promise.reject(gitError("output_too_large")));
  await rejectsWithStepError(huge.service().prepare(wt(huge)), /^The uncommitted diff is larger than 64 MB\.$/);

  const many = setup(t);
  many.git.untracked = Array.from({ length: 2_001 }, (_, i) => `gen/file-${i}.txt`);
  await rejectsWithStepError(many.service().prepare(wt(many)), /more than 2,000 untracked files/);

  const heavy = setup(t);
  heavy.git.untracked = ["big.bin"];
  fs.writeFileSync(path.join(heavy.clone, "big.bin"), "");
  fs.truncateSync(path.join(heavy.clone, "big.bin"), 201 * 1024 * 1024); // sparse: no real disk use
  await rejectsWithStepError(heavy.service().prepare(wt(heavy)), /^Untracked files exceed 200 MB\.$/);

  const ok = setup(t);
  ok.git.patch = "diff --git a/src/A.tsx b/src/A.tsx\n--- a/src/A.tsx\n+++ b/src/A.tsx\n";
  ok.git.untracked = ["src/New.tsx", "node_modules/x/index.js", ".git/x", "../escape"];
  fs.mkdirSync(path.join(ok.clone, "src"));
  fs.writeFileSync(path.join(ok.clone, "src", "New.tsx"), "export {};", { mode: 0o640 });
  const workspace = await ok.service().prepare(wt(ok));
  assert.equal(workspace.headSha, null);
  assert.equal(workspace.baseSha, BASE_TIP);
  assert.deepEqual(
    ok.git.callsOf("worktreeAdd").map((args) => args[2]),
    [BASE_TIP, BASE_TIP]
  );
  assert.deepEqual(ok.git.callsOf("applyPatch")[0], [workspace.headDir, ok.git.patch]);
  assert.equal(fs.readFileSync(path.join(workspace.headDir, "src", "New.tsx"), "utf8"), "export {};");
  assert.equal(fs.statSync(path.join(workspace.headDir, "src", "New.tsx")).mode & 0o777, 0o640);
  assert.ok(ok.console.has("info", "Applied uncommitted changes: 1 tracked file change(s), 1 untracked file(s)."));
});

// ---------------------------------------------------------------------------------------------------------------
// Files in the worktrees
// ---------------------------------------------------------------------------------------------------------------

test("WorkspacePrepareService.prepare creates node_modules symlinks pointing at the user's node_modules", async (t) => {
  const h = setup(t);
  const workspace = await h.service().prepare(h.input());
  for (const dir of [workspace.baseDir, workspace.headDir]) {
    const link = path.join(dir, "node_modules");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readlinkSync(link), path.join(h.clone, "node_modules"));
  }

  const committed = setup(t, { "package.json": PACKAGE_JSON, "node_modules/.keep": "" });
  await committed.service().prepare(committed.input());
  assert.ok(committed.console.has("warn", "The repository contains a node_modules entry; using it as-is on base."));

  const subfolder = setup(t, { "apps/web/package.json": PACKAGE_JSON });
  const nested = await subfolder.service().prepare(
    subfolder.input({
      repository: {
        id: 1,
        localPath: subfolder.clone,
        githubOwner: null,
        githubRepo: null,
        viteConfigPath: "apps/web/vite.config.ts"
      }
    })
  );
  assert.ok(fs.lstatSync(path.join(nested.headDir, "apps", "web", "node_modules")).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(nested.headDir, "apps", "web", ".prvision-harness", "index.html")));
});

test("WorkspacePrepareService.prepare copies harness templates into .prvision-harness on both sides; fails clearly when they are missing", async (t) => {
  const h = setup(t);
  const workspace = await h.service().prepare(h.input());
  for (const dir of [workspace.baseDir, workspace.headDir]) {
    assert.equal(fs.readFileSync(path.join(dir, ".prvision-harness", "index.html"), "utf8"), "<div id=root></div>");
    assert.equal(fs.readFileSync(path.join(dir, ".prvision-harness", "lib", "entry.tsx"), "utf8"), "export {};");
  }
  assert.ok(h.console.has("info", "Note: .env files are not copied into the render workspace."));

  const missing = setup(t);
  missing.deps.harnessTemplatesDir = path.join(missing.templates, "nope");
  await rejectsWithStepError(
    missing.service().prepare(missing.input()),
    /^Harness templates are missing at .+nope; the PRVision installation is incomplete\.$/
  );
});

test("WorkspacePrepareService.prepare replaces a committed .prvision-harness symlink without writing through it", async (t) => {
  const target = tempDir(t, "harness-target");
  fs.writeFileSync(path.join(target, "keep.txt"), "untouched");
  const h = setup(t, { "package.json": PACKAGE_JSON, ".prvision-harness": { symlink: target } });
  const workspace = await h.service().prepare(h.input());
  assert.deepEqual(fs.readdirSync(target), ["keep.txt"], "the symlink target stays untouched");
  const harnessDir = path.join(workspace.headDir, ".prvision-harness");
  assert.ok(fs.lstatSync(harnessDir).isDirectory() && !fs.lstatSync(harnessDir).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(harnessDir, "index.html")));
  assert.ok(h.console.has("warn", "The repository contains a .prvision-harness entry; it was replaced on head."));

  const committedDir = setup(t, { "package.json": PACKAGE_JSON, ".prvision-harness/old.txt": "stale" });
  const replaced = await committedDir.service().prepare(committedDir.input());
  assert.equal(fs.existsSync(path.join(replaced.baseDir, ".prvision-harness", "old.txt")), false);
});

test("WorkspacePrepareService.prepare skips untracked files whose parent folder is a symlink in the checkout, and never creates directories outside the worktree", async (t) => {
  const outside = tempDir(t, "outside");
  const h = setup(t, { "package.json": PACKAGE_JSON, linked: { symlink: outside }, "file.txt": "tracked" });
  fs.mkdirSync(path.join(h.clone, "linked", "deep"), { recursive: true });
  fs.writeFileSync(path.join(h.clone, "linked", "deep", "new.txt"), "x");
  fs.writeFileSync(path.join(h.clone, "file.txt"), "user version");
  h.git.untracked = ["linked/deep/new.txt", "file.txt"];
  await h.service().prepare(h.input({ sourceType: "working_tree", headRef: "working-tree" }));
  assert.deepEqual(fs.readdirSync(outside), [], "nothing written through the symlinked folder");
  assert.ok(h.console.has("warn", "Skipped linked/deep/new.txt (its folder is not a real folder in the checkout)."));
  assert.ok(h.console.has("warn", "Skipped file.txt (already exists in the checkout)."));
});

test("WorkspacePrepareService.prepare fails with a clear message when the Vite root folder is a symlink", async (t) => {
  const outside = tempDir(t, "vite-root");
  const h = setup(t, { "package.json": PACKAGE_JSON, apps: { symlink: outside } });
  await rejectsWithStepError(
    h.service().prepare(
      h.input({
        repository: {
          id: 1,
          localPath: h.clone,
          githubOwner: null,
          githubRepo: null,
          viteConfigPath: "apps/web/vite.config.ts"
        }
      })
    ),
    /^The Vite root apps\/web is a symbolic link in this checkout; PRVision only renders projects whose Vite root is a real folder\.$/
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("WorkspacePrepareService.prepare cleans a leftover root before preparing", async (t) => {
  const h = setup(t);
  const root = h.artifacts.visualizationWorktreeRoot(5);
  fs.mkdirSync(path.join(root, "head"), { recursive: true });
  fs.writeFileSync(path.join(root, "head", "stale.txt"), "old");
  await h.service().prepare(h.input());
  const methods = h.git.calls.map((call) => call.method);
  assert.ok(methods.indexOf("worktreeRemove") < methods.indexOf("worktreeAdd"));
  assert.equal(fs.existsSync(path.join(root, "head", "stale.txt")), false);
});

test("WorkspacePrepareService.prepare warns about LFS when .gitattributes contains filter=lfs", async (t) => {
  const h = setup(t, { "package.json": PACKAGE_JSON, ".gitattributes": "*.png filter=lfs diff=lfs merge=lfs -text\n" });
  await h.service().prepare(h.input());
  assert.ok(
    h.console.has(
      "warn",
      "This repository uses Git LFS; LFS files (e.g. images) are not downloaded and may render as broken."
    )
  );
  const plain = setup(t);
  await plain.service().prepare(plain.input());
  assert.equal(plain.console.has("warn", "Git LFS"), false);
});

test("compareDependencies detects added, removed and changed packages and ignores moves between groups", () => {
  assert.deepEqual(
    compareDependencies(
      { dependencies: { react: "19.0.0", lodash: "4" }, devDependencies: { vite: "7.0.0" } },
      { dependencies: { react: "19.1.0", zod: "4" }, devDependencies: {}, peerDependencies: { vite: "7.0.0" } }
    ),
    { any: true, added: ["zod"], removed: ["lodash"], changed: ["react"] }
  );
  assert.deepEqual(compareDependencies({ dependencies: { a: "1" } }, { devDependencies: { a: "1" } }), {
    any: false,
    added: [],
    removed: [],
    changed: []
  });
  assert.deepEqual(compareDependencies(null, null), { any: false, added: [], removed: [], changed: [] });
  assert.deepEqual(compareDependencies({}, "not json"), {
    any: true,
    added: [],
    removed: [],
    changed: ["package.json"]
  });
});

// ---------------------------------------------------------------------------------------------------------------
// app roots (15 §5.4.6)
// ---------------------------------------------------------------------------------------------------------------

const APP_ROOT = "src/tenant-frontend";

/** An Angular-style monorepo clone: the app's own node_modules plus a root node_modules (the setup default). */
function angularSetup(t: TestContext, checkout: CheckoutFiles = { "package.json": PACKAGE_JSON }): PrepareHarness {
  const h = setup(t, { [`${APP_ROOT}/package.json`]: PACKAGE_JSON, ...checkout });
  fs.mkdirSync(path.join(h.clone, APP_ROOT, "node_modules", "@angular", "core"), { recursive: true });
  return h;
}

function angularInput(h: PrepareHarness, appRoot = APP_ROOT): WorkspacePrepareInput {
  return h.input({
    repository: {
      id: 1,
      localPath: h.clone,
      githubOwner: null,
      githubRepo: null,
      viteConfigPath: null,
      framework: "angular",
      appRoot
    }
  });
}

/** Every node_modules symlink below `dir` (repo-relative folder → link target), skipping into no symlink. */
function nodeModulesLinks(dir: string): Record<string, string> {
  const links: Record<string, string> = {};
  const visit = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (entry.name === "node_modules") {
          links[rel === "" ? "." : rel] = fs.readlinkSync(path.join(dir, childRel));
        }
      } else if (entry.isDirectory()) {
        visit(childRel);
      }
    }
  };
  visit("");
  return links;
}

test("WorkspacePrepareService.prepare links node_modules for . and the app root, and skips the React template copy for Angular", async (t) => {
  const h = angularSetup(t);
  const workspace = await h.service().prepare(angularInput(h));
  for (const dir of [workspace.baseDir, workspace.headDir]) {
    assert.deepEqual(nodeModulesLinks(dir), {
      ".": path.join(h.clone, "node_modules"),
      [APP_ROOT]: path.join(h.clone, APP_ROOT, "node_modules")
    });
    assert.equal(fs.existsSync(path.join(dir, ".prvision-harness")), false, "no React template at the root");
    assert.equal(fs.existsSync(path.join(dir, APP_ROOT, ".prvision-harness")), false, "Angular writes its own later");
  }
});

test("WorkspacePrepareService.prepare skips a link folder whose node_modules is missing in the clone", async (t) => {
  const h = angularSetup(t);
  fs.rmSync(path.join(h.clone, "node_modules"), { recursive: true, force: true }); // hoisting-free app
  const workspace = await h.service().prepare(angularInput(h));
  assert.deepEqual(nodeModulesLinks(workspace.headDir), {
    [APP_ROOT]: path.join(h.clone, APP_ROOT, "node_modules")
  });

  const missingApp = angularSetup(t);
  fs.rmSync(path.join(missingApp.clone, APP_ROOT, "node_modules"), { recursive: true, force: true }); // hoisted
  const hoisted = await missingApp.service().prepare(angularInput(missingApp));
  assert.deepEqual(nodeModulesLinks(hoisted.baseDir), { ".": path.join(missingApp.clone, "node_modules") });
});

test("WorkspacePrepareService.prepare refuses a symlinked app root", async (t) => {
  const outside = tempDir(t, "app-root");
  const h = setup(t, { "package.json": PACKAGE_JSON, src: { symlink: outside } });
  await rejectsWithStepError(
    h.service().prepare(angularInput(h)),
    /^The app root src\/tenant-frontend is a symbolic link in this checkout; PRVision only renders apps whose folder is a real directory\.$/
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("WorkspacePrepareService.prepare warns about a committed node_modules entry in the app root and uses it as-is", async (t) => {
  const h = angularSetup(t, { "package.json": PACKAGE_JSON, [`${APP_ROOT}/node_modules/.keep`]: "" });
  const workspace = await h.service().prepare(angularInput(h));
  assert.ok(
    h.console.has("warn", `The repository contains a node_modules entry at ${APP_ROOT}; using it as-is on base.`)
  );
  assert.equal(fs.lstatSync(path.join(workspace.headDir, APP_ROOT, "node_modules")).isSymbolicLink(), false);
});

test("WorkspacePrepareService.prepare keeps the React link set: root, and a sub-folder Vite root linked to the root node_modules", async (t) => {
  const root = setup(t);
  const rootWorkspace = await root.service().prepare(root.input());
  assert.deepEqual(nodeModulesLinks(rootWorkspace.headDir), { ".": path.join(root.clone, "node_modules") });
  assert.ok(fs.existsSync(path.join(rootWorkspace.headDir, ".prvision-harness", "index.html")));

  const nested = setup(t, { "apps/web/package.json": PACKAGE_JSON });
  const nestedWorkspace = await nested.service().prepare(
    nested.input({
      repository: {
        id: 1,
        localPath: nested.clone,
        githubOwner: null,
        githubRepo: null,
        viteConfigPath: "apps/web/vite.config.ts"
      }
    })
  );
  assert.deepEqual(nodeModulesLinks(nestedWorkspace.baseDir), {
    ".": path.join(nested.clone, "node_modules"),
    "apps/web": path.join(nested.clone, "node_modules")
  });
});

test("WorkspacePrepareService.cleanup unlinks the app root node_modules link before removing the worktrees", async (t) => {
  const h = angularSetup(t);
  const workspace = await h.service().prepare(angularInput(h));
  const linkedAtRemoval: boolean[] = [];
  h.git.on("worktreeRemove", (_repo, dir) => {
    linkedAtRemoval.push(fs.existsSync(path.join(dir, APP_ROOT, "node_modules")));
    fs.rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  });
  await h.service().cleanup({ visualizationId: 5, repositoryPath: h.clone, prNumber: null, appRoot: APP_ROOT });
  assert.deepEqual(linkedAtRemoval, [false, false]);
  assert.equal(fs.existsSync(workspace.headDir), false);
  assert.ok(fs.existsSync(path.join(h.clone, APP_ROOT, "node_modules", "@angular", "core")), "clone intact");
});

// ---------------------------------------------------------------------------------------------------------------
// cleanup / abort
// ---------------------------------------------------------------------------------------------------------------

test("WorkspacePrepareService.cleanup unlinks node_modules symlinks first, removes worktrees, deletes both refs, prunes and removes the root", async (t) => {
  const h = setup(t);
  const workspace = await h.service().prepare(prInput(h));
  h.git.calls.length = 0;
  const unlinkedFirst: boolean[] = [];
  h.git.on("worktreeRemove", (_repo, dir) => {
    unlinkedFirst.push(!fs.existsSync(path.join(dir, "node_modules")));
    fs.rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  });
  await h.service().cleanup({ visualizationId: 5, repositoryPath: h.clone, prNumber: 12 });
  assert.deepEqual(unlinkedFirst, [true, true]);
  assert.deepEqual(
    h.git.calls.map((call) => [call.method, call.args[1]]),
    [
      ["worktreeRemove", workspace.headDir],
      ["worktreeRemove", workspace.baseDir],
      ["worktreePrune", undefined],
      ["deleteRef", "refs/prvision/pr-12"],
      ["deleteRef", "refs/prvision/pr-12-base"]
    ]
  );
  assert.equal(fs.existsSync(h.artifacts.visualizationWorktreeRoot(5)), false);
  assert.ok(fs.existsSync(path.join(h.clone, "node_modules", "react", "package.json")), "user's node_modules intact");

  const noRepo = setup(t);
  await noRepo.service().cleanup({ visualizationId: 6, repositoryPath: null, prNumber: 3 });
  assert.deepEqual(noRepo.git.calls, [], "no git calls without a repository");
});

test("WorkspacePrepareService.prepare passes { signal, timeoutMs } to fetch and stops at the next call boundary after an abort", async (t) => {
  const h = setup(t);
  await h.service().prepare(prInput(h));
  const options = h.git.callsOf("fetch")[0]?.[2] as { signal: AbortSignal; timeoutMs: number };
  assert.equal(options.signal, h.controller.signal);
  assert.equal(options.timeoutMs, GIT_FETCH_TIMEOUT_MS);

  const aborted = setup(t);
  aborted.git.on("revParse", (_cwd, rev) => {
    aborted.controller.abort("cancelled");
    return Promise.resolve(rev === "refs/heads/main" ? BASE_TIP : HEAD);
  });
  await assert.rejects(aborted.service().prepare(aborted.input()), (reason: unknown) => reason === "cancelled");
  assert.deepEqual(
    aborted.git.calls.map((call) => call.method),
    ["topLevel", "worktreePrune", "revParse"],
    "no git call after the abort"
  );

  const abortedFetch = setup(t);
  const input = prInput(abortedFetch);
  abortedFetch.git.on("fetch", () => Promise.reject(gitError("aborted")));
  await assert.rejects(
    abortedFetch.service().prepare(input),
    (error: unknown) => error instanceof Error && error.message.includes("aborted")
  );
  assert.equal(abortedFetch.git.callsOf("fetch").length, 1, "an aborted fetch is not retried");
});

test("WorkspacePrepareService.cleanup never throws when git fails", async (t) => {
  const h = setup(t);
  await h.service().prepare(h.input());
  for (const method of ["worktreeRemove", "worktreePrune", "deleteRef"] as const) {
    h.git.on(method, () => Promise.reject(gitError("command_failed", "boom")));
  }
  h.deps.artifacts = {
    worktreeDir: (id, side) => h.artifacts.worktreeDir(id, side),
    worktreesRoot: () => h.artifacts.worktreesRoot(),
    visualizationWorktreeRoot: (id) => h.artifacts.visualizationWorktreeRoot(id),
    ensureDir: (dir) => h.artifacts.ensureDir(dir),
    removeVisualizationWorktreeRoot: () => Promise.reject(new Error("EBUSY"))
  };
  await h.service().cleanup({ visualizationId: 5, repositoryPath: h.clone, prNumber: 12 });
  assert.equal(h.git.callsOf("deleteRef").length, 2, "every step still ran");
});
