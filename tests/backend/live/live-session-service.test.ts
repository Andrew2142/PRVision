import assert from "node:assert/strict";
import { test } from "node:test";
import { Table } from "../../../backend/src/enums";
import {
  LIVE_BUSY_MESSAGE,
  LIVE_NEVER_STARTED_MESSAGE,
  LIVE_NOT_RUNNING_MESSAGE,
  LIVE_OPEN_MAX_ATTEMPTS,
  LiveSessionService,
  liveLimitMessage,
  stopLiveSessionsOfRuns
} from "../../../backend/src/services/live/live-session-service";
import type { Conditions, QueryHandler } from "../../../backend/src/utilities";
import { makeComponentRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { InMemoryQueryHandler, type Row } from "../helpers/query-handler-stub";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const HARNESS = `import { definePrvisionHarness } from "../harness-api";
import Target from "../../src/components/Button";
export default definePrvisionHarness({ states: [
  { name: "Default", render: () => <Target /> },
  { name: "Menu open", render: () => <Target />, steps: [{ action: "click", target: { by: "text", text: "More" } }] }
] });
`;

interface Harness {
  store: InMemoryQueryHandler;
  service: LiveSessionService;
  enqueued: number[];
  clock: { t: number };
}

function finishedRun(id: number, overrides: Record<string, unknown> = {}): ReturnType<typeof makeVisualizationRow> {
  return makeVisualizationRow({
    id,
    status: "completed",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    completedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  });
}

function setup(options: { failEnqueue?: boolean; maxSessions?: number } = {}): Harness {
  const store = new InMemoryQueryHandler();
  const clock = { t: Date.parse("2026-03-01T10:00:00Z") };
  store.now = () => new Date(clock.t);
  store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 }), makeRepositoryRow({ id: 2, isDeleted: true })]);
  store.seed(Table.VISUALIZATIONS, [
    finishedRun(1),
    finishedRun(2),
    finishedRun(3),
    finishedRun(4, { status: "rendering", completedAt: null }),
    finishedRun(5),
    finishedRun(6, { baseSha: null }),
    finishedRun(7, { sourceType: "working_tree", headSha: null, workingTreeSnapshot: false }),
    finishedRun(8, { headSha: null }),
    finishedRun(9, { repositoryId: 2 }),
    finishedRun(10, { sourceType: "working_tree", headSha: null, workingTreeSnapshot: true })
  ]);
  store.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 11, visualizationId: 1, harnessSource: HARNESS }),
    makeComponentRow({ id: 12, visualizationId: 1, filePath: "src/B.tsx", harnessSource: null }),
    makeComponentRow({ id: 21, visualizationId: 2, harnessSource: HARNESS }),
    makeComponentRow({ id: 31, visualizationId: 3, harnessSource: HARNESS }),
    makeComponentRow({ id: 51, visualizationId: 5, harnessSource: null }),
    makeComponentRow({ id: 61, visualizationId: 6, harnessSource: HARNESS }),
    makeComponentRow({ id: 71, visualizationId: 7, harnessSource: HARNESS }),
    makeComponentRow({ id: 81, visualizationId: 8, harnessSource: HARNESS }),
    makeComponentRow({ id: 91, visualizationId: 9, harnessSource: HARNESS }),
    makeComponentRow({ id: 101, visualizationId: 10, harnessSource: HARNESS })
  ]);
  const enqueued: number[] = [];
  const service = new LiveSessionService({
    queryHandler: store as unknown as QueryHandler,
    queue: {
      enqueueLiveSession: (id: number) => {
        if (options.failEnqueue === true) {
          return Promise.reject(new Error("redis down"));
        }
        enqueued.push(id);
        return Promise.resolve({ jobId: `live-${String(id)}`, alreadyQueued: false });
      }
    },
    now: () => new Date(clock.t),
    maxSessions: options.maxSessions ?? 2
  });
  return { store, service, enqueued, clock };
}

function session(store: InMemoryQueryHandler, id: number): Row {
  const row = store.row(Table.LIVE_SESSIONS, id);
  assert.ok(row, `live session ${String(id)}`);
  return row;
}

test("start refuses runs that are missing, unfinished, empty or not recreatable, with the §12.2 messages", async () => {
  const { service } = setup();
  const cases: Array<[number, number, string]> = [
    [404, 999, "Visualization not found"],
    [404, 9, "Visualization not found"], // repository removed
    [409, 4, "Live mode is available once the run has finished."],
    [409, 5, "This run has no rendered components to show live."],
    [409, 6, "This run has no base commit to recreate."],
    [409, 7, "The uncommitted changes of this run are no longer available. Start a new visualization."],
    [409, 8, "This run has no head commit to recreate."]
  ];
  for (const [status, id, message] of cases) {
    const response = await service.start(id);
    assert.equal(response.status, status, `run ${String(id)}`);
    assert.equal(response.error, message, `run ${String(id)}`);
    assert.equal(response.error_reason, status === 404 ? "not_found" : "conflict");
  }
});

