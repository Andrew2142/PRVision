/**
 * Writes fake `node_modules/vite` packages (sheet 10 §9.3) with the export shapes of Vite 4, 5, 6 and 7. The ESM
 * entry exports stub functions; the CJS entry throws so a test fails if the loader ever picks it.
 */
import fs from "node:fs";
import path from "node:path";

export type FakeViteShape = 4 | 5 | 6 | 7;

export interface FakeViteOptions {
  version?: string;
  shape?: FakeViteShape;
  /** The ESM entry exports only `default` (an object holding the API). */
  defaultOnly?: boolean;
  /** Leave createServer out of the API. */
  omitCreateServer?: boolean;
  /** The ESM entry throws at evaluation. */
  throwOnImport?: boolean;
  engines?: string;
}

const API_FUNCTIONS = [
  "createServer",
  "loadConfigFromFile",
  "mergeConfig",
  "createLogger",
  "loadEnv",
  "transformWithEsbuild",
  "searchForWorkspaceRoot"
];

function exportsFor(shape: FakeViteShape): unknown {
  switch (shape) {
    case 4:
      return {
        ".": { types: "./dist/node/index.d.ts", import: "./dist/node/index.js", require: "./index.cjs" },
        "./package.json": "./package.json"
      };
    case 5:
      return {
        ".": {
          import: { types: "./dist/node/index.d.ts", default: "./dist/node/index.js" },
          require: { types: "./index.d.cts", default: "./index.cjs" }
        },
        "./package.json": "./package.json"
      };
    case 6:
      return {
        ".": { "module-sync": "./dist/node/index.js", import: "./dist/node/index.js", require: "./index.cjs" },
        "./package.json": "./package.json"
      };
    case 7:
      return { ".": "./dist/node/index.js", "./package.json": "./package.json" };
  }
}

/**
 * Creates `<root>/node_modules/vite` and returns the package directory.
 *
 * @param root - The directory that plays the Vite root (gets a package.json too).
 */
export function writeFakeVitePackage(root: string, options: FakeViteOptions = {}): string {
  const shape = options.shape ?? 7;
  const version = options.version ?? `${String(shape)}.1.0`;
  const dir = path.join(root, "node_modules", "vite");
  fs.mkdirSync(path.join(dir, "dist", "node"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fake-app", private: true }));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "vite",
      version,
      type: "module",
      main: "./dist/node/index.js",
      exports: exportsFor(shape),
      engines: { node: options.engines ?? "^20.19.0 || >=22.12.0" }
    })
  );
  const functions = API_FUNCTIONS.filter((name) => !(options.omitCreateServer === true && name === "createServer"));
  const body = functions.map((name) => `function ${name}() { return null; }`).join("\n");
  const exportList = functions.join(", ");
  const entry = options.throwOnImport
    ? `throw new Error("boom while loading vite");\n`
    : options.defaultOnly
      ? `${body}\nexport default { version: ${JSON.stringify(version)}, ${exportList} };\n`
      : `${body}\nexport const version = ${JSON.stringify(version)};\nexport { ${exportList} };\n`;
  fs.writeFileSync(path.join(dir, "dist", "node", "index.js"), entry);
  fs.writeFileSync(path.join(dir, "index.cjs"), `throw new Error("the deprecated CJS build was loaded");\n`);
  return dir;
}
