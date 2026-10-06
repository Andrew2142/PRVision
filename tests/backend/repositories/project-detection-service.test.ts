import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  ProjectDetectionService,
  type DetectedProject,
  type DetectionFailure,
  type DetectionResult
} from "../../../backend/src/services/repositories/project-detection-service";
import {
  createDetectionFixture,
  DEFAULT_PACKAGE_JSON,
  fakeGit,
  writeFile,
  type FakeGitState,
  type FixtureSpec
} from "./helpers/detection-fixture";

/** A data dir that neither contains nor is inside the fixtures. */
async function tempDataDir(t: TestContext): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-detect-data-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t: TestContext, spec: FixtureSpec = {}): Promise<string> {
  const created = await createDetectionFixture(spec);
  t.after(() => created.cleanup());
  return created.root;
}

async function detect(
  t: TestContext,
  root: string,
  git: Partial<FakeGitState> = {},
  dataDir?: string
): Promise<DetectionResult> {
  const service = new ProjectDetectionService({ git: fakeGit(git), dataDir: dataDir ?? (await tempDataDir(t)) });
  return service.detect(root);
}

function expectProject(result: DetectionResult): DetectedProject {
  if (!result.ok) {
    assert.fail(`expected success, got ${result.failure.errorReason}: ${result.failure.message}`);
  }
  return result.project;
}

function expectFailure(result: DetectionResult, errorReason: DetectionFailure["errorReason"]): string {
  if (result.ok) {
    assert.fail(`expected ${errorReason}, got success`);
  }
  assert.equal(result.failure.status, 400);
  assert.equal(result.failure.errorReason, errorReason, result.failure.message);
  return result.failure.message;
}

const STANDARD_FILES = {
  "vite.config.ts": "export default {};\n",
  "tsconfig.json": "{}\n",
  "tsconfig.app.json": "{}\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "index.html":
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  "src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n',
  "src/App.tsx": "export default function App() { return null; }\n",
  "src/index.css": "body { margin: 0; }\n"
};

test("detects a standard Vite React TS project", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  const project = expectProject(await detect(t, root));
  assert.deepEqual(
    { ...project, warnings: [] },
    {
      rootPath: root,
      suggestedName: "fixture-app",
      githubOwner: null,
      githubRepo: null,
      githubRemoteName: null,
      defaultBranch: "main",
      framework: "react_vite",
      packageManager: "pnpm",
      appRoot: ".",
      angularProject: null,
      angularBuildConfiguration: null,
      viteConfigPath: "vite.config.ts",
      tsconfigPath: "tsconfig.app.json",
      entryFilePath: "src/main.tsx",
      globalStylePaths: ["/src/index.css"],
      warnings: []
    }
  );
  assert.deepEqual(project.warnings, []);
});

test("resolves a trailing slash and a symlinked spelling to the realpath", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  const link = path.join(path.dirname(root), "link-to-project");
  await fs.symlink(root, link);
  assert.equal(expectProject(await detect(t, `${link}/`)).rootPath, root);
});

test("fails validation_failed for a missing folder", async (t) => {
  const root = await fixture(t);
  const missing = path.join(root, "does-not-exist");
  assert.equal(expectFailure(await detect(t, missing), "validation_failed"), `Folder does not exist: ${missing}`);
  const file = path.join(root, "package.json");
  assert.equal(expectFailure(await detect(t, file), "validation_failed"), `Not a folder: ${file}`);
});

test("fails validation_failed for a folder inside the data dir", async (t) => {
  const dataDir = await tempDataDir(t);
  await fs.mkdir(path.join(dataDir, "worktrees"));
  const root = await fixture(t, { parentDir: path.join(dataDir, "worktrees"), files: STANDARD_FILES });
  assert.equal(
    expectFailure(await detect(t, root, {}, dataDir), "validation_failed"),
    "Folders inside the PRVision data directory cannot be registered"
  );
  assert.equal(
    expectFailure(await detect(t, dataDir, {}, dataDir), "validation_failed"),
    "Folders inside the PRVision data directory cannot be registered"
  );
});

test("accepts the fixture repository under <dataDir>/fixtures (build note 06, deviation 1)", async (t) => {
  const dataDir = await tempDataDir(t);
  await fs.mkdir(path.join(dataDir, "fixtures"));
  const root = await fixture(t, { parentDir: path.join(dataDir, "fixtures"), files: STANDARD_FILES });
  assert.equal(expectProject(await detect(t, root, {}, dataDir)).rootPath, root);
});

