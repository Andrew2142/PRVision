import assert from "node:assert/strict";
import { test } from "node:test";
import { LIBRARY_JOB_STATUS_VALUES, Table, TERMINAL_LIBRARY_JOB_STATUSES } from "../../../backend/src/enums";
import {
  canTransitionLibraryJob,
  isTerminalLibraryJobStatus,
  LIBRARY_JOB_TRANSITIONS,
  LibraryJobTransitionError,
  transitionLibraryJob
} from "../../../backend/src/services/harness-library/library-job-state";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { makeLibraryJobRow } from "../helpers/factories";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const JOBS = Table.HARNESS_LIBRARY_JOBS;

function setup(status: "queued" | "preparing" | "running" = "queued"): {
  db: InMemoryQueryHandler;
  qh: QueryHandler;
} {
  const db = new InMemoryQueryHandler();
  db.seed(JOBS, [makeLibraryJobRow({ id: 7, status })]);
  return { db, qh: db as unknown as QueryHandler };
}

test("the transition table matches 16 §10.2 exactly", () => {
  assert.deepEqual(LIBRARY_JOB_TRANSITIONS, {
    queued: ["preparing", "cancelled", "failed"],
    preparing: ["running", "failed", "cancelled"],
    running: ["completed", "cap_reached", "failed", "cancelled"],
    completed: [],
    cap_reached: [],
    failed: [],
    cancelled: []
  });
  for (const status of LIBRARY_JOB_STATUS_VALUES) {
    assert.equal(
      isTerminalLibraryJobStatus(status),
      (TERMINAL_LIBRARY_JOB_STATUSES as readonly string[]).includes(status),
      status
    );
  }
  assert.equal(canTransitionLibraryJob("queued", "running"), false);
  assert.equal(canTransitionLibraryJob("preparing", "cap_reached"), false);
  assert.equal(canTransitionLibraryJob("running", "cap_reached"), true);
});

test("queued → preparing stamps started_at and writes the given fields under the status guard", async () => {
  const { db, qh } = setup();
  const ok = await transitionLibraryJob(qh, {
    jobId: 7,
    from: "queued",
    to: "preparing",
    fields: { scanSha: "a".repeat(40) },
    now: NOW
  });
  assert.equal(ok, true);
  const row = db.row(JOBS, 7);
  assert.equal(row?.status, "preparing");
  assert.deepEqual(row.startedAt, NOW);
  assert.equal(row.completedAt, null);
  assert.equal(row.scanSha, "a".repeat(40));
  const update = db.callsFor("update", JOBS)[0];
  assert.deepEqual(update?.args[1], { id: 7, status: "queued" });
});

test("a terminal transition stamps completed_at; preparing does not stamp it", async () => {
  const { db, qh } = setup("running");
  assert.equal(
    await transitionLibraryJob(qh, {
      jobId: 7,
      from: "running",
      to: "cap_reached",
      fields: { errorMessage: "Stopped at the spending cap of $1.00 (spent $1.02)." },
      now: NOW
    }),
    true
  );
  const row = db.row(JOBS, 7);
  assert.equal(row?.status, "cap_reached");
  assert.deepEqual(row.completedAt, NOW);
  assert.equal(row.startedAt, null);
});

test("a lost guard returns false and writes nothing", async () => {
  const { db, qh } = setup("running");
  assert.equal(await transitionLibraryJob(qh, { jobId: 7, from: "queued", to: "preparing", now: NOW }), false);
  assert.equal(db.row(JOBS, 7)?.status, "running");
});

test("an illegal transition throws before any write; a DB failure throws", async () => {
  const { db, qh } = setup();
  await assert.rejects(
    transitionLibraryJob(qh, { jobId: 7, from: "queued", to: "completed", now: NOW }),
    LibraryJobTransitionError
  );
  assert.equal(db.callsFor("update").length, 0);
  db.failNext("update");
  await assert.rejects(
    transitionLibraryJob(qh, { jobId: 7, from: "queued", to: "preparing", now: NOW }),
    /update failed \(500\)/
  );
});
