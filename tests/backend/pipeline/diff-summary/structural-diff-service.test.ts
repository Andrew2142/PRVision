import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { ComponentDetector } from "../../../../backend/src/services/visualizations/pipeline/component-detector";
import {
  StructuralDiffService,
  buildJsxTree,
  classNameTokens,
  diffJsxTrees,
  newJsxBudget,
  type JsxElementNode
} from "../../../../backend/src/services/visualizations/pipeline/structural-diff-service";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type ComponentRenderResult,
  type ComponentSourceQueries,
  type StructuralChange
} from "../../../../backend/src/types/visualization-pipeline";
import { createPipelineContext } from "../../helpers/pipeline-context";
import { VISUALIZATION_ID, failedSide, okSide, recordingQueryHandler } from "./helpers/png-fixtures";

const detector = new ComponentDetector();
const BASE_DIR = "/worktrees/1/base";
const HEAD_DIR = "/worktrees/1/head";

/** Element roots of `exportName` in `source` (the service's own pipeline: parse → findExport → findRenderRoots). */
function rootsOf(source: string, exportName: string): JsxElementNode[] {
  const sf = detector.parse("src/C.tsx", source);
  const resolved = detector.findExport(sf, exportName);
  assert.ok(resolved, `export ${exportName} found`);
  const budget = newJsxBudget();
  return detector
    .findRenderRoots(resolved)
    .flatMap((expr) => buildJsxTree(expr, sf, budget))
    .filter((node): node is JsxElementNode => node.kind === "element");
}

/** Wraps JSX in `export function C() { return (…); }`. */
function component(jsx: string, preamble = ""): string {
  return `export function C({ items, props, rest, active, size, open, loading, name, user, t }: any) {\n${preamble}\n  return (\n    ${jsx}\n  );\n}\n`;
}

function diffJsx(baseJsx: string, headJsx: string): StructuralChange[] {
  return diffJsxTrees(rootsOf(component(baseJsx), "C"), rootsOf(component(headJsx), "C")).changes;
}

function candidate(componentId: number, overrides: Partial<ComponentCandidate> = {}): ComponentCandidate {
  return {
    componentId,
    filePath: `src/components/C${String(componentId)}.tsx`,
    exportName: "C",
    displayName: `C${String(componentId)}`,
    changeKind: "modified",
    rank: componentId,
    codeDiff: null,
    reason: "Component code changed",
    ...overrides
  };
}

function analysisOf(
  candidates: ComponentCandidate[],
  changedFiles: ChangeAnalysisResult["changedFiles"] = []
): ChangeAnalysisResult {
  return {
    candidates,
    skipped: [],
    changedFiles,
    sourceQueries: {} as ComponentSourceQueries
  };
}

/** Failed head render on a modified component: the structural diff runs. */
function headFailed(componentId: number): ComponentRenderResult {
  return {
    componentId,
    base: okSide("base", componentId),
    head: failedSide("head")
  };
}

function setupService(files: { base?: Record<string, string>; head?: Record<string, string> }, componentIds: number[]) {
  const db = recordingQueryHandler(componentIds.map((id) => ({ id })));
  const handle = createPipelineContext({
    visualizationId: VISUALIZATION_ID,
    dataDir: "/tmp/unused",
    repositoryPath: "/tmp/repo",
    baseDir: BASE_DIR,
    headDir: HEAD_DIR
  });
  const reads: string[] = [];
  const service = new StructuralDiffService({
    createQueryHandler: () => db.asQueryHandler(),
    readSource: (root, repoPath) => {
      reads.push(`${root === BASE_DIR ? "base" : "head"}:${repoPath}`);
      const side = root === BASE_DIR ? files.base : files.head;
      return Promise.resolve(side?.[repoPath] ?? null);
    }
  });
  return { db, handle, service, reads };
}

const PRICE_TAG_BASE = `export function PriceTag({ price, sale }: Props) {
  if (!price) return <Skeleton />;
  return (
    <div className="flex gap-2 text-sm">
      <span className="font-bold">{price}</span>
      {sale && <Badge tone="red">Sale</Badge>}
    </div>
  );
}
`;

const PRICE_TAG_HEAD = `export function PriceTag({ price, sale }: Props) {
  if (!price) return <Skeleton />;
  return (
    <div className="flex gap-3 text-sm">
      <span className="font-bold">{formatPrice(price)}</span>
      {sale && <Badge tone="green">Sale!</Badge>}
      <Info />
    </div>
  );
}
`;

