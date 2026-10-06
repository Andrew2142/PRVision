import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
  type Column,
  type SQL
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { DatabaseError } from "pg";
import { getTableSchema, supportsSoftDelete, tableHasColumn } from "../../database/table-registry";
import { DeletionMode, ErrorReason, type Table } from "../../enums";
import { createLogger } from "../loggers/logger";
import { DrizzleDb, type DbExecutor } from "../services/drizzle-db";
import { ModelHandler } from "./model-handler";
import { isWhereOperator, type Conditions, type SelectManyOptions } from "./query-conditions";
import type { ApiResponse } from "./response-handler";

const log = createLogger("query-handler");

/** Programming errors (unknown column, unsupported soft delete) and DB failures of the throwing methods. */
export class QueryHandlerError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly table: Table,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "QueryHandlerError";
  }
}

/**
 * Implements the QueryHandler contract on Drizzle (04 §8.5). Tables are resolved through
 * database/table-registry.ts; condition and payload keys are camelCase model properties.
 */
export class QueryHandlerDrizzle {
  private readonly db: DbExecutor;

  /**
   * @param db - Executor for every call; pass the `tx` of DrizzleDb.transaction to make several writes atomic.
   */
  constructor(db?: DbExecutor) {
    this.db = db ?? DrizzleDb.getInstance();
  }

  /**
   * Uply dbPrepare: own property names, leading "_" stripped, functions and undefined dropped, null kept.
   *
   * @param data - Model instance or plain object.
   * @param excludedKeys - Keys (with or without "_") to omit.
   */
  normalizeData(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    return QueryHandlerDrizzle.normalize(data, excludedKeys);
  }

  /** Static form of normalizeData (needs no database connection). */
  static normalize(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    const record = data as Record<string, unknown>;
    const prepared: Record<string, unknown> = {};
    for (const property of Object.getOwnPropertyNames(record)) {
      if (excludedKeys.includes(property)) {
        continue;
      }
      const value = record[property];
      if (typeof value === "function" || value === undefined) {
        continue;
      }
      const cleanProperty = property.startsWith("_") ? property.slice(1) : property;
      if (excludedKeys.includes(cleanProperty)) {
        continue;
      }
      prepared[cleanProperty] = value;
    }
    return prepared;
  }

  /** Inserts one or more rows and returns them. Unknown keys throw; an empty array is 200 []. */
  async insert(
    data: Record<string, unknown> | Record<string, unknown>[],
    table: Table,
    excludedKeys: readonly string[] = []
  ): Promise<ApiResponse<Record<string, unknown>[]>> {
    const tableSchema = getTableSchema(table);
    const rows = (Array.isArray(data) ? data : [data]).map((row) =>
      this.prepareValues(tableSchema, table, row, excludedKeys, "insert")
    );
    if (rows.length === 0) {
      return { status: 200, data: [] };
    }
    try {
      const result = await this.db
        .insert(tableSchema)
        .values(rows as never)
        .returning();
      return { status: 200, data: result };
    } catch (error: unknown) {
      return this.handleDatabaseError(error, "insert", table);
    }
  }

