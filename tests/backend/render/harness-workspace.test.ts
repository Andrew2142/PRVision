import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  HARNESS_JSX_PRAGMA,
  HarnessTemplatesMissingError,
  HarnessWorkspaceWriter,
  assertInside,
  assertTemplatesPresent,
  buildGlobalsSource,
  resolveSideLayout,
  rewriteTargetSpecifier,
  scanReferencedEnvKeys,
  toHarnessFileSource
} from "../../../backend/src/services/visualizations/pipeline/render/harness-workspace";
import { HARNESS_TEMPLATES_DIR } from "../../../backend/src/config-consts/render.config";
import { makeTempDir } from "../helpers/temp-dir";
import { writeFakeTemplates } from "./helpers/render-stubs";

function tempDir(t: TestContext, label = "workspace"): string {
  const temp = makeTempDir(label);
  t.after(() => {
    temp.cleanup();
  });
  return temp.path;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("prepareSide copies templates, writes .gitignore and globals.ts", async (t) => {
  const root = tempDir(t);
  const templates = path.join(root, "templates");
  writeFakeTemplates(templates);
  const worktree = path.join(root, "head");
  write(path.join(worktree, "src/index.css"), "body{}");
  const layout = resolveSideLayout("head", worktree, null);
  const writer = new HarnessWorkspaceWriter(templates);
  const { missingStyles } = await writer.prepareSide(layout, ["/src/index.css"]);
  assert.deepEqual(missingStyles, []);
  for (const file of ["index.html", "entry.tsx", "error-boundary.tsx"]) {
    assert.equal(fs.readFileSync(path.join(layout.harnessDir, file), "utf8"), `// ${file}\n`);
  }
  assert.equal(fs.readFileSync(path.join(layout.harnessDir, ".gitignore"), "utf8"), "*\n");
  assert.match(fs.readFileSync(path.join(layout.harnessDir, "globals.ts"), "utf8"), /import "\.\.\/src\/index\.css";/);
  assert.ok(fs.statSync(layout.componentsDir).isDirectory());
  // Overwrite on a second run.
  fs.writeFileSync(path.join(templates, "entry.tsx"), "// v2\n");
  await writer.prepareSide(layout, []);
  assert.equal(fs.readFileSync(path.join(layout.harnessDir, "entry.tsx"), "utf8"), "// v2\n");
});

test("globals.ts maps /src/… specifiers to POSIX relative imports and keeps bare package specifiers, in order", () => {
  const layout = resolveSideLayout("base", "/wt/base", null);
  const existing = new Set([
    "/wt/base/src/index.css",
    "/wt/base/src/styles/theme.scss",
    "/wt/base/node_modules/bootstrap/package.json",
    "/wt/base/node_modules/@fontsource/inter/package.json"
  ]);
  const { source, missing } = buildGlobalsSource(
    layout,
    ["/src/index.css", "bootstrap/dist/css/bootstrap.min.css", "/src/styles/theme.scss", "@fontsource/inter"],
    (file) => existing.has(file)
  );
  assert.deepEqual(missing, []);
  const imports = source.split("\n").filter((line) => line.startsWith("import "));
  assert.deepEqual(imports, [
    'import "../src/index.css";',
    'import "bootstrap/dist/css/bootstrap.min.css";',
    'import "../src/styles/theme.scss";',
    'import "@fontsource/inter";'
  ]);
  assert.match(source, /export \{\};/);
});

test("globals.ts comments out missing files and uninstalled packages and reports them", () => {
  const layout = resolveSideLayout("base", "/wt/base", null);
  const { source, missing } = buildGlobalsSource(
    layout,
    ["/src/old.css", "bootstrap/dist/css/bootstrap.css", "./relative.css"],
    () => false
  );
  assert.deepEqual(missing, ["/src/old.css", "bootstrap/dist/css/bootstrap.css", "./relative.css"]);
  assert.match(source, /\/\/ missing on the base side: \/src\/old\.css/);
  assert.match(source, /\/\/ package not installed: bootstrap\/dist\/css\/bootstrap\.css/);
  assert.doesNotMatch(source, /^import /m);
});

test("rewriteTargetSpecifier replaces exactly one import specifier and throws when it occurs zero or two times", () => {
  const source = [
    'import Button from "../../src/components/NewButton";',
    'import { helper } from "../../src/lib/helper";',
    'const label = "../../src/components/NewButton";',
    "export default function PRVisionHarness() { return <Button>{label}</Button>; }"
  ].join("\n");
  const rewritten = rewriteTargetSpecifier(source, "../../src/components/NewButton", "../../src/components/OldButton");
  assert.match(rewritten, /^import Button from "\.\.\/\.\.\/src\/components\/OldButton";/);
  assert.match(
    rewritten,
    /const label = "\.\.\/\.\.\/src\/components\/NewButton";/,
    "string literals outside imports untouched"
  );
  assert.throws(
    () => rewriteTargetSpecifier(source, "../../src/components/Missing", "x"),
    /target specifier not found exactly once/
  );
  const twice = `${source}\nexport { default as Again } from "../../src/components/NewButton";`;
  assert.throws(
    () => rewriteTargetSpecifier(twice, "../../src/components/NewButton", "x"),
    /target specifier not found exactly once/
  );
});

test("writeComponentHarness prepends the JSX pragma unless one exists", async (t) => {
  const root = tempDir(t);
  const layout = resolveSideLayout("head", root, null);
  const writer = new HarnessWorkspaceWriter(root);
  const file = await writer.writeComponentHarness(
    layout,
    12,
    "export default function PRVisionHarness() { return <div />; }"
  );
  assert.equal(file, path.join(layout.componentsDir, "12.tsx"));
  const written = fs.readFileSync(file, "utf8");
  assert.ok(written.startsWith(`${HARNESS_JSX_PRAGMA}\n// Generated by PRVision`));
  const withPragma = toHarnessFileSource(
    "/** @jsxImportSource @emotion/react */\nexport default function PRVisionHarness() { return null; }"
  );
  assert.ok(withPragma.startsWith("// Generated by PRVision"));
  assert.ok(!withPragma.includes(HARNESS_JSX_PRAGMA));
});

test("writeComponentHarness writes atomically and overwrites on repair", async (t) => {
  const root = tempDir(t);
  const layout = resolveSideLayout("head", root, null);
  const writer = new HarnessWorkspaceWriter(root);
  await writer.writeComponentHarness(layout, 3, "export default function PRVisionHarness() { return 1; }");
  await writer.writeComponentHarness(layout, 3, "export default function PRVisionHarness() { return 2; }");
  assert.match(fs.readFileSync(path.join(layout.componentsDir, "3.tsx"), "utf8"), /return 2;/);
  assert.deepEqual(fs.readdirSync(layout.componentsDir), ["3.tsx"], "no temp files left behind");
  await assert.rejects(writer.writeComponentHarness(layout, 0, "x"), /Invalid component id/);
});

test("assertInside rejects traversal in filePath, viteConfigPath and globalStylePaths", () => {
  assert.doesNotThrow(() => {
    assertInside("/wt/head", "/wt/head/src/A.tsx");
  });
  assert.doesNotThrow(() => {
    assertInside("/wt/head", "/wt/head");
  });
  assert.throws(() => {
    assertInside("/wt/head", path.join("/wt/head", "../../etc/passwd"));
  }, /Path escapes worktree/);
  assert.throws(() => resolveSideLayout("head", "/wt/head", "../outside/vite.config.ts"), /Path escapes worktree/);
  const layout = resolveSideLayout("head", "/wt/head", null);
  assert.throws(() => buildGlobalsSource(layout, ["/../../etc/passwd.css"], () => true), /Path escapes worktree/);
});

test("resolveSideLayout uses the config directory as viteRoot", () => {
  const nested = resolveSideLayout("base", "/wt/base", "apps/web/vite.config.ts");
  assert.equal(nested.viteRoot, "/wt/base/apps/web");
  assert.equal(nested.configFile, "/wt/base/apps/web/vite.config.ts");
  assert.equal(nested.harnessDir, "/wt/base/apps/web/.prvision-harness");
  assert.equal(nested.componentsDir, "/wt/base/apps/web/.prvision-harness/components");
  assert.equal(nested.cacheDir, "/wt/base/apps/web/.prvision-harness/.vite-cache");
  assert.equal(nested.harnessUrlPath, "/.prvision-harness/index.html");
  const flat = resolveSideLayout("head", "/wt/head", "vite.config.ts");
  assert.equal(flat.viteRoot, "/wt/head");
  assert.equal(resolveSideLayout("head", "/wt/head", null).configFile, null);
});

test("assertTemplatesPresent throws when a template file is missing", async (t) => {
  const root = tempDir(t);
  writeFakeTemplates(root);
  await assertTemplatesPresent(root);
  fs.rmSync(path.join(root, "error-boundary.tsx"));
  await assert.rejects(assertTemplatesPresent(root), (error: unknown) => {
    assert.ok(error instanceof HarnessTemplatesMissingError);
    assert.equal(
      error.message,
      "PRVision's harness templates are missing (backend/harness-templates). Reinstall PRVision."
    );
    return true;
  });
});

test("the real harness templates directory contains the three templates", async () => {
  await assertTemplatesPresent(HARNESS_TEMPLATES_DIR);
  const entry = fs.readFileSync(path.join(HARNESS_TEMPLATES_DIR, "entry.tsx"), "utf8");
  assert.match(entry, /^\/\*\* @jsxRuntime automatic \*\//);
  assert.match(entry, /window\.__PRVISION_READY__ = true/);
});

test("scanReferencedEnvKeys collects VITE_ keys and skips node_modules and the harness dir", async (t) => {
  const root = tempDir(t);
  const base = path.join(root, "base");
  const head = path.join(root, "head");
  write(
    path.join(base, "src/config.ts"),
    "export const api = import.meta.env.VITE_API_URL; const m = import.meta.env.MODE;"
  );
  write(path.join(head, "src/flags.tsx"), "if (import.meta.env.VITE_FLAG_NEW) {}\nimport.meta.env.VITE_API_URL;");
  write(path.join(head, "node_modules/lib/index.js"), "import.meta.env.VITE_FROM_DEPS");
  write(path.join(head, ".prvision-harness/components/1.tsx"), "import.meta.env.VITE_FROM_HARNESS");
  write(path.join(head, "dist/assets/app.js"), "import.meta.env.VITE_FROM_DIST");
  write(path.join(head, "src/readme.md"), "import.meta.env.VITE_FROM_MARKDOWN");
  assert.deepEqual(await scanReferencedEnvKeys([base, head]), ["VITE_API_URL", "VITE_FLAG_NEW"]);
});
