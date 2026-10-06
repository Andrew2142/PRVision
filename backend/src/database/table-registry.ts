import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Table } from "../enums";
import {
  appSettings,
  repositories,
  visualizationComponents,
  visualizationConsoleEvents,
  visualizations
} from "./schema";

/** Exhaustive Table → Drizzle table map. Adding a Table value without an entry is a compile error. */
export const TABLE_SCHEMAS = {
  [Table.APP_SETTINGS]: appSettings,
  [Table.REPOSITORIES]: repositories,
  [Table.VISUALIZATIONS]: visualizations,
  [Table.VISUALIZATION_COMPONENTS]: visualizationComponents,
  [Table.VISUALIZATION_CONSOLE_EVENTS]: visualizationConsoleEvents
} as const satisfies Record<Table, PgTable>;

/** Drizzle table object for a logical Table value. */
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
