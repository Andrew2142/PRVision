import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVE_VISUALIZATION_STATUSES,
  AI_EFFORT_VALUES,
  AI_PROVIDER_KIND_VALUES,
  AiEffort,
  AiProviderKind,
  COMPONENT_CHANGE_KIND_VALUES,
  COMPONENT_RENDER_STATUS_VALUES,
  COMPONENT_RISK_VALUES,
  COMPONENT_VISUAL_CHANGE_VALUES,
  CONSOLE_LEVEL_VALUES,
  ComponentChangeKind,
  ComponentRenderStatus,
  ComponentRisk,
  ComponentVisualChange,
  ConsoleLevel,
  DeletionMode,
  NON_TERMINAL_VISUALIZATION_STATUSES,
  PACKAGE_MANAGER_VALUES,
  PackageManager,
  REPOSITORY_FRAMEWORK_VALUES,
  RepositoryFramework,
  TABLE_VALUES,
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
    values: ["modified", "added", "removed", "affected_parent", "replaced"] // 00 §17 adds replaced
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
    VISUALIZATION_CONSOLE_EVENTS: "visualization_console_events"
  });
  assert.deepEqual([...TABLE_VALUES], Object.values(Table));
  assert.deepEqual(DeletionMode, { SOFT: "soft", HARD: "hard" });
});

test("TERMINAL_VISUALIZATION_STATUSES is a subset of VisualizationStatus values", () => {
  for (const status of TERMINAL_VISUALIZATION_STATUSES) {
    assert.ok((VISUALIZATION_STATUS_VALUES as readonly string[]).includes(status), status);
  }
});

test("ACTIVE + TERMINAL + queued covers every VisualizationStatus exactly once", () => {
  const combined = [VisualizationStatus.QUEUED, ...ACTIVE_VISUALIZATION_STATUSES, ...TERMINAL_VISUALIZATION_STATUSES];
  assert.equal(new Set(combined).size, combined.length);
  assert.deepEqual([...combined].sort(), [...VISUALIZATION_STATUS_VALUES].sort());
  assert.deepEqual([...NON_TERMINAL_VISUALIZATION_STATUSES], ["queued", ...ACTIVE_VISUALIZATION_STATUSES]);
});

test("enumValues throws on an empty object", () => {
  assert.throws(() => enumValues({}), /empty enum object/);
});
