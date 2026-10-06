import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  HarnessContextBuilder,
  SafeFileReader,
  storyAndTestCandidates,
  type HarnessContextPackage,
  type PromptSection,
  type SectionId
} from "../../../backend/src/services/visualizations/pipeline/harness-context-builder";
import { buildHarnessUserPrompt } from "../../../backend/src/services/visualizations/pipeline/harness-prompts";
import type { ComponentCandidate } from "../../../backend/src/types/visualization-pipeline";
import { recordLogger } from "../helpers/console-recorder";
import { createPipelineContext } from "../helpers/pipeline-context";
import { FakeSourceQueries, directImport, type FakeSourceQueriesOptions } from "./helpers/fake-source-queries";
import { createTempWorktrees, harnessFixture, type TempWorktrees } from "./helpers/temp-worktrees";

const BUTTON = "src/components/Button/Button.tsx";
const PACKAGE_JSON = JSON.stringify({
  name: "sample",
  dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "@radix-ui/react-dialog": "^1.1.0", clsx: "^2.1.0" },
  peerDependencies: { "react-router-dom": "^6.26.0" },
  devDependencies: { vite: "^7.0.0", vitest: "^3.0.0" }
});

function candidate(overrides: Partial<ComponentCandidate> = {}): ComponentCandidate {
  return {
    componentId: 11,
    filePath: BUTTON,
    exportName: "Button",
    displayName: "Button",
    changeKind: "modified",
    rank: 0,
    codeDiff: harnessFixture("button/Button.diff"),
    reason: "Component code changed",
    ...overrides
  };
}

interface Setup {
  trees: TempWorktrees;
  queries: FakeSourceQueries;
  builder: HarnessContextBuilder;
}

function setup(t: TestContext, options: FakeSourceQueriesOptions = {}, write?: (trees: TempWorktrees) => void): Setup {
  const trees = createTempWorktrees(t);
  trees.write("head", BUTTON, harnessFixture("button/Button.tsx"));
  trees.write("base", BUTTON, harnessFixture("button/Button.base.tsx"));
  trees.write("both", "src/components/Button/Button.stories.tsx", harnessFixture("button/Button.stories.tsx"));
  trees.write(
    "both",
    "src/components/Button/__tests__/Button.test.tsx",
    'it("renders", () => { render(<Button>Save</Button>); });\n'
  );
  trees.write("head", "src/components/Spinner/Spinner.tsx", "export function Spinner() { return null; }\n");
  trees.write(
    "both",
    "src/main.tsx",
    'import App from "./App";\ncreateRoot(root).render(<BrowserRouter><App /></BrowserRouter>);\n'
  );
  trees.write("both", "src/App.tsx", "export default function App() { return <Layout />; }\n");
  trees.write("both", "package.json", PACKAGE_JSON);
  write?.(trees);
  const queries = new FakeSourceQueries({
    files: { base: trees.files.base, head: trees.files.head },
    directImports: {
      base: {
        [BUTTON]: [
          directImport({ specifier: "clsx", kind: "package", defaultImport: true }),
          directImport({
            specifier: "./legacy",
            kind: "relative",
            resolvedPath: "src/components/Button/legacy.ts",
            namedImports: ["old"]
          }),
          directImport({ specifier: "./Button.module.css", kind: "style", defaultImport: true })
        ],
        "src/main.tsx": [
          directImport({ specifier: "./App", kind: "relative", resolvedPath: "src/App.tsx", defaultImport: true })
        ]
      },
      head: {
        [BUTTON]: [
          directImport({ specifier: "clsx", kind: "package", defaultImport: true }),
          directImport({ specifier: "react", kind: "package", namedImports: [], typeOnly: true }),
          directImport({
            specifier: "../Spinner/Spinner",
            kind: "relative",
            resolvedPath: "src/components/Spinner/Spinner.tsx",
            namedImports: ["Spinner"]
          }),
          directImport({ specifier: "./Button.module.css", kind: "style", defaultImport: true })
        ],
        "src/main.tsx": [
          directImport({ specifier: "./App", kind: "relative", resolvedPath: "src/App.tsx", defaultImport: true })
        ]
      }
    },
    moduleExports: { head: { "src/components/Spinner/Spinner.tsx": ["Spinner", "SpinnerSize"] } },
    typeSources: {
      [`head:${BUTTON}`]: {
        found: true,
        propsTypeName: "ButtonProps",
        parameterText: "{ variant }: ButtonProps",
        sources: [
          {
            name: "ButtonProps",
            filePath: BUTTON,
            startLine: 7,
            endLine: 12,
            kind: "interface",
            depth: 0,
            text: "export interface ButtonProps { variant?: ButtonVariant }"
          }
        ],
        unresolved: ["ButtonHTMLAttributes", "ReactNode"],
        truncated: false
      }
    },
    callSites: {
      [`head:${BUTTON}`]: [
        {
          filePath: "src/pages/Settings.tsx",
          role: "source",
          line: 14,
          startLine: 10,
          endLine: 18,
          usedAs: "Button",
          snippet: '// src/pages/Settings.tsx lines 10–18 (usage at line 14)\n<Button variant="primary">Save</Button>'
        }
      ]
    },
    ...options
  });
  const handle = createPipelineContext({
    dataDir: trees.root,
    repositoryPath: trees.root,
    baseDir: trees.baseDir,
    headDir: trees.headDir,
    repository: { entryFilePath: "src/main.tsx", globalStylePaths: ["/src/index.css"] }
  });
  return { trees, queries, builder: new HarnessContextBuilder(handle.context, queries) };
}

