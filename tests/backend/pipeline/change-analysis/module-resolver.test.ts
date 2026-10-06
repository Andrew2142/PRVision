import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ModuleResolver } from "../../../../backend/src/services/visualizations/pipeline/module-resolver";
import { writeTree, type FileMap } from "./helpers/worktree-fixture";

interface Setup {
  root: string;
  resolver: ModuleResolver;
  warnings: string[];
}

async function setup(
  t: TestContext,
  files: FileMap,
  options: { tsconfigPath?: string | null; viteConfigPath?: string | null } = {}
): Promise<Setup> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-resolver-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeTree(root, files);
  const warnings: string[] = [];
  const resolver = await ModuleResolver.create({
    side: "head",
    rootDir: root,
    tsconfigPath: options.tsconfigPath ?? null,
    viteConfigPath: options.viteConfigPath ?? null,
    sourceRoot: "src",
    warn: (message) => warnings.push(message)
  });
  return { root, resolver, warnings };
}

const SRC = {
  "src/hooks/useAuth.ts": "export const useAuth = () => 1;",
  "src/components/Button.tsx": "export default function Button() { return null }",
  "src/main.tsx": "import x from './x';"
};

test("resolves tsconfig paths alias", async (t) => {
  const { resolver } = await setup(
    t,
    { ...SRC, "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }) },
    { tsconfigPath: "tsconfig.json" }
  );
  assert.deepEqual(resolver.resolveScript("@/hooks/useAuth", "src/main.tsx"), {
    kind: "internal",
    path: "src/hooks/useAuth.ts"
  });
  assert.deepEqual(resolver.resolveScript("./components/Button", "src/main.tsx"), {
    kind: "internal",
    path: "src/components/Button.tsx"
  });
  assert.equal(resolver.resolveScript("@/hooks/missing", "src/main.tsx").kind, "unresolved");
});

test("follows tsconfig references to tsconfig.app.json", async (t) => {
  const { resolver, warnings } = await setup(
    t,
    {
      ...SRC,
      "tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.node.json" }, { path: "./tsconfig.app.json" }]
      }),
      "tsconfig.node.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["vite.config.ts"] }),
      "tsconfig.app.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } }, include: ["src"] })
    },
    { tsconfigPath: "tsconfig.json" }
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(resolver.resolveScript("~/hooks/useAuth", "src/main.tsx"), {
    kind: "internal",
    path: "src/hooks/useAuth.ts"
  });
});

test("reads vite object alias with path.resolve(__dirname)", async (t) => {
  const { resolver } = await setup(t, {
    ...SRC,
    "vite.config.ts": `import path from "node:path";
import { defineConfig } from "vite";
export default defineConfig({ resolve: { alias: { "@app": path.resolve(__dirname, "./src") } } });`
  });
  assert.equal(resolver.aliases.length, 1);
  assert.deepEqual(resolver.resolveScript("@app/hooks/useAuth", "src/main.tsx"), {
    kind: "internal",
    path: "src/hooks/useAuth.ts"
  });
});

test("reads vite array alias with find/replacement", async (t) => {
  const { resolver } = await setup(t, {
    ...SRC,
    "vite.config.ts": `import { resolve } from "path";
const srcDir = resolve(__dirname, "src");
export default { resolve: { alias: [{ find: "#c", replacement: \`\${srcDir}/components\` }] } };`
  });
  assert.deepEqual(resolver.resolveScript("#c/Button", "src/main.tsx"), {
    kind: "internal",
    path: "src/components/Button.tsx"
  });
});

test("reads fileURLToPath(new URL()) alias", async (t) => {
  const { resolver } = await setup(
    t,
    {
      ...SRC,
      "vite.config.ts": `import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } } });`
    },
    { viteConfigPath: "vite.config.ts" }
  );
  assert.deepEqual(resolver.resolveScript("@/hooks/useAuth", "src/main.tsx"), {
    kind: "internal",
    path: "src/hooks/useAuth.ts"
  });
});

test("reads defineConfig arrow returning object", async (t) => {
  const { resolver } = await setup(t, {
    ...SRC,
    "vite.config.mts": `import { defineConfig } from "vite";
export default defineConfig(({ mode }) => {
  return { resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } } };
});`
  });
  assert.deepEqual(resolver.resolveScript("@/components/Button", "src/main.tsx"), {
    kind: "internal",
    path: "src/components/Button.tsx"
  });
});

test("warns and skips regex find and non-static replacement", async (t) => {
  const { resolver, warnings } = await setup(t, {
    ...SRC,
    "vite.config.ts": `export default {
  resolve: { alias: [
    { find: /^@x/, replacement: "./src" },
    { find: "@dyn", replacement: compute() },
    { find: "@ok", replacement: "./src" }
  ] }
};`
  });
  assert.deepEqual(warnings, [
    'Vite alias "/^@x/" could not be read statically; imports using it are ignored.',
    'Vite alias "@dyn" could not be read statically; imports using it are ignored.'
  ]);
  assert.deepEqual(
    resolver.aliases.map((a) => a.find),
    ["@ok"]
  );
});

test("rejects alias replacement outside the worktree", async (t) => {
  const { resolver, warnings } = await setup(t, {
    ...SRC,
    "vite.config.ts": `export default { resolve: { alias: { "@out": "../../etc", "@abs": "/etc/passwd-dir" } } };`
  });
  assert.equal(resolver.aliases.length, 0);
  assert.equal(warnings.length, 2);
});