test("fails validation_failed for a folder that contains the data dir", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  const dataDir = path.join(root, ".prvision");
  await fs.mkdir(dataDir);
  const message = expectFailure(await detect(t, root, {}, dataDir), "validation_failed");
  assert.ok(message.startsWith(`This folder contains the PRVision data directory (${dataDir})`), message);
});

test("treats a package.json symlink pointing outside the root as missing", async (t) => {
  const outside = await fixture(t); // a valid package.json elsewhere
  const root = await fixture(t, { files: STANDARD_FILES });
  await fs.rm(path.join(root, "package.json"));
  await fs.symlink(path.join(outside, "package.json"), path.join(root, "package.json"));
  assert.equal(expectFailure(await detect(t, root), "unsupported_framework"), "No package.json at the repository root");
});

test("ignores an index.html entry and style imports that escape the root", async (t) => {
  const outside = await fixture(t, { files: { "evil.css": "x{}" } });
  const root = await fixture(t, {
    files: {
      ...STANDARD_FILES,
      "index.html": '<script type="module" src="../../outside/main.tsx"></script>',
      "src/main.jsx": 'import "./linked.css";\nimport "./index.css";\n'
    }
  });
  await fs.rm(path.join(root, "src/main.tsx"));
  await fs.symlink(path.join(outside, "evil.css"), path.join(root, "src/linked.css"));
  const project = expectProject(await detect(t, root));
  assert.equal(project.entryFilePath, "src/main.jsx");
  assert.deepEqual(project.globalStylePaths, ["/src/index.css"]);
});

test("fails not_git_repo when rev-parse fails", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  assert.equal(
    expectFailure(await detect(t, root, { isRepository: false }), "not_git_repo"),
    `Not a git repository: ${root}`
  );
});

test("a sub-folder of the toplevel registers the toplevel (15 §5.4.2; formerly not_git_repo)", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  const project = expectProject(await detect(t, path.join(root, "src"), { toplevel: root }));
  assert.equal(project.rootPath, root);
  assert.equal(project.appRoot, ".");
  assert.equal(project.framework, "react_vite");
});

test("fails not_git_repo when the repo has no commits", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  assert.equal(
    expectFailure(await detect(t, root, { hasCommits: false }), "not_git_repo"),
    "The repository has no commits yet"
  );
});

test("fails unsupported_framework without package.json", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  await fs.rm(path.join(root, "package.json"));
  assert.equal(expectFailure(await detect(t, root), "unsupported_framework"), "No package.json at the repository root");
});

test("fails unsupported_framework for invalid package.json", async (t) => {
  const invalid = await fixture(t, { packageJson: "{ not json" });
  assert.equal(expectFailure(await detect(t, invalid), "unsupported_framework"), "package.json is not valid JSON");
  const array = await fixture(t, { packageJson: "[1, 2]" });
  assert.equal(expectFailure(await detect(t, array), "unsupported_framework"), "package.json is not valid JSON");
  const huge = await fixture(t, { packageJson: `{"name":"x","pad":"${"x".repeat(1_048_600)}"}` });
  assert.equal(expectFailure(await detect(t, huge), "unsupported_framework"), "package.json is larger than 1 MiB");
});

test("fails unsupported_framework for a workspace root without react/vite", async (t) => {
  const root = await fixture(t, { packageJson: { name: "monorepo", private: true, workspaces: ["packages/*"] } });
  assert.ok(
    expectFailure(await detect(t, root), "unsupported_framework").startsWith("This looks like a monorepo root")
  );
  const pnpmRoot = await fixture(t, {
    packageJson: { name: "mono", devDependencies: { vite: "^7.0.0" } },
    files: { "pnpm-workspace.yaml": "packages:\n  - apps/*\n" }
  });
  assert.ok(expectFailure(await detect(t, pnpmRoot), "unsupported_framework").includes("monorepo root"));
});

test("accepts a workspace root that declares react and vite, with a warning", async (t) => {
  const root = await fixture(t, {
    packageJson: { ...DEFAULT_PACKAGE_JSON, workspaces: { packages: ["packages/*"] } },
    files: STANDARD_FILES
  });
  const project = expectProject(await detect(t, root));
  assert.ok(
    project.warnings.includes("Workspace root detected; rendering uses the root package and the hoisted node_modules.")
  );
});

test("fails unsupported_framework for Next.js even when vite is present", async (t) => {
  const root = await fixture(t, {
    packageJson: { ...DEFAULT_PACKAGE_JSON, dependencies: { ...DEFAULT_PACKAGE_JSON.dependencies, next: "15.0.0" } }
  });
  assert.equal(
    expectFailure(await detect(t, root), "unsupported_framework"),
    "Next.js projects are not supported yet (PRVision renders Vite + React projects)"
  );
});

