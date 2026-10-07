import assert from "node:assert/strict";
import { test } from "node:test";
import { RENDER_ERROR_MAX_CHARS } from "../../../backend/src/config-consts";
import { Table } from "../../../backend/src/enums";
import {
  HarnessLibraryStore,
  LIBRARY_NOTES_MAX_CHARS
} from "../../../backend/src/services/harness-library/harness-library-store";
import type { SaveWrittenHarnessInput } from "../../../backend/src/types/harness-library";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import type { Transaction } from "../../../backend/src/utilities/services/drizzle-db";
import { InMemoryQueryHandler, type Row } from "../helpers/query-handler-stub";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const ENTRIES = Table.HARNESS_LIBRARY_ENTRIES;

function setup(options: { onTransactionError?: (error: unknown, attempt: number) => void } = {}): {
  db: InMemoryQueryHandler;
  store: HarnessLibraryStore;
  transactions: () => number;
} {
  const db = new InMemoryQueryHandler();
  db.now = () => NOW;
  let transactions = 0;
  const qh = db as unknown as QueryHandler;
  const store = new HarnessLibraryStore({
    queryHandler: qh,
    createQueryHandler: () => qh,
    runInTransaction: async (fn) => {
      transactions += 1;
      try {
        return await fn({} as Transaction);
      } catch (error) {
        options.onTransactionError?.(error, transactions);
        throw error;
      }
    },
    now: () => NOW
  });
  return { db, store, transactions: () => transactions };
}

const HARNESS: NonNullable<SaveWrittenHarnessInput["harness"]> = {
  harnessSource: "export default definePrvisionHarness({ states: [] });",
  mockedModules: [],
  notes: "Card states.",
  states: [
    { name: "Default", steps: [] },
    { name: "Long title", steps: [] }
  ]
};

function input(overrides: Partial<SaveWrittenHarnessInput> = {}): SaveWrittenHarnessInput {
  return {
    repositoryId: 1,
    framework: "react_vite",
    identity: { filePath: "src/components/Card.tsx", exportName: "Card" },
    displayName: "Card",
    selector: null,
    sourceFingerprint: "a".repeat(64),
    harness: HARNESS,
    stateAllowance: 3,
    status: "ready",
    origin: "run",
    lastError: null,
    lastFailedVisualizationId: null,
    aiModel: "claude-opus-5-5",
    aiUsage: {
      inputTokens: 26_000,
      cacheReadInputTokens: 4_500,
      cacheWriteInputTokens: 0,
      outputTokens: 9_000,
      calls: 1
    },
    expectedRevision: 0,
    ...overrides
  };
}

function seedEntry(db: InMemoryQueryHandler, overrides: Partial<Row> = {}): Row {
  const [row] = db.seed(ENTRIES, [
    {
      repositoryId: 1,
      framework: "react_vite",
      filePath: "src/components/Card.tsx",
      exportName: "Card",
      displayName: "Card",
      harnessSource: "old source",
      states: [{ name: "Default", steps: [] }],
      stateCount: 1,
      stateAllowance: 3,
      status: "ready",
      origin: "scan",
      revision: 1,
      ...overrides
    }
  ]);
  assert.ok(row);
  return row;
}

test("HarnessLibraryStore.saveWritten inserts revision 1 with state count, cost and written_at", async () => {
  const { db, store } = setup();
  const outcome = await store.saveWritten(input());
  assert.ok(outcome.saved);
  assert.equal(outcome.entry.revision, 1);
  assert.equal(outcome.entry.status, "ready");
  assert.deepEqual(
    outcome.entry.states.map((state) => state.name),
    ["Default", "Long title"]
  );
  const row = db.rows(ENTRIES)[0];
  assert.ok(row);
  assert.deepEqual(row.writtenAt, NOW);
  assert.equal(row.lastError, null);
  assert.equal(row.costUsd, 0.2669);
  assert.equal(row.stateCount, 2);
});

test("HarnessLibraryStore.saveWritten replaces with expectedRevision null or equal (revision + 1)", async () => {
  const { db, store } = setup();
  seedEntry(db);
  const unconditional = await store.saveWritten(input({ expectedRevision: null, origin: "repair" }));
  assert.ok(unconditional.saved);
  assert.equal(unconditional.entry.revision, 2);
  assert.equal(unconditional.entry.origin, "repair");
  const equal = await store.saveWritten(input({ expectedRevision: 2, origin: "scan" }));
  assert.ok(equal.saved);
  assert.equal(equal.entry.revision, 3);
  assert.equal(db.rows(ENTRIES).length, 1);
});

test("HarnessLibraryStore.saveWritten returns revision_changed for a different revision and for 0 on an existing entry", async () => {
  const { db, store } = setup();
  seedEntry(db, { revision: 4 });
  for (const expectedRevision of [3, 0]) {
    const outcome = await store.saveWritten(input({ expectedRevision }));
    assert.equal(outcome.saved, false);
    assert.ok(!outcome.saved);
    assert.equal(outcome.reason, "revision_changed");
    assert.equal(outcome.current.revision, 4);
    assert.equal(outcome.current.harnessSource, "old source");
  }
  assert.equal(db.callsFor("update", ENTRIES).length, 0, "nothing is overwritten");
});