const sectionIds = (pkg: HarnessContextPackage): SectionId[] => pkg.sections.map((s) => s.id);
function sectionOf(pkg: HarnessContextPackage, id: SectionId): PromptSection {
  const found = pkg.sections.find((s) => s.id === id);
  assert.ok(found, `section ${id} present`);
  return found;
}

test("modified candidate gets head source, base source, diff", async (t) => {
  const { builder } = setup(t);
  const pkg = await builder.build(candidate());
  assert.deepEqual(sectionIds(pkg).slice(0, 4), ["head_source", "base_source", "code_diff", "direct_imports"]);
  assert.ok(sectionOf(pkg, "head_source").body.includes("loading && styles.loading"));
  assert.ok(!sectionOf(pkg, "base_source").body.includes("loading"));
  assert.deepEqual(sectionOf(pkg, "head_source").attributes, { side: "head", path: BUTTON, lines: "27" });
  assert.equal(pkg.sourceSide, "head");
  assert.deepEqual(pkg.sidesPresent, { base: true, head: true });
  assert.equal(pkg.targetImportStatement, 'import { Button } from "../../src/components/Button/Button";');
  assert.ok(pkg.estimatedTokens > 0);
  const prompt = buildHarnessUserPrompt(pkg);
  assert.ok(prompt.includes('<referenced_types>\n<type_source name="ButtonProps"'));
  assert.ok(prompt.includes("external or unknown types: ButtonHTMLAttributes, ReactNode"));
  assert.ok(prompt.includes('<call_site path="src/pages/Settings.tsx" line="14" role="source">'));
  assert.ok(
    prompt.includes("<global_styles>\n/src/index.css\n(already loaded by the render page; never import these)")
  );
});

test("added candidate has no base section", async (t) => {
  const { builder } = setup(t, { componentPaths: { [BUTTON]: { base: null, head: BUTTON } } });
  const pkg = await builder.build(candidate({ changeKind: "added", codeDiff: null }));
  assert.ok(!sectionIds(pkg).includes("base_source"));
  assert.ok(!sectionIds(pkg).includes("code_diff"));
  assert.deepEqual(pkg.sidesPresent, { base: false, head: true });
  assert.deepEqual(pkg.directImports.base, []);
  assert.ok(buildHarnessUserPrompt(pkg).includes("exists in: head only (new component)"));
});

