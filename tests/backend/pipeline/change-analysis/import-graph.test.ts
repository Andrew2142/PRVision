import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type ts from "typescript";
import { MAX_PARENTS_PER_MODULE } from "../../../../backend/src/config-consts";
import { ComponentDetector } from "../../../../backend/src/services/visualizations/pipeline/component-detector";
import {
  ImportGraph,
  truncateFiles,
  type ImportGraphBuildOptions
} from "../../../../backend/src/services/visualizations/pipeline/import-graph";
import { ModuleResolver } from "../../../../backend/src/services/visualizations/pipeline/module-resolver";
import type { Seed } from "../../../../backend/src/types/change-analysis";
import { ALIAS_TSCONFIG, writeTree, type FileMap } from "./helpers/worktree-fixture";

async function makeRoot(t: TestContext, files: FileMap): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-graph-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeTree(root, { "tsconfig.json": ALIAS_TSCONFIG, ...files });
  return root;
}

async function build(
  t: TestContext,
  files: FileMap,
  overrides: Partial<ImportGraphBuildOptions> = {}
): Promise<ImportGraph> {
  const root = await makeRoot(t, files);
  const resolver = await ModuleResolver.create({
    side: "head",
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    viteConfigPath: null,
    sourceRoot: "src",
    warn: () => undefined
  });
  return ImportGraph.build({
    side: "head",
    rootDir: root,
    sourceRoot: "src",
    resolver,
    detector: new ComponentDetector(),
    priorityPaths: [],
    maxFiles: 3000,
    budgetMs: 45_000,
    signal: new AbortController().signal,
    now: Date.now,
    ...overrides
  });
}

function seed(p: string, names: Set<string> | "*"): Seed {
  return { path: p, names, reasonLabel: `module ${p}`, global: false, changedLines: 1 };
}

const covered = { isAlreadyCovered: (): boolean => false };
const limits = { maxDepth: 3, maxParents: MAX_PARENTS_PER_MODULE, ...covered };

function parentKeys(parents: ReturnType<ImportGraph["findAffectedParents"]>): string[] {
  return parents.map((p) => `${p.path}#${p.exportInfo.exportName}@${String(p.depth)}`);
}

test("builds forward and reverse edges with bindings", async (t) => {
  const graph = await build(t, {
    "src/a.ts": `export const a = 1; export default 2;`,
    "src/b.tsx": `import def, { a as x } from "./a";\nimport * as NS from "@/a";\nimport "./side";\nexport const B = () => <i>{x}{NS.a}{def}</i>;`,
    "src/side.ts": `console.log(1);`,
    "src/lazy.tsx": `export const L = React.lazy(() => import("./b"));`
  });
  const forward = graph.importsOf("src/b.tsx");
  assert.deepEqual(
    forward.map((e) => [e.to, e.kind, e.bindings, e.star, e.line]),
    [
      [
        "src/a.ts",
        "import",
        [
          { imported: "default", local: "def" },
          { imported: "a", local: "x" }
        ],
        false,
        1
      ],
      ["src/a.ts", "import", [{ imported: "*", local: "NS" }], true, 2],
      ["src/side.ts", "side_effect", [], true, 3]
    ]
  );
  assert.deepEqual(
    graph.importersOf("src/a.ts").map((e) => e.from),
    ["src/b.tsx", "src/b.tsx"]
  );
  assert.deepEqual(
    graph.importersOf("src/b.tsx").map((e) => [e.from, e.kind]),
    [["src/lazy.tsx", "dynamic"]]
  );
  assert.equal(graph.stats.edges, 4);
});

test("skips type-only imports", async (t) => {
  const graph = await build(t, {
    "src/types.ts": `export interface P { a: string }`,
    "src/a.tsx": `import type { P } from "./types";\nimport { type P as Q } from "./types";\nexport const A = (p: P & Q) => <i/>;`
  });
  assert.equal(graph.importsOf("src/a.tsx").length, 0);
});

test("marks tests and stories by role but includes them as nodes", async (t) => {
  const graph = await build(t, {
    "src/A.tsx": `export const A = () => <i/>;`,
    "src/A.test.tsx": `import { A } from "./A";`,
    "src/A.stories.tsx": `import { A } from "./A";`
  });
  assert.equal(graph.module("src/A.test.tsx")?.role, "test");
  assert.equal(graph.module("src/A.stories.tsx")?.role, "story");
  assert.equal(graph.importersOf("src/A.tsx").length, 2);
});

