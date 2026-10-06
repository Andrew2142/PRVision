import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { QUEUED_RECOVERY_GRACE_MS, RUNNING_RECOVERY_GRACE_MS } from "../../../backend/src/config-consts";
import { Table, type VisualizationStatus } from "../../../backend/src/enums";
import {
  VisualizationWorkerService,
  type RecoveryDependencies
} from "../../../backend/src/services/visualizations/pipeline/visualization-worker-service";
import type { WorkspaceCleanupInput } from "../../../backend/src/services/visualizations/pipeline/workspace-prepare-service";
import type { QueryHandler } from "../../../backend/src/utilities";
import { recordLogger } from "../helpers/console-recorder";
import { makeComponentRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { InMemoryQueryHandler, installQueryHandlerStub } from "../helpers/query-handler-stub";
import { useTempDataDir } from "../helpers/temp-dir";
import { FakeQueueStatics, fakeTransaction } from "./helpers/fakes";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - QUEUED_RECOVERY_GRACE_MS - 1_000);
const RECENT = new Date(NOW.getTime() - 5_000);
const RESTART_MESSAGE = "The worker restarted while this visualization was running. Start it again.";
const LOST_QUEUED_MESSAGE =
  "The queued job was lost (Redis was cleared or the job failed before starting). Start the visualization again.";
const LOST_RUNNING_MESSAGE =
  "The worker lost track of this visualization (its job ended without a final status). Start it again.";

interface RecoveryHarness {
  store: InMemoryQueryHandler;
  queue: FakeQueueStatics;
  worktreesRoot: string;
  repoDir: string;
  cleanups: WorkspaceCleanupInput[];
  prunes: string[];
  deps: Partial<RecoveryDependencies>;
}

function setup(t: TestContext): RecoveryHarness {
  const store = new InMemoryQueryHandler();
  store.now = () => NOW;
  const stub = installQueryHandlerStub(store);
  t.after(stub.restore);
  const dataDir = useTempDataDir(t);
  const worktreesRoot = path.join(dataDir, "worktrees");
  fs.mkdirSync(worktreesRoot);
  const repoDir = path.join(dataDir, "clone");
  fs.mkdirSync(repoDir);
  store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: repoDir })]);
  const queue = new FakeQueueStatics();
  const h: RecoveryHarness = {
    store,
    queue,
    worktreesRoot,
    repoDir,
    cleanups: [],
    prunes: [],
    deps: {}
  };
  h.deps = {
    queryHandler: store as unknown as QueryHandler,
    transaction: fakeTransaction(store),
    queue,
    workspace: {
      cleanup: (input) => {
        h.cleanups.push(input);
        return Promise.resolve();
      }
    },
    git: {
      worktreePrune: (repoPath) => {
        h.prunes.push(repoPath);
        return Promise.resolve();
      }
    },
    artifacts: { worktreesRoot: () => worktreesRoot },
    now: () => NOW,
    intervalMs: 20
  };
  return h;
}

function consoleFor(h: RecoveryHarness, id: number): Array<Record<string, unknown>> {
  return h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).filter((row) => row.visualizationId === id);
}

test("VisualizationWorkerService.recoverOnBoot fails every active status with the restart message, failed_stage = its status, a console event at stage failed and the pending sweep", async (t) => {
  const h = setup(t);
  const active: VisualizationStatus[] = [
    "preparing",
    "analyzing",
    "generating_harnesses",
    "rendering",
    "diffing",
    "summarizing"
  ];
  h.store.seed(
    Table.VISUALIZATIONS,
    active.map((status, index) => makeVisualizationRow({ id: index + 1, status, createdAt: RECENT }))
  );
  h.store.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 1, visualizationId: 4, renderStatus: "pending" }),
    makeComponentRow({ id: 2, visualizationId: 4, renderStatus: "rendered", filePath: "src/B.tsx" })
  ]);
  const report = await VisualizationWorkerService.recoverOnBoot(h.deps);
  assert.deepEqual(report.failedRunning, [1, 2, 3, 4, 5, 6]);
  for (const [index, status] of active.entries()) {
    const row = h.store.row(Table.VISUALIZATIONS, index + 1);
    assert.equal(row?.status, "failed");
    assert.equal(row.failedStage, status);
    assert.equal(row.errorMessage, RESTART_MESSAGE);
    assert.deepEqual(row.completedAt, NOW);
    assert.deepEqual(
      consoleFor(h, index + 1).map((e) => [e.level, e.stage, e.message]),
      [["error", "failed", RESTART_MESSAGE]]
    );
  }
  assert.deepEqual(
    h.store.rows(Table.VISUALIZATION_COMPONENTS).map((c) => [c.renderStatus, c.skipReason]),
    [
      ["skipped", "Not processed: the run failed before this component was finished."],
      ["rendered", null]
    ]
  );
});

