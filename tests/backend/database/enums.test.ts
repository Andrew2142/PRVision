import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_LIBRARY_JOB_STATUSES,
  ACTIVE_LIVE_SESSION_STATUSES,
  ACTIVE_VISUALIZATION_STATUSES,
  AI_EFFORT_VALUES,
  AI_PROVIDER_KIND_VALUES,
  AiEffort,
  AiProviderKind,
  COMPONENT_CHANGE_KIND_VALUES,
  COMPONENT_HARNESS_ORIGIN_VALUES,
  COMPONENT_RENDER_STATUS_VALUES,
  COMPONENT_RISK_VALUES,
  COMPONENT_VISUAL_CHANGE_VALUES,
  CONSOLE_LEVEL_VALUES,
  ComponentChangeKind,
  ComponentHarnessOrigin,
  ComponentRenderStatus,
  ComponentRisk,
  ComponentVisualChange,
  ConsoleLevel,
  DeletionMode,
  HARNESS_LIBRARY_ORIGIN_VALUES,
  HARNESS_LIBRARY_STATUS_VALUES,
  HarnessLibraryOrigin,
  HarnessLibraryStatus,
  LIBRARY_BUILD_MODE_VALUES,
  LIBRARY_JOB_KIND_VALUES,
  LIBRARY_JOB_STATUS_VALUES,
  LIVE_SESSION_STATUS_VALUES,
  LIVE_STOP_REASON_VALUES,
  LibraryBuildMode,
  LibraryJobKind,
  LibraryJobStatus,
  LiveSessionStatus,
  LiveStopReason,
  NON_TERMINAL_VISUALIZATION_STATUSES,
  PACKAGE_MANAGER_VALUES,
  PackageManager,
  REPOSITORY_FRAMEWORK_VALUES,
  RepositoryFramework,
  TABLE_VALUES,
  TERMINAL_LIBRARY_JOB_STATUSES,
  TERMINAL_VISUALIZATION_STATUSES,
  Table,
  VISUALIZATION_SOURCE_TYPE_VALUES,
  VISUALIZATION_STATUS_VALUES,
  VisualizationSourceType,
  VisualizationStatus,
  enumValues
} from "../../../backend/src/enums";

/** 00 §5, verbatim. */
const EXPECTED: Array<{
  name: string;
  object: Record<string, string>;
  tuple: readonly string[];
  values: string[];
}> = [
  {
    name: "AiProviderKind",
    object: AiProviderKind,
    tuple: AI_PROVIDER_KIND_VALUES,
    values: ["anthropic_api", "claude_code"]
  },
  {
    name: "AiEffort",
    object: AiEffort,
    tuple: AI_EFFORT_VALUES,
    values: ["low", "medium", "high", "xhigh", "max"]
  },
  {
    name: "RepositoryFramework",
    object: RepositoryFramework,
    tuple: REPOSITORY_FRAMEWORK_VALUES,
    values: ["react_vite", "angular"]
  },
  {
    name: "PackageManager",
    object: PackageManager,
    tuple: PACKAGE_MANAGER_VALUES,
    values: ["npm", "pnpm", "yarn"]
  },
  {
    name: "VisualizationSourceType",
    object: VisualizationSourceType,
    tuple: VISUALIZATION_SOURCE_TYPE_VALUES,
    values: ["github_pr", "local_branch", "working_tree", "commit_range"] // 00 §16 adds commit_range
  },
  {
    name: "VisualizationStatus",
    object: VisualizationStatus,
    tuple: VISUALIZATION_STATUS_VALUES,
    values: [
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
    ]
  },
  {
    name: "ComponentChangeKind",
    object: ComponentChangeKind,
    tuple: COMPONENT_CHANGE_KIND_VALUES,
    values: ["modified", "added", "removed", "affected_parent", "replaced", "rechecked"] // 00 §17 replaced, §21 rechecked
  },
  {
    name: "ComponentRenderStatus",
    object: ComponentRenderStatus,
    tuple: COMPONENT_RENDER_STATUS_VALUES,
    values: ["pending", "rendered", "partial", "failed", "skipped"]
  },
  {
    name: "ComponentVisualChange",
    object: ComponentVisualChange,
    tuple: COMPONENT_VISUAL_CHANGE_VALUES,
    values: ["changed", "unchanged", "new", "deleted"]
  },
  {
    name: "ComponentRisk",
    object: ComponentRisk,
    tuple: COMPONENT_RISK_VALUES,
    values: ["none", "check", "likely_regression"]
  },
  {
    name: "ConsoleLevel",
    object: ConsoleLevel,
    tuple: CONSOLE_LEVEL_VALUES,
    values: ["info", "warn", "error"]
  },
  // 00 §21 / sheet 16 §6.1
  {
    name: "HarnessLibraryStatus",
    object: HarnessLibraryStatus,
    tuple: HARNESS_LIBRARY_STATUS_VALUES,
    values: ["ready", "needs_update", "off_default_branch"]
  },
  {
    name: "HarnessLibraryOrigin",
    object: HarnessLibraryOrigin,
    tuple: HARNESS_LIBRARY_ORIGIN_VALUES,
    values: ["run", "scan", "repair", "import"]
  },
  {
    name: "LibraryBuildMode",
    object: LibraryBuildMode,
    tuple: LIBRARY_BUILD_MODE_VALUES,
    values: ["grow", "scan"]
  },
  {
    name: "LibraryJobKind",
    object: LibraryJobKind,
    tuple: LIBRARY_JOB_KIND_VALUES,
    values: ["scan", "rescan", "repair"]
  },
  {
    name: "LibraryJobStatus",
    object: LibraryJobStatus,
    tuple: LIBRARY_JOB_STATUS_VALUES,
    values: ["queued", "preparing", "running", "completed", "cap_reached", "failed", "cancelled"]
  },
  {
    name: "ComponentHarnessOrigin",
    object: ComponentHarnessOrigin,
    tuple: COMPONENT_HARNESS_ORIGIN_VALUES,
    values: ["library", "written", "repaired"]
  },
  {
    name: "LiveSessionStatus",
    object: LiveSessionStatus,
    tuple: LIVE_SESSION_STATUS_VALUES,
    values: ["starting", "ready", "stopping", "stopped", "failed"]
  },
  {
    name: "LiveStopReason",
    object: LiveStopReason,
    tuple: LIVE_STOP_REASON_VALUES,
    values: ["user", "left", "idle", "max_duration", "shutdown", "error"]
  }
];

