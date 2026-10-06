/**
 * Applies drizzle-kit migrations from src/database/migrations to DATABASE_URL (03 §8.3).
 * Adapted from Uply-v2 backend/scripts/drizzle-migrate.ts as committed (plain migrate()): PRVision has no pg
 * enums (text + CHECK), so all pending migrations run in one transaction. Exits 0 without connecting when no
 * migrations exist.
 */
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { DATABASE_URL } from "../src/config-consts";
import { MIGRATIONS_FOLDER } from "../src/database/schema-readiness";

function hasMigrations(): boolean {
  const journalPath = path.join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return false;
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries?: unknown };
  return Array.isArray(journal.entries) && journal.entries.length > 0;
}

async function main(): Promise<void> {
  if (!hasMigrations()) {
    console.log("No migrations found in src/database/migrations; nothing to apply.");
    return;
  }
  if (DATABASE_URL === "") {
    throw new Error("DATABASE_URL is not set (run npm run setup:env)");
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, options: "-c timezone=UTC" });
  try {
    // One transaction for all pending migrations (drizzle's node-postgres migrator): all-or-nothing.
    await migrate(drizzle(pool), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsTable: "__drizzle_migrations",
      migrationsSchema: "drizzle"
    });
    console.log("Drizzle migrations applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Print the message and pg code only: a pg error object can echo connection parameters.
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  console.error(
    `Drizzle migration failed${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
