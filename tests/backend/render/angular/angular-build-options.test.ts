import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AngularWorkspaceError,
  buildHarnessBuildOptions,
  globalInputFiles,
  readAngularProject,
  STRIPPED_BUILD_OPTIONS,
  usesZone,
  type AngularHarnessTarget
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-build-options";

/** angular.json of the Acme shape (application builder), with comments and a trailing comma. */
const APPLICATION_JSON = `{
  // JSONC like the Angular CLI accepts
  "projects": {
    "tenant-frontend": {
      "projectType": "application",
      "root": "",
      "sourceRoot": "src",
      "architect": {
        "build": {
          "builder": "@angular/build:application",
          "options": {
            "browser": "src/main.ts",
            "outputPath": "dist/tenant-frontend",
            "index": "src/index.html",
            "polyfills": ["zone.js"],
            "tsConfig": "tsconfig.app.json",
            "assets": ["src/favicon.ico", { "glob": "**/*", "input": "public", "output": "/" }],
            "styles": ["node_modules/grapesjs/dist/css/grapes.min.css", "src/styles.css", { "input": "src/theme.scss", "inject": false }],
            "scripts": [],
            "server": "src/main.server.ts",
            "ssr": { "entry": "server.ts" },
            "prerender": true,
            "budgets": [{ "type": "initial", "maximumError": "1mb" }],
            "allowedCommonJsDependencies": ["leaflet"],
            "fileReplacements": [{ "replace": "src/environments/environment.ts", "with": "src/environments/environment.dev.ts" }]
          },
          "configurations": {
            "production": { "optimization": true, "outputHashing": "all" },
            "development": {
              "optimization": false,
              "sourceMap": true,
              "fileReplacements": [
                { "replace": "src/environments/environment.ts", "with": "src/environments/environment.local.ts" },
                { "replace": "src/app/api.config.ts", "with": "src/app/api.config.local.ts" }
              ],
            },
          },
        },
      },
    },
    "lib": { "projectType": "library", "root": "projects/lib", "architect": { "build": { "builder": "@angular/build:ng-packagr" } } }
  }
}`;

const BROWSER_ESBUILD_JSON = JSON.stringify({
  projects: {
    legacy: {
      root: "",
      targets: {
        build: {
          builder: "@angular-devkit/build-angular:browser-esbuild",
          options: {
            main: "src/main.ts",
            outputPath: "dist/legacy",
            index: { input: "src/index.html" },
            polyfills: "zone.js"
          }
        }
      }
    }
  }
});

function input(target: AngularHarnessTarget, overrides: Partial<Parameters<typeof buildHarnessBuildOptions>[0]> = {}) {
  return {
    target,
    configuration: "development",
    buildKey: "none",
    mockReplacements: [],
    cacheDir: "/data/cache/angular/7",
    ...overrides
  };
}

test("readAngularProject parses JSONC and returns the build target; architect and targets are both read", () => {
  const app = readAngularProject(APPLICATION_JSON, "tenant-frontend");
  assert.equal(app.build.builder, "@angular/build:application");
  assert.equal(app.build.options.browser, "src/main.ts");
  assert.deepEqual(Object.keys(app.build.configurations).sort(), ["development", "production"]);
  const legacy = readAngularProject(BROWSER_ESBUILD_JSON, "legacy");
  assert.equal(legacy.build.builder, "@angular-devkit/build-angular:browser-esbuild");
});

test("readAngularProject rejects a missing project, an unsupported builder and unparsable text", () => {
  assert.throws(() => readAngularProject(APPLICATION_JSON, "nope"), /Project nope not found in angular\.json/);
  assert.throws(() => readAngularProject(APPLICATION_JSON, "lib"), AngularWorkspaceError);
  assert.throws(() => readAngularProject("{ not json", "x"), AngularWorkspaceError);
});

