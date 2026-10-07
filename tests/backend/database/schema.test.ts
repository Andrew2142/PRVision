import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AI_DEFAULT_MODEL } from "../../../backend/src/config-consts/ai.config";
import {
  STATE_ALLOWANCE_DEFAULT,
  STATE_ALLOWANCE_MAX,
  STATE_ALLOWANCE_MIN
} from "../../../backend/src/config-consts/render.config";
import * as schema from "../../../backend/src/database/schema";
import { NON_TERMINAL_VISUALIZATION_STATUSES, VISUALIZATION_STATUS_VALUES } from "../../../backend/src/enums";
import * as drizzleOrm from "drizzle-orm";
import * as drizzlePgCore from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

const { getTableName, is } = drizzleOrm;
const { PgDialect, getTableConfig } = drizzlePgCore;

const SCHEMA_FILE = path.resolve(__dirname, "../../../backend/src/database/schema.ts");

const TABLES: PgTable[] = [
  schema.appSettings,
  schema.repositories,
  schema.visualizations,
  schema.visualizationComponents,
  schema.visualizationConsoleEvents,
  schema.harnessLibraryEntries,
  schema.harnessLibraryJobs,
  schema.harnessLibraryJobEvents,
  schema.visualizationComponentStates,
  schema.liveSessions
];

/** Append-only tables (no updated_at): 00 §6 console events and 16 §6.5 library job events. */
const APPEND_ONLY_TABLES: PgTable[] = [schema.visualizationConsoleEvents, schema.harnessLibraryJobEvents];

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkNames(table: PgTable): string[] {
  return getTableConfig(table).checks.map((check) => check.name);
}

function indexNames(table: PgTable): Array<string | undefined> {
  return getTableConfig(table).indexes.map((index) => index.config.name);
}

function column(table: PgTable, name: string) {
  const found = getTableConfig(table).columns.find((candidate) => candidate.name === name);
  assert.ok(found, `${getTableName(table)}.${name} exists`);
  return found;
}

test("defines exactly the five tables named in 00 §6 plus the five of 16 §6.3–§6.9", () => {
  const exportsList: unknown[] = Object.values(schema);
  const tableExports = exportsList.filter((value): value is PgTable => is(value, drizzlePgCore.PgTable));
  assert.deepEqual(tableExports.map((table) => getTableName(table)).sort(), [
    "app_settings",
    "harness_library_entries",
    "harness_library_job_events",
    "harness_library_jobs",
    "live_sessions",
    "repositories",
    "visualization_component_states",
    "visualization_components",
    "visualization_console_events",
    "visualizations"
  ]);
});

test("every table has id, createdAt; all but the append-only event tables have updatedAt", () => {
  for (const table of TABLES) {
    const names = columnNames(table);
    assert.ok(names.includes("id"), getTableName(table));
    assert.ok(names.includes("created_at"), getTableName(table));
    assert.equal(names.includes("updated_at"), !APPEND_ONLY_TABLES.includes(table), getTableName(table));
  }
});

test("repositories and visualizations have isDeleted; the other tables do not", () => {
  for (const table of TABLES) {
    const expected = table === schema.repositories || table === schema.visualizations;
    assert.equal(columnNames(table).includes("is_deleted"), expected, getTableName(table));
  }
});

test("every enum-backed column has a CHECK named <table>_<column>_check", () => {
  let enumColumns = 0;
  for (const table of TABLES) {
    const checks = checkNames(table);
    for (const enumColumn of getTableConfig(table).columns) {
      if (!Array.isArray(enumColumn.enumValues) || enumColumn.enumValues.length === 0) {
        continue;
      }
      enumColumns += 1;
      const expected = `${getTableName(table)}_${enumColumn.name}_check`;
      assert.ok(checks.includes(expected), `missing ${expected}`);
    }
  }
  assert.ok(enumColumns >= 14, `expected at least 14 enum-backed columns, found ${enumColumns}`);
});

test("app_settings has app_settings_singleton_check", () => {
  assert.ok(checkNames(schema.appSettings).includes("app_settings_singleton_check"));
});

