import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test, type TestContext as NodeTestContext } from "node:test";
import type ts from "typescript";
import { ChangeAnalysisService } from "../../../../backend/src/services/visualizations/pipeline/change-analysis-service";
import { basePathFor, headPathFor } from "../../../../backend/src/services/visualizations/pipeline/change-source";
import { ComponentDetector } from "../../../../backend/src/services/visualizations/pipeline/component-detector";
import type {
  ChangeAnalysisResult,
  ComponentSourceQueries
} from "../../../../backend/src/types/visualization-pipeline";
import type { GitNameStatusEntry } from "../../../../backend/src/utilities/services/git-client";
import { recordLogger } from "../../helpers/console-recorder";
import {
  ALIAS_TSCONFIG,
  diffEntries,
  makeContext,
  makeWorktrees,
  stubGitClient,
  stubPersistence,
  type FileMap
} from "./helpers/worktree-fixture";

async function analyzed(
  t: NodeTestContext,
  base: FileMap,
  head: FileMap,
  options: { entries?: GitNameStatusEntry[]; detector?: ComponentDetector } = {}
): Promise<{ result: ChangeAnalysisResult; queries: ComponentSourceQueries; root: string }> {
  const wt = await makeWorktrees({
    base: { "tsconfig.json": ALIAS_TSCONFIG, ...base },
    head: { "tsconfig.json": ALIAS_TSCONFIG, ...head }
  });
  t.after(() => wt.cleanup());
  const service = new ChangeAnalysisService({
    gitClient: stubGitClient(options.entries ?? diffEntries(base, head)),
    ...stubPersistence(),
    ...(options.detector === undefined ? {} : { detector: options.detector })
  });
  const result = await service.analyze(
    makeContext({ baseDir: wt.baseDir, headDir: wt.headDir }, { tsconfigPath: "tsconfig.json" })
  );
  return { result, queries: result.sourceQueries, root: wt.root };
}

/** Same files on both sides plus one changed marker file, so the queries have something to look at. */
async function sameOnBothSides(t: NodeTestContext, files: FileMap) {
  return analyzed(
    t,
    { ...files, "src/marker.ts": "export const m = 1;" },
    { ...files, "src/marker.ts": "export const m = 2;" }
  );
}

const METHODS = [
  "componentPaths",
  "resolveTypeSources",
  "findCallSites",
  "getDirectImports",
  "getModuleExports",
  "resolveSpecifier",
  "changedDependenciesOf"
] as const;

test("analyze returns sourceQueries implementing every ComponentSourceQueries method", async (t) => {
  const { queries } = await sameOnBothSides(t, {});
  for (const method of METHODS) {
    assert.equal(typeof queries[method], "function", method);
  }
});

test("queries never reject and return empty results after worktrees are removed", async (t) => {
  const log = recordLogger();
  t.after(log.restore);
  const { queries, root } = await sameOnBothSides(t, {
    "src/Button.tsx": `export interface P { a: string }\nexport function Button(p: P) { return <b/> }`,
    "src/Page.tsx": `import { Button } from "./Button";\nexport const Page = () => <Button a="x"/>;`
  });
  await fs.rm(root, { recursive: true, force: true });
  for (const side of ["base", "head"] as const) {
    assert.equal((await queries.resolveTypeSources("src/Button.tsx", "Button", side)).found, false);
    assert.deepEqual(await queries.findCallSites("src/Button.tsx", "Button", side, 5), []);
    assert.deepEqual(await queries.getDirectImports("src/Page.tsx", side), []);
    assert.equal(await queries.getModuleExports("src/Button.tsx", side), null);
    assert.equal(await queries.resolveSpecifier("src/Page.tsx", "./Button", side), null);
    assert.deepEqual(await queries.changedDependenciesOf("src/Page.tsx", side, 3), []);
    await queries.getDirectImports("src/Page.tsx", side);
  }
  assert.deepEqual(await queries.componentPaths("src/Button.tsx"), { base: null, head: null });
  const warnings = log.lines.filter((line) => line.event === "source_queries.failed");
  const keys = warnings.map((line) => `${String(line.method)}:${String(line.side)}`);
  assert.equal(new Set(keys).size, keys.length, "one warn per method, side and reason");
  assert.ok(keys.includes("getDirectImports:base"));
});

