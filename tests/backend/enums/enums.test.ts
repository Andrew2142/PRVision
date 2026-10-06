import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_VISUALIZATION_STATUSES,
  AI_EFFORT_VALUES,
  COMPONENT_RENDER_STATUS_VALUES,
  NON_TERMINAL_VISUALIZATION_STATUSES,
  TABLE_VALUES,
  TERMINAL_VISUALIZATION_STATUSES,
  VISUALIZATION_STATUS_VALUES,
  VisualizationStatus,
  isTerminalVisualizationStatus
} from "../../../backend/src/enums";

test("VisualizationStatus values match 00 §5 in order", () => {
  assert.deepEqual(VISUALIZATION_STATUS_VALUES, [
    "queued",
    "preparing",
    "analyzing",
    "generating_harnesses",
    "rendering",
    "diffing",
    "summarizing",
    "completed",
    "failed",
    "cancelled"
  ]);
});

test("terminal statuses are completed, failed, cancelled", () => {
  assert.deepEqual([...TERMINAL_VISUALIZATION_STATUSES], ["completed", "failed", "cancelled"]);
  assert.equal(isTerminalVisualizationStatus(VisualizationStatus.FAILED), true);
  assert.equal(isTerminalVisualizationStatus(VisualizationStatus.RENDERING), false);
});

test("non-terminal statuses are queued plus the active stages", () => {
  assert.deepEqual([...NON_TERMINAL_VISUALIZATION_STATUSES], ["queued", ...ACTIVE_VISUALIZATION_STATUSES]);
  assert.equal(
    NON_TERMINAL_VISUALIZATION_STATUSES.length + TERMINAL_VISUALIZATION_STATUSES.length,
    VISUALIZATION_STATUS_VALUES.length
  );
});

test("value tuples are non-empty and CHECK-safe", () => {
  for (const values of [AI_EFFORT_VALUES, COMPONENT_RENDER_STATUS_VALUES, VISUALIZATION_STATUS_VALUES]) {
    assert.ok(values.length > 0);
    for (const value of values) {
      assert.match(value, /^[a-z0-9_]+$/);
    }
  }
});

test("Table values are the snake_case SQL table names", () => {
  assert.deepEqual(TABLE_VALUES, [
    "app_settings",
    "repositories",
    "visualizations",
    "visualization_components",
    "visualization_console_events"
  ]);
});
