# 03 — Database Schema, Migrations and Models

Owner: build agent (wave 2)
Depends on: 00 (contracts), 01 (engineering standards), 02 (scaffold: `backend/package.json`, `tsconfig.json`, ESLint/Prettier, `config-consts` values, Docker Compose Postgres on `127.0.0.1:5433`)
Consumed by: 04 (`QueryHandler`, `DbPool`, `DrizzleDb`), 05, 06, 07, 08, 09, 10, 11, 14

## 1. Purpose

Define PRVision's complete persistence layer: the single Drizzle `schema.ts` (five tables from 00 §6), the
enum modules it is generated from, the Postgres connection factory, `drizzle.config.ts`, the migration
workflow and scripts, the model generator and the exact generated model classes, the `Table` → Drizzle table
registry used by `QueryHandler`, and the conventions every feature sheet follows when it turns a row into a
view (dates, numerics, JSON, artifact paths, soft delete).

After this sheet is done, a fresh `docker compose up -d postgres && npm run db:migrate` produces the full
schema with the singleton `app_settings` row, and `npm run generate:models` produces typed, lint-clean model
classes that the rest of the backend imports from `backend/src/models`.

## 2. Scope / Out of scope

In scope:

- `backend/src/database/schema.ts` written out in full (below), including CHECK constraints derived from the
  enum objects, FKs with explicit `onDelete`, all indexes, `relations()` and inferred row types.
- `backend/src/enums/**` — the domain enums from 00 §5, the `Table` and `DeletionMode` utility enums, barrel.
- `backend/src/database/connection.ts` (pg `Pool` factory), `backend/src/database/table-registry.ts`
  (`Table` → table object map), `backend/src/database/schema-readiness.ts` (boot-time check).
- `backend/drizzle.config.ts`, the two initial migrations (generated + custom seed), `backend/scripts/drizzle-migrate.ts`,
  `backend/scripts/generate-models.ts`, `backend/scripts/check-db-connection.ts`.
- The generated `backend/src/models/*` (committed).
- Row-to-view mapping conventions, soft-delete semantics, retention policy, seed data.

Out of scope:

- `QueryHandler`, `QueryHandlerDrizzle`, `ModelHandler`, `DbPool`, `DrizzleDb` implementations (sheet 04;
  this sheet specifies the registry they consume and the behaviour they must have for these tables).
- DTOs and view mapper functions per feature (sheets 05–07; this sheet sets the conventions).
- `docker-compose.yml`, `.env.example`, `package.json` script wiring (sheet 02; §9.6 lists the exact script
  lines this sheet needs so 02 and 03 agree).
- Data retention jobs or artifact garbage collection (none in the prototype, see §9.9).

## 3. Dependencies

| Dependency | What is used |
|---|---|
| 00 §5 | Enum objects and values, `Table` names |
| 00 §6 | Table and column names |
| 00 §8, §14.4 | `AiUsage`, `MockedModule`, `StructuralChange` types for jsonb `$type<>()` (file `backend/src/types/visualization-pipeline.ts`, created by 02 §6.10.2; this sheet only imports types from it) |
| 00 §4, §14.1 | `DATABASE_URL` env var, Postgres on host port 5433 by default (overridable with `PRVISION_PG_PORT`, compose-only) |
| 00 §14.3 | Snake_case `Table` values, `table-registry.ts`, new columns `change_reason`, `skip_reason`, `failed_stage`, adopted constraints, seed migration, `schema-readiness.ts`, relative image paths |
| 02 | `backend/src/config-consts/app.config.ts` exports `DATABASE_URL: string` (`""` when unset — never throws at import) and `DB_POOL_MAX: number` (10) — 02 §6.7. `utilities/helpers/env.ts` loads `.env`. 02 already created the enum files of §5 (identical bodies), `drizzle.config.ts`, `scripts/drizzle-migrate.ts`, `scripts/check-db-connection.ts` and `scripts/generate-models.ts`; this sheet takes them over and changes them as described below. |
| 04 | `QueryHandlerDrizzle` consumes `TABLE_SCHEMAS`; `ArtifactStore.toPublicUrl`, `toIsoString` used by the view conventions in §9.5. Scripts in this sheet print with `console` (allowed in `backend/scripts/**`, 01 §5.3.1), so they do not depend on 04's logger. |

Library versions (match Uply-v2, already verified with these exact APIs): `drizzle-orm ^0.45.2`,
`drizzle-kit ^0.31.5`, `pg ^8.16.3`, `@types/pg`. The array form of the `pgTable` third argument is required
(the object form is deprecated in 0.45).

## 4. File inventory

