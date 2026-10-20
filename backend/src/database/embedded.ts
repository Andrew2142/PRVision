import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import { MIGRATIONS_FOLDER } from "./schema-readiness";

/** An in-process Postgres (PGlite) with the full schema migrated; used by headless runs instead of a server. */
export interface EmbeddedDatabase {
  db: ReturnType<typeof drizzle<typeof schema>>;
  close(): Promise<void>;
}

/**
 * Opens PGlite in memory (or in `dataDir` to keep it between processes) and applies every migration. The same
 * SQL migrations as the Postgres server run unchanged, so all queries and persistence code work as they are.
 */
export async function openEmbeddedDatabase(dataDir?: string): Promise<EmbeddedDatabase> {
  const client = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    close: () => client.close()
  };
}
