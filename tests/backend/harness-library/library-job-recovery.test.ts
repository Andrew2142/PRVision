import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Table } from "../../../backend/src/enums";
import {
  LibraryJobRecovery,
  LOST_LIBRARY_JOB_MESSAGE,
  REPAIR_RESTARTED_MESSAGE,
  SCAN_RESTARTED_MESSAGE
} from "../../../backend/src/services/harness-library/library-job-recovery";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { makeLibraryJobRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { FakeLibraryQueue } from "../helpers/fake-library-queue";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { fakeTransaction } from "../visualizations/helpers/fakes";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const JOBS = Table.HARNESS_LIBRARY_JOBS;

interface Setup {
  db: InMemoryQueryHandler;
  queue: FakeLibraryQueue;
  pruned: string[];
  dataDir: string;
  recovery: LibraryJobRecovery;
}

async function setup(t: TestContext): Promise<Setup> {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-library-recovery-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const clone = path.join(dataDir, "clone");
  await fs.mkdir(clone);
  const db = new InMemoryQueryHandler();
  db.now = () => NOW;
  db.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 1, localPath: clone }),
    makeRepositoryRow({ id: 2, localPath: path.join(dataDir, "missing-clone") })
  ]);
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 4, status: "completed", completedAt: NOW })]);
  const queue = new FakeLibraryQueue();
  const pruned: string[] = [];
  const recovery = new LibraryJobRecovery({
    queryHandler: db as unknown as QueryHandler,
    transaction: fakeTransaction(db),
    createQueryHandler: () => db as unknown as QueryHandler,
    queue,
    git: {
      worktreePrune: (repoPath) => {
        pruned.push(repoPath);
        return Promise.resolve();
      }
    },
    worktreesRoot: path.join(dataDir, "worktrees"),
    libraryJobsRoot: path.join(dataDir, "library-jobs"),
    now: () => NOW,
    intervalMs: 60_000
  });
  return { db, queue, pruned, dataDir, recovery };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

test("boot fails jobs a worker was processing with the kind's restart message and one error event each", async (t) => {
  const { db, recovery } = await setup(t);
  db.seed(JOBS, [
    makeLibraryJobRow({ id: 1, status: "running", totalCount: 5 }),
    makeLibraryJobRow({ id: 2, kind: "rescan", status: "preparing" }),
    makeLibraryJobRow({ id: 3, kind: "repair", status: "running", visualizationId: 4, componentIds: [7] }),
    makeLibraryJobRow({ id: 4, status: "completed", completedAt: NOW }),
    makeLibraryJobRow({ id: 5, status: "queued", createdAt: NOW })
  ]);
  const report = await recovery.recoverOnBoot();
  assert.deepEqual(report.failedActive.sort(), [1, 2, 3]);
  assert.equal(db.row(JOBS, 1)?.errorMessage, SCAN_RESTARTED_MESSAGE);
  assert.equal(db.row(JOBS, 2)?.errorMessage, SCAN_RESTARTED_MESSAGE);
  assert.equal(db.row(JOBS, 3)?.errorMessage, REPAIR_RESTARTED_MESSAGE);
  assert.equal(
    SCAN_RESTARTED_MESSAGE,
    "PRVision restarted while this scan was running. Continue scan to write the rest."
  );
  assert.equal(REPAIR_RESTARTED_MESSAGE, "PRVision restarted during the repair. Run Repair again.");
  for (const id of [1, 2, 3]) {
    assert.equal(db.row(JOBS, id)?.status, "failed");
    assert.deepEqual(db.row(JOBS, id)?.completedAt, NOW);
  }
  assert.equal(db.row(JOBS, 4)?.status, "completed");
  assert.equal(db.row(JOBS, 5)?.status, "queued", "a recent queued job keeps waiting for the worker");
  const events = db.rows(Table.HARNESS_LIBRARY_JOB_EVENTS);
  assert.deepEqual(events.map((event) => [event.jobId, event.level]).sort(), [
    [1, "error"],
    [2, "error"],
    [3, "error"]
  ]);
});