| File | Responsibility |
|---|---|
| `backend/src/enums/domain/ai-provider-kind.ts` | `AiProviderKind` const + type |
| `backend/src/enums/domain/ai-effort.ts` | `AiEffort` const + type |
| `backend/src/enums/domain/repository-framework.ts` | `RepositoryFramework` const + type |
| `backend/src/enums/domain/package-manager.ts` | `PackageManager` const + type |
| `backend/src/enums/domain/visualization-source-type.ts` | `VisualizationSourceType` const + type |
| `backend/src/enums/domain/visualization-status.ts` | `VisualizationStatus` (+ alias type `VisualizationStatusValue`), `VISUALIZATION_STATUS_VALUES`, `TERMINAL_VISUALIZATION_STATUSES`, `ACTIVE_VISUALIZATION_STATUSES`, `NON_TERMINAL_VISUALIZATION_STATUSES`, `isTerminalVisualizationStatus()` |
| `backend/src/enums/domain/component-change-kind.ts` | `ComponentChangeKind` |
| `backend/src/enums/domain/component-render-status.ts` | `ComponentRenderStatus` |
| `backend/src/enums/domain/component-visual-change.ts` | `ComponentVisualChange` |
| `backend/src/enums/domain/component-risk.ts` | `ComponentRisk` |
| `backend/src/enums/domain/console-level.ts` | `ConsoleLevel` |
| `backend/src/enums/utility/table.ts` | `Table` const + type (values = SQL table names) |
| `backend/src/enums/utility/deletion-mode.ts` | `DeletionMode` (`soft` / `hard`) |
| `backend/src/enums/utility/value-of.ts` | `ValueOf<T>` helper type and `enumValues()` runtime helper |
| `backend/src/enums/index.ts` | Barrel re-exporting all of the above (04 adds `utility/error-reason.ts`) |
| `backend/src/database/schema.ts` | The only Drizzle schema file: 5 tables, constraints, indexes, relations, row types |
| `backend/src/database/connection.ts` | `getPgPool()` / `closePgPool()` singleton `pg.Pool` |
| `backend/src/database/table-registry.ts` | `TABLE_SCHEMAS` (`Table` → `PgTable`), `getTableSchema()`, `tableHasColumn()` |
| `backend/src/database/schema-readiness.ts` | `assertDatabaseReady(pool)` — boot check that migrations ran and the singleton row exists |
| `backend/src/database/migrations/0000_initial_schema.sql` | Generated by drizzle-kit (never hand-edited) |
| `backend/src/database/migrations/0001_seed_app_settings.sql` | Custom migration: inserts `app_settings` row `id = 1` |
| `backend/src/database/migrations/meta/_journal.json`, `0000_snapshot.json`, `0001_snapshot.json` | Generated by drizzle-kit |
| `backend/drizzle.config.ts` | drizzle-kit config (created by 02 with the §8.1 body; owned here) |
| `backend/scripts/drizzle-migrate.ts` | Applies migrations with the runtime connection settings (02 creates; replaced by §8.3) |
| `backend/scripts/generate-models.ts` | Generates `src/models/*` from `schema.ts` (02 copies Uply's; changed per §9.1) |
| `backend/scripts/check-db-connection.ts` | Prints DB/user/schema and migration count; exits non-zero on failure (02 creates; extended per §8.4) |
| `backend/src/models/app-setting-model.ts` | Generated `AppSettingModel` |
| `backend/src/models/repository-model.ts` | Generated `RepositoryModel` |
| `backend/src/models/visualization-model.ts` | Generated `VisualizationModel` |
| `backend/src/models/visualization-component-model.ts` | Generated `VisualizationComponentModel` |
| `backend/src/models/visualization-console-event-model.ts` | Generated `VisualizationConsoleEventModel` |
| `backend/src/models/index.ts` | Generated barrel |
| `tests/backend/database/schema.test.ts` | Structural assertions on the schema (no DB) |
| `tests/backend/database/table-registry.test.ts` | Registry completeness |
| `tests/backend/database/model-generator.test.ts` | Generator output assertions |
| `tests/backend/database/enums.test.ts` | Enum values match 00 §5 exactly |
| `tests/backend/database/migrations.integration.test.ts` | Real-Postgres tests, skipped unless `PRVISION_TEST_DATABASE_URL` is set |

Ownership note (00 §14.3): this sheet owns `backend/src/enums/**` except `utility/error-reason.ts` (04).
Sheet 02 creates every file of §5 during the scaffold with **exactly** the bodies below (02 §6.10.1 repeats
them); if a 02 body differs from this section, this section wins and the file is corrected here.

## 5. Enums

All enums are `as const` objects plus a same-named union type plus a non-empty `<NAME>_VALUES` tuple — no
TypeScript `enum` keyword. This applies to `Table` and `DeletionMode` too (00 §14.3). The `_VALUES` tuples feed
drizzle's `text(..., { enum })`, the CHECK constraints and class-validator `@IsIn(...)` in DTOs.

`backend/src/enums/utility/value-of.ts`:

```ts
/** Union of the values of a const object. */
export type ValueOf<T> = T[keyof T];

/**
 * Returns the values of a string const-enum as a non-empty tuple. Drizzle's text `enum` option needs a
 * non-empty tuple type, and an empty enum is always a programming error.
 */
export function enumValues<T extends Record<string, string>>(enumObject: T): [ValueOf<T>, ...ValueOf<T>[]] {
  const values = Object.values(enumObject) as ValueOf<T>[];
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error("enumValues() called with an empty enum object");
  }
  return [first, ...rest];
}
```

Pattern for each domain file (example `ai-effort.ts`):

```ts
import { enumValues, type ValueOf } from "../utility/value-of";

export const AiEffort = { LOW: "low", MEDIUM: "medium", HIGH: "high", XHIGH: "xhigh", MAX: "max" } as const;
export type AiEffort = ValueOf<typeof AiEffort>;
export const AI_EFFORT_VALUES = enumValues(AiEffort);
```

`backend/src/enums/domain/visualization-status.ts` (adds the status groups used by 03, 04 and 07):

```ts
import { enumValues, type ValueOf } from "../utility/value-of";

export const VisualizationStatus = {
  QUEUED: "queued",
  PREPARING: "preparing",
  ANALYZING: "analyzing",
  GENERATING_HARNESSES: "generating_harnesses",
  RENDERING: "rendering",
  DIFFING: "diffing",
  SUMMARIZING: "summarizing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type VisualizationStatus = ValueOf<typeof VisualizationStatus>;
/** Name used by 00 §14.7 for the same union. */
export type VisualizationStatusValue = VisualizationStatus;
export const VISUALIZATION_STATUS_VALUES = enumValues(VisualizationStatus);

/** Statuses after which a visualization never changes again (00 §5). */
export const TERMINAL_VISUALIZATION_STATUSES = ["completed", "failed", "cancelled"] as const satisfies readonly VisualizationStatus[];
export type TerminalVisualizationStatus = (typeof TERMINAL_VISUALIZATION_STATUSES)[number];

/** Statuses in which a worker is (or should be) processing the visualization. */
export const ACTIVE_VISUALIZATION_STATUSES = [
  "preparing", "analyzing", "generating_harnesses", "rendering", "diffing", "summarizing",
] as const satisfies readonly VisualizationStatus[];
export type ActiveVisualizationStatus = (typeof ACTIVE_VISUALIZATION_STATUSES)[number];

/** queued + active. Allowed values of visualizations.failed_stage and of PipelineStepError.stage (00 §14.3/§14.7). */
export const NON_TERMINAL_VISUALIZATION_STATUSES = ["queued", ...ACTIVE_VISUALIZATION_STATUSES] as const;
export type NonTerminalVisualizationStatus = (typeof NON_TERMINAL_VISUALIZATION_STATUSES)[number];

/** True when the status is terminal. */
export function isTerminalVisualizationStatus(status: VisualizationStatus): status is TerminalVisualizationStatus {
  return (TERMINAL_VISUALIZATION_STATUSES as readonly VisualizationStatus[]).includes(status);
}
```

The other domain files follow the `ai-effort.ts` shape with exactly the values of 00 §5:

| File | Const / type | Values tuple | Values |
|---|---|---|---|
| `ai-provider-kind.ts` | `AiProviderKind` | `AI_PROVIDER_KIND_VALUES` | `anthropic_api`, `claude_code` |
| `ai-effort.ts` | `AiEffort` | `AI_EFFORT_VALUES` | `low`, `medium`, `high`, `xhigh`, `max` |
| `repository-framework.ts` | `RepositoryFramework` | `REPOSITORY_FRAMEWORK_VALUES` | `react_vite` |
| `package-manager.ts` | `PackageManager` | `PACKAGE_MANAGER_VALUES` | `npm`, `pnpm`, `yarn` |
| `visualization-source-type.ts` | `VisualizationSourceType` | `VISUALIZATION_SOURCE_TYPE_VALUES` | `github_pr`, `local_branch`, `working_tree` |
| `visualization-status.ts` | `VisualizationStatus` | `VISUALIZATION_STATUS_VALUES` | 00 §5 order (above) |
| `component-change-kind.ts` | `ComponentChangeKind` | `COMPONENT_CHANGE_KIND_VALUES` | `modified`, `added`, `removed`, `affected_parent` |
| `component-render-status.ts` | `ComponentRenderStatus` | `COMPONENT_RENDER_STATUS_VALUES` | `pending`, `rendered`, `partial`, `failed`, `skipped` |
| `component-visual-change.ts` | `ComponentVisualChange` | `COMPONENT_VISUAL_CHANGE_VALUES` | `changed`, `unchanged`, `new`, `deleted` |
| `component-risk.ts` | `ComponentRisk` | `COMPONENT_RISK_VALUES` | `none`, `check`, `likely_regression` |
| `console-level.ts` | `ConsoleLevel` | `CONSOLE_LEVEL_VALUES` | `info`, `warn`, `error` |

`backend/src/enums/utility/table.ts`:

```ts
import { enumValues, type ValueOf } from "./value-of";

/**
 * Logical table identifiers. Values are the SQL table names (00 §5, §14.3). QueryHandlerDrizzle resolves them
 * through database/table-registry.ts, never by schema export name.
 */
export const Table = {
  APP_SETTINGS: "app_settings",
  REPOSITORIES: "repositories",
  VISUALIZATIONS: "visualizations",
  VISUALIZATION_COMPONENTS: "visualization_components",
  VISUALIZATION_CONSOLE_EVENTS: "visualization_console_events",
} as const;
export type Table = ValueOf<typeof Table>;
export const TABLE_VALUES = enumValues(Table);
```

`backend/src/enums/utility/deletion-mode.ts`:

```ts
import type { ValueOf } from "./value-of";
export const DeletionMode = { SOFT: "soft", HARD: "hard" } as const;
export type DeletionMode = ValueOf<typeof DeletionMode>;
```

`backend/src/enums/index.ts` re-exports every file above with `export * from "./domain/<file>";` /
`export * from "./utility/<file>";` (explicit list, alphabetical, no nested barrels). 04 appends
`export * from "./utility/error-reason";`.

## 6. Detailed design — `schema.ts` (complete)

Conventions (all verified against drizzle-kit 0.31.10 output — see §6.3):

- `id serial primary key`; FK columns are `integer`.
- Timestamps: `timestamp(name, { withTimezone: true, precision: 3, mode: "date" })` → `timestamptz(3)`, read as `Date`.
- `updatedAt` has `.defaultNow().$onUpdate(() => new Date())`; `QueryHandler.update` also stamps it (04).
- Enum-backed columns are `text(name, { enum: enumValues(X) })` (plain `text` in SQL, narrowed union in TS,
  and `column.enumValues` available at runtime for the model generator) **plus** a named CHECK constraint
  generated from the same values by `checkIn()`.
- CHECK and index names are explicit: `<table>_<column(s)>_check`, `<table>_<columns>_idx`, `<table>_<columns>_key` (unique).
- CHECK SQL is built with `sql.raw` for the literal list. Never interpolate values as bound params inside
  `check()` — drizzle-kit would emit `$1` placeholders. `sql.raw` is allowed only in `schema.ts` (01 §5.3.1
  lint exception) and only through `sqlLiteralList()`, which accepts nothing but `^[a-z0-9_]+$` literals.
- jsonb columns carry `$type<>()`; array-valued jsonb columns that are logically never absent are
  `.notNull().default(sql\`'[]'::jsonb\`)`.

### 6.1 Full file

```ts
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
  varchar,
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
  enumValues,
} from "../enums";
import type { AiUsage, MockedModule, StructuralChange } from "../types/visualization-pipeline";

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
    updatedAt: updatedAt(),
  },
  (table) => [
    check("app_settings_singleton_check", sql`${table.id} = 1`),
    check("app_settings_ai_provider_check", checkIn(table.aiProvider, enumValues(AiProviderKind))),
    check("app_settings_ai_harness_effort_check", checkIn(table.aiHarnessEffort, enumValues(AiEffort))),
    check("app_settings_ai_summary_effort_check", checkIn(table.aiSummaryEffort, enumValues(AiEffort))),
    check("app_settings_ai_model_check", sql`length(trim(${table.aiModel})) > 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// repositories — soft-deletable. local_path unique among non-deleted rows.
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
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("repositories_local_path_active_key")
      .on(table.localPath)
      .where(sql`${table.isDeleted} = false`),
    index("repositories_active_created_at_idx")
      .on(table.createdAt.desc())
      .where(sql`${table.isDeleted} = false`),
    check("repositories_framework_check", checkIn(table.framework, enumValues(RepositoryFramework))),
    check("repositories_package_manager_check", checkIn(table.packageManager, enumValues(PackageManager))),
    check("repositories_local_path_absolute_check", sql`${table.localPath} like '/%'`),
    check("repositories_name_check", sql`length(trim(${table.name})) > 0`),
    check(
      "repositories_github_pair_check",
      sql`(${table.githubOwner} is null) = (${table.githubRepo} is null)`,
    ),
    check(
      "repositories_global_style_paths_check",
      sql`jsonb_typeof(${table.globalStylePaths}) = 'array'`,
    ),
  ],
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
    startedAt: timestampTz("started_at"),
    completedAt: timestampTz("completed_at"),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
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
          or (${table.sourceType} <> 'github_pr' and ${table.prNumber} is null)`,
    ),
    check(
      "visualizations_counts_check",
      sql`${table.componentCount} >= 0 and ${table.changedCount} >= 0 and ${table.changedCount} <= ${table.componentCount}`,
    ),
    check(
      "visualizations_completed_at_check",
      sql`${table.completedAt} is null or ${table.status} in (${sqlLiteralList(TERMINAL_VISUALIZATION_STATUSES)})`,
    ),
    check(
      "visualizations_failed_stage_check",
      checkInOrNull(table.failedStage, NON_TERMINAL_VISUALIZATION_STATUSES),
    ),
    check(
      "visualizations_failed_stage_status_check",
      sql`${table.failedStage} is null or ${table.status} in ('failed', 'cancelled')`,
    ),
  ],
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("visualization_components_visualization_id_rank_idx").on(table.visualizationId, table.rank),
    uniqueIndex("visualization_components_visualization_file_export_key").on(
      table.visualizationId,
      table.filePath,
      table.exportName,
    ),
    check("visualization_components_change_kind_check", checkIn(table.changeKind, enumValues(ComponentChangeKind))),
    check(
      "visualization_components_render_status_check",
      checkIn(table.renderStatus, enumValues(ComponentRenderStatus)),
    ),
    check(
      "visualization_components_visual_change_check",
      checkInOrNull(table.visualChange, enumValues(ComponentVisualChange)),
    ),
    check("visualization_components_risk_check", checkInOrNull(table.risk, enumValues(ComponentRisk))),
    check("visualization_components_rank_check", sql`${table.rank} >= 0`),
    check(
      "visualization_components_image_size_check",
      sql`(${table.imageWidth} is null or ${table.imageWidth} > 0) and (${table.imageHeight} is null or ${table.imageHeight} > 0)`,
    ),
    check(
      "visualization_components_diff_pixel_ratio_check",
      sql`${table.diffPixelRatio} is null or (${table.diffPixelRatio} >= 0 and ${table.diffPixelRatio} <= 1)`,
    ),
    check(
      "visualization_components_file_path_relative_check",
      sql`${table.filePath} not like '/%' and length(${table.filePath}) > 0`,
    ),
    // One direction only: skipped rows may lack a reason (07's pending → skipped sweep, 09's cannot_render
    // writes harness_notes), but a reason on a non-skipped row is a writer bug.
    check(
      "visualization_components_skip_reason_check",
      sql`${table.skipReason} is null or ${table.renderStatus} = 'skipped'`,
    ),
    check(
      "visualization_components_image_path_relative_check",
      sql`(${table.baseImagePath} is null or ${table.baseImagePath} like 'artifacts/%')
          and (${table.headImagePath} is null or ${table.headImagePath} like 'artifacts/%')
          and (${table.diffImagePath} is null or ${table.diffImagePath} like 'artifacts/%')`,
    ),
  ],
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
    createdAt: createdAt(),
  },
  (table) => [
    index("visualization_console_events_visualization_id_id_idx").on(table.visualizationId, table.id),
    check("visualization_console_events_level_check", checkIn(table.level, enumValues(ConsoleLevel))),
    check("visualization_console_events_stage_check", checkIn(table.stage, enumValues(VisualizationStatus))),
  ],
);

// ---------------------------------------------------------------------------------------------
// Relations (for db.query.* relational reads in services that justify direct Drizzle)
// ---------------------------------------------------------------------------------------------
export const repositoriesRelations = relations(repositories, ({ many }) => ({
  visualizations: many(visualizations),
}));

export const visualizationsRelations = relations(visualizations, ({ one, many }) => ({
  repository: one(repositories, { fields: [visualizations.repositoryId], references: [repositories.id] }),
  components: many(visualizationComponents),
  consoleEvents: many(visualizationConsoleEvents),
}));

export const visualizationComponentsRelations = relations(visualizationComponents, ({ one }) => ({
  visualization: one(visualizations, {
    fields: [visualizationComponents.visualizationId],
    references: [visualizations.id],
  }),
}));

export const visualizationConsoleEventsRelations = relations(visualizationConsoleEvents, ({ one }) => ({
  visualization: one(visualizations, {
    fields: [visualizationConsoleEvents.visualizationId],
    references: [visualizations.id],
  }),
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
```