test("repositories has a partial unique index on (local_path, app_root, coalesce(angular_project, '')) where is_deleted = false", () => {
  const indexes = getTableConfig(schema.repositories).indexes;
  assert.equal(
    indexes.some((candidate) => candidate.config.name === "repositories_local_path_active_key"),
    false,
    "the single-column key was replaced (15 §5.4.1)"
  );
  const index = indexes.find((candidate) => candidate.config.name === "repositories_local_path_app_active_key");
  assert.ok(index);
  assert.equal(index.config.unique, true);
  assert.ok(index.config.where);
  const [localPath, appRoot, angularProject, ...rest] = index.config.columns;
  assert.equal(rest.length, 0);
  assert.deepEqual(
    [localPath, appRoot].map((indexColumn) => (indexColumn && "name" in indexColumn ? indexColumn.name : "")),
    ["local_path", "app_root"]
  );
  assert.ok(is(angularProject, drizzleOrm.SQL), "third key part is an expression");
  assert.match(new PgDialect().sqlToQuery(angularProject).sql, /coalesce\(("repositories"\.)?"angular_project", ''\)/);
  const where = new PgDialect().sqlToQuery(index.config.where);
  assert.match(where.sql, /"is_deleted" = false/);
});

test("repositories has app_root, angular_project, angular_build_configuration and the 15 §5.4.1 CHECKs", () => {
  const appRoot = column(schema.repositories, "app_root");
  assert.equal(appRoot.notNull, true);
  assert.equal(appRoot.default, ".");
  assert.equal(column(schema.repositories, "angular_project").notNull, false);
  assert.equal(column(schema.repositories, "angular_build_configuration").notNull, false);
  assert.deepEqual(column(schema.repositories, "framework").enumValues, ["react_vite", "angular"]);
  const checks = checkNames(schema.repositories);
  for (const name of [
    "repositories_app_root_check",
    "repositories_angular_project_check",
    "repositories_react_root_check"
  ]) {
    assert.ok(checks.includes(name), name);
  }
});

test("visualizations.repository_id FK uses onDelete restrict", () => {
  const [foreignKey, ...rest] = getTableConfig(schema.visualizations).foreignKeys;
  assert.ok(foreignKey);
  assert.equal(rest.length, 0);
  assert.equal(foreignKey.onDelete, "restrict");
  const reference = foreignKey.reference();
  assert.deepEqual(
    reference.columns.map((referenceColumn) => referenceColumn.name),
    ["repository_id"]
  );
  assert.equal(getTableName(reference.foreignTable), "repositories");
});

test("visualization_components and console events FKs use onDelete cascade", () => {
  for (const table of [schema.visualizationComponents, schema.visualizationConsoleEvents]) {
    const toVisualizations = getTableConfig(table).foreignKeys.filter(
      (foreignKey) => getTableName(foreignKey.reference().foreignTable) === "visualizations"
    );
    assert.equal(toVisualizations.length, 1, getTableName(table));
    assert.equal(toVisualizations[0]?.onDelete, "cascade", getTableName(table));
  }
  // The only other FKs are 16 §6.7's library entry links of visualization_components (set null).
  assert.equal(getTableConfig(schema.visualizationConsoleEvents).foreignKeys.length, 1);
  assert.equal(getTableConfig(schema.visualizationComponents).foreignKeys.length, 3);
});

test("required indexes exist", () => {
  assert.ok(indexNames(schema.visualizations).includes("visualizations_repository_id_created_at_idx"));
  assert.ok(indexNames(schema.visualizationComponents).includes("visualization_components_visualization_id_rank_idx"));
  assert.ok(
    indexNames(schema.visualizationConsoleEvents).includes("visualization_console_events_visualization_id_id_idx")
  );
  const componentKey = getTableConfig(schema.visualizationComponents).indexes.find(
    (index) => index.config.name === "visualization_components_visualization_file_export_key"
  );
  assert.equal(componentKey?.config.unique, true);
});

test("diffPixelRatio is numeric(8, 6) in number mode", () => {
  assert.equal(schema.visualizationComponents.diffPixelRatio.getSQLType(), "numeric(8, 6)");
  assert.equal(schema.visualizationComponents.diffPixelRatio.dataType, "number");
});

