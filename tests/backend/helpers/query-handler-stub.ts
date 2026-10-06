/**
 * InMemoryQueryHandler (sheet 14 §5.4.4): an in-memory fake of sheet 04's QueryHandler facade (04 §8.4) that
 * mirrors QueryHandlerDrizzle (04 §8.5) wherever tests can observe it — method names and argument order, SQL
 * three-valued condition logic, soft-delete defaults, column validation, Drizzle defaults, error responses and
 * throws. CHECK constraints are NOT evaluated (sheet 03's migrations.integration.test.ts proves those).
 */
import { getTableColumns, is, SQL, type Column } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableSchema, supportsSoftDelete, tableHasColumn } from "../../../backend/src/database/table-registry";
import { DeletionMode, ErrorReason, type Table } from "../../../backend/src/enums";
import { ModelHandler } from "../../../backend/src/utilities/handlers/model-handler";
import {
  isWhereOperator,
  type Conditions,
  type ScalarValue,
  type SelectManyOptions,
  type WhereOperator
} from "../../../backend/src/utilities/handlers/query-conditions";
import { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { QueryHandlerError } from "../../../backend/src/utilities/handlers/query-handler-drizzle";
import type { ApiResponse } from "../../../backend/src/utilities/handlers/response-handler";
import { patchStaticMethod } from "./test-context";

export type Row = Record<string, unknown> & { id: number };
export type QueryHandlerMethod =
  "insert" | "select" | "update" | "delete" | "count" | "checkDuplicates" | "validateAndSelect" | "selectMany";
export interface RecordedCall {
  method: QueryHandlerMethod;
  table: Table;
  args: unknown[];
}

const DB_FAILURE: ApiResponse<never> = {
  status: 500,
  error: "Internal server error",
  error_reason: ErrorReason.INTERNAL_ERROR
};
const NO_CONDITIONS: ApiResponse<never> = {
  status: 400,
  error: "No valid conditions provided",
  error_reason: ErrorReason.VALIDATION_FAILED
};
const NOT_FOUND: ApiResponse<never> = { status: 404, error: "Record not found", error_reason: ErrorReason.NOT_FOUND };
const NOT_NULL_VIOLATION: ApiResponse<never> = {
  status: 400,
  error: "Invalid value for database column",
  error_reason: ErrorReason.VALIDATION_FAILED
};
const dialect = new PgDialect();
const SQL_DEFAULTS: Record<string, ((now: Date) => unknown) | undefined> = {
  "now()": (now) => now,
  "'[]'::jsonb": () => []
};

const columnsOf = (table: Table): Record<string, Column> => getTableColumns(getTableSchema(table));
const hasColumn = (table: Table, key: string): boolean => tableHasColumn(getTableSchema(table), key);

/** Settle like a real DB round-trip: validation errors surface as rejections, never as synchronous throws. */
const roundTrip = (): Promise<void> => Promise.resolve();

/** In-memory QueryHandler with call recording, an injectable clock and scripted DB failures. */
export class InMemoryQueryHandler {
  readonly calls: RecordedCall[] = [];
  private readonly tables = new Map<Table, Row[]>();
  private readonly nextId = new Map<Table, number>();
  private readonly failures = new Map<QueryHandlerMethod, Array<ApiResponse<never> | Error>>();
  /** Injectable clock so timestamps are deterministic. */
  now: () => Date = () => new Date("2026-01-01T00:00:00.000Z");

  /** Same as QueryHandler.firstInsertedId. */
  static firstInsertedId(response: ApiResponse<Record<string, unknown>[]>): number | null {
    const id = response.data?.[0]?.id;
    return typeof id === "number" ? id : null;
  }

  /** Same as QueryHandler.normalizeData (static form). */
  static normalizeData(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const record = data as Record<string, unknown>;
    for (const prop of Object.getOwnPropertyNames(record)) {
      const clean = prop.startsWith("_") ? prop.slice(1) : prop;
      if (excludedKeys.includes(prop) || excludedKeys.includes(clean)) {
        continue;
      }
      const value = record[prop];
      if (value !== undefined && typeof value !== "function") {
        out[clean] = value; // keeps null (04)
      }
    }
    return out;
  }

  /** Test setup: inserts rows without recording a call; missing NOT NULL columns become null instead of failing. */
  seed(table: Table, rows: Array<Partial<Row>>): Row[] {
    return rows.map((row) => this.insertOne(table, this.checkedValues(table, row, [], "seed"), false));
  }

  /** Copies of every stored row of `table` (soft-deleted ones included). */
  rows(table: Table): Row[] {
    return (this.tables.get(table) ?? []).map((row) => ({ ...row }));
  }

  /** Copy of one stored row, or undefined. */
  row(table: Table, id: number): Row | undefined {
    return this.rows(table).find((row) => row.id === id);
  }

  /** Recorded calls of one method (optionally for one table). */
  callsFor(method: QueryHandlerMethod, table?: Table): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && (table === undefined || c.table === table));
  }

  /** Simulates one DB failure on the next call to `method` (after argument validation, like a real DB error). */
  failNext(method: QueryHandlerMethod, failure: ApiResponse<never> | Error = DB_FAILURE): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  normalizeData(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    return InMemoryQueryHandler.normalizeData(data, excludedKeys);
  }

  async insert(
    data: Record<string, unknown> | Record<string, unknown>[],
    table: Table,
    excludedKeys: readonly string[] = []
  ): Promise<ApiResponse<Record<string, unknown>[]>> {
    await roundTrip();
    this.record("insert", table, [data, excludedKeys]);
    const prepared = (Array.isArray(data) ? data : [data]).map((input) =>
      this.checkedValues(table, input, excludedKeys, "insert")
    );
    if (prepared.length === 0) {
      return { status: 200, data: [] };
    }
    const failure = this.responseFailure("insert");
    if (failure) {
      return failure;
    }
    if (prepared.some((values) => this.missingNotNull(table, values))) {
      return NOT_NULL_VIOLATION;
    }
    return { status: 200, data: prepared.map((values) => ({ ...this.insertOne(table, values, true) })) };
  }

  async select(conditions: Conditions, table: Table, isolateData: true): Promise<Record<string, unknown>[]>;
  async select(
    conditions: Conditions,
    table: Table,
    isolateData?: false
  ): Promise<ApiResponse<Record<string, unknown>[]>>;
  async select(
    conditions: Conditions,
    table: Table,
    isolateData = false
  ): Promise<ApiResponse<Record<string, unknown>[]> | Record<string, unknown>[]> {
    await roundTrip();
    this.record("select", table, [conditions, isolateData]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, conditions));
    if (isolateData) {
      this.throwingFailure("select", table);
      return this.match(table, effective);
    }
    const failure = this.responseFailure("select");
    if (failure) {
      return failure;
    }
    return { status: 200, data: this.match(table, effective) };
  }

  async update(
    newValues: Record<string, unknown>,
    conditions: Conditions,
    table: Table,
    excludedKeys: readonly string[] = []
  ): Promise<ApiResponse<{ rowsAffected: number }>> {
    await roundTrip();
    this.record("update", table, [newValues, conditions, excludedKeys]);
    const where = this.checkedConditions(table, conditions); // unknown keys throw first (buildWhere)
    if (!this.hasEffectiveConditions(where)) {
      return NO_CONDITIONS;
    }
    const values = this.checkedValues(table, newValues, excludedKeys, "update"); // then unknown value keys throw
    const failure = this.responseFailure("update");
    if (failure) {
      return failure;
    }
    const targets = (this.tables.get(table) ?? []).filter((row) => this.matches(row, where));
    const stamp = hasColumn(table, "updatedAt") ? { updatedAt: this.now() } : {};
    for (const row of targets) {
      Object.assign(row, values, stamp, { id: row.id });
    }
    return targets.length > 0 ? { status: 200, data: { rowsAffected: targets.length } } : NOT_FOUND;
  }

  async delete(
    conditions: Conditions,
    table: Table,
    mode: DeletionMode
  ): Promise<ApiResponse<{ rowsAffected: number }>> {
    await roundTrip();
    this.record("delete", table, [conditions, mode]);
    if (mode === DeletionMode.SOFT && !supportsSoftDelete(table)) {
      throw new QueryHandlerError(`Table ${table} does not support soft delete`, "delete", table);
    }
    const where = this.checkedConditions(table, conditions);
    if (!this.hasEffectiveConditions(where)) {
      return NO_CONDITIONS;
    }
    const failure = this.responseFailure("delete");
    if (failure) {
      return failure;
    }
    const rows = this.tables.get(table) ?? [];
    const targets = rows.filter((row) => this.matches(row, where));
    if (targets.length === 0) {
      return NOT_FOUND;
    }
    if (mode === DeletionMode.SOFT) {
      for (const row of targets) {
        Object.assign(row, { isDeleted: true, updatedAt: this.now() });
      }
    } else {
      this.tables.set(
        table,
        rows.filter((row) => !targets.includes(row))
      );
    }
    return { status: 200, data: { rowsAffected: targets.length } };
  }

  async count(conditions: Conditions, table: Table): Promise<ApiResponse<{ count: number }>> {
    await roundTrip();
    this.record("count", table, [conditions]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, conditions));
    const failure = this.responseFailure("count");
    if (failure) {
      return failure;
    }
    return { status: 200, data: { count: this.match(table, effective).length } };
  }

  async checkDuplicates(keyName: string, keyValue: ScalarValue, table: Table): Promise<boolean> {
    this.record("checkDuplicates", table, [keyName, keyValue]);
    this.throwingFailure("checkDuplicates", table);
    return (await this.select({ [keyName]: keyValue }, table, true)).length > 0; // 04 delegates to select(…, true) too
  }

  async validateAndSelect<T extends object>(
    ModelClass: new () => T,
    query: Conditions,
    table: Table
  ): Promise<T | null> {
    await roundTrip();
    this.record("validateAndSelect", table, [ModelClass.name, query]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, query));
    this.throwingFailure("validateAndSelect", table);
    const [row] = this.match(table, effective).sort((a, b) => a.id - b.id); // limit 1, ordered by id
    return row ? ModelHandler.hydrate(ModelClass, row) : null;
  }

  async selectMany<T extends object>(
    ModelClass: new () => T,
    conditions: Conditions,
    table: Table,
    options: SelectManyOptions = {}
  ): Promise<T[]> {
    await roundTrip();
    this.record("selectMany", table, [ModelClass.name, conditions, options]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, conditions));
    const order = options.orderBy?.length ? options.orderBy : [{ column: "id", direction: "asc" as const }];
    for (const key of [...Object.keys(options.search ?? {}), ...order.map((o) => o.column)]) {
      this.assertColumn(table, key, "selectMany");
    }
    this.throwingFailure("selectMany", table);
    let rows = this.match(table, effective);
    for (const [field, needle] of Object.entries(options.search ?? {})) {
      rows = rows.filter((row) => stringOf(row[field]).toLowerCase().includes(needle.toLowerCase()));
    }
    rows.sort((a, b) => {
      for (const { column, direction } of order) {
        const cmp = compareForOrder(a[column], b[column], direction);
        if (cmp !== 0) {
          return cmp;
        }
      }
      return 0;
    });
    const offset = options.offset ?? 0;
    return rows
      .slice(offset, options.limit === undefined ? undefined : offset + options.limit)
      .map((row) => ModelHandler.hydrate(ModelClass, row));
  }

  // ---- internals ----
  private insertOne(table: Table, values: Record<string, unknown>, strict: boolean): Row {
    const nextId = this.nextId.get(table) ?? 1;
    const id = typeof values.id === "number" ? values.id : nextId;
    this.nextId.set(table, Math.max(nextId, id + 1));
    const row: Row = { ...this.defaultsFor(table, values, strict), ...values, id };
    this.tables.set(table, [...(this.tables.get(table) ?? []), row]);
    return { ...row };
  }

  /** Every column the caller did not provide: its Drizzle default, else null (what Postgres returns). */
  private defaultsFor(table: Table, provided: Record<string, unknown>, strict: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(columnsOf(table))) {
      if (key === "id" || key in provided) {
        continue;
      }
      if (column.defaultFn) {
        out[key] = column.defaultFn();
        continue;
      }
      if (!column.hasDefault) {
        out[key] = null;
        continue;
      }
      if (is(column.default, SQL)) {
        const text = dialect.sqlToQuery(column.default).sql;
        const make = SQL_DEFAULTS[text];
        if (!make) {
          if (strict) {
            throw new Error(
              `InMemoryQueryHandler cannot evaluate SQL default ${text} for ${table}.${key}; pass a value`
            );
          }
          out[key] = null;
          continue;
        }
        out[key] = make(this.now());
        continue;
      }
      out[key] = column.default;
    }
    return out;
  }

  private missingNotNull(table: Table, values: Record<string, unknown>): boolean {
    return Object.entries(columnsOf(table)).some(
      ([key, column]) =>
        key !== "id" &&
        column.notNull &&
        !column.hasDefault &&
        !column.defaultFn &&
        (values[key] === undefined || values[key] === null)
    );
  }

  private checkedValues(
    table: Table,
    data: object,
    excludedKeys: readonly string[],
    operation: string
  ): Record<string, unknown> {
    const values = this.normalizeData(data, excludedKeys);
    for (const key of Object.keys(values)) {
      this.assertColumn(table, key, operation);
    }
    return values;
  }

  private checkedConditions(table: Table, conditions: Conditions): Conditions {
    for (const [key, value] of Object.entries(conditions)) {
      if (value !== undefined) {
        this.assertColumn(table, key, "where");
      }
    }
    return conditions;
  }

  private assertColumn(table: Table, key: string, operation: string): void {
    if (!hasColumn(table, key)) {
      throw new QueryHandlerError(`Unknown column "${key}"`, operation, table);
    }
  }

  private withSoftDeleteDefault(table: Table, conditions: Conditions): Conditions {
    if (!supportsSoftDelete(table) || Object.prototype.hasOwnProperty.call(conditions, "isDeleted")) {
      return conditions;
    }
    return { isDeleted: false, ...conditions };
  }

  private hasEffectiveConditions(conditions: Conditions): boolean {
    return Object.values(conditions).some((value) => value !== undefined);
  }

  private match(table: Table, conditions: Conditions): Row[] {
    return (this.tables.get(table) ?? []).filter((row) => this.matches(row, conditions)).map((row) => ({ ...row }));
  }

  private matches(row: Row, conditions: Conditions): boolean {
    return Object.entries(conditions).every(([key, expected]) => {
      if (expected === undefined) {
        return true; // ignored (04)
      }
      const actual = row[key] ?? null;
      if (expected === null) {
        return actual === null; // IS NULL
      }
      if (isWhereOperator(expected)) {
        return evaluate(actual, expected);
      }
      return actual !== null && compare(actual, expected) === 0; // NULL = x is never true
    });
  }

  private record(method: QueryHandlerMethod, table: Table, args: unknown[]): void {
    this.calls.push({ method, table, args });
  }

  private responseFailure(method: QueryHandlerMethod): ApiResponse<never> | undefined {
    const next = this.failures.get(method)?.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  private throwingFailure(method: QueryHandlerMethod, table: Table): void {
    const next = this.failures.get(method)?.shift();
    if (next === undefined) {
      return;
    }
    throw next instanceof Error ? next : new QueryHandlerError(`Database ${method} failed on ${table}`, method, table);
  }
}

function stringOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) {
    return 0;
  }
  return (av as number | string) < (bv as number | string) ? -1 : 1;
}

/** Postgres ORDER BY: NULLS LAST for asc, NULLS FIRST for desc. */
function compareForOrder(a: unknown, b: unknown, direction: "asc" | "desc"): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) {
    if (an && bn) {
      return 0;
    }
    return (an ? 1 : -1) * (direction === "asc" ? 1 : -1);
  }
  return direction === "asc" ? compare(a, b) : -compare(a, b);
}

/** SQL semantics: any comparison with NULL is unknown (false), except notIn([]) which 04 renders as TRUE. */
function evaluate(actual: unknown, operator: WhereOperator): boolean {
  switch (operator.op) {
    case "isNull":
      return actual === null;
    case "isNotNull":
      return actual !== null;
    case "in":
      // in([]) matches nothing (04)
      return actual !== null && operator.values.some((value) => compare(actual, value) === 0);
    case "notIn":
      if (operator.values.length === 0) {
        return true;
      }
      return actual !== null && !operator.values.some((value) => compare(actual, value) === 0);
    case "ne":
      return actual !== null && compare(actual, operator.value) !== 0;
    case "gt":
      return actual !== null && compare(actual, operator.value) > 0;
    case "gte":
      return actual !== null && compare(actual, operator.value) >= 0;
    case "lt":
      return actual !== null && compare(actual, operator.value) < 0;
    case "lte":
      return actual !== null && compare(actual, operator.value) <= 0;
  }
}

/** Routes every QueryHandler instance (prototype patch, incl. `new QueryHandler(tx)`) to one in-memory store. */
export function installQueryHandlerStub(stub = new InMemoryQueryHandler()): {
  stub: InMemoryQueryHandler;
  restore: () => void;
} {
  const methods: QueryHandlerMethod[] = [
    "insert",
    "select",
    "update",
    "delete",
    "count",
    "checkDuplicates",
    "validateAndSelect",
    "selectMany"
  ];
  const restores = methods.map((method) =>
    patchStaticMethod(QueryHandler.prototype, method, ((...args: unknown[]) =>
      (stub[method] as (...a: unknown[]) => unknown).apply(stub, args)) as never)
  );
  const normalize = ((data: object, excluded?: readonly string[]) => stub.normalizeData(data, excluded)) as never;
  restores.push(patchStaticMethod(QueryHandler.prototype, "normalizeData", normalize));
  restores.push(patchStaticMethod(QueryHandler, "normalizeData", normalize));
  return {
    stub,
    restore: () => {
      for (const restore of restores.reverse()) {
        restore();
      }
    }
  };
}