test("start inserts a starting session, enqueues live-<id>, stores the job id and answers 202 with the view", async () => {
  const { service, store, enqueued, clock } = setup();
  const response = await service.start(1);
  assert.equal(response.status, 202);
  const view = response.data;
  assert.ok(view);
  assert.deepEqual(enqueued, [view.id]);
  assert.equal(session(store, view.id).jobId, `live-${String(view.id)}`);
  assert.deepEqual(view, {
    id: view.id,
    visualizationId: 1,
    status: "starting",
    stopReason: null,
    errorMessage: null,
    hosts: [],
    idleTimeoutMs: 600_000,
    heartbeatIntervalMs: 30_000,
    createdAt: new Date(clock.t).toISOString(),
    readyAt: null,
    stoppedAt: null
  });
  const working = await service.start(10);
  assert.equal(working.status, 202, "a working-tree run with its snapshot can go live");
});

test("one Live click serves the run: a second start returns the active session with 200", async () => {
  const { service, enqueued } = setup();
  const first = await service.start(1);
  const second = await service.start(1);
  assert.equal(second.status, 200);
  assert.equal(second.data?.id, first.data?.id);
  assert.equal(enqueued.length, 1);
});

test("at most 2 live sessions overall: a third run gets 409 with the limit message", async () => {
  const { service, store } = setup();
  assert.equal((await service.start(1)).status, 202);
  assert.equal((await service.start(2)).status, 202);
  const third = await service.start(3);
  assert.equal(third.status, 409);
  assert.equal(
    third.error,
    "Live mode is already running for 2 other runs. Leave one of them first (it also stops by itself after 10 minutes idle)."
  );
  assert.equal(third.error, liveLimitMessage(2));
  // A stopped session frees its slot
  const first = store.rows(Table.LIVE_SESSIONS)[0];
  assert.ok(first);
  await store.update({ status: "stopped", stopReason: "user" }, { id: first.id }, Table.LIVE_SESSIONS);
  assert.equal((await service.start(3)).status, 202);
});

test("a failed enqueue answers 500 and marks the session failed", async () => {
  const { service, store } = setup({ failEnqueue: true });
  const response = await service.start(1);
  assert.equal(response.status, 500);
  assert.equal(response.error, "Could not queue live mode.");
  const row = store.rows(Table.LIVE_SESSIONS)[0];
  assert.equal(row?.status, "failed");
  assert.equal(row.stopReason, "error");
});

test("get returns the active session, else the most recent one, and 404 when the run never had one", async () => {
  const { service, store } = setup();
  const never = await service.get(1);
  assert.equal(never.status, 404);
  assert.equal(never.error, LIVE_NEVER_STARTED_MESSAGE);
  const started = await service.start(1);
  assert.equal((await service.get(1)).data?.id, started.data?.id);
  await store.update(
    { status: "stopped", stopReason: "idle", stoppedAt: new Date() },
    { id: started.data?.id },
    Table.LIVE_SESSIONS
  );
  const latest = await service.get(1);
  assert.equal(latest.status, 200);
  assert.equal(latest.data?.status, "stopped");
  assert.equal(latest.data.stopReason, "idle");
  assert.equal((await service.get(999)).status, 404);
});

test("open validates the session, the component and the state, then appends with the version guard", async () => {
  const { service, store, clock } = setup();
  const notRunning = await service.open(1, { componentId: 11, stateName: "Default" });
  assert.deepEqual([notRunning.status, notRunning.error], [409, LIVE_NOT_RUNNING_MESSAGE]);
  const id = (await service.start(1)).data?.id ?? 0;
  assert.equal((await service.open(1, { componentId: 12, stateName: "Default" })).status, 404, "no harness");
  assert.equal((await service.open(1, { componentId: 21, stateName: "Default" })).status, 404, "other run");
  const badState = await service.open(1, { componentId: 11, stateName: "Hovered" });
  assert.equal(badState.status, 400);
  assert.equal(badState.error_reason, "validation_failed");
  assert.deepEqual(badState.error, ['State "Hovered" is not a state of this component. States: Default, Menu open.']);

  clock.t += 5_000;
  const opened = await service.open(1, { componentId: 11, stateName: "Menu open" });
  assert.equal(opened.status, 202);
  assert.equal(opened.data?.id, id);
  let row = session(store, id);
  assert.equal(row.openRequestsVersion, 1);
  assert.deepEqual(row.openRequests, [{ componentId: 11, requestedAt: new Date(clock.t).toISOString() }]);
  assert.equal((row.lastActivityAt as Date).getTime(), clock.t);

  clock.t += 1_000;
  await service.open(1, { componentId: 11, stateName: "Default" });
  row = session(store, id);
  assert.equal(row.openRequestsVersion, 2);
  assert.deepEqual(
    row.openRequests,
    [{ componentId: 11, requestedAt: new Date(clock.t).toISOString() }],
    "deduplicated"
  );

  await store.update({ status: "stopping", stopReason: "user" }, { id }, Table.LIVE_SESSIONS);
  assert.equal((await service.open(1, { componentId: 11, stateName: "Default" })).status, 409, "stopping");
});