test("removed candidate reads base side for everything", async (t) => {
  const { builder, queries } = setup(t, { componentPaths: { [BUTTON]: { base: BUTTON, head: null } } }, (trees) => {
    trees.write("base", "package.json", JSON.stringify({ dependencies: { react: "^18.3.1" } }));
  });
  const pkg = await builder.build(candidate({ changeKind: "removed", codeDiff: null }));
  assert.equal(pkg.sourceSide, "base");
  assert.deepEqual(sectionIds(pkg).slice(0, 1), ["base_source"]);
  assert.equal(sectionOf(pkg, "base_source").attributes.status, "removed in head");
  assert.ok(!sectionIds(pkg).includes("head_source"));
  assert.ok(sectionOf(pkg, "dependencies").body.includes("react@^18.3.1"));
  for (const method of ["resolveTypeSources", "findCallSites"] as const) {
    assert.ok(
      queries.callsTo(method).every((args) => args[2] === "base"),
      method
    );
  }
  assert.ok(queries.callsTo("getDirectImports").every((args) => args[1] === "base"));
  assert.ok(buildHarnessUserPrompt(pkg).includes("exists in: base only (removed in head)"));
  assert.equal(pkg.targetImportPath, "../../src/components/Button/Button");
});

test("affected_parent candidate includes changed dependency diffs from changedDependenciesOf", async (t) => {
  const { builder, queries } = setup(t, {
    changedDependencies: {
      [`head:${BUTTON}`]: [
        { path: "src/hooks/useCart.ts", status: "M", depth: 1, codeDiff: "@@ -1 +1 @@\n-old\n+new </dependency_diff>" },
        { path: "src/lib/a.ts", status: "A", depth: 2, codeDiff: "@@ +1 @@\n+a" },
        { path: "src/lib/b.ts", status: "D", depth: 2, codeDiff: "@@ -1 @@\n-b" },
        { path: "src/lib/c.ts", status: "R", depth: 3, codeDiff: "@@ -1 +1 @@" }
      ]
    }
  });
  const pkg = await builder.build(candidate({ changeKind: "affected_parent", codeDiff: null }));
  const deps = sectionOf(pkg, "changed_dependencies");
  assert.ok(deps.body.includes('<dependency_diff path="src/hooks/useCart.ts" status="modified" depth="1">'));
  assert.ok(deps.body.includes('<dependency_diff path="src/lib/b.ts" status="deleted" depth="2">'));
  assert.ok(!deps.body.includes("src/lib/c.ts"), "first 3 entries");
  assert.ok(deps.body.includes("+new <\\/dependency_diff>"), "contents escaped by the builder");
  assert.ok(
    queries.callsTo("changedDependenciesOf").some((args) => args[0] === BUTTON && args[1] === "head" && args[2] === 3)
  );
  assert.ok(!sectionIds(pkg).includes("base_source"));
  assert.ok(!sectionIds(pkg).includes("code_diff"));
  // modified: only when changedDependenciesOf(head, 1) is non-empty
  const modified = await builder.build(candidate());
  assert.ok(sectionIds(modified).includes("changed_dependencies"));
});

test("renamed modified candidate reads base source and base imports from the previous path", async (t) => {
  const oldPath = "src/legacy/OldButton.tsx";
  const { builder, queries } = setup(t, { componentPaths: { [BUTTON]: { base: oldPath, head: BUTTON } } }, (trees) => {
    trees.write("base", oldPath, "export function Button() { return <button>old</button>; }\n");
  });
  const pkg = await builder.build(candidate());
  assert.deepEqual(pkg.paths, { base: oldPath, head: BUTTON });
  assert.equal(sectionOf(pkg, "base_source").attributes.path, oldPath);
  assert.ok(sectionOf(pkg, "base_source").body.includes("old</button>"));
  assert.ok(queries.callsTo("getDirectImports").some((args) => args[0] === oldPath && args[1] === "base"));
  assert.equal(pkg.targetImportPath, "../../src/components/Button/Button", "the harness imports the head path");
  assert.ok(
    !buildHarnessUserPrompt(pkg).includes('import the target with exactly: import { Button } from "../../src/legacy')
  );
});