test("timestamps are timestamptz with precision 3", () => {
  let timestamps = 0;
  for (const table of TABLES) {
    for (const tableColumn of getTableConfig(table).columns) {
      if (tableColumn.dataType !== "date") {
        continue;
      }
      timestamps += 1;
      assert.equal(
        tableColumn.getSQLType(),
        "timestamp (3) with time zone",
        `${getTableName(table)}.${tableColumn.name}`
      );
    }
  }
  assert.ok(timestamps >= 12);
});

test("schema.ts does not import config-consts or utilities", () => {
  const source = fs.readFileSync(SCHEMA_FILE, "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.doesNotMatch(specifier ?? "", /config-consts|utilities/);
  }
  assert.deepEqual(
    [...new Set(specifiers)].sort(),
    [
      "../enums",
      "../types/harness-library",
      "../types/visualization-pipeline",
      "drizzle-orm",
      "drizzle-orm/pg-core"
    ].sort()
  );
});

test("visualizations has failed_stage with visualizations_failed_stage_check and visualizations_failed_stage_status_check", () => {
  const failedStage = column(schema.visualizations, "failed_stage");
  assert.equal(failedStage.notNull, false);
  assert.deepEqual(failedStage.enumValues, [...NON_TERMINAL_VISUALIZATION_STATUSES]);
  const checks = checkNames(schema.visualizations);
  assert.ok(checks.includes("visualizations_failed_stage_check"));
  assert.ok(checks.includes("visualizations_failed_stage_status_check"));
});

test("visualizations has visualizations_commit_range_shas_check and allows source_type commit_range (00 §16)", () => {
  const config = getTableConfig(schema.visualizations);
  assert.ok(checkNames(schema.visualizations).includes("visualizations_commit_range_shas_check"));
  const sourceType = config.columns.find((column) => column.name === "source_type");
  assert.ok(sourceType?.enumValues?.includes("commit_range"));
});

test("visualization_components has change_reason, skip_reason and visualization_components_skip_reason_check", () => {
  assert.equal(column(schema.visualizationComponents, "change_reason").notNull, false);
  assert.equal(column(schema.visualizationComponents, "skip_reason").notNull, false);
  assert.ok(checkNames(schema.visualizationComponents).includes("visualization_components_skip_reason_check"));
});

test("console event stage is CHECKed against VisualizationStatus values", () => {
  const stageCheck = getTableConfig(schema.visualizationConsoleEvents).checks.find(
    (check) => check.name === "visualization_console_events_stage_check"
  );
  assert.ok(stageCheck);
  const rendered = new PgDialect().sqlToQuery(stageCheck.value).sql;
  for (const status of VISUALIZATION_STATUS_VALUES) {
    assert.ok(rendered.includes(`'${status}'`), status);
  }
  assert.deepEqual(column(schema.visualizationConsoleEvents, "stage").enumValues, [...VISUALIZATION_STATUS_VALUES]);
});

test("DEFAULT_AI_MODEL in schema.ts equals AI_DEFAULT_MODEL from ai.config.ts", () => {
  assert.equal(column(schema.appSettings, "ai_model").default, AI_DEFAULT_MODEL);
});

