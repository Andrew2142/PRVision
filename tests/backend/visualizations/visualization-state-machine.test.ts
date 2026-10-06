import assert from "node:assert/strict";
import { test } from "node:test";
import { Table, VISUALIZATION_STATUS_VALUES, type VisualizationStatus } from "../../../backend/src/enums";
import {
  canTransition,
  transitionVisualization,
  VISUALIZATION_TRANSITIONS,
  VisualizationTransitionError
} from "../../../backend/src/services/visualizations/visualization-state-machine";
import { makeVisualizationRow } from "../helpers/factories";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";

const NOW = new Date("2026-02-01T10:00:00.000Z");
const TERMINAL: VisualizationStatus[] = ["completed", "failed", "cancelled"];
const LINEAR: VisualizationStatus[] = [
  "queued",
  "preparing",
  "analyzing",
  "generating_harnesses",
  "rendering",
  "diffing",
  "summarizing",
  "completed"
];

function store(row = makeVisualizationRow()): InMemoryQueryHandler {
  const qh = new InMemoryQueryHandler();
  qh.seed(Table.VISUALIZATIONS, [row]);
  return qh;
}

test("VISUALIZATION_TRANSITIONS: every non-terminal status can reach failed and cancelled", () => {
  for (const status of VISUALIZATION_STATUS_VALUES.filter((s) => !TERMINAL.includes(s))) {
    assert.equal(canTransition(status, "failed"), true, status);
    assert.equal(canTransition(status, "cancelled"), true, status);
  }
});

test("VISUALIZATION_TRANSITIONS: terminal statuses have no outgoing transitions", () => {
  for (const status of TERMINAL) {
    assert.deepEqual(VISUALIZATION_TRANSITIONS[status], []);
    for (const to of VISUALIZATION_STATUS_VALUES) {
      assert.equal(canTransition(status, to), false, `${status} → ${to}`);
    }
  }
});

test("VISUALIZATION_TRANSITIONS: running stages are linear: preparing → analyzing → generating_harnesses → rendering → diffing → summarizing → completed", () => {
  for (const [index, from] of LINEAR.slice(0, -1).entries()) {
    const next = LINEAR[index + 1];
    assert.ok(next);
    assert.equal(canTransition(from, next), true, `${from} → ${next}`);
    const forward = VISUALIZATION_TRANSITIONS[from].filter((to) => to !== "failed" && to !== "cancelled");
    assert.deepEqual(forward, [next], `${from} has exactly one forward edge`);
  }
  for (const status of VISUALIZATION_STATUS_VALUES) {
    assert.equal(canTransition(status, status), false, `no self-transition on ${status}`);
  }
});

test("VISUALIZATION_TRANSITIONS: analyzing cannot go to completed directly", () => {
  assert.equal(canTransition("analyzing", "completed"), false);
  assert.equal(canTransition("queued", "completed"), false);
  assert.equal(canTransition("rendering", "summarizing"), false);
});

test("transitionVisualization guards on from-status and isDeleted", async () => {
  const qh = store();
  assert.equal(
    await transitionVisualization(qh, { visualizationId: 1, from: "queued", to: "preparing", now: NOW }),
    true
  );
  const call = qh.callsFor("update", Table.VISUALIZATIONS)[0];
  assert.deepEqual(call?.args[1], { id: 1, status: "queued", isDeleted: false });

  const deleted = store(makeVisualizationRow({ isDeleted: true }));
  assert.equal(
    await transitionVisualization(deleted, { visualizationId: 1, from: "queued", to: "preparing", now: NOW }),
    false
  );
  assert.equal(deleted.row(Table.VISUALIZATIONS, 1)?.status, "queued");
});

test("transitionVisualization stamps startedAt on preparing and completedAt on terminal statuses", async () => {
  const qh = store();
  await transitionVisualization(qh, {
    visualizationId: 1,
    from: "queued",
    to: "preparing",
    now: NOW,
    fields: { aiProvider: "claude_code", aiModel: "m", errorMessage: null }
  });
  let row = qh.row(Table.VISUALIZATIONS, 1);
  assert.deepEqual(row?.startedAt, NOW);
  assert.equal(row.completedAt, null);
  assert.equal(row.aiProvider, "claude_code");

  for (const status of ["analyzing", "generating_harnesses", "rendering", "diffing", "summarizing"] as const) {
    const from = row?.status as VisualizationStatus;
    await transitionVisualization(qh, { visualizationId: 1, from, to: status, now: NOW });
    row = qh.row(Table.VISUALIZATIONS, 1);
  }
  const later = new Date("2026-02-01T10:05:00.000Z");
  await transitionVisualization(qh, { visualizationId: 1, from: "summarizing", to: "completed", now: later });
  row = qh.row(Table.VISUALIZATIONS, 1);
  assert.equal(row?.status, "completed");
  assert.deepEqual(row.completedAt, later);
  assert.deepEqual(row.startedAt, NOW, "startedAt untouched");
});

test("transitionVisualization stamps failedStage = from on failed and cancelled, and not on completed", async () => {
  const failed = store(makeVisualizationRow({ status: "rendering" }));
  await transitionVisualization(failed, {
    visualizationId: 1,
    from: "rendering",
    to: "failed",
    now: NOW,
    fields: { errorMessage: "x" }
  });
  assert.equal(failed.row(Table.VISUALIZATIONS, 1)?.failedStage, "rendering");

  const cancelled = store();
  await transitionVisualization(cancelled, { visualizationId: 1, from: "queued", to: "cancelled", now: NOW });
  assert.equal(cancelled.row(Table.VISUALIZATIONS, 1)?.failedStage, "queued");

  const completed = store(makeVisualizationRow({ status: "summarizing" }));
  await transitionVisualization(completed, { visualizationId: 1, from: "summarizing", to: "completed", now: NOW });
  const values = completed.callsFor("update")[0]?.args[0] as Record<string, unknown>;
  assert.equal("failedStage" in values, false);
  assert.equal(completed.row(Table.VISUALIZATIONS, 1)?.failedStage, null);
});

test("transitionVisualization returns false on 404", async () => {
  const qh = store(makeVisualizationRow({ status: "preparing" }));
  assert.equal(
    await transitionVisualization(qh, { visualizationId: 1, from: "queued", to: "failed", now: NOW }),
    false
  );
  assert.equal(
    await transitionVisualization(qh, { visualizationId: 99, from: "preparing", to: "failed", now: NOW }),
    false
  );
  qh.failNext("update");
  await assert.rejects(
    transitionVisualization(qh, { visualizationId: 1, from: "preparing", to: "failed", now: NOW }),
    /update failed \(500\)/
  );
});

test("transitionVisualization throws VisualizationTransitionError for an illegal transition", async () => {
  const qh = store();
  await assert.rejects(
    transitionVisualization(qh, { visualizationId: 1, from: "queued", to: "completed", now: NOW }),
    (error: unknown) =>
      error instanceof VisualizationTransitionError && error.from === "queued" && error.to === "completed"
  );
  await assert.rejects(
    transitionVisualization(qh, { visualizationId: 1, from: "failed", to: "queued", now: NOW }),
    VisualizationTransitionError
  );
  assert.equal(qh.callsFor("update").length, 0);
});