test("VisualizationWorkerService.recoverOnBoot fails queued rows older than the grace period whose job is missing, completed or failed", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, createdAt: OLD }),
    makeVisualizationRow({ id: 2, createdAt: OLD }),
    makeVisualizationRow({ id: 3, createdAt: OLD })
  ]);
  h.queue.jobStates.set(2, "completed");
  h.queue.jobStates.set(3, "failed");
  const report = await VisualizationWorkerService.recoverOnBoot(h.deps);
  assert.deepEqual(report.failedLostQueued, [1, 2, 3]);
  for (const id of [1, 2, 3]) {
    const row = h.store.row(Table.VISUALIZATIONS, id);
    assert.equal(row?.status, "failed");
    assert.equal(row.failedStage, "queued");
    assert.equal(row.errorMessage, LOST_QUEUED_MESSAGE);
    assert.equal(consoleFor(h, id)[0]?.stage, "failed");
  }
});

test("VisualizationWorkerService.recoverOnBoot leaves queued rows with waiting or active jobs, and recent rows, alone", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, createdAt: OLD }),
    makeVisualizationRow({ id: 2, createdAt: OLD }),
    makeVisualizationRow({ id: 3, createdAt: RECENT }),
    makeVisualizationRow({ id: 4, createdAt: OLD, status: "completed", completedAt: OLD })
  ]);
  h.queue.jobStates.set(1, "waiting");
  h.queue.jobStates.set(2, "active");
  const report = await VisualizationWorkerService.recoverOnBoot(h.deps);
  assert.deepEqual(report.failedLostQueued, []);
  assert.deepEqual(report.failedRunning, []);
  assert.deepEqual(
    h.store.rows(Table.VISUALIZATIONS).map((row) => row.status),
    ["queued", "queued", "queued", "completed"]
  );
  assert.equal(h.queue.calls.includes("state:3"), false, "recent rows are not even looked up");
  assert.equal(h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).length, 0);
});

test("VisualizationWorkerService.recoverOnBoot cleans numeric worktree dirs, including those of soft-deleted visualizations; leaves foreign entries and symlinks", async (t) => {
  const h = setup(t);
  h.store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2, localPath: "/tmp/deleted-repo", isDeleted: true })]);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 7, status: "completed", completedAt: OLD }),
    makeVisualizationRow({
      id: 8,
      repositoryId: 2,
      sourceType: "github_pr",
      prNumber: 41,
      status: "failed",
      completedAt: OLD,
      failedStage: "rendering",
      isDeleted: true
    })
  ]);
  for (const dir of ["7", "8", "9", "notes", "007"]) {
    fs.mkdirSync(path.join(h.worktreesRoot, dir));
  }
  fs.writeFileSync(path.join(h.worktreesRoot, "10"), "not a dir");
  const outside = path.join(path.dirname(h.worktreesRoot), "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.worktreesRoot, "11"));
  const logs = recordLogger();
  t.after(logs.restore);

  const report = await VisualizationWorkerService.recoverOnBoot(h.deps);
  assert.deepEqual(report.cleanedWorktrees, [7, 8, 9]);
  assert.deepEqual(report.skippedEntries.sort(), ["007", "10", "11", "notes"]);
  assert.deepEqual(h.cleanups, [
    { visualizationId: 7, repositoryPath: h.repoDir, prNumber: null, viteConfigPath: "vite.config.ts", appRoot: "." },
    {
      visualizationId: 8,
      repositoryPath: "/tmp/deleted-repo",
      prNumber: 41,
      viteConfigPath: "vite.config.ts",
      appRoot: "."
    },
    { visualizationId: 9, repositoryPath: null, prNumber: null, viteConfigPath: null, appRoot: null }
  ]);
  assert.ok(fs.existsSync(path.join(h.worktreesRoot, "notes")), "foreign entries are never deleted");
  assert.ok(fs.lstatSync(path.join(h.worktreesRoot, "11")).isSymbolicLink());
  assert.ok(logs.lines.some((l) => l.event === "visualization.recovery.foreign_entry"));

  fs.rmSync(h.worktreesRoot, { recursive: true });
  const empty = await VisualizationWorkerService.recoverOnBoot(h.deps);
  assert.deepEqual(empty.cleanedWorktrees, [], "a missing worktrees root is fine");
});