test("does not follow symlinked directories", async (t) => {
  const root = await makeRoot(t, { "src/a.ts": "export const a = 1;", "outside/b.ts": "export const b = 1;" });
  await fs.symlink(path.join(root, "outside"), path.join(root, "src", "linked"));
  const resolver = await ModuleResolver.create({
    side: "head",
    rootDir: root,
    tsconfigPath: null,
    viteConfigPath: null,
    sourceRoot: "src",
    warn: () => undefined
  });
  const graph = await ImportGraph.build({
    side: "head",
    rootDir: root,
    sourceRoot: "src",
    resolver,
    detector: new ComponentDetector(),
    priorityPaths: [],
    maxFiles: 10,
    budgetMs: 10_000,
    signal: new AbortController().signal,
    now: Date.now
  });
  assert.deepEqual(graph.paths(), ["src/a.ts"]);
});

test("truncates to maxFiles keeping changed files and nearest directories", async (t) => {
  assert.deepEqual(
    truncateFiles(["src/a/x.ts", "src/b/c/y.ts", "src/b/c/z.ts", "src/b/w.ts", "src/d/v.ts"], ["src/b/c/y.ts"], 3),
    ["src/b/c/y.ts", "src/b/c/z.ts", "src/b/w.ts"]
  );
  const graph = await build(
    t,
    { "src/a/x.ts": "", "src/b/c/y.ts": "", "src/b/c/z.ts": "", "src/b/w.ts": "", "src/d/v.ts": "" },
    { maxFiles: 2, priorityPaths: ["src/d/v.ts"] }
  );
  assert.equal(graph.truncated, true);
  assert.equal(graph.totalFiles, 5);
  assert.ok(graph.has("src/d/v.ts"));
  assert.equal(graph.paths().length, 2);
});

test("stops at soft budget and flags budgetExceeded", async (t) => {
  const files: FileMap = {};
  for (let i = 0; i < 250; i++) {
    files[`src/f${String(i).padStart(3, "0")}.ts`] = `export const v = ${String(i)};`;
  }
  let clock = 0;
  const graph = await build(t, files, {
    budgetMs: 50,
    now: () => {
      clock += 100;
      return clock;
    }
  });
  assert.equal(graph.budgetExceeded, true);
  assert.equal(graph.paths().length, 100);
});

const HOOK_TREE: FileMap = {
  "src/hooks/useCart.ts": `export function useCart() { return 1 }\nexport const CART_LIMIT = 10;`,
  "src/hooks/useAuth.ts": `export function useAuth() { return 1 }`,
  "src/hooks/index.ts": `export * from "./useCart";\nexport * from "./useAuth";`,
  "src/components/CartBadge.tsx": `import { useCart } from "@/hooks/useCart";\nexport function CartBadge() { const c = useCart(); return <b>{c}</b> }`,
  "src/components/CartLimitNote.tsx": `import { CART_LIMIT } from "@/hooks/useCart";\nexport const CartLimitNote = () => <p>{CART_LIMIT}</p>;`,
  "src/pages/CheckoutPage.tsx": `import { useCart } from "../hooks";\nexport default function CheckoutPage() { useCart(); return <main/> }`,
  "src/pages/AdminPage.tsx": `import { useAuth } from "../hooks";\nexport default function AdminPage() { useAuth(); return <main/> }`,
  "src/components/CartBadge.test.tsx": `import { CartBadge } from "./CartBadge";\nexport const T = () => <CartBadge/>;`
};

test("findAffectedParents finds direct importer using the binding", async (t) => {
  const graph = await build(t, HOOK_TREE);
  const parents = graph.findAffectedParents(seed("src/hooks/useCart.ts", new Set(["useCart"])), {
    ...limits,
    maxParents: 1
  });
  assert.deepEqual(parentKeys(parents), ["src/components/CartBadge.tsx#CartBadge@1"]);
  assert.deepEqual(parents[0]?.via, []);
});

test("findAffectedParents ignores importers of other names", async (t) => {
  const graph = await build(t, HOOK_TREE);
  const parents = graph.findAffectedParents(seed("src/hooks/useCart.ts", new Set(["useCart"])), limits);
  assert.ok(!parentKeys(parents).some((key) => key.includes("CartLimitNote") || key.includes("AdminPage")));
});

test("findAffectedParents walks through export-star barrel", async (t) => {
  const graph = await build(t, HOOK_TREE);
  const parents = graph.findAffectedParents(seed("src/hooks/useCart.ts", new Set(["useCart"])), limits);
  assert.deepEqual(parentKeys(parents), [
    "src/components/CartBadge.tsx#CartBadge@1",
    "src/pages/CheckoutPage.tsx#default@2"
  ]);
  assert.deepEqual(parents[1]?.via, ["src/hooks/index.ts"]);
});

