import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import {
  ViteLoadError,
  loadTargetVite,
  resolveExportTarget
} from "../../../backend/src/services/visualizations/pipeline/render/vite-loader";
import { resolveWatchOption } from "../../../backend/src/services/visualizations/pipeline/render/vite-server-config";
import { makeTempDir } from "../helpers/temp-dir";
import { writeFakeVitePackage, type FakeViteOptions } from "./helpers/fake-vite-package";

function fakeRoot(t: TestContext, options?: FakeViteOptions): string {
  const temp = makeTempDir("vite-loader");
  t.after(() => {
    temp.cleanup();
  });
  if (options !== undefined) {
    writeFakeVitePackage(temp.path, options);
  }
  return temp.path;
}

async function rejectsWithKind(promise: Promise<unknown>, kind: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ViteLoadError, "ViteLoadError");
    assert.equal(error.kind, kind);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return true;
  });
}

for (const [shape, label] of [
  [4, "the Vite 4 exports shape"],
  [5, "the Vite 5 nested-conditions shape"],
  [6, "the Vite 6 module-sync shape"],
  [7, "the Vite 7 string export"]
] as const) {
  test(`loads the ESM entry for ${label}`, async (t) => {
    const root = fakeRoot(t, { shape });
    const loaded = await loadTargetVite(root);
    assert.equal(loaded.major, shape);
    assert.equal(loaded.minor, 1);
    assert.equal(loaded.version, `${String(shape)}.1.0`);
    assert.equal(loaded.entryPath, path.join(fs.realpathSync(root), "node_modules/vite/dist/node/index.js"));
    assert.equal(typeof loaded.module.createServer, "function");
    assert.equal(loaded.warning, null);
  });
}

test("uses the default export when the namespace wraps the API", async (t) => {
  const root = fakeRoot(t, { shape: 7, defaultOnly: true });
  const loaded = await loadTargetVite(root);
  assert.equal(typeof loaded.module.createServer, "function");
  assert.equal(typeof loaded.module.mergeConfig, "function");
});

test("reports vite_not_found when Vite is not installed", async (t) => {
  const root = fakeRoot(t);
  await rejectsWithKind(loadTargetVite(root), "vite_not_found", /Vite is not installed for this repository/);
});

test("reports vite_unsupported for Vite 3", async (t) => {
  const root = fakeRoot(t, { shape: 4, version: "3.2.7" });
  await rejectsWithKind(
    loadTargetVite(root),
    "vite_unsupported",
    /Vite 3\.2\.7 is not supported\. PRVision supports Vite 4 to 7\./
  );
});

test("reports vite_unsupported when createServer is missing", async (t) => {
  const root = fakeRoot(t, { shape: 7, omitCreateServer: true });
  await rejectsWithKind(loadTargetVite(root), "vite_unsupported", /does not export createServer/);
});

test("reports vite_load_failed with Node version and engines when import throws", async (t) => {
  const root = fakeRoot(t, { shape: 7, version: "7.3.1", throwOnImport: true, engines: "^20.19.0 || >=22.12.0" });
  await rejectsWithKind(
    loadTargetVite(root),
    "vite_load_failed",
    new RegExp(
      `Vite 7\\.3\\.1 could not be loaded with Node ${process.version.replace(/\./g, "\\.")} \\(requires \\^20\\.19\\.0 \\|\\| >=22\\.12\\.0\\): boom while loading vite`
    )
  );
});

test("warns for a Vite major newer than the tested range", async (t) => {
  const root = fakeRoot(t, { shape: 7, version: "8.0.0" });
  const loaded = await loadTargetVite(root);
  assert.equal(loaded.warning, "Vite 8.0.0 is newer than the tested range (4–7)");
});

test("resolves through a symlinked node_modules to the real path", async (t) => {
  const temp = makeTempDir("vite-loader-link");
  t.after(() => {
    temp.cleanup();
  });
  const clone = path.join(temp.path, "clone");
  const worktree = path.join(temp.path, "worktree");
  fs.mkdirSync(clone);
  fs.mkdirSync(worktree);
  writeFakeVitePackage(clone, { shape: 6 });
  fs.symlinkSync(path.join(clone, "node_modules"), path.join(worktree, "node_modules"), "dir");
  const loaded = await loadTargetVite(worktree);
  assert.equal(loaded.packageDir, fs.realpathSync(path.join(clone, "node_modules", "vite")));
  assert.equal(loaded.major, 6);
});

test("resolveExportTarget follows conditions in priority order", () => {
  assert.equal(resolveExportTarget("./a.js", ["import"]), "./a.js");
  assert.equal(resolveExportTarget({ require: "./a.cjs", import: "./a.js" }, ["import", "default"]), "./a.js");
  assert.equal(
    resolveExportTarget({ import: { types: "./a.d.ts", default: "./a.js" } }, ["import", "default"]),
    "./a.js"
  );
  assert.equal(resolveExportTarget([{ node: "./n.js" }, "./b.js"], ["import"]), "./b.js");
  assert.equal(resolveExportTarget({ require: "./a.cjs" }, ["import"]), null);
});

test("resolveWatchOption returns null for 5.4+ and ignore-all for older versions", () => {
  assert.equal(resolveWatchOption(7, 0), null);
  assert.equal(resolveWatchOption(6, 2), null);
  assert.equal(resolveWatchOption(5, 4), null);
  assert.deepEqual(resolveWatchOption(5, 3), { ignored: ["**/*"] });
  assert.deepEqual(resolveWatchOption(4, 5), { ignored: ["**/*"] });
});

test("esm-import keeps a native import() in the compiled CommonJS output", () => {
  const backendDir = path.join(__dirname, "../../../backend");
  const configPath = path.join(backendDir, "tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined
    }
  );
  assert.ok(config);
  const file = path.join(backendDir, "src/services/visualizations/pipeline/render/esm-import.ts");
  const program = ts.createProgram([file], {
    ...config.options,
    noEmit: false,
    sourceMap: false,
    removeComments: true
  });
  const sourceFile = program.getSourceFile(file);
  assert.ok(sourceFile);
  let output = "";
  program.emit(sourceFile, (name, text) => {
    if (name.endsWith(".js")) {
      output = text;
    }
  });
  assert.match(output, /\bimport\(fileUrl\)/);
  assert.doesNotMatch(output, /require\(fileUrl\)/);
  assert.doesNotMatch(output, /new Function|eval\(/);
});
