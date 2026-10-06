import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AI_DEFAULT_MODEL } from "../../../backend/src/config-consts/ai.config";
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
  schema.visualizationConsoleEvents
];

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

test("defines exactly the five tables named in 00 §6", () => {
  const exportsList: unknown[] = Object.values(schema);
  const tableExports = exportsList.filter((value): value is PgTable => is(value, drizzlePgCore.PgTable));
  assert.deepEqual(tableExports.map((table) => getTableName(table)).sort(), [
    "app_settings",
    "repositories",
    "visualization_components",
    "visualization_console_events",
    "visualizations"
  ]);
});

test("every table has id, createdAt; all but console events have updatedAt", () => {
  for (const table of TABLES) {
    const names = columnNames(table);
    assert.ok(names.includes("id"), getTableName(table));
    assert.ok(names.includes("created_at"), getTableName(table));
    assert.equal(names.includes("updated_at"), table !== schema.visualizationConsoleEvents, getTableName(table));
  }
});

test("repositories and visualizations have isDeleted; the other three do not", () => {
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
    const [foreignKey, ...rest] = getTableConfig(table).foreignKeys;
    assert.ok(foreignKey);
    assert.equal(rest.length, 0);
    assert.equal(foreignKey.onDelete, "cascade", getTableName(table));
    assert.equal(getTableName(foreignKey.reference().foreignTable), "visualizations");
  }
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
    ["../enums", "../types/visualization-pipeline", "drizzle-orm", "drizzle-orm/pg-core"].sort()
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