test("every CHECK renders without bound parameters", () => {
  const dialect = new PgDialect();
  let rendered = 0;
  for (const table of TABLES) {
    const config = getTableConfig(table);
    for (const check of config.checks) {
      const query = dialect.sqlToQuery(check.value);
      assert.equal(query.params.length, 0, `${check.name} has bound parameters`);
      assert.doesNotMatch(query.sql, /\$\d/, check.name);
      rendered += 1;
    }
    for (const index of config.indexes) {
      if (index.config.where) {
        assert.equal(dialect.sqlToQuery(index.config.where).params.length, 0, `${index.config.name} predicate`);
      }
    }
  }
  assert.ok(rendered > 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Sheet 16 §6 (16a): harness library tables and columns
// ---------------------------------------------------------------------------------------------------------------

function checkSql(table: PgTable, name: string): string {
  const found = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  assert.ok(found, `${getTableName(table)} has ${name}`);
  return new PgDialect().sqlToQuery(found.value).sql;
}

function indexConfig(table: PgTable, name: string) {
  const found = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  assert.ok(found, `${getTableName(table)} has index ${name}`);
  return found.config;
}

function indexColumnNames(table: PgTable, name: string): string[] {
  return indexConfig(table, name).columns.map((indexColumn) =>
    "name" in indexColumn && typeof indexColumn.name === "string" ? indexColumn.name : "<expression>"
  );
}

function foreignKeyTo(table: PgTable, columnName: string) {
  const found = getTableConfig(table).foreignKeys.find((foreignKey) =>
    foreignKey.reference().columns.some((referenceColumn) => referenceColumn.name === columnName)
  );
  assert.ok(found, `${getTableName(table)}.${columnName} FK`);
  return { onDelete: found.onDelete, target: getTableName(found.reference().foreignTable) };
}

test("16 §6.2: repositories has library_build_mode (grow) and state_allowance (3) with their CHECKs", () => {
  const buildMode = column(schema.repositories, "library_build_mode");
  assert.equal(buildMode.notNull, true);
  assert.equal(buildMode.default, "grow");
  assert.deepEqual(buildMode.enumValues, ["grow", "scan"]);
  const allowance = column(schema.repositories, "state_allowance");
  assert.equal(allowance.notNull, true);
  assert.equal(allowance.default, STATE_ALLOWANCE_DEFAULT);
  assert.match(checkSql(schema.repositories, "repositories_library_build_mode_check"), /in \('grow', 'scan'\)/);
  assert.match(checkSql(schema.repositories, "repositories_state_allowance_check"), /between 1 and 5/);
});

test("16 §6.2: the 1–5 CHECK literals equal STATE_ALLOWANCE_MIN/MAX", () => {
  const literal = `between ${String(STATE_ALLOWANCE_MIN)} and ${String(STATE_ALLOWANCE_MAX)}`;
  for (const [table, name] of [
    [schema.repositories, "repositories_state_allowance_check"],
    [schema.harnessLibraryEntries, "harness_library_entries_state_allowance_check"],
    [schema.harnessLibraryJobs, "harness_library_jobs_state_allowance_check"]
  ] as const) {
    assert.ok(checkSql(table, name).includes(literal), name);
  }
  assert.ok(
    checkSql(schema.harnessLibraryEntries, "harness_library_entries_state_count_check").includes(
      `between ${String(STATE_ALLOWANCE_MIN)} and ${String(STATE_ALLOWANCE_MAX)}`
    )
  );
});

test("16 §6.3: harness_library_entries columns, CHECKs and indexes", () => {
  assert.deepEqual(columnNames(schema.harnessLibraryEntries).sort(), [
    "ai_model",
    "ai_usage",
    "cost_usd",
    "created_at",
    "display_name",
    "export_name",
    "file_path",
    "framework",
    "harness_source",
    "id",
    "last_error",
    "last_failed_visualization_id",
    "last_rendered_at",
    "mocked_modules",
    "notes",
    "origin",
    "repository_id",
    "revision",
    "selector",
    "source_fingerprint",
    "state_allowance",
    "state_count",
    "states",
    "status",
    "updated_at",
    "written_at"
  ]);
  assert.deepEqual(column(schema.harnessLibraryEntries, "status").enumValues, [
    "ready",
    "needs_update",
    "off_default_branch"
  ]);
  assert.deepEqual(column(schema.harnessLibraryEntries, "origin").enumValues, ["run", "scan", "repair", "import"]);
  assert.equal(column(schema.harnessLibraryEntries, "revision").default, 1);
  assert.equal(column(schema.harnessLibraryEntries, "notes").default, "");
  assert.equal(column(schema.harnessLibraryEntries, "harness_source").notNull, false);
  assert.equal(column(schema.harnessLibraryEntries, "cost_usd").getSQLType(), "numeric(10, 4)");
  assert.equal(column(schema.harnessLibraryEntries, "cost_usd").dataType, "number");
  assert.equal(column(schema.harnessLibraryEntries, "source_fingerprint").getSQLType(), "varchar(64)");
  assert.match(
    checkSql(schema.harnessLibraryEntries, "harness_library_entries_source_fingerprint_check"),
    /"source_fingerprint" is null or .*"source_fingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/
  );
  assert.match(
    checkSql(schema.harnessLibraryEntries, "harness_library_entries_ready_harness_check"),
    /"status" <> 'ready' or .*"harness_source" is not null/
  );
  assert.match(
    checkSql(schema.harnessLibraryEntries, "harness_library_entries_selector_check"),
    /"framework" = 'angular' or .*"selector" is null/
  );
  assert.match(checkSql(schema.harnessLibraryEntries, "harness_library_entries_revision_check"), /"revision" >= 1/);
  assert.match(checkSql(schema.harnessLibraryEntries, "harness_library_entries_states_check"), /jsonb_typeof/);
  for (const name of [
    "harness_library_entries_framework_check",
    "harness_library_entries_status_check",
    "harness_library_entries_origin_check",
    "harness_library_entries_file_path_relative_check",
    "harness_library_entries_state_count_check"
  ]) {
    assert.ok(checkNames(schema.harnessLibraryEntries).includes(name), name);
  }
  const identity = indexConfig(schema.harnessLibraryEntries, "harness_library_entries_identity_key");
  assert.equal(identity.unique, true);
  assert.equal(identity.where, undefined);
  assert.deepEqual(indexColumnNames(schema.harnessLibraryEntries, "harness_library_entries_identity_key"), [
    "repository_id",
    "file_path",
    "export_name"
  ]);
  assert.deepEqual(indexColumnNames(schema.harnessLibraryEntries, "harness_library_entries_repository_status_idx"), [
    "repository_id",
    "status"
  ]);
  assert.deepEqual(foreignKeyTo(schema.harnessLibraryEntries, "repository_id"), {
    onDelete: "cascade",
    target: "repositories"
  });
  // E26: last_failed_visualization_id is a plain integer (runs are soft-deleted and may be removed).
  assert.equal(getTableConfig(schema.harnessLibraryEntries).foreignKeys.length, 1);
});

test("16 §6.4: harness_library_jobs CHECKs and the partial unique indexes for active scans and repairs", () => {
  assert.equal(column(schema.harnessLibraryJobs, "status").default, "queued");
  assert.equal(column(schema.harnessLibraryJobs, "spend_cap_usd").getSQLType(), "numeric(10, 2)");
  assert.equal(column(schema.harnessLibraryJobs, "spent_usd").getSQLType(), "numeric(10, 4)");
  assert.equal(column(schema.harnessLibraryJobs, "spent_usd").notNull, true);
  assert.equal(column(schema.harnessLibraryJobs, "ai_model").notNull, true);
  assert.match(
    checkSql(schema.harnessLibraryJobs, "harness_library_jobs_visualization_id_check"),
    /\("harness_library_jobs"\."kind" = 'repair'\) = \("harness_library_jobs"\."visualization_id" is not null\)/
  );
  assert.match(
    checkSql(schema.harnessLibraryJobs, "harness_library_jobs_component_ids_check"),
    /= 'repair'\) = \("harness_library_jobs"\."component_ids" is not null\)/
  );
  assert.match(
    checkSql(schema.harnessLibraryJobs, "harness_library_jobs_spend_cap_usd_check"),
    /"spend_cap_usd" is null or \(.*"spend_cap_usd" > 0 and .*"kind" <> 'repair'\)/
  );
  assert.match(
    checkSql(schema.harnessLibraryJobs, "harness_library_jobs_counts_check"),
    /"written_count" \+ "harness_library_jobs"\."failed_count" \+ "harness_library_jobs"\."skipped_count" <= "harness_library_jobs"\."total_count"/
  );
  assert.match(
    checkSql(schema.harnessLibraryJobs, "harness_library_jobs_completed_at_check"),
    /in \('completed', 'cap_reached', 'failed', 'cancelled'\)/
  );
  const dialect = new PgDialect();
  const activeScan = indexConfig(schema.harnessLibraryJobs, "harness_library_jobs_active_scan_key");
  assert.equal(activeScan.unique, true);
  assert.deepEqual(indexColumnNames(schema.harnessLibraryJobs, "harness_library_jobs_active_scan_key"), [
    "repository_id"
  ]);
  assert.ok(activeScan.where);
  assert.match(
    dialect.sqlToQuery(activeScan.where).sql,
    /"kind" in \('scan', 'rescan'\) and .*"status" in \('queued', 'preparing', 'running'\)/
  );
  const activeRepair = indexConfig(schema.harnessLibraryJobs, "harness_library_jobs_active_repair_key");
  assert.equal(activeRepair.unique, true);
  assert.deepEqual(indexColumnNames(schema.harnessLibraryJobs, "harness_library_jobs_active_repair_key"), [
    "visualization_id"
  ]);
  assert.ok(activeRepair.where);
  assert.match(
    dialect.sqlToQuery(activeRepair.where).sql,
    /"kind" = 'repair' and .*"status" in \('queued', 'preparing', 'running'\)/
  );
  assert.ok(indexNames(schema.harnessLibraryJobs).includes("harness_library_jobs_repository_created_idx"));
  assert.deepEqual(foreignKeyTo(schema.harnessLibraryJobs, "repository_id"), {
    onDelete: "cascade",
    target: "repositories"
  });
  assert.deepEqual(foreignKeyTo(schema.harnessLibraryJobs, "visualization_id"), {
    onDelete: "cascade",
    target: "visualizations"
  });
});

test("16 §6.5: harness_library_job_events is append-only with a (job_id, id) index", () => {
  assert.deepEqual(columnNames(schema.harnessLibraryJobEvents).sort(), [
    "created_at",
    "id",
    "job_id",
    "level",
    "message"
  ]);
  assert.deepEqual(indexColumnNames(schema.harnessLibraryJobEvents, "harness_library_job_events_job_id_id_idx"), [
    "job_id",
    "id"
  ]);
  assert.deepEqual(foreignKeyTo(schema.harnessLibraryJobEvents, "job_id"), {
    onDelete: "cascade",
    target: "harness_library_jobs"
  });
});

test("16 §6.6: visualization_component_states ordinals, sides, failure kinds and unique keys", () => {
  assert.match(
    checkSql(schema.visualizationComponentStates, "visualization_component_states_ordinal_check"),
    /"ordinal" between 0 and 9/
  );
  assert.match(
    checkSql(schema.visualizationComponentStates, "visualization_component_states_default_ordinal_check"),
    /"ordinal" <> 0 or .*"state_name" = 'Default'/
  );
  assert.match(
    checkSql(schema.visualizationComponentStates, "visualization_component_states_sides_check"),
    /"on_base" or .*"on_head"/
  );
  for (const side of ["base", "head"]) {
    const rendered = checkSql(
      schema.visualizationComponentStates,
      `visualization_component_states_${side}_failure_kind_check`
    );
    for (const kind of ["vite_unavailable", "module_load", "step_failed", "budget_exceeded", "cancelled"]) {
      assert.ok(rendered.includes(`'${kind}'`), `${side} ${kind}`);
    }
  }
  assert.equal(column(schema.visualizationComponentStates, "state_name").getSQLType(), "varchar(40)");
  assert.equal(column(schema.visualizationComponentStates, "render_status").default, "pending");
  assert.deepEqual(
    indexColumnNames(schema.visualizationComponentStates, "visualization_component_states_component_ordinal_key"),
    ["visualization_component_id", "ordinal"]
  );
  assert.deepEqual(
    indexColumnNames(schema.visualizationComponentStates, "visualization_component_states_component_name_key"),
    ["visualization_component_id", "state_name"]
  );
  for (const name of [
    "visualization_component_states_component_ordinal_key",
    "visualization_component_states_component_name_key"
  ]) {
    assert.equal(indexConfig(schema.visualizationComponentStates, name).unique, true, name);
  }
  assert.ok(
    indexNames(schema.visualizationComponentStates).includes("visualization_component_states_visualization_idx")
  );
  assert.deepEqual(foreignKeyTo(schema.visualizationComponentStates, "visualization_component_id"), {
    onDelete: "cascade",
    target: "visualization_components"
  });
  assert.deepEqual(foreignKeyTo(schema.visualizationComponentStates, "visualization_id"), {
    onDelete: "cascade",
    target: "visualizations"
  });
});

test("16 §6.7: visualization_components library columns, rechecked change kind and library entry FKs", () => {
  const changeKind = checkSql(schema.visualizationComponents, "visualization_components_change_kind_check");
  assert.ok(changeKind.includes("'rechecked'"));
  assert.ok(column(schema.visualizationComponents, "change_kind").enumValues?.includes("rechecked"));
  assert.equal(column(schema.visualizationComponents, "harness_needs_update").default, false);
  assert.equal(column(schema.visualizationComponents, "source_changed_since_write").notNull, false);
  assert.equal(column(schema.visualizationComponents, "state_count").default, 0);
  assert.equal(column(schema.visualizationComponents, "changed_state_count").default, 0);
  assert.match(
    checkSql(schema.visualizationComponents, "visualization_components_base_library_entry_id_check"),
    /"change_kind" = 'replaced' or .*"base_library_entry_id" is null/
  );
  assert.match(
    checkSql(schema.visualizationComponents, "visualization_components_base_harness_origin_check"),
    /"change_kind" = 'replaced' or .*"base_harness_origin" is null/
  );
  assert.match(
    checkSql(schema.visualizationComponents, "visualization_components_changed_state_count_check"),
    /"changed_state_count" <= .*"state_count"/
  );
  assert.ok(checkNames(schema.visualizationComponents).includes("visualization_components_harness_origin_check"));
  for (const name of ["library_entry_id", "base_library_entry_id"]) {
    assert.deepEqual(foreignKeyTo(schema.visualizationComponents, name), {
      onDelete: "set null",
      target: "harness_library_entries"
    });
  }
});

test("16 §6.8: visualizations library counts, trigger and working_tree_snapshot CHECKs", () => {
  for (const name of ["checked_count", "reused_harness_count", "new_harness_count", "needs_update_count"]) {
    assert.equal(column(schema.visualizations, name).notNull, true, name);
    assert.equal(column(schema.visualizations, name).default, 0, name);
  }
  assert.equal(column(schema.visualizations, "global_style_trigger").notNull, false);
  assert.equal(column(schema.visualizations, "working_tree_snapshot").default, false);
  assert.match(
    checkSql(schema.visualizations, "visualizations_checked_count_check"),
    /"checked_count" <= .*"component_count"/
  );
  assert.match(
    checkSql(schema.visualizations, "visualizations_working_tree_snapshot_check"),
    /not .*"working_tree_snapshot" or .*"source_type" = 'working_tree'/
  );
});

test("16 §6.9: live_sessions status, stop reason CHECKs and the partial active indexes", () => {
  assert.equal(column(schema.liveSessions, "status").default, "starting");
  assert.equal(column(schema.liveSessions, "open_requests_version").default, 0);
  assert.match(
    checkSql(schema.liveSessions, "live_sessions_stop_reason_status_check"),
    /"stop_reason" is null or .*"status" in \('stopping', 'stopped', 'failed'\)/
  );
  assert.ok(checkNames(schema.liveSessions).includes("live_sessions_stop_reason_check"));
  const dialect = new PgDialect();
  const activeKey = indexConfig(schema.liveSessions, "live_sessions_active_visualization_key");
  assert.equal(activeKey.unique, true);
  assert.deepEqual(indexColumnNames(schema.liveSessions, "live_sessions_active_visualization_key"), [
    "visualization_id"
  ]);
  assert.ok(activeKey.where);
  assert.match(dialect.sqlToQuery(activeKey.where).sql, /"status" in \('starting', 'ready', 'stopping'\)/);
  const activeIdx = indexConfig(schema.liveSessions, "live_sessions_active_idx");
  assert.equal(activeIdx.unique, false);
  assert.ok(activeIdx.where);
  assert.match(dialect.sqlToQuery(activeIdx.where).sql, /"status" in \('starting', 'ready', 'stopping'\)/);
  assert.deepEqual(foreignKeyTo(schema.liveSessions, "visualization_id"), {
    onDelete: "cascade",
    target: "visualizations"
  });
});