test("HarnessLibraryStore.saveWritten with a revision n inserts when there is no entry", async () => {
  const { store } = setup();
  const outcome = await store.saveWritten(input({ expectedRevision: 5 }));
  assert.ok(outcome.saved);
  assert.equal(outcome.entry.revision, 1);
});

test("HarnessLibraryStore.saveWritten re-runs once after a unique violation on insert", async () => {
  let ctxDb: InMemoryQueryHandler | null = null;
  const { db, store, transactions } = setup({
    onTransactionError: (_error, attempt) => {
      if (attempt === 1 && ctxDb !== null) {
        seedEntry(ctxDb, { revision: 1 }); // the concurrent writer's row becomes visible
      }
    }
  });
  ctxDb = db;
  db.failNext("insert", { status: 409, error: "Duplicate record", error_reason: "conflict" });
  const outcome = await store.saveWritten(input({ expectedRevision: 0 }));
  assert.equal(transactions(), 2);
  assert.ok(!outcome.saved, "expectedRevision 0 then finds the concurrent entry");
  assert.equal(outcome.reason, "revision_changed");
});

test("HarnessLibraryStore.saveWritten caps notes and errors; a ready save stores no last_error", async () => {
  const { db, store } = setup();
  await store.saveWritten(
    input({
      harness: { ...HARNESS, notes: "n".repeat(LIBRARY_NOTES_MAX_CHARS + 50) },
      status: "needs_update",
      lastError: "e".repeat(RENDER_ERROR_MAX_CHARS + 10),
      lastFailedVisualizationId: 9
    })
  );
  const row = db.rows(ENTRIES)[0];
  assert.equal(String(row?.notes).length, LIBRARY_NOTES_MAX_CHARS);
  assert.equal(String(row?.lastError).length, RENDER_ERROR_MAX_CHARS);
  assert.equal(row?.lastFailedVisualizationId, 9);
  await store.saveWritten(input({ expectedRevision: null, status: "ready", lastError: "ignored" }));
  assert.equal(db.rows(ENTRIES)[0]?.lastError, null);
});

test("HarnessLibraryStore.saveWritten without a harness stores state_count 0 and no source", async () => {
  const { db, store } = setup();
  const outcome = await store.saveWritten(
    input({ harness: null, status: "needs_update", lastError: "AI error", aiUsage: null })
  );
  assert.ok(outcome.saved);
  const row = db.rows(ENTRIES)[0];
  assert.ok(row);
  assert.equal(row.harnessSource, null);
  assert.equal(row.costUsd, null);
  assert.equal(row.stateCount, 0);
});

test("HarnessLibraryStore.markRenderOutcome never sets ready without a harness", async () => {
  const { db, store } = setup();
  const row = seedEntry(db, { harnessSource: null, status: "needs_update", stateCount: 0, lastError: "x" });
  await store.markRenderOutcome(row.id, { ok: true, at: NOW });
  assert.equal(db.row(ENTRIES, row.id)?.status, "needs_update");
  assert.deepEqual(db.row(ENTRIES, row.id)?.lastRenderedAt, NOW);
});

test("HarnessLibraryStore.markRenderOutcome returns an off_default_branch entry to ready or needs_update", async () => {
  const { db, store } = setup();
  const ok = seedEntry(db, { status: "off_default_branch", lastError: "old" });
  await store.markRenderOutcome(ok.id, { ok: true, at: NOW });
  assert.equal(db.row(ENTRIES, ok.id)?.status, "ready");
  assert.equal(db.row(ENTRIES, ok.id)?.lastError, null);
  const failed = seedEntry(db, { exportName: "Other", status: "off_default_branch" });
  await store.markRenderOutcome(failed.id, { ok: false, at: NOW, error: "boom", visualizationId: 12 });
  const after = db.row(ENTRIES, failed.id);
  assert.ok(after);
  assert.equal(after.harnessSource, "old source", "the harness is never touched");
  assert.equal(after.lastError, "boom");
  assert.equal(after.lastFailedVisualizationId, 12);
  assert.equal(after.status, "needs_update");
});

test("HarnessLibraryStore.markOffDefaultBranch keeps the harness and skips already-marked rows", async () => {
  const { db, store } = setup();
  const a = seedEntry(db, { lastError: null });
  const b = seedEntry(db, { exportName: "B", status: "off_default_branch" });
  const other = seedEntry(db, { repositoryId: 2, exportName: "C" });
  assert.equal(await store.markOffDefaultBranch(1, [a.id, b.id, other.id]), 1);
  assert.equal(db.row(ENTRIES, a.id)?.status, "off_default_branch");
  assert.equal(db.row(ENTRIES, a.id)?.harnessSource, "old source");
  assert.equal(db.row(ENTRIES, other.id)?.status, "ready", "another repository is untouched");
  assert.equal(await store.markOffDefaultBranch(1, []), 0);
});