  /** Selects rows (soft-delete default applied). `isolateData` returns the rows and throws on DB errors. */
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
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, this.applyDefaultConditions(table, conditions));
    try {
      const rows = (await this.db.select().from(tableSchema).where(where)) as Record<string, unknown>[];
      return isolateData ? rows : { status: 200, data: rows };
    } catch (error: unknown) {
      if (isolateData) {
        throw this.wrap(error, "select", table);
      }
      return this.handleDatabaseError(error, "select", table);
    }
  }

  /** Updates matching rows and stamps updatedAt. No conditions → 400 without a write; 0 rows → 404. */
  async update(
    newValues: Record<string, unknown>,
    conditions: Conditions,
    table: Table,
    excludedKeys: readonly string[] = []
  ): Promise<ApiResponse<{ rowsAffected: number }>> {
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, conditions);
    if (!where) {
      return { status: 400, error: "No valid conditions provided", error_reason: ErrorReason.VALIDATION_FAILED };
    }
    const values = this.withUpdatedAt(
      tableSchema,
      this.prepareValues(tableSchema, table, newValues, excludedKeys, "update")
    );
    try {
      const result = await this.db
        .update(tableSchema)
        .set(values as never)
        .where(where)
        .returning();
      return result.length > 0
        ? { status: 200, data: { rowsAffected: result.length } }
        : { status: 404, error: "Record not found", error_reason: ErrorReason.NOT_FOUND };
    } catch (error: unknown) {
      return this.handleDatabaseError(error, "update", table);
    }
  }

  /**
   * Soft delete (isDeleted = true + updatedAt) or hard delete. No conditions → 400; 0 rows → 404.
   *
   * @throws QueryHandlerError for SOFT on a table without isDeleted (Uply silently hard-deleted).
   */
  async delete(
    conditions: Conditions,
    table: Table,
    deletionMode: DeletionMode
  ): Promise<ApiResponse<{ rowsAffected: number }>> {
    if (deletionMode === DeletionMode.SOFT && !supportsSoftDelete(table)) {
      throw new QueryHandlerError(`Table ${table} does not support soft delete`, "delete", table);
    }
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, conditions);
    if (!where) {
      return { status: 400, error: "No valid conditions provided", error_reason: ErrorReason.VALIDATION_FAILED };
    }
    try {
      const result =
        deletionMode === DeletionMode.SOFT
          ? await this.db
              .update(tableSchema)
              .set(this.withUpdatedAt(tableSchema, { isDeleted: true }) as never)
              .where(where)
              .returning()
          : await this.db.delete(tableSchema).where(where).returning();
      return result.length > 0
        ? { status: 200, data: { rowsAffected: result.length } }
        : { status: 404, error: "Record not found", error_reason: ErrorReason.NOT_FOUND };
    } catch (error: unknown) {
      return this.handleDatabaseError(error, "delete", table);
    }
  }

  /** Counts matching rows (soft-delete default applied). */
  async count(conditions: Conditions, table: Table): Promise<ApiResponse<{ count: number }>> {
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, this.applyDefaultConditions(table, conditions));
    try {
      const result = await this.db.select({ count: count() }).from(tableSchema).where(where);
      return { status: 200, data: { count: result[0]?.count ?? 0 } };
    } catch (error: unknown) {
      return this.handleDatabaseError(error, "count", table);
    }
  }

  /** True when a (non-deleted) row has `keyName = keyValue`. Throws on DB errors. */
  async checkDuplicates(keyName: string, keyValue: string | number | boolean | Date, table: Table): Promise<boolean> {
    return (await this.select({ [keyName]: keyValue }, table, true)).length > 0;
  }

  /** First matching row (ordered by id) hydrated into ModelClass, or null. Throws QueryHandlerError on DB errors. */
  async validateAndSelect<T extends object>(
    ModelClass: new () => T,
    query: Conditions,
    table: Table
  ): Promise<T | null> {
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, this.applyDefaultConditions(table, query));
    const orderBy = this.buildOrderBy(tableSchema, table, undefined);
    try {
      const rows = (await this.db
        .select()
        .from(tableSchema)
        .where(where)
        .orderBy(...orderBy)
        .limit(1)) as Record<string, unknown>[];
      const row = rows[0];
      return row ? ModelHandler.hydrate(ModelClass, row) : null;
    } catch (error: unknown) {
      throw this.wrap(error, "validateAndSelect", table);
    }
  }

  /** Matching rows hydrated into ModelClass, ordered (default id asc), optionally limited. Throws on DB errors. */
  async selectMany<T extends object>(
    ModelClass: new () => T,
    conditions: Conditions,
    table: Table,
    options: SelectManyOptions = {}
  ): Promise<T[]> {
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, this.applyDefaultConditions(table, conditions));
    const searchParts = this.buildSearch(tableSchema, table, options.search);
    const fullWhere = searchParts.length > 0 ? and(...(where ? [where] : []), ...searchParts) : where;
    const orderBy = this.buildOrderBy(tableSchema, table, options.orderBy);
    try {
      const base = this.db
        .select()
        .from(tableSchema)
        .where(fullWhere)
        .orderBy(...orderBy)
        .$dynamic();
      const limited = options.limit === undefined ? base : base.limit(options.limit);
      const rows = (await limited.offset(options.offset ?? 0)) as Record<string, unknown>[];
      return rows.map((row) => ModelHandler.hydrate(ModelClass, row));
    } catch (error: unknown) {
      throw this.wrap(error, "selectMany", table);
    }
  }

  /**
   * Builds the WHERE predicate. Public for unit tests (rendered with PgDialect.sqlToQuery).
   *
   * @throws QueryHandlerError for a key that is not a column property of the table.
   */
  buildWhere(tableSchema: PgTable, table: Table, conditions: Conditions): SQL | undefined {
    const columns = getTableColumns(tableSchema) as Record<string, Column>;
    const parts: SQL[] = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value === undefined) {
        continue;
      }
      const column = Object.prototype.hasOwnProperty.call(columns, key) ? columns[key] : undefined;
      if (!column) {
        throw new QueryHandlerError(`Unknown column "${key}"`, "where", table);
      }
      parts.push(this.toPredicate(column, value));
    }
    return parts.length > 0 ? and(...parts) : undefined;
  }

  private toPredicate(column: Column, value: NonNullable<Conditions[string]> | null): SQL {
    if (value === null) {
      return isNull(column);
    }
    if (!isWhereOperator(value)) {
      return eq(column, value);
    }
    switch (value.op) {
      case "ne":
        return ne(column, value.value);
      case "gt":
        return gt(column, value.value);
      case "gte":
        return gte(column, value.value);
      case "lt":
        return lt(column, value.value);
      case "lte":
        return lte(column, value.value);
      case "in":
        return value.values.length === 0 ? sql`false` : inArray(column, [...value.values]);
      case "notIn":
        return value.values.length === 0 ? sql`true` : notInArray(column, [...value.values]);
      case "isNull":
        return isNull(column);
      case "isNotNull":
        return isNotNull(column);
    }
  }

  private buildSearch(tableSchema: PgTable, table: Table, search: Record<string, string> | undefined): SQL[] {
    if (!search) {
      return [];
    }
    const columns = getTableColumns(tableSchema) as Record<string, Column>;
    const parts: SQL[] = [];
    for (const [key, term] of Object.entries(search)) {
      const column = Object.prototype.hasOwnProperty.call(columns, key) ? columns[key] : undefined;
      if (!column) {
        throw new QueryHandlerError(`Unknown column "${key}"`, "search", table);
      }
      if (term !== "") {
        parts.push(ilike(column, `%${escapeLike(term)}%`));
      }
    }
    return parts;
  }

  private applyDefaultConditions(table: Table, conditions: Conditions): Conditions {
    if (!supportsSoftDelete(table) || Object.prototype.hasOwnProperty.call(conditions, "isDeleted")) {
      return conditions;
    }
    return { isDeleted: false, ...conditions };
  }

  private prepareValues(
    tableSchema: PgTable,
    table: Table,
    data: Record<string, unknown>,
    excludedKeys: readonly string[],
    operation: string
  ): Record<string, unknown> {
    const prepared = this.normalizeData(data, excludedKeys);
    for (const key of Object.keys(prepared)) {
      if (!tableHasColumn(tableSchema, key)) {
        throw new QueryHandlerError(`Unknown column "${key}"`, operation, table);
      }
    }
    return prepared;
  }

  private withUpdatedAt(tableSchema: PgTable, values: Record<string, unknown>): Record<string, unknown> {
    return tableHasColumn(tableSchema, "updatedAt") ? { ...values, updatedAt: new Date() } : values;
  }

  private buildOrderBy(tableSchema: PgTable, table: Table, orderBy: SelectManyOptions["orderBy"]): SQL[] {
    const columns = getTableColumns(tableSchema) as Record<string, Column>;
    const specs = orderBy && orderBy.length > 0 ? orderBy : [{ column: "id", direction: "asc" as const }];
    return specs.map((spec) => {
      const column = Object.prototype.hasOwnProperty.call(columns, spec.column) ? columns[spec.column] : undefined;
      if (!column) {
        throw new QueryHandlerError(`Unknown column "${spec.column}"`, "orderBy", table);
      }
      return spec.direction === "desc" ? desc(column) : asc(column);
    });
  }

  private wrap(error: unknown, operation: string, table: Table): QueryHandlerError {
    this.logDatabaseError(error, operation, table);
    return new QueryHandlerError(`Database ${operation} failed on ${table}`, operation, table, { cause: error });
  }

  private handleDatabaseError(error: unknown, operation: string, table: Table): ApiResponse<never> {
    this.logDatabaseError(error, operation, table);
    const dbError = findDatabaseError(error);
    switch (dbError?.code) {
      case "23505":
        return {
          status: 409,
          error: `Duplicate record (${dbError.constraint ?? "unique constraint"})`,
          error_reason: ErrorReason.CONFLICT
        };
      case "23503":
        return {
          status: 409,
          error: `Related record conflict (${dbError.constraint ?? "foreign key"})`,
          error_reason: ErrorReason.CONFLICT
        };
      case "23502":
      case "22001":
      case "22P02":
      case "22003":
        return { status: 400, error: "Invalid value for database column", error_reason: ErrorReason.VALIDATION_FAILED };
      default:
        // 23514 (CHECK violation) lands here on purpose: the service wrote an invalid enum/state.
        return { status: 500, error: "Internal server error", error_reason: ErrorReason.INTERNAL_ERROR };
    }
  }

  private logDatabaseError(error: unknown, operation: string, table: Table): void {
    const dbError = findDatabaseError(error);
    log.error(
      {
        event: "db.query.failed",
        table,
        operation,
        pgCode: dbError?.code ?? null,
        constraint: dbError?.constraint ?? null,
        detail: dbError?.detail ?? null,
        err: dbError ? undefined : error
      },
      "Database operation failed"
    );
  }
}

/** Walks `error.cause` up to 3 levels: drizzle wraps pg errors in DrizzleQueryError. */
function findDatabaseError(error: unknown): DatabaseError | null {
  let current: unknown = error;
  for (let depth = 0; depth <= 3 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof DatabaseError) {
      return current;
    }
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return null;
}

/** Escapes LIKE wildcards so a search term matches literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}
