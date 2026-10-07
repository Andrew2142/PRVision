// backend/src/database/schema.ts
// Single source of truth for the PRVision database. After editing:
//   npm run generate:models && npm run db:generate   (then commit schema, models and migration together)
import { relations, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar
} from "drizzle-orm/pg-core";
import {
  ACTIVE_LIBRARY_JOB_STATUSES,
  ACTIVE_LIVE_SESSION_STATUSES,
  AiEffort,
  AiProviderKind,
  ComponentChangeKind,
  ComponentHarnessOrigin,
  ComponentRenderStatus,
  ComponentRisk,
  ComponentVisualChange,
  ConsoleLevel,
  HarnessLibraryOrigin,
  HarnessLibraryStatus,
  LibraryBuildMode,
  LibraryJobKind,
  LibraryJobStatus,
  LiveSessionStatus,
  LiveStopReason,
  NON_TERMINAL_VISUALIZATION_STATUSES,
  PackageManager,
  RepositoryFramework,
  TERMINAL_LIBRARY_JOB_STATUSES,
  TERMINAL_VISUALIZATION_STATUSES,
  VisualizationSourceType,
  VisualizationStatus,
  enumValues
} from "../enums";
import type { HarnessStateSpec, HarnessStep, LiveHostState, LiveOpenRequestRecord } from "../types/harness-library";
import type {
  AiUsage,
  MockedModule,
  RenderFailureKindValue,
  StructuralChange,
  SuccessorEvidence
} from "../types/visualization-pipeline";

// ---------------------------------------------------------------------------------------------
// Helpers (module-private; not exported so the model generator ignores them)
// ---------------------------------------------------------------------------------------------

const CHECK_LITERAL = /^[a-z0-9_]+$/;

/**
 * Joins enum literals for use inside a CHECK constraint or partial-index predicate. The only sql.raw in the
 * codebase: every literal is validated first, so nothing but [a-z0-9_] can ever reach the DDL.
 */
