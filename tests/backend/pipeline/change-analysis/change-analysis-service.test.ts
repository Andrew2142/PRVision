import assert from "node:assert/strict";
import { test, type TestContext as NodeTestContext } from "node:test";
import { Table } from "../../../../backend/src/enums";
import {
  ChangeAnalysisService,
  rankAndCap
} from "../../../../backend/src/services/visualizations/pipeline/change-analysis-service";
import type { DraftCandidate } from "../../../../backend/src/types/change-analysis";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type PipelineContext
} from "../../../../backend/src/types/visualization-pipeline";
import { GitCommandError, type GitNameStatusEntry } from "../../../../backend/src/utilities/services/git-client";
import {
  ALIAS_TSCONFIG,
  diffEntries,
  makeContext,
  makeWorktrees,
  stubGitClient,
  stubPersistence,
  type FileMap,
  type StubPersistence,
  type TestContext
} from "./helpers/worktree-fixture";

interface RunOptions {
  entries?: GitNameStatusEntry[] | Error;
  persistence?: StubPersistence;
  repo?: Partial<PipelineContext["repository"]>;
  tweak?: (ctx: TestContext) => void;
}

async function analyze(
  t: NodeTestContext,
  base: FileMap,
  head: FileMap,
  options: RunOptions = {}
): Promise<{ result: ChangeAnalysisResult; ctx: TestContext; persistence: StubPersistence }> {
  const wt = await makeWorktrees({ base, head });
  t.after(() => wt.cleanup());
  const persistence = options.persistence ?? stubPersistence();
  const ctx = makeContext(
    { baseDir: wt.baseDir, headDir: wt.headDir },
    { tsconfigPath: "tsconfig.json", ...options.repo }
  );
  options.tweak?.(ctx);
  const service = new ChangeAnalysisService({
    gitClient: stubGitClient(options.entries ?? diffEntries(base, head)),
    ...persistence
  });
  const result = await service.analyze(ctx);
  return { result, ctx, persistence };
}

