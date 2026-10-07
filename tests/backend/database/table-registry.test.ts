import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TABLE_SCHEMAS,
  getTableSchema,
  supportsSoftDelete,
  tableHasColumn
} from "../../../backend/src/database/table-registry";
import { TABLE_VALUES, Table } from "../../../backend/src/enums";
import * as drizzleOrm from "drizzle-orm";

const { getTableName } = drizzleOrm;

test("TABLE_SCHEMAS has an entry for every Table value and getTableName matches the value", () => {
  assert.deepEqual(Object.keys(TABLE_SCHEMAS).sort(), [...TABLE_VALUES].sort());
  for (const table of TABLE_VALUES) {
    assert.equal(getTableName(getTableSchema(table)), table);
    assert.equal(getTableSchema(table), TABLE_SCHEMAS[table]);
  }
});

test("supportsSoftDelete is true only for repositories and visualizations", () => {
  const softDeletable = TABLE_VALUES.filter((table) => supportsSoftDelete(table));
  assert.deepEqual(softDeletable.sort(), [Table.REPOSITORIES, Table.VISUALIZATIONS].sort());
});

test("16 §6.10: the five library tables are registered", () => {
  for (const table of [
    Table.HARNESS_LIBRARY_ENTRIES,
    Table.HARNESS_LIBRARY_JOBS,
    Table.HARNESS_LIBRARY_JOB_EVENTS,
    Table.VISUALIZATION_COMPONENT_STATES,
    Table.LIVE_SESSIONS
  ]) {
    assert.equal(getTableName(getTableSchema(table)), table);
    assert.equal(supportsSoftDelete(table), false, table);
  }
});

test("tableHasColumn uses property names, not SQL names", () => {
  const repositories = getTableSchema(Table.REPOSITORIES);
  assert.equal(tableHasColumn(repositories, "isDeleted"), true);
  assert.equal(tableHasColumn(repositories, "is_deleted"), false);
  assert.equal(tableHasColumn(repositories, "toString"), false);
});
