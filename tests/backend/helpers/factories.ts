/**
 * Row and model builders (sheet 14 §5.4.14). Rows contain EVERY column of their table (camelCase properties,
 * 03 §6.1) so `assert.deepEqual` on views is meaningful. Because InMemoryQueryHandler does not evaluate CHECK
 * constraints, overrides that would violate one of 03's CHECKs throw here instead.
 */
import type { TABLE_SCHEMAS } from "../../../backend/src/database/table-registry";
import {
  AI_EFFORT_VALUES,
  AI_PROVIDER_KIND_VALUES,
  COMPONENT_CHANGE_KIND_VALUES,
  COMPONENT_HARNESS_ORIGIN_VALUES,
  COMPONENT_RENDER_STATUS_VALUES,
  COMPONENT_RISK_VALUES,
  COMPONENT_VISUAL_CHANGE_VALUES,
  CONSOLE_LEVEL_VALUES,
  HARNESS_LIBRARY_ORIGIN_VALUES,
  HARNESS_LIBRARY_STATUS_VALUES,
  LIBRARY_BUILD_MODE_VALUES,
  LIBRARY_JOB_KIND_VALUES,
  LIBRARY_JOB_STATUS_VALUES,
  TERMINAL_LIBRARY_JOB_STATUSES,
  NON_TERMINAL_VISUALIZATION_STATUSES,
  PACKAGE_MANAGER_VALUES,
  REPOSITORY_FRAMEWORK_VALUES,
  TERMINAL_VISUALIZATION_STATUSES,
  VISUALIZATION_SOURCE_TYPE_VALUES,
  VISUALIZATION_STATUS_VALUES,
  type Table
} from "../../../backend/src/enums";
import { RepositoryModel, VisualizationModel } from "../../../backend/src/models";
import { ModelHandler } from "../../../backend/src/utilities/handlers/model-handler";

type RowOf<T extends Table> = (typeof TABLE_SCHEMAS)[T]["$inferSelect"];
export type SettingsRow = RowOf<"app_settings">;
export type RepositoryRow = RowOf<"repositories">;
export type VisualizationRow = RowOf<"visualizations">;
export type ComponentRow = RowOf<"visualization_components">;
export type ConsoleEventRow = RowOf<"visualization_console_events">;
export type LibraryEntryRow = RowOf<"harness_library_entries">;
export type LibraryJobRow = RowOf<"harness_library_jobs">;
export type LibraryJobEventRow = RowOf<"harness_library_job_events">;

/** Fixed timestamp used by every factory (and InMemoryQueryHandler's default clock). */
export const FIXED_DATE = "2026-01-01T00:00:00.000Z";
const at = (): Date => new Date(FIXED_DATE);

function check(condition: boolean, constraint: string, detail: string): void {
  if (!condition) {
    throw new Error(`factory override violates ${constraint}: ${detail}`);
  }
}

function checkEnum(value: unknown, allowed: readonly string[], constraint: string, nullable = false): void {
  if (nullable && value === null) {
    return;
  }
  check(typeof value === "string" && allowed.includes(value), constraint, JSON.stringify(value));
}

/** app_settings row (id 1, defaults of migration 0001). */
export function makeSettingsRow(overrides: Partial<SettingsRow> = {}): SettingsRow {
  const row: SettingsRow = {
    id: 1,
    githubTokenEncrypted: null,
    githubLogin: null,
    aiProvider: "anthropic_api",
    anthropicApiKeyEncrypted: null,
    aiModel: "claude-opus-5-5",
    aiHarnessEffort: "high",
    aiSummaryEffort: "medium",
    createdAt: at(),
    updatedAt: at(),
    ...overrides
  };
  check(row.id === 1, "app_settings_singleton_check", `id ${row.id}`);
  checkEnum(row.aiProvider, AI_PROVIDER_KIND_VALUES, "app_settings_ai_provider_check");
  checkEnum(row.aiHarnessEffort, AI_EFFORT_VALUES, "app_settings_ai_harness_effort_check");
  checkEnum(row.aiSummaryEffort, AI_EFFORT_VALUES, "app_settings_ai_summary_effort_check");
  check(row.aiModel.trim().length > 0, "app_settings_ai_model_check", "empty aiModel");
  return row;
}

