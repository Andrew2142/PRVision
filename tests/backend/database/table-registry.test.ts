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

test("tableHasColumn uses property names, not SQL names", () => {
  const repositories = getTableSchema(Table.REPOSITORIES);
  assert.equal(tableHasColumn(repositories, "isDeleted"), true);
  assert.equal(tableHasColumn(repositories, "is_deleted"), false);
  assert.equal(tableHasColumn(repositories, "toString"), false);
});
