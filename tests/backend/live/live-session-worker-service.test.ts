import assert from "node:assert/strict";
import { test } from "node:test";
import { Table } from "../../../backend/src/enums";
import type { LiveHostManagerOptions } from "../../../backend/src/services/live/live-host-manager";
import {
  LIVE_NOTHING_TO_SHOW_MESSAGE,
  LIVE_START_TIMEOUT_MESSAGE,
  LiveSessionWorkerService,
  type LiveHostManagerPort,
  type LiveSessionLimits
} from "../../../backend/src/services/live/live-session-worker-service";
import { PipelineStepError } from "../../../backend/src/types/visualization-pipeline";
import type { LiveHostState } from "../../../backend/src/types/harness-library";
import type { Conditions, QueryHandler } from "../../../backend/src/utilities";
import { makeComponentRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { InMemoryQueryHandler, type Row } from "../helpers/query-handler-stub";

const T0 = Date.parse("2026-03-01T10:00:00Z");
const HARNESS = `import { definePrvisionHarness } from "../harness-api";
import Target from "../../src/components/Button";
export default definePrvisionHarness({ states: [{ name: "Default", render: () => <Target /> }] });
`;
const LIMITS: LiveSessionLimits = {
  pollIntervalMs: 500,
  heartbeatLossMs: 90_000,
  idleTimeoutMs: 600_000,
  maxSessionMs: 4 * 3_600_000,
  startTimeoutMs: 300_000
};

class FakeManager implements LiveHostManagerPort {
  readonly opened: number[] = [];
  stopAllCalls = 0;
  health = 0;
  constructor(private readonly options: LiveHostManagerOptions) {}

  open(componentId: number): { known: boolean; done: Promise<void> } {
    this.opened.push(componentId);
    const known = this.options.plan.groupOf.has(componentId);
    if (known) {
      this.options.onChange(this.snapshot());
    }
    return { known, done: Promise.resolve() };
  }

  checkHealth(): void {
    this.health += 1;
  }

  stopAll(): Promise<void> {
    this.stopAllCalls += 1;
    return Promise.resolve();
  }

  snapshot(): LiveHostState[] {
    return this.opened.map((componentId) => ({
      side: "head",
      groupKey: "none",
      componentIds: [componentId],
      status: "ready",
      origin: "http://127.0.0.1:50001",
      harnessUrlPath: "/.prvision-harness/index.html",
      error: null,
      lastUsedAt: new Date(T0).toISOString()
    }));
  }
}

interface Scenario {
  store: InMemoryQueryHandler;
  clock: { t: number };
  worker: LiveSessionWorkerService;
  managers: FakeManager[];
  cleanups: number;
  recreated: number;
  prepared: number;
  controller: AbortController;
  /** Called once per poll tick (after the tick's work), before the next one. */
  onTick: (tick: number) => Promise<void> | void;
}

function scenario(options: {
  recreate?: () => Promise<void>;
  rows?: Array<ReturnType<typeof makeComponentRow>>;
  sessionStatus?: "starting" | "stopping" | "ready";
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}): Scenario {
  const store = new InMemoryQueryHandler();
  const clock = { t: T0 };
  store.now = () => new Date(clock.t);
  store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 1,
      status: "completed",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      completedAt: new Date(T0)
    })
  ]);
  store.seed(
    Table.VISUALIZATION_COMPONENTS,
    options.rows ?? [
      makeComponentRow({ id: 11, harnessSource: HARNESS }),
      makeComponentRow({ id: 12, filePath: "src/components/Card.tsx", rank: 1, harnessSource: HARNESS })
    ]
  );
  store.seed(Table.LIVE_SESSIONS, [
    {
      id: 7,
      visualizationId: 1,
      status: options.sessionStatus ?? "starting",
      stopReason: options.sessionStatus === "stopping" ? "user" : null,
      jobId: "live-7",
      hosts: [],
      openRequests: [],
      openRequestsVersion: 0,
      lastHeartbeatAt: new Date(T0),
      lastActivityAt: new Date(T0),
      createdAt: new Date(T0),
      updatedAt: new Date(T0)
    }
  ]);
  const state: Scenario = {
    store,
    clock,
    managers: [],
    cleanups: 0,
    recreated: 0,
    prepared: 0,
    controller: new AbortController(),
    onTick: () => undefined,
    worker: undefined as unknown as LiveSessionWorkerService
  };
  let tick = 0;
  state.worker = new LiveSessionWorkerService({
    queryHandler: store as unknown as QueryHandler,
    worktreesRoot: "/tmp/prvision-test-live-worktrees",
    frontendOrigins: ["http://localhost:4210", "http://127.0.0.1:4210"],
    now: () => new Date(clock.t),
    limits: {
      ...LIMITS,
      startTimeoutMs: options.startTimeoutMs ?? LIMITS.startTimeoutMs,
      pollIntervalMs: options.pollIntervalMs ?? LIMITS.pollIntervalMs
    },
    recreator: {
      recreate: async (input) => {
        state.recreated += 1;
        assert.equal(input.rootDir, "/tmp/prvision-test-live-worktrees/live-7");
        await options.recreate?.();
        return {
          workspace: {
            visualizationId: 1,
            repositoryPath: "/repo",
            baseDir: `${input.rootDir}/base`,
            headDir: `${input.rootDir}/head`,
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            sourceType: "local_branch",
            dependencyDrift: false
          },
          cleanup: () => {
            state.cleanups += 1;
            return Promise.resolve();
          }
        };
      }
    },
    createBackend: () => ({
      prepare: () => {
        state.prepared += 1;
        return Promise.resolve();
      },
      start: () => Promise.reject(new Error("not used")),
      close: () => Promise.resolve()
    }),
    createHostManager: (managerOptions) => {
      const manager = new FakeManager(managerOptions);
      state.managers.push(manager);
      return manager;
    },
    sleep: async () => {
      tick += 1;
      if (tick > 1_000) {
        throw new Error("runaway loop");
      }
      await state.onTick(tick);
    }
  });
  return state;
}

