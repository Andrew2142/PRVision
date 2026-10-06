import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../database/schema";
import { DbPool } from "./db-pool";

/** The application's typed Drizzle database (schema-aware). */
export type Database = NodePgDatabase<typeof schema>;
/** The `tx` handle passed to `DrizzleDb.transaction(async (tx) => ...)`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything queries can run on: the shared database or an open transaction. */
export type DbExecutor = Database | Transaction;

/** Singleton Drizzle instance bound to the shared pg pool. */
export class DrizzleDb {
  private static instance: Database | null = null;

  /** Returns the shared Drizzle database, creating it on first use. */
  static getInstance(): Database {
    DrizzleDb.instance ??= drizzle(DbPool.getInstance(), { schema });
    return DrizzleDb.instance;
  }

  /**
   * Runs fn in a transaction. Use `new QueryHandler(tx)` inside for CRUD, and turn every non-200 ApiResponse
   * into a throw (04 §9.2): a normal return commits.
   */
  static async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return DrizzleDb.getInstance().transaction(fn);
  }

  /** Test hook: forget the cached instance (after DbPool.close()). */
  static reset(): void {
    DrizzleDb.instance = null;
  }
}