test("direct imports union marks head-only and base-only specifiers", async (t) => {
  const { builder } = setup(t);
  const body = sectionOf(await builder.build(candidate()), "direct_imports").body;
  assert.ok(body.includes('- "clsx" [package] imports: default\n'));
  assert.ok(
    body.includes(
      '- "../Spinner/Spinner" [relative → src/components/Spinner/Spinner.tsx] imports: Spinner | module exports: Spinner, SpinnerSize [head only]'
    ),
    body
  );
  assert.ok(body.includes('- "./legacy" [relative → src/components/Button/legacy.ts] imports: old [base only]'));
  assert.ok(body.includes('- "react" [type-only — no mock needed] [head only]'));
});

test("style imports are labelled leave untouched", async (t) => {
  const { builder } = setup(t);
  const body = sectionOf(await builder.build(candidate()), "direct_imports").body;
  assert.ok(body.includes('- "./Button.module.css" [style — leave untouched]'));
});

test("stories discovery finds Button.stories.tsx and __tests__/Button.test.tsx", async (t) => {
  const { builder } = setup(t);
  const body = sectionOf(await builder.build(candidate()), "stories_tests").body;
  assert.ok(body.includes('<story path="src/components/Button/Button.stories.tsx">'));
  assert.ok(body.includes('args: { children: "Save changes" }'));
  assert.ok(body.includes('<test path="src/components/Button/__tests__/Button.test.tsx">'));
});

test("index.tsx uses parent directory name for discovery", async (t) => {
  const { stories, tests } = storyAndTestCandidates("src/ui/Card/index.tsx");
  assert.equal(stories[0], "src/ui/Card/Card.stories.tsx");
  assert.ok(tests.includes("src/ui/Card/__tests__/Card.spec.tsx"));
  assert.ok(tests.includes("src/ui/Card/__tests__/Card.jsx"));
  const card = "src/ui/Card/index.tsx";
  const { builder } = setup(t, {}, (trees) => {
    trees.write("head", card, "export default function Card() { return null; }\n");
    trees.write(
      "head",
      "src/ui/Card/__stories__/Card.stories.jsx",
      'export const Basic = { args: { title: "Hi" } };\n'
    );
  });
  const pkg = await builder.build(
    candidate({ filePath: card, exportName: "default", displayName: "Card", changeKind: "added", codeDiff: null })
  );
  assert.ok(sectionOf(pkg, "stories_tests").body.includes('<story path="src/ui/Card/__stories__/Card.stories.jsx">'));
});

test("dependencies section lists libraries of interest", async (t) => {
  const { builder } = setup(t);
  const body = sectionOf(await builder.build(candidate()), "dependencies").body;
  const first = body.split("\n")[0] ?? "";
  assert.equal(
    first,
    "libraries of interest: react@^19.0.0, react-dom@^19.0.0, @radix-ui/react-dialog@^1.1.0, react-router-dom@^6.26.0"
  );
  assert.ok(body.includes("dependencies:\nreact@^19.0.0"));
  assert.ok(body.includes("peerDependencies:\nreact-router-dom@^6.26.0"));
  assert.ok(body.includes("devDependencies:\nvite@^7.0.0\nvitest@^3.0.0"));
});

