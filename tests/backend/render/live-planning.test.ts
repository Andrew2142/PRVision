import assert from "node:assert/strict";
import { test } from "node:test";
import { VisualizationComponentModel, RepositoryModel } from "../../../backend/src/models";
import {
  planLiveItems,
  planStates,
  planWorkItem
} from "../../../backend/src/services/visualizations/pipeline/render/live-planning";
import { candidate, harnessFor } from "./helpers/render-stubs";

const D = { name: "Default", steps: [] };
const MENU = {
  name: "Menu open",
  steps: [{ action: "click" as const, target: { by: "text" as const, text: "More" } }]
};

test("planStates: same-harness rows use the harness's states on every present side", () => {
  assert.deepEqual(planStates([D, MENU], null, { base: true, head: true }), [
    { ordinal: 0, name: "Default", onBase: true, onHead: true, steps: [] },
    { ordinal: 1, name: "Menu open", onBase: true, onHead: true, steps: MENU.steps }
  ]);
  assert.deepEqual(planStates([D], null, { base: false, head: true }), [
    { ordinal: 0, name: "Default", onBase: false, onHead: true, steps: [] }
  ]);
  assert.deepEqual(planStates([], null, { base: true, head: true }), [
    { ordinal: 0, name: "Default", onBase: true, onHead: true, steps: [] }
  ]);
});

test("planStates: replaced rows match by name, head order first, then base-only states (E9), at most 10", () => {
  const plans = planStates([D, { name: "Empty", steps: [] }, MENU], [D, MENU, { name: "Legacy", steps: [] }], {
    base: true,
    head: true
  });
  assert.deepEqual(
    plans.map((plan) => [plan.ordinal, plan.name, plan.onBase, plan.onHead]),
    [
      [0, "Default", true, true],
      [1, "Empty", false, true],
      [2, "Menu open", true, true],
      [3, "Legacy", true, false]
    ]
  );
  const many = Array.from({ length: 8 }, (_, index) => ({ name: `H${String(index)}`, steps: [] }));
  const base = Array.from({ length: 8 }, (_, index) => ({ name: `B${String(index)}`, steps: [] }));
  assert.equal(planStates(many, base, { base: true, head: true }).length, 10);
});

test("planWorkItem builds a pure item with states, origins and the mock group", () => {
  const harness = { ...harnessFor(5, "src/A.tsx"), states: [D, MENU], origin: "library" as const };
  const item = planWorkItem({
    candidate: candidate(5, "src/A.tsx"),
    harness,
    paths: { base: "src/A.tsx", head: "src/A.tsx" }
  });
  assert.equal(item.origin, "library");
  assert.equal(item.states.length, 2);
  assert.equal(item.fingerprint, "none");
  assert.deepEqual(item.plannedFailures, { base: null, head: null });
});

test("planLiveItems builds items from run rows with harness snapshots (rank order, rows without a harness skipped)", () => {
  const row = (data: Record<string, unknown>): VisualizationComponentModel =>
    new VisualizationComponentModel({
      visualizationId: 1,
      exportName: "default",
      displayName: "A",
      rank: 0,
      renderStatus: "rendered",
      changeKind: "modified",
      mockedModules: [],
      harnessNeedsUpdate: false,
      stateCount: 0,
      changedStateCount: 0,
      ...data
    });
  const items = planLiveItems(
    [
      {
        row: row({ id: 3, filePath: "src/B.tsx", rank: 1, harnessSource: "b", harnessOrigin: "library" }),
        states: [D],
        baseStates: null
      },
      { row: row({ id: 2, filePath: "src/A.tsx", rank: 0, harnessSource: "a" }), states: [D, MENU], baseStates: null },
      { row: row({ id: 4, filePath: "src/C.tsx", rank: 2 }), states: [D], baseStates: null },
      {
        row: row({ id: 5, filePath: "src/New.tsx", rank: 3, changeKind: "added", harnessSource: "n" }),
        states: [D],
        baseStates: null
      },
      {
        row: row({
          id: 6,
          filePath: "src/Next.tsx",
          rank: 4,
          changeKind: "replaced",
          harnessSource: "h",
          baseHarnessSource: "b",
          baseFilePath: "src/Prev.tsx",
          baseExportName: "Prev",
          baseDisplayName: "Prev",
          baseMockedModules: []
        }),
        states: [D],
        baseStates: [D, MENU]
      }
    ],
    new RepositoryModel()
  );
  assert.deepEqual(
    items.map((item) => item.candidate.componentId),
    [2, 3, 5, 6]
  );
  assert.equal(items[0]?.states.length, 2);
  assert.equal(items[1]?.origin, "library");
  assert.deepEqual(items[2]?.paths, { base: null, head: "src/New.tsx" });
  const replaced = items[3];
  assert.ok(replaced);
  assert.deepEqual(replaced.paths, { base: "src/Prev.tsx", head: "src/Next.tsx" });
  assert.deepEqual(
    replaced.states.map((state) => [state.name, state.onBase, state.onHead]),
    [
      ["Default", true, true],
      ["Menu open", true, false]
    ]
  );
});
