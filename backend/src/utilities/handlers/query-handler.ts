import type { DeletionMode, Table } from "../../enums";
import type { DbExecutor } from "../services/drizzle-db";
import type { Conditions, ScalarValue, SelectManyOptions } from "./query-conditions";
import { QueryHandlerDrizzle } from "./query-handler-drizzle";
import type { ApiResponse } from "./response-handler";

/**
 * The project's database access facade (guidelines §5): services depend on this contract rather than on Drizzle.
 * Methods returning ApiResponse never throw for DB errors; methods returning rows/models throw QueryHandlerError.
 */
export class QueryHandler {
  private readonly drizzleHandler: QueryHandlerDrizzle;

  /**
   * @param db - Optional executor for every call on this handler. Pass the `tx` of
   *   `DrizzleDb.transaction(async (tx) => { const qh = new QueryHandler(tx); ... })` to make several writes atomic.
   */
  constructor(db?: DbExecutor) {
    this.drizzleHandler = new QueryHandlerDrizzle(db);
  }

  /**
   * Normalizes a model instance or plain object into a persistence-safe payload without a handler instance
   * (and without touching the database).
   */
  static normalizeData(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    return QueryHandlerDrizzle.normalize(data, excludedKeys);
  }

  /** First inserted row id of an insert response, or null. */
  static firstInsertedId(response: ApiResponse<Record<string, unknown>[]>): number | null {
    const id = response.data?.[0]?.id;
    return typeof id === "number" ? id : null;
  }

  /** Instance form of QueryHandler.normalizeData. */
  normalizeData(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    return QueryHandler.normalizeData(data, excludedKeys);
  }

  /**
   * Inserts one or more rows and returns them.
   *
   * @throws QueryHandlerError for a key that is not a column of the table.
   */
  async insert(
    data: Record<string, unknown> | Record<string, unknown>[],
    table: Table,
    excludedKeys: readonly string[] = []
  ): Promise<ApiResponse<Record<string, unknown>[]>> {
    return this.drizzleHandler.insert(data, table, excludedKeys);
  }

  /**
   * Selects rows matching `conditions` (soft-deleted rows excluded unless `isDeleted` is given).
   * `isolateData: true` returns the rows and throws QueryHandlerError on a DB failure.
   */
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
    return isolateData
      ? this.drizzleHandler.select(conditions, table, true)
      : this.drizzleHandler.select(conditions, table, false);
  }

  /** Updates rows matching `conditions`; 400 without conditions, 404 when nothing matched. */
  async update(
    newValues: Record<string, unknown>,
    conditions: Conditions,
    table: Table,
    excludedKeys: readonly string[] = []
  ): Promise<ApiResponse<{ rowsAffected: number }>> {
    return this.drizzleHandler.update(newValues, conditions, table, excludedKeys);
  }

  /**
   * Soft- or hard-deletes rows matching `conditions`; 400 without conditions, 404 when nothing matched.
   *
   * @throws QueryHandlerError for DeletionMode.SOFT on a table without isDeleted.
   */
  async delete(
    conditions: Conditions,
    table: Table,
    mode: DeletionMode
  ): Promise<ApiResponse<{ rowsAffected: number }>> {
    return this.drizzleHandler.delete(conditions, table, mode);
  }

  /** Counts rows matching `conditions`. */
  async count(conditions: Conditions, table: Table): Promise<ApiResponse<{ count: number }>> {
    return this.drizzleHandler.count(conditions, table);
  }

  /** True when a row with `keyName = keyValue` exists. */
  async checkDuplicates(keyName: string, keyValue: ScalarValue, table: Table): Promise<boolean> {
    return this.drizzleHandler.checkDuplicates(keyName, keyValue, table);
  }

  /** First matching row (by id) hydrated into Model, or null. Throws QueryHandlerError on DB errors. */
  async validateAndSelect<T extends object>(Model: new () => T, query: Conditions, table: Table): Promise<T | null> {
    return this.drizzleHandler.validateAndSelect(Model, query, table);
  }

  /** Matching rows hydrated into Model (ordering, limit, offset, search in options). Throws on DB errors. */
  async selectMany<T extends object>(
    Model: new () => T,
    conditions: Conditions,
    table: Table,
    options?: SelectManyOptions
  ): Promise<T[]> {
    return this.drizzleHandler.selectMany(Model, conditions, table, options);
  }
}
