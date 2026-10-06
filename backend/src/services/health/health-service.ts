import { setTimeout as delay } from "node:timers/promises";
import { APP_VERSION, HEALTH_CHECK_TIMEOUT_MS } from "../../config-consts";
import type { HealthView } from "../../dtos";
import { DbPool, RedisPool, createLogger, type ApiResponse } from "../../utilities";

const log = createLogger("health");

/**
 * GET /api/health: probes Postgres and Redis concurrently, each bounded by HEALTH_CHECK_TIMEOUT_MS. Always
 * HTTP 200; probe failures are logged and only flip the matching flag (00 §14.4).
 */
export class HealthService {
  /** Runs both probes and builds the HealthView. Never rejects. */
  async check(): Promise<ApiResponse<HealthView>> {
    const [database, redis] = await Promise.all([
      this.probe("database", () => DbPool.ping()),
      this.probe("redis", () => RedisPool.ping())
    ]);
    const data: HealthView = {
      status: database && redis ? "ok" : "degraded",
      database,
      redis,
      version: APP_VERSION
    };
    return { status: 200, data };
  }

  private async probe(name: "database" | "redis", run: () => Promise<number>): Promise<boolean> {
    const timeoutController = new AbortController();
    const timedOut = (async (): Promise<never> => {
      // ref: false — the timer never keeps the process alive.
      await delay(HEALTH_CHECK_TIMEOUT_MS, undefined, { signal: timeoutController.signal, ref: false });
      throw new Error(`${name} probe timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms`);
    })();
    // Settles with an AbortError when the probe wins first; that outcome is expected and ignored.
    timedOut.catch(() => undefined);
    try {
      await Promise.race([run(), timedOut]);
      return true;
    } catch (error: unknown) {
      log.warn({ event: "health.probe.failed", probe: name, err: error }, "Health probe failed");
      return false;
    } finally {
      timeoutController.abort();
    }
  }
}
