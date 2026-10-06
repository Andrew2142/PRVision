import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CHILD_PROCESS_BASE_ENV, DATA_DIR, WORKTREES_DIR_NAME } from "../../../backend/src/config-consts";
import { ProcessError, type ProcessResult, type runProcess } from "../../../backend/src/utilities/helpers/process";
import {
  GIT_ENV,
  GitClient,
  GitCommandError,
  parseGitVersion,
  parseLogCommits,
  parseNameStatusZ,
  parseStatusPorcelainZ,
  parseWorktreeListZ,
  toGitCommandError
} from "../../../backend/src/utilities/services/git-client";
import { createTempGitRepo, type TempGitRepo } from "../helpers/git-fixtures";

const git = new GitClient();

type RunnerCall = { command: string; args: readonly string[]; options: Parameters<typeof runProcess>[2] };

function fakeRunner(result: Partial<ProcessResult> = {}): { runner: typeof runProcess; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: typeof runProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, durationMs: 1, ...result });
  };
  return { runner, calls };
}

async function withRepo(files: Record<string, string>, fn: (repo: TempGitRepo) => Promise<void>): Promise<void> {
  const repo = await createTempGitRepo(files);
  try {
    await fn(repo);
  } finally {
    await repo.cleanup();
  }
}

function isGitError(code: GitCommandError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof GitCommandError && error.code === code;
}

async function worktreesRoot(): Promise<string> {
  const root = path.join(DATA_DIR, WORKTREES_DIR_NAME);
  await fs.mkdir(root, { recursive: true });
  return root;
}

test("GitClient.version parses and assertSupportedVersion passes on the CI git", async () => {
  const version = await git.version();
  assert.ok(version.major >= 2);
  await git.assertSupportedVersion();
});

test("GitClient.assertSupportedVersion rejects an old git and maps a missing binary to git_not_found", async () => {
  const { runner } = fakeRunner({ stdout: "git version 2.30.9\n" });
  await assert.rejects(new GitClient({ runner }).assertSupportedVersion(), isGitError("unsupported_version"));
  await assert.rejects(new GitClient({ binary: "prvision-no-such-git" }).version(), isGitError("git_not_found"));
});

test("GitClient.isRepository is true for a repo and false for a plain dir", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    assert.equal(await git.isRepository(repo.dir), true);
    const plain = path.join(path.dirname(repo.dir), `${path.basename(repo.dir)}-plain`);
    await fs.mkdir(plain);
    try {
      assert.equal(await git.isRepository(plain), false);
      assert.equal(await git.isRepository(path.join(plain, "missing")), false);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
    assert.equal(await git.topLevel(repo.dir), repo.dir);
  });
});

test("GitClient.revParse returns the full sha; an unknown ref is unknown_revision", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    const sha = (await repo.git(["rev-parse", "HEAD"])).trim();
    assert.equal(await git.revParse(repo.dir, "main"), sha);
    assert.match(sha, /^[0-9a-f]{40}$/);
    await assert.rejects(git.revParse(repo.dir, "no-such-branch"), isGitError("unknown_revision"));
    assert.equal(await git.hasCommit(repo.dir, sha), true);
    assert.equal(await git.hasCommit(repo.dir, "0".repeat(40)), false);
    assert.equal(await git.logSubject(repo.dir, sha), "initial");
  });
});

test("GitClient.mergeBase finds the fork point of two branches", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    const base = await repo.commit("second", { "a.txt": "a2" });
    await repo.git(["checkout", "-q", "-b", "feature"]);
    await repo.commit("feature work", { "b.txt": "b" });
    await repo.git(["checkout", "-q", "main"]);
    await repo.commit("main work", { "c.txt": "c" });
    assert.equal(await git.mergeBase(repo.dir, "main", "feature"), base);
  });
});

test("GitClient.isAncestor follows history and is false for a sibling branch or the reverse direction", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    const first = (await repo.git(["rev-parse", "HEAD"])).trim();
    const second = await repo.commit("second", { "a.txt": "a2" });
    await repo.git(["checkout", "-q", "-b", "side", first]);
    const side = await repo.commit("side work", { "s.txt": "s" });
    assert.equal(await git.isAncestor(repo.dir, first, second), true);
    assert.equal(await git.isAncestor(repo.dir, second, second), true);
    assert.equal(await git.isAncestor(repo.dir, second, first), false);
    assert.equal(await git.isAncestor(repo.dir, side, second), false);
    assert.equal(await git.isAncestor(repo.dir, first, "main"), true);
    await assert.rejects(git.isAncestor(repo.dir, "0".repeat(40), second), isGitError("unknown_revision"));
  });
});

