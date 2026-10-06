import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { CHILD_PROCESS_BASE_ENV } from "../../../backend/src/config-consts";
import type { ViteHostStartOptions } from "../../../backend/src/services/visualizations/pipeline/render/render-types";
import {
  ViteHostClient,
  ViteHostStartError,
  buildChildEnv,
  childExecArgv,
  hostEntryPath
} from "../../../backend/src/services/visualizations/pipeline/render/vite-host-client";
import { makeTempDir } from "../helpers/temp-dir";

const FIXED_KEYS = ["NODE_ENV", "BROWSER", "FORCE_COLOR", "NO_COLOR", "BROWSERSLIST_IGNORE_OLD_DATA"];

/** A few lines of Node that answer the IPC protocol and spawn a `sleep` grandchild (pid written to a file). */
const FAKE_HOST = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
let ignoreShutdown = false;
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "shutdown") {
    if (ignoreShutdown) return;
    process.exit(0);
  }
  if (message.type !== "start") return;
  const options = message.options;
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(path.join(options.worktreeDir, "grandchild.pid"), String(sleeper.pid));
  fs.writeFileSync(path.join(options.worktreeDir, "env.json"), JSON.stringify(process.env));
  if (options.groupKey === "hang") return;
  if (options.groupKey === "fail") {
    process.send({ type: "start_failed", kind: "config_error", message: "Loading vite.config.ts failed on the head side: boom", detail: null });
    return;
  }
  if (options.groupKey === "ignore-shutdown") {
    ignoreShutdown = true;
  }
  process.send({ type: "log", level: "warn", message: "hello from the fake host", at: Date.now() });
  process.send({ type: "ready", origin: "http://127.0.0.1:65000", viteVersion: "7.3.6", reactDomVersion: "19.3.0", tailwindMajor: 4, configFile: null, warnings: ["w1"] });
});
process.on("disconnect", () => process.exit(0));
`;

interface FakeHostSetup {
  dir: string;
  entry: string;
  options: (groupKey: string) => ViteHostStartOptions;
  grandchildPid: () => number | null;
}

function setup(t: TestContext): FakeHostSetup {
  const temp = makeTempDir("vite-host");
  t.after(() => {
    temp.cleanup();
  });
  const entry = path.join(temp.path, "fake-host.js");
  fs.writeFileSync(entry, FAKE_HOST);
  return {
    dir: temp.path,
    entry,
    options: (groupKey) => ({
      side: "head",
      groupKey,
      worktreeDir: temp.path,
      viteRoot: temp.path,
      harnessDir: path.join(temp.path, ".prvision-harness"),
      cacheDir: path.join(temp.path, ".prvision-harness", ".vite-cache"),
      configFile: null,
      optimizeEntries: [],
      warmupFiles: [],
      referencedEnvKeys: [],
      mocks: []
    }),
    grandchildPid: () => {
      const file = path.join(temp.path, "grandchild.pid");
      return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : null;
    }
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed process may linger as a zombie until its (new) parent reaps it.
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return !/\) Z /.test(stat);
  } catch {
    return process.platform !== "linux";
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await delay(25);
  }
  return condition();
}

test("buildChildEnv defaults its base to CHILD_PROCESS_BASE_ENV, adds only the fixed Vite values and never reads process.env", () => {
  const env = buildChildEnv();
  const expectedKeys = new Set([
    ...Object.keys(CHILD_PROCESS_BASE_ENV),
    ...FIXED_KEYS,
    "TS_NODE_TRANSPILE_ONLY",
    "TS_NODE_PROJECT"
  ]);
  assert.deepEqual(new Set(Object.keys(env)), expectedKeys);
  assert.equal(env.NODE_ENV, "development");
  assert.equal(env.BROWSER, "none");
  assert.equal(env.FORCE_COLOR, "0");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.TS_NODE_TRANSPILE_ONLY, "true");
  assert.equal(env.TS_NODE_PROJECT, path.resolve(__dirname, "../../../backend/tsconfig.json"));
  assert.deepEqual(buildChildEnv({ PATH: "/bin" }, false), {
    PATH: "/bin",
    NODE_ENV: "development",
    BROWSER: "none",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    BROWSERSLIST_IGNORE_OLD_DATA: "1"
  });
  const source = fs.readFileSync(
    path.join(__dirname, "../../../backend/src/services/visualizations/pipeline/render/vite-host-client.ts"),
    "utf8"
  );
  assert.doesNotMatch(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""), /process\.env/);
});

test("buildChildEnv drops DATABASE_URL, REDIS_URL, PRVISION_*, ANTHROPIC_* and NODE_OPTIONS", () => {
  assert.ok(process.env.DATABASE_URL, "the test preload sets DATABASE_URL");
  const env = buildChildEnv();
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /^(DATABASE_URL|REDIS_URL|NODE_OPTIONS|PRVISION_|ANTHROPIC_|GITHUB_|CLAUDE_)/);
  }
});

test("childExecArgv never copies process.execArgv and adds ts-node only for .ts entries", () => {
  assert.deepEqual(childExecArgv("/x/vite-host-process.js"), ["--max-old-space-size=2048"]);
  const tsArgs = childExecArgv("/x/vite-host-process.ts");
  assert.equal(tsArgs[0], "--max-old-space-size=2048");
  assert.equal(tsArgs[1], "-r");
  assert.ok(path.isAbsolute(tsArgs[2] ?? ""), "ts-node hook resolved to an absolute path");
  assert.match(tsArgs[2] ?? "", /ts-node[\\/]register[\\/]transpile-only\.js$/);
  for (const arg of process.execArgv) {
    if (arg !== "-r" && !arg.includes("ts-node")) {
      assert.ok(!tsArgs.includes(arg), `copied ${arg}`);
    }
  }
  assert.ok(hostEntryPath().endsWith(path.join("render", "vite-host-process.ts")));
});

test("start resolves on the ready message and reads the origin from it", async (t) => {
  const fake = setup(t);
  const handle = await ViteHostClient.start(
    fake.options("ready"),
    "/.prvision-harness/index.html",
    new AbortController().signal,
    {
      entryPath: fake.entry
    }
  );
  try {
    assert.equal(handle.origin, "http://127.0.0.1:65000");
    assert.equal(handle.viteVersion, "7.3.6");
    assert.equal(handle.tailwindMajor, 4);
    assert.deepEqual(handle.warnings, ["w1"]);
    assert.equal(handle.harnessUrlPath, "/.prvision-harness/index.html");
    assert.equal(handle.isAlive(), true);
    assert.ok(handle.logsSince(0, "warn").some((entry) => entry.message === "hello from the fake host"));
    const childEnv = JSON.parse(fs.readFileSync(path.join(fake.dir, "env.json"), "utf8")) as Record<string, string>;
    assert.equal(childEnv.DATABASE_URL, undefined);
    assert.equal(childEnv.PRVISION_SECRET_KEY, undefined);
    assert.equal(childEnv.NODE_ENV, "development");
  } finally {
    await handle.stop();
  }
});

test("start rejects with the child's start_failed kind and message", async (t) => {
  const fake = setup(t);
  await assert.rejects(
    ViteHostClient.start(fake.options("fail"), "/.prvision-harness/index.html", new AbortController().signal, {
      entryPath: fake.entry
    }),
    (error: unknown) => {
      assert.ok(error instanceof ViteHostStartError);
      assert.equal(error.kind, "config_error");
      assert.equal(error.sticky, true);
      assert.match(error.message, /Loading vite\.config\.ts failed on the head side: boom/);
      return true;
    }
  );
  assert.equal(ViteHostClient.liveCount(), 0);
});

test("start timeout kills the whole process group including grandchildren", async (t) => {
  const fake = setup(t);
  await assert.rejects(
    ViteHostClient.start(fake.options("hang"), "/.prvision-harness/index.html", new AbortController().signal, {
      entryPath: fake.entry,
      startTimeoutMs: 1_500
    }),
    (error: unknown) => {
      assert.ok(error instanceof ViteHostStartError);
      assert.equal(error.kind, "timeout");
      assert.equal(error.sticky, false);
      assert.match(error.message, /The Vite dev server for the head side did not become ready within 2 s\./);
      return true;
    }
  );
  const pid = fake.grandchildPid();
  assert.ok(pid !== null, "grandchild was spawned");
  assert.equal(await waitFor(() => !isRunning(pid), 3_000), true, "grandchild killed with the group");
  assert.equal(ViteHostClient.liveCount(), 0);
});

test("abort during start kills the process group and rejects with kind aborted", async (t) => {
  const fake = setup(t);
  const controller = new AbortController();
  const pending = ViteHostClient.start(fake.options("hang"), "/.prvision-harness/index.html", controller.signal, {
    entryPath: fake.entry,
    startTimeoutMs: 30_000
  });
  assert.equal(await waitFor(() => fake.grandchildPid() !== null, 5_000), true);
  controller.abort("cancelled");
  await assert.rejects(pending, (error: unknown) => error instanceof ViteHostStartError && error.kind === "aborted");
  const pid = fake.grandchildPid();
  assert.ok(pid !== null);
  assert.equal(await waitFor(() => !isRunning(pid), 3_000), true);
  await assert.rejects(
    ViteHostClient.start(fake.options("ready"), "/x", controller.signal, { entryPath: fake.entry }),
    (error: unknown) => error instanceof ViteHostStartError && error.kind === "aborted"
  );
});

test("stop sends shutdown, then SIGKILLs the group after VITE_STOP_TIMEOUT_MS", async (t) => {
  const fake = setup(t);
  const handle = await ViteHostClient.start(fake.options("ignore-shutdown"), "/x", new AbortController().signal, {
    entryPath: fake.entry,
    stopTimeoutMs: 400
  });
  const pid = fake.grandchildPid();
  assert.ok(pid !== null);
  const startedAt = Date.now();
  await handle.stop();
  assert.ok(Date.now() - startedAt >= 350, "waited for the graceful shutdown first");
  assert.equal(handle.isAlive(), false);
  assert.match(handle.exitReason() ?? "", /signal SIGKILL/);
  assert.equal(await waitFor(() => !isRunning(pid), 3_000), true);
  await handle.stop(); // idempotent, never throws
});

test("child exits by itself when the IPC channel disconnects", async (t) => {
  const temp = makeTempDir("vite-host-disconnect");
  t.after(() => {
    temp.cleanup();
  });
  const entry = hostEntryPath();
  const child = fork(entry, [], {
    cwd: temp.path,
    env: buildChildEnv(CHILD_PROCESS_BASE_ENV, entry.endsWith(".ts")),
    execArgv: childExecArgv(entry),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: true
  });
  t.after(() => {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  await delay(2_500); // let ts-node load the real host entry and install its handlers
  assert.equal(child.exitCode, null, "the host waits for messages while connected");
  child.disconnect();
  const code = await Promise.race([exited, delay(8_000, "timeout" as const)]);
  assert.notEqual(code, "timeout");
  assert.equal(code, 0);
});

test("liveCount returns to 0 after stop", async (t) => {
  const fake = setup(t);
  const before = ViteHostClient.liveCount();
  const handle = await ViteHostClient.start(fake.options("ready"), "/x", new AbortController().signal, {
    entryPath: fake.entry
  });
  assert.equal(ViteHostClient.liveCount(), before + 1);
  await handle.stop();
  assert.equal(ViteHostClient.liveCount(), before);
  assert.equal(before, 0);
});
