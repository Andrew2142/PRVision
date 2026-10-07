import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readAngularProject } from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-build-options";
import {
  ANGULAR_GENERATED_HEADER,
  AngularHarnessWorkspaceWriter,
  AngularTemplatesMissingError,
  assertAngularPathInside,
  assertAngularTemplatesPresent,
  buildFrameworkSource,
  buildHarnessIndexHtml,
  buildHarnessTsconfig,
  buildRegistrySource,
  effectiveDtsIncludes,
  resolveAngularLayout,
  rewriteAngularTargetSpecifier,
  toAngularHarnessFileSource
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-harness-workspace";
import { makeTempDir } from "../../helpers/temp-dir";

const APP_INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Tenant Portal</title>
  <base href="/app/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="assets/env.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Poppins" rel="stylesheet">
  <style>.app-loading { display: flex; }</style>
</head>
<body>
  <app-root><div class="app-loading">Loading…</div></app-root>
</body>
</html>`;

function tempDir(t: TestContext): string {
  const temp = makeTempDir("angular-ws");
  t.after(() => {
    temp.cleanup();
  });
  return temp.path;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("buildHarnessIndexHtml keeps the app head, replaces the title and base, and renders only <prvision-root>", () => {
  const html = buildHarnessIndexHtml(APP_INDEX);
  assert.ok(html.includes("<title>PRVision harness</title>"));
  assert.ok(!html.includes("Tenant Portal"));
  assert.ok(!html.includes('<base href="/app/">'));
  assert.equal(html.match(/<base /g)?.length, 1);
  assert.ok(html.indexOf('<meta charset="utf-8">') < html.indexOf('<base href="/">'), "base follows the charset meta");
  assert.ok(html.includes('<script src="assets/env.js"></script>'));
  assert.ok(html.includes("fonts.googleapis.com"));
  assert.ok(html.includes(".app-loading { display: flex; }"));
  assert.ok(html.includes('<style id="prvision-base-style">'));
  assert.ok(html.includes("#prvision-root { display: flow-root;"));
  assert.match(html, /<body>\s*<prvision-root id="prvision-root"><\/prvision-root>\s*<\/body>/);
  assert.ok(!html.includes("app-root"));
});

test("buildHarnessIndexHtml without an app index uses a minimal head", () => {
  const html = buildHarnessIndexHtml(null);
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes('<meta name="viewport"'));
  assert.ok(html.includes('<base href="/">'));
  assert.ok(html.includes("<title>PRVision harness</title>"));
  assert.ok(html.includes('<prvision-root id="prvision-root"></prvision-root>'));
});

test("effectiveDtsIncludes follows a two-level extends chain and rebases the nearest include's .d.ts entries", async (t) => {
  const root = tempDir(t);
  write(path.join(root, "tsconfig.base.json"), `{ "include": ["types/**/*.d.ts", "src/**/*.ts"] }`);
  write(
    path.join(root, "app", "tsconfig.json"),
    `{ /* jsonc */ "extends": "../tsconfig.base.json", "compilerOptions": {} }`
  );
  write(path.join(root, "app", "tsconfig.app.json"), `{ "extends": "./tsconfig.json", "files": ["src/main.ts"], }`);
  const includes = await effectiveDtsIncludes(path.join(root, "app", "tsconfig.app.json"));
  assert.deepEqual(includes, [path.join(root, "types/**/*.d.ts")]);
  write(path.join(root, "app", "tsconfig.app.json"), `{ "extends": "./tsconfig.json", "include": ["src/**/*.d.ts"] }`);
  assert.deepEqual(await effectiveDtsIncludes(path.join(root, "app", "tsconfig.app.json")), [
    path.join(root, "app", "src/**/*.d.ts")
  ]);
  const harnessDir = path.join(root, "app", ".prvision-harness");
  const tsconfig = JSON.parse(
    buildHarnessTsconfig(harnessDir, path.join(root, "app", "tsconfig.app.json"), [path.join(root, "types/**/*.d.ts")])
  ) as Record<string, unknown>;
  assert.deepEqual(tsconfig, {
    extends: "../tsconfig.app.json",
    compilerOptions: { outDir: "./out-tsc", noUnusedLocals: false, noUnusedParameters: false },
    files: ["./main.ts"],
    include: ["../../types/**/*.d.ts"]
  });
});

test("buildFrameworkSource: zone, zoneless (≥ 20, 18–19) and the Angular 17 compat output", () => {
  const zone = buildFrameworkSource({ zone: true, angularMajor: 21, animations: true });
  assert.ok(zone.source.includes("provideZoneChangeDetection(),"));
  assert.ok(zone.source.includes("provideNoopAnimations(),"));
  assert.ok(zone.source.includes("appRef.whenStable()"));
  assert.equal(zone.warning, null);
  const zoneless = buildFrameworkSource({ zone: false, angularMajor: 20, animations: false });
  assert.ok(zoneless.source.includes("provideZonelessChangeDetection(),"));
  assert.ok(!zoneless.source.includes("provideNoopAnimations"));
  const experimental = buildFrameworkSource({ zone: false, angularMajor: 18, animations: false });
  assert.ok(experimental.source.includes("provideExperimentalZonelessChangeDetection(),"));
  assert.ok(experimental.source.includes("appRef.whenStable()"));
  const v17 = buildFrameworkSource({ zone: false, angularMajor: 17, animations: true });
  assert.ok(v17.source.includes("provideZoneChangeDetection(),"));
  assert.match(v17.warning ?? "", /Angular 18/);
  assert.ok(v17.source.includes("firstValueFrom(appRef.isStable.pipe(filter(Boolean)))"));
  assert.ok(v17.source.includes("import { firstValueFrom } from 'rxjs';"));
  const unknown = buildFrameworkSource({ zone: true, angularMajor: null, animations: false });
  assert.ok(unknown.source.includes("appRef.whenStable()"));
});

test("buildRegistrySource lists only the build's items; harness files get the @ts-nocheck header", () => {
  const source = buildRegistrySource([12, 3]);
  assert.ok(source.includes("export const HARNESS_LOADERS"));
  assert.ok(
    source.indexOf("'3': () => import('./components/3')") < source.indexOf("'12': () => import('./components/12')")
  );
  assert.ok(!buildRegistrySource([]).includes("import("));
  const file = toAngularHarnessFileSource("export default 1;");
  assert.ok(file.startsWith("// @ts-nocheck\n// Generated by PRVision for this render run. Do not edit.\n"));
  assert.equal(file, `${ANGULAR_GENERATED_HEADER}export default 1;\n`);
});

test("resolveAngularLayout and the containment guard refuse app roots and files outside the worktree", () => {
  const layout = resolveAngularLayout("head", "/data/worktrees/1/head", "src/tenant-frontend");
  assert.equal(layout.workspaceRoot, "/data/worktrees/1/head/src/tenant-frontend");
  assert.equal(layout.harnessDir, "/data/worktrees/1/head/src/tenant-frontend/.prvision-harness");
  assert.equal(layout.componentsDir, `${layout.harnessDir}/components`);
  assert.equal(layout.mocksDir, `${layout.harnessDir}/mocks`);
  assert.equal(layout.distDir, `${layout.harnessDir}/dist`);
  assert.equal(resolveAngularLayout("base", "/w", ".").workspaceRoot, "/w");
  assert.throws(() => resolveAngularLayout("head", "/w", "../escape"), /Path escapes worktree/);
  assert.throws(() => assertAngularPathInside("/w", "/w/../x"), /Path escapes worktree/);
  assertAngularPathInside("/w", "/w");
});

test("rewriteAngularTargetSpecifier replaces exactly one import specifier (decorators allowed)", () => {
  const source = `import { Component } from '@angular/core';\nimport { A } from '../../src/app/new/a.component';\n@Component({ selector: 'prvision-host', template: '' })\nclass Host {}\nexport default 1;\n`;
  const rewritten = rewriteAngularTargetSpecifier(
    source,
    "../../src/app/new/a.component",
    "../../src/app/old/a.component"
  );
  assert.ok(rewritten.includes("from '../../src/app/old/a.component'"));
  assert.throws(() => rewriteAngularTargetSpecifier(source, "../missing", "x"), /exactly once/);
});

test("AngularHarnessWorkspaceWriter.prepareSide writes templates, index, tsconfig, framework and an empty registry", async (t) => {
  const root = tempDir(t);
  const templates = path.join(root, "templates");
  for (const file of ["main.ts", "harness-api.ts", "http-backend.ts"]) {
    write(path.join(templates, file), `// ${file}\n`);
  }
  write(path.join(root, "shared", "prvision-steps.ts"), "// prvision-steps.ts\n");
  const worktree = path.join(root, "worktree");
  const app = path.join(worktree, "apps", "web");
  write(path.join(app, "src", "index.html"), APP_INDEX);
  write(path.join(app, "tsconfig.json"), `{ "include": ["src/**/*.d.ts"] }`);
  write(path.join(app, "tsconfig.app.json"), `{ "extends": "./tsconfig.json", "files": ["src/main.ts"] }`);
  write(
    path.join(app, "node_modules", "@angular", "core", "package.json"),
    `{ "name": "@angular/core", "version": "19.2.0" }`
  );
  const project = readAngularProject(
    JSON.stringify({
      projects: {
        web: {
          root: "",
          architect: {
            build: {
              builder: "@angular/build:application",
              options: { browser: "src/main.ts", index: "src/index.html", tsConfig: "tsconfig.app.json", polyfills: [] }
            }
          }
        }
      }
    }),
    "web"
  );
  const layout = resolveAngularLayout("head", worktree, "apps/web");
  const writer = new AngularHarnessWorkspaceWriter(templates);
  const prepared = await writer.prepareSide(layout, project, null);
  assert.deepEqual(prepared.warnings, []);
  assert.equal(prepared.angularMajor, 19);
  assert.equal(prepared.zone, false);
  assert.equal(prepared.animations, false);
  assert.deepEqual(prepared.tsconfigFiles, ["tsconfig.app.json", "tsconfig.json"]);
  for (const file of [
    "main.ts",
    "harness-api.ts",
    "http-backend.ts",
    "prvision-steps.ts",
    "index.html",
    "tsconfig.json",
    "framework.generated.ts",
    "registry.generated.ts"
  ]) {
    assert.ok(fs.existsSync(path.join(layout.harnessDir, file)), file);
  }
  assert.equal(fs.readFileSync(path.join(layout.harnessDir, ".gitignore"), "utf8"), "*\n");
  assert.ok(
    fs
      .readFileSync(path.join(layout.harnessDir, "framework.generated.ts"), "utf8")
      .includes("provideExperimentalZonelessChangeDetection")
  );
  const tsconfig = JSON.parse(fs.readFileSync(path.join(layout.harnessDir, "tsconfig.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(tsconfig.extends, "../tsconfig.app.json");
  assert.deepEqual(tsconfig.include, ["../src/**/*.d.ts"]);
  await writer.writeComponentHarness(layout, 7, "export default 7;");
  await writer.writeMock(layout, "0123456789abcdef", "export const x = 1;");
  await writer.writeRegistry(layout, [7]);
  assert.ok(fs.readFileSync(path.join(layout.componentsDir, "7.ts"), "utf8").startsWith("// @ts-nocheck"));
  assert.ok(fs.readFileSync(path.join(layout.mocksDir, "0123456789abcdef.ts"), "utf8").startsWith("// @ts-nocheck"));
  assert.ok(fs.readFileSync(path.join(layout.harnessDir, "registry.generated.ts"), "utf8").includes("'7'"));
  await assert.rejects(writer.writeComponentHarness(layout, 0, "x"), /Invalid component id/);
  await assert.rejects(writer.writeMock(layout, "../../x", "x"), /Invalid mock hash/);
  // Nothing outside the harness folder was written.
  assert.deepEqual(fs.readdirSync(app).sort(), [
    ".prvision-harness",
    "node_modules",
    "src",
    "tsconfig.app.json",
    "tsconfig.json"
  ]);
});

test("AngularHarnessWorkspaceWriter.prepareSide warns when the index is missing; missing templates are reported", async (t) => {
  const root = tempDir(t);
  const templates = path.join(root, "templates");
  await assert.rejects(assertAngularTemplatesPresent(templates), AngularTemplatesMissingError);
  for (const file of ["main.ts", "harness-api.ts", "http-backend.ts"]) {
    write(path.join(templates, file), "\n");
  }
  // 16 §7.5: the shared step runtime (<templates>/../shared) is required too.
  await assert.rejects(assertAngularTemplatesPresent(templates), AngularTemplatesMissingError);
  write(path.join(root, "shared", "prvision-steps.ts"), "\n");
  await assertAngularTemplatesPresent(templates);
  const worktree = path.join(root, "wt");
  write(path.join(worktree, "tsconfig.app.json"), "{}");
  const project = readAngularProject(
    JSON.stringify({
      projects: {
        app: {
          root: "",
          architect: {
            build: {
              builder: "@angular/build:application",
              options: { index: "src/missing.html", tsConfig: "tsconfig.app.json", polyfills: ["zone.js"] }
            }
          }
        }
      }
    }),
    "app"
  );
  const layout = resolveAngularLayout("base", worktree, ".");
  const prepared = await new AngularHarnessWorkspaceWriter(templates).prepareSide(layout, project, null);
  assert.equal(prepared.warnings.length, 1);
  assert.match(prepared.warnings[0] ?? "", /index\.html could not be read on the base side/);
  assert.equal(prepared.zone, true);
  assert.ok(fs.readFileSync(path.join(layout.harnessDir, "index.html"), "utf8").includes('<meta charset="utf-8">'));
});