test("runs only for components without pixel output", async () => {
  const source = component(`<div className="a"><span>Hi</span></div>`);
  const { db, handle, service } = setupService(
    {
      base: {
        "src/components/C1.tsx": source,
        "src/components/C2.tsx": source
      },
      head: {
        "src/components/C1.tsx": source,
        "src/components/C2.tsx": source
      }
    },
    [1, 2]
  );
  const outcomes = await service.compare(handle.context, {
    renders: [{ componentId: 1, base: okSide("base", 1), head: okSide("head", 1) }, headFailed(2)],
    diffs: [
      {
        componentId: 1,
        diffImagePath: "artifacts/1/1/diff.png",
        diffPixelRatio: 0,
        width: 100,
        height: 50
      }
    ],
    analysis: analysisOf([candidate(1), candidate(2)])
  });
  assert.deepEqual(outcomes, [
    { componentId: 1, ran: false, changes: null, truncated: false, note: null },
    { componentId: 2, ran: true, changes: [], truncated: false, note: null }
  ]);
  assert.deepEqual(db.updatesFor(1), []);
  assert.deepEqual(db.updatesFor(2), [{ structuralDiff: [] }]);
  assert.ok(
    handle.console.has("info", "Comparing JSX structure for 1 components that could not be compared visually.")
  );
});

test("a replaced row compares R's JSX on base with A's JSX on head (00 §17)", async () => {
  const oldForm = `export function NoteForm() {\n  return <form className="p-4"><textarea /></form>;\n}\n`;
  const newForm = `export function NoteFormModal() {\n  return <div role="dialog"><form className="p-4"><textarea /></form></div>;\n}\n`;
  const { db, handle, service, reads } = setupService(
    { base: { "src/components/NoteForm.tsx": oldForm }, head: { "src/components/NoteFormModal.tsx": newForm } },
    [1]
  );
  const replaced = candidate(1, {
    filePath: "src/components/NoteFormModal.tsx",
    exportName: "NoteFormModal",
    displayName: "NoteFormModal",
    changeKind: "replaced",
    predecessor: {
      filePath: "src/components/NoteForm.tsx",
      exportName: "NoteForm",
      displayName: "NoteForm",
      evidence: []
    }
  });
  const outcomes = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([replaced])
  });
  assert.deepEqual(reads, ["base:src/components/NoteForm.tsx", "head:src/components/NoteFormModal.tsx"]);
  assert.equal(outcomes[0]?.note, null);
  assert.deepEqual(outcomes[0].changes, [
    { kind: "element_removed", path: "form", tag: "form" },
    { kind: "element_added", path: "div", tag: "div" }
  ]);
  assert.deepEqual(db.updatesFor(1), [{ structuralDiff: outcomes[0].changes }]);
});

test("does not run for new and deleted with ok side", async () => {
  const { db, handle, service, reads } = setupService({}, [1, 2, 3]);
  const outcomes = await service.compare(handle.context, {
    renders: [
      { componentId: 1, base: null, head: okSide("head", 1) },
      { componentId: 2, base: okSide("base", 2), head: null },
      { componentId: 3, base: null, head: null }
    ],
    diffs: [],
    analysis: analysisOf([candidate(1, { changeKind: "added" }), candidate(2, { changeKind: "removed" }), candidate(3)])
  });
  assert.ok(outcomes.every((outcome) => !outcome.ran && outcome.changes === null));
  assert.equal(db.updates.length, 0);
  assert.equal(reads.length, 0);
  assert.equal(handle.console.events.length, 0);
});