test("GitClient.logCommits lists first-parent history newest first with author and ISO date; limit and skip page it", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    const root = (await repo.git(["rev-parse", "HEAD"])).trim();
    const second = await repo.commit("second: colons, unicode é and\ttab", { "a.txt": "a2" });
    await repo.git(["checkout", "-q", "-b", "topic"]);
    const topic = await repo.commit("topic work", { "t.txt": "t" });
    await repo.git(["checkout", "-q", "main"]);
    const third = await repo.commit("third", { "c.txt": "c" });
    await repo.git(["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
    const merge = (await repo.git(["rev-parse", "HEAD"])).trim();

    const all = await git.logCommits(repo.dir, "main", { limit: 50 });
    assert.deepEqual(
      all.map((commit) => commit.sha),
      [merge, third, second, root],
      "first parent only: the topic commit is not listed"
    );
    assert.ok(!all.some((commit) => commit.sha === topic));
    assert.equal(all[0]?.subject, "merge topic");
    assert.equal(all[2]?.subject, "second: colons, unicode é and\ttab");
    assert.ok(all.every((commit) => commit.authorName.length > 0));
    assert.ok(all.every((commit) => !Number.isNaN(Date.parse(commit.committedAt))));
    assert.deepEqual(
      all.map((commit) => [commit.parentSha, commit.isMerge]),
      [
        [third, true],
        [second, false],
        [root, false],
        [null, false]
      ],
      "parentSha is the first parent (the merge's is the main-line commit, not topic) and null for the root"
    );

    assert.deepEqual(
      (await git.logCommits(repo.dir, "main", { limit: 2 })).map((commit) => commit.sha),
      [merge, third]
    );
    assert.deepEqual(
      (await git.logCommits(repo.dir, third, { limit: 2, skip: 1 })).map((commit) => commit.sha),
      [second, root]
    );
    assert.deepEqual(await git.logCommits(repo.dir, root, { limit: 5, skip: 1 }), []);
  });
});

test("GitClient.logCommits searches message and author literally and case-insensitively on first-parent history", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    const sidebar = await repo.commit("feat: Grouped sidebar (v2.0)", { "a.txt": "a2" });
    await repo.commit("fix: footer spacing", { "b.txt": "b" });

    const byMessage = await git.logCommits(repo.dir, "main", { limit: 10, grep: "grouped SIDEBAR (v2.0)" });
    assert.deepEqual(
      byMessage.map((commit) => commit.sha),
      [sidebar],
      "regex characters are matched literally"
    );
    assert.deepEqual(await git.logCommits(repo.dir, "main", { limit: 10, grep: "nothing like this" }), []);

    const author = (await repo.git(["log", "-1", "--format=%an"])).trim();
    const byAuthor = await git.logCommits(repo.dir, "main", { limit: 10, author: author.toUpperCase() });
    assert.equal(byAuthor.length, 3);
  });
});

test("GitClient.logCommits passes search text as single fixed-string arguments and rejects multi-line or empty text", async () => {
  const { runner, calls } = fakeRunner();
  const client = new GitClient({ runner });
  await client.logCommits("/repo", "main", { limit: 5, grep: "a.b*; rm -rf /", author: "Ann" });
  const tail = (calls[0]?.args ?? []).slice((calls[0]?.args ?? []).indexOf("log"));
  assert.ok(tail.includes("--fixed-strings"));
  assert.ok(tail.includes("--regexp-ignore-case"));
  assert.ok(tail.includes("--grep=a.b*; rm -rf /"));
  assert.ok(tail.includes("--author=Ann"));
  assert.deepEqual(tail.slice(-3), ["--end-of-options", "main", "--"]);
  for (const bad of ["", "two\nlines", "x".repeat(201)]) {
    await assert.rejects(client.logCommits("/repo", "main", { limit: 5, grep: bad }), /invalid argument/);
  }
  assert.equal(calls.length, 1, "rejected input never spawns git");
});