test("VisualizationWorkerService.recoverOnBoot runs worktreePrune for every existing repository", async (t) => {
  const h = setup(t);
  h.store.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 2, localPath: "/nonexistent/prvision-clone" }),
    makeRepositoryRow({ id: 3, localPath: h.worktreesRoot, isDeleted: true })
  ]);
  await VisualizationWorkerService.recoverOnBoot(h.deps);
  assert.deepEqual(h.prunes, [h.repoDir]);
});

test("VisualizationWorkerService.recoverOnBoot never throws when a step fails", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "rendering" })]);
  fs.mkdirSync(path.join(h.worktreesRoot, "1"));
  h.deps.queryHandler = {
    selectMany: () => Promise.reject(new Error("db down")),
    validateAndSelect: () => Promise.reject(new Error("db down"))
  } as unknown as QueryHandler;
  h.deps.git = { worktreePrune: () => Promise.reject(new Error("git broken")) };
  const logs = recordLogger();
  t.after(logs.restore);
  const report = await VisualizationWorkerService.recoverOnBoot(h.deps);
  assert.deepEqual(report, { failedRunning: [], failedLostQueued: [], cleanedWorktrees: [], skippedEntries: [] });
  assert.ok(logs.lines.filter((l) => l.event === "visualization.recovery.step_failed").length >= 3);

  const transactionFails = setup(t);
  transactionFails.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "rendering" })]);
  transactionFails.deps.transaction = () => Promise.reject(new Error("deadlock"));
  await VisualizationWorkerService.recoverOnBoot(transactionFails.deps);
  assert.equal(transactionFails.store.row(Table.VISUALIZATIONS, 1)?.status, "rendering");
});

test("VisualizationWorkerService.startRecoverySweep fails an active row whose job is completed, failed or missing, and leaves the row of the active job alone", async (t) => {
  const h = setup(t);
  const stale = new Date(NOW.getTime() - RUNNING_RECOVERY_GRACE_MS - 1_000);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "rendering", updatedAt: stale }),
    makeVisualizationRow({ id: 2, status: "diffing", updatedAt: stale }),
    makeVisualizationRow({ id: 3, status: "analyzing", updatedAt: stale }),
    makeVisualizationRow({ id: 4, status: "rendering", updatedAt: stale }),
    makeVisualizationRow({ id: 5, status: "rendering", updatedAt: RECENT }),
    makeVisualizationRow({ id: 6, createdAt: OLD })
  ]);
  h.queue.jobStates.set(1, "completed");
  h.queue.jobStates.set(2, "failed");
  h.queue.jobStates.set(4, "active");
  const sweep = VisualizationWorkerService.startRecoverySweep(h.deps);
  t.after(() => {
    sweep.stop();
  });
  await delay(120);
  sweep.stop();
  const status = (id: number): unknown => h.store.row(Table.VISUALIZATIONS, id)?.status;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(status), ["failed", "failed", "failed", "rendering", "rendering", "failed"]);
  for (const id of [1, 2, 3]) {
    assert.equal(h.store.row(Table.VISUALIZATIONS, id)?.errorMessage, LOST_RUNNING_MESSAGE);
  }
  assert.equal(h.store.row(Table.VISUALIZATIONS, 1)?.failedStage, "rendering");
  assert.equal(h.store.row(Table.VISUALIZATIONS, 6)?.errorMessage, LOST_QUEUED_MESSAGE);
});

test("VisualizationWorkerService.startRecoverySweep skips a tick while the previous one is still running; stop() clears the interval", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, createdAt: OLD })]);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  const count = (): number => lookups;
  h.queue.getVisualizationJobState = async () => {
    lookups += 1;
    await gate;
    return "waiting";
  };
  const sweep = VisualizationWorkerService.startRecoverySweep(h.deps);
  t.after(() => {
    sweep.stop();
  });
  await delay(150); // ~7 intervals while the first tick is blocked
  assert.equal(count(), 1, "overlapping ticks are skipped");
  release();
  await delay(60);
  assert.ok(count() >= 2, "ticks resume after the first finished");
  sweep.stop();
  const afterStop = lookups;
  await delay(100);
  assert.equal(count(), afterStop, "no ticks after stop()");
});