function sqlLiteralList(values: readonly string[]): SQL {
  for (const value of values) {
    if (!CHECK_LITERAL.test(value)) {
      throw new Error(`Literal "${value}" is not allowed in a CHECK constraint`);
    }
  }
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

/** `<column> in ('a', 'b', ...)` built from an enum value list. */
function checkIn(column: AnyColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sqlLiteralList(values)})`;
}

/** Same as checkIn but allows NULL. */
function checkInOrNull(column: AnyColumn, values: readonly string[]): SQL {
  return sql`${column} is null or ${column} in (${sqlLiteralList(values)})`;
}

const timestampTz = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: "date" });

const createdAt = () => timestampTz("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestampTz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Default AI model for a fresh install (00 D5). Kept here, not in config-consts, so drizzle-kit never reads env. */
const DEFAULT_AI_MODEL = "claude-opus-5-5";

/**
 * State allowance default (16 E23). Equals STATE_ALLOWANCE_DEFAULT; the 1–5 CHECK literals equal STATE_ALLOWANCE_MIN/MAX
 * (both asserted by tests; config validation keeps MIN/MAX fixed). Literals here so drizzle-kit never reads env.
 */
const DEFAULT_STATE_ALLOWANCE = 3;

/** `<column> between 1 and 5`: the state allowance range (16 §6.2). */
function checkStateAllowance(column: AnyColumn): SQL {
  return sql`${column} between 1 and 5`;
}

/**
 * Every value of 10's RenderFailureKind (16 §6.6 base/head_failure_kind). A Record so a kind added to the union
 * without an entry here is a compile error.
 */
const RENDER_FAILURE_KINDS: Record<RenderFailureKindValue, true> = {
  vite_unavailable: true,
  navigation: true,
  module_load: true,
  render_error: true,
  timeout: true,
  step_failed: true,
  browser: true,
  screenshot: true,
  file_missing: true,
  budget_exceeded: true,
  cancelled: true
};
const RENDER_FAILURE_KIND_VALUES = Object.keys(RENDER_FAILURE_KINDS) as [
  RenderFailureKindValue,
  ...RenderFailureKindValue[]
];

// ---------------------------------------------------------------------------------------------
// app_settings — singleton (id = 1). Seeded by migration 0001.
// ---------------------------------------------------------------------------------------------
export const appSettings = pgTable(
  "app_settings",
  {
    id: serial("id").primaryKey(),
    githubTokenEncrypted: text("github_token_encrypted"),
    githubLogin: varchar("github_login", { length: 100 }),
    aiProvider: text("ai_provider", { enum: enumValues(AiProviderKind) })
      .notNull()
      .default(AiProviderKind.ANTHROPIC_API),
    anthropicApiKeyEncrypted: text("anthropic_api_key_encrypted"),
    aiModel: varchar("ai_model", { length: 100 }).notNull().default(DEFAULT_AI_MODEL),
    aiHarnessEffort: text("ai_harness_effort", { enum: enumValues(AiEffort) })
      .notNull()
      .default(AiEffort.HIGH),
    aiSummaryEffort: text("ai_summary_effort", { enum: enumValues(AiEffort) })
      .notNull()
      .default(AiEffort.MEDIUM),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    check("app_settings_singleton_check", sql`${table.id} = 1`),
    check("app_settings_ai_provider_check", checkIn(table.aiProvider, enumValues(AiProviderKind))),
    check("app_settings_ai_harness_effort_check", checkIn(table.aiHarnessEffort, enumValues(AiEffort))),
    check("app_settings_ai_summary_effort_check", checkIn(table.aiSummaryEffort, enumValues(AiEffort))),
    check("app_settings_ai_model_check", sql`length(trim(${table.aiModel})) > 0`)
  ]
);

// ---------------------------------------------------------------------------------------------
// repositories — soft-deletable. One row per app: (local_path, app_root, angular_project) unique among non-deleted rows.
// ---------------------------------------------------------------------------------------------
export const repositories = pgTable(
  "repositories",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    localPath: text("local_path").notNull(),
    githubOwner: varchar("github_owner", { length: 100 }),
    githubRepo: varchar("github_repo", { length: 100 }),
    defaultBranch: varchar("default_branch", { length: 255 }).notNull(),
    framework: text("framework", { enum: enumValues(RepositoryFramework) })
      .notNull()
      .default(RepositoryFramework.REACT_VITE),
    packageManager: text("package_manager", { enum: enumValues(PackageManager) }).notNull(),
    /** Repo-relative POSIX folder of the app inside the clone; "." = repository root (15 §5.4.1). */
    appRoot: text("app_root").notNull().default("."),
    /** Screen size screenshots are taken at: desktop 1280×800, tablet 768×1024, mobile 390×844. */
    renderViewport: text("render_viewport", { enum: ["desktop", "tablet", "mobile"] })
      .notNull()
      .default("desktop"),
    /** Project key in angular.json; set exactly when framework = 'angular'. */
    angularProject: text("angular_project"),
    /** Build configuration merged over the build target's options; null = base options only. */
    angularBuildConfiguration: text("angular_build_configuration"),
    viteConfigPath: text("vite_config_path"),
    tsconfigPath: text("tsconfig_path"),
    entryFilePath: text("entry_file_path"),
    globalStylePaths: jsonb("global_style_paths")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** 16 §6.2 (D3): how the harness library is built. */
    libraryBuildMode: text("library_build_mode", { enum: enumValues(LibraryBuildMode) })
      .notNull()
      .default(LibraryBuildMode.GROW),
    /** 16 §6.2 (D4): maximum states per harness, 1–5. */
    stateAllowance: integer("state_allowance").notNull().default(DEFAULT_STATE_ALLOWANCE),
    lastDetectedAt: timestampTz("last_detected_at").notNull().defaultNow(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("repositories_local_path_app_active_key")
      .on(table.localPath, table.appRoot, sql`coalesce(${table.angularProject}, '')`)
      .where(sql`${table.isDeleted} = false`),
    index("repositories_active_created_at_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.isDeleted} = false`),
    check("repositories_framework_check", checkIn(table.framework, enumValues(RepositoryFramework))),
    check("repositories_package_manager_check", checkIn(table.packageManager, enumValues(PackageManager))),
    check("repositories_local_path_absolute_check", sql`${table.localPath} like '/%'`),
    check("repositories_name_check", sql`length(trim(${table.name})) > 0`),
    check("repositories_github_pair_check", sql`(${table.githubOwner} is null) = (${table.githubRepo} is null)`),
    check("repositories_global_style_paths_check", sql`jsonb_typeof(${table.globalStylePaths}) = 'array'`),
    // Repo-relative POSIX folder: no leading "/", no "." or ".." segment, no trailing "/", no backslash.
    check(
      "repositories_app_root_check",
      sql`${table.appRoot} = '.' or (${table.appRoot} !~ '^/' and ${table.appRoot} !~ '(^|/)\\.\\.?(/|$)' and ${table.appRoot} !~ '/$' and ${table.appRoot} !~ '\\\\')`
    ),
    check(
      "repositories_angular_project_check",
      sql`(${table.framework} = 'angular') = (${table.angularProject} is not null)`
    ),
    // React apps may live in a sub-folder (monorepo app root); the Vite root is the app's vite.config folder.
    check("repositories_render_viewport_check", sql`${table.renderViewport} in ('desktop', 'tablet', 'mobile')`),
    check("repositories_library_build_mode_check", checkIn(table.libraryBuildMode, enumValues(LibraryBuildMode))),
    check("repositories_state_allowance_check", checkStateAllowance(table.stateAllowance))
  ]
);