test("fails unsupported_framework when react-dom is missing", async (t) => {
  const root = await fixture(t, {
    packageJson: { name: "x", dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^7.0.0" } }
  });
  assert.equal(
    expectFailure(await detect(t, root), "unsupported_framework"),
    "React and react-dom must be dependencies of the root package.json"
  );
  const noVite = await fixture(t, { packageJson: { name: "x", dependencies: DEFAULT_PACKAGE_JSON.dependencies } });
  assert.equal(
    expectFailure(await detect(t, noVite), "unsupported_framework"),
    "Vite was not found in package.json (dependencies or devDependencies)"
  );
});

test("fails unsupported_framework when Vite 3 is installed", async (t) => {
  const root = await fixture(t, { installed: { vite: "3.2.7", react: "19.0.0", "react-dom": "19.0.0" } });
  assert.equal(
    expectFailure(await detect(t, root), "unsupported_framework"),
    "Vite 3.2.7 is not supported (need 4 or newer)"
  );
});

test("warns for React <18 and Angular packages without failing", async (t) => {
  const root = await fixture(t, {
    packageJson: { ...DEFAULT_PACKAGE_JSON, devDependencies: { vite: "^5.0.0", "@angular/core": "19.0.0" } },
    installed: { vite: "5.4.0", react: "17.0.2", "react-dom": "17.0.2" },
    files: STANDARD_FILES
  });
  const project = expectProject(await detect(t, root));
  assert.ok(project.warnings.includes("React <18 detected; the harness uses createRoot and may fail"));
  assert.ok(project.warnings.includes("Angular packages found; only React components are analysed"));
});

test("fails missing_node_modules without node_modules and names the right package manager", async (t) => {
  const root = await fixture(t, { noNodeModules: true, files: { "yarn.lock": "" } });
  assert.equal(
    expectFailure(await detect(t, root), "missing_node_modules"),
    `node_modules not found. Run \`yarn install\` in ${root} first.`
  );
});

test("fails missing_node_modules for Yarn PnP", async (t) => {
  const root = await fixture(t, { noNodeModules: true, files: { "yarn.lock": "", ".pnp.cjs": "" } });
  assert.ok(
    expectFailure(await detect(t, root), "missing_node_modules").startsWith("Yarn Plug'n'Play is not supported")
  );
});

test("fails missing_node_modules when vite is declared but not installed", async (t) => {
  const root = await fixture(t, { installed: { react: "19.0.0", "react-dom": "19.0.0" } });
  assert.equal(
    expectFailure(await detect(t, root), "missing_node_modules"),
    "vite is declared but not installed. Run `npm install`."
  );
});

test("discovers vite.config.js before vite.config.ts (Vite order)", async (t) => {
  const root = await fixture(t, {
    files: { ...STANDARD_FILES, "vite.config.js": "export default {};\n", "vite.config.mjs": "export default {};\n" }
  });
  assert.equal(expectProject(await detect(t, root)).viteConfigPath, "vite.config.js");
  const none = await fixture(t, { files: { "src/main.tsx": "" } });
  const project = expectProject(await detect(t, none));
  assert.equal(project.viteConfigPath, null);
  assert.ok(project.warnings.includes("No vite.config found; the render engine will use Vite defaults"));
});

test("prefers tsconfig.app.json over tsconfig.json", async (t) => {
  const both = await fixture(t, { files: { "tsconfig.json": "{}", "tsconfig.app.json": "{}" } });
  assert.equal(expectProject(await detect(t, both)).tsconfigPath, "tsconfig.app.json");
  const plain = await fixture(t, { files: { "tsconfig.json": "{}" } });
  assert.equal(expectProject(await detect(t, plain)).tsconfigPath, "tsconfig.json");
  const js = await fixture(t);
  assert.equal(expectProject(await detect(t, js)).tsconfigPath, null);
});

test("falls back to src/main.jsx when index.html has no module script", async (t) => {
  const root = await fixture(t, {
    files: {
      "index.html": '<script src="/legacy.js"></script>',
      "src/main.jsx": 'import "./index.css";\n',
      "src/index.css": "body{}"
    }
  });
  const project = expectProject(await detect(t, root));
  assert.equal(project.entryFilePath, "src/main.jsx");
  assert.deepEqual(project.globalStylePaths, ["/src/index.css"]);
  assert.ok(project.warnings.includes("Entry file inferred from convention (src/main.jsx)"));
});

test("resolves a relative module script src against index.html and strips query and hash", async (t) => {
  const root = await fixture(t, {
    files: { "index.html": '<script type="module" src="./app/boot.tsx?v=1#x"></script>', "app/boot.tsx": "" }
  });
  assert.equal(expectProject(await detect(t, root)).entryFilePath, "app/boot.tsx");
});

test("returns null entry and no styles when nothing is found, with warnings", async (t) => {
  const root = await fixture(t);
  const project = expectProject(await detect(t, root));
  assert.equal(project.entryFilePath, null);
  assert.deepEqual(project.globalStylePaths, []);
  assert.ok(project.warnings.includes("No entry file found; global styles were not detected"));
});

test("uses upstream before origin for the GitHub remote", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  const project = expectProject(
    await detect(t, root, {
      remotes: {
        origin: "git@github.com:me/web-app.git",
        upstream: "https://github.com/acme/web-app.git"
      },
      symbolicDefault: { upstream: "develop" }
    })
  );
  assert.equal(project.githubOwner, "acme");
  assert.equal(project.githubRepo, "web-app");
  assert.equal(project.githubRemoteName, "upstream");
  assert.equal(project.defaultBranch, "develop");

  const originOnly = expectProject(
    await detect(t, root, { remotes: { origin: "https://user:ghp_secret@github.com/me/web-app.git" } })
  );
  assert.deepEqual(
    [originOnly.githubOwner, originOnly.githubRepo, originOnly.githubRemoteName],
    ["me", "web-app", "origin"]
  );
  assert.ok(!JSON.stringify(originOnly).includes("ghp_secret"));
});