test("failed lazy base graph build is not retried", async (t) => {
  let graphParses = 0;
  let failing = false;
  class FailingDetector extends ComponentDetector {
    override parse(repoPath: string, text: string, options: { parents?: boolean } = {}): ts.SourceFile {
      if (options.parents === false) {
        graphParses++;
        if (failing) {
          throw new Error("parser exploded");
        }
      }
      return super.parse(repoPath, text, options);
    }
  }
  const detector = new FailingDetector();
  const log = recordLogger();
  t.after(log.restore);
  const { queries } = await analyzed(
    t,
    {
      "src/A.tsx": `export const A = () => <i/>;`,
      "src/B.tsx": `import { A } from "./A";\nexport const B = () => <A/>;`
    },
    {
      "src/A.tsx": `export const A = () => <b/>;`,
      "src/B.tsx": `import { A } from "./A";\nexport const B = () => <A/>;`
    },
    { detector }
  );
  failing = true;
  const before = graphParses;
  assert.deepEqual(await queries.findCallSites("src/A.tsx", "A", "base", 5), []);
  const afterFirst = graphParses;
  assert.equal(afterFirst, before + 1, "one attempt to build the base graph");
  assert.deepEqual(await queries.findCallSites("src/A.tsx", "A", "base", 5), []);
  assert.deepEqual(await queries.changedDependenciesOf("src/B.tsx", "base", 2), []);
  assert.equal(graphParses, afterFirst, "no retry");
  const warnings = log.lines.filter(
    (line) => line.event === "source_queries.failed" && line.method === "findCallSites"
  );
  assert.equal(warnings.length, 1);
  assert.equal((await queries.findCallSites("src/A.tsx", "A", "head", 5)).length, 1, "head graph unaffected");
});

const BUTTON = `import type { ReactNode } from "react";
export type Variant = "primary" | "ghost";
type Unused = { z: number };
export interface ButtonProps extends Base {
  variant?: Variant;
  children: ReactNode;
}
interface Base { id: string }
export default function Button({ variant = "primary", children }: ButtonProps) {
  return <button>{children}</button>;
}
`;

test("resolveTypeSources returns interface from same file", async (t) => {
  const { queries } = await sameOnBothSides(t, { "src/Button.tsx": BUTTON });
  const result = await queries.resolveTypeSources("src/Button.tsx", "default", "head");
  assert.equal(result.found, true);
  assert.equal(result.propsTypeName, "ButtonProps");
  assert.equal(result.parameterText, `{ variant = "primary", children }: ButtonProps`);
  assert.deepEqual(result.sources[0]?.name, "ButtonProps");
  assert.equal(result.sources[0].kind, "interface");
  assert.equal(result.sources[0].depth, 0);
  assert.equal(result.sources[0].filePath, "src/Button.tsx");
});

test("resolveTypeSources follows imported props type through barrel", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/types/card.ts": `export interface CardProps { title: string }`,
    "src/types/index.ts": `export * from "./card";`,
    "src/Card.tsx": `import type { CardProps } from "@/types";\nexport const Card = ({ title }: CardProps) => <h3>{title}</h3>;`
  });
  const result = await queries.resolveTypeSources("src/Card.tsx", "Card", "head");
  assert.equal(result.propsTypeName, "CardProps");
  assert.deepEqual(
    result.sources.map((s) => [s.name, s.filePath, s.kind]),
    [["CardProps", "src/types/card.ts", "interface"]]
  );
  assert.deepEqual(result.unresolved, []);
});