test("GitClient.logCommits puts the revision after --end-of-options, ends with --, and rejects bad input without spawning", async () => {
  const { runner, calls } = fakeRunner();
  const client = new GitClient({ runner });
  await client.logCommits("/repo", "feature/x", { limit: 3, skip: 2 });
  const args = calls[0]?.args ?? [];
  const log = args.indexOf("log");
  assert.ok(log > 0);
  const tail = args.slice(log);
  assert.ok(tail.includes("--first-parent"));
  assert.ok(tail.includes("--no-show-signature"));
  assert.ok(tail.includes("--max-count=3"));
  assert.ok(tail.includes("--skip=2"));
  assert.deepEqual(tail.slice(-3), ["--end-of-options", "feature/x", "--"]);
  await client.isAncestor("/repo", "a".repeat(40), "main");
  assert.deepEqual(calls[1]?.args.slice(-5), [
    "merge-base",
    "--is-ancestor",
    "--end-of-options",
    "a".repeat(40),
    "main"
  ]);

  calls.length = 0;
  await assert.rejects(client.logCommits("/repo", "--all", { limit: 1 }), isGitError("invalid_argument"));
  await assert.rejects(client.logCommits("/repo", "a..b", { limit: 1 }), isGitError("invalid_argument"));
  await assert.rejects(client.logCommits("/repo", "main", { limit: 0 }), isGitError("invalid_argument"));
  await assert.rejects(client.logCommits("/repo", "main", { limit: 1, skip: -1 }), isGitError("invalid_argument"));
  await assert.rejects(client.isAncestor("/repo", "--x", "main"), isGitError("invalid_argument"));
  assert.equal(calls.length, 0);
});

test("GitClient.diffNameStatus reports A, M, D and R with previousPath and score", async () => {
  const longText = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  await withRepo({ "keep.txt": "keep", "drop.txt": "drop", "old-name.txt": longText }, async (repo) => {
    const base = (await repo.git(["rev-parse", "HEAD"])).trim();
    await repo.git(["mv", "old-name.txt", "new-name.txt"]);
    const head = await repo.commit("change", { "keep.txt": "changed", "drop.txt": null, "added.txt": "new" });
    const entries = await git.diffNameStatus(repo.dir, base, head);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("added.txt")?.status, "A");
    assert.equal(byPath.get("keep.txt")?.status, "M");
    assert.equal(byPath.get("drop.txt")?.status, "D");
    const renamed = byPath.get("new-name.txt");
    assert.equal(renamed?.status, "R");
    assert.equal(renamed.previousPath, "old-name.txt");
    assert.equal(renamed.score, 100);
  });
});

test("GitClient.diffNameStatus with to=null compares against the working tree", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    await fs.writeFile(path.join(repo.dir, "a.txt"), "changed");
    assert.deepEqual(await git.diffNameStatus(repo.dir, "HEAD", null), [{ status: "M", path: "a.txt" }]);
  });
});

test("GitClient.diffNameStatus passes --no-renames for renames:false and pathspecs after --", async () => {
  const { runner, calls } = fakeRunner();
  await new GitClient({ runner }).diffNameStatus("/repo", "base", "head", {
    renames: false,
    pathspecs: ["./src/a.ts"]
  });
  const args = calls[0]!.args;
  assert.ok(args.includes("--no-renames"));
  assert.ok(!args.includes("-M"));
  assert.deepEqual(args.slice(args.indexOf("--end-of-options")), [
    "--end-of-options",
    "base",
    "head",
    "--",
    "src/a.ts"
  ]);
  for (const flag of ["--no-ext-diff", "--no-textconv", "--no-color"]) {
    assert.ok(args.includes(flag));
  }
});

test("GitClient.diffNameStatusNoIndex lists differences of two directories and treats exit code 1 as success", async () => {
  await withRepo({ "x.txt": "x" }, async (repo) => {
    await fs.mkdir(path.join(repo.dir, "left"));
    await fs.mkdir(path.join(repo.dir, "right"));
    await fs.writeFile(path.join(repo.dir, "left", "same.txt"), "same");
    await fs.writeFile(path.join(repo.dir, "right", "same.txt"), "same");
    await fs.writeFile(path.join(repo.dir, "left", "changed.txt"), "one");
    await fs.writeFile(path.join(repo.dir, "right", "changed.txt"), "two");
    await fs.writeFile(path.join(repo.dir, "right", "added.txt"), "new");
    const entries = await git.diffNameStatusNoIndex(repo.dir, "left", "right");
    const statuses = entries.map((entry) => `${entry.status} ${entry.path}`).sort();
    // Paths are returned exactly as git prints them (08 strips the left/ and right/ prefixes).
    assert.deepEqual(statuses, ["A right/added.txt", "M left/changed.txt"]);
    assert.deepEqual(await git.diffNameStatusNoIndex(repo.dir, "left/same.txt", "right/same.txt"), []);
  });
});

