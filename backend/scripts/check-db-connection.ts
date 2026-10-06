/**
 * Prints the connected database, user and schema, the applied vs. committed migration counts and whether the
 * app_settings singleton row exists (03 §8.4). Adapted from Uply-v2 (DATABASE_URL instead of DB_*).
 * Exits 1 on any failure; never prints the connection string.
 */
import { DatabaseError, Pool } from "pg";
import { DATABASE_URL } from "../src/config-consts";
import { countJournalMigrations } from "../src/database/schema-readiness";

/** 42P01 undefined_table, 3F000 invalid_schema_name: nothing was migrated yet. */
function isNotMigratedError(error: unknown): boolean {
  return error instanceof DatabaseError && (error.code === "42P01" || error.code === "3F000");
}

async function countAppliedMigrations(pool: Pool): Promise<number> {
  try {
    const result = await pool.query<{ applied: number }>(
      "select count(*)::int as applied from drizzle.__drizzle_migrations"
    );
    return result.rows[0]?.applied ?? 0;
  } catch (error: unknown) {
    if (isNotMigratedError(error)) {
      return 0;
    }
    throw error;
  }
}

async function hasSettingsRow(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query("select id from app_settings where id = 1");
    return result.rowCount === 1;
  } catch (error: unknown) {
    if (isNotMigratedError(error)) {
      return false;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  if (DATABASE_URL === "") {
    throw new Error("DATABASE_URL is not set (run npm run setup:env)");
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: "-c timezone=UTC" });
  try {
    const identity = await pool.query<{ database_name: string; database_user: string; schema_name: string }>(
      "select current_database() as database_name, current_user as database_user, current_schema() as schema_name"
    );
    const appliedMigrations = await countAppliedMigrations(pool);
    const journalMigrations = await countJournalMigrations();
    const appSettingsRow = await hasSettingsRow(pool);
    console.log(JSON.stringify({ ...identity.rows[0], appliedMigrations, journalMigrations, appSettingsRow }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Print the message and pg code only: a pg error object can echo connection parameters.
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Database connection check failed${code ? ` (${code})` : ""}: ${message}`);
  process.exitCode = 1;
});
