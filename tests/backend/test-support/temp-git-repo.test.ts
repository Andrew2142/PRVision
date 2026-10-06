import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { componentSource, isolatedGitEnv, reactViteFiles, withTempGitRepo } from "../helpers/temp-git-repo";

const noGit = spawnSync("git", ["--version"]).status !== 0 ? "git is not available" : false;

/** Sheet 06's ProjectDetectionService (wave 3). The detection case runs once that module exists. */
const DETECTION_MODULE = path.resolve(
  __dirname,
  "../../../backend/src/services/repositories/project-detection-service.ts"
);
const noDetection = fs.existsSync(DETECTION_MODULE)
  ? false
  : "needs sheet 06's backend/src/services/repositories/project-detection-service.ts (wave 3)";

test("createTempGitRepo creates main with an initial commit and .gitignore", { skip: noGit }, (t) => {
  const repo = withTempGitRepo(t, { files: { "README.md": "# hi\n" } });
  assert.equal(repo.git("symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(repo.git("rev-list", "--count", "HEAD"), "1");
  assert.equal(repo.git("log", "-1", "--format=%s"), "initial");
  assert.equal(fs.readFileSync(path.join(repo.path, ".gitignore"), "utf8"), "node_modules\ndist\n");
  assert.deepEqual(repo.git("ls-files").split("\n"), [".gitignore", "README.md"]);
  assert.equal(repo.git("status", "--porcelain"), "");
});

test("identical steps in two repos produce identical SHAs", { skip: noGit }, (t) => {
  const steps = (): string[] => {
    const repo = withTempGitRepo(t, { files: reactViteFiles() });
    repo.branch("feature/x");
    const first = repo.commit("feat: button", { "src/Button.tsx": componentSource("Button", "<button>Hi</button>") });
    const second = repo.commit("chore: drop app", {}, { remove: ["src/App.tsx"] });
    return [repo.sha("main"), first, second];
  };
  assert.deepEqual(steps(), steps());
});

test("dirty produces modified, staged, untracked and deleted entries", { skip: noGit }, (t) => {
  const repo = withTempGitRepo(t, { files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" } });
  repo.dirty({ modify: { "a.txt": "A\n" }, untracked: { "new.txt": "n\n" }, remove: ["c.txt"], stage: true });
  repo.dirty({ modify: { "b.txt": "B\n" } });
  const status = repo.git("status", "--porcelain=v1", "--untracked-files=all").split("\n").sort();
  assert.deepEqual(status, [" D c.txt", " M b.txt", "?? new.txt", "M  a.txt"]);
});

test("createBareOrigin + setPullRef exposes refs/pull/<n>/head to git ls-remote", { skip: noGit }, (t) => {
  const repo = withTempGitRepo(t);
  repo.branch("feature/pr");
  const head = repo.commit("feat: pr change", { "pr.txt": "pr\n" });
  const bare = repo.createBareOrigin();
  t.after(() => {
    bare.cleanup();
  });
  bare.setPullRef(1, head);
  const listed = execFileSync("git", ["ls-remote", bare.path, "refs/pull/1/head"], {
    env: isolatedGitEnv(),
    encoding: "utf8"
  });
  assert.equal(listed.trim(), `${head}\trefs/pull/1/head`);
  assert.equal(bare.git("rev-parse", "refs/heads/feature/pr"), head);
});

test(
  "snapshot changes when HEAD, branches, status, index or stash change and ignores refs/prvision",
  { skip: noGit },
  (t) => {
    const repo = withTempGitRepo(t, { files: { "a.txt": "a\n" } });
    const base = repo.snapshot();
    assert.equal(base.symbolicHead, "refs/heads/main");

    repo.git("update-ref", "refs/prvision/pr-1", repo.sha());
    assert.deepEqual(repo.snapshot(), base, "refs/prvision/* must be ignored");

    repo.git("branch", "side");
    const withBranch = repo.snapshot();
    assert.notEqual(withBranch.branches, base.branches);

    repo.write({ "a.txt": "changed\n" });
    const dirty = repo.snapshot();
    assert.notEqual(dirty.status, withBranch.status);

    repo.git("add", "a.txt");
    const staged = repo.snapshot();
    assert.notEqual(staged.indexHash, dirty.indexHash);

    repo.git("stash");
    const stashed = repo.snapshot();
    assert.notEqual(stashed.stashes, staged.stashes);

    repo.commit("second", { "b.txt": "b\n" });
    assert.notEqual(repo.snapshot().head, stashed.head);
  }
);

test("helpers ignore the developer's global and system git config", { skip: noGit }, (t) => {
  const repo = withTempGitRepo(t);
  const origins = repo
    .git("config", "--list", "--show-origin")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[0]);
  assert.ok(origins.length > 0);
  for (const origin of origins) {
    assert.equal(origin, "file:.git/config", `unexpected config origin ${String(origin)}`);
  }
});

test("nodeModules option produces a layout sheet 06 detection accepts", { skip: noGit || noDetection }, async (t) => {
  const repo = withTempGitRepo(t, { files: reactViteFiles(), nodeModules: true });
  assert.ok(fs.existsSync(path.join(repo.path, "node_modules", "vite", "package.json")));
  assert.equal(repo.git("status", "--porcelain"), "", "node_modules must be ignored");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- sheet 06's module does not exist in wave 2; loaded only when this case runs
  const { ProjectDetectionService } = require(DETECTION_MODULE) as {
    ProjectDetectionService: new () => { detect(inputPath: string): Promise<unknown> };
  };
  const result = (await new ProjectDetectionService().detect(repo.path)) as {
    ok: boolean;
    project?: { framework: string; packageManager: string };
  };
  assert.equal(result.ok, true);
  assert.equal(result.project?.framework, "react_vite");
  assert.equal(result.project.packageManager, "npm");
});