Import rule: `schema.ts` may import only from `../enums` and type-only from `../types/visualization-pipeline`.
It must never import `config-consts`, `utilities` or anything that reads env, because drizzle-kit loads it
in a bare process.

### 6.2 Column decisions not fixed by 00

| Column | Decision | Why |
|---|---|---|
| `app_settings.id` | `serial` + `CHECK (id = 1)` + seed row | 00 fixes `serial`; the CHECK makes a second row impossible. A stray insert without `id` gets `nextval = 1` and fails on the PK — also safe. |
| `app_settings.ai_*` defaults | provider `anthropic_api`, model `claude-opus-5-5`, harness effort `high`, summary effort `medium` | Fresh install shows a usable form; `hasAnthropicApiKey=false` makes 05 return `ai_not_configured`. |
| `repositories.github_owner/repo` | nullable, both-or-neither CHECK | `no_github_remote` repos can still do `local_branch` / `working_tree`. |
| `repositories.local_path` | absolute (CHECK `like '/%'`), stored already resolved by 06 (`realpath`, no trailing slash) | Uniqueness only works on canonical paths; Linux/macOS only (00 D12). |
| `visualizations.repository_id` | `onDelete: restrict` | Repositories are only soft-deleted; a hard delete with history would orphan artifacts on disk, so the DB refuses it. |
| `visualizations.title` | `text` | PR titles up to 256 chars plus branch-derived titles; 07 trims to 300 chars. |
| `*_sha` | `varchar(64)` | Allows SHA-256 object format repos. |
| `visualizations.head_sha` | nullable | `null` until prepared and always `null` for `working_tree` (00 §8 `PreparedWorkspace.headSha`). |
| `visualizations.base_sha` | nullable | `null` until 07's prepare step resolves it. |
| `visualizations.completed_at` | CHECK only set for terminal statuses | Catches orchestration bugs at write time. |
| `visualization_components.mocked_modules` | `not null default '[]'` | Never absent logically; avoids null checks. |
| `visualization_components.structural_diff` | nullable | `null` = not computed (only computed when rendering fails or on request in 11). |
| `visualization_components.diff_pixel_ratio` | `numeric(8,6)`, `mode: "number"`, CHECK 0..1 | Drizzle converts pg's string to `number` on read and number→string on write. Precision: 6 decimals; writers round with `Math.round(r * 1e6) / 1e6`. |
| `visualization_components (visualization_id, file_path, export_name)` | unique | One row per component per visualization; 08 must de-duplicate before insert, and a duplicate becomes a 23505 instead of silent double rendering. |
| `*_image_path` | `text`, path **relative to the data dir**, POSIX, e.g. `artifacts/12/345/base.png`; CHECK `like 'artifacts/%'` | 00 §14.3; matches 00 §8 `RenderSideResult.imagePath`; produced only by `ArtifactStore.componentImagePath()` and turned into a URL by `ArtifactStore.toPublicUrl()` (04). |
| `visualization_console_events.stage` | `text` + CHECK in `VisualizationStatus` values | 00 §14.4: stage values are the pipeline status names. Component names go in the message, never in `stage`. |
| `visualizations.failed_stage` | nullable `text`, CHECK in `NON_TERMINAL_VISUALIZATION_STATUSES`, and only non-null when `status in ('failed','cancelled')` | 00 §14.3. Written by 07 together with the terminal status, from `PipelineStepError.stage` or the stage active at cancel time. |
| `visualization_components.change_reason` | nullable `text` | 00 §14.3; `ComponentCandidate.reason` (08). Nullable because rows inserted before 08 sets it (tests, manual rows) are still valid. |
| `visualization_components.skip_reason` | nullable `text`, CHECK: non-null only when `render_status = 'skipped'` | 00 §14.3. 08 writes it for rows over the `MAX_COMPONENTS` cap; 09 may write it for `cannot_render`. |