test("findAffectedParents maps names through named re-export", async (t) => {
  const graph = await build(t, {
    "src/lib/util.ts": `export const fmt = () => 1;\nexport const other = 2;`,
    "src/lib/index.ts": `export { fmt as format, other } from "./util";`,
    "src/A.tsx": `import { format } from "./lib";\nexport const A = () => <i>{format()}</i>;`,
    "src/B.tsx": `import { other } from "./lib";\nexport const B = () => <i>{other}</i>;`
  });
  const parents = graph.findAffectedParents(seed("src/lib/util.ts", new Set(["fmt"])), limits);
  assert.deepEqual(parentKeys(parents), ["src/A.tsx#A@2"]);
});

test("findAffectedParents stops at nearest component importer", async (t) => {
  const graph = await build(t, {
    "src/u.ts": `export const u = 1;`,
    "src/Child.tsx": `import { u } from "./u";\nexport const Child = () => <i>{u}</i>;`,
    "src/Parent.tsx": `import { Child } from "./Child";\nexport const Parent = () => <Child/>;`
  });
  const parents = graph.findAffectedParents(seed("src/u.ts", new Set(["u"])), limits);
  assert.deepEqual(parentKeys(parents), ["src/Child.tsx#Child@1"]);
});

test("findAffectedParents respects depth limit 3", async (t) => {
  const graph = await build(t, {
    "src/u.ts": `export const u = 1;`,
    "src/l1.ts": `import { u } from "./u";\nexport const l1 = u;`,
    "src/l2.ts": `import { l1 } from "./l1";\nexport const l2 = l1;`,
    "src/l3.ts": `import { l2 } from "./l2";\nexport const l3 = l2;`,
    "src/Deep.tsx": `import { l3 } from "./l3";\nexport const Deep = () => <i>{l3}</i>;`,
    "src/Near.tsx": `import { l2 } from "./l2";\nexport const Near = () => <i>{l2}</i>;`
  });
  const parents = graph.findAffectedParents(seed("src/u.ts", new Set(["u"])), limits);
  assert.deepEqual(parentKeys(parents), ["src/Near.tsx#Near@3"]);
  assert.deepEqual(parents[0]?.via, ["src/l1.ts", "src/l2.ts"]);
});

test("findAffectedParents caps at MAX_PARENTS_PER_MODULE", async (t) => {
  const files: FileMap = { "src/u.ts": `export const u = 1;` };
  for (const name of ["A", "B", "C", "D"]) {
    files[`src/${name}.tsx`] = `import { u } from "./u";\nexport const ${name} = () => <i>{u}</i>;`;
  }
  const graph = await build(t, files);
  assert.equal(MAX_PARENTS_PER_MODULE, 2);
  assert.deepEqual(parentKeys(graph.findAffectedParents(seed("src/u.ts", new Set(["u"])), limits)), [
    "src/A.tsx#A@1",
    "src/B.tsx#B@1"
  ]);
});

test("already-covered parents do not consume the cap", async (t) => {
  const files: FileMap = { "src/u.ts": `export const u = 1;` };
  for (const name of ["A", "B", "C"]) {
    files[`src/${name}.tsx`] = `import { u } from "./u";\nexport const ${name} = () => <i>{u}</i>;`;
  }
  const graph = await build(t, files);
  const parents = graph.findAffectedParents(seed("src/u.ts", new Set(["u"])), {
    ...limits,
    isAlreadyCovered: (p) => p === "src/A.tsx"
  });
  assert.deepEqual(parentKeys(parents), ["src/A.tsx#A@1", "src/B.tsx#B@1", "src/C.tsx#C@1"]);
});

test("ignores test and story importers", async (t) => {
  const graph = await build(t, {
    "src/u.ts": `export const u = 1;`,
    "src/A.test.tsx": `import { u } from "./u";\nexport const T = () => <i>{u}</i>;`,
    "src/A.stories.tsx": `import { u } from "./u";\nexport const S = () => <i>{u}</i>;`
  });
  assert.deepEqual(graph.findAffectedParents(seed("src/u.ts", new Set(["u"])), limits), []);
});

test("handles circular imports", async (t) => {
  const graph = await build(t, {
    "src/a.ts": `import { b } from "./b";\nexport const a = () => b;`,
    "src/b.ts": `import { a } from "./a";\nexport const b = () => a;`,
    "src/C.tsx": `import { a } from "./a";\nexport const C = () => <i>{a()}</i>;`
  });
  assert.deepEqual(parentKeys(graph.findAffectedParents(seed("src/b.ts", new Set(["b"])), limits)), ["src/C.tsx#C@2"]);
});

