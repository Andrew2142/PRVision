import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Table } from "../../../backend/src/enums";
import {
  LIVE_RESTARTED_MESSAGE,
  LIVE_START_LOST_MESSAGE,
  LiveSessionRecovery
} from "../../../backend/src/services/live/live-session-recovery";
import type { QueryHandler } from "../../../backend/src/utilities";
import { makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { makeTempDir } from "../helpers/temp-dir";

const NOW = Date.parse("2026-03-01T10:00:00Z");

function sessionRow(id: number, status: string, ageMs: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    visualizationId: 1,
    status,
    stopReason: status === "stopping" ? "user" : null,
    hosts: [],
    openRequests: [],
    openRequestsVersion: 0,
    lastHeartbeatAt: new Date(NOW - ageMs),
    lastActivityAt: new Date(NOW - ageMs),
    createdAt: new Date(NOW - ageMs),
    updatedAt: new Date(NOW - ageMs),
    ...extra
  };
}

function setup(states: Record<number, string> = {}) {
  const temp = makeTempDir("live-recovery");
  const worktrees = path.join(temp.path, "worktrees");
  const clone = path.join(temp.path, "clone");
  fs.mkdirSync(clone, { recursive: true });
  for (const name of ["live-3", "live-12", "scan-4", "repair-5", "17", "live-x"]) {
    fs.mkdirSync(path.join(worktrees, name, "base"), { recursive: true });
  }
  fs.writeFileSync(path.join(worktrees, "live-9"), "a file, not a folder");
  const store = new InMemoryQueryHandler();
  store.now = () => new Date(NOW);
  store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: clone })]);
  store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "completed", completedAt: new Date(NOW) })]);
  const pruned: string[] = [];
  const recovery = new LiveSessionRecovery({
    queryHandler: store as unknown as QueryHandler,
    queue: { getLiveSessionJobState: (id: number) => Promise.resolve(states[id] ?? "missing") },
    git: {
      worktreePrune: (repo: string) => {
        pruned.push(repo);
        return Promise.resolve();
      }
    },
    worktreesRoot: worktrees,
    now: () => new Date(NOW),
    intervalMs: 60_000,
    startTimeoutMs: 300_000
  });
  return { temp, worktrees, clone, store, recovery, pruned };
}

test("boot recovery fails every active session, removes live worktree folders only and prunes the clones", async () => {
  const s = setup();
  try {
    s.store.seed(Table.LIVE_SESSIONS, [
      sessionRow(1, "starting", 1_000),
      sessionRow(2, "ready", 1_000),
      sessionRow(3, "stopping", 1_000),
      sessionRow(4, "stopped", 1_000, { stopReason: "idle" }),
      sessionRow(5, "failed", 1_000, { stopReason: "error", errorMessage: "x" })
    ]);
    const report = await s.recovery.recoverOnBoot();
    assert.deepEqual(report.failedSessions, [1, 2, 3]);
    assert.deepEqual(report.removedFolders, ["live-12", "live-3"]);
    for (const id of [1, 2, 3]) {
      const row = s.store.row(Table.LIVE_SESSIONS, id);
      assert.deepEqual([row?.status, row?.stopReason, row?.errorMessage], ["failed", "error", LIVE_RESTARTED_MESSAGE]);
    }
    assert.equal(s.store.row(Table.LIVE_SESSIONS, 4)?.status, "stopped");
    assert.deepEqual(fs.readdirSync(s.worktrees).sort(), ["17", "live-9", "live-x", "repair-5", "scan-4"]);
    assert.deepEqual(s.pruned, [s.clone]);
  } finally {
    s.temp.cleanup();
  }
});

test("the sweep fails stuck starting sessions whose job is not active and closes orphaned stopping ones", async () => {
  const s = setup({ 2: "active", 6: "active" });
  try {
    s.store.seed(Table.LIVE_SESSIONS, [
      sessionRow(1, "starting", 300_001),
      sessionRow(2, "starting", 300_001),
      sessionRow(3, "starting", 299_000),
      sessionRow(4, "ready", 3_600_000),
      sessionRow(5, "stopping", 120_000),
      sessionRow(6, "stopping", 120_000)
    ]);
    await s.recovery.sweepOnce();
    const status = (id: number): unknown => s.store.row(Table.LIVE_SESSIONS, id)?.status;
    assert.equal(status(1), "failed");
    assert.equal(s.store.row(Table.LIVE_SESSIONS, 1)?.errorMessage, LIVE_START_LOST_MESSAGE);
    assert.equal(status(2), "starting", "its job is still preparing");
    assert.equal(status(3), "starting", "not older than the start timeout");
    assert.equal(status(4), "ready");
    assert.equal(status(5), "stopped");
    assert.equal(status(6), "stopping", "its worker is still releasing hosts");
  } finally {
    s.temp.cleanup();
  }
});