async function analyzeRejects(
  t: NodeTestContext,
  base: FileMap,
  head: FileMap,
  code: string,
  options: RunOptions = {}
): Promise<PipelineStepError> {
  let caught: unknown;
  try {
    await analyze(t, base, head, options);
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof PipelineStepError, `expected PipelineStepError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  assert.equal(caught.stage, "analyzing");
  return caught;
}

const rows = (r: ChangeAnalysisResult): unknown[] =>
  r.candidates.map((c) => [c.rank, c.filePath, c.exportName, c.changeKind, c.reason]);

const EXAMPLE_A_BASE = `import { memo, forwardRef } from "react";
import styles from "./Button.module.css";
export interface ButtonProps { label: string; variant?: "primary" | "ghost" }
const cx = (...c: Array<string | false>) => c.filter(Boolean).join(" ");
export function Button({ label, variant = "primary" }: ButtonProps) {
  return <button className={cx(styles.btn, variant === "ghost" && styles.ghost)}>{label}</button>;
}
export const IconButton = memo(forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => <button ref={ref}>{p.icon}</button>));
export const useButtonSize = (): number => 32;
`;
const EXAMPLE_A_HEAD = EXAMPLE_A_BASE.replace("{label}</button>", "{label.toUpperCase()}</button>").replace(
  `memo(forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => <button ref={ref}>{p.icon}</button>));`,
  `memo(\n  forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => (\n    <button ref={ref}>{p.icon}</button>\n  )),\n);`
);

test("Example A: only changed export becomes modified", async (t) => {
  const files = { "tsconfig.json": ALIAS_TSCONFIG, "src/components/Button.module.css": ".btn{}" };
  const { result } = await analyze(
    t,
    { ...files, "src/components/Button.tsx": EXAMPLE_A_BASE },
    { ...files, "src/components/Button.tsx": EXAMPLE_A_HEAD }
  );
  assert.deepEqual(rows(result), [[0, "src/components/Button.tsx", "Button", "modified", "Component code changed"]]);
  assert.equal(result.candidates[0]?.displayName, "Button");
});

const EXAMPLE_B: FileMap = {
  "tsconfig.json": ALIAS_TSCONFIG,
  "src/hooks/useCart.ts": `export function useCart() { return 1 }\nexport const CART_LIMIT = 10;\n`,
  "src/hooks/useAuth.ts": `export function useAuth() { return 1 }\n`,
  "src/hooks/index.ts": `export * from "./useCart";\nexport * from "./useAuth";\n`,
  "src/components/CartBadge.tsx": `import { useCart } from "@/hooks/useCart";\nexport function CartBadge() { const c = useCart(); return <b>{c}</b> }\n`,
  "src/components/CartLimitNote.tsx": `import { CART_LIMIT } from "@/hooks/useCart";\nexport const CartLimitNote = () => <p>{CART_LIMIT}</p>;\n`,
  "src/pages/CheckoutPage.tsx": `import { useCart } from "../hooks";\nexport default function CheckoutPage() { useCart(); return <main/> }\n`,
  "src/pages/AdminPage.tsx": `import { useAuth } from "../hooks";\nexport default function AdminPage() { useAuth(); return <main/> }\n`,
  "src/components/CartBadge.test.tsx": `import { CartBadge } from "./CartBadge";\nexport const T = () => <CartBadge/>;\n`
};

test("Example B: hook change yields two affected parents with reasons", async (t) => {
  const head = {
    ...EXAMPLE_B,
    "src/hooks/useCart.ts": `export function useCart() { return 2 }\nexport const CART_LIMIT = 10;\n`
  };
  const { result, ctx } = await analyze(t, EXAMPLE_B, head);
  assert.deepEqual(
    result.candidates.map((c) => [c.filePath, c.exportName, c.displayName, c.changeKind, c.codeDiff, c.reason]),
    [
      [
        "src/components/CartBadge.tsx",
        "CartBadge",
        "CartBadge",
        "affected_parent",
        null,
        "Imports changed hook src/hooks/useCart.ts"
      ],
      [
        "src/pages/CheckoutPage.tsx",
        "default",
        "CheckoutPage",
        "affected_parent",
        null,
        "Imports changed hook src/hooks/useCart.ts via src/hooks/index.ts"
      ]
    ]
  );
  assert.ok(
    ctx.consoleEvents.some(
      (e) => e.message === "hook src/hooks/useCart.ts changed: also rendering CartBadge, CheckoutPage."
    )
  );
});

test("Example C: formatting-only change yields no candidates and info event", async (t) => {
  const base = {
    "src/components/Card.tsx": `// card\nexport function Card() { return <div className='card'><span>{1}</span></div> }\n`
  };
  const head = {
    "src/components/Card.tsx": `// the card component\nexport function Card() {\n  return (\n    <div className="card">\n      <span>{1}</span>\n    </div>\n  );\n}\n`
  };
  const { result, ctx, persistence } = await analyze(t, base, head);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.changedFiles, [{ path: "src/components/Card.tsx", status: "M" }]);
  assert.ok(
    ctx.consoleEvents.some(
      (e) => e.level === "info" && e.message === "No React components are affected by this change."
    )
  );
  assert.deepEqual(persistence.inserted, []);
});

test("Example D: CSS module change marks owning component modified with stylesheet diff", async (t) => {
  const base: FileMap = {
    "src/components/Card.module.css": `.card { padding: 12px }\n`,
    "src/components/Card.tsx": `import styles from "./Card.module.css";\nexport function Card() { return <div className={styles.card}/> }\n`,
    "src/pages/Home.tsx": `import { Card } from "../components/Card";\nexport default function Home() { return <Card/> }\n`
  };
  const head = { ...base, "src/components/Card.module.css": `.card { padding: 16px }\n` };
  const { result } = await analyze(t, base, head);
  assert.deepEqual(rows(result), [
    [0, "src/components/Card.tsx", "Card", "modified", "Uses changed stylesheet src/components/Card.module.css"]
  ]);
  assert.match(result.candidates[0]?.codeDiff ?? "", /^diff --git a\/src\/components\/Card\.module\.css/);
  assert.match(result.candidates[0]?.codeDiff ?? "", /\+\.card \{ padding: 16px \}/);
});