test("boot removes scan and repair worktrees and scratch renders only, and prunes every existing clone", async (t) => {
  const { recovery, dataDir, pruned } = await setup(t);
  const worktrees = path.join(dataDir, "worktrees");
  for (const dir of ["scan-3/head", "repair-8/base", "12/head", "scan-x", "notes"]) {
    await fs.mkdir(path.join(worktrees, dir), { recursive: true });
  }
  // A node_modules link inside a scan worktree must be removed as a link, never followed.
  const userModules = path.join(dataDir, "clone", "node_modules");
  await fs.mkdir(userModules);
  await fs.writeFile(path.join(userModules, "keep.txt"), "user file");
  await fs.symlink(userModules, path.join(worktrees, "scan-3", "head", "node_modules"), "dir");
  await fs.mkdir(path.join(dataDir, "library-jobs", "3", "renders", "1"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "library-jobs", "3", "keep.json"), "{}");

  const report = await recovery.recoverOnBoot();
  assert.deepEqual(report.removedWorktrees, ["repair-8", "scan-3"]);
  assert.equal(await exists(path.join(worktrees, "scan-3")), false);
  assert.equal(await exists(path.join(worktrees, "repair-8")), false);
  assert.equal(await exists(path.join(worktrees, "12")), true, "visualization worktrees belong to 07's recovery");
  assert.equal(await exists(path.join(worktrees, "scan-x")), true);
  assert.equal(await exists(path.join(worktrees, "notes")), true);
  assert.equal(await fs.readFile(path.join(userModules, "keep.txt"), "utf8"), "user file");
  assert.deepEqual(report.removedRenderDirs, ["3"]);
  assert.equal(await exists(path.join(dataDir, "library-jobs", "3", "renders")), false);
  assert.equal(await exists(path.join(dataDir, "library-jobs", "3", "keep.json")), true);
  assert.deepEqual(pruned, [path.join(dataDir, "clone")]);
});

test("boot and sweep fail queued jobs whose BullMQ job is gone after the grace period", async (t) => {
  const { db, queue, recovery } = await setup(t);
  db.seed(JOBS, [
    makeLibraryJobRow({ id: 1, status: "queued" }), // created 2026-01-01: past the grace period
    makeLibraryJobRow({ id: 2, status: "queued" }),
    makeLibraryJobRow({ id: 3, status: "queued", createdAt: NOW })
  ]);
  queue.jobStates.set(2, "waiting");
  const report = await recovery.recoverOnBoot();
  assert.deepEqual(report.failedLostQueued, [1]);
  assert.equal(db.row(JOBS, 1)?.errorMessage, LOST_LIBRARY_JOB_MESSAGE);
  assert.equal(LOST_LIBRARY_JOB_MESSAGE, "The job was lost; start it again.");
  assert.equal(db.row(JOBS, 2)?.status, "queued");
  assert.equal(db.row(JOBS, 3)?.status, "queued");

  queue.jobStates.set(2, "failed");
  await recovery.sweepOnce();
  assert.equal(db.row(JOBS, 2)?.status, "failed");
});

test("the sweep fails preparing or running jobs whose BullMQ job is not active", async (t) => {
  const { db, queue, recovery } = await setup(t);
  db.seed(JOBS, [
    makeLibraryJobRow({ id: 1, status: "running", totalCount: 3 }),
    makeLibraryJobRow({ id: 2, status: "running", totalCount: 3 }),
    makeLibraryJobRow({ id: 3, kind: "repair", status: "preparing", visualizationId: 4, componentIds: [1] }),
    makeLibraryJobRow({ id: 4, status: "running", totalCount: 3, updatedAt: NOW })
  ]);
  queue.jobStates.set(2, "active");
  await recovery.sweepOnce();
  assert.equal(db.row(JOBS, 1)?.status, "failed");
  assert.equal(db.row(JOBS, 1)?.errorMessage, SCAN_RESTARTED_MESSAGE);
  assert.equal(db.row(JOBS, 2)?.status, "running", "an active BullMQ job is left alone");
  assert.equal(db.row(JOBS, 3)?.errorMessage, REPAIR_RESTARTED_MESSAGE);
  assert.equal(db.row(JOBS, 4)?.status, "running", "recently updated jobs are within the grace period");
});

test("a recovery step failure is logged and never blocks the other steps", async (t) => {
  const { db, recovery, pruned } = await setup(t);
  db.failNext("selectMany", new Error("db down"));
  const report = await recovery.recoverOnBoot();
  assert.deepEqual(report.failedActive, []);
  assert.equal(pruned.length, 1);
});