### 6.3 Expected generated SQL (excerpt — verify after `db:generate`)

drizzle-kit 0.31 renders the patterns above as follows (verified on a scratch schema with the same helpers):

```sql
CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	...
	CONSTRAINT "app_settings_singleton_check" CHECK ("app_settings"."id" = 1),
	CONSTRAINT "app_settings_ai_provider_check" CHECK ("app_settings"."ai_provider" in ('anthropic_api', 'claude_code')),
	...
);
--> statement-breakpoint
ALTER TABLE "visualizations" ADD CONSTRAINT "visualizations_repository_id_repositories_id_fk"
  FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_local_path_active_key" ON "repositories" USING btree ("local_path")
  WHERE "repositories"."is_deleted" = false;
--> statement-breakpoint
CREATE INDEX "visualizations_repository_id_created_at_idx" ON "visualizations" USING btree ("repository_id","created_at" DESC NULLS LAST);
```

Column types to check in the generated file: `timestamp (3) with time zone`, `numeric(8, 6)`,
`jsonb DEFAULT '[]'::jsonb NOT NULL`, enum columns as plain `text` (no `CREATE TYPE`).

## 7. Detailed design — connection, registry, readiness

### 7.1 `backend/src/database/connection.ts`

Mirrors Uply-v2 `backend/src/database/connection.ts`, but uses a connection string instead of the
host/port/user split (`runtime-connection-config.ts` is **not** copied).

```ts
import { Pool } from "pg";
import { DATABASE_URL, DB_POOL_MAX } from "../config-consts";

let pool: Pool | null = null;

/**
 * Server-side guards for every session: UTC timestamps; no statement may run longer than 30 s and no
 * transaction may sit idle for more than 60 s (a stuck worker can never hold row locks indefinitely).
 */
const SESSION_OPTIONS = "-c timezone=UTC -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000";

/** Returns the process-wide pg Pool, creating it on first use. */
export function getPgPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: DB_POOL_MAX,
      options: SESSION_OPTIONS,
      application_name: "prvision",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

/** Ends the pool. Safe to call more than once. */
export async function closePgPool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}
```

The pool's `error` event (idle client errors) is attached by 04's `DbPool` so it goes through the logger.

### 7.2 `backend/src/database/table-registry.ts`

Uply's `QueryHandlerDrizzle.getTableSchema` indexes the schema module by the `Table` value (which there is the
camelCase export name). PRVision's `Table` values are SQL table names (00 §5), so the mapping is explicit and
type-checked for exhaustiveness:

```ts
import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Table } from "../enums";
import {
  appSettings,
  repositories,
  visualizationComponents,
  visualizationConsoleEvents,
  visualizations,
} from "./schema";

/** Exhaustive Table → Drizzle table map. Adding a Table value without an entry is a compile error. */
export const TABLE_SCHEMAS = {
  [Table.APP_SETTINGS]: appSettings,
  [Table.REPOSITORIES]: repositories,
  [Table.VISUALIZATIONS]: visualizations,
  [Table.VISUALIZATION_COMPONENTS]: visualizationComponents,
  [Table.VISUALIZATION_CONSOLE_EVENTS]: visualizationConsoleEvents,
} as const satisfies Record<Table, PgTable>;

export function getTableSchema(table: Table): PgTable {
  return TABLE_SCHEMAS[table];
}

/** True when the Drizzle table defines the given camelCase property (e.g. "isDeleted"). */
export function tableHasColumn(tableSchema: PgTable, propertyName: string): boolean {
  return Object.prototype.hasOwnProperty.call(getTableColumns(tableSchema), propertyName);
}

/** Tables that support soft delete. Derived, not hand-maintained. */
export function supportsSoftDelete(table: Table): boolean {
  return tableHasColumn(getTableSchema(table), "isDeleted");
}
```

`getTableSchema` cannot return null (the Uply "Invalid table" branch is unreachable and is dropped in 04).

### 7.3 `backend/src/database/schema-readiness.ts`

Called by `app.ts` and `worker.ts` (04) right after the DB ping so a missing migration fails fast with a
useful message instead of a 500 on the first request.