test("GitClient.deleteRef removes refs/prvision/pr-1, is idempotent, and rejects refs/heads/main", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    await repo.git(["update-ref", "refs/prvision/pr-1", "HEAD"]);
    await git.deleteRef(repo.dir, "refs/prvision/pr-1");
    assert.equal((await repo.git(["for-each-ref", "refs/prvision/"])).trim(), "");
    await git.deleteRef(repo.dir, "refs/prvision/pr-1");
    await assert.rejects(git.deleteRef(repo.dir, "refs/heads/main"), isGitError("invalid_argument"));
    assert.equal(await git.revParse(repo.dir, "main"), (await repo.git(["rev-parse", "HEAD"])).trim());
  });
});

test("GitClient.fetch argv contains --no-write-fetch-head and -c credential.helper=", async () => {
  const { runner, calls } = fakeRunner();
  await new GitClient({ runner }).fetch("/repo", {
    remote: "origin",
    refspecs: ["+refs/pull/12/head:refs/prvision/pr-12"]
  });
  const args = calls[0]!.args;
  assert.ok(args.includes("--no-write-fetch-head"));
  const helperIndex = args.indexOf("credential.helper=");
  assert.ok(helperIndex > 0 && args[helperIndex - 1] === "-c");
  assert.ok(helperIndex < args.indexOf("fetch"));
  assert.deepEqual(args.slice(args.indexOf("--end-of-options")), [
    "--end-of-options",
    "origin",
    "+refs/pull/12/head:refs/prvision/pr-12"
  ]);
  assert.ok(calls[0]!.options.timeoutMs >= 180_000);
});

test("GitClient.fetch passes the auth header via GIT_CONFIG_* env, not argv", async () => {
  const { runner, calls } = fakeRunner();
  const header = "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==";
  await new GitClient({ runner }).fetch("/repo", {
    remote: "https://github.com/acme/app.git",
    refspecs: ["+refs/heads/main:refs/prvision/pr-1-base"],
    auth: { urlPrefix: "https://github.com/", header },
    depth: 50
  });
  const call = calls[0]!;
  assert.ok(!call.args.some((arg) => arg.includes("eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA")));
  assert.ok(call.args.includes("--depth=50"));
  assert.equal(call.options.env?.GIT_CONFIG_COUNT, "1");
  assert.equal(call.options.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  assert.equal(call.options.env.GIT_CONFIG_VALUE_0, header);
});

test("GitClient.fetch really fetches into refs/prvision from a configured remote", async () => {
  await withRepo({ "a.txt": "a" }, async (upstream) => {
    const upstreamHead = await upstream.commit("upstream work", { "b.txt": "b" });
    await withRepo({ "a.txt": "a" }, async (clone) => {
      await clone.git(["remote", "add", "origin", upstream.dir]);
      await git.fetch(clone.dir, { remote: "origin", refspecs: ["+refs/heads/main:refs/prvision/pr-7"] });
      assert.equal(await git.revParse(clone.dir, "refs/prvision/pr-7"), upstreamHead);
      await assert.rejects(fs.access(path.join(clone.dir, ".git", "FETCH_HEAD")));
      assert.equal(await git.remoteUrl(clone.dir), upstream.dir);
      await assert.rejects(
        git.fetch(clone.dir, { remote: "origin", refspecs: ["+refs/heads/nope:refs/prvision/pr-8"] }),
        isGitError("unknown_revision")
      );
    });
  });
});

test("GitClient child env is the allow-list: CHILD_PROCESS_BASE_ENV, GIT_ENV or the per-call env", async () => {
  const { runner, calls } = fakeRunner();
  const client = new GitClient({ runner });
  await client.statusPorcelain("/repo");
  await client.fetch("/repo", {
    remote: "origin",
    refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
    auth: { urlPrefix: "https://github.com/", header: "AUTHORIZATION: basic x" }
  });
  const perCall = new Set(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
  for (const call of calls) {
    for (const key of Object.keys(call.options.env ?? {})) {
      assert.ok(key in CHILD_PROCESS_BASE_ENV || key in GIT_ENV || perCall.has(key), `${key} must be allow-listed`);
    }
    for (const forbidden of ["PRVISION_SECRET_KEY", "DATABASE_URL", "REDIS_URL", "GIT_DIR", "GIT_WORK_TREE"]) {
      assert.equal(call.options.env?.[forbidden], undefined);
    }
    assert.equal(call.options.cwd, DATA_DIR);
    assert.equal(call.args[call.args.indexOf("-C") + 1], "/repo");
  }
});

test("GitClient.diffBinaryHead argv has -c diff.noprefix=false and --ignore-submodules=all, and applies cleanly with diff.noprefix=true", async () => {
  const { runner, calls } = fakeRunner();
  await new GitClient({ runner }).diffBinaryHead("/repo");
  const args = calls[0]!.args;
  const noprefix = args.indexOf("diff.noprefix=false");
  assert.ok(noprefix > 0 && args[noprefix - 1] === "-c" && noprefix < args.indexOf("diff"));
  assert.ok(args.includes("--ignore-submodules=all"));
  assert.ok(args.includes("--binary"));

  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await repo.git(["config", "diff.noprefix", "true"]);
    await fs.writeFile(path.join(repo.dir, "a.txt"), "two\n");
    const patch = await git.diffBinaryHead(repo.dir);
    assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt/m);
    await repo.git(["checkout", "--", "a.txt"]);
    await git.applyPatch(repo.dir, patch);
    assert.equal(await fs.readFile(path.join(repo.dir, "a.txt"), "utf8"), "two\n");
  });
});