test("resolveTypeSources reads forwardRef second type argument", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/Input.tsx": `import { forwardRef } from "react";
interface InputProps { value: string }
export const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => <input ref={ref} value={props.value}/>);`
  });
  const result = await queries.resolveTypeSources("src/Input.tsx", "Input", "head");
  assert.equal(result.propsTypeName, "InputProps");
  assert.equal(result.parameterText, "props");
  assert.equal(result.sources[0]?.name, "InputProps");
});

test("resolveTypeSources reads FC<P> annotation", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/Tag.tsx": `import React from "react";
type TagProps = { label: string };
export const Tag: React.FC<TagProps> = ({ label }) => <span>{label}</span>;`
  });
  const result = await queries.resolveTypeSources("src/Tag.tsx", "Tag", "head");
  assert.equal(result.propsTypeName, "TagProps");
  assert.equal(result.sources[0]?.kind, "type");
});

test("resolveTypeSources returns inline type literal", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/Inline.tsx": `export function Inline({ a }: { a: string; b?: number }) { return <i>{a}</i> }`
  });
  const result = await queries.resolveTypeSources("src/Inline.tsx", "Inline", "head");
  assert.equal(result.propsTypeName, null);
  assert.deepEqual(
    result.sources.map((s) => [s.name, s.kind, s.text]),
    [["(inline)", "inline", "{ a: string; b?: number }"]]
  );
});

test("resolveTypeSources includes depth-1 referenced types only", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/Button.tsx": BUTTON.replace(
      "interface Base { id: string }",
      "interface Base { id: Deeper }\ninterface Deeper { x: string }"
    )
  });
  const result = await queries.resolveTypeSources("src/Button.tsx", "default", "head");
  assert.deepEqual(
    result.sources.map((s) => [s.name, s.depth]),
    [
      ["ButtonProps", 0],
      ["Base", 1],
      ["Variant", 1]
    ]
  );
  assert.ok(!result.sources.some((s) => s.name === "Deeper" || s.name === "Unused"));
});

test("resolveTypeSources lists external types as unresolved", async (t) => {
  const { queries } = await sameOnBothSides(t, { "src/Button.tsx": BUTTON });
  const result = await queries.resolveTypeSources("src/Button.tsx", "default", "head");
  assert.deepEqual(result.unresolved, ["ReactNode"]);
});

test("resolveTypeSources returns propTypes and defaultProps for JS components", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/Legacy.jsx": `import PropTypes from "prop-types";
export function Legacy({ name }) { return <p>{name}</p> }
Legacy.propTypes = { name: PropTypes.string };
Legacy.defaultProps = { name: "x" };`
  });
  const result = await queries.resolveTypeSources("src/Legacy.jsx", "Legacy", "head");
  assert.equal(result.found, true);
  assert.deepEqual(
    result.sources.map((s) => [s.name, s.kind]),
    [
      ["(propTypes)", "propTypes"],
      ["(defaultProps)", "defaultProps"]
    ]
  );
});

test("resolveTypeSources truncates at char budget", async (t) => {
  const fields = Array.from({ length: 900 }, (_, i) => `  field${String(i)}: string;`).join("\n");
  const { queries } = await sameOnBothSides(t, {
    "src/Big.tsx": `interface Extra {\n${fields}\n}\ninterface BigProps { extra: Extra; a: string }\nexport const Big = (p: BigProps) => <i>{p.a}</i>;`
  });
  const result = await queries.resolveTypeSources("src/Big.tsx", "Big", "head");
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.sources.map((s) => s.name),
    ["BigProps"]
  );
});

test("resolveTypeSources reports start and end lines", async (t) => {
  const { queries } = await sameOnBothSides(t, { "src/Button.tsx": BUTTON });
  const result = await queries.resolveTypeSources("src/Button.tsx", "default", "head");
  const props = result.sources.find((s) => s.name === "ButtonProps");
  assert.deepEqual([props?.startLine, props?.endLine], [4, 7]);
  const variant = result.sources.find((s) => s.name === "Variant");
  assert.deepEqual([variant?.startLine, variant?.endLine], [2, 2]);
});

function lines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, i) => `// ${prefix} ${String(i + 1)}`).join("\n");
}

test("findCallSites returns JSX usages with ±15 lines", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/Button.tsx": `export default function Button(p: { label: string }) { return <button>{p.label}</button> }`,
    "src/Page.tsx": `import Button from "./Button";\n${lines(28, "before")}\nexport const Page = () => <Button label="Go" />;\n${lines(30, "after")}`
  });
  const sites = await queries.findCallSites("src/Button.tsx", "default", "head", 5);
  assert.equal(sites.length, 1);
  const site = sites[0];
  assert.ok(site);
  assert.deepEqual(
    [site.filePath, site.role, site.line, site.startLine, site.endLine, site.usedAs],
    ["src/Page.tsx", "source", 30, 15, 45, "Button"]
  );
  const snippetLines = site.snippet.split("\n");
  assert.equal(snippetLines[0], "// src/Page.tsx lines 15–45 (usage at line 30)");
  assert.equal(snippetLines.length, 32);
  assert.equal(snippetLines[16], `export const Page = () => <Button label="Go" />;`);
});

