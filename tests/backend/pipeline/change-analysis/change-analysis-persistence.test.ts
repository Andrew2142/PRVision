import assert from "node:assert/strict";
import { test } from "node:test";
import { DeletionMode, Table } from "../../../../backend/src/enums";
import {
  analysisRowKey,
  persistAnalysisRows
} from "../../../../backend/src/services/visualizations/pipeline/change-analysis-persistence";
import type { DraftCandidate } from "../../../../backend/src/types/change-analysis";
import { PipelineStepError } from "../../../../backend/src/types/visualization-pipeline";
import { stubPersistence } from "./helpers/worktree-fixture";

function draft(filePath: string, exportName: string, changeKind: DraftCandidate["changeKind"]): DraftCandidate {
  return {
    filePath,
    exportName,
    displayName: exportName,
    changeKind,
    codeDiff: changeKind === "affected_parent" ? null : `diff --git a/${filePath} b/${filePath}`,
    reason: `reason of ${exportName}`,
    diffSize: 1,
    depth: changeKind === "affected_parent" ? 1 : 0,
    forcedSkipReason: null
  };
}

const ORDERED = [draft("src/A.tsx", "default", "modified"), draft("src/B.tsx", "B", "affected_parent")];

test("persistAnalysisRows replaces the rows in one transaction and maps ids by key", async () => {
  const persistence = stubPersistence();
  const rendered = new Set([analysisRowKey(ORDERED[0] ?? draft("x", "x", "modified"))]);
  const skipReasons = new Map([
    [analysisRowKey({ filePath: "src/B.tsx", exportName: "B" }), "over_limit: ranked 2 of 2"]
  ]);
  const ids = await persistAnalysisRows(persistence, 7, ORDERED, rendered, skipReasons);
  assert.equal(persistence.transactions, 1);
  assert.deepEqual(persistence.deleted, [{ visualizationId: 7 }]);
  assert.deepEqual(persistence.inserted[0], [
    {
      visualizationId: 7,
      filePath: "src/A.tsx",
      exportName: "default",
      displayName: "default",
      changeKind: "modified",
      renderStatus: "pending",
      rank: 0,
      codeDiff: "diff --git a/src/A.tsx b/src/A.tsx",
      mockedModules: [],
      changeReason: "reason of default",
      skipReason: null
    },
    {
      visualizationId: 7,
      filePath: "src/B.tsx",
      exportName: "B",
      displayName: "B",
      changeKind: "affected_parent",
      renderStatus: "skipped",
      rank: 1,
      codeDiff: null,
      mockedModules: [],
      changeReason: "reason of B",
      skipReason: "over_limit: ranked 2 of 2"
    }
  ]);
  assert.deepEqual(persistence.updates, [
    { values: { componentCount: 2 }, conditions: { id: 7 }, table: Table.VISUALIZATIONS }
  ]);
  // the stub echoes rows in reverse order (ids 100, 101 by input position): mapping is by key, not by order
  assert.deepEqual(
    [...ids],
    [
      [analysisRowKey({ filePath: "src/B.tsx", exportName: "B" }), 101],
      [analysisRowKey({ filePath: "src/A.tsx", exportName: "default" }), 100]
    ]
  );
});

test("persistAnalysisRows writes component_count 0 and inserts nothing for an empty analysis", async () => {
  const persistence = stubPersistence();
  const ids = await persistAnalysisRows(persistence, 3, [], new Set(), new Map());
  assert.equal(ids.size, 0);
  assert.deepEqual(persistence.inserted, []);
  assert.deepEqual(persistence.updates, [
    { values: { componentCount: 0 }, conditions: { id: 3 }, table: Table.VISUALIZATIONS }
  ]);
});

test("persistAnalysisRows deletes previous rows with a hard delete", async () => {
  const calls: unknown[] = [];
  const persistence = stubPersistence();
  const original = persistence.createQueryHandler;
  persistence.createQueryHandler = (tx) => {
    const handler = original(tx);
    const remove = handler.delete.bind(handler);
    Object.assign(handler, {
      delete: (...args: Parameters<typeof handler.delete>) => {
        calls.push(args);
        return remove(...args);
      }
    });
    return handler;
  };
  await persistAnalysisRows(persistence, 9, [], new Set(), new Map());
  assert.deepEqual(calls, [[{ visualizationId: 9 }, Table.VISUALIZATION_COMPONENTS, DeletionMode.HARD]]);
});

test("persistAnalysisRows throws ANALYSIS_PERSIST_FAILED and rolls back when a write fails", async () => {
  for (const options of [{ insertThrows: true }, { insertStatus: 500 }, { deleteStatus: 500 }]) {
    const persistence = stubPersistence(options);
    let caught: unknown;
    try {
      await persistAnalysisRows(persistence, 1, ORDERED, new Set(), new Map());
    } catch (error: unknown) {
      caught = error;
    }
    assert.ok(caught instanceof PipelineStepError, JSON.stringify(options));
    assert.equal(caught.code, "ANALYSIS_PERSIST_FAILED");
    assert.equal(caught.stage, "analyzing");
    assert.equal(caught.userMessage, "Could not save the list of components.");
    assert.equal(persistence.rolledBack, 1);
  }
});

test("analysisRowKey separates the path and export name with a NUL", () => {
  assert.equal(analysisRowKey({ filePath: "src/a.ts", exportName: "A" }), "src/a.ts\u0000A");
});
