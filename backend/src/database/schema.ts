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
  AiEffort,
  AiProviderKind,
  ComponentChangeKind,
  ComponentRenderStatus,
  ComponentRisk,
  ComponentVisualChange,
  ConsoleLevel,
  NON_TERMINAL_VISUALIZATION_STATUSES,
  PackageManager,
  RepositoryFramework,
  TERMINAL_VISUALIZATION_STATUSES,
  VisualizationSourceType,
  VisualizationStatus,
  enumValues
} from "../enums";
import type { AiUsage, MockedModule, StructuralChange, SuccessorEvidence } from "../types/visualization-pipeline";

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
    check("repositories_render_viewport_check", sql`${table.renderViewport} in ('desktop', 'tablet', 'mobile')`)
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
// Relations (for db.query.* relational reads in services that justify direct Drizzle)
// ---------------------------------------------------------------------------------------------
export const repositoriesRelations = relations(repositories, ({ many }) => ({
  visualizations: many(visualizations)
}));

export const visualizationsRelations = relations(visualizations, ({ one, many }) => ({
  repository: one(repositories, { fields: [visualizations.repositoryId], references: [repositories.id] }),
  components: many(visualizationComponents),
  consoleEvents: many(visualizationConsoleEvents)
}));

export const visualizationComponentsRelations = relations(visualizationComponents, ({ one }) => ({
  visualization: one(visualizations, {
    fields: [visualizationComponents.visualizationId],
    references: [visualizations.id]
  })
}));

export const visualizationConsoleEventsRelations = relations(visualizationConsoleEvents, ({ one }) => ({
  visualization: one(visualizations, {
    fields: [visualizationConsoleEvents.visualizationId],
    references: [visualizations.id]
  })
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