test("GitClient.diffUnified is limited to the given paths", async () => {
  await withRepo({ "a.txt": "a\n", "b.txt": "b\n" }, async (repo) => {
    const base = (await repo.git(["rev-parse", "HEAD"])).trim();
    const head = await repo.commit("both", { "a.txt": "a2\n", "b.txt": "b2\n" });
    const diff = await git.diffUnified(repo.dir, base, head, { paths: ["a.txt"] });
    assert.match(diff, /a\/a\.txt/);
    assert.doesNotMatch(diff, /b\.txt/);
    const all = await git.diffUnified(repo.dir, base, head, { contextLines: 0 });
    assert.match(all, /b\/b\.txt/);
  });
});

test("GitClient.diffBinaryHead + applyPatch reproduce working-tree changes in a worktree", async () => {
  await withRepo({ "a.txt": "a\n", "img.bin": "\u0000\u0001\u0002" }, async (repo) => {
    const sha = (await repo.git(["rev-parse", "HEAD"])).trim();
    await fs.writeFile(path.join(repo.dir, "a.txt"), "a changed\n");
    await fs.writeFile(path.join(repo.dir, "img.bin"), Buffer.from([0, 9, 8, 7, 255]));
    await fs.writeFile(path.join(repo.dir, "staged.txt"), "staged\n");
    await repo.git(["add", "staged.txt"]);
    const patch = await git.diffBinaryHead(repo.dir);

    const dir = path.join(await worktreesRoot(), `patch-${process.pid}`);
    await git.worktreeAdd(repo.dir, dir, sha);
    try {
      await git.applyPatch(dir, patch);
      assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "a changed\n");
      assert.deepEqual(await fs.readFile(path.join(dir, "img.bin")), Buffer.from([0, 9, 8, 7, 255]));
      assert.equal(await fs.readFile(path.join(dir, "staged.txt"), "utf8"), "staged\n");
    } finally {
      await git.worktreeRemove(repo.dir, dir);
    }
  });
});

test("GitClient.applyPatch with a bad patch is patch_failed; an empty patch is a no-op", async () => {
  await withRepo({ "a.txt": "a\n" }, async (repo) => {
    const bad = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-zzz\n+yyy\n";
    await assert.rejects(git.applyPatch(repo.dir, bad), isGitError("patch_failed"));
  });
  const { runner, calls } = fakeRunner();
  await new GitClient({ runner }).applyPatch("/repo", "  \n");
  assert.equal(calls.length, 0);
});

