/**
 * App discovery (15 §5.4.3) over real temp git repositories: `git ls-files` with the discovery pathspecs, the real
 * GitClient and the real file system. Nothing is installed; node_modules stubs are git-ignored.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  ProjectDetectionService,
  type AppDiscovery,
  type AppDiscoveryResult
} from "../../../backend/src/services/repositories/project-detection-service";
import { GitClient } from "../../../backend/src/utilities/services/git-client";
import { useTempDataDir } from "../helpers/temp-dir";
import { reactViteFiles, withTempGitRepo, type FileMap, type TempGitRepo } from "../helpers/temp-git-repo";
import { ANGULAR_21_INSTALL, angularAppFiles, installedPackages } from "./helpers/angular-fixture";

function service(t: TestContext): ProjectDetectionService {
  return new ProjectDetectionService({ git: new GitClient(), dataDir: useTempDataDir(t) });
}

function expectDiscovery(result: AppDiscoveryResult): AppDiscovery {
  if (!result.ok) {
    assert.fail(`expected a discovery, got ${result.failure.errorReason}: ${result.failure.message}`);
  }
  return result.discovery;
}

/** Acme-like monorepo: two Angular workspaces under src/, a React site deeper down, an empty root node_modules. */
function acmeLike(t: TestContext): TempGitRepo {
  const files: FileMap = {
    "package.json": `${JSON.stringify({ name: "acme", private: true })}\n`,
    ...angularAppFiles("src/tenant-frontend"),
    ...angularAppFiles("src/core-frontend"),
    "src/public-sites/estates/resident-app/package.json": `${JSON.stringify({
      name: "estates-resident-app",
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: { vite: "^5.4.10" }
    })}\n`,
    "src/public-sites/estates/resident-app/vite.config.ts": "export default {};\n"
  };
  const repo = withTempGitRepo(t, { files });
  fs.mkdirSync(path.join(repo.path, "node_modules"), { recursive: true });
  repo.write(installedPackages("src/tenant-frontend/node_modules", ANGULAR_21_INSTALL));
  return repo;
}

test("an Acme-like monorepo lists both Angular workspaces as supported and checks the nested React site at its own root", async (t) => {
  const repo = acmeLike(t);
  const discovery = expectDiscovery(await service(t).discoverApps(repo.path));
  assert.equal(discovery.rootPath, repo.path);
  assert.equal(discovery.hint, null);
  assert.deepEqual(
    discovery.apps.map((app) => [app.appRoot, app.framework, app.angularProject, app.supported]),
    [
      ["src/core-frontend", "angular", "core-frontend", true],
      ["src/tenant-frontend", "angular", "tenant-frontend", true],
      ["src/public-sites/estates/resident-app", "react_vite", null, false]
    ]
  );
  const repoName = path.basename(repo.path);
  assert.equal(discovery.apps[1]?.suggestedName, `${repoName} · tenant-frontend`);
  assert.equal(discovery.apps[2]?.suggestedName, "estates-resident-app");
  // The React site is detected at its own folder; it is unsupported here only because it has no node_modules.
  assert.match(
    discovery.apps[2].reason ?? "",
    /^node_modules not found\. Run `npm install` in .*\/src\/public-sites\/estates\/resident-app first\.$/
  );
  assert.deepEqual(discovery.warnings, []);
});

test("a sub-folder input becomes the hint, sorts first and is preselected by detect()", async (t) => {
  const repo = acmeLike(t);
  const detector = service(t);
  const discovery = expectDiscovery(await detector.discoverApps(path.join(repo.path, "src/tenant-frontend")));
  assert.equal(discovery.rootPath, repo.path);
  assert.equal(discovery.hint, "src/tenant-frontend");
  assert.equal(discovery.apps[0]?.appRoot, "src/tenant-frontend");

  const detected = await detector.detect(path.join(repo.path, "src/tenant-frontend"));
  assert.ok(detected.ok, detected.ok ? "" : detected.failure.message);
  assert.equal(detected.project.rootPath, repo.path);
  assert.equal(detected.project.appRoot, "src/tenant-frontend");
  assert.equal(detected.project.angularProject, "tenant-frontend");

  const ambiguous = await detector.detect(repo.path);
  assert.ok(!ambiguous.ok);
  assert.equal(ambiguous.failure.errorReason, "validation_failed");
  assert.match(
    ambiguous.failure.message,
    /^This repository contains 2 apps\. Choose one: src\/core-frontend · core-frontend, src\/tenant-frontend · tenant-frontend$/
  );
});