test("HarnessLibraryStore.restoreOnDefaultBranch: ready only with a harness and no last_error; only marked rows", async () => {
  const { db, store } = setup();
  const clean = seedEntry(db, { status: "off_default_branch", lastError: null });
  const errored = seedEntry(db, { exportName: "E", status: "off_default_branch", lastError: "failed" });
  const empty = seedEntry(db, {
    exportName: "N",
    status: "off_default_branch",
    harnessSource: null,
    stateCount: 0,
    lastError: null
  });
  const notMarked = seedEntry(db, { exportName: "R", status: "needs_update", lastError: "x" });
  const changed = await store.restoreOnDefaultBranch(1, [clean.id, errored.id, empty.id, notMarked.id]);
  assert.equal(changed, 3);
  assert.equal(db.row(ENTRIES, clean.id)?.status, "ready");
  assert.equal(db.row(ENTRIES, errored.id)?.status, "needs_update");
  assert.equal(db.row(ENTRIES, empty.id)?.status, "needs_update");
  assert.equal(db.row(ENTRIES, notMarked.id)?.status, "needs_update");
  assert.equal(db.row(ENTRIES, notMarked.id)?.lastError, "x");
});

test("HarnessLibraryStore.listForRepository orders by path and export; onDefaultBranchOnly and withHarnessOnly filter", async () => {
  const { db, store } = setup();
  seedEntry(db, { filePath: "src/b/B.tsx", exportName: "B" });
  seedEntry(db, { filePath: "src/a/A.tsx", exportName: "default" });
  seedEntry(db, { filePath: "src/a/A.tsx", exportName: "Alt", status: "off_default_branch" });
  seedEntry(db, {
    filePath: "src/c/C.tsx",
    exportName: "C",
    harnessSource: null,
    stateCount: 0,
    status: "needs_update"
  });
  const all = await store.listForRepository(1);
  assert.deepEqual(
    all.map((entry) => `${entry.filePath}#${entry.exportName}`),
    ["src/a/A.tsx#Alt", "src/a/A.tsx#default", "src/b/B.tsx#B", "src/c/C.tsx#C"]
  );
  const onBranch = await store.listForRepository(1, { onDefaultBranchOnly: true, withHarnessOnly: true });
  assert.deepEqual(
    onBranch.map((entry) => entry.exportName),
    ["default", "B"]
  );
});

test("HarnessLibraryStore.findByIdentities keys entries by identity and filters by export", async () => {
  const { db, store } = setup();
  seedEntry(db);
  seedEntry(db, { exportName: "CardHeader" });
  const found = await store.findByIdentities(1, [
    { filePath: "src/components/Card.tsx", exportName: "Card" },
    { filePath: "src/components/Missing.tsx", exportName: "Missing" }
  ]);
  assert.deepEqual([...found.keys()], ["src/components/Card.tsx\u0000Card"]);
  assert.equal((await store.findByIdentities(1, [])).size, 0);
});

test("HarnessLibraryStore.moveIdentity moves the entry; a no-op when the target identity exists", async () => {
  const { db, store } = setup();
  const old = seedEntry(db, { filePath: "src/legacy/Card.tsx" });
  await store.moveIdentity(old.id, { filePath: "src/components/Card.tsx", exportName: "Card", displayName: "Card" });
  assert.equal(db.row(ENTRIES, old.id)?.filePath, "src/components/Card.tsx");
  const other = seedEntry(db, { filePath: "src/old/Badge.tsx", exportName: "Badge" });
  await store.moveIdentity(other.id, { filePath: "src/components/Card.tsx", exportName: "Card", displayName: "Card" });
  assert.equal(db.row(ENTRIES, other.id)?.filePath, "src/old/Badge.tsx", "the target wins");
});

test("HarnessLibraryStore.counts exclude off_default_branch entries and count other allowances", async () => {
  const { db, store } = setup();
  seedEntry(db, { exportName: "A", stateAllowance: 3 });
  seedEntry(db, { exportName: "B", stateAllowance: 1 });
  seedEntry(db, { exportName: "C", status: "needs_update", harnessSource: null, stateCount: 0, stateAllowance: 1 });
  seedEntry(db, { exportName: "D", status: "needs_update", stateAllowance: 3 });
  seedEntry(db, { exportName: "E", status: "off_default_branch", stateAllowance: 1 });
  seedEntry(db, { repositoryId: 2, exportName: "F" });
  assert.deepEqual(await store.counts(1, 3), {
    total: 4,
    ready: 2,
    needsUpdate: 2,
    withoutHarness: 1,
    otherAllowance: 1
  });
});

test("HarnessLibraryStore issues no delete statement", async () => {
  const { db, store } = setup();
  const row = seedEntry(db);
  await store.saveWritten(input({ expectedRevision: null }));
  await store.markRenderOutcome(row.id, { ok: false, at: NOW, error: "x", visualizationId: null });
  await store.markOffDefaultBranch(1, [row.id]);
  await store.restoreOnDefaultBranch(1, [row.id]);
  await store.moveIdentity(row.id, { filePath: "src/x.tsx", exportName: "X", displayName: "X" });
  assert.equal(db.callsFor("delete").length, 0);
  assert.equal(db.rows(ENTRIES).length, 1);
});