test("resolves Vite root-relative /src imports", async (t) => {
  const { resolver } = await setup(t, SRC);
  assert.deepEqual(resolver.resolveScript("/src/hooks/useAuth.ts", "src/components/Button.tsx"), {
    kind: "internal",
    path: "src/hooks/useAuth.ts"
  });
});

test("classifies node_modules and bare packages as external", async (t) => {
  const { resolver, root } = await setup(t, {
    ...SRC,
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", main: "index.js" }),
    "node_modules/left-pad/index.js": "module.exports = 1;"
  });
  assert.deepEqual(resolver.resolveScript("left-pad", "src/main.tsx"), { kind: "external" });
  assert.deepEqual(resolver.resolveScript("react", "src/main.tsx"), { kind: "external" });
  assert.deepEqual(resolver.resolveScript("virtual:pwa", "src/main.tsx"), { kind: "external" });
  assert.deepEqual(resolver.resolveScript("./x?raw", "src/main.tsx"), { kind: "external" });
  assert.deepEqual(resolver.resolveScript("../node_modules/left-pad/index.js", "src/main.tsx"), { kind: "external" });
  assert.equal(await resolver.isInstalledPackage("left-pad"), true);
  assert.equal(await resolver.isInstalledPackage("react"), false);
  assert.ok(root.length > 0);
});

test("resolves scss partials and index files", async (t) => {
  const { resolver } = await setup(t, {
    ...SRC,
    "src/styles/_tokens.scss": "$a: 1;",
    "src/styles/mixins/_index.scss": "",
    "src/styles/theme/index.css": "",
    "src/styles/main.scss": ""
  });
  assert.deepEqual(resolver.resolveStyle("./tokens", "src/styles/main.scss"), {
    kind: "internal",
    path: "src/styles/_tokens.scss"
  });
  assert.deepEqual(resolver.resolveStyle("./mixins", "src/styles/main.scss"), {
    kind: "internal",
    path: "src/styles/mixins/_index.scss"
  });
  assert.deepEqual(resolver.resolveStyle("./theme", "src/styles/main.scss"), {
    kind: "internal",
    path: "src/styles/theme/index.css"
  });
  assert.deepEqual(resolver.resolveStyle("sass:math", "src/styles/main.scss"), { kind: "external" });
  assert.deepEqual(resolver.resolveStyle("~bootstrap/scss/x", "src/styles/main.scss"), { kind: "external" });
});

test("resolves css module composes", async (t) => {
  const { resolver } = await setup(t, {
    ...SRC,
    "src/styles/shared.module.css": ".base { color: red }",
    "src/components/Card.module.css": ".card { composes: base from '../styles/shared.module.css'; }"
  });
  assert.deepEqual(resolver.resolveStyle("../styles/shared.module.css", "src/components/Card.module.css"), {
    kind: "internal",
    path: "src/styles/shared.module.css"
  });
});

test("resolves scss import through tsconfig paths", async (t) => {
  const { resolver } = await setup(
    t,
    {
      ...SRC,
      "src/styles/tokens.scss": "",
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })
    },
    { tsconfigPath: "tsconfig.json" }
  );
  assert.deepEqual(resolver.resolveScript("@/styles/tokens.scss", "src/main.tsx"), {
    kind: "internal",
    path: "src/styles/tokens.scss"
  });
  assert.deepEqual(resolver.resolveStyle("@/styles/tokens", "src/main.tsx"), {
    kind: "internal",
    path: "src/styles/tokens.scss"
  });
});

test("reads tsconfig extends from a node_modules package", async (t) => {
  const { resolver, warnings } = await setup(
    t,
    {
      ...SRC,
      "node_modules/@acme/tsconfig/package.json": JSON.stringify({ name: "@acme/tsconfig" }),
      "node_modules/@acme/tsconfig/base.json": JSON.stringify({
        compilerOptions: { baseUrl: "../../..", paths: { "$lib/*": ["src/*"] } }
      }),
      "tsconfig.json": JSON.stringify({ extends: "@acme/tsconfig/base.json" })
    },
    { tsconfigPath: "tsconfig.json" }
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(resolver.resolveScript("$lib/hooks/useAuth", "src/main.tsx"), {
    kind: "internal",
    path: "src/hooks/useAuth.ts"
  });
});

test("classifies asset imports as external", async (t) => {
  const { resolver } = await setup(t, { ...SRC, "src/logo.svg": "<svg/>", "src/data.json": "{}" });
  for (const specifier of ["./logo.svg", "./data.json", "./font.woff2", "./image.png?url", "./Icon.tsx?react"]) {
    assert.deepEqual(resolver.resolveScript(specifier, "src/main.tsx"), { kind: "external" }, specifier);
  }
});

test("warns when the tsconfig cannot be read", async (t) => {
  const { warnings, resolver } = await setup(
    t,
    { ...SRC, "tsconfig.json": "{ not json" },
    { tsconfigPath: "tsconfig.json" }
  );
  assert.deepEqual(warnings, ["Could not read tsconfig.json; import aliases from it are ignored."]);
  assert.equal(resolver.resolveScript("./components/Button", "src/main.tsx").kind, "internal");
});