test("Example E: deleted file yields removed default export; rename yields modified with rename header", async (t) => {
  const base: FileMap = {
    "src/components/Banner.tsx": `export default function Banner() { return <aside/> }\n`,
    "src/components/Old.tsx": `export function Notice() {\n  return <p>a</p>;\n}\n// line\n// line\n// line\n`
  };
  const head: FileMap = {
    "src/components/Notice.tsx": `export function Notice() {\n  return <p>b</p>;\n}\n// line\n// line\n// line\n`
  };
  const { result } = await analyze(t, base, head, {
    entries: [
      { status: "D", path: "src/components/Banner.tsx" },
      { status: "R", score: 92, path: "src/components/Notice.tsx", previousPath: "src/components/Old.tsx" }
    ]
  });
  assert.deepEqual(
    result.candidates.map((c) => [c.filePath, c.exportName, c.displayName, c.changeKind, c.reason]),
    [
      ["src/components/Notice.tsx", "Notice", "Notice", "modified", "Component code changed"],
      ["src/components/Banner.tsx", "default", "Banner", "removed", "File deleted"]
    ]
  );
  assert.match(result.candidates[1]?.codeDiff ?? "", /deleted file mode 100644/);
  assert.match(
    result.candidates[0]?.codeDiff ?? "",
    /rename from src\/components\/Old\.tsx\nrename to src\/components\/Notice\.tsx/
  );
  assert.deepEqual(result.changedFiles, [
    { path: "src/components/Banner.tsx", status: "D" },
    { path: "src/components/Notice.tsx", status: "R", previousPath: "src/components/Old.tsx" }
  ]);
});

function draft(partial: Partial<DraftCandidate> & Pick<DraftCandidate, "filePath" | "changeKind">): DraftCandidate {
  return {
    exportName: "default",
    displayName: "X",
    codeDiff: partial.changeKind === "affected_parent" ? null : "diff",
    reason: "r",
    diffSize: 0,
    depth: partial.changeKind === "affected_parent" ? 1 : 0,
    forcedSkipReason: null,
    ...partial
  };
}

test("Example F: ranking order and over_limit skip reasons", async (t) => {
  const drafts: DraftCandidate[] = [
    draft({ filePath: "src/p1.tsx", changeKind: "affected_parent", depth: 2 }),
    draft({ filePath: "src/p2.tsx", changeKind: "affected_parent", depth: 1 }),
    draft({ filePath: "src/p3.tsx", changeKind: "affected_parent", depth: 1, diffSize: 5 }),
    draft({ filePath: "src/r.tsx", changeKind: "removed" }),
    draft({ filePath: "src/a2.tsx", changeKind: "added" }),
    draft({ filePath: "src/a1.tsx", changeKind: "added" }),
    ...[40, 40, 12, 9, 8, 7, 6, 5, 4].map((size, i) =>
      draft({ filePath: `src/m${String(9 - i)}.tsx`, changeKind: "modified", diffSize: size })
    ),
    draft({ filePath: "src/m1.tsx", changeKind: "modified", diffSize: 7, exportName: "Named" })
  ].slice(0, 15);
  const { ordered, rendered, skipReasons } = rankAndCap(drafts, 12);
  assert.deepEqual(
    ordered.map((d) => `${d.changeKind}:${d.filePath}`).slice(0, 2),
    ["modified:src/m8.tsx", "modified:src/m9.tsx"],
    "equal diff sizes order by path"
  );
  assert.deepEqual(
    ordered.slice(9).map((d) => `${d.changeKind}:${d.filePath}`),
    [
      "added:src/a1.tsx",
      "added:src/a2.tsx",
      "removed:src/r.tsx",
      "affected_parent:src/p3.tsx",
      "affected_parent:src/p2.tsx",
      "affected_parent:src/p1.tsx"
    ]
  );
  assert.equal(rendered.size, 12);
  assert.equal(
    skipReasons.get("src/p3.tsx\u0000default"),
    "over_limit: ranked 13 of 15; PRVision renders at most 12 components per visualization"
  );
  assert.equal(skipReasons.size, 3);

  // Service: 13 new components → one skipped with a warning.
  const many = Array.from({ length: 13 }, (_, i) => `export const C${String(i).padStart(2, "0")} = () => <i/>;`).join(
    "\n"
  );
  const { result, ctx, persistence } = await analyze(t, {}, { "src/Many.tsx": many });
  assert.equal(result.candidates.length, 12);
  assert.deepEqual(
    result.skipped.map((s) => [s.exportName, s.rank, s.skipReason]),
    [["C12", 12, "over_limit: ranked 13 of 13; PRVision renders at most 12 components per visualization"]]
  );
  assert.ok(ctx.consoleEvents.some((e) => e.level === "warn" && e.message === "1 components were skipped (limit 12)."));
  const inserted = persistence.inserted[0] ?? [];
  assert.equal(inserted.filter((row) => row.renderStatus === "skipped").length, 1);
});