/** repositories row: the fixture repo shape, not deleted. */
export function makeRepositoryRow(overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  const row: RepositoryRow = {
    id: 1,
    name: "sample-react-app",
    localPath: "/tmp/prvision-test-repo/sample-react-app",
    githubOwner: null,
    githubRepo: null,
    defaultBranch: "main",
    framework: "react_vite",
    packageManager: "npm",
    appRoot: ".",
    angularProject: null,
    angularBuildConfiguration: null,
    viteConfigPath: "vite.config.ts",
    tsconfigPath: "tsconfig.json",
    entryFilePath: "src/main.tsx",
    globalStylePaths: ["/src/index.css"],
    renderViewport: "desktop",
    libraryBuildMode: "grow",
    stateAllowance: 3,
    lastDetectedAt: at(),
    isDeleted: false,
    createdAt: at(),
    updatedAt: at(),
    ...overrides
  };
  checkEnum(row.framework, REPOSITORY_FRAMEWORK_VALUES, "repositories_framework_check");
  checkEnum(row.libraryBuildMode, LIBRARY_BUILD_MODE_VALUES, "repositories_library_build_mode_check");
  check(
    Number.isInteger(row.stateAllowance) && row.stateAllowance >= 1 && row.stateAllowance <= 5,
    "repositories_state_allowance_check",
    String(row.stateAllowance)
  );
  checkEnum(row.packageManager, PACKAGE_MANAGER_VALUES, "repositories_package_manager_check");
  check(row.localPath.startsWith("/"), "repositories_local_path_absolute_check", row.localPath);
  check(row.name.trim().length > 0, "repositories_name_check", "empty name");
  check(
    (row.githubOwner === null) === (row.githubRepo === null),
    "repositories_github_pair_check",
    "githubOwner and githubRepo must both be null or both set"
  );
  check(Array.isArray(row.globalStylePaths), "repositories_global_style_paths_check", "not an array");
  check(
    (row.framework === "angular") === (row.angularProject !== null),
    "repositories_angular_project_check",
    "angularProject must be set exactly for angular"
  );
  check(row.framework !== "react_vite" || row.appRoot === ".", "repositories_react_root_check", row.appRoot);
  return row;
}

/** visualizations row: a queued local_branch run (jobId viz-<id>). */
export function makeVisualizationRow(overrides: Partial<VisualizationRow> = {}): VisualizationRow {
  const id = overrides.id ?? 1;
  const row: VisualizationRow = {
    id,
    repositoryId: 1,
    sourceType: "local_branch",
    prNumber: null,
    title: "feature/button-restyle → main",
    baseRef: "main",
    headRef: "feature/button-restyle",
    baseSha: null,
    headSha: null,
    status: "queued",
    errorMessage: null,
    failedStage: null,
    summaryMarkdown: null,
    aiProvider: "anthropic_api",
    aiModel: "claude-opus-5-5",
    aiUsage: null,
    jobId: `viz-${id}`,
    componentCount: 0,
    changedCount: 0,
    componentLimit: null,
    renderViewport: null,
    checkedCount: 0,
    reusedHarnessCount: 0,
    newHarnessCount: 0,
    needsUpdateCount: 0,
    globalStyleTrigger: null,
    workingTreeSnapshot: false,
    startedAt: null,
    completedAt: null,
    isDeleted: false,
    createdAt: at(),
    updatedAt: at(),
    ...overrides
  };
  checkEnum(row.sourceType, VISUALIZATION_SOURCE_TYPE_VALUES, "visualizations_source_type_check");
  checkEnum(row.status, VISUALIZATION_STATUS_VALUES, "visualizations_status_check");
  checkEnum(row.aiProvider, AI_PROVIDER_KIND_VALUES, "visualizations_ai_provider_check");
  check(
    row.sourceType === "github_pr" ? row.prNumber !== null && row.prNumber > 0 : row.prNumber === null,
    "visualizations_pr_number_check",
    `sourceType ${row.sourceType} with prNumber ${String(row.prNumber)}`
  );
  check(
    row.componentCount >= 0 && row.changedCount >= 0 && row.changedCount <= row.componentCount,
    "visualizations_counts_check",
    `componentCount ${row.componentCount}, changedCount ${row.changedCount}`
  );
  const isTerminal = (TERMINAL_VISUALIZATION_STATUSES as readonly string[]).includes(row.status);
  check(row.completedAt === null || isTerminal, "visualizations_completed_at_check", `completedAt on ${row.status}`);
  checkEnum(row.failedStage, NON_TERMINAL_VISUALIZATION_STATUSES, "visualizations_failed_stage_check", true);
  check(
    row.failedStage === null || row.status === "failed" || row.status === "cancelled",
    "visualizations_failed_stage_status_check",
    `failedStage on ${row.status}`
  );
  check(
    row.checkedCount >= 0 && row.checkedCount <= row.componentCount,
    "visualizations_checked_count_check",
    `checkedCount ${row.checkedCount}, componentCount ${row.componentCount}`
  );
  check(
    !row.workingTreeSnapshot || row.sourceType === "working_tree",
    "visualizations_working_tree_snapshot_check",
    `workingTreeSnapshot on ${row.sourceType}`
  );
  return row;
}

