import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_VISUALIZATION_STATUSES,
  AI_EFFORT_VALUES,
  COMPONENT_CHANGE_KIND_VALUES,
  COMPONENT_HARNESS_ORIGIN_VALUES,
  COMPONENT_RENDER_STATUS_VALUES,
  HARNESS_LIBRARY_ORIGIN_VALUES,
  HARNESS_LIBRARY_STATUS_VALUES,
  LIBRARY_BUILD_MODE_VALUES,
  LIBRARY_JOB_KIND_VALUES,
  LIBRARY_JOB_STATUS_VALUES,
  LIVE_SESSION_STATUS_VALUES,
  LIVE_STOP_REASON_VALUES,
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
    "awaiting_confirmation", // 00 §19
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

test("non-terminal statuses are queued, awaiting_confirmation (00 §19) and the active stages", () => {
  assert.deepEqual(
    [...NON_TERMINAL_VISUALIZATION_STATUSES],
    ["queued", "awaiting_confirmation", ...ACTIVE_VISUALIZATION_STATUSES]
  );
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
    "visualization_console_events",
    "harness_library_entries",
    "harness_library_jobs",
    "harness_library_job_events",
    "visualization_component_states",
    "live_sessions"
  ]);
});

test("16 §6.1: new enum value tuples are non-empty and CHECK-safe", () => {
  for (const values of [
    HARNESS_LIBRARY_STATUS_VALUES,
    HARNESS_LIBRARY_ORIGIN_VALUES,
    LIBRARY_BUILD_MODE_VALUES,
    LIBRARY_JOB_KIND_VALUES,
    LIBRARY_JOB_STATUS_VALUES,
    COMPONENT_HARNESS_ORIGIN_VALUES,
    LIVE_SESSION_STATUS_VALUES,
    LIVE_STOP_REASON_VALUES,
    COMPONENT_CHANGE_KIND_VALUES
  ]) {
    assert.ok(values.length > 0);
    for (const value of values) {
      assert.match(value, /^[a-z0-9_]+$/);
    }
  }
  assert.ok((COMPONENT_CHANGE_KIND_VALUES as readonly string[]).includes("rechecked"));
});