```ts
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { DatabaseError } from "pg";

/**
 * Migration folder resolved from the backend package root, so it is the same from src/database (ts-node)
 * and dist/database (compiled): tsc does not copy .sql/.json files into dist.
 */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../src/database/migrations");

export class DatabaseNotReadyError extends Error {
  constructor(message: string, readonly hint: string) {
    super(message);
    this.name = "DatabaseNotReadyError";
  }
}

/** Number of migrations drizzle-kit recorded in meta/_journal.json. */
export async function countJournalMigrations(migrationsFolder: string = MIGRATIONS_FOLDER): Promise<number> {
  const raw = await fs.readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8");
  const journal = JSON.parse(raw) as { entries?: unknown };
  return Array.isArray(journal.entries) ? journal.entries.length : 0;
}

/**
 * Verifies every committed migration was applied and the app_settings singleton row exists.
 * Throws DatabaseNotReadyError with an actionable hint; never mutates.
 */
export async function assertDatabaseReady(pool: Pool, migrationsFolder: string = MIGRATIONS_FOLDER): Promise<void> {
  const expected = await countJournalMigrations(migrationsFolder);
  try {
    const applied = await pool.query<{ applied: number }>(
      "select count(*)::int as applied from drizzle.__drizzle_migrations",
    );
    const appliedCount = applied.rows[0]?.applied ?? 0;
    if (appliedCount < expected) {
      throw new DatabaseNotReadyError(
        `${expected - appliedCount} database migration(s) are not applied`,
        "Run `npm run db:migrate`.",
      );
    }
    const result = await pool.query<{ id: number }>("select id from app_settings where id = 1");
    if (result.rowCount !== 1) {
      throw new DatabaseNotReadyError(
        "app_settings singleton row is missing",
        "Run `npm run db:migrate` on a fresh database, or restart the API (05 re-seeds the row on read).",
      );
    }
  } catch (error: unknown) {
    // 42P01 undefined_table, 3F000 invalid_schema_name: nothing was migrated yet.
    if (error instanceof DatabaseError && (error.code === "42P01" || error.code === "3F000")) {
      throw new DatabaseNotReadyError("Database schema is not migrated", "Run `npm run db:migrate`.");
    }
    throw error;
  }
}
```

An applied count **greater** than the journal (a newer branch migrated this database) is allowed: the
schema is a superset and drizzle never runs down-migrations.

## 8. Detailed design — migrations

### 8.1 `backend/drizzle.config.ts`

```ts
import type { Config } from "drizzle-kit";
import { DATABASE_URL } from "./src/config-consts";

export default {
  schema: "./src/database/schema.ts",
  out: "./src/database/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  // Empty string is fine for `generate`/`check` (no connection); `studio` needs a real DATABASE_URL.
  dbCredentials: { url: DATABASE_URL },
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
} satisfies Config;
```

`config-consts` must not throw at import when `DATABASE_URL` is missing (02 §6.7 contract; 04's
`config-validation.ts` is where missing values are reported). `drizzle-kit generate` with an empty url was
verified to work. This body is identical to 02 §6.9.3 (02 creates the file in the scaffold).

### 8.2 Initial migrations

Created once by the build agent, in this order, then committed:

```bash
cd backend
npm run db:generate -- --name initial_schema          # → 0000_initial_schema.sql + meta
npx drizzle-kit generate --custom --name seed_app_settings   # → empty 0001_seed_app_settings.sql + meta
```

`backend/src/database/migrations/0001_seed_app_settings.sql` (hand-written into the empty custom file):

```sql
-- Seed the app_settings singleton. Defaults come from the column definitions.
INSERT INTO "app_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
```

Rules:

- Never edit a migration that has been committed; add a new one.
- Never use `drizzle-kit push` (no `db:push` script exists).
- Hashes in `drizzle.__drizzle_migrations` are of the SQL text, so the seed file must not change after commit.

### 8.3 `backend/scripts/drizzle-migrate.ts`

Copy Uply-v2 `backend/scripts/drizzle-migrate.ts` **as committed in git** (the plain `migrate()` call), not
the uncommitted working-copy variant with `migrateOneAtATime`. That variant exists because Uply's pg enums
hit Postgres error 55P04 ("unsafe use of new enum value") when an enum value is added and used in one
transaction. PRVision has no pg enums (text + CHECK), so a single transaction for all pending migrations is
correct and preferable (all-or-nothing).

Changes from Uply: connection string instead of `getDatabaseConnectionConfig()`; explicit migrations table to
match `drizzle.config.ts`; the "no migrations yet" short-circuit from 02 §6.9.5 is kept (it is harmless once
migrations exist). Scripts print with `console` (01 §5.3.1 allows it in `backend/scripts/**`), which keeps
`db:migrate` independent of 04's logger and its pino-pretty transport.

