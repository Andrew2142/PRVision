import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Response } from "express";
import { APP_VERSION, HEALTH_CHECK_TIMEOUT_MS } from "../../../backend/src/config-consts";
import { HealthController } from "../../../backend/src/controllers/health-controller";
import { HealthService } from "../../../backend/src/services/health/health-service";
import { DbPool } from "../../../backend/src/utilities/services/db-pool";
import { RedisPool } from "../../../backend/src/utilities/services/redis-pool";
import { patchStaticMethod } from "../helpers/test-context";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
});

function probes(database: () => Promise<number>, redis: () => Promise<number>): void {
  restores.push(patchStaticMethod(DbPool, "ping", database), patchStaticMethod(RedisPool, "ping", redis));
}

test("HealthService.check with both probes ok → { status: ok, database: true, redis: true, version: APP_VERSION }", async () => {
  probes(
    () => Promise.resolve(1),
    () => Promise.resolve(1)
  );
  const response = await new HealthService().check();
  assert.deepEqual(response, {
    status: 200,
    data: { status: "ok", database: true, redis: true, version: APP_VERSION }
  });
});

test("HealthService.check with one failure → degraded with that flag false", async () => {
  probes(
    () => Promise.resolve(1),
    () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6380"))
  );
  assert.deepEqual((await new HealthService().check()).data, {
    status: "degraded",
    database: true,
    redis: false,
    version: APP_VERSION
  });
});

test("HealthService.check marks a slow probe false after HEALTH_CHECK_TIMEOUT_MS", async () => {
  probes(
    () => new Promise<number>(() => undefined),
    () => Promise.resolve(1)
  );
  const startedAt = Date.now();
  const response = await new HealthService().check();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= HEALTH_CHECK_TIMEOUT_MS - 50 && elapsed < HEALTH_CHECK_TIMEOUT_MS + 1_500, `${elapsed} ms`);
  assert.equal(response.data?.database, false);
  assert.equal(response.data.redis, true);
  assert.equal(response.data.status, "degraded");
});

test("HealthController.get always answers HTTP 200, with exactly the four HealthView keys", async () => {
  probes(
    () => Promise.reject(new Error("down")),
    () => Promise.reject(new Error("down"))
  );
  const sent: { status: number | null; body: unknown } = { status: null, body: undefined };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    }
  } as unknown as Response;
  await new HealthController().get({} as never, res);
  assert.equal(sent.status, 200);
  const body = sent.body as { status: number; data: Record<string, unknown> };
  assert.equal(body.status, 200);
  assert.deepEqual(Object.keys(body.data).sort(), ["database", "redis", "status", "version"]);
  assert.equal(body.data.status, "degraded");
});