function liveRow(store: InMemoryQueryHandler): Row {
  const row = store.row(Table.LIVE_SESSIONS, 7);
  assert.ok(row);
  return row;
}

async function run(s: Scenario): Promise<string> {
  return s.worker.run({ liveSessionId: 7, jobId: "live-7", signal: s.controller.signal });
}

test("the session becomes ready, serves opens, and stops with the API's reason, releasing everything", async () => {
  const s = scenario({});
  const seen: string[] = [];
  s.onTick = async (tick) => {
    const row = liveRow(s.store);
    seen.push(String(row.status));
    if (tick === 1) {
      assert.ok(row.readyAt instanceof Date);
      await s.store.update(
        { openRequests: [{ componentId: 11, requestedAt: new Date(T0).toISOString() }], openRequestsVersion: 1 },
        { id: 7 },
        Table.LIVE_SESSIONS
      );
    }
    if (tick === 3) {
      await s.store.update({ status: "stopping", stopReason: "user" }, { id: 7 }, Table.LIVE_SESSIONS);
    }
  };
  assert.equal(await run(s), "stopped");
  assert.deepEqual(seen.slice(0, 2), ["ready", "ready"]);
  const manager = s.managers[0];
  assert.ok(manager);
  assert.deepEqual(manager.opened, [11]);
  const row = liveRow(s.store);
  assert.equal(row.status, "stopped");
  assert.equal(row.stopReason, "user", "the API's reason stays");
  assert.ok(row.stoppedAt instanceof Date);
  assert.deepEqual(row.openRequests, []);
  assert.equal(row.openRequestsVersion, 2);
  assert.deepEqual(
    (row.hosts as LiveHostState[]).map((host) => host.componentIds),
    [[11]]
  );
  assert.equal(manager.stopAllCalls, 1);
  assert.equal(s.cleanups, 1);
});

test("draining keeps an append made between the read and the write for the next tick", async () => {
  const s = scenario({});
  const original = s.store.update.bind(s.store);
  let raced = false;
  s.store.update = async (values: Record<string, unknown>, conditions: Conditions, table: Table) => {
    if (table === Table.LIVE_SESSIONS && !raced && "openRequestsVersion" in conditions && "openRequests" in values) {
      raced = true; // the API appends component 12 right after the worker read the row
      await original(
        {
          openRequests: [
            { componentId: 11, requestedAt: new Date(T0).toISOString() },
            { componentId: 12, requestedAt: new Date(T0).toISOString() }
          ],
          openRequestsVersion: 2
        },
        { id: 7 },
        Table.LIVE_SESSIONS
      );
    }
    return original(values, conditions, table);
  };
  s.onTick = async (tick) => {
    if (tick === 1) {
      await original(
        { openRequests: [{ componentId: 11, requestedAt: new Date(T0).toISOString() }], openRequestsVersion: 1 },
        { id: 7 },
        Table.LIVE_SESSIONS
      );
    }
    if (tick === 2) {
      assert.deepEqual(s.managers[0]?.opened, [], "the guarded drain missed: nothing taken this tick");
    }
    if (tick === 4) {
      await original({ status: "stopping", stopReason: "user" }, { id: 7 }, Table.LIVE_SESSIONS);
    }
  };
  assert.equal(await run(s), "stopped");
  assert.deepEqual(s.managers[0]?.opened, [11, 12]);
  assert.equal(liveRow(s.store).openRequestsVersion, 3);
});

