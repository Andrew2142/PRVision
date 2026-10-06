import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CHILD_PROCESS_BASE_ENV } from "../../../backend/src/config-consts";
import { ProcessError, runProcess } from "../../../backend/src/utilities/helpers/process";
import { withTempDir } from "../helpers/test-context";

const NODE = process.execPath;
const cwd = process.cwd();

async function rejectsWithKind(promise: Promise<unknown>, kind: ProcessError["kind"]): Promise<ProcessError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof ProcessError, "expected a ProcessError");
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail(`expected rejection with ${kind}`);
}

test("runProcess resolves stdout/stderr/exitCode for a successful child", async () => {
  const result = await runProcess(NODE, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], {
    cwd,
    timeoutMs: 10_000
  });
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
});

test("runProcess rejects non_zero_exit unless allowedExitCodes includes the code", async () => {
  const error = await rejectsWithKind(
    runProcess(NODE, ["-e", "process.stderr.write('bad'); process.exit(3)"], { cwd, timeoutMs: 10_000 }),
    "non_zero_exit"
  );
  assert.equal(error.exitCode, 3);
  assert.equal(error.stderr, "bad");
  const allowed = await runProcess(NODE, ["-e", "process.exit(3)"], {
    cwd,
    timeoutMs: 10_000,
    allowedExitCodes: [0, 3]
  });
  assert.equal(allowed.exitCode, 3);
});

test("runProcess kills and rejects timeout", async () => {
  await rejectsWithKind(runProcess(NODE, ["-e", "setInterval(() => {}, 1000)"], { cwd, timeoutMs: 200 }), "timeout");
});

test("runProcess kills and rejects aborted on AbortSignal", async () => {
  const controller = new AbortController();
  const running = runProcess(NODE, ["-e", "setInterval(() => {}, 1000)"], {
    cwd,
    timeoutMs: 10_000,
    signal: controller.signal
  });
  setTimeout(() => {
    controller.abort("cancelled");
  }, 150);
  await rejectsWithKind(running, "aborted");
});

test("runProcess with a pre-aborted signal never spawns", async () => {
  await withTempDir(async (dir) => {
    const marker = path.join(dir, "spawned");
    const controller = new AbortController();
    controller.abort("cancelled");
    await rejectsWithKind(
      runProcess(NODE, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`], {
        cwd,
        timeoutMs: 10_000,
        signal: controller.signal
      }),
      "aborted"
    );
    await delay(300);
    await assert.rejects(fs.access(marker));
  });
});

test("runProcess rejects max_buffer when output exceeds the cap", async () => {
  await rejectsWithKind(
    runProcess(NODE, ["-e", "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"], {
      cwd,
      timeoutMs: 10_000,
      maxBufferBytes: 1_000
    }),
    "max_buffer"
  );
});

test("runProcess rejects spawn_failed for a missing binary", async () => {
  await rejectsWithKind(runProcess("prvision-no-such-binary", [], { cwd, timeoutMs: 10_000 }), "spawn_failed");
});

test("runProcess passes stdin input", async () => {
  const result = await runProcess(NODE, ["-e", "process.stdin.pipe(process.stdout)"], {
    cwd,
    timeoutMs: 10_000,
    input: "hello stdin"
  });
  assert.equal(result.stdout, "hello stdin");
});

test("runProcess does not inherit PRVISION_SECRET_KEY, DATABASE_URL or REDIS_URL", async () => {
  // The preload sets all three in the parent environment.
  const result = await runProcess(NODE, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
    cwd,
    timeoutMs: 10_000
  });
  const childEnv = JSON.parse(result.stdout) as Record<string, string>;
  for (const name of ["PRVISION_SECRET_KEY", "DATABASE_URL", "REDIS_URL", "PRVISION_DATA_DIR", "NODE_OPTIONS"]) {
    assert.equal(childEnv[name], undefined, `${name} must not reach the child`);
  }
  for (const name of Object.keys(CHILD_PROCESS_BASE_ENV)) {
    assert.equal(childEnv[name], CHILD_PROCESS_BASE_ENV[name]);
  }
});

test("runProcess kills the whole process group on timeout", async () => {
  await withTempDir(async (dir) => {
    const marker = path.join(dir, "grandchild-ran");
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, '1'), 2000)`;
    const parent = [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);"
    ].join("\n");
    await rejectsWithKind(runProcess(NODE, ["-e", parent], { cwd, timeoutMs: 500 }), "timeout");
    await delay(2_500);
    await assert.rejects(fs.access(marker), "the grandchild must have been killed with its group");
  });
});

test("runProcess error message never contains argv", async () => {
  const error = await rejectsWithKind(
    runProcess(NODE, ["-e", "process.exit(2)", "--", "--token=super-secret-value"], {
      cwd,
      timeoutMs: 10_000,
      logLabel: "node test"
    }),
    "non_zero_exit"
  );
  assert.ok(!error.message.includes("super-secret-value"));
  assert.equal(error.message, "node test failed (non_zero_exit, exit 2)");
});
