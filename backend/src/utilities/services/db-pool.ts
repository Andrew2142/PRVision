import type { Pool } from "pg";
import { closePgPool, getPgPool } from "../../database/connection";
import { createLogger } from "../loggers/logger";

const log = createLogger("db");

/**
 * Exposes the shared PostgreSQL pool (03 connection.ts) with the idle-client error listener, a ping and close.
 */
export class DbPool {
  private static listenerPool: Pool | null = null;

  /** Shared pg Pool with an idle-error listener attached once per pool instance. */
  static getInstance(): Pool {
    const pool = getPgPool();
    if (DbPool.listenerPool !== pool) {
      pool.on("error", (error) => {
        log.error({ event: "db.pool.error", err: error }, "Idle Postgres client error");
      });
      DbPool.listenerPool = pool;
    }
    return pool;
  }

  /**
   * Runs `select 1`.
   *
   * @returns Latency in ms.
   * @throws The pg error when Postgres is unreachable.
   */
  static async ping(): Promise<number> {
    const startedAt = process.hrtime.bigint();
    await DbPool.getInstance().query("select 1");
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  }

  /** Ends the pool. No-op when it was never created. */
  static async close(): Promise<void> {
    DbPool.listenerPool = null;
    await closePgPool();
  }
}
