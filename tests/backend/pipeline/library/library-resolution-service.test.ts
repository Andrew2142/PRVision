/**
 * LibraryResolutionService (16 §8.4, 16d): per-row plans (reuse on both sides, renames, harness-less entries,
 * replaced rows, off_default_branch entries), the D9 pause on new harnesses, the over-limit skip, the D7 whole-library
 * re-check rows, the persisted counts and the console lines. In-memory library store and query handler.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIBRARY_RECHECK_MAX_COMPONENTS } from "../../../../backend/src/config-consts";
import { Table } from "../../../../backend/src/enums";
import {
  LibraryResolutionService,
  newHarnessPauseMessage,
  overLimitReason,
  recheckReason,
  type LibraryResolutionDeps
} from "../../../../backend/src/services/visualizations/pipeline/library-resolution-service";
import type { HarnessLibraryEntryRecord } from "../../../../backend/src/types/harness-library";
import type {
  ChangeAnalysisResult,
  ComponentCandidate,
  ComponentSourceQueries,
  PipelineContext
} from "../../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../../backend/src/utilities";
import { makeComponentRow, makeVisualizationRow } from "../../helpers/factories";
import { FakeLibraryStore, libraryEntry } from "../../helpers/fake-library-store";
import { createPipelineContext, type PipelineContextHandle } from "../../helpers/pipeline-context";
import { InMemoryQueryHandler } from "../../helpers/query-handler-stub";
import { fakeTransaction } from "../../visualizations/helpers/fakes";

const SOURCE = 'export default definePrvisionHarness({ states: [{ name: "Default", render: () => null }] });';

function row(componentId: number, overrides: Partial<ComponentCandidate> = {}): ComponentCandidate {
  return {
    componentId,
    filePath: `src/components/C${String(componentId)}.tsx`,
    exportName: "default",
    displayName: `C${String(componentId)}`,
    changeKind: "modified",
    rank: componentId - 1,
    codeDiff: "@@",
    reason: "Component code changed",
    ...overrides
  };
}

function entry(
  id: number,
  filePath: string,
  overrides: Partial<HarnessLibraryEntryRecord> = {}
): HarnessLibraryEntryRecord {
  return libraryEntry({
    id,
    filePath,
    displayName: filePath.replace(/^.*\//, "").replace(/\.tsx$/, ""),
    harnessSource: SOURCE,
    ...overrides
  });
}

interface Harness {
  db: InMemoryQueryHandler;
  library: FakeLibraryStore;
  handle: PipelineContextHandle;
  ctx: PipelineContext;
  service: LibraryResolutionService;
  analysis(candidates: ComponentCandidate[], extra?: Partial<ChangeAnalysisResult>): ChangeAnalysisResult;
  messages(level?: "info" | "warn"): string[];
}

function setup(
  options: {
    entries?: HarnessLibraryEntryRecord[];
    renames?: Record<string, string>;
    componentLimit?: number;
    deps?: Partial<LibraryResolutionDeps>;
    missingOnBase?: string[];
  } = {}
): Harness {
  const db = new InMemoryQueryHandler();
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "analyzing" })]);
  const library = new FakeLibraryStore(options.entries ?? []);
  const handle = createPipelineContext({ dataDir: "/tmp/prvision-resolution", repositoryPath: "/tmp/repo" });
  const ctx: PipelineContext = {
    ...handle.context,
    ...(options.componentLimit !== undefined ? { componentLimit: options.componentLimit } : {})
  };
  const renames = options.renames ?? {};
  const missing = new Set(options.missingOnBase ?? []);
  const queries = {
    componentPaths: (filePath: string) => Promise.resolve({ base: renames[filePath] ?? filePath, head: filePath })
  } as unknown as ComponentSourceQueries;
  const service = new LibraryResolutionService({
    store: library,
    queryHandler: db as unknown as QueryHandler,
    transaction: fakeTransaction(db),
    createQueryHandler: () => db as unknown as QueryHandler,
    fingerprinter: { fingerprint: () => Promise.resolve("a".repeat(64)) },
    fileExists: (side, path) => Promise.resolve(!(side === "base" && missing.has(path))),
    now: () => 0,
    ...options.deps
  });
  return {
    db,
    library,
    handle,
    ctx,
    service,
    analysis: (candidates, extra = {}) => {
      db.seed(
        Table.VISUALIZATION_COMPONENTS,
        candidates.map((c) =>
          makeComponentRow({
            id: c.componentId,
            visualizationId: 1,
            filePath: c.filePath,
            exportName: c.exportName,
            displayName: c.displayName,
            changeKind: c.changeKind,
            rank: c.rank,
            ...(c.predecessor
              ? {
                  baseFilePath: c.predecessor.filePath,
                  baseExportName: c.predecessor.exportName,
                  baseDisplayName: c.predecessor.displayName,
                  successorEvidence: c.predecessor.evidence
                }
              : {})
          })
        )
      );
      return {
        candidates,
        skipped: [],
        changedFiles: candidates.map((c) => ({ path: c.filePath, status: "M" as const })),
        sourceQueries: queries,
        globalStyleChanges: [],
        ...extra
      };
    },
    messages: (level) =>
      handle.console.events
        .filter((event) => level === undefined || event.level === level)
        .map((event) => event.message)
  };
}

function plansOf(result: Awaited<ReturnType<LibraryResolutionService["resolve"]>>): unknown[] {
  return [...result.plans].map(([componentId, plans]) => [
    componentId,
    plans.map((plan) => [plan.side, plan.identity.filePath, plan.entry?.id ?? null])
  ]);
}

test("plans: reuse the head entry, a renamed component's base entry, an off_default_branch entry; write when missing or harness-less", async () => {
  const h = setup({
    entries: [
      entry(11, "src/components/C1.tsx"),
      entry(12, "src/components/Old2.tsx"),
      entry(13, "src/components/C3.tsx", { status: "off_default_branch" }),
      entry(14, "src/components/C4.tsx", { harnessSource: null, revision: 3, status: "needs_update" }),
      entry(16, "src/components/C6.tsx", { status: "needs_update" })
    ],
    renames: { "src/components/C2.tsx": "src/components/Old2.tsx" }
  });
  const candidates = [1, 2, 3, 4, 5, 6].map((id) => row(id));
  const result = await h.service.resolve(h.ctx, h.analysis(candidates));
  assert.deepEqual(plansOf(result), [
    [1, [["head", "src/components/C1.tsx", 11]]],
    [2, [["head", "src/components/C2.tsx", 12]]], // renamed: base identity's entry, moved later
    [3, [["head", "src/components/C3.tsx", 13]]], // E26: off_default_branch entries are reused
    [4, [["head", "src/components/C4.tsx", null]]], // harness-less entry → write (E25 revision kept)
    [5, [["head", "src/components/C5.tsx", null]]],
    [6, [["head", "src/components/C6.tsx", 16]]] // E4: needs_update entries are still tried
  ]);
  assert.deepEqual(
    result.toWrite.map((w) => [w.candidate.componentId, w.sides]),
    [
      [4, ["head"]],
      [5, ["head"]]
    ]
  );
  assert.deepEqual([...result.writeRevisions], [["src/components/C4.tsx\u0000default", 3]]);
  assert.equal(result.newHarnessCount, 2);
  assert.equal(result.reusedCount, 4);
  assert.equal(result.pause, false);
  assert.deepEqual(
    result.renderCandidates.map((c) => c.componentId),
    [1, 2, 3, 4, 5, 6]
  );
  const rowOf = (id: number): Record<string, unknown> | undefined => h.db.row(Table.VISUALIZATION_COMPONENTS, id);
  assert.equal(rowOf(1)?.libraryEntryId, 11);
  assert.equal(rowOf(1)?.harnessOrigin, "library");
  assert.equal(rowOf(2)?.libraryEntryId, 12);
  assert.equal(rowOf(5)?.harnessOrigin, null);
});

test("plans: removed rows use the base identity; replaced rows plan base and head independently", async () => {
  const h = setup({
    entries: [entry(21, "src/components/Gone.tsx"), entry(22, "src/forms/NoteForm.tsx", { exportName: "NoteForm" })]
  });
  const removed = row(1, { filePath: "src/components/Gone.tsx", changeKind: "removed" });
  const replacedReuseBase = row(2, {
    filePath: "src/forms/NoteFormModal.tsx",
    exportName: "NoteFormModal",
    changeKind: "replaced",
    predecessor: { filePath: "src/forms/NoteForm.tsx", exportName: "NoteForm", displayName: "NoteForm", evidence: [] }
  });
  const replacedWriteBoth = row(3, {
    filePath: "src/x/NewX.tsx",
    exportName: "NewX",
    changeKind: "replaced",
    predecessor: { filePath: "src/x/OldX.tsx", exportName: "OldX", displayName: "OldX", evidence: [] }
  });
  const result = await h.service.resolve(h.ctx, h.analysis([removed, replacedReuseBase, replacedWriteBoth]));
  assert.deepEqual(plansOf(result), [
    [1, [["base", "src/components/Gone.tsx", 21]]],
    [
      2,
      [
        ["base", "src/forms/NoteForm.tsx", 22],
        ["head", "src/forms/NoteFormModal.tsx", null]
      ]
    ],
    [
      3,
      [
        ["base", "src/x/OldX.tsx", null],
        ["head", "src/x/NewX.tsx", null]
      ]
    ]
  ]);
  assert.deepEqual(
    result.toWrite.map((w) => [w.candidate.componentId, w.sides]),
    [
      [2, ["head"]],
      [3, ["base", "head"]]
    ]
  );
  assert.equal(result.newHarnessCount, 3, "a replaced row with two new harnesses counts 2");
  const replacedRow = h.db.row(Table.VISUALIZATION_COMPONENTS, 2);
  assert.equal(replacedRow?.baseLibraryEntryId, 22);
  assert.equal(replacedRow.baseHarnessOrigin, "library");
  assert.equal(replacedRow.libraryEntryId ?? null, null);
  assert.equal(h.db.row(Table.VISUALIZATION_COMPONENTS, 1)?.libraryEntryId, 21);
});

test("D9: pauses at 13 new harnesses (persisting only the two counts), not at 12, and never when componentLimit is set", async () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => row(i + 1));
  const reused = entry(99, "src/components/C14.tsx");
  const paused = setup({ entries: [reused] });
  const result = await paused.service.resolve(paused.ctx, paused.analysis([...thirteen, row(14)]));
  assert.equal(result.pause, true);
  assert.equal(result.newHarnessCount, 13);
  assert.equal(result.reusedCount, 1);
  assert.deepEqual(result.toWrite, []);
  assert.deepEqual(result.renderCandidates, []);
  assert.equal(paused.db.callsFor("insert").length, 0);
  assert.equal(paused.db.callsFor("update", Table.VISUALIZATION_COMPONENTS).length, 0, "nothing else is written");
  assert.deepEqual(
    paused.db.callsFor("update", Table.VISUALIZATIONS).map((call) => call.args[0]),
    [{ newHarnessCount: 13, reusedHarnessCount: 1 }]
  );
  assert.equal(
    newHarnessPauseMessage(13, 1),
    "13 new harnesses needed (1 components reuse saved harnesses); PRVision writes 12 by default. Waiting for you to choose how many to write."
  );

  const twelve = setup();
  const notPaused = await twelve.service.resolve(twelve.ctx, twelve.analysis(thirteen.slice(0, 12)));
  assert.equal(notPaused.pause, false);
  assert.equal(notPaused.toWrite.length, 12);

  const confirmed = setup({ componentLimit: 20 });
  const limited = await confirmed.service.resolve(confirmed.ctx, confirmed.analysis(thirteen));
  assert.equal(limited.pause, false);
  assert.equal(limited.toWrite.length, 13);
});

test("over the confirmed limit: rows needing new harnesses are skipped in rank order with the 16 §8.4 reason; reused rows never", async () => {
  const h = setup({ componentLimit: 2, entries: [entry(41, "src/components/C4.tsx")] });
  const replaced = row(2, {
    filePath: "src/x/NewX.tsx",
    exportName: "NewX",
    changeKind: "replaced",
    predecessor: { filePath: "src/x/OldX.tsx", exportName: "OldX", displayName: "OldX", evidence: [] }
  });
  const candidates = [row(1), replaced, row(3), row(4), row(5)];
  const result = await h.service.resolve(h.ctx, h.analysis(candidates));
  // C1 needs 1 (fits, 1 left), the replaced row needs 2 (skipped whole), C3 needs 1 (fits), C5 needs 1 (skipped)
  assert.deepEqual(result.skippedOverLimit, [2, 5]);
  assert.deepEqual(
    result.renderCandidates.map((c) => c.componentId),
    [1, 3, 4]
  );
  assert.equal(
    h.db.row(Table.VISUALIZATION_COMPONENTS, 2)?.skipReason,
    "over_limit: needs a new harness, ranked 2 of 4; PRVision writes at most 2 new harnesses per visualization"
  );
  assert.equal(h.db.row(Table.VISUALIZATION_COMPONENTS, 2)?.renderStatus, "skipped");
  assert.equal(h.db.row(Table.VISUALIZATION_COMPONENTS, 5)?.skipReason, overLimitReason(4, 4, 2));
  assert.equal(h.db.row(Table.VISUALIZATION_COMPONENTS, 4)?.renderStatus, "pending", "reused rows are never skipped");
  assert.equal(result.newHarnessCount, 5, "planned before the limit");
  const counts = h.db.row(Table.VISUALIZATIONS, 1);
  assert.equal(counts?.newHarnessCount, 2, "planned and not skipped");
  assert.equal(counts.reusedHarnessCount, 1);
  assert.ok(h.messages("warn").includes("2 component(s) need a new harness beyond the limit of 2; they are skipped."));
  assert.ok(
    h.messages("info").includes("Harness library: 1 component(s) reuse saved harnesses, 2 need a new harness.")
  );
});

test("D7 re-check: a global style change adds rechecked rows for library entries that are not row identities, exist on both sides and are on the default branch", async () => {
  const h = setup({
    entries: [
      entry(51, "src/components/C1.tsx"), // a row identity: not re-checked
      entry(52, "src/components/Zeta.tsx"),
      entry(53, "src/components/Alpha.tsx", { exportName: "Alpha" }),
      entry(54, "src/components/Off.tsx", { status: "off_default_branch" }), // E26: never re-checked
      entry(55, "src/components/NewOnHead.tsx"), // missing on base
      entry(56, "src/components/Empty.tsx", { harnessSource: null, status: "needs_update" })
    ],
    missingOnBase: ["src/components/NewOnHead.tsx"]
  });
  const analysis = h.analysis([row(1)], {
    changedFiles: [
      { path: "src/components/C1.tsx", status: "M" },
      { path: "src/index.css", status: "M" },
      { path: "tailwind.config.js", status: "M" }
    ],
    skipped: [
      { ...row(9), skipReason: "over_limit: ranked 2 of 2; PRVision analyses at most 500 components per visualization" }
    ]
  });
  const result = await h.service.resolve(h.ctx, analysis);
  assert.equal(result.globalStyleTrigger, "src/index.css", "first trigger by path");
  assert.equal(result.recheckedCount, 2);
  const rechecked = result.renderCandidates.filter((c) => c.changeKind === "rechecked");
  assert.deepEqual(
    rechecked.map((c) => [c.filePath, c.exportName, c.rank, c.reason, c.codeDiff]),
    [
      ["src/components/Alpha.tsx", "Alpha", 1, recheckReason("src/index.css"), null],
      [
        "src/components/Zeta.tsx",
        "default",
        2,
        "Global style changed (src/index.css); re-checked with the saved harness",
        null
      ]
    ]
  );
  for (const candidate of rechecked) {
    const inserted = h.db.row(Table.VISUALIZATION_COMPONENTS, candidate.componentId);
    assert.equal(inserted?.changeKind, "rechecked");
    assert.equal(inserted.renderStatus, "pending");
    assert.equal(inserted.harnessOrigin, "library");
    assert.equal(inserted.libraryEntryId, candidate.filePath.endsWith("Alpha.tsx") ? 53 : 52);
    assert.equal(inserted.sourceChangedSinceWrite ?? null, null, "not computed for rechecked rows");
    assert.equal(result.plans.get(candidate.componentId)?.[0]?.entry?.harnessSource, SOURCE);
  }
  assert.deepEqual(h.library.callsOf("listForRepository")[0], [
    1,
    { withHarnessOnly: true, onDefaultBranchOnly: true }
  ]);
  const viz = h.db.row(Table.VISUALIZATIONS, 1);
  assert.equal(viz?.componentCount, 4, "1 analysed + 1 skipped by analysis + 2 rechecked");
  assert.equal(viz.globalStyleTrigger, "src/index.css");
  assert.equal(viz.reusedHarnessCount, 1, "rechecked rows are counted separately (checked_count)");
  assert.ok(
    h
      .messages("info")
      .includes("Global style change in src/index.css (global stylesheet): re-checking all 2 saved harnesses.")
  );
});

test("D7 re-check: an empty library explains how to get coverage; no trigger means no re-check", async () => {
  const empty = setup();
  const triggered = await empty.service.resolve(
    empty.ctx,
    empty.analysis([], { changedFiles: [{ path: "tailwind.config.js", status: "M" }] })
  );
  assert.equal(triggered.recheckedCount, 0);
  assert.equal(triggered.globalStyleTrigger, "tailwind.config.js");
  assert.ok(
    empty
      .messages("info")
      .includes(
        "Global style change in tailwind.config.js (Tailwind config). The harness library is empty, so nothing else is re-checked. Scan the whole app from the repository page for full coverage."
      )
  );
  const quiet = setup({ entries: [entry(61, "src/components/Other.tsx")] });
  const none = await quiet.service.resolve(quiet.ctx, quiet.analysis([row(1)]));
  assert.equal(none.globalStyleTrigger, null);
  assert.equal(none.recheckedCount, 0);
  assert.equal(quiet.library.callsOf("listForRepository").length, 0);
});

test(`D7 re-check: at most LIBRARY_RECHECK_MAX_COMPONENTS (${String(LIBRARY_RECHECK_MAX_COMPONENTS)}) rows, by path, with a console warning`, async () => {
  const entries = Array.from({ length: LIBRARY_RECHECK_MAX_COMPONENTS + 1 }, (_, i) =>
    entry(1_000 + i, `src/lib/C${String(i).padStart(5, "0")}.tsx`)
  );
  const h = setup({ entries });
  const result = await h.service.resolve(
    h.ctx,
    h.analysis([], { changedFiles: [{ path: "src/index.css", status: "M" }] })
  );
  assert.equal(result.recheckedCount, LIBRARY_RECHECK_MAX_COMPONENTS);
  assert.equal(
    result.renderCandidates.at(-1)?.filePath,
    `src/lib/C${String(LIBRARY_RECHECK_MAX_COMPONENTS - 1).padStart(5, "0")}.tsx`
  );
  assert.ok(
    h
      .messages("warn")
      .includes(`Only the first ${String(LIBRARY_RECHECK_MAX_COMPONENTS)} saved harnesses are re-checked.`)
  );
});

test("source_changed_since_write compares the head fingerprint with the reused entry's; null when either is null", async () => {
  const h = setup({
    entries: [
      entry(71, "src/components/C1.tsx", { sourceFingerprint: "a".repeat(64) }),
      entry(72, "src/components/C2.tsx", { sourceFingerprint: "b".repeat(64) }),
      entry(73, "src/components/C3.tsx", { sourceFingerprint: null })
    ]
  });
  await h.service.resolve(h.ctx, h.analysis([row(1), row(2), row(3)]));
  assert.equal(h.db.row(Table.VISUALIZATION_COMPONENTS, 1)?.sourceChangedSinceWrite, false);
  assert.equal(h.db.row(Table.VISUALIZATION_COMPONENTS, 2)?.sourceChangedSinceWrite, true);
  assert.equal(h.db.row(Table.VISUALIZATION_COMPONENTS, 3)?.sourceChangedSinceWrite, null);
});

test("persistence is one transaction: a failing write rolls back the re-check rows and the run fails in analyzing", async () => {
  const h = setup({ entries: [entry(81, "src/components/Other.tsx")] });
  h.db.failNext("update");
  await assert.rejects(
    h.service.resolve(h.ctx, h.analysis([], { changedFiles: [{ path: "src/index.css", status: "M" }] })),
    /visualization counts update failed/
  );
  assert.deepEqual(
    h.db.rows(Table.VISUALIZATION_COMPONENTS).filter((r) => r.changeKind === "rechecked"),
    [],
    "rolled back"
  );
});