test("findCallSites resolves aliased and namespace imports", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/ui/Button.tsx": `export function Button() { return <button/> }`,
    "src/A.tsx": `import { Button as Btn } from "@/ui/Button";\nexport const A = () => <Btn/>;`,
    "src/B.tsx": `import * as UI from "./ui/Button";\nexport const B = () => <UI.Button></UI.Button>;`
  });
  const sites = await queries.findCallSites("src/ui/Button.tsx", "Button", "head", 5);
  assert.deepEqual(
    sites.map((s) => [s.filePath, s.usedAs]),
    [
      ["src/A.tsx", "Btn"],
      ["src/B.tsx", "UI.Button"]
    ]
  );
});

test("findCallSites follows barrels", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/ui/Button.tsx": `export default function Button() { return <button/> }`,
    "src/ui/index.ts": `export { default as Button } from "./Button";`,
    "src/index.ts": `export * from "./ui";`,
    "src/A.tsx": `import { Button } from "./index";\nexport const A = () => <Button/>;`
  });
  const sites = await queries.findCallSites("src/ui/Button.tsx", "default", "head", 5);
  assert.deepEqual(
    sites.map((s) => s.filePath),
    ["src/A.tsx"]
  );
});

test("findCallSites orders source before story before test and diversifies files", async (t) => {
  const use = `import { X } from "./X";\n`;
  const { queries } = await sameOnBothSides(t, {
    "src/X.tsx": `export const X = () => <i/>;`,
    "src/A.tsx": `${use}export const A = () => <div><X/>\n<X/>\n<X/></div>;`,
    "src/B.tsx": `${use}export const B = () => <X/>;`,
    "src/X.stories.tsx": `${use}export const S = () => <X/>;`,
    "src/X.test.tsx": `${use}export const T = () => <X/>;`
  });
  const sites = await queries.findCallSites("src/X.tsx", "X", "head", 5);
  assert.deepEqual(
    sites.map((s) => `${s.role}:${s.filePath}:${String(s.line)}`),
    [
      "source:src/A.tsx:2",
      "source:src/A.tsx:3",
      "source:src/B.tsx:2",
      "story:src/X.stories.tsx:2",
      "test:src/X.test.tsx:2"
    ]
  );
  const six = await queries.findCallSites("src/X.tsx", "X", "head", 6);
  assert.equal(six.length, 6);
  assert.equal(six.filter((s) => s.filePath === "src/A.tsx").length, 3);
});

test("findCallSites clamps limit", async (t) => {
  const usages = Array.from({ length: 25 }, () => "<X/>").join("\n");
  const { queries } = await sameOnBothSides(t, {
    "src/X.tsx": `export const X = () => <i/>;`,
    "src/A.tsx": `import { X } from "./X";\nexport const A = () => <div>\n${usages}\n</div>;`
  });
  assert.equal((await queries.findCallSites("src/X.tsx", "X", "head", 0)).length, 1);
  assert.equal((await queries.findCallSites("src/X.tsx", "X", "head", 100)).length, 20);
});

test("findCallSites uses base graph for removed components", async (t) => {
  const { result, queries } = await analyzed(
    t,
    {
      "src/Banner.tsx": `export default function Banner() { return <aside/> }`,
      "src/Page.tsx": `import Banner from "./Banner";\nexport const Page = () => <Banner/>;`
    },
    { "src/Page.tsx": `export const Page = () => <main/>;` }
  );
  assert.ok(result.candidates.some((c) => c.filePath === "src/Banner.tsx" && c.changeKind === "removed"));
  assert.deepEqual(
    (await queries.findCallSites("src/Banner.tsx", "default", "base", 5)).map((s) => s.filePath),
    ["src/Page.tsx"]
  );
  assert.deepEqual(await queries.findCallSites("src/Banner.tsx", "default", "head", 5), []);
});

