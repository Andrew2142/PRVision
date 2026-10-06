import { Pool } from "pg";
import { DATABASE_URL, DB_POOL_MAX } from "../config-consts";

let pool: Pool | null = null;

/**
 * Server-side guards for every session: UTC timestamps; no statement may run longer than 30 s and no
 * transaction may sit idle for more than 60 s (a stuck worker can never hold row locks indefinitely).
 */
const SESSION_OPTIONS = "-c timezone=UTC -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000";

/** Returns the process-wide pg Pool, creating it on first use. */
export function getPgPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: DB_POOL_MAX,
      options: SESSION_OPTIONS,
      application_name: "prvision",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000
    });
  }
  return pool;
}

/** Ends the pool. Safe to call more than once. */
export async function closePgPool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}