test("each domain enum has exactly the values listed in 00 §5", () => {
  for (const { name, object, tuple, values } of EXPECTED) {
    assert.deepEqual(Object.values(object), values, `${name} object values`);
    assert.deepEqual([...tuple], values, `${name} *_VALUES tuple`);
  }
});

test("Table values are the snake_case SQL table names (00 §14.3)", () => {
  assert.deepEqual(Table, {
    APP_SETTINGS: "app_settings",
    REPOSITORIES: "repositories",
    VISUALIZATIONS: "visualizations",
    VISUALIZATION_COMPONENTS: "visualization_components",
    VISUALIZATION_CONSOLE_EVENTS: "visualization_console_events",
    HARNESS_LIBRARY_ENTRIES: "harness_library_entries",
    HARNESS_LIBRARY_JOBS: "harness_library_jobs",
    HARNESS_LIBRARY_JOB_EVENTS: "harness_library_job_events",
    VISUALIZATION_COMPONENT_STATES: "visualization_component_states",
    LIVE_SESSIONS: "live_sessions"
  });
  assert.deepEqual([...TABLE_VALUES], Object.values(Table));
  assert.deepEqual(DeletionMode, { SOFT: "soft", HARD: "hard" });
});

test("TERMINAL_VISUALIZATION_STATUSES is a subset of VisualizationStatus values", () => {
  for (const status of TERMINAL_VISUALIZATION_STATUSES) {
    assert.ok((VISUALIZATION_STATUS_VALUES as readonly string[]).includes(status), status);
  }
});

test("ACTIVE + TERMINAL + queued + awaiting_confirmation covers every VisualizationStatus exactly once", () => {
  // 00 §19: awaiting_confirmation is neither terminal nor active.
  const combined = [
    VisualizationStatus.QUEUED,
    VisualizationStatus.AWAITING_CONFIRMATION,
    ...ACTIVE_VISUALIZATION_STATUSES,
    ...TERMINAL_VISUALIZATION_STATUSES
  ];
  assert.equal(new Set(combined).size, combined.length);
  assert.deepEqual([...combined].sort(), [...VISUALIZATION_STATUS_VALUES].sort());
  assert.deepEqual(
    [...NON_TERMINAL_VISUALIZATION_STATUSES],
    ["queued", "awaiting_confirmation", ...ACTIVE_VISUALIZATION_STATUSES]
  );
});

test("16 §6.1: ACTIVE and TERMINAL library job statuses partition LibraryJobStatus", () => {
  assert.deepEqual([...ACTIVE_LIBRARY_JOB_STATUSES], ["queued", "preparing", "running"]);
  assert.deepEqual([...TERMINAL_LIBRARY_JOB_STATUSES], ["completed", "cap_reached", "failed", "cancelled"]);
  const combined = [...ACTIVE_LIBRARY_JOB_STATUSES, ...TERMINAL_LIBRARY_JOB_STATUSES];
  assert.equal(new Set(combined).size, combined.length);
  assert.deepEqual([...combined].sort(), [...LIBRARY_JOB_STATUS_VALUES].sort());
});

test("16 §6.1: ACTIVE_LIVE_SESSION_STATUSES are starting, ready, stopping", () => {
  assert.deepEqual([...ACTIVE_LIVE_SESSION_STATUSES], ["starting", "ready", "stopping"]);
  for (const status of ACTIVE_LIVE_SESSION_STATUSES) {
    assert.ok((LIVE_SESSION_STATUS_VALUES as readonly string[]).includes(status), status);
  }
});

test("enumValues throws on an empty object", () => {
  assert.throws(() => enumValues({}), /empty enum object/);
});