test("getDirectImports lists default, named, namespace, type-only, side-effect, re-export and dynamic imports with kinds", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/util.ts": `export const a = 1; export type B = string;`,
    "src/types.ts": `export type T = 1;`,
    "src/lib/ns.ts": `export const n = 1;`,
    "src/x.ts": `export const x = 1;`,
    "src/all.ts": `export const all = 1;`,
    "src/Lazy.tsx": `export default function Lazy() { return <i/> }`,
    "src/global.css": `body{}`,
    "src/Main.tsx": `import React from "react";
import { a, type B } from "./util";
import * as NS from "@/lib/ns";
import type { T } from "./types";
import "./global.css";
import logo from "./logo.svg";
export { x } from "./x";
export * from "./all";
const Lazy = React.lazy(() => import("./Lazy"));
export const Main = () => <Lazy/>;`
  });
  const imports = await queries.getDirectImports("src/Main.tsx", "head");
  const pick = (i: (typeof imports)[number]) => {
    const flags = (
      ["defaultImport", "namespaceImport", "typeOnly", "sideEffectOnly", "reexport", "dynamic"] as const
    ).filter((flag) => i[flag]);
    return [i.specifier, i.line, i.kind, i.resolvedPath, i.namedImports.join(","), flags.join(",")];
  };
  assert.deepEqual(imports.map(pick), [
    ["react", 1, "package", null, "", "defaultImport"],
    ["./util", 2, "relative", "src/util.ts", "a", ""],
    ["@/lib/ns", 3, "alias", "src/lib/ns.ts", "", "namespaceImport"],
    ["./types", 4, "relative", "src/types.ts", "", "typeOnly"],
    ["./global.css", 5, "style", "src/global.css", "", "sideEffectOnly"],
    ["./logo.svg", 6, "asset", null, "", "defaultImport"],
    ["./x", 7, "relative", "src/x.ts", "x", "reexport"],
    ["./all", 8, "relative", "src/all.ts", "", "namespaceImport,reexport"],
    ["./Lazy", 9, "relative", "src/Lazy.tsx", "", "dynamic"]
  ]);
});

test("getDirectImports resolves alias and relative targets per side", async (t) => {
  const main = `import { thing } from "@/lib/thing";\nexport const Main = () => <i>{thing}</i>;`;
  const { queries } = await analyzed(
    t,
    { "src/lib/thing.ts": `export const thing = 1;`, "src/Main.tsx": main },
    { "src/lib/thing/index.ts": `export const thing = 2;`, "src/Main.tsx": main }
  );
  assert.equal((await queries.getDirectImports("src/Main.tsx", "base"))[0]?.resolvedPath, "src/lib/thing.ts");
  assert.equal((await queries.getDirectImports("src/Main.tsx", "head"))[0]?.resolvedPath, "src/lib/thing/index.ts");
  assert.deepEqual(await queries.getDirectImports("src/missing.tsx", "head"), []);
});

test("getModuleExports includes default, named re-exports and export-star targets up to 3 hops", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/m.ts": `export default 1;\nexport const own = 1;\nexport type Hidden = 1;\nexport { r as renamed } from "./r";\nexport * as NS from "./r";\nexport * from "./h1";`,
    "src/r.ts": `export const r = 1;`,
    "src/h1.ts": `export const one = 1;\nexport default 9;\nexport * from "./h2";`,
    "src/h2.ts": `export const two = 1;\nexport * from "./h3";`,
    "src/h3.ts": `export const three = 1;\nexport * from "./h4";`,
    "src/h4.ts": `export const four = 1;`
  });
  assert.deepEqual(await queries.getModuleExports("src/m.ts", "head"), [
    "NS",
    "default",
    "one",
    "own",
    "renamed",
    "three",
    "two"
  ]);
});

test("getModuleExports returns null for stylesheets and missing files", async (t) => {
  const { queries } = await sameOnBothSides(t, { "src/a.css": "body{}" });
  assert.equal(await queries.getModuleExports("src/a.css", "head"), null);
  assert.equal(await queries.getModuleExports("src/missing.ts", "head"), null);
});

test("resolveSpecifier returns repo path, package:<name> for installed packages, null otherwise", async (t) => {
  const { queries } = await sameOnBothSides(t, {
    "src/lib/api.ts": `export const api = 1;`,
    "src/Main.tsx": `export const Main = () => <i/>;`,
    "node_modules/@tanstack/react-query/package.json": `{"name":"@tanstack/react-query"}`,
    "node_modules/react/package.json": `{"name":"react"}`
  });
  assert.equal(await queries.resolveSpecifier("src/Main.tsx", "@/lib/api", "head"), "src/lib/api.ts");
  assert.equal(await queries.resolveSpecifier("src/Main.tsx", "./lib/api", "base"), "src/lib/api.ts");
  assert.equal(
    await queries.resolveSpecifier("src/Main.tsx", "@tanstack/react-query/devtools", "head"),
    "package:@tanstack/react-query"
  );
  assert.equal(await queries.resolveSpecifier("src/Main.tsx", "react", "head"), "package:react");
  assert.equal(await queries.resolveSpecifier("src/Main.tsx", "left-pad", "head"), null);
  assert.equal(await queries.resolveSpecifier("src/Main.tsx", "virtual:pwa", "head"), null);
  assert.equal(await queries.resolveSpecifier("src/Main.tsx", "./missing", "head"), null);
  assert.equal(await queries.resolveSpecifier("src/Main.tsx", "@/missing", "head"), null);
});