test("returns null owner/repo for a GitLab remote, with a warning", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  const project = expectProject(await detect(t, root, { remotes: { origin: "https://gitlab.com/acme/web-app.git" } }));
  assert.equal(project.githubOwner, null);
  assert.equal(project.githubRepo, null);
  assert.equal(project.githubRemoteName, null);
  assert.ok(project.warnings.includes("Remote origin is not on github.com; pull request features are disabled"));
  assert.ok(project.warnings.some((w) => w.startsWith("origin/HEAD is not set")));
});

test("default branch: symbolic ref, then main/master, then current, then first branch", async (t) => {
  const root = await fixture(t, { files: STANDARD_FILES });
  const remotes = { origin: "https://github.com/acme/web.git" };
  const branchOf = async (git: Partial<FakeGitState>): Promise<string> =>
    expectProject(await detect(t, root, git)).defaultBranch;

  assert.equal(await branchOf({ remotes, symbolicDefault: { origin: "trunk" }, branches: ["main"] }), "trunk");
  assert.equal(await branchOf({ remotes, branches: ["feature/x", "master", "main"], current: "feature/x" }), "main");
  assert.equal(await branchOf({ branches: ["feature/x", "master"], current: "feature/x" }), "master");
  assert.equal(await branchOf({ branches: ["feature/x", "feature/y"], current: "feature/y" }), "feature/y");
  assert.equal(await branchOf({ branches: ["feature/x", "feature/y"], current: null }), "feature/x");

  const warned = expectProject(await detect(t, root, { remotes, branches: ["main"] }));
  assert.ok(
    warned.warnings.includes(
      "origin/HEAD is not set; run `git remote set-head origin --auto` for an accurate default branch"
    )
  );
  assert.equal(
    expectFailure(await detect(t, root, { branches: [], current: null }), "not_git_repo"),
    "Could not determine a default branch (no local branches)"
  );
});

test("uses the package.json name, else the folder basename", async (t) => {
  const named = await fixture(t);
  assert.equal(expectProject(await detect(t, named)).suggestedName, "fixture-app");
  const unnamed = await fixture(t, { packageJson: { ...DEFAULT_PACKAGE_JSON, name: "" } });
  assert.equal(expectProject(await detect(t, unnamed)).suggestedName, "project");
  const tooLong = await fixture(t, { packageJson: { ...DEFAULT_PACKAGE_JSON, name: "x".repeat(201) } });
  assert.equal(expectProject(await detect(t, tooLong)).suggestedName, "project");
});

test("follows a pnpm-style node_modules symlink to read the installed version", async (t) => {
  // pnpm layout: node_modules/vite is a symlink into .pnpm; detection follows it for the version only.
  const root = await fixture(t, { installed: { react: "19.0.0", "react-dom": "19.0.0" }, files: STANDARD_FILES });
  await writeFile(root, "node_modules/.pnpm/vite@7.1.0/node_modules/vite/package.json", '{"version":"7.1.0"}');
  await fs.symlink(
    path.join(root, "node_modules/.pnpm/vite@7.1.0/node_modules/vite"),
    path.join(root, "node_modules/vite")
  );
  assert.equal(expectProject(await detect(t, root)).framework, "react_vite");
});
