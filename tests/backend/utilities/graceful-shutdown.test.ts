import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  closeHttpServer,
  describeBootError,
  installGracefulShutdown,
  type ShutdownStep
} from "../../../backend/src/utilities/helpers/graceful-shutdown";
import http from "node:http";

class FakeProcess extends EventEmitter {
  readonly exits: number[] = [];
  exit(code: number): never {
    this.exits.push(code);
    return undefined as never;
  }
}

function install(steps: ShutdownStep[], timeoutMs = 5_000) {
  const proc = new FakeProcess();
  const controller = installGracefulShutdown(steps, {
    role: "api",
    timeoutMs,
    processLike: proc as unknown as Pick<NodeJS.Process, "on" | "exit">
  });
  return { proc, controller };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail("condition not met in time");
    }
    await delay(10);
  }
}

test("installGracefulShutdown runs steps in order and exits 0", async () => {
  const order: string[] = [];
  const step = (name: string): ShutdownStep => ({
    name,
    close: async () => {
      await delay(5);
      order.push(name);
    }
  });
  const { proc, controller } = install([step("http server"), step("queues"), step("redis"), step("postgres")]);
  await controller.shutdown(0, "SIGTERM");
  assert.deepEqual(order, ["http server", "queues", "redis", "postgres"]);
  assert.deepEqual(proc.exits, [0]);
  await controller.shutdown(0, "again"); // idempotent
  assert.deepEqual(proc.exits, [0]);
});

test("installGracefulShutdown: a failing step logs and exits 1 after running the rest", async () => {
  const ran: string[] = [];
  const { proc, controller } = install([
    { name: "a", close: () => Promise.reject(new Error("boom")) },
    {
      name: "b",
      close: () => {
        ran.push("b");
        return Promise.resolve();
      }
    }
  ]);
  await controller.shutdown(0, "SIGINT");
  assert.deepEqual(ran, ["b"]);
  assert.deepEqual(proc.exits, [1]);
});

test("installGracefulShutdown: SIGINT starts the shutdown and a second signal forces exit 1", async () => {
  let release: () => void = () => undefined;
  const { proc } = install([
    {
      name: "slow",
      close: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    }
  ]);
  proc.emit("SIGINT", "SIGINT");
  await delay(10);
  assert.deepEqual(proc.exits, []);
  proc.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(proc.exits, [1]);
  release();
  await delay(20);
  assert.deepEqual(proc.exits, [1], "exit happens once");
});

test("installGracefulShutdown: the timeout forces exit 1", async () => {
  const { proc, controller } = install([{ name: "hang", close: () => new Promise<void>(() => undefined) }], 100);
  void controller.shutdown(0, "SIGTERM").catch(() => undefined);
  await waitFor(() => proc.exits.length > 0);
  assert.deepEqual(proc.exits, [1]);
});

test("installGracefulShutdown: unhandledRejection triggers shutdown(1)", async () => {
  const closed: string[] = [];
  const { proc } = install([
    {
      name: "postgres",
      close: () => {
        closed.push("postgres");
        return Promise.resolve();
      }
    }
  ]);
  proc.emit("unhandledRejection", new Error("crash"));
  await waitFor(() => proc.exits.length > 0);
  assert.deepEqual(closed, ["postgres"]);
  assert.deepEqual(proc.exits, [1]);
});

test("closeHttpServer resolves for a listening server and for one that never started", async () => {
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await closeHttpServer(server, 100);
  assert.equal(server.listening, false);
  await closeHttpServer(http.createServer(), 100);
});

test("describeBootError maps known boot failures to hints without reading the message", () => {
  assert.match(
    describeBootError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" })).hint ??
      "",
    /npm run infra:up/
  );
  assert.match(
    describeBootError(new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })])).hint ?? "",
    /infra:up/
  );
  assert.match(
    describeBootError(Object.assign(new Error("listen"), { code: "EADDRINUSE", port: 3100 })).hint ?? "",
    /Port 3100 in use/
  );
  assert.equal(
    describeBootError(
      Object.assign(new Error("x"), { name: "DatabaseNotReadyError", hint: "Run `npm run db:migrate`." })
    ).hint,
    "Run `npm run db:migrate`."
  );
  assert.match(
    describeBootError(Object.assign(new Error("x"), { name: "ConfigValidationError" })).hint ?? "",
    /setup:env/
  );
  assert.equal(describeBootError(new Error("postgres://user:pw@host")).hint, null);
  assert.equal(describeBootError("string").hint, null);
});