/** Makes the next `misses` version-guarded appends lose the race (the worker drains in between). */
function raceAppends(store: InMemoryQueryHandler, misses: number): { attempts: number } {
  const counter = { attempts: 0 };
  let left = misses;
  const original = store.update.bind(store);
  store.update = async (values: Record<string, unknown>, conditions: Conditions, table: Table) => {
    if (table === Table.LIVE_SESSIONS && "openRequestsVersion" in conditions && "lastActivityAt" in values) {
      counter.attempts += 1;
      if (left > 0) {
        left -= 1;
        const id = conditions.id as number;
        const current = store.row(Table.LIVE_SESSIONS, id);
        await original(
          { openRequests: [], openRequestsVersion: Number(current?.openRequestsVersion ?? 0) + 1 },
          { id },
          Table.LIVE_SESSIONS
        );
      }
    }
    return original(values, conditions, table);
  };
  return counter;
}

test("open retries a version miss and answers 409 after 3 misses", async () => {
  const ok = setup();
  const id = (await ok.service.start(1)).data?.id ?? 0;
  const counter = raceAppends(ok.store, 1);
  assert.equal((await ok.service.open(1, { componentId: 11, stateName: "Default" })).status, 202);
  assert.equal(counter.attempts, 2);
  assert.deepEqual(
    (session(ok.store, id).openRequests as Array<{ componentId: number }>).map((request) => request.componentId),
    [11]
  );

  const busy = setup();
  await busy.service.start(1);
  const busyCounter = raceAppends(busy.store, LIVE_OPEN_MAX_ATTEMPTS);
  const response = await busy.service.open(1, { componentId: 11, stateName: "Default" });
  assert.deepEqual([response.status, response.error, response.error_reason], [409, LIVE_BUSY_MESSAGE, "conflict"]);
  assert.equal(busyCounter.attempts, 3);
});

test("heartbeat records the heartbeat (and activity only when active); 404 without an active session", async () => {
  const { service, store, clock } = setup();
  const none = await service.heartbeat(1, { active: true });
  assert.deepEqual([none.status, none.error_reason], [404, "not_found"]);
  const id = (await service.start(1)).data?.id ?? 0;
  const created = clock.t;
  clock.t += 30_000;
  assert.deepEqual(await service.heartbeat(1, { active: false }), { status: 200, data: { status: "starting" } });
  let row = session(store, id);
  assert.equal((row.lastHeartbeatAt as Date).getTime(), clock.t);
  assert.equal((row.lastActivityAt as Date).getTime(), created);
  clock.t += 30_000;
  await service.heartbeat(1, { active: true });
  row = session(store, id);
  assert.equal((row.lastActivityAt as Date).getTime(), clock.t);
  await store.update({ status: "stopped", stopReason: "idle" }, { id }, Table.LIVE_SESSIONS);
  assert.equal((await service.heartbeat(1, { active: true })).status, 404, "the page learns that it stopped");
});

test("stop: reason left by default, user when given; idempotent while stopping and when nothing is active", async () => {
  const { service, store } = setup();
  assert.deepEqual(await service.stop(1, {}), { status: 200, data: { id: null, status: "stopped" } });
  const id = (await service.start(1)).data?.id ?? 0;
  assert.deepEqual(await service.stop(1, {}), { status: 200, data: { id, status: "stopping" } });
  assert.deepEqual([session(store, id).status, session(store, id).stopReason], ["stopping", "left"]);
  assert.deepEqual(await service.stop(1, { reason: "user" }), { status: 200, data: { id, status: "stopping" } });
  assert.equal(session(store, id).stopReason, "left", "a second stop keeps the first reason");

  const other = (await service.start(2)).data?.id ?? 0;
  await service.stop(2, { reason: "user" });
  assert.equal(session(store, other).stopReason, "user");
  assert.equal((await service.stop(999, {})).status, 404);
});

test("stopLiveSessionsOfRuns asks running sessions of the runs to stop with reason user", async () => {
  const { service, store } = setup();
  const a = (await service.start(1)).data?.id ?? 0;
  const b = (await service.start(2)).data?.id ?? 0;
  assert.equal(await stopLiveSessionsOfRuns(store as unknown as QueryHandler, []), 0);
  assert.equal(await stopLiveSessionsOfRuns(store as unknown as QueryHandler, [1, 3]), 1);
  assert.deepEqual([session(store, a).status, session(store, a).stopReason], ["stopping", "user"]);
  assert.equal(session(store, b).status, "starting");
});