test("added file yields added components", async (t) => {
  const { result } = await analyze(
    t,
    {},
    { "src/components/Badge.tsx": `export const Badge = () => <span/>;\nexport function Pill() { return <b/> }\n` }
  );
  assert.deepEqual(rows(result), [
    [0, "src/components/Badge.tsx", "Badge", "added", "New file"],
    [1, "src/components/Badge.tsx", "Pill", "added", "New file"]
  ]);
});

test("dedupe keeps modified over affected_parent", async (t) => {
  const base: FileMap = {
    "src/u.ts": `export const u = 1;\n`,
    "src/A.tsx": `import { u } from "./u";\nexport const A = () => <i>{u}</i>;\n`
  };
  const head: FileMap = {
    "src/u.ts": `export const u = 2;\n`,
    "src/A.tsx": `import { u } from "./u";\nexport const A = () => <b>{u}</b>;\n`
  };
  const { result } = await analyze(t, base, head);
  assert.deepEqual(rows(result), [[0, "src/A.tsx", "A", "modified", "Component code changed"]]);
});

test("codeDiff is null for affected_parent", async (t) => {
  const head = {
    ...EXAMPLE_B,
    "src/hooks/useCart.ts": `export function useCart() { return 3 }\nexport const CART_LIMIT = 10;\n`
  };
  const { result, persistence } = await analyze(t, EXAMPLE_B, head);
  assert.ok(result.candidates.length > 0);
  for (const candidate of result.candidates) {
    assert.equal(candidate.codeDiff, null);
  }
  for (const row of persistence.inserted[0] ?? []) {
    assert.equal(row.codeDiff, null);
  }
});

test("persists rows in one transaction, deletes previous rows, updates component_count", async (t) => {
  const { persistence } = await analyze(
    t,
    {},
    { "src/A.tsx": `export const A = () => <i/>;\nexport const B = () => <b/>;\n` }
  );
  assert.equal(persistence.transactions, 1);
  assert.deepEqual(persistence.deleted, [{ visualizationId: 1 }]);
  assert.equal(persistence.inserted.length, 1);
  assert.equal(persistence.inserted[0]?.length, 2);
  assert.deepEqual(persistence.updates, [
    { values: { componentCount: 2 }, conditions: { id: 1 }, table: Table.VISUALIZATIONS }
  ]);
});

test("maps component ids by key not insert order", async (t) => {
  const { result } = await analyze(
    t,
    {},
    { "src/A.tsx": `export const A = () => <i/>;\nexport const B = () => <b/>;\nexport const C = () => <u/>;\n` }
  );
  assert.deepEqual(
    result.candidates.map((c) => [c.exportName, c.componentId, c.rank]),
    [
      ["A", 100, 0],
      ["B", 101, 1],
      ["C", 102, 2]
    ]
  );
});

test("writes change_reason for every row and skip_reason for skipped rows only", async (t) => {
  const many = Array.from({ length: 14 }, (_, i) => `export const C${String(i).padStart(2, "0")} = () => <i/>;`).join(
    "\n"
  );
  const { persistence } = await analyze(t, {}, { "src/Many.tsx": many });
  const inserted = persistence.inserted[0] ?? [];
  assert.equal(inserted.length, 14);
  for (const row of inserted) {
    assert.equal(row.changeReason, "New file");
    if (row.renderStatus === "pending") {
      assert.equal(row.skipReason, null);
    } else {
      assert.equal(row.renderStatus, "skipped");
      assert.match(String(row.skipReason), /^over_limit: ranked 1[34] of 14;/);
    }
  }
});

test("never writes harness_notes", async (t) => {
  const { persistence } = await analyze(t, {}, { "src/A.tsx": `export const A = () => <i/>;\n` });
  for (const row of persistence.inserted.flat()) {
    assert.equal("harnessNotes" in row, false);
  }
  for (const update of persistence.updates) {
    assert.equal(JSON.stringify(update).includes("harnessNotes"), false);
  }
});

