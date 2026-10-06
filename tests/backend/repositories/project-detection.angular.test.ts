/**
 * Angular detection (15 §5.4.4) on throw-away folders with the in-memory git fake (discovery walks the folder like
 * `git ls-files`). Nothing is installed: node_modules/<pkg>/package.json stubs carry the versions.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  ProjectDetectionService,
  type AppSelection,
  type DetectedProject,
  type DetectionFailure,
  type DetectionResult
} from "../../../backend/src/services/repositories/project-detection-service";
import type { FileMap } from "../helpers/temp-git-repo";
import {
  ANGULAR_21_INSTALL,
  angularAppFiles,
  installedPackages,
  type AngularProjectSpec
} from "./helpers/angular-fixture";
import { createDetectionFixture, fakeGit } from "./helpers/detection-fixture";

const APP = "src/app";
const ROOT_PACKAGE = { name: "mono", private: true };

async function tempDataDir(t: TestContext): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-detect-data-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A monorepo folder with one Angular workspace at src/app (plus `files`); nothing installed unless given. */
async function monorepo(t: TestContext, files: FileMap): Promise<string> {
  const created = await createDetectionFixture({ packageJson: ROOT_PACKAGE, files, noNodeModules: true });
  t.after(() => created.cleanup());
  return created.root;
}

async function detect(
  t: TestContext,
  root: string,
  selection?: AppSelection,
  toplevel: string | null = null
): Promise<DetectionResult> {
  const service = new ProjectDetectionService({ git: fakeGit({ toplevel }), dataDir: await tempDataDir(t) });
  return service.detect(root, selection);
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
  assert.equal(result.failure.errorReason, errorReason, result.failure.message);
  return result.failure.message;
}

function app(options: { projects?: AngularProjectSpec[]; extra?: FileMap } = {}): FileMap {
  return angularAppFiles(APP, options);
}

const INSTALLED_IN_APP = installedPackages(`${APP}/node_modules`, ANGULAR_21_INSTALL);

test("detects the fields of an Angular application project in a sub-folder", async (t) => {
  const root = await monorepo(t, {
    ...app({
      projects: [
        {
          name: "app",
          options: {
            browser: "src/main.ts",
            tsConfig: "tsconfig.app.json",
            polyfills: ["zone.js"],
            styles: ["node_modules/some-lib/dist/lib.css", "src/styles.css", { input: "src/lazy.css", inject: false }]
          }
        }
      ]
    }),
    ...INSTALLED_IN_APP
  });
  const project = expectProject(await detect(t, root, { appRoot: APP }));
  assert.deepEqual(
    { ...project, warnings: [] },
    {
      rootPath: root,
      suggestedName: `${path.basename(root)} · app`,
      githubOwner: null,
      githubRepo: null,
      githubRemoteName: null,
      defaultBranch: "main",
      framework: "angular",
      packageManager: "npm",
      appRoot: APP,
      angularProject: "app",
      angularBuildConfiguration: "development",
      viteConfigPath: null,
      tsconfigPath: `${APP}/tsconfig.app.json`,
      entryFilePath: `${APP}/src/main.ts`,
      globalStylePaths: ["some-lib/dist/lib.css", `/${APP}/src/styles.css`],
      warnings: []
    }
  );
  assert.deepEqual(project.warnings, []);
});

test("a single Angular app is chosen without a selection, and a sub-folder input is its hint", async (t) => {
  const root = await monorepo(t, { ...app(), ...INSTALLED_IN_APP });
  assert.equal(expectProject(await detect(t, root)).appRoot, APP);
  const fromSubFolder = expectProject(await detect(t, path.join(root, APP), undefined, root));
  assert.equal(fromSubFolder.rootPath, root);
  assert.equal(fromSubFolder.appRoot, APP);
});

test("hoisted node_modules at the repository root is accepted", async (t) => {
  const root = await monorepo(t, { ...app(), ...installedPackages("node_modules", ANGULAR_21_INSTALL) });
  assert.equal(expectProject(await detect(t, root, { appRoot: APP })).angularProject, "app");
});

test("missing node_modules, a missing builder package and a missing architect fail missing_node_modules", async (t) => {
  const none = await monorepo(t, app());
  assert.equal(
    expectFailure(await detect(t, none, { appRoot: APP }), "missing_node_modules"),
    `node_modules not found for ${APP}. Run \`npm install\` in ${APP} first.`
  );

  const noBuilder = await monorepo(t, {
    ...app(),
    ...installedPackages(`${APP}/node_modules`, {
      "@angular/core": "21.2.0",
      "@angular-devkit/architect": "0.2102.0"
    })
  });
  assert.equal(
    expectFailure(await detect(t, noBuilder, { appRoot: APP }), "missing_node_modules"),
    `@angular/build is not installed. Run \`npm install\` in ${APP}.`
  );

  const noArchitect = await monorepo(t, {
    ...app(),
    ...installedPackages(`${APP}/node_modules`, { "@angular/core": "21.2.0", "@angular/build": "21.2.0" })
  });
  assert.equal(
    expectFailure(await detect(t, noArchitect, { appRoot: APP }), "missing_node_modules"),
    `@angular-devkit/architect is not installed. Run \`npm install\` in ${APP}.`
  );

  const nestedArchitect = await monorepo(t, {
    ...app(),
    ...installedPackages(`${APP}/node_modules`, { "@angular/core": "21.2.0", "@angular/build": "21.2.0" }),
    ...installedPackages(`${APP}/node_modules/@angular/build/node_modules`, { "@angular-devkit/architect": "0.2102.0" })
  });
  assert.equal(expectProject(await detect(t, nestedArchitect, { appRoot: APP })).angularProject, "app");
});