// ---------------------------------------------------------------------------------------------
// visualizations — soft-deletable. One row per requested visual review.
// ---------------------------------------------------------------------------------------------
export const visualizations = pgTable(
  "visualizations",
  {
    id: serial("id").primaryKey(),
    repositoryId: integer("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    sourceType: text("source_type", { enum: enumValues(VisualizationSourceType) }).notNull(),
    prNumber: integer("pr_number"),
    title: text("title").notNull(),
    baseRef: varchar("base_ref", { length: 255 }).notNull(),
    headRef: varchar("head_ref", { length: 255 }).notNull(),
    baseSha: varchar("base_sha", { length: 64 }),
    headSha: varchar("head_sha", { length: 64 }),
    status: text("status", { enum: enumValues(VisualizationStatus) })
      .notNull()
      .default(VisualizationStatus.QUEUED),
    errorMessage: text("error_message"),
    /** Stage that was active when the run failed or was cancelled (00 §14.3). Null otherwise. */
    failedStage: text("failed_stage", { enum: NON_TERMINAL_VISUALIZATION_STATUSES }),
    summaryMarkdown: text("summary_markdown"),
    aiProvider: text("ai_provider", { enum: enumValues(AiProviderKind) }).notNull(),
    aiModel: varchar("ai_model", { length: 100 }).notNull(),
    aiUsage: jsonb("ai_usage").$type<AiUsage>(),
    jobId: varchar("job_id", { length: 64 }),
    componentCount: integer("component_count").notNull().default(0),
    changedCount: integer("changed_count").notNull().default(0),
    /** Components to render, confirmed by the user when analysis found more than MAX_COMPONENTS; null = default. */
    componentLimit: integer("component_limit"),
    /** Screen size chosen for this run; null = the repository's screen size. */
    renderViewport: text("render_viewport", { enum: ["desktop", "tablet", "mobile"] }),
    /** 16 §6.8: rows that reached rendering. */
    checkedCount: integer("checked_count").notNull().default(0),
    /** 16 §6.8: rows rendered with a saved harness on at least one side. */
    reusedHarnessCount: integer("reused_harness_count").notNull().default(0),
    /** 16 §6.8: harnesses written by this run (a `replaced` row with two new harnesses counts 2). */
    newHarnessCount: integer("new_harness_count").notNull().default(0),
    /** 16 §6.8: rows with harness_needs_update (updated by repair). */
    needsUpdateCount: integer("needs_update_count").notNull().default(0),
    /** 16 §6.8: first changed file that triggered the whole-library re-check (§8.5). */
    globalStyleTrigger: text("global_style_trigger"),
    /** 16 §6.8 (E18): <dataDir>/snapshots/<id>/ was saved (working_tree runs only). */
    workingTreeSnapshot: boolean("working_tree_snapshot").notNull().default(false),
    startedAt: timestampTz("started_at"),
    completedAt: timestampTz("completed_at"),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("visualizations_repository_id_created_at_idx").on(table.repositoryId, table.createdAt.desc()),
    index("visualizations_active_created_at_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.isDeleted} = false`),
    index("visualizations_non_terminal_status_idx")
      .on(table.status)
      .where(sql`${table.status} not in (${sqlLiteralList(TERMINAL_VISUALIZATION_STATUSES)})`),
    check("visualizations_source_type_check", checkIn(table.sourceType, enumValues(VisualizationSourceType))),
    check("visualizations_status_check", checkIn(table.status, enumValues(VisualizationStatus))),
    check("visualizations_ai_provider_check", checkIn(table.aiProvider, enumValues(AiProviderKind))),
    check(
      "visualizations_pr_number_check",
      sql`(${table.sourceType} = 'github_pr' and ${table.prNumber} is not null and ${table.prNumber} > 0)
          or (${table.sourceType} <> 'github_pr' and ${table.prNumber} is null)`
    ),
    // 00 §16: a commit range is fixed at create time, so both commits are stored on insert.
    check(
      "visualizations_commit_range_shas_check",
      sql`${table.sourceType} <> 'commit_range' or (${table.baseSha} is not null and ${table.headSha} is not null)`
    ),
    check(
      "visualizations_counts_check",
      sql`${table.componentCount} >= 0 and ${table.changedCount} >= 0 and ${table.changedCount} <= ${table.componentCount}`
    ),
    check(
      "visualizations_completed_at_check",
      sql`${table.completedAt} is null or ${table.status} in (${sqlLiteralList(TERMINAL_VISUALIZATION_STATUSES)})`
    ),
    check("visualizations_failed_stage_check", checkInOrNull(table.failedStage, NON_TERMINAL_VISUALIZATION_STATUSES)),
    check(
      "visualizations_render_viewport_check",
      sql`${table.renderViewport} is null or ${table.renderViewport} in ('desktop', 'tablet', 'mobile')`
    ),
    check(
      "visualizations_component_limit_check",
      sql`${table.componentLimit} is null or (${table.componentLimit} >= 1 and ${table.componentLimit} <= 100)`
    ),
    check(
      "visualizations_failed_stage_status_check",
      sql`${table.failedStage} is null or ${table.status} in ('failed', 'cancelled')`
    ),
    check(
      "visualizations_checked_count_check",
      sql`${table.checkedCount} >= 0 and ${table.checkedCount} <= ${table.componentCount}`
    ),
    check(
      "visualizations_working_tree_snapshot_check",
      sql`not ${table.workingTreeSnapshot} or ${table.sourceType} = 'working_tree'`
    )
  ]
);

// ---------------------------------------------------------------------------------------------
// visualization_components — one row per component candidate. Hard-deleted only via cascade.
// ---------------------------------------------------------------------------------------------
export const visualizationComponents = pgTable(
  "visualization_components",
  {
    id: serial("id").primaryKey(),
    visualizationId: integer("visualization_id")
      .notNull()
      .references(() => visualizations.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    exportName: varchar("export_name", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    changeKind: text("change_kind", { enum: enumValues(ComponentChangeKind) }).notNull(),
    renderStatus: text("render_status", { enum: enumValues(ComponentRenderStatus) })
      .notNull()
      .default(ComponentRenderStatus.PENDING),
    visualChange: text("visual_change", { enum: enumValues(ComponentVisualChange) }),
    risk: text("risk", { enum: enumValues(ComponentRisk) }),
    rank: integer("rank").notNull(),
    /** Why the component is a candidate (= ComponentCandidate.reason, 00 §8). Written by 08. */
    changeReason: text("change_reason"),
    /** Why the component was not rendered (over the cap, not renderable). Only set on skipped rows. */
    skipReason: text("skip_reason"),
    harnessSource: text("harness_source"),
    harnessNotes: text("harness_notes"),
    mockedModules: jsonb("mocked_modules")
      .$type<MockedModule[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    baseImagePath: text("base_image_path"),
    headImagePath: text("head_image_path"),
    diffImagePath: text("diff_image_path"),
    imageWidth: integer("image_width"),
    imageHeight: integer("image_height"),
    diffPixelRatio: numeric("diff_pixel_ratio", { precision: 8, scale: 6, mode: "number" }),
    codeDiff: text("code_diff"),
    structuralDiff: jsonb("structural_diff").$type<StructuralChange[]>(),
    aiNote: text("ai_note"),
    baseError: text("base_error"),
    headError: text("head_error"),
    /** 00 §17: the removed base component (R) of a `replaced` row; file_path/export_name/display_name are A's. */
    baseFilePath: text("base_file_path"),
    baseExportName: varchar("base_export_name", { length: 255 }),
    baseDisplayName: varchar("base_display_name", { length: 255 }),
    /** 00 §17: base-side harness of a `replaced` row (R); harness_source/notes/mocked_modules stay the head side. */
    baseHarnessSource: text("base_harness_source"),
    baseHarnessNotes: text("base_harness_notes"),
    baseMockedModules: jsonb("base_mocked_modules").$type<MockedModule[]>(),
    /** 00 §17: why R and A were paired (`replaced` rows only). */
    successorEvidence: jsonb("successor_evidence").$type<SuccessorEvidence[]>(),
    /** 16 §6.7: library entry of the head harness (or the only harness). */
    libraryEntryId: integer("library_entry_id").references(() => harnessLibraryEntries.id, { onDelete: "set null" }),
    /** 16 §6.7: library entry of the base harness (`replaced` rows only). */
    baseLibraryEntryId: integer("base_library_entry_id").references(() => harnessLibraryEntries.id, {
      onDelete: "set null"
    }),
    /** 16 §6.7: where the head harness came from; null = no harness. */
    harnessOrigin: text("harness_origin", { enum: enumValues(ComponentHarnessOrigin) }),
    /** 16 §6.7: where the base harness came from (`replaced` rows only). */
    baseHarnessOrigin: text("base_harness_origin", { enum: enumValues(ComponentHarnessOrigin) }),
    /** 16 §6.7 (E5): a present side of a state failed for a harness-attributable reason. */
    harnessNeedsUpdate: boolean("harness_needs_update").notNull().default(false),
    /** 16 §6.7: reused rows: head fingerprint differs from the entry's; null when not computed. */
    sourceChangedSinceWrite: boolean("source_changed_since_write"),
    /** 16 §6.7: states compared on this row (union by name). */
    stateCount: integer("state_count").notNull().default(0),
    changedStateCount: integer("changed_state_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("visualization_components_visualization_id_rank_idx").on(table.visualizationId, table.rank),
    uniqueIndex("visualization_components_visualization_file_export_key").on(
      table.visualizationId,
      table.filePath,
      table.exportName
    ),
    check("visualization_components_change_kind_check", checkIn(table.changeKind, enumValues(ComponentChangeKind))),
    check(
      "visualization_components_render_status_check",
      checkIn(table.renderStatus, enumValues(ComponentRenderStatus))
    ),
    check(
      "visualization_components_visual_change_check",
      checkInOrNull(table.visualChange, enumValues(ComponentVisualChange))
    ),
    check("visualization_components_risk_check", checkInOrNull(table.risk, enumValues(ComponentRisk))),
    check("visualization_components_rank_check", sql`${table.rank} >= 0`),
    check(
      "visualization_components_image_size_check",
      sql`(${table.imageWidth} is null or ${table.imageWidth} > 0) and (${table.imageHeight} is null or ${table.imageHeight} > 0)`
    ),
    check(
      "visualization_components_diff_pixel_ratio_check",
      sql`${table.diffPixelRatio} is null or (${table.diffPixelRatio} >= 0 and ${table.diffPixelRatio} <= 1)`
    ),
    check(
      "visualization_components_file_path_relative_check",
      sql`${table.filePath} not like '/%' and length(${table.filePath}) > 0`
    ),
    // One direction only: skipped rows may lack a reason (07's pending → skipped sweep, 09's cannot_render
    // writes harness_notes), but a reason on a non-skipped row is a writer bug.
    check(
      "visualization_components_skip_reason_check",
      sql`${table.skipReason} is null or ${table.renderStatus} = 'skipped'`
    ),
    // 00 §17: the base_* columns and successor_evidence belong to `replaced` rows only; R is always named there.
    check(
      "visualization_components_replaced_columns_check",
      sql`(${table.changeKind} = 'replaced' and ${table.baseFilePath} is not null and ${table.baseExportName} is not null
            and ${table.baseDisplayName} is not null)
          or (${table.changeKind} <> 'replaced' and ${table.baseFilePath} is null and ${table.baseExportName} is null
            and ${table.baseDisplayName} is null and ${table.baseHarnessSource} is null and ${table.baseHarnessNotes} is null
            and ${table.baseMockedModules} is null and ${table.successorEvidence} is null)`
    ),
    check(
      "visualization_components_base_file_path_relative_check",
      sql`${table.baseFilePath} is null or (${table.baseFilePath} not like '/%' and length(${table.baseFilePath}) > 0)`
    ),
    check(
      "visualization_components_image_path_relative_check",
      sql`(${table.baseImagePath} is null or ${table.baseImagePath} like 'artifacts/%')
          and (${table.headImagePath} is null or ${table.headImagePath} like 'artifacts/%')
          and (${table.diffImagePath} is null or ${table.diffImagePath} like 'artifacts/%')`
    ),
    check(
      "visualization_components_base_library_entry_id_check",
      sql`${table.changeKind} = 'replaced' or ${table.baseLibraryEntryId} is null`
    ),
    check(
      "visualization_components_harness_origin_check",
      checkInOrNull(table.harnessOrigin, enumValues(ComponentHarnessOrigin))
    ),
    check(
      "visualization_components_base_harness_origin_check",
      sql`(${checkInOrNull(table.baseHarnessOrigin, enumValues(ComponentHarnessOrigin))})
          and (${table.changeKind} = 'replaced' or ${table.baseHarnessOrigin} is null)`
    ),
    check(
      "visualization_components_changed_state_count_check",
      sql`${table.changedStateCount} >= 0 and ${table.changedStateCount} <= ${table.stateCount}`
    )
  ]
);

// ---------------------------------------------------------------------------------------------
// visualization_console_events — append-only progress log. No updated_at, no soft delete.
// ---------------------------------------------------------------------------------------------
export const visualizationConsoleEvents = pgTable(
  "visualization_console_events",
  {
    id: serial("id").primaryKey(),
    visualizationId: integer("visualization_id")
      .notNull()
      .references(() => visualizations.id, { onDelete: "cascade" }),
    level: text("level", { enum: enumValues(ConsoleLevel) }).notNull(),
    /** A VisualizationStatus value (00 §14.4: console event stage values are the pipeline status names). */
    stage: text("stage", { enum: enumValues(VisualizationStatus) }).notNull(),
    message: text("message").notNull(),
    createdAt: createdAt()
  },
  (table) => [
    index("visualization_console_events_visualization_id_id_idx").on(table.visualizationId, table.id),
    check("visualization_console_events_level_check", checkIn(table.level, enumValues(ConsoleLevel))),
    check("visualization_console_events_stage_check", checkIn(table.stage, enumValues(VisualizationStatus)))
  ]
);

// ---------------------------------------------------------------------------------------------
// harness_library_entries — one saved harness per component (16 §6.3). Never deleted automatically (E26).
// ---------------------------------------------------------------------------------------------
export const harnessLibraryEntries = pgTable(
  "harness_library_entries",
  {
    id: serial("id").primaryKey(),
    repositoryId: integer("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    framework: text("framework", { enum: enumValues(RepositoryFramework) }).notNull(),
    /** Repo-relative POSIX path inside the app root (E1). */
    filePath: text("file_path").notNull(),
    exportName: varchar("export_name", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    /** Angular selector, for display and rename matching. */
    selector: varchar("selector", { length: 255 }),
    /** §8.1 fingerprint of the component source when the harness was saved; null when it could not be located. */
    sourceFingerprint: varchar("source_fingerprint", { length: 64 }),
    /** null = writing was attempted and produced no harness. */
    harnessSource: text("harness_source"),
    mockedModules: jsonb("mocked_modules")
      .$type<MockedModule[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    notes: text("notes").notNull().default(""),
    /** HarnessStateSpec[], Default first (E6, E7). */
    states: jsonb("states")
      .$type<HarnessStateSpec[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    stateCount: integer("state_count").notNull().default(0),
    /** Allowance this revision was written with (E24). */
    stateAllowance: integer("state_allowance").notNull(),
    status: text("status", { enum: enumValues(HarnessLibraryStatus) }).notNull(),
    origin: text("origin", { enum: enumValues(HarnessLibraryOrigin) }).notNull(),
    /** +1 on every rewrite (E3, E25). */
    revision: integer("revision").notNull().default(1),
    lastError: text("last_error"),
    /** Plain integer, no FK: runs are soft-deleted and may be removed. */
    lastFailedVisualizationId: integer("last_failed_visualization_id"),
    aiModel: varchar("ai_model", { length: 100 }),
    aiUsage: jsonb("ai_usage").$type<AiUsage>(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4, mode: "number" }),
    writtenAt: timestampTz("written_at"),
    /** Last successful render on the status side (E4, E5). */
    lastRenderedAt: timestampTz("last_rendered_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("harness_library_entries_identity_key").on(table.repositoryId, table.filePath, table.exportName),
    index("harness_library_entries_repository_status_idx").on(table.repositoryId, table.status),
    check("harness_library_entries_framework_check", checkIn(table.framework, enumValues(RepositoryFramework))),
    check("harness_library_entries_status_check", checkIn(table.status, enumValues(HarnessLibraryStatus))),
    check("harness_library_entries_origin_check", checkIn(table.origin, enumValues(HarnessLibraryOrigin))),
    check(
      "harness_library_entries_file_path_relative_check",
      sql`${table.filePath} not like '/%' and length(${table.filePath}) > 0`
    ),
    check("harness_library_entries_selector_check", sql`${table.framework} = 'angular' or ${table.selector} is null`),
    check(
      "harness_library_entries_source_fingerprint_check",
      sql`${table.sourceFingerprint} is null or ${table.sourceFingerprint} ~ '^[0-9a-f]{64}$'`
    ),
    check("harness_library_entries_states_check", sql`jsonb_typeof(${table.states}) = 'array'`),
    check(
      "harness_library_entries_state_count_check",
      sql`(${table.harnessSource} is null and ${table.stateCount} = 0)
          or (${table.harnessSource} is not null and ${table.stateCount} between 1 and 5)`
    ),
    check("harness_library_entries_state_allowance_check", checkStateAllowance(table.stateAllowance)),
    // off_default_branch is allowed with or without a harness (E26); ready always has one.
    check(
      "harness_library_entries_ready_harness_check",
      sql`${table.status} <> 'ready' or ${table.harnessSource} is not null`
    ),
    check("harness_library_entries_revision_check", sql`${table.revision} >= 1`)
  ]
);

// ---------------------------------------------------------------------------------------------
// harness_library_jobs — scan, rescan and repair jobs (16 §6.4). Never soft-deleted.
// ---------------------------------------------------------------------------------------------
export const harnessLibraryJobs = pgTable(
  "harness_library_jobs",
  {
    id: serial("id").primaryKey(),
    repositoryId: integer("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: enumValues(LibraryJobKind) }).notNull(),
    status: text("status", { enum: enumValues(LibraryJobStatus) })
      .notNull()
      .default(LibraryJobStatus.QUEUED),
    /** Repair jobs only: the run whose cards are repaired. */
    visualizationId: integer("visualization_id").references(() => visualizations.id, { onDelete: "cascade" }),
    /** Repair jobs only: the run's visualization_components ids. */
    componentIds: jsonb("component_ids").$type<number[]>(),
    /** Scan: the repository's allowance at start; repair: the allowance used for rewritten harnesses. */
    stateAllowance: integer("state_allowance").notNull(),
    spendCapUsd: numeric("spend_cap_usd", { precision: 10, scale: 2, mode: "number" }),
    /** Commit scanned (scan, rescan). */
    scanSha: varchar("scan_sha", { length: 64 }),
    totalCount: integer("total_count").notNull().default(0),
    writtenCount: integer("written_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    currentLabel: text("current_label"),
    spentUsd: numeric("spent_usd", { precision: 10, scale: 4, mode: "number" }).notNull().default(0),
    aiUsage: jsonb("ai_usage").$type<AiUsage>(),
    /** Model at start. */
    aiModel: varchar("ai_model", { length: 100 }).notNull(),
    /** BullMQ job id. */
    jobId: varchar("job_id", { length: 64 }),
    errorMessage: text("error_message"),
    startedAt: timestampTz("started_at"),
    completedAt: timestampTz("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("harness_library_jobs_repository_created_idx").on(table.repositoryId, table.createdAt.desc()),
    uniqueIndex("harness_library_jobs_active_scan_key")
      .on(table.repositoryId)
      .where(
        sql`${table.kind} in ('scan', 'rescan') and ${table.status} in (${sqlLiteralList(ACTIVE_LIBRARY_JOB_STATUSES)})`
      ),
    uniqueIndex("harness_library_jobs_active_repair_key")
      .on(table.visualizationId)
      .where(sql`${table.kind} = 'repair' and ${table.status} in (${sqlLiteralList(ACTIVE_LIBRARY_JOB_STATUSES)})`),
    check("harness_library_jobs_kind_check", checkIn(table.kind, enumValues(LibraryJobKind))),
    check("harness_library_jobs_status_check", checkIn(table.status, enumValues(LibraryJobStatus))),
    check(
      "harness_library_jobs_visualization_id_check",
      sql`(${table.kind} = 'repair') = (${table.visualizationId} is not null)`
    ),
    check(
      "harness_library_jobs_component_ids_check",
      sql`(${table.kind} = 'repair') = (${table.componentIds} is not null)`
    ),
    check("harness_library_jobs_state_allowance_check", checkStateAllowance(table.stateAllowance)),
    check(
      "harness_library_jobs_spend_cap_usd_check",
      sql`${table.spendCapUsd} is null or (${table.spendCapUsd} > 0 and ${table.kind} <> 'repair')`
    ),
    check(
      "harness_library_jobs_counts_check",
      sql`${table.totalCount} >= 0 and ${table.writtenCount} >= 0 and ${table.failedCount} >= 0
          and ${table.skippedCount} >= 0
          and ${table.writtenCount} + ${table.failedCount} + ${table.skippedCount} <= ${table.totalCount}`
    ),
    check(
      "harness_library_jobs_completed_at_check",
      sql`${table.completedAt} is null or ${table.status} in (${sqlLiteralList(TERMINAL_LIBRARY_JOB_STATUSES)})`
    )
  ]
);

// ---------------------------------------------------------------------------------------------
// harness_library_job_events — append-only console of a library job (16 §6.5). No updated_at.
// ---------------------------------------------------------------------------------------------
export const harnessLibraryJobEvents = pgTable(
  "harness_library_job_events",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => harnessLibraryJobs.id, { onDelete: "cascade" }),
    level: text("level", { enum: enumValues(ConsoleLevel) }).notNull(),
    message: text("message").notNull(),
    createdAt: createdAt()
  },
  (table) => [
    index("harness_library_job_events_job_id_id_idx").on(table.jobId, table.id),
    check("harness_library_job_events_level_check", checkIn(table.level, enumValues(ConsoleLevel)))
  ]
);

// ---------------------------------------------------------------------------------------------
// visualization_component_states — one row per (run component, state), Default included (16 §6.6, E9).
// Hard-deleted only by cascade.
// ---------------------------------------------------------------------------------------------
export const visualizationComponentStates = pgTable(
  "visualization_component_states",
  {
    id: serial("id").primaryKey(),
    visualizationComponentId: integer("visualization_component_id")
      .notNull()
      .references(() => visualizationComponents.id, { onDelete: "cascade" }),
    /** Denormalized for per-run queries. */
    visualizationId: integer("visualization_id")
      .notNull()
      .references(() => visualizations.id, { onDelete: "cascade" }),
    /** 0 = Default. */
    ordinal: integer("ordinal").notNull(),
    stateName: varchar("state_name", { length: 40 }).notNull(),
    /** The state exists in that side's harness. */
    onBase: boolean("on_base").notNull(),
    onHead: boolean("on_head").notNull(),
    /** HarnessStep[] of the head harness (base's when the state is only on base). */
    steps: jsonb("steps")
      .$type<HarnessStep[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    renderStatus: text("render_status", { enum: enumValues(ComponentRenderStatus) })
      .notNull()
      .default(ComponentRenderStatus.PENDING),
    visualChange: text("visual_change", { enum: enumValues(ComponentVisualChange) }),
    baseImagePath: text("base_image_path"),
    headImagePath: text("head_image_path"),
    diffImagePath: text("diff_image_path"),
    imageWidth: integer("image_width"),
    imageHeight: integer("image_height"),
    diffPixelRatio: numeric("diff_pixel_ratio", { precision: 8, scale: 6, mode: "number" }),
    baseError: text("base_error"),
    headError: text("head_error"),
    /** 10's RenderFailureKind of the side; used by repair to build HarnessRenderError without parsing messages. */
    baseFailureKind: text("base_failure_kind", { enum: RENDER_FAILURE_KIND_VALUES }),
    headFailureKind: text("head_failure_kind", { enum: RENDER_FAILURE_KIND_VALUES }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("visualization_component_states_component_ordinal_key").on(
      table.visualizationComponentId,
      table.ordinal
    ),
    uniqueIndex("visualization_component_states_component_name_key").on(
      table.visualizationComponentId,
      table.stateName
    ),
    index("visualization_component_states_visualization_idx").on(table.visualizationId),
    check("visualization_component_states_ordinal_check", sql`${table.ordinal} between 0 and 9`),
    check(
      "visualization_component_states_default_ordinal_check",
      sql`${table.ordinal} <> 0 or ${table.stateName} = 'Default'`
    ),
    check("visualization_component_states_sides_check", sql`${table.onBase} or ${table.onHead}`),
    check(
      "visualization_component_states_render_status_check",
      checkIn(table.renderStatus, enumValues(ComponentRenderStatus))
    ),
    check(
      "visualization_component_states_visual_change_check",
      checkInOrNull(table.visualChange, enumValues(ComponentVisualChange))
    ),
    check(
      "visualization_component_states_image_path_relative_check",
      sql`(${table.baseImagePath} is null or ${table.baseImagePath} like 'artifacts/%')
          and (${table.headImagePath} is null or ${table.headImagePath} like 'artifacts/%')
          and (${table.diffImagePath} is null or ${table.diffImagePath} like 'artifacts/%')`
    ),
    check(
      "visualization_component_states_image_size_check",
      sql`(${table.imageWidth} is null or ${table.imageWidth} > 0) and (${table.imageHeight} is null or ${table.imageHeight} > 0)`
    ),
    check(
      "visualization_component_states_diff_pixel_ratio_check",
      sql`${table.diffPixelRatio} is null or (${table.diffPixelRatio} >= 0 and ${table.diffPixelRatio} <= 1)`
    ),
    check(
      "visualization_component_states_base_failure_kind_check",
      checkInOrNull(table.baseFailureKind, RENDER_FAILURE_KIND_VALUES)
    ),
    check(
      "visualization_component_states_head_failure_kind_check",
      checkInOrNull(table.headFailureKind, RENDER_FAILURE_KIND_VALUES)
    )
  ]
);

// ---------------------------------------------------------------------------------------------
// live_sessions — one live mode session of a run (16 §6.9, §12).
// ---------------------------------------------------------------------------------------------
export const liveSessions = pgTable(
  "live_sessions",
  {
    id: serial("id").primaryKey(),
    visualizationId: integer("visualization_id")
      .notNull()
      .references(() => visualizations.id, { onDelete: "cascade" }),
    status: text("status", { enum: enumValues(LiveSessionStatus) })
      .notNull()
      .default(LiveSessionStatus.STARTING),
    jobId: varchar("job_id", { length: 64 }),
    /** LiveHostState[], written only by the live worker. */
    hosts: jsonb("hosts")
      .$type<LiveHostState[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** LiveOpenRequestRecord[], appended by the API, drained by the worker. */
    openRequests: jsonb("open_requests")
      .$type<LiveOpenRequestRecord[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** +1 on every write of open_requests (optimistic; never compare updated_at, 16 §12.3). */
    openRequestsVersion: integer("open_requests_version").notNull().default(0),
    errorMessage: text("error_message"),
    stopReason: text("stop_reason", { enum: enumValues(LiveStopReason) }),
    lastHeartbeatAt: timestampTz("last_heartbeat_at").notNull().defaultNow(),
    lastActivityAt: timestampTz("last_activity_at").notNull().defaultNow(),
    readyAt: timestampTz("ready_at"),
    stoppedAt: timestampTz("stopped_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex("live_sessions_active_visualization_key")
      .on(table.visualizationId)
      .where(sql`${table.status} in (${sqlLiteralList(ACTIVE_LIVE_SESSION_STATUSES)})`),
    index("live_sessions_active_idx")
      .on(table.status)
      .where(sql`${table.status} in (${sqlLiteralList(ACTIVE_LIVE_SESSION_STATUSES)})`),
    check("live_sessions_status_check", checkIn(table.status, enumValues(LiveSessionStatus))),
    check("live_sessions_stop_reason_check", checkInOrNull(table.stopReason, enumValues(LiveStopReason))),
    check(
      "live_sessions_stop_reason_status_check",
      sql`${table.stopReason} is null or ${table.status} in ('stopping', 'stopped', 'failed')`
    ),
    check("live_sessions_open_requests_version_check", sql`${table.openRequestsVersion} >= 0`)
  ]
);

// ---------------------------------------------------------------------------------------------
// Relations (for db.query.* relational reads in services that justify direct Drizzle)
// ---------------------------------------------------------------------------------------------
export const repositoriesRelations = relations(repositories, ({ many }) => ({
  visualizations: many(visualizations),
  harnessLibraryEntries: many(harnessLibraryEntries),
  harnessLibraryJobs: many(harnessLibraryJobs)
}));

export const visualizationsRelations = relations(visualizations, ({ one, many }) => ({
  repository: one(repositories, { fields: [visualizations.repositoryId], references: [repositories.id] }),
  components: many(visualizationComponents),
  consoleEvents: many(visualizationConsoleEvents),
  liveSessions: many(liveSessions)
}));

export const visualizationComponentsRelations = relations(visualizationComponents, ({ one, many }) => ({
  visualization: one(visualizations, {
    fields: [visualizationComponents.visualizationId],
    references: [visualizations.id]
  }),
  visualizationComponentStates: many(visualizationComponentStates)
}));

export const visualizationConsoleEventsRelations = relations(visualizationConsoleEvents, ({ one }) => ({
  visualization: one(visualizations, {
    fields: [visualizationConsoleEvents.visualizationId],
    references: [visualizations.id]
  })
}));

export const harnessLibraryEntriesRelations = relations(harnessLibraryEntries, ({ one }) => ({
  repository: one(repositories, { fields: [harnessLibraryEntries.repositoryId], references: [repositories.id] })
}));

export const harnessLibraryJobsRelations = relations(harnessLibraryJobs, ({ one, many }) => ({
  repository: one(repositories, { fields: [harnessLibraryJobs.repositoryId], references: [repositories.id] }),
  events: many(harnessLibraryJobEvents)
}));

export const harnessLibraryJobEventsRelations = relations(harnessLibraryJobEvents, ({ one }) => ({
  job: one(harnessLibraryJobs, { fields: [harnessLibraryJobEvents.jobId], references: [harnessLibraryJobs.id] })
}));

export const visualizationComponentStatesRelations = relations(visualizationComponentStates, ({ one }) => ({
  component: one(visualizationComponents, {
    fields: [visualizationComponentStates.visualizationComponentId],
    references: [visualizationComponents.id]
  })
}));

export const liveSessionsRelations = relations(liveSessions, ({ one }) => ({
  visualization: one(visualizations, { fields: [liveSessions.visualizationId], references: [visualizations.id] })
}));

// ---------------------------------------------------------------------------------------------
// Inferred row types (for direct-Drizzle code paths; services normally use generated models)
// ---------------------------------------------------------------------------------------------
export type AppSettingsRow = typeof appSettings.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;
export type VisualizationRow = typeof visualizations.$inferSelect;
export type NewVisualizationRow = typeof visualizations.$inferInsert;
export type VisualizationComponentRow = typeof visualizationComponents.$inferSelect;
export type NewVisualizationComponentRow = typeof visualizationComponents.$inferInsert;
export type VisualizationConsoleEventRow = typeof visualizationConsoleEvents.$inferSelect;
export type NewVisualizationConsoleEventRow = typeof visualizationConsoleEvents.$inferInsert;
export type HarnessLibraryEntryRow = typeof harnessLibraryEntries.$inferSelect;
export type NewHarnessLibraryEntryRow = typeof harnessLibraryEntries.$inferInsert;
export type HarnessLibraryJobRow = typeof harnessLibraryJobs.$inferSelect;
export type NewHarnessLibraryJobRow = typeof harnessLibraryJobs.$inferInsert;
export type HarnessLibraryJobEventRow = typeof harnessLibraryJobEvents.$inferSelect;
export type NewHarnessLibraryJobEventRow = typeof harnessLibraryJobEvents.$inferInsert;
export type VisualizationComponentStateRow = typeof visualizationComponentStates.$inferSelect;
export type NewVisualizationComponentStateRow = typeof visualizationComponentStates.$inferInsert;
export type LiveSessionRow = typeof liveSessions.$inferSelect;
export type NewLiveSessionRow = typeof liveSessions.$inferInsert;