test("GitClient.lsUntracked and statusPorcelain list untracked and modified files (incl. rename record)", async () => {
  await withRepo(
    { "a.txt": "a", "move-me.txt": "content for rename detection\n".repeat(5), ".gitignore": "ignored.txt\n" },
    async (repo) => {
      await fs.writeFile(path.join(repo.dir, "a.txt"), "changed");
      await fs.mkdir(path.join(repo.dir, "dir"));
      await fs.writeFile(path.join(repo.dir, "dir", "new file.txt"), "u");
      await fs.writeFile(path.join(repo.dir, "ignored.txt"), "i");
      await repo.git(["mv", "move-me.txt", "moved.txt"]);
      assert.deepEqual(await git.lsUntracked(repo.dir), ["dir/new file.txt"]);
      const status = await git.statusPorcelain(repo.dir);
      const byPath = new Map(status.map((entry) => [entry.path, entry]));
      assert.equal(byPath.get("a.txt")?.worktree, "M");
      assert.equal(byPath.get("dir/new file.txt")?.index, "?");
      assert.equal(byPath.get("moved.txt")?.index, "R");
      assert.equal(byPath.get("moved.txt")?.originalPath, "move-me.txt");
      assert.equal(await git.isDirty(repo.dir), true);
    }
  );
  await withRepo({ "a.txt": "a" }, async (repo) => {
    assert.equal(await git.isDirty(repo.dir), false);
  });
});

test("GitClient.lsFiles lists tracked files matching root and :(glob) pathspecs (15 §5.4.3)", async () => {
  await withRepo(
    {
      "angular.json": "{}",
      "src/web/angular.json": "{}",
      "src/web/vite.config.ts": "export default {};",
      "vite.config.mjs": "export default {};",
      "notes/angular.json.bak": "x"
    },
    async (repo) => {
      await fs.writeFile(path.join(repo.dir, "untracked-angular.json"), "{}");
      await fs.mkdir(path.join(repo.dir, "new"));
      await fs.writeFile(path.join(repo.dir, "new", "angular.json"), "{}");
      const files = await git.lsFiles(repo.dir, [
        "angular.json",
        ":(glob)**/angular.json",
        "vite.config.*",
        ":(glob)**/vite.config.*"
      ]);
      assert.deepEqual([...new Set(files)].sort(), [
        "angular.json",
        "src/web/angular.json",
        "src/web/vite.config.ts",
        "vite.config.mjs"
      ]);
    }
  );
});

test("GitClient.lsFiles rejects an empty pathspec list, an empty pathspec and NUL before running git", async () => {
  const { runner, calls } = fakeRunner();
  const client = new GitClient({ runner });
  for (const pathspecs of [[], [""], ["a\0b"]]) {
    await assert.rejects(client.lsFiles("/repo", pathspecs), (error: unknown) => {
      assert.ok(error instanceof GitCommandError);
      assert.equal(error.code, "invalid_argument");
      return true;
    });
  }
  assert.equal(calls.length, 0);
  await client.lsFiles("/repo", ["-not-an-option"]);
  assert.deepEqual(calls[0]?.args.slice(-4), ["ls-files", "-z", "--", "-not-an-option"]);
});

test("GitClient.listBranches and currentBranch (null when detached)", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    await repo.git(["branch", "feature/x"]);
    assert.deepEqual((await git.listBranches(repo.dir)).sort(), ["feature/x", "main"]);
    assert.equal(await git.currentBranch(repo.dir), "main");
    await repo.git(["checkout", "-q", "--detach"]);
    assert.equal(await git.currentBranch(repo.dir), null);
  });
});

test("GitClient.remoteUrl is null without origin; symbolicRefDefault is null without origin/HEAD", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    assert.equal(await git.remoteUrl(repo.dir), null);
    assert.equal(await git.symbolicRefDefault(repo.dir), null);
    await repo.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await repo.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    assert.equal(await git.symbolicRefDefault(repo.dir), "main");
  });
});

test("GitClient.showFile returns content and null for a missing path", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, async (repo) => {
    assert.equal(await git.showFile(repo.dir, "HEAD", "src/a.ts"), "export const a = 1;\n");
    assert.equal(await git.showFile(repo.dir, "HEAD", "src/missing.ts"), null);
    assert.deepEqual(await git.listFiles(repo.dir, "HEAD"), ["src/a.ts"]);
  });
});

test("GitClient.worktreeAdd creates a detached checkout; worktreeRemove is idempotent; worktreeList includes it", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    const sha = (await repo.git(["rev-parse", "HEAD"])).trim();
    const dir = path.join(await worktreesRoot(), `list-${process.pid}`);
    await git.worktreeAdd(repo.dir, dir, sha);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "a");
    assert.equal(await git.currentBranch(dir), null);
    assert.ok((await git.worktreeList(repo.dir)).includes(dir));
    await assert.rejects(git.worktreeAdd(repo.dir, dir, sha), isGitError("worktree_exists"));
    await git.worktreeRemove(repo.dir, dir);
    await git.worktreeRemove(repo.dir, dir);
    await git.worktreePrune(repo.dir);
    assert.ok(!(await git.worktreeList(repo.dir)).includes(dir));
    await assert.rejects(git.worktreeAdd(repo.dir, "/tmp/outside-data-dir", sha), isGitError("invalid_argument"));
    await assert.rejects(git.worktreeAdd(repo.dir, dir, "main"), isGitError("invalid_argument"));
  });
});