test("PriceTag example produces the expected changes", async () => {
  const filePath = "src/components/PriceTag.tsx";
  const { db, handle, service } = setupService(
    {
      base: { [filePath]: PRICE_TAG_BASE },
      head: { [filePath]: PRICE_TAG_HEAD }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([
      candidate(1, {
        filePath,
        exportName: "PriceTag",
        displayName: "PriceTag"
      })
    ])
  });
  const expected: StructuralChange[] = [
    {
      kind: "attribute_changed",
      path: "return[1] > div",
      tag: "div",
      attribute: "className",
      before: "flex gap-2 text-sm",
      after: "flex gap-3 text-sm",
      tokensAdded: ["gap-3"],
      tokensRemoved: ["gap-2"]
    },
    {
      kind: "text_changed",
      path: "return[1] > div > span > #text[0]",
      before: "{price}",
      after: "{formatPrice(price)}"
    },
    {
      kind: "attribute_changed",
      path: "return[1] > div > Badge",
      tag: "Badge",
      attribute: "tone",
      before: "red",
      after: "green"
    },
    {
      kind: "text_changed",
      path: "return[1] > div > Badge > #text[0]",
      before: "Sale",
      after: "Sale!"
    },
    { kind: "element_added", path: "return[1] > div > Info", tag: "Info" }
  ];
  assert.deepEqual(outcome?.changes, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(db.updatesFor(1)[0]?.structuralDiff)), expected);
});

test("literal attribute change", () => {
  assert.deepEqual(diffJsx(`<button title="Save">Go</button>`, `<button title={"Store"}>Go</button>`), [
    {
      kind: "attribute_changed",
      path: "button",
      tag: "button",
      attribute: "title",
      before: "Save",
      after: "Store"
    }
  ]);
});

test("boolean attribute added", () => {
  assert.deepEqual(diffJsx(`<input type="text" />`, `<input type="text" disabled />`), [
    {
      kind: "attribute_changed",
      path: "input",
      tag: "input",
      attribute: "disabled",
      before: null,
      after: "true"
    }
  ]);
});

test("spread attribute change", () => {
  assert.deepEqual(diffJsx(`<div {...props} id="x" />`, `<div {...rest} id="x" />`), [
    {
      kind: "attribute_changed",
      path: "div",
      tag: "div",
      attribute: "{...props}",
      before: "spread",
      after: null
    },
    {
      kind: "attribute_changed",
      path: "div",
      tag: "div",
      attribute: "{...rest}",
      before: null,
      after: "spread"
    }
  ]);
});

test("expression attribute stores source text", () => {
  assert.deepEqual(diffJsx(`<a title={t("save")} icon={<Plus />} />`, `<a title={t( "store" )} icon={<Minus />} />`), [
    {
      kind: "attribute_changed",
      path: "a",
      tag: "a",
      attribute: "icon",
      before: "{<Plus />}",
      after: "{<Minus />}"
    },
    {
      kind: "attribute_changed",
      path: "a",
      tag: "a",
      attribute: "title",
      before: '{t("save")}',
      after: '{t( "store" )}'
    }
  ]);
});

test("className token diff with cn() and conditionals", () => {
  const changes = diffJsx(
    `<div className={cn("px-4 py-2", active && "bg-blue-500", size === "lg" ? "text-lg" : "text-sm", { hidden: !open })} />`,
    `<div className={cn("px-4 py-3", active && "bg-indigo-500", size === "lg" ? "text-lg" : "text-sm", { hidden: !open, "font-bold": active })} />`
  );
  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.ok(change?.kind === "attribute_changed");
  assert.equal(change.attribute, "className");
  assert.deepEqual(change.tokensAdded, ["bg-indigo-500", "font-bold", "py-3"]);
  assert.deepEqual(change.tokensRemoved, ["bg-blue-500", "py-2"]);
});

test("className reorder only is not a change", () => {
  assert.deepEqual(diffJsx(`<div className="px-4 py-2 flex" />`, `<div className="flex px-4  py-2" />`), []);
  assert.deepEqual(
    diffJsx(`<div className={clsx("a", ["b", "c"])} />`, `<div className={clsx(["c", "b"], "a")} />`),
    []
  );
});

test("template literal className tokens", () => {
  const sf = detector.parse("src/C.tsx", "const x = <div className={`btn ${size} active`} />;");
  let initializer: ts.JsxAttributeValue | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.deepEqual(classNameTokens(initializer, sf), ["btn", "${size}", "active"]);
  assert.deepEqual(diffJsx("<div className={`btn ${size} active`} />", "<div className={`active btn ${size}`} />"), []);
});

test("keyed children reorder is not a change", () => {
  assert.deepEqual(
    diffJsx(
      `<ul><li key="a">A</li><li key="b">B</li><li key="c">C</li></ul>`,
      `<ul><li key="c">C</li><li key="a">A</li><li key="b">B</li></ul>`
    ),
    []
  );
});