test("walks SCSS partial chain to component", async (t) => {
  const graph = await build(t, {
    "src/styles/_tokens.scss": `$pad: 4px;`,
    "src/styles/main.scss": `@use "./tokens";\n.a { padding: tokens.$pad }`,
    "src/Panel.tsx": `import "./styles/main.scss";\nexport const Panel = () => <i/>;`
  });
  const parents = graph.findAffectedParents(seed("src/styles/_tokens.scss", "*"), limits);
  assert.deepEqual(parentKeys(parents), ["src/Panel.tsx#Panel@2"]);
  assert.equal(parents[0]?.directStyleOwner, false);
});

test("componentsFromEntry returns App for global stylesheet", async (t) => {
  const graph = await build(t, {
    "src/main.tsx": `import App from "./App";\nimport "./index.css";\ncreateRoot(el).render(<App/>);`,
    "src/index.css": `body { margin: 0 }`,
    "src/App.tsx": `import Page from "./Page";\nexport default function App() { return <Page/> }`,
    "src/Page.tsx": `export default function Page() { return <main/> }`
  });
  assert.deepEqual(graph.findAffectedParents(seed("src/index.css", "*"), limits), []);
  assert.deepEqual(
    graph
      .componentsFromEntry("src/main.tsx", { maxDepth: 3, limit: 1 })
      .map((c) => [c.path, c.exportInfo.exportName, c.depth]),
    [["src/App.tsx", "default", 1]]
  );
});

test("exportAliases follows barrels for call sites", async (t) => {
  const graph = await build(t, {
    "src/ui/Button.tsx": `export default function Button() { return <button/> }`,
    "src/ui/index.ts": `export { default as Button } from "./Button";`,
    "src/index.ts": `export * from "./ui";`
  });
  assert.deepEqual(graph.exportAliases("src/ui/Button.tsx", "default", 3), [
    { path: "src/ui/Button.tsx", exportName: "default" },
    { path: "src/ui/index.ts", exportName: "Button" },
    { path: "src/index.ts", exportName: "Button" }
  ]);
});

test("graph build parses without parent nodes", async (t) => {
  const seen: Array<boolean | undefined> = [];
  class SpyDetector extends ComponentDetector {
    override parse(repoPath: string, text: string, options: { parents?: boolean } = {}): ts.SourceFile {
      seen.push(options.parents);
      return super.parse(repoPath, text, options);
    }
  }
  await build(t, { "src/a.tsx": `export const A = () => <i/>;` }, { detector: new SpyDetector() });
  assert.deepEqual(seen, [false]);
});

test("builds a 3000-file synthetic graph within the 15 s budget", async (t) => {
  const files: FileMap = {};
  for (let i = 0; i < 3000; i++) {
    const dir = `src/m${String(Math.floor(i / 50))}`;
    const prev = i % 50 === 0 ? null : `./c${String(i - 1)}`;
    const lines = [
      prev === null ? `import { useState } from "react";` : `import { C${String(i - 1)} } from "${prev}";`,
      `import "../shared.css";`,
      `export interface P${String(i)} { label: string; count?: number }`,
      `const helper${String(i)} = (n: number) => n * 2;`,
      `export function C${String(i)}({ label, count = 1 }: P${String(i)}) {`,
      `  const doubled = helper${String(i)}(count);`,
      `  return (`,
      `    <div className="p-2">`,
      `      <span>{label}</span>`,
      `      <span>{doubled}</span>`,
      `    </div>`,
      `  );`,
      `}`,
      `export const use${String(i)} = () => ${String(i)};`
    ];
    while (lines.length < 20) {
      lines.push(`// filler ${String(lines.length)}`);
    }
    files[`${dir}/c${String(i)}.tsx`] = lines.join("\n");
  }
  files["src/shared.css"] = "body{}";
  const root = await makeRoot(t, files);
  const resolver = await ModuleResolver.create({
    side: "head",
    rootDir: root,
    tsconfigPath: "tsconfig.json",
    viteConfigPath: null,
    sourceRoot: "src",
    warn: () => undefined
  });
  const started = Date.now();
  const graph = await ImportGraph.build({
    side: "head",
    rootDir: root,
    sourceRoot: "src",
    resolver,
    detector: new ComponentDetector(),
    priorityPaths: [],
    maxFiles: 3000,
    budgetMs: 45_000,
    signal: new AbortController().signal,
    now: Date.now
  });
  const elapsed = Date.now() - started;
  t.diagnostic(
    `3000-file graph: ${String(graph.stats.files)} modules, ${String(graph.stats.edges)} edges in ${String(elapsed)} ms`
  );
  assert.equal(graph.stats.files, 3000);
  assert.ok(elapsed < 15_000, `graph build took ${String(elapsed)} ms`);
});