test("GitClient.worktreeAdd does not run user hooks", async () => {
  await withRepo({ "a.txt": "a" }, async (repo) => {
    const marker = path.join(repo.dir, "hook-ran");
    const hook = path.join(repo.dir, ".git", "hooks", "post-checkout");
    await fs.writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const sha = (await repo.git(["rev-parse", "HEAD"])).trim();
    const dir = path.join(await worktreesRoot(), `hooks-${process.pid}`);
    await git.worktreeAdd(repo.dir, dir, sha);
    try {
      await assert.rejects(fs.access(marker));
    } finally {
      await git.worktreeRemove(repo.dir, dir);
    }
  });
});

test("GitClient rejects unsafe refs (--foo, a..b, @{u}) with invalid_argument without spawning", async () => {
  const { runner, calls } = fakeRunner();
  const client = new GitClient({ runner });
  for (const ref of ["--upload-pack=x", "-x", "a..b", "main@{u}", "a//b", "x.lock", "dir/", "a b", ""]) {
    await assert.rejects(client.revParse("/repo", ref), isGitError("invalid_argument"), ref);
    await assert.rejects(client.diffNameStatus("/repo", ref, null), isGitError("invalid_argument"), ref);
  }
  await assert.rejects(
    client.fetch("/repo", { remote: "--upload-pack=evil", refspecs: ["+refs/heads/a:refs/prvision/pr-1"] }),
    isGitError("invalid_argument")
  );
  await assert.rejects(
    client.fetch("/repo", {
      remote: "https://user:pw@github.com/a/b.git",
      refspecs: ["+refs/heads/a:refs/prvision/pr-1"]
    }),
    isGitError("invalid_argument")
  );
  await assert.rejects(
    client.fetch("/repo", { remote: "origin", refspecs: ["+refs/heads/a:refs/heads/main"] }),
    isGitError("invalid_argument")
  );
  await assert.rejects(client.showFile("/repo", "HEAD", "../etc/passwd"), isGitError("invalid_argument"));
  await assert.rejects(client.revParse("relative/path", "main"), isGitError("invalid_argument"));
  assert.equal(calls.length, 0);
});