/** visualization_components row: a pending modified Button. Image paths are relative (00 §14.3) when set. */
export function makeComponentRow(overrides: Partial<ComponentRow> = {}): ComponentRow {
  const row: ComponentRow = {
    id: 1,
    visualizationId: 1,
    filePath: "src/components/Button.tsx",
    exportName: "default",
    displayName: "Button",
    changeKind: "modified",
    renderStatus: "pending",
    visualChange: null,
    risk: null,
    rank: 0,
    changeReason: "Component code changed",
    skipReason: null,
    harnessSource: null,
    harnessNotes: null,
    mockedModules: [],
    baseImagePath: null,
    headImagePath: null,
    diffImagePath: null,
    imageWidth: null,
    imageHeight: null,
    diffPixelRatio: null,
    codeDiff: null,
    structuralDiff: null,
    aiNote: null,
    baseError: null,
    headError: null,
    baseFilePath: null,
    baseExportName: null,
    baseDisplayName: null,
    baseHarnessSource: null,
    baseHarnessNotes: null,
    baseMockedModules: null,
    successorEvidence: null,
    libraryEntryId: null,
    baseLibraryEntryId: null,
    harnessOrigin: null,
    baseHarnessOrigin: null,
    harnessNeedsUpdate: false,
    sourceChangedSinceWrite: null,
    stateCount: 0,
    changedStateCount: 0,
    createdAt: at(),
    updatedAt: at(),
    ...overrides
  };
  checkEnum(row.changeKind, COMPONENT_CHANGE_KIND_VALUES, "visualization_components_change_kind_check");
  checkEnum(row.renderStatus, COMPONENT_RENDER_STATUS_VALUES, "visualization_components_render_status_check");
  checkEnum(row.visualChange, COMPONENT_VISUAL_CHANGE_VALUES, "visualization_components_visual_change_check", true);
  checkEnum(row.risk, COMPONENT_RISK_VALUES, "visualization_components_risk_check", true);
  check(row.rank >= 0, "visualization_components_rank_check", `rank ${row.rank}`);
  check(
    (row.imageWidth === null || row.imageWidth > 0) && (row.imageHeight === null || row.imageHeight > 0),
    "visualization_components_image_size_check",
    `${String(row.imageWidth)}x${String(row.imageHeight)}`
  );
  check(
    row.diffPixelRatio === null || (row.diffPixelRatio >= 0 && row.diffPixelRatio <= 1),
    "visualization_components_diff_pixel_ratio_check",
    String(row.diffPixelRatio)
  );
  check(
    !row.filePath.startsWith("/") && row.filePath.length > 0,
    "visualization_components_file_path_relative_check",
    row.filePath
  );
  check(
    row.skipReason === null || row.renderStatus === "skipped",
    "visualization_components_skip_reason_check",
    `skipReason on ${row.renderStatus}`
  );
  for (const imagePath of [row.baseImagePath, row.headImagePath, row.diffImagePath]) {
    check(
      imagePath === null || imagePath.startsWith("artifacts/"),
      "visualization_components_image_path_relative_check",
      String(imagePath)
    );
  }
  const replacedColumns = [
    row.baseFilePath,
    row.baseExportName,
    row.baseDisplayName,
    row.baseHarnessSource,
    row.baseHarnessNotes,
    row.baseMockedModules,
    row.successorEvidence
  ];
  check(
    row.changeKind === "replaced"
      ? row.baseFilePath !== null && row.baseExportName !== null && row.baseDisplayName !== null
      : replacedColumns.every((value) => value === null),
    "visualization_components_replaced_columns_check",
    `base columns on ${row.changeKind}`
  );
  check(
    row.baseFilePath === null || (!row.baseFilePath.startsWith("/") && row.baseFilePath.length > 0),
    "visualization_components_base_file_path_relative_check",
    String(row.baseFilePath)
  );
  check(
    row.changeKind === "replaced" || row.baseLibraryEntryId === null,
    "visualization_components_base_library_entry_id_check",
    `baseLibraryEntryId on ${row.changeKind}`
  );
  checkEnum(row.harnessOrigin, COMPONENT_HARNESS_ORIGIN_VALUES, "visualization_components_harness_origin_check", true);
  checkEnum(
    row.baseHarnessOrigin,
    COMPONENT_HARNESS_ORIGIN_VALUES,
    "visualization_components_base_harness_origin_check",
    true
  );
  check(
    row.changeKind === "replaced" || row.baseHarnessOrigin === null,
    "visualization_components_base_harness_origin_check",
    `baseHarnessOrigin on ${row.changeKind}`
  );
  check(
    row.changedStateCount >= 0 && row.changedStateCount <= row.stateCount,
    "visualization_components_changed_state_count_check",
    `changedStateCount ${row.changedStateCount}, stateCount ${row.stateCount}`
  );
  return row;
}