test("unkeyed same-tag siblings use [i] paths", () => {
  assert.deepEqual(diffJsx(`<ul><li>A</li><li>B</li><p>x</p></ul>`, `<ul><li>A</li><li>Bee</li><p>x</p></ul>`), [
    {
      kind: "text_changed",
      path: "ul > li[1] > #text[0]",
      before: "B",
      after: "Bee"
    }
  ]);
});

test("element added and removed report subtree root only", () => {
  assert.deepEqual(
    diffJsx(
      `<div><aside><p>Old</p><p>Older</p></aside></div>`,
      `<div><section><h2>Title</h2><p>Body</p></section></div>`
    ),
    [
      { kind: "element_added", path: "div > section", tag: "section" },
      { kind: "element_removed", path: "div > aside", tag: "aside" }
    ]
  );
});

test("root tag change yields removed + added", () => {
  assert.deepEqual(diffJsx(`<div className="a" />`, `<section className="a" />`), [
    { kind: "element_removed", path: "div", tag: "div" },
    { kind: "element_added", path: "section", tag: "section" }
  ]);
});

test("text literal and expression text changes", () => {
  assert.deepEqual(diffJsx(`<p>Hello {name}{"!"}</p>`, `<p>Hi {user.name}{"!"}</p>`), [
    {
      kind: "text_changed",
      path: "p > #text[0]",
      before: "Hello ",
      after: "Hi "
    },
    {
      kind: "text_changed",
      path: "p > #text[1]",
      before: "{name}",
      after: "{user.name}"
    }
  ]);
});

test("map callback JSX is expanded", () => {
  assert.deepEqual(
    diffJsx(
      `<List>{items.map((item) => <Row key={item.id} tone="a" />)}</List>`,
      `<List>{items.map((item) => { return <Row key={item.id} tone="b" />; })}</List>`
    ),
    [
      {
        kind: "attribute_changed",
        path: "List > Row{key={item.id}}",
        tag: "Row",
        attribute: "tone",
        before: "a",
        after: "b"
      }
    ]
  );
});

test("conditional branches are both expanded", () => {
  assert.deepEqual(
    diffJsx(
      `<div>{loading ? <Spinner /> : <Content />}{open || <Closed />}</div>`,
      `<div>{loading ? <Spinner /> : <Body />}{open || <Closed />}</div>`
    ),
    [
      { kind: "element_added", path: "div > Body", tag: "Body" },
      { kind: "element_removed", path: "div > Content", tag: "Content" }
    ]
  );
});

test("multiple returns use return[i] prefix", () => {
  const base = `export function C({ loading }: any) {\n  if (loading) return <Spinner size="s" />;\n  return <main><h1>T</h1></main>;\n}\n`;
  const head = `export function C({ loading }: any) {\n  if (loading) return <Spinner size="m" />;\n  return <main><h1>T</h1></main>;\n}\n`;
  assert.deepEqual(diffJsxTrees(rootsOf(base, "C"), rootsOf(head, "C")).changes, [
    {
      kind: "attribute_changed",
      path: "return[0] > Spinner",
      tag: "Spinner",
      attribute: "size",
      before: "s",
      after: "m"
    }
  ]);
});

test("fragment normalised to Fragment", () => {
  const roots = rootsOf(component(`<React.Fragment key="k"><A /></React.Fragment>`), "C");
  assert.equal(roots[0]?.tag, "Fragment");
  assert.equal(roots[0].key, "k");
  assert.equal(rootsOf(component(`<Fragment><A /></Fragment>`), "C")[0]?.tag, "Fragment");
  assert.deepEqual(diffJsx(`<><A /><B /></>`, `<React.Fragment><A /><B /></React.Fragment>`), []);
});