test("buildHarnessBuildOptions (application builder): merges the configuration, deletes server options and points at the harness", () => {
  const target = readAngularProject(APPLICATION_JSON, "tenant-frontend").build;
  const built = buildHarnessBuildOptions(input(target));
  const options = built.options;
  assert.equal(built.builderName, "@angular/build:application");
  for (const key of STRIPPED_BUILD_OPTIONS) {
    assert.ok(!(key in options), key);
  }
  assert.equal(options.browser, ".prvision-harness/main.ts");
  assert.ok(!("main" in options));
  assert.equal(options.index, ".prvision-harness/index.html");
  assert.equal(options.tsConfig, ".prvision-harness/tsconfig.json");
  assert.deepEqual(options.outputPath, { base: ".prvision-harness/dist/none", browser: "" });
  assert.equal(options.baseHref, "/");
  assert.equal(options.outputHashing, "none");
  assert.equal(options.optimization, false);
  assert.equal(options.extractLicenses, false);
  assert.equal(options.namedChunks, true);
  assert.deepEqual(options.sourceMap, { scripts: true, styles: false, vendor: false, hidden: false });
  assert.equal(options.progress, false);
  assert.equal(options.deleteOutputPath, true);
  assert.equal(options.watch, false);
  assert.equal(options.aot, true);
  assert.equal(options.crossOrigin, "none");
  // Kept as configured.
  assert.deepEqual(options.polyfills, ["zone.js"]);
  assert.deepEqual(options.allowedCommonJsDependencies, ["leaflet"]);
  assert.equal((options.assets as unknown[]).length, 2);
  // The development configuration's fileReplacements replace the base ones (configuration merge).
  assert.deepEqual(options.fileReplacements, [
    { replace: "src/environments/environment.ts", with: "src/environments/environment.local.ts" },
    { replace: "src/app/api.config.ts", with: "src/app/api.config.local.ts" }
  ]);
  assert.deepEqual(built.projectExtensions, {
    projectType: "application",
    cli: { cache: { enabled: true, environment: "all", path: "/data/cache/angular/7" } }
  });
  // The target itself is not mutated.
  assert.equal(target.options.browser, "src/main.ts");
  assert.ok("server" in target.options);
});

test("buildHarnessBuildOptions without a configuration uses the base options only", () => {
  const target = readAngularProject(APPLICATION_JSON, "tenant-frontend").build;
  const options = buildHarnessBuildOptions(input(target, { configuration: null, buildKey: "abc-r1" })).options;
  assert.deepEqual(options.outputPath, { base: ".prvision-harness/dist/abc-r1", browser: "" });
  assert.deepEqual(options.fileReplacements, [
    { replace: "src/environments/environment.ts", with: "src/environments/environment.dev.ts" }
  ]);
});

test("buildHarnessBuildOptions: mocks override configured fileReplacements of the same file and are appended", () => {
  const target = readAngularProject(APPLICATION_JSON, "tenant-frontend").build;
  const options = buildHarnessBuildOptions(
    input(target, {
      mockReplacements: [
        { replace: "./src/app/api.config.ts", with: ".prvision-harness/mocks/0123456789abcdef.ts" },
        { replace: "src/app/clock.ts", with: ".prvision-harness/mocks/fedcba9876543210.ts" }
      ]
    })
  ).options;
  assert.deepEqual(options.fileReplacements, [
    { replace: "src/environments/environment.ts", with: "src/environments/environment.local.ts" },
    { replace: "./src/app/api.config.ts", with: ".prvision-harness/mocks/0123456789abcdef.ts" },
    { replace: "src/app/clock.ts", with: ".prvision-harness/mocks/fedcba9876543210.ts" }
  ]);
});

test("buildHarnessBuildOptions (browser-esbuild): string outputPath and `main`", () => {
  const target = readAngularProject(BROWSER_ESBUILD_JSON, "legacy").build;
  const options = buildHarnessBuildOptions(input(target, { configuration: null })).options;
  assert.equal(options.main, ".prvision-harness/main.ts");
  assert.ok(!("browser" in options));
  assert.equal(options.outputPath, ".prvision-harness/dist/none");
  assert.equal(options.index, ".prvision-harness/index.html");
  assert.equal(options.polyfills, "zone.js");
  assert.ok(!("fileReplacements" in options));
});

test("usesZone and globalInputFiles read polyfills and styles", () => {
  const target = readAngularProject(APPLICATION_JSON, "tenant-frontend").build;
  assert.equal(usesZone(target.options), true);
  assert.equal(usesZone({ polyfills: ["zone.js/testing"] }), true);
  assert.equal(usesZone({ polyfills: [] }), false);
  assert.equal(usesZone({}), false);
  assert.deepEqual(globalInputFiles({ ...target.options, polyfills: ["zone.js", "src/polyfills.ts"] }), [
    "node_modules/grapesjs/dist/css/grapes.min.css",
    "src/styles.css",
    "src/theme.scss",
    "src/polyfills.ts"
  ]);
});