for (const [label, advance, reason] of [
  ["90 s without heartbeat → left", (s: Scenario) => (s.clock.t += 90_001), "left"],
  [
    "10 minutes without activity → idle",
    async (s: Scenario) => {
      s.clock.t += 600_001;
      await s.store.update({ lastHeartbeatAt: new Date(s.clock.t) }, { id: 7 }, Table.LIVE_SESSIONS);
    },
    "idle"
  ],
  [
    "4 hours → max_duration",
    async (s: Scenario) => {
      s.clock.t += 4 * 3_600_000 + 1;
      await s.store.update(
        { lastHeartbeatAt: new Date(s.clock.t), lastActivityAt: new Date(s.clock.t) },
        { id: 7 },
        Table.LIVE_SESSIONS
      );
    },
    "max_duration"
  ],
  ["worker shutdown → shutdown", (s: Scenario) => s.controller.abort("shutdown"), "shutdown"]
] as const) {
  test(`stop condition: ${label}`, async () => {
    const s = scenario({});
    s.onTick = async (tick) => {
      if (tick === 2) {
        await advance(s);
      }
    };
    assert.equal(await run(s), "stopped");
    const row = liveRow(s.store);
    assert.deepEqual([row.status, row.stopReason], ["stopped", reason]);
    assert.equal(s.managers[0]?.stopAllCalls, 1);
    assert.equal(s.cleanups, 1);
  });
}

test("89 s without heartbeat and 9 minutes idle keep the session running", async () => {
  const s = scenario({});
  s.onTick = async (tick) => {
    if (tick === 1) {
      s.clock.t += 89_000;
    }
    if (tick === 2) {
      await s.store.update({ lastHeartbeatAt: new Date(s.clock.t) }, { id: 7 }, Table.LIVE_SESSIONS);
      s.clock.t += 540_000 - 89_000 - 1;
      await s.store.update({ lastHeartbeatAt: new Date(s.clock.t) }, { id: 7 }, Table.LIVE_SESSIONS);
    }
    if (tick === 3) {
      assert.equal(liveRow(s.store).status, "ready");
      await s.store.update({ status: "stopping", stopReason: "left" }, { id: 7 }, Table.LIVE_SESSIONS);
    }
  };
  assert.equal(await run(s), "stopped");
  assert.equal(liveRow(s.store).stopReason, "left");
});

test("a failure while preparing ends failed with the user message, and nothing is left behind", async () => {
  const s = scenario({
    recreate: () => Promise.reject(new PipelineStepError("preparing", "Commit aaaaaaa is no longer in the clone."))
  });
  assert.equal(await run(s), "failed");
  const row = liveRow(s.store);
  assert.deepEqual(
    [row.status, row.stopReason, row.errorMessage],
    ["failed", "error", "Commit aaaaaaa is no longer in the clone."]
  );
  assert.ok(row.stoppedAt instanceof Date);
  assert.equal(s.managers.length, 0);
});

test("a run without harness snapshots fails; the recreated worktrees are cleaned up", async () => {
  const s = scenario({ rows: [makeComponentRow({ id: 11, harnessSource: null })] });
  assert.equal(await run(s), "failed");
  assert.equal(liveRow(s.store).errorMessage, LIVE_NOTHING_TO_SHOW_MESSAGE);
  assert.equal(s.cleanups, 1);
});

test("preparing longer than the start timeout fails with the timeout message", async () => {
  const s = scenario({
    startTimeoutMs: 20,
    recreate: () => new Promise((resolve) => setTimeout(resolve, 60))
  });
  assert.equal(await run(s), "failed");
  assert.equal(liveRow(s.store).errorMessage, LIVE_START_TIMEOUT_MESSAGE);
  assert.equal(s.cleanups, 1);
});

test("an unexpected error in the loop ends failed; hosts and worktrees are still released", async () => {
  const s = scenario({});
  s.onTick = (tick) => {
    if (tick === 1) {
      throw new Error("boom");
    }
  };
  assert.equal(await run(s), "failed");
  const row = liveRow(s.store);
  assert.equal(row.status, "failed");
  assert.equal(row.errorMessage, "Live mode failed unexpectedly. See the worker log for details.");
  assert.equal(s.managers[0]?.stopAllCalls, 1);
  assert.equal(s.cleanups, 1);
});

test("a session stopped by the API before the job ran is closed without preparing anything", async () => {
  const s = scenario({ sessionStatus: "stopping" });
  assert.equal(await run(s), "stopped");
  const row = liveRow(s.store);
  assert.deepEqual([row.status, row.stopReason], ["stopped", "user"]);
  assert.equal(s.recreated, 0);
});

test("a session that is not starting is skipped untouched", async () => {
  const s = scenario({ sessionStatus: "ready" });
  assert.equal(await run(s), "skipped");
  assert.equal(liveRow(s.store).status, "ready");
  assert.equal(await s.worker.run({ liveSessionId: 99, jobId: "live-99", signal: s.controller.signal }), "skipped");
});

test("an API stop while the worktrees are being prepared aborts the start and keeps the API's reason", async () => {
  let store: InMemoryQueryHandler | null = null;
  const s = scenario({
    pollIntervalMs: 10,
    recreate: async () => {
      await store?.update({ status: "stopping", stopReason: "left" }, { id: 7 }, Table.LIVE_SESSIONS);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  store = s.store;
  assert.equal(await run(s), "stopped");
  const row = liveRow(s.store);
  assert.deepEqual([row.status, row.stopReason, row.readyAt ?? null], ["stopped", "left", null]);
  assert.equal(s.prepared, 0);
  assert.equal(s.cleanups, 1);
});