test("a root Vite + React app is a supported react_vite candidate", async (t) => {
  const repo = withTempGitRepo(t, { files: reactViteFiles(), nodeModules: true });
  const discovery = expectDiscovery(await service(t).discoverApps(repo.path));
  assert.deepEqual(discovery.apps, [
    {
      appRoot: ".",
      framework: "react_vite",
      angularProject: null,
      suggestedName: "temp-app",
      supported: true,
      reason: null
    }
  ]);
});

test("a root React app that fails 06 detection is listed with 06's message", async (t) => {
  const repo = withTempGitRepo(t, { files: reactViteFiles() }); // no node_modules
  const discovery = expectDiscovery(await service(t).discoverApps(repo.path));
  assert.equal(discovery.apps.length, 1);
  assert.equal(discovery.apps[0]?.supported, false);
  assert.match(discovery.apps[0].reason ?? "", /^node_modules not found\. Run `npm install`/);
});

test("React in apps/x is detected at its app root, which reports the missing node_modules", async (t) => {
  const repo = withTempGitRepo(t, {
    files: {
      "package.json": `${JSON.stringify({ name: "mono", private: true, workspaces: ["apps/*"] })}\n`,
      ...Object.fromEntries(Object.entries(reactViteFiles()).map(([file, content]) => [`apps/x/${file}`, content]))
    }
  });
  const discovery = expectDiscovery(await service(t).discoverApps(repo.path));
  assert.deepEqual(
    discovery.apps.map((app) => [app.appRoot, app.supported]),
    [["apps/x", false]]
  );
  assert.match(discovery.apps[0]?.reason ?? "", /^node_modules not found\. Run `npm install` in .*\/apps\/x first\.$/);
});

test("the webpack builder is listed as unsupported with the migration hint", async (t) => {
  const repo = withTempGitRepo(t, {
    files: angularAppFiles("legacy", {
      projects: [{ name: "legacy", builder: "@angular-devkit/build-angular:browser" }]
    })
  });
  const discovery = expectDiscovery(await service(t).discoverApps(repo.path));
  assert.equal(discovery.apps.length, 1);
  assert.equal(discovery.apps[0]?.supported, false);
  assert.match(discovery.apps[0].reason ?? "", /webpack builder \(@angular-devkit\/build-angular:browser\)/);
});

test("an unreadable angular.json is listed as unsupported", async (t) => {
  const repo = withTempGitRepo(t, { files: { "web/angular.json": "{ broken" } });
  const discovery = expectDiscovery(await service(t).discoverApps(repo.path));
  assert.equal(discovery.apps.length, 1);
  assert.equal(discovery.apps[0]?.appRoot, "web");
  assert.match(discovery.apps[0].reason ?? "", /^angular\.json could not be read: /);
});

test("more than 50 app configs: the first 50 are inspected, with a warning", async (t) => {
  const files: FileMap = {};
  for (let index = 0; index < 51; index += 1) {
    const dir = `apps/a${String(index).padStart(2, "0")}`;
    files[`${dir}/angular.json`] = angularAppFiles(dir)[`${dir}/angular.json`] ?? "";
  }
  const repo = withTempGitRepo(t, { files });
  const discovery = expectDiscovery(await service(t).discoverApps(repo.path));
  assert.equal(discovery.apps.length, 50);
  assert.equal(
    discovery.apps.some((app) => app.appRoot === "apps/a50"),
    false
  );
  assert.deepEqual(discovery.warnings, ["More than 50 app configs found; showing the first 50."]);
});

test("configs inside node_modules or deeper than 6 segments are ignored; nothing found fails unsupported_framework", async (t) => {
  const repo = withTempGitRepo(t, {
    files: {
      "package.json": `${JSON.stringify({ name: "plain" })}\n`,
      "a/b/c/d/e/f/angular.json": angularAppFiles(".")["angular.json"] ?? ""
    }
  });
  repo.write({
    "vendor/node_modules/x/vite.config.ts": "export default {};\n",
    "vendor/node_modules/x/package.json": `${JSON.stringify({ dependencies: { react: "1", vite: "1" } })}\n`
  });
  repo.git("add", "-f", "--", "vendor/node_modules/x"); // tracked despite .gitignore, still skipped
  const result = await service(t).discoverApps(repo.path);
  assert.deepEqual(result, {
    ok: false,
    failure: {
      status: 400,
      errorReason: "unsupported_framework",
      message: "No Angular workspace (angular.json) or Vite + React app was found in this repository."
    }
  });
});