test("toGitCommandError maps stderr samples to codes", () => {
  const sample = (stderr: string, kind: ProcessError["kind"] = "non_zero_exit"): ProcessError =>
    new ProcessError("git failed", kind, "git", 128, null, "", stderr, 1);
  const cases: Array<[ProcessError | Error, string, GitCommandError["code"]]> = [
    [sample("fatal: not a git repository (or any of the parent directories): .git"), "status", "not_a_repository"],
    [sample("fatal: cannot change to '/nope': No such file or directory"), "status", "not_a_repository"],
    [sample("fatal: Authentication failed for 'https://github.com/a/b.git/'"), "fetch", "auth_failed"],
    [
      sample("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
      "fetch",
      "auth_failed"
    ],
    [
      sample("fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 403"),
      "fetch",
      "auth_failed"
    ],
    [sample("fatal: unable to access 'https://github.com/': Could not resolve host: github.com"), "fetch", "network"],
    [sample("fatal: couldn't find remote ref refs/pull/9/head"), "fetch", "unknown_revision"],
    [sample("fatal: ambiguous argument 'nope': unknown revision"), "diff", "unknown_revision"],
    [sample("fatal: '/data/worktrees/1/base' already exists"), "worktree", "worktree_exists"],
    [sample("error: patch failed: a.txt:1"), "apply", "patch_failed"],
    [sample("something else"), "status", "command_failed"],
    [sample("", "spawn_failed"), "status", "git_not_found"],
    [sample("", "timeout"), "fetch", "timeout"],
    [sample("", "aborted"), "fetch", "aborted"],
    [sample("", "max_buffer"), "diff", "output_too_large"],
    [new Error("weird"), "status", "command_failed"]
  ];
  for (const [error, subcommand, code] of cases) {
    const mapped = toGitCommandError(error, subcommand);
    assert.equal(mapped.code, code, `${subcommand}: ${error instanceof ProcessError ? error.stderr : error.message}`);
    assert.equal(mapped.subcommand, subcommand);
  }
  const token = `ghp_${"z".repeat(36)}`;
  const redacted = toGitCommandError(sample(`fatal: https://x-access-token:${token}@github.com/ failed`), "fetch");
  assert.ok(!redacted.stderr.includes(token));
  assert.ok(toGitCommandError(sample("x".repeat(10_000)), "diff").stderr.length <= 4_000);
});

test("parseLogCommits splits records and fields, takes the first parent, flags merges and rejects malformed output", () => {
  const sha = "f".repeat(40);
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  const out =
    `${sha}\0${first} ${second}\0Fix: a, b\0Ada Lovelace\0 2026-01-02T03:04:05+02:00\x1e\n` +
    `${first}\0${"e".repeat(40)}\0Plain\0Ada\0 2026-01-01T12:00:00Z\x1e\n` +
    `${"e".repeat(40)}\0\0\0\0 2026-01-01T00:00:00Z\x1e\n`;
  assert.deepEqual(parseLogCommits(out), [
    {
      sha,
      parentSha: first,
      isMerge: true,
      subject: "Fix: a, b",
      authorName: "Ada Lovelace",
      committedAt: "2026-01-02T03:04:05+02:00"
    },
    {
      sha: first,
      parentSha: "e".repeat(40),
      isMerge: false,
      subject: "Plain",
      authorName: "Ada",
      committedAt: "2026-01-01T12:00:00Z"
    },
    {
      sha: "e".repeat(40),
      parentSha: null,
      isMerge: false,
      subject: "",
      authorName: "",
      committedAt: "2026-01-01T00:00:00Z"
    }
  ]);
  assert.deepEqual(parseLogCommits(""), []);
  assert.throws(() => parseLogCommits("not-a-sha\0\0s\0a\0d\x1e"), isGitError("command_failed"));
  assert.throws(() => parseLogCommits(`${sha}\0not-a-parent\0s\0a\0d\x1e`), isGitError("command_failed"));
  assert.throws(() => parseLogCommits(`${sha}\0\0only three\x1e`), isGitError("command_failed"));
});

test("parseNameStatusZ / parseStatusPorcelainZ / parseWorktreeListZ / parseGitVersion", () => {
  assert.deepEqual(
    parseNameStatusZ("M\0src/a.ts\0R087\0old.ts\0new.ts\0C100\0x.ts\0y.ts\0A\0b c.ts\0D\0gone.ts\0T\0t\0U\0u\0X\0x\0"),
    [
      { status: "M", path: "src/a.ts" },
      { status: "R", score: 87, path: "new.ts", previousPath: "old.ts" },
      { status: "C", score: 100, path: "y.ts", previousPath: "x.ts" },
      { status: "A", path: "b c.ts" },
      { status: "D", path: "gone.ts" },
      { status: "T", path: "t" },
      { status: "U", path: "u" },
      { status: "X", path: "x" }
    ]
  );
  assert.deepEqual(parseNameStatusZ(""), []);
  assert.throws(
    () => parseNameStatusZ("Q\0file\0"),
    (error: unknown) => error instanceof GitCommandError && error.code === "command_failed"
  );

  assert.deepEqual(parseStatusPorcelainZ(" M a.txt\0R  new.txt\0old.txt\0?? dir/u.txt\0"), [
    { index: " ", worktree: "M", path: "a.txt" },
    { index: "R", worktree: " ", path: "new.txt", originalPath: "old.txt" },
    { index: "?", worktree: "?", path: "dir/u.txt" }
  ]);

  assert.deepEqual(
    parseWorktreeListZ(
      "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /data/worktrees/1/base\0HEAD def\0detached\0\0"
    ),
    ["/repo", "/data/worktrees/1/base"]
  );

  assert.deepEqual(parseGitVersion("git version 2.43.0\n"), {
    raw: "git version 2.43.0",
    major: 2,
    minor: 43,
    patch: 0
  });
  assert.equal(parseGitVersion("git version 2.39.3 (Apple Git-146)").minor, 39);
  assert.equal(parseGitVersion("git version 2.45.1.windows.1").patch, 1);
  assert.equal(parseGitVersion("git version 2.31").patch, 0);
});
