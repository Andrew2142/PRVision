import { Redis, type RedisOptions } from "ioredis";
import { REDIS_URL } from "../../config-consts";
import { createLogger } from "../loggers/logger";

const log = createLogger("redis");

const CONNECT_TIMEOUT_MS = 5_000;
const ERROR_LOG_INTERVAL_MS = 10_000;

/**
 * Turns a redis:// or rediss:// URL into ioredis options.
 *
 * @param url - REDIS_URL.
 */
export function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isInteger(db) ? db : 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined
  };
}

/**
 * The shared Redis command connection (cancel flags, health ping) plus the connection-option profiles BullMQ
 * uses for its own connections (04 §9.3).
 */
export class RedisPool {
  private static connection: Redis | null = null;
  private static lastErrorLogAt = 0;

  /** BullMQ Queue (producer): fail fast while Redis is down. */
  static getQueueConnectionOptions(): RedisOptions {
    return { ...RedisPool.baseOptions(), maxRetriesPerRequest: 1 };
  }

  /** BullMQ Worker: `maxRetriesPerRequest: null` is required for the blocking connection. */
  static getWorkerConnectionOptions(): RedisOptions {
    return { ...RedisPool.baseOptions(), maxRetriesPerRequest: null };
  }

  /** The shared command connection, created lazily (not yet connected). */
  static getConnection(): Redis {
    if (!RedisPool.connection) {
      const connection = new Redis({
        ...RedisPool.baseOptions(),
        maxRetriesPerRequest: 1,
        enableOfflineQueue: true,
        lazyConnect: true
      });
      connection.on("ready", () => {
        log.info({ event: "redis.connection.ready" }, "Redis connected");
      });
      connection.on("error", (error: Error) => {
        // Rate-limited: ioredis emits one error per reconnect attempt while Docker is down.
        const now = Date.now();
        if (now - RedisPool.lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
          RedisPool.lastErrorLogAt = now;
          log.warn({ event: "redis.connection.error", message: error.message }, "Redis connection error");
        }
      });
      RedisPool.connection = connection;
    }
    return RedisPool.connection;
  }

  /** Connects the shared connection (when not yet connecting) and pings it. */
  static async connect(): Promise<void> {
    const connection = RedisPool.getConnection();
    if (connection.status === "wait") {
      await connection.connect();
    }
    await RedisPool.ping();
  }

  /**
   * PING on the shared connection.
   *
   * @returns Latency in ms.
   */
  static async ping(): Promise<number> {
    const startedAt = process.hrtime.bigint();
    await RedisPool.getConnection().ping();
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
  }

  /** QUIT (falls back to disconnect when QUIT rejects). No-op when no connection was ever created. */
  static async disconnect(): Promise<void> {
    const connection = RedisPool.connection;
    if (!connection) {
      return;
    }
    RedisPool.connection = null;
    if (connection.status === "wait" || connection.status === "end") {
      // Never connected (lazyConnect) or already closed: QUIT would open a connection first.
      connection.disconnect();
      return;
    }
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
  }

  private static baseOptions(): RedisOptions {
    return { ...parseRedisUrl(REDIS_URL), enableReadyCheck: true, connectTimeout: CONNECT_TIMEOUT_MS };
  }
}