test("safe reader refuses .env and paths outside worktree", async (t) => {
  const trees = createTempWorktrees(t);
  trees.write("head", "src/ok.ts", "export const ok = 1;\n");
  trees.write("head", ".env", "SECRET=1\n");
  trees.write("head", "config/.env.local", "SECRET=1\n");
  trees.write("head", "certs/server.pem", "-----BEGIN-----\n");
  trees.write("head", "node_modules/pkg/index.js", "module.exports = 1;\n");
  trees.write("head", ".prvision-harness/components/1.tsx", "x\n");
  fs.writeFileSync(path.join(trees.root, "outside.ts"), "export const secret = 1;\n");
  fs.symlinkSync(path.join(trees.root, "outside.ts"), path.join(trees.headDir, "src/link.ts"));
  fs.writeFileSync(path.join(trees.headDir, "src/binary.ts"), Buffer.from([0x61, 0x00, 0x62]));
  const reader = new SafeFileReader({ baseDir: trees.baseDir, headDir: trees.headDir });
  assert.equal(await reader.read("head", "src/ok.ts"), "export const ok = 1;\n");
  for (const refused of [
    ".env",
    "config/.env.local",
    "certs/server.pem",
    "node_modules/pkg/index.js",
    ".prvision-harness/components/1.tsx",
    "../outside.ts",
    "src/../../outside.ts",
    "src/link.ts",
    "src/binary.ts",
    "/etc/passwd",
    "src/missing.ts"
  ]) {
    assert.equal(await reader.read("head", refused), null, refused);
  }
  assert.equal(await reader.read("head", "src/ok.ts", 5), null, "over maxBytes");
  assert.equal(await reader.exists("head", "src/ok.ts"), true);
  assert.equal(await reader.exists("head", "src/link.ts"), false);
  assert.equal(await reader.exists("base", "src/ok.ts"), false);
});

test("shared sections are computed once per side", async (t) => {
  const { builder, queries } = setup(
    t,
    { componentPaths: { "src/Other.tsx": { base: null, head: "src/Other.tsx" } } },
    (trees) => {
      trees.write("head", "src/Other.tsx", "export function Other() { return null; }\n");
    }
  );
  const first = await builder.build(candidate());
  const second = await builder.build(
    candidate({
      componentId: 12,
      filePath: "src/Other.tsx",
      exportName: "Other",
      displayName: "Other",
      changeKind: "added",
      codeDiff: null
    })
  );
  const entryCalls = queries.callsTo("getDirectImports").filter((args) => args[0] === "src/main.tsx");
  assert.deepEqual(entryCalls, [["src/main.tsx", "head"]]);
  assert.deepEqual(sectionOf(first, "app_entry").body, sectionOf(second, "app_entry").body);
  assert.ok(sectionOf(first, "app_entry").body.includes("// file: src/App.tsx\nexport default function App()"));
});

test("empty source-query result omits only that section", async (t) => {
  const { builder } = setup(t, { typeSources: {}, callSites: {} });
  const ids = sectionIds(await builder.build(candidate()));
  assert.ok(!ids.includes("referenced_types"));
  assert.ok(!ids.includes("call_sites"));
  for (const id of [
    "head_source",
    "base_source",
    "code_diff",
    "direct_imports",
    "stories_tests",
    "app_entry",
    "dependencies",
    "global_styles"
  ] as const) {
    assert.ok(ids.includes(id), id);
  }

  // an unexpected exception in one section is logged and only that section is omitted
  const logs = recordLogger();
  t.after(logs.restore);
  const { builder: failing, queries } = setup(t);
  queries.findCallSites = () => Promise.reject(new Error("boom"));
  const pkg = await failing.build(candidate());
  assert.ok(!sectionIds(pkg).includes("call_sites"));
  assert.ok(sectionIds(pkg).includes("referenced_types"));
  assert.ok(
    logs.lines.some((line) => line.event === "harness.context.section_failed" && line.section === "call_sites")
  );
});

test("uses only ComponentSourceQueries (no ImportGraph, no service instance)", () => {
  const dir = path.join(__dirname, "../../../backend/src/services/visualizations/pipeline");
  for (const file of [
    "harness-context-builder.ts",
    "harness-generation-service.ts",
    "harness-validator.ts",
    "harness-prompts.ts",
    "ai-usage-recorder.ts"
  ]) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(
      source,
      /ImportGraph|import-graph|ChangeAnalysisService|change-analysis-service|component-source-queries|from "diff"/,
      file
    );
  }
  assert.equal(HarnessContextBuilder.length, 2, "constructor(ctx, queries, fsReader?)");
});
