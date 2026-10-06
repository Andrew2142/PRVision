import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  AngularHostClient,
  angularChildExecArgv,
  buildAngularChildEnv,
  type AngularBuildRequest
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-host-client";
import { makeTempDir } from "../../helpers/temp-dir";

/**
 * Fake Angular host child (no Angular): speaks the IPC protocol. Its behaviour is read from `behaviour.txt` in its
 * cwd at every message, and it records its environment in `env.json`.
 */
const FAKE_CHILD = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const cwd = process.cwd();
const behaviour = () => fs.readFileSync(path.join(cwd, "behaviour.txt"), "utf8").trim();
fs.writeFileSync(path.join(cwd, "env.json"), JSON.stringify(process.env));
fs.appendFileSync(path.join(cwd, "starts.txt"), String(process.pid) + "\n");
const mode = behaviour();
if (mode === "fatal") {
  process.send({ type: "fatal", message: "@angular-devkit/architect (Cannot find module)" });
  setTimeout(() => process.exit(1), 50);
} else if (mode === "hang-start") {
  setInterval(() => {}, 1000);
} else {
  process.send({ type: "ready", versions: { core: "21.2.0", build: "21.2.0", architect: "0.2102.0" } });
}
process.on("message", (msg) => {
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "build") return;
  const now = behaviour();
  if (now === "die-once" && !fs.existsSync(path.join(cwd, "died"))) {
    fs.writeFileSync(path.join(cwd, "died"), "1");
    process.exit(3);
  }
  if (now === "hang-build") {
    const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
    fs.writeFileSync(path.join(cwd, "grandchild.pid"), String(grandchild.pid));
    return;
  }
  process.send({ type: "log", buildId: msg.buildId, level: "info", message: "Building " + msg.projectName });
  process.send({ type: "log", buildId: "other#9", level: "error", message: "not this build" });
  if (now === "fail") {
    process.send({ type: "log", buildId: msg.buildId, level: "error", message: "✘ [ERROR] NG8001: 'x' is not a known element" });
    process.send({ type: "result", buildId: msg.buildId, success: false, durationMs: 5, outputDir: null });
    return;
  }
  process.send({ type: "result", buildId: msg.buildId, success: true, durationMs: 5, outputDir: path.join(cwd, "dist", "out") });
});
process.on("disconnect", () => process.exit(0));
`;

const REQUEST: AngularBuildRequest = {
  buildKey: "none",
  projectName: "app",
  builderName: "@angular/build:application",
  options: { browser: ".prvision-harness/main.ts" },
  projectExtensions: {}
};

interface Fixture {
  dir: string;
  client: AngularHostClient;
  setBehaviour(mode: string): void;
  starts(): number[];
}

function setup(t: TestContext, mode: string): Fixture {
  const temp = makeTempDir("angular-host");
  const dir = temp.path;
  const entry = path.join(dir, "fake-host.cjs");
  fs.writeFileSync(entry, FAKE_CHILD);
  fs.writeFileSync(path.join(dir, "behaviour.txt"), mode);
  const client = new AngularHostClient("head", dir, {
    entryPath: entry,
    startTimeoutMs: 1_500,
    buildTimeoutMs: 1_500,
    stopTimeoutMs: 300
  });
  t.after(async () => {
    await client.stop();
    temp.cleanup();
  });
  return {
    dir,
    client,
    setBehaviour: (next) => {
      fs.writeFileSync(path.join(dir, "behaviour.txt"), next);
    },
    starts: () =>
      fs.existsSync(path.join(dir, "starts.txt"))
        ? fs.readFileSync(path.join(dir, "starts.txt"), "utf8").trim().split("\n").map(Number)
        : []
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      return true;
    }
    await delay(50);
  }
  return !isRunning(pid);
}

test("buildAngularChildEnv is the allow-listed base plus fixed values (never CI, secrets or connection URLs)", () => {
  const env = buildAngularChildEnv({ PATH: "/usr/bin", HOME: "/home/u", CI: "true" }, false);
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/u",
    NG_CLI_ANALYTICS: "false",
    NG_FORCE_TTY: "false",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NODE_OPTIONS: "--max-old-space-size=4096"
  });
  const tsEnv = buildAngularChildEnv({}, true);
  assert.equal(tsEnv.TS_NODE_TRANSPILE_ONLY, "true");
  assert.ok(tsEnv.TS_NODE_PROJECT?.endsWith(path.join("backend", "tsconfig.json")));
  assert.deepEqual(angularChildExecArgv("/x/host.js"), ["--max-old-space-size=4096"]);
  const tsArgs = angularChildExecArgv("/x/host.ts");
  assert.equal(tsArgs[1], "-r");
  assert.ok(path.isAbsolute(tsArgs[2] ?? ""));
});

test("AngularHostClient.build starts the child lazily, forwards only this build's logs and returns the output dir", async (t) => {
  const f = setup(t, "ready");
  assert.equal(f.client.versions(), null);
  const outcome = await f.client.build(REQUEST, new AbortController().signal);
  assert.ok(outcome.status === "success");
  assert.equal(outcome.outputDir, path.join(f.dir, "dist", "out"));
  assert.deepEqual(outcome.logs, [{ level: "info", message: "Building app" }]);
  assert.deepEqual(f.client.versions(), { core: "21.2.0", build: "21.2.0", architect: "0.2102.0" });
  const second = await f.client.build({ ...REQUEST, buildKey: "none-x2" }, new AbortController().signal);
  assert.equal(second.status, "success");
  assert.equal(f.starts().length, 1, "builds reuse the same child");
  const env = JSON.parse(fs.readFileSync(path.join(f.dir, "env.json"), "utf8")) as Record<string, string>;
  for (const secret of ["DATABASE_URL", "REDIS_URL", "PRVISION_SECRET_KEY", "PRVISION_DATA_DIR", "CI"]) {
    assert.ok(!(secret in env), secret);
  }
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.NG_CLI_ANALYTICS, "false");
  assert.match(env.NODE_OPTIONS ?? "", /^--max-old-space-size=4096$/);
});

test("AngularHostClient.build reports compile failures as failed with the builder logs", async (t) => {
  const f = setup(t, "fail");
  const outcome = await f.client.build(REQUEST, new AbortController().signal);
  assert.equal(outcome.status, "failed");
  assert.ok(outcome.logs.some((entry) => entry.level === "error" && entry.message.includes("NG8001")));
});

test("AngularHostClient: a fatal child is sticky unavailable and is not restarted", async (t) => {
  const f = setup(t, "fatal");
  const first = await f.client.build(REQUEST, new AbortController().signal);
  assert.ok(first.status === "unavailable");
  assert.equal(first.sticky, true);
  assert.match(first.message, /@angular-devkit\/architect/);
  const second = await f.client.build(REQUEST, new AbortController().signal);
  assert.equal(second.status, "unavailable");
  assert.equal(f.starts().length, 1);
  assert.equal(AngularHostClient.liveCount(), 0);
});

test("AngularHostClient: start timeout kills the child (not sticky)", async (t) => {
  const f = setup(t, "hang-start");
  const outcome = await f.client.build(REQUEST, new AbortController().signal);
  assert.ok(outcome.status === "unavailable");
  assert.equal(outcome.sticky, false);
  assert.match(outcome.message, /did not start within 2 s|did not start within 1 s/);
  const pid = f.starts()[0] ?? 0;
  assert.ok(await waitUntilGone(pid));
});

test("AngularHostClient: build timeout kills the whole process group (grandchildren included)", async (t) => {
  const f = setup(t, "hang-build");
  const outcome = await f.client.build(REQUEST, new AbortController().signal);
  assert.ok(outcome.status === "timeout");
  assert.match(outcome.message, /did not finish within/);
  const grandchild = Number(fs.readFileSync(path.join(f.dir, "grandchild.pid"), "utf8"));
  assert.ok(await waitUntilGone(grandchild), "grandchild killed with the group");
  assert.ok(await waitUntilGone(f.starts()[0] ?? 0));
  assert.equal(AngularHostClient.liveCount(), 0);
});

test("AngularHostClient: a child that dies mid-build is unavailable and the next build starts a new child", async (t) => {
  const f = setup(t, "die-once");
  const first = await f.client.build(REQUEST, new AbortController().signal);
  assert.ok(first.status === "unavailable");
  assert.match(first.message, /^The Angular build process exited \(exit code 3/);
  const second = await f.client.build(REQUEST, new AbortController().signal);
  assert.equal(second.status, "success");
  assert.equal(f.starts().length, 2);
});

test("AngularHostClient: cancellation mid-build kills the group; stop() is idempotent and leaves nothing running", async (t) => {
  const f = setup(t, "hang-build");
  const controller = new AbortController();
  const pending = f.client.build(REQUEST, controller.signal);
  await delay(400);
  controller.abort("cancelled");
  const outcome = await pending;
  assert.equal(outcome.status, "cancelled");
  const grandchild = Number(fs.readFileSync(path.join(f.dir, "grandchild.pid"), "utf8"));
  assert.ok(await waitUntilGone(grandchild));
  const aborted = new AbortController();
  aborted.abort("cancelled");
  assert.equal((await f.client.build(REQUEST, aborted.signal)).status, "cancelled");
  await f.client.stop();
  await f.client.stop();
  assert.equal(AngularHostClient.liveCount(), 0);
  assert.equal((await f.client.build(REQUEST, new AbortController().signal)).status, "cancelled");
});

test("AngularHostClient.stop shuts a ready child down", async (t) => {
  const f = setup(t, "ready");
  assert.equal((await f.client.build(REQUEST, new AbortController().signal)).status, "success");
  const pid = f.client.pid() ?? 0;
  assert.ok(isRunning(pid));
  await f.client.stop();
  assert.ok(await waitUntilGone(pid));
  assert.equal(AngularHostClient.liveCount(), 0);
});