test("missing component on head yields removals", async () => {
  const filePath = "src/components/C1.tsx";
  const { db, handle, service } = setupService(
    {
      base: { [filePath]: component(`<div><span /></div>`) },
      head: { [filePath]: "export const other = 1;\n" }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome?.changes, [{ kind: "element_removed", path: "div", tag: "div" }]);
  assert.equal(outcome.note, "export C not found on head");
  assert.deepEqual(db.updatesFor(1), [{ structuralDiff: [{ kind: "element_removed", path: "div", tag: "div" }] }]);
  assert.ok(handle.console.has("warn", "Could not compare the JSX of C1: export C not found on head."));
});

test("component returning children yields empty array", async () => {
  const filePath = "src/components/C1.tsx";
  const wrap = (extra: string): string =>
    `export function C({ children }: { children: React.ReactNode }) {\n  ${extra}\n  return children;\n}\n`;
  const { db, handle, service } = setupService(
    {
      base: { [filePath]: wrap("const a = 1;") },
      head: { [filePath]: wrap("const a = 2;") }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome?.changes, []);
  assert.equal(outcome.note, null);
  assert.deepEqual(db.updatesFor(1), [{ structuralDiff: [] }]);
});

test("limit 200 truncates", async () => {
  const filePath = "src/components/C1.tsx";
  const items = Array.from({ length: 250 }, (_, i) => `<li key="k${String(i)}">Item</li>`).join("");
  const { db, handle, service } = setupService(
    {
      base: { [filePath]: component(`<ul></ul>`) },
      head: { [filePath]: component(`<ul>${items}</ul>`) }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.equal(outcome?.changes?.length, 200);
  assert.equal(outcome.truncated, true);
  assert.equal((db.updatesFor(1)[0]?.structuralDiff as unknown[]).length, 200);
  assert.deepEqual(outcome.changes[199], {
    kind: "element_added",
    path: "ul > li{key=k199}",
    tag: "li"
  });
});

test("uses basePathFor for renamed files", async () => {
  const { handle, service, reads } = setupService(
    {
      base: { "src/components/OldName.tsx": component(`<div title="old" />`) },
      head: { "src/components/C1.tsx": component(`<div title="new" />`) }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf(
      [candidate(1)],
      [
        {
          path: "src/components/C1.tsx",
          status: "R",
          previousPath: "src/components/OldName.tsx"
        }
      ]
    )
  });
  assert.deepEqual(reads, ["base:src/components/OldName.tsx", "head:src/components/C1.tsx"]);
  assert.deepEqual(outcome?.changes, [
    {
      kind: "attribute_changed",
      path: "div",
      tag: "div",
      attribute: "title",
      before: "old",
      after: "new"
    }
  ]);
});

test("persists [] when no differences", async () => {
  const filePath = "src/components/C1.tsx";
  const source = component(`<section><h2>Same</h2></section>`);
  const { db, handle, service } = setupService({ base: { [filePath]: source }, head: { [filePath]: source } }, [1]);
  await service.compare(handle.context, {
    renders: [{ componentId: 1, base: failedSide("base"), head: failedSide("head") }],
    diffs: [],
    analysis: analysisOf([candidate(1, { changeKind: "affected_parent" })])
  });
  assert.deepEqual(db.updatesFor(1), [{ structuralDiff: [] }]);
  assert.equal(handle.console.messages("warn").length, 0);
});

test("parse failure stores [] and warns", async () => {
  const filePath = "src/components/C1.tsx";
  const { db, handle, service } = setupService(
    {
      base: { [filePath]: component(`<div />`) },
      head: { [filePath]: "export function C() { return <div><span></div>; " }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome?.changes, []);
  assert.equal(outcome.note, "could not parse the head source");
  assert.deepEqual(db.updatesFor(1), [{ structuralDiff: [] }]);
  assert.ok(handle.console.has("warn", "Could not compare the JSX of C1: could not parse the head source."));
});

test("unreadable source on a side is treated as empty with a note", async () => {
  const filePath = "src/components/C1.tsx";
  const { handle, service } = setupService({ base: { [filePath]: component(`<div />`) } }, [1]);
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome?.changes, [{ kind: "element_removed", path: "div", tag: "div" }]);
  assert.equal(outcome.note, "component source not found on head");
});

test("throws STRUCTURAL_DIFF_PERSIST_FAILED on update error", async () => {
  const filePath = "src/components/C1.tsx";
  const source = component(`<div />`);
  const { db, handle, service } = setupService({ base: { [filePath]: source }, head: { [filePath]: source } }, [1]);
  db.failNext("update");
  await assert.rejects(
    service.compare(handle.context, {
      renders: [headFailed(1)],
      diffs: [],
      analysis: analysisOf([candidate(1)])
    }),
    (error: unknown) => error instanceof PipelineStepError && error.code === "STRUCTURAL_DIFF_PERSIST_FAILED"
  );
});