test("@angular/core must be declared by the app or the root package.json", async (t) => {
  const root = await monorepo(t, {
    ...app(),
    [`${APP}/package.json`]: `${JSON.stringify({ name: "app" })}\n`,
    ...INSTALLED_IN_APP
  });
  assert.equal(
    expectFailure(await detect(t, root, { appRoot: APP }), "unsupported_framework"),
    `@angular/core is not a dependency of ${APP}/package.json`
  );
});

test("Angular 16 is unsupported; Angular 22 warns", async (t) => {
  const old = await monorepo(t, {
    ...app(),
    ...installedPackages(`${APP}/node_modules`, { ...ANGULAR_21_INSTALL, "@angular/core": "16.2.12" })
  });
  assert.equal(
    expectFailure(await detect(t, old, { appRoot: APP }), "unsupported_framework"),
    "Angular 16.2.12 is not supported (need 17 or newer)"
  );

  const next = await monorepo(t, {
    ...app(),
    ...installedPackages(`${APP}/node_modules`, { ...ANGULAR_21_INSTALL, "@angular/core": "22.0.0" })
  });
  assert.ok(
    expectProject(await detect(t, next, { appRoot: APP })).warnings.includes(
      "Angular 22.0.0 is newer than the tested range (17–21)"
    )
  );
});

test("warns about postcss.config.js, notes zoneless apps and Tailwind, and a missing development configuration", async (t) => {
  const root = await monorepo(t, {
    ...app({
      projects: [
        {
          name: "app",
          options: { browser: "src/main.ts", tsConfig: "tsconfig.app.json", polyfills: [] },
          configurations: { production: {} }
        }
      ],
      extra: { "postcss.config.js": "module.exports = {};\n", "tailwind.config.js": "module.exports = {};\n" }
    }),
    ...installedPackages(`${APP}/node_modules`, { ...ANGULAR_21_INSTALL, tailwindcss: "3.4.17" })
  });
  const project = expectProject(await detect(t, root, { appRoot: APP }));
  assert.equal(project.angularBuildConfiguration, null);
  assert.deepEqual(project.warnings, [
    "No development configuration; building with the target's base options (optimisation may be on and builds slower).",
    "Zoneless app",
    "Tailwind 3 detected",
    "The Angular builder ignores postcss.config.js; it uses its built-in Tailwind integration or postcss.config.json."
  ]);
});

test("redetect with a removed project fails unsupported_framework; an unknown app root fails validation", async (t) => {
  const root = await monorepo(t, { ...app(), ...INSTALLED_IN_APP });
  assert.equal(
    expectFailure(await detect(t, root, { appRoot: APP, angularProject: "gone" }), "unsupported_framework"),
    `Project gone no longer exists in ${APP}/angular.json`
  );
  assert.equal(
    expectFailure(await detect(t, root, { appRoot: "src/other" }), "validation_failed"),
    "No app found at src/other"
  );
  assert.equal(
    expectFailure(await detect(t, root, { appRoot: "../escape" }), "validation_failed"),
    "No app found at ../escape"
  );
});

test("several projects in one workspace need angularProject; the webpack builder fails unsupported_framework", async (t) => {
  const root = await monorepo(t, {
    ...app({
      projects: [
        { name: "admin" },
        { name: "shop" },
        { name: "legacy", builder: "@angular-devkit/build-angular:browser" },
        { name: "ui", projectType: "library" }
      ]
    }),
    ...INSTALLED_IN_APP
  });
  assert.match(
    expectFailure(await detect(t, root, { appRoot: APP }), "validation_failed"),
    /^src\/app contains 3 apps\. Choose one: /
  );
  assert.equal(expectProject(await detect(t, root, { appRoot: APP, angularProject: "shop" })).angularProject, "shop");
  assert.match(
    expectFailure(await detect(t, root, { appRoot: APP, angularProject: "legacy" }), "unsupported_framework"),
    /webpack builder/
  );
});

test("a React selection at the root still runs 06 detection unchanged", async (t) => {
  const root = await monorepo(t, { ...app(), ...INSTALLED_IN_APP });
  assert.equal(
    expectFailure(await detect(t, root, { appRoot: "." }), "unsupported_framework"),
    "React and react-dom must be dependencies of the root package.json"
  );
});