/** visualization_console_events row (append-only: no updatedAt, no isDeleted). */
export function makeConsoleEventRow(overrides: Partial<ConsoleEventRow> = {}): ConsoleEventRow {
  const row: ConsoleEventRow = {
    id: 1,
    visualizationId: 1,
    level: "info",
    stage: "preparing",
    message: "Preparing workspaces",
    createdAt: at(),
    ...overrides
  };
  checkEnum(row.level, CONSOLE_LEVEL_VALUES, "visualization_console_events_level_check");
  checkEnum(row.stage, VISUALIZATION_STATUS_VALUES, "visualization_console_events_stage_check");
  return row;
}

/** harness_library_entries row (16 §6.3): a ready React harness with one Default state, revision 1. */
export function makeLibraryEntryRow(overrides: Partial<LibraryEntryRow> = {}): LibraryEntryRow {
  const row: LibraryEntryRow = {
    id: 1,
    repositoryId: 1,
    framework: "react_vite",
    filePath: "src/components/Card.tsx",
    exportName: "default",
    displayName: "Card",
    selector: null,
    sourceFingerprint: null,
    harnessSource: "export default definePrvisionHarness({ states: [] });",
    mockedModules: [],
    notes: "",
    states: [{ name: "Default", steps: [] }],
    stateCount: 1,
    stateAllowance: 3,
    status: "ready",
    origin: "scan",
    revision: 1,
    lastError: null,
    lastFailedVisualizationId: null,
    aiModel: "claude-opus-5-5",
    aiUsage: null,
    costUsd: null,
    writtenAt: at(),
    lastRenderedAt: null,
    createdAt: at(),
    updatedAt: at(),
    ...overrides
  };
  checkEnum(row.framework, REPOSITORY_FRAMEWORK_VALUES, "harness_library_entries_framework_check");
  checkEnum(row.status, HARNESS_LIBRARY_STATUS_VALUES, "harness_library_entries_status_check");
  checkEnum(row.origin, HARNESS_LIBRARY_ORIGIN_VALUES, "harness_library_entries_origin_check");
  check(
    (row.harnessSource === null && row.stateCount === 0) ||
      (row.harnessSource !== null && row.stateCount >= 1 && row.stateCount <= 5),
    "harness_library_entries_state_count_check",
    `stateCount ${row.stateCount}`
  );
  check(
    row.status !== "ready" || row.harnessSource !== null,
    "harness_library_entries_ready_harness_check",
    "ready without a harness"
  );
  check(row.stateAllowance >= 1 && row.stateAllowance <= 5, "harness_library_entries_state_allowance_check", "");
  return row;
}

