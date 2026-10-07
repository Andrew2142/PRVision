import assert from "node:assert/strict";
import { test } from "node:test";
import { Table } from "../../../../backend/src/enums";
import {
  aggregateComponentStates,
  persistComponentStates,
  updateComponentStateDiffs
} from "../../../../backend/src/services/visualizations/pipeline/component-state-persistence";
import type { StateRenderPayload } from "../../../../backend/src/services/visualizations/pipeline/render-service";
import type { QueryHandler } from "../../../../backend/src/utilities";
import { InMemoryQueryHandler } from "../../helpers/query-handler-stub";

const STATES = Table.VISUALIZATION_COMPONENT_STATES;

function state(ordinal: number, name: string, overrides: Partial<StateRenderPayload> = {}): StateRenderPayload {
  return {
    ordinal,
    stateName: name,
    onBase: true,
    onHead: true,
    steps: [],
    renderStatus: "rendered",
    baseImagePath: `artifacts/1/7/${ordinal === 0 ? "" : `s${String(ordinal)}/`}base.png`,
    headImagePath: `artifacts/1/7/${ordinal === 0 ? "" : `s${String(ordinal)}/`}head.png`,
    imageWidth: 100,
    imageHeight: 40,
    baseError: null,
    headError: null,
    baseFailureKind: null,
    headFailureKind: null,
    ...overrides
  };
}

test("persistComponentStates replaces the state rows of one component (hard delete, then insert)", async () => {
  const db = new InMemoryQueryHandler();
  db.seed(STATES, [
    { visualizationComponentId: 7, visualizationId: 1, ordinal: 0, stateName: "Default", onBase: true, onHead: true },
    { visualizationComponentId: 7, visualizationId: 1, ordinal: 1, stateName: "Old", onBase: true, onHead: true },
    { visualizationComponentId: 8, visualizationId: 1, ordinal: 0, stateName: "Default", onBase: true, onHead: true }
  ]);
  const qh = db as unknown as QueryHandler;
  await persistComponentStates(qh, 1, 7, [
    state(0, "Default"),
    state(1, "Overdue", {
      renderStatus: "partial",
      headImagePath: null,
      headError: "[step_failed] x",
      headFailureKind: "step_failed",
      steps: [{ action: "click", target: { by: "text", text: "More" } }]
    })
  ]);
  const rows = db.rows(STATES).filter((row) => row.visualizationComponentId === 7);
  assert.deepEqual(
    rows.map((row) => [row.ordinal, row.stateName, row.renderStatus, row.headFailureKind]),
    [
      [0, "Default", "rendered", null],
      [1, "Overdue", "partial", "step_failed"]
    ]
  );
  assert.deepEqual(rows[1]?.steps, [{ action: "click", target: { by: "text", text: "More" } }]);
  assert.equal(db.rows(STATES).filter((row) => row.visualizationComponentId === 8).length, 1, "other components kept");
  // No rows → delete only.
  await persistComponentStates(qh, 1, 7, []);
  assert.equal(db.rows(STATES).filter((row) => row.visualizationComponentId === 7).length, 0);
});

test("persistComponentStates throws when the insert fails", async () => {
  const db = new InMemoryQueryHandler();
  db.failNext("insert");
  await assert.rejects(
    persistComponentStates(db as unknown as QueryHandler, 1, 7, [state(0, "Default")]),
    /visualization_component_states insert failed/
  );
});

test("aggregateComponentStates counts changed, new and deleted states and takes the largest ratio", () => {
  assert.deepEqual(
    aggregateComponentStates([
      { visualChange: "unchanged", diffPixelRatio: 0.0001 },
      { visualChange: "changed", diffPixelRatio: 0.02 },
      { visualChange: "new", diffPixelRatio: null },
      { visualChange: null, diffPixelRatio: null },
      { visualChange: "deleted", diffPixelRatio: null }
    ]),
    { stateCount: 5, changedStateCount: 3, maxDiffPixelRatio: 0.02 }
  );
  assert.deepEqual(aggregateComponentStates([]), { stateCount: 0, changedStateCount: 0, maxDiffPixelRatio: null });
});

test("updateComponentStateDiffs writes each state's diff columns by ordinal", async () => {
  const db = new InMemoryQueryHandler();
  db.seed(STATES, [
    { visualizationComponentId: 7, visualizationId: 1, ordinal: 0, stateName: "Default", onBase: true, onHead: true },
    { visualizationComponentId: 7, visualizationId: 1, ordinal: 1, stateName: "Overdue", onBase: true, onHead: true }
  ]);
  await updateComponentStateDiffs(db as unknown as QueryHandler, 7, [
    {
      ordinal: 0,
      stateName: "Default",
      visualChange: "unchanged",
      diffImagePath: "artifacts/1/7/diff.png",
      diffPixelRatio: 0,
      width: 10,
      height: 5
    },
    {
      ordinal: 1,
      stateName: "Overdue",
      visualChange: "changed",
      diffImagePath: "artifacts/1/7/s1/diff.png",
      diffPixelRatio: 0.25,
      width: 10,
      height: 6
    },
    {
      ordinal: 2,
      stateName: "Gone",
      visualChange: null,
      diffImagePath: null,
      diffPixelRatio: null,
      width: null,
      height: null
    }
  ]);
  const rows = db.rows(STATES);
  assert.deepEqual(
    rows.map((row) => [row.ordinal, row.visualChange, row.diffImagePath, row.diffPixelRatio, row.imageHeight]),
    [
      [0, "unchanged", "artifacts/1/7/diff.png", 0, 5],
      [1, "changed", "artifacts/1/7/s1/diff.png", 0.25, 6]
    ]
  );
});