test("throws ANALYSIS_GIT_DIFF_FAILED when git fails", async (t) => {
  const error = await analyzeRejects(t, {}, {}, "ANALYSIS_GIT_DIFF_FAILED", {
    entries: new GitCommandError("git diff failed (unknown_revision)", "unknown_revision", "diff", 128, "")
  });
  assert.equal(error.userMessage, "Could not list the changed files (git diff failed).");
});

test("throws ANALYSIS_WORKTREE_MISSING", async () => {
  const ctx = makeContext({ baseDir: "/nonexistent/prvision/base", headDir: "/nonexistent/prvision/head" });
  const service = new ChangeAnalysisService({ gitClient: stubGitClient([]), ...stubPersistence() });
  await assert.rejects(service.analyze(ctx), (error: unknown) => {
    assert.ok(error instanceof PipelineStepError);
    assert.equal(error.code, "ANALYSIS_WORKTREE_MISSING");
    assert.equal(error.userMessage, "The prepared workspace is missing. Start the visualization again.");
    return true;
  });
});

test("throws ANALYSIS_CANCELLED when cancelled before persist and writes nothing", async (t) => {
  const persistence = stubPersistence();
  let calls = 0;
  await analyzeRejects(t, {}, { "src/A.tsx": `export const A = () => <i/>;\n` }, "ANALYSIS_CANCELLED", {
    persistence,
    tweak: (ctx) => {
      ctx.isCancelled = () => {
        calls++;
        return Promise.resolve(calls >= 4);
      };
    }
  });
  assert.equal(calls, 4, "fourth checkpoint is the one right before persisting");
  assert.equal(persistence.transactions, 0);
  assert.deepEqual(persistence.inserted, []);
  await analyzeRejects(t, {}, { "src/A.tsx": `export const A = () => <i/>;\n` }, "ANALYSIS_CANCELLED", {
    tweak: (ctx) => {
      ctx.cancel();
    }
  });
});

test("throws ANALYSIS_PERSIST_FAILED when insert fails", async (t) => {
  const persistence = stubPersistence({ insertStatus: 500 });
  const error = await analyzeRejects(
    t,
    {},
    { "src/A.tsx": `export const A = () => <i/>;\n` },
    "ANALYSIS_PERSIST_FAILED",
    {
      persistence
    }
  );
  assert.equal(error.userMessage, "Could not save the list of components.");
  assert.match(error.message, /^ANALYSIS_PERSIST_FAILED: insert failed \(500\)/);
  assert.equal(persistence.rolledBack, 1);
  await analyzeRejects(t, {}, { "src/A.tsx": `export const A = () => <i/>;\n` }, "ANALYSIS_PERSIST_FAILED", {
    persistence: stubPersistence({ insertThrows: true })
  });
});

test("warns about tailwind.config change outside src", async (t) => {
  const { result, ctx } = await analyze(t, { "tailwind.config.ts": "a" }, { "tailwind.config.ts": "b" });
  assert.deepEqual(result.changedFiles, [{ path: "tailwind.config.ts", status: "M" }]);
  assert.deepEqual(result.candidates, []);
  assert.ok(
    ctx.consoleEvents.some(
      (e) =>
        e.level === "warn" &&
        e.message ===
          "tailwind.config.ts changed. PRVision does not analyse it; components may look different for reasons not shown here."
    )
  );
});

test("no analysable changes persists nothing and returns empty result", async (t) => {
  const { result, persistence, ctx } = await analyze(t, { "README.md": "a" }, { "README.md": "b" });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(persistence.inserted, []);
  assert.deepEqual(persistence.deleted, [{ visualizationId: 1 }]);
  assert.deepEqual(persistence.updates, [
    { values: { componentCount: 0 }, conditions: { id: 1 }, table: Table.VISUALIZATIONS }
  ]);
  assert.ok(ctx.consoleEvents.some((e) => e.message === "1 changed files, 0 of them React/TS/CSS sources under src/"));
  assert.deepEqual(await result.sourceQueries.getModuleExports("src/missing.ts", "head"), null);
});