test("changedDependenciesOf returns nearest changed imports with their diffs", async (t) => {
  const base: FileMap = {
    "src/theme.ts": `export const color = "red";`,
    "src/useAuth.ts": `export const useAuth = () => 1;`,
    "src/Button.tsx": `import { color } from "./theme";\nexport const Button = () => <b style={{ color }}/>;`,
    "src/UserMenu.tsx": `import { useAuth } from "./useAuth";\nimport { Button } from "./Button";\nexport const UserMenu = () => <Button/>;`
  };
  const head = {
    ...base,
    "src/theme.ts": `export const color = "blue";`,
    "src/useAuth.ts": `export const useAuth = () => 2;`
  };
  const { queries } = await analyzed(t, base, head);
  const deps = await queries.changedDependenciesOf("src/UserMenu.tsx", "head", 3);
  assert.deepEqual(
    deps.map((d) => [d.path, d.status, d.depth]),
    [
      ["src/useAuth.ts", "M", 1],
      ["src/theme.ts", "M", 2]
    ]
  );
  assert.match(deps[0]?.codeDiff ?? "", /^diff --git a\/src\/useAuth\.ts/);
  assert.deepEqual(
    (await queries.changedDependenciesOf("src/UserMenu.tsx", "head", 1)).map((d) => d.path),
    ["src/useAuth.ts"]
  );
  assert.deepEqual(
    (await queries.changedDependenciesOf("src/UserMenu.tsx", "base", 9)).map((d) => d.path),
    ["src/useAuth.ts", "src/theme.ts"]
  );
});

test("componentPaths returns the previous path on base for renamed components and null for absent sides", async (t) => {
  const { queries } = await analyzed(
    t,
    {
      "src/Old.tsx": `export function Notice() { return <p>a</p> }\n// x\n// y\n// z`,
      "src/Banner.tsx": `export default function Banner() { return <aside/> }`
    },
    {
      "src/Notice.tsx": `export function Notice() { return <p>b</p> }\n// x\n// y\n// z`,
      "src/Badge.tsx": `export const Badge = () => <i/>;`
    },
    {
      entries: [
        { status: "A", path: "src/Badge.tsx" },
        { status: "D", path: "src/Banner.tsx" },
        { status: "R", score: 90, path: "src/Notice.tsx", previousPath: "src/Old.tsx" }
      ]
    }
  );
  assert.deepEqual(await queries.componentPaths("src/Notice.tsx"), { base: "src/Old.tsx", head: "src/Notice.tsx" });
  assert.deepEqual(await queries.componentPaths("src/Badge.tsx"), { base: null, head: "src/Badge.tsx" });
  assert.deepEqual(await queries.componentPaths("src/Banner.tsx"), { base: "src/Banner.tsx", head: null });
  assert.deepEqual(await queries.componentPaths("src/Nowhere.tsx"), { base: null, head: null });
});

test("basePathFor and headPathFor follow change kind and renames", () => {
  const changed = [
    { path: "src/New.tsx", status: "R" as const, previousPath: "src/Old.tsx" },
    { path: "src/M.tsx", status: "M" as const }
  ];
  assert.equal(basePathFor("src/New.tsx", "modified", changed), "src/Old.tsx");
  assert.equal(basePathFor("src/New.tsx", "added", changed), null);
  assert.equal(basePathFor("src/M.tsx", "affected_parent", changed), "src/M.tsx");
  assert.equal(basePathFor("src/Gone.tsx", "removed", changed), "src/Gone.tsx");
  assert.equal(headPathFor("src/Gone.tsx", "removed"), null);
  assert.equal(headPathFor("src/New.tsx", "modified"), "src/New.tsx");
});
