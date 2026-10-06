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
  constructor(
    message: string,
    readonly hint: string
  ) {
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
      "select count(*)::int as applied from drizzle.__drizzle_migrations"
    );
    const appliedCount = applied.rows[0]?.applied ?? 0;
    if (appliedCount < expected) {
      throw new DatabaseNotReadyError(
        `${expected - appliedCount} database migration(s) are not applied`,
        "Run `npm run db:migrate`."
      );
    }
    const result = await pool.query<{ id: number }>("select id from app_settings where id = 1");
    if (result.rowCount !== 1) {
      throw new DatabaseNotReadyError(
        "app_settings singleton row is missing",
        "Run `npm run db:migrate` on a fresh database, or restart the API (05 re-seeds the row on read)."
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