```ts
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { DATABASE_URL } from "../src/config-consts";
import { MIGRATIONS_FOLDER } from "../src/database/schema-readiness";

function hasMigrations(): boolean {
  const journalPath = path.join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return false;
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries?: unknown };
  return Array.isArray(journal.entries) && journal.entries.length > 0;
}

async function main(): Promise<void> {
  if (!hasMigrations()) {
    console.log("No migrations found in src/database/migrations; nothing to apply.");
    return;
  }
  if (DATABASE_URL === "") {
    throw new Error("DATABASE_URL is not set (run npm run setup:env)");
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: "-c timezone=UTC" });
  try {
    // One transaction for all pending migrations (drizzle's node-postgres migrator): all-or-nothing.
    await migrate(drizzle(pool), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsTable: "__drizzle_migrations",
      migrationsSchema: "drizzle",
    });
    console.log("Drizzle migrations applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Print the message and pg code only: a pg error object can echo connection parameters.
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  console.error(`Drizzle migration failed${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
```

Never print `DATABASE_URL` (it contains the password). The migrate pool deliberately omits the
`statement_timeout` of §7.1: a migration may legitimately run longer than 30 s.

### 8.4 `backend/scripts/check-db-connection.ts`

Extend 02 §6.9.6's script: additionally print the number of applied migrations
(`select count(*)::int as applied from drizzle.__drizzle_migrations`, treating 42P01/3F000 as 0), the journal
count (`countJournalMigrations()` from `schema-readiness.ts`) and whether the singleton row exists. Exit code 1
on any failure; print the error message and pg code only, never the connection string.

## 9. Detailed design — models and conventions

### 9.1 Generator: copy and adapt Uply-v2 `backend/scripts/generate-models.ts`

Keep: schema module introspection via `DrizzleTable.Symbol.Columns`, `getTableColumns`, `getTableName`,
`toPascalCase`/`toSingular`/`toKebabCase`, deletion of old `*-model.ts` + `index.ts`, generated barrel,
`require.main === module` guard and the exported `generateModelClass` / `readSchemaTables` for tests.

Change:

1. **Nullability.** Uply ignores `notNull`. PRVision emits:
   - not-null column → `private _x!: T;`, setter `setX(value: T): void`, getter `get x(): T`
   - nullable column → `private _x!: T | null;`, setter `setX(value: T | null): void`, getter `get x(): T | null`

   Definite assignment (`!`) and no initializer keep Uply's semantics: an unset field is `undefined` at
   runtime and `QueryHandler.normalizeData` drops it, so DB defaults apply on insert and partial updates do
   not overwrite unrelated columns. Do **not** initialize nullable fields to `null` — that would make every
   model-based update null-out unset columns.
2. **Enum text columns** → literal union from `column.enumValues` (Uply's existing branch; works for
   `text(..., { enum })` — verified that `enumValues` is populated at runtime).
3. **jsonb columns** → type from an explicit override map; the generator **fails** if a json column has no
   entry (forces typing):

   ```ts
   const JSON_COLUMN_TYPES: Record<string, { tsType: string; typeImports: string[] }> = {
     "repositories.globalStylePaths": { tsType: "string[]", typeImports: [] },
     "visualizations.aiUsage": { tsType: "AiUsage", typeImports: ["AiUsage"] },
     "visualizationComponents.mockedModules": { tsType: "MockedModule[]", typeImports: ["MockedModule"] },
     "visualizationComponents.structuralDiff": { tsType: "StructuralChange[]", typeImports: ["StructuralChange"] },
   };
   // key = `${exportName}.${propertyName}`; emitted import:
   // import type { AiUsage } from "../types/visualization-pipeline";
   ```
4. **Numeric** `mode: "number"` reports `dataType: "number"` → `number` (no change needed; covered by test).
5. **Lint-clean constructor** under `strictTypeChecked` + `noUncheckedIndexedAccess`:

   ```ts
   constructor(data?: Partial<Record<keyof VisualizationModel, unknown>>) {
     if (!data) {
       return;
     }
     for (const [key, value] of Object.entries(data)) {
       if (value === undefined || value === null) {
         continue;
       }
       const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
       const setter = (this as unknown as Record<string, unknown>)[setterName];
       if (typeof setter === "function") {
         (setter as (input: unknown) => void).call(this, value);
       }
     }
   }
   ```
6. Explicit `: void` on setters; header comment
   `// AUTO-GENERATED by scripts/generate-models.ts from src/database/schema.ts — DO NOT EDIT.`
7. `CLASS_NAME_OVERRIDES` becomes an empty object (default singularisation yields the right names).
8. Format every generated source **in memory** with Prettier's API before writing, so `models:drift` is
   stable:
   ```ts
   import * as prettier from "prettier";
   const prettierOptions = (await prettier.resolveConfig(path.join(backendDir, ".prettierrc.json"))) ?? {};
   const formatted = await prettier.format(source, { ...prettierOptions, parser: "typescript" });
   ```
   Do **not** shell out to `prettier --write src/models`: `backend/.prettierignore` lists `src/models/`, and
   Prettier 3 skips ignored paths even when they are passed explicitly, so the CLI call would silently do
   nothing. `main()` becomes `async`; keep the `require.main === module` guard with
   `main().catch((error: unknown) => { console.error(error); process.exitCode = 1; })`.
9. Output goes to `console` (scripts may print; 01 §5.3.1). Final line: `Generated <n> model classes.`

### 9.2 Exact generated model list

| Schema export | Table | Class | File |
|---|---|---|---|
| `appSettings` | `app_settings` | `AppSettingModel` | `app-setting-model.ts` |
| `repositories` | `repositories` | `RepositoryModel` | `repository-model.ts` |
| `visualizations` | `visualizations` | `VisualizationModel` | `visualization-model.ts` |
| `visualizationComponents` | `visualization_components` | `VisualizationComponentModel` | `visualization-component-model.ts` |
| `visualizationConsoleEvents` | `visualization_console_events` | `VisualizationConsoleEventModel` | `visualization-console-event-model.ts` |

Fields are sorted alphabetically (Uply behaviour). Example of the expected output (abridged):

```ts
// AUTO-GENERATED by scripts/generate-models.ts from src/database/schema.ts — DO NOT EDIT.
import type { AiUsage } from "../types/visualization-pipeline";

/**
 * VisualizationModel
 * Auto-generated from Drizzle schema table "visualizations"
 */
export class VisualizationModel {
  private _aiModel!: string;
  private _aiProvider!: "anthropic_api" | "claude_code";
  private _aiUsage!: AiUsage | null;
  private _baseSha!: string | null;
  private _completedAt!: Date | null;
  private _createdAt!: Date;
  private _id!: number;
  private _isDeleted!: boolean;
  private _prNumber!: number | null;
  private _status!:
    | "queued" | "preparing" | "analyzing" | "generating_harnesses" | "rendering"
    | "diffing" | "summarizing" | "completed" | "failed" | "cancelled";
  // ...remaining columns

  constructor(data?: Partial<Record<keyof VisualizationModel, unknown>>) { /* as §9.1 item 5 */ }

  // ===== Setters =====
  setAiUsage(value: AiUsage | null): void { this._aiUsage = value; }
  setStatus(value: /* union */): void { this._status = value; }
  // ...

  // ===== Getters =====
  get aiUsage(): AiUsage | null { return this._aiUsage; }
  get status(): /* union */ { return this._status; }
  // ...
}
```

`VisualizationComponentModel.diffPixelRatio` is `number | null`; `changeReason` and `skipReason` are
`string | null`; `VisualizationModel.failedStage` is the `NON_TERMINAL_VISUALIZATION_STATUSES` union `| null`;
`VisualizationConsoleEventModel.stage` is the `VisualizationStatus` union; `RepositoryModel.globalStylePaths` is
`string[]`; `VisualizationConsoleEventModel` has no `updatedAt` / `isDeleted`.

### 9.3 Schema → model → migration workflow

1. Edit `src/database/schema.ts` (and enums if values change — enum value changes need a migration because
   the CHECK changes).
2. `npm run generate:models`
3. `npm run db:generate -- --name <snake_case_change_name>`
4. Review the SQL; `npm run db:migrate`
5. Commit schema, models, migration and `meta/` together. CI's `drizzle:drift` and `models:drift` fail otherwise.

### 9.4 How `QueryHandler` uses this sheet (contract for 04)

- `Table` → table object: `getTableSchema()` from `database/table-registry.ts`.
- Condition keys and payload keys are the **camelCase property names** (`repositoryId`, `isDeleted`), never
  SQL column names. Unknown keys are a programming error (04 throws `QueryHandlerError`).
- Soft-delete default: selects/counts on `repositories` and `visualizations` add `isDeleted = false` unless the
  caller passes `isDeleted` explicitly. `DeletionMode.SOFT` on the other three tables throws (no silent hard
  delete — a change from Uply).
- `updatedAt` stamped on every update for tables that have it; never for console events.
- Unique violation `23505` → 409 with `error_reason: "conflict"`; services map it to their own reason
  (e.g. 06 maps the `repositories_local_path_active_key` conflict to a 409 "Repository already registered").
  `QueryHandler` passes the constraint name through in its log and in `ApiResponse.error` detail so services
  can branch on it.

### 9.5 Row → view mapping conventions (binding for 05, 06, 07)

Views (00 §9) are built from models (or direct-Drizzle rows) by pure functions that live next to the view
interface in `dtos/<feature>/<name>-view.dto.ts`, named `to<Name>View(...)`. Rules:

| Source | View | Rule |
|---|---|---|
| `Date` (timestamptz) | `string` | `toIsoString(date)` from `utilities/helpers/date.ts` (04) → `date.toISOString()` (UTC, `Z`). Nullable → `toIsoStringOrNull`. Never `String(date)` or locale formats. |
| `numeric(8,6)` (`mode: "number"`) | `number \| null` | Already a JS number; pass through. Guard `Number.isFinite`, else `null`. |
| `integer` | `number` | Pass through. |
| jsonb arrays (`globalStylePaths`, `structuralDiff`) | arrays | Pass through; nullable jsonb → `null` (do not coerce `null` to `[]` for `structuralDiff`: `null` means "not computed"). |
| `aiUsage` jsonb | `{ inputTokens, outputTokens, calls } \| null` | Copy exactly these three fields (the stored `AiUsage` may also carry `cacheReadInputTokens`, 00 §14.4, which the view does not expose). |
| `failedStage`, `changeReason`, `skipReason` | same name, `T \| null` | Pass through (00 §14.4 view additions). |
| `*_image_path` (relative) | `*ImageUrl` | `ArtifactStore.toPublicUrl(path)` (04) → `"/artifacts/12/345/base.png"` or `null`. Never expose the absolute filesystem path. |
| `*_encrypted` columns | booleans | Only `hasGithubToken` / `hasAnthropicApiKey`; ciphertext never leaves the service. |
| `isDeleted`, `jobId`, `harness` internals not in the view | omitted | Views contain exactly the fields in 00 §9. |

Example (sheet 06 implements it; shown to fix the pattern):

```ts
export function toRepositoryView(model: RepositoryModel): RepositoryView {
  return {
    id: model.id,
    name: model.name,
    localPath: model.localPath,
    githubOwner: model.githubOwner,
    githubRepo: model.githubRepo,
    defaultBranch: model.defaultBranch,
    framework: model.framework,
    packageManager: model.packageManager,
    viteConfigPath: model.viteConfigPath,
    tsconfigPath: model.tsconfigPath,
    entryFilePath: model.entryFilePath,
    globalStylePaths: model.globalStylePaths,
    lastDetectedAt: toIsoString(model.lastDetectedAt),
    createdAt: toIsoString(model.createdAt),
  };
}
```

### 9.6 Package scripts this sheet relies on (sheet 02 wires them in `backend/package.json`, 02 §6.9.1)

No `tsconfig-paths`: PRVision has no path aliases (01 §5.1). Lines as in 02:

```json
"generate:models": "ts-node --transpile-only scripts/generate-models.ts",
"db:generate": "drizzle-kit generate",
"db:migrate": "ts-node --transpile-only scripts/drizzle-migrate.ts",
"db:check": "ts-node --transpile-only scripts/check-db-connection.ts",
"db:studio": "drizzle-kit studio",
"drizzle:check": "drizzle-kit check",
"drizzle:drift": "drizzle-kit generate && (git diff --exit-code --stat -- src/database/migrations && test -z \"$(git status --porcelain --untracked-files=all -- src/database/migrations)\" || (echo 'Drizzle schema drift: run npm run db:generate and commit.' >&2 && exit 1))",
"models:drift": "npm run generate:models && (git diff --exit-code --stat -- src/models && test -z \"$(git status --porcelain --untracked-files=all -- src/models)\" || (echo 'Model drift: run npm run generate:models and commit.' >&2 && exit 1))",
"schema:sync": "npm run generate:models && npm run db:generate && npm run db:migrate"
```

The root `npm run dev` (02) must run `db:migrate` after Postgres is healthy and before starting the API and
worker; `assertDatabaseReady` turns a skipped migration into a clear boot error.

### 9.7 Soft-delete semantics

- `repositories` and `visualizations` are soft-deleted via `QueryHandler.delete(..., DeletionMode.SOFT)`
  (sets `isDeleted = true`, stamps `updatedAt`).
- Default reads exclude soft-deleted rows. Direct-Drizzle reads (joins in 07) must add
  `eq(table.isDeleted, false)` themselves — reviewers check this.
- Re-registering a soft-deleted repository path inserts a **new** row (the partial unique index allows it);
  the old row and its visualizations stay soft-deleted/hidden. 06 must not "undelete".
- Visualizations of a soft-deleted repository are hidden from lists by 07 (join on
  `repositories.is_deleted = false`) but their rows and artifacts are not touched by repository deletion.
- Deleting a visualization (07): soft-delete the row, then remove `<dataDir>/artifacts/<id>` via
  `ArtifactStore.removeVisualization` (04; `removeVisualizationArtifacts` is only a deprecated alias, 00 §14.12). Its component and
  console rows remain (cascade only fires on hard delete) — they are unreachable through the API.
- `visualization_components` and `visualization_console_events` are never deleted individually by the app.

### 9.8 Seed data

Exactly one seed: the `app_settings` row (`id = 1`, column defaults) from migration 0001. No repositories or
visualizations are seeded. Registering the fixture repo (`<dataDir>/fixtures/sample-react-app`) is done through
the API by sheet 14's tooling, not by migrations. 05's `SettingsService` should still treat a missing row as
recoverable (`insert ... on conflict (id) do nothing` then re-read) so a manual `delete from app_settings`
does not brick the app.

### 9.9 Retention

None in the prototype. Rows and artifacts live until the user deletes the visualization or wipes the data
dir. Console events are bounded per visualization by 07 (it caps message length at
`CONSOLE_MESSAGE_MAX_LENGTH` = 4 000 chars, 02 §6.7, and the pipeline emits on the order of hundreds of events
per run). Documented in README (02): to reset everything,
`docker compose down -v && rm -rf ~/.prvision`.

## 10. Error handling and edge cases

| Situation | Behaviour |
|---|---|
| `DATABASE_URL` unset when running `db:migrate` | Script prints "Drizzle migration failed: DATABASE_URL is not set …", exit code 1 (exit 0 when there are no migrations at all) |
| Postgres not running | `db:migrate`/`db:check` exit 1 printing the `ECONNREFUSED` message (no connection string); API/worker boot fails in 04 before `assertDatabaseReady` |
| Migrations not applied, or only some applied | `assertDatabaseReady` throws `DatabaseNotReadyError` ("N database migration(s) are not applied", hint: run `npm run db:migrate`) |
| Query or transaction hangs | Postgres cancels it after `statement_timeout` (30 s) / `idle_in_transaction_session_timeout` (60 s), error 57014 / 25P03 → `QueryHandler` 500 |
| `failed_stage` set while status is not `failed`/`cancelled`, or set to a terminal value | 23514 → 500 (07 bug) |
| `skip_reason` on a non-skipped row | 23514 → 500 (08/09 bug) |
| Console event with a stage that is not a status name | 23514 → 500 (07 bug) |
| Singleton row deleted manually | `assertDatabaseReady` fails at boot with the hint; 05 re-seeds on read when running |
| Second `app_settings` row insert | Rejected by `app_settings_singleton_check` (23514) or PK (23505) |
| Invalid enum value written | 23514 check violation → 04 logs with constraint name, returns 500 (a service bug, not user error) |
| Same `local_path` registered twice (both active) | 23505 on `repositories_local_path_active_key` → 409 `conflict` → 06 maps to user message |
| Duplicate component in one visualization | 23505 on `visualization_components_visualization_file_export_key` → 08 bug; 08 dedupes first |
| `diff_pixel_ratio` with > 6 decimals | Postgres rounds to scale 6 (no error); outside 0..1 → 23514 |
| Hard delete of a repository with visualizations | 23503 (restrict) → 409 `conflict` from QueryHandler; the app never does this |
| json column without `JSON_COLUMN_TYPES` entry | `generate-models` throws `Missing JSON_COLUMN_TYPES entry for <export>.<prop>` and exits 1 |
| drizzle-kit `generate` produces no changes | Prints "No schema changes"; `drizzle:drift` passes |

## 11. Logging

- Scripts print with `console` (allowed in `backend/scripts/**`): success lines with counts
  (`Generated 5 model classes.`, `Drizzle migrations applied successfully.`), failures as one
  `console.error` line with the message and pg code. Never print `DATABASE_URL`.
- `DbPool` (04) logs idle-client `error` events at `error` with `{ err }`.
- `QueryHandlerDrizzle` (04) logs DB errors at `error` with `{ table, operation, pgCode, constraint, detail }`
  (no row payloads — they may contain encrypted secrets or large diffs).
- No user-facing console events (`visualization_console_events`) originate in this sheet.

## 12. Security notes

- Encrypted columns (`github_token_encrypted`, `anthropic_api_key_encrypted`) store only AES-256-GCM payloads
  produced by 04's `Encryption`; plaintext secrets must never be written to any column, including
  `error_message`, `harness_notes`, `ai_note` or console `message` (05/07/09/11 must pass error strings
  through `redactSecrets()` from 04's logger module before persisting).
- Views never include ciphertext (§9.5).
- Postgres is bound to `127.0.0.1:5433` by Docker Compose (02); the default `prvision/prvision` credentials
  are acceptable only because of that binding.
- Migrations contain no secrets; the seed inserts only `id`.
- `schema.ts` never reads env, so drizzle-kit cannot leak config.

## 13. Tests

All in `tests/backend/database/`, `node:test` + `node:assert/strict`.

`enums.test.ts` (02 ships `tests/backend/enums/enums.test.ts` with the basic value checks; this file adds)
- `each domain enum has exactly the values listed in 00 §5` (deepEqual on `Object.values` and on each `*_VALUES` tuple)
- `Table values are the snake_case SQL table names (00 §14.3)`
- `TERMINAL_VISUALIZATION_STATUSES is a subset of VisualizationStatus values`
- `ACTIVE + TERMINAL + queued covers every VisualizationStatus exactly once`; `NON_TERMINAL = queued + ACTIVE`
- `enumValues throws on an empty object`

`schema.test.ts` (uses `getTableConfig` from `drizzle-orm/pg-core`; no DB)
- `defines exactly the five tables named in 00 §6` (`getTableName` of every table export)
- `every table has id, createdAt; all but console events have updatedAt`
- `repositories and visualizations have isDeleted; the other three do not`
- `every enum-backed column has a CHECK named <table>_<column>_check` (iterate columns with `enumValues`)
- `app_settings has app_settings_singleton_check`
- `repositories has a partial unique index on local_path where is_deleted = false` (index name + `isUnique` + `where` present)
- `visualizations.repository_id FK uses onDelete restrict`
- `visualization_components and console events FKs use onDelete cascade`
- `required indexes exist`: `visualizations_repository_id_created_at_idx`, `visualization_components_visualization_id_rank_idx`, `visualization_console_events_visualization_id_id_idx`
- `diffPixelRatio is numeric(8, 6) in number mode` (`getSQLType() === "numeric(8, 6)"`, `dataType === "number"`)
- `timestamps are timestamptz with precision 3` (`getSQLType() === "timestamp (3) with time zone"`)
- `schema.ts does not import config-consts or utilities` (read file text, assert no such import)
- `visualizations has failed_stage with visualizations_failed_stage_check and visualizations_failed_stage_status_check`
- `visualization_components has change_reason, skip_reason and visualization_components_skip_reason_check`
- `console event stage is CHECKed against VisualizationStatus values`
- `DEFAULT_AI_MODEL in schema.ts equals AI_DEFAULT_MODEL from ai.config.ts` (read the column default via `getTableConfig`)
- `every CHECK renders without bound parameters` (for each table, `getTableConfig(t).checks`; render `check.value` with `new PgDialect().sqlToQuery()` and assert `params.length === 0`; `sqlLiteralList` itself is module-private)

`table-registry.test.ts`
- `TABLE_SCHEMAS has an entry for every Table value and getTableName matches the value`
- `supportsSoftDelete is true only for repositories and visualizations`
- `tableHasColumn uses property names, not SQL names` (`isDeleted` true, `is_deleted` false)

`model-generator.test.ts` (imports `readSchemaTables`, `generateModelClass`)
- `produces the five class names from §9.2`
- `nullable columns are typed T | null and not-null columns T`
- `enum text columns become literal unions`
- `json columns use JSON_COLUMN_TYPES and emit type-only imports`
- `fails when a json column has no type mapping` (call the mapper with a fake json column)
- `generated source has no "any"` (regex `\bany\b` absent)
- `committed src/models matches generator output` (generate to a temp dir, run prettier, compare) — optional if `models:drift` runs in CI

`migrations.integration.test.ts` — `test.skip` unless `PRVISION_TEST_DATABASE_URL` is set. Creates a fresh
schema-isolated database state: `drop schema public cascade; create schema public; drop schema if exists drizzle cascade;`
on the **test** database only (assert the URL's database name ends in `_test` before dropping).
- `migrations apply to an empty database and seed app_settings id=1 with defaults`
- `re-running migrations is a no-op`
- `inserting app_settings id=2 fails the singleton check`
- `invalid visualization status is rejected by the CHECK`
- `local_path can be re-registered after soft delete but not while active`
- `github_pr requires pr_number and other source types forbid it`
- `diff_pixel_ratio round-trips as a JS number (0.123456) and rejects 1.5`
- `deleting a visualization row cascades to components and console events`
- `hard-deleting a repository with visualizations fails with 23503`
- `failed_stage is rejected while status is rendering and accepted with status failed`
- `skip_reason is rejected on a rendered row and accepted on a skipped row`
- `console event stage "render:Button" is rejected`
- `assertDatabaseReady passes after migrate, throws DatabaseNotReadyError on an empty schema, and throws when the journal lists more migrations than were applied` (pass a temp `migrationsFolder` whose journal has one extra entry)

The integration file connects with `PRVISION_TEST_DATABASE_URL` (00 §14.10; read by the test file, never by
`config-consts`) and builds its own `Pool`; it never uses `getPgPool()`.

## 14. Acceptance criteria

- [ ] `backend/src/database/schema.ts` matches §6.1 (table/column names exactly as 00 §6, camelCase properties).
- [ ] `npm run db:generate` on a clean checkout reports no changes (migrations committed and current).
- [ ] `0000_initial_schema.sql` contains every CHECK, FK and index named in §6.1, enum columns are `text`, no `CREATE TYPE`.
- [ ] `0001_seed_app_settings.sql` contains only the idempotent insert of `id = 1`.
- [ ] `docker compose up -d postgres && npm run db:migrate` succeeds on an empty DB; running it again succeeds and changes nothing.
- [ ] `select * from app_settings` returns one row with provider `anthropic_api`, model `claude-opus-5-5`, efforts `high`/`medium`.
- [ ] `npm run generate:models` produces exactly the five files in §9.2 plus `index.ts`; `npm run models:drift` passes; running it twice produces no diff.
- [ ] Generated models compile under `npm run typecheck` (`strict` + `noUncheckedIndexedAccess`); they are excluded from `npm run lint` (01 §5.3.1 ignores `src/models/**`) but `cd .. && npx eslint -c backend/eslint.config.js --no-ignore backend/src/models` reports 0 problems; no `any`.
- [ ] `0000_initial_schema.sql` contains `failed_stage`, `change_reason`, `skip_reason` and the checks `visualizations_failed_stage_check`, `visualizations_failed_stage_status_check`, `visualization_components_skip_reason_check`, `visualization_components_image_path_relative_check`, `visualization_console_events_stage_check`.
- [ ] Every CHECK in the generated SQL contains literal values only (no `$1` placeholders).
- [ ] `TABLE_SCHEMAS` is exhaustive (removing an entry fails `tsc`).
- [ ] `assertDatabaseReady` is exported and throws `DatabaseNotReadyError` on an unmigrated DB.
- [ ] All tests in §13 pass; integration tests pass when `PRVISION_TEST_DATABASE_URL` points at a `*_test` database.
- [ ] No file in this sheet reads `process.env` directly.

## 15. Contract changes requested

1. **`Table` / `DeletionMode` as `as const` objects.** Resolved — 00 §14.3 (snake_case values, `table-registry.ts`).
2. **Enum file ownership.** Resolved — 00 §14.3 (03 owns `enums/**`, 02 creates the files in the scaffold).
3. **Image path storage format.** Resolved — 00 §14.3 (relative `artifacts/<v>/<c>/<kind>.png`, `ArtifactStore.toPublicUrl`).
4. **New columns and adopted constraints.** Resolved — 00 §14.3 (`change_reason`, `skip_reason`, `failed_stage`; FK restrict, unique component key, pr_number, completed_at, diff ratio).

Open: none. Interpretations made here (no contract change needed): `failed_stage` is also CHECKed to be null
unless `status in ('failed','cancelled')`; `skip_reason` is CHECKed to be null unless `render_status = 'skipped'`;
console `stage` is CHECKed against the `VisualizationStatus` values (00 §14.4); image paths are CHECKed to start
with `artifacts/`.