/** harness_library_jobs row (16 §6.4): a queued scan of repository 1 without a cap. */
export function makeLibraryJobRow(overrides: Partial<LibraryJobRow> = {}): LibraryJobRow {
  const id = overrides.id ?? 1;
  const row: LibraryJobRow = {
    id,
    repositoryId: 1,
    kind: "scan",
    status: "queued",
    visualizationId: null,
    componentIds: null,
    stateAllowance: 3,
    spendCapUsd: null,
    scanSha: null,
    totalCount: 0,
    writtenCount: 0,
    failedCount: 0,
    skippedCount: 0,
    currentLabel: null,
    spentUsd: 0,
    aiUsage: null,
    aiModel: "claude-opus-5-5",
    jobId: `scan-${id}`,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: at(),
    updatedAt: at(),
    ...overrides
  };
  checkEnum(row.kind, LIBRARY_JOB_KIND_VALUES, "harness_library_jobs_kind_check");
  checkEnum(row.status, LIBRARY_JOB_STATUS_VALUES, "harness_library_jobs_status_check");
  check(
    (row.kind === "repair") === (row.visualizationId !== null) &&
      (row.kind === "repair") === (row.componentIds !== null),
    "harness_library_jobs_repair_check",
    `kind ${row.kind}`
  );
  check(
    row.spendCapUsd === null || (row.spendCapUsd > 0 && row.kind !== "repair"),
    "harness_library_jobs_spend_cap_check",
    String(row.spendCapUsd)
  );
  check(
    row.writtenCount + row.failedCount + row.skippedCount <= row.totalCount,
    "harness_library_jobs_counts_check",
    `counts over total ${row.totalCount}`
  );
  const terminal = (TERMINAL_LIBRARY_JOB_STATUSES as readonly string[]).includes(row.status);
  check(
    row.completedAt === null || terminal,
    "harness_library_jobs_completed_at_check",
    `completedAt on ${row.status}`
  );
  return row;
}

/** harness_library_job_events row (append-only: no updatedAt). */
export function makeLibraryJobEventRow(overrides: Partial<LibraryJobEventRow> = {}): LibraryJobEventRow {
  const row: LibraryJobEventRow = {
    id: 1,
    jobId: 1,
    level: "info",
    message: "Scanning 3 components",
    createdAt: at(),
    ...overrides
  };
  checkEnum(row.level, CONSOLE_LEVEL_VALUES, "harness_library_job_events_level_check");
  return row;
}

/** RepositoryModel hydrated through its generated setters (Uply makeUser pattern). */
export function makeRepositoryModel(overrides: Partial<RepositoryRow> = {}): RepositoryModel {
  return ModelHandler.hydrate(RepositoryModel, makeRepositoryRow(overrides));
}

/** VisualizationModel hydrated through its generated setters. */
export function makeVisualizationModel(overrides: Partial<VisualizationRow> = {}): VisualizationModel {
  return ModelHandler.hydrate(VisualizationModel, makeVisualizationRow(overrides));
}

/**
 * A model with only `id` set — what controllers build from an IdParamDTO before calling get/remove/redetect.
 * Defaults to RepositoryModel; pass another generated model class for other services.
 */
export function idModel(id: number): RepositoryModel;
export function idModel<T extends { setId(value: number): void }>(id: number, ModelClass: new () => T): T;
export function idModel(id: number, ModelClass: new () => { setId(value: number): void } = RepositoryModel): object {
  const model = new ModelClass();
  model.setId(id);
  return model;
}
