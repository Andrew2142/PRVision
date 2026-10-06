import assert from "node:assert/strict";
import test from "node:test";
import {
  builderPackageOf,
  classifyBuilder,
  joinRepoPath,
  listApplicationProjects,
  parseAngularWorkspace,
  resolveBuildPaths,
  resolveGlobalStyles,
  usesZoneJs,
  type AngularWorkspaceProject
} from "../../../backend/src/services/repositories/angular-workspace-reader";

function parsed(text: string): AngularWorkspaceProject[] {
  const result = parseAngularWorkspace(text);
  if (!result.ok) {
    assert.fail(`expected a parsed workspace, got: ${result.reason}`);
  }
  return result.projects;
}

const JSONC_WORKSPACE = `{
  // comments are allowed, like the Angular CLI
  "version": 1,
  "projects": {
    "shop": {
      "projectType": "application",
      "root": "",
      "architect": {
        "build": {
          "builder": "@angular/build:application",
          "options": { "browser": "src/main.ts", "tsConfig": "tsconfig.app.json", },
          "configurations": { "development": { "optimization": false }, },
        },
      },
    },
    /* a library is not an app */
    "ui-kit": { "projectType": "library", "root": "projects/ui-kit", "architect": {} },
    "nx-app": {
      "projectType": "application",
      "targets": { "build": { "builder": "@angular-devkit/build-angular:application", "options": { "main": "src/main.ts" } } }
    },
  },
}`;

test("parses angular.json with comments and trailing commas", () => {
  const projects = parsed(JSONC_WORKSPACE);
  assert.deepEqual(
    projects.map((project) => [project.name, project.projectType]),
    [
      ["shop", "application"],
      ["ui-kit", "library"],
      ["nx-app", "application"]
    ]
  );
  const shop = projects[0];
  assert.ok(shop?.buildTarget);
  assert.equal(shop.buildTarget.builder, "@angular/build:application");
  assert.deepEqual(shop.buildTarget.options, { browser: "src/main.ts", tsConfig: "tsconfig.app.json" });
  assert.deepEqual(Object.keys(shop.buildTarget.configurations), ["development"]);
});

test("lists application projects only, reading architect and Nx-style targets", () => {
  const apps = listApplicationProjects(parsed(JSONC_WORKSPACE));
  assert.deepEqual(
    apps.map((project) => project.name),
    ["shop", "nx-app"]
  );
  assert.equal(apps[1]?.buildTarget?.builder, "@angular-devkit/build-angular:application");
});

test("reports unparsable text and a missing projects object", () => {
  const broken = parseAngularWorkspace("{ not json");
  assert.equal(broken.ok, false);
  const noProjects = parseAngularWorkspace('{ "version": 1 }');
  assert.deepEqual(noProjects, { ok: false, reason: 'no "projects" object' });
  assert.deepEqual(parseAngularWorkspace("[]"), { ok: false, reason: "the file is not a JSON object" });
});

test("supported builders, the webpack builder, other builders and a missing build target", () => {
  const target = (builder: string | null) => ({ builder, options: {}, configurations: {} });
  for (const builder of [
    "@angular/build:application",
    "@angular-devkit/build-angular:application",
    "@angular-devkit/build-angular:browser-esbuild"
  ]) {
    assert.deepEqual(classifyBuilder(target(builder)), { supported: true }, builder);
  }
  const webpack = classifyBuilder(target("@angular-devkit/build-angular:browser"));
  assert.ok(!webpack.supported);
  assert.match(webpack.reason, /webpack builder.*ng update @angular\/cli --name use-application-builder/);
  assert.deepEqual(classifyBuilder(target("@nx/webpack:webpack")), {
    supported: false,
    reason: "Build target uses @nx/webpack:webpack, which PRVision does not support."
  });
  assert.deepEqual(classifyBuilder(null), {
    supported: false,
    reason: "The project has no build target, which PRVision needs."
  });
  assert.equal(builderPackageOf("@angular/build:application"), "@angular/build");
  assert.equal(builderPackageOf("@angular-devkit/build-angular:browser-esbuild"), "@angular-devkit/build-angular");
});

test("styles: strings and objects, inject:false skipped, node_modules paths become bare specifiers", () => {
  assert.deepEqual(
    resolveGlobalStyles("src/tenant-frontend", [
      "node_modules/grapesjs/dist/css/grapes.min.css",
      "src/styles.css",
      { input: "src/theme.scss", bundleName: "theme" },
      { input: "src/lazy.css", inject: false },
      "./src/extra.css",
      "../../../outside.css",
      42
    ]),
    [
      "grapesjs/dist/css/grapes.min.css",
      "/src/tenant-frontend/src/styles.css",
      "/src/tenant-frontend/src/theme.scss",
      "/src/tenant-frontend/src/extra.css"
    ]
  );
  assert.deepEqual(resolveGlobalStyles(".", ["src/styles.css"]), ["/src/styles.css"]);
  assert.deepEqual(resolveGlobalStyles(".", undefined), []);
});

test("build paths resolve against the workspace folder; browser wins over main", () => {
  assert.deepEqual(
    resolveBuildPaths("src/tenant-frontend", {
      tsConfig: "tsconfig.app.json",
      browser: "src/main.ts",
      main: "src/old-main.ts",
      styles: ["src/styles.css"]
    }),
    {
      tsconfigPath: "src/tenant-frontend/tsconfig.app.json",
      entryFilePath: "src/tenant-frontend/src/main.ts",
      globalStylePaths: ["/src/tenant-frontend/src/styles.css"]
    }
  );
  assert.deepEqual(resolveBuildPaths(".", { main: "src/main.ts" }), {
    tsconfigPath: null,
    entryFilePath: "src/main.ts",
    globalStylePaths: []
  });
  assert.equal(joinRepoPath("apps/a", "../../../escape.ts"), null);
});

test("zone.js detection accepts a string or an array of polyfills", () => {
  assert.equal(usesZoneJs({ polyfills: ["zone.js"] }), true);
  assert.equal(usesZoneJs({ polyfills: "zone.js" }), true);
  assert.equal(usesZoneJs({ polyfills: ["zone.js/testing"] }), true);
  assert.equal(usesZoneJs({ polyfills: [] }), false);
  assert.equal(usesZoneJs({}), false);
});
