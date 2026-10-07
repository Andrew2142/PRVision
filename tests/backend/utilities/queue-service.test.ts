import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, test } from "node:test";
import { RedisPool } from "../../../backend/src/utilities/services/redis-pool";
import {
  JobAbortedError,
  QueueService,
  jobAbortReason,
  throwIfJobAborted,
  type LibraryJob,
  type LiveSessionJob,
  type VisualizationJob
} from "../../../backend/src/utilities/services/queue-service";
import { patchStaticMethod } from "../helpers/test-context";

type JobLike = { id?: string; data: unknown };
type Processor = (job: JobLike) => Promise<void>;

interface FakeJob {
  state: string;
  removed: boolean;
  getState(): Promise<string>;
  remove(): Promise<void>;
}

class FakeQueue {
  readonly added: Array<{ name: string; data: unknown; options: Record<string, unknown> }> = [];
  readonly jobs = new Map<string, FakeJob>();
  closed = false;
  readyError: Error | null = null;
  closeError: Error | null = null;
  constructor(
    readonly name: string,
    readonly options: Record<string, unknown>,
    private readonly order: string[]
  ) {}
  waitUntilReady(): Promise<void> {
    return this.readyError ? Promise.reject(this.readyError) : Promise.resolve();
  }
  add(name: string, data: unknown, options: Record<string, unknown>): Promise<void> {
    this.added.push({ name, data, options });
    return Promise.resolve();
  }
  getJob(jobId: string): Promise<FakeJob | undefined> {
    return Promise.resolve(this.jobs.get(jobId));
  }
  close(): Promise<void> {
    this.order.push("queue");
    this.closed = true;
    return this.closeError ? Promise.reject(this.closeError) : Promise.resolve();
  }
}

class FakeWorker {
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  closeCalls: boolean[] = [];
  constructor(
    readonly name: string,
    readonly processor: Processor,
    readonly options: Record<string, unknown>,
    private readonly order: string[]
  ) {}
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, handler);
    return this;
  }
  close(force = false): Promise<void> {
    this.order.push("worker");
    this.closeCalls.push(force);
    return Promise.resolve();
  }
}

type QueueServiceInternals = {
  createQueue: (name: string, options: Record<string, unknown>) => FakeQueue;
  createWorker: (name: string, processor: Processor, options: Record<string, unknown>) => FakeWorker;
};

function fakeJob(state: string): FakeJob {
  return {
    state,
    removed: false,
    getState() {
      return Promise.resolve(this.state);
    },
    remove() {
      this.removed = true;
      return Promise.resolve();
    }
  };
}

let order: string[] = [];
let queues: FakeQueue[] = [];
let workers: FakeWorker[] = [];
let redisKeys: Map<string, string>;
let redisCalls: unknown[][];
let existsImpl: ((key: string) => Promise<number>) | null;
const restores: Array<() => void> = [];

beforeEach(() => {
  order = [];
  queues = [];
  workers = [];
  redisKeys = new Map();
  redisCalls = [];
  existsImpl = null;
  const internals = QueueService as unknown as QueueServiceInternals;
  restores.push(
    patchStaticMethod(internals, "createQueue", (name, options) => {
      const queue = new FakeQueue(name, options, order);
      queues.push(queue);
      return queue;
    }),
    patchStaticMethod(internals, "createWorker", (name, processor, options) => {
      const worker = new FakeWorker(name, processor, options, order);
      workers.push(worker);
      return worker;
    }),
    patchStaticMethod(RedisPool, "getConnection", (() => ({
      set: (...args: unknown[]) => {
        redisCalls.push(["set", ...args]);
        redisKeys.set(String(args[0]), String(args[1]));
        return Promise.resolve("OK");
      },
      exists: (key: string) => {
        redisCalls.push(["exists", key]);
        return existsImpl ? existsImpl(key) : Promise.resolve(redisKeys.has(key) ? 1 : 0);
      },
      del: (key: string) => {
        redisCalls.push(["del", key]);
        redisKeys.delete(key);
        return Promise.resolve(1);
      }
    })) as unknown as typeof RedisPool.getConnection)
  );
});

afterEach(async () => {
  await QueueService.close().catch(() => undefined);
  while (restores.length > 0) {
    restores.pop()?.();
  }
});

/** Starts the worker with a processor that records its argument and waits until released. */
async function startRecordingWorker(): Promise<{ jobs: VisualizationJob[]; release: () => void; worker: FakeWorker }> {
  const jobs: VisualizationJob[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await QueueService.startVisualizationWorker(async (job) => {
    jobs.push(job);
    await Promise.race([
      released,
      new Promise<void>((resolve) => job.signal.addEventListener("abort", () => resolve()))
    ]);
  });
  return { jobs, release, worker: workers[0]! };
}

test("QueueService.initialize creates the visualizations queue with prefix prvision and a fail-fast connection", async () => {
  await QueueService.initialize();
  await QueueService.initialize(); // idempotent
  // 16 §6.15: all four queues are opened (the API enqueues to every one of them).
  assert.deepEqual(
    queues.map((queue) => queue.name),
    ["visualizations", "harness-scans", "harness-repairs", "live-sessions"]
  );
  assert.equal(queues[0]!.name, "visualizations");
  for (const queue of queues) {
    assert.equal(queue.options.prefix, "prvision", queue.name);
    assert.equal((queue.options.connection as { maxRetriesPerRequest: unknown }).maxRetriesPerRequest, 1, queue.name);
  }
  assert.equal(QueueService.isInitialized(), true);
});

test("QueueService.initialize failure closes partial resources and rethrows", async () => {
  const internals = QueueService as unknown as QueueServiceInternals;
  restores.push(
    patchStaticMethod(internals, "createQueue", (name, options) => {
      const queue = new FakeQueue(name, options, order);
      queue.readyError = new Error("redis down");
      queues.push(queue);
      return queue;
    })
  );
  await assert.rejects(QueueService.initialize(), /redis down/);
  assert.equal(queues[0]!.closed, true);
  assert.equal(QueueService.isInitialized(), false);
});

test("QueueService.enqueueVisualization uses jobId viz-<id>, name visualize, attempts 1", async () => {
  await QueueService.initialize();
  assert.deepEqual(await QueueService.enqueueVisualization(5), { jobId: "viz-5", alreadyQueued: false });
  const added = queues[0]!.added[0]!;
  assert.equal(added.name, "visualize");
  assert.deepEqual(added.data, { visualizationId: 5 });
  assert.equal(added.options.jobId, "viz-5");
  assert.equal(added.options.attempts, 1);
  assert.ok(added.options.removeOnComplete);
  assert.ok(added.options.removeOnFail);
});

test("QueueService.enqueueVisualization returns alreadyQueued when the job exists and does not add", async () => {
  await QueueService.initialize();
  queues[0]!.jobs.set("viz-6", fakeJob("active"));
  assert.deepEqual(await QueueService.enqueueVisualization(6), { jobId: "viz-6", alreadyQueued: true });
  assert.equal(queues[0]!.added.length, 0);
});

test("QueueService.enqueueVisualization before initialize throws", async () => {
  await assert.rejects(QueueService.enqueueVisualization(1), /must be initialized/);
});

test("QueueService.startVisualizationWorker uses concurrency 1, lockDuration 300000 and maxStalledCount 0", async () => {
  await QueueService.startVisualizationWorker(() => Promise.resolve());
  await QueueService.startVisualizationWorker(() => Promise.resolve()); // idempotent
  assert.equal(workers.length, 1);
  const options = workers[0]!.options;
  assert.equal(workers[0]!.name, "visualizations");
  assert.equal(options.prefix, "prvision");
  assert.equal(options.concurrency, 1);
  assert.equal(options.lockDuration, 300_000);
  assert.equal(options.maxStalledCount, 0);
  assert.equal((options.connection as { maxRetriesPerRequest: unknown }).maxRetriesPerRequest, null);
});

test("QueueService processor receives { visualizationId, jobId, signal }; invalid job data fails the job", async () => {
  const received: VisualizationJob[] = [];
  await QueueService.startVisualizationWorker((job) => {
    received.push(job);
    return Promise.resolve();
  });
  await workers[0]!.processor({ id: "viz-9", data: { visualizationId: 9 } });
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]!).sort(), ["jobId", "signal", "visualizationId"]);
  assert.equal(received[0]!.visualizationId, 9);
  assert.equal(received[0]!.jobId, "viz-9");
  assert.ok(received[0]!.signal instanceof AbortSignal);
  assert.equal(received[0]!.signal.aborted, false);

  for (const data of [{}, { visualizationId: "9" }, { visualizationId: 0 }, null]) {
    await assert.rejects(workers[0]!.processor({ id: "viz-x", data }), /Invalid visualization job data/);
  }
  assert.equal(received.length, 1);
});

test('QueueService cancel flag aborts the signal with reason "cancelled"', async () => {
  const { jobs, worker } = await startRecordingWorker();
  const running = worker.processor({ id: "viz-11", data: { visualizationId: 11 } });
  await delay(50);
  assert.equal(jobs[0]!.signal.aborted, false);
  await QueueService.requestCancel(11);
  await running; // the processor returns once its signal aborts (poll every CANCEL_POLL_INTERVAL_MS)
  assert.equal(jobs[0]!.signal.aborted, true);
  assert.equal(jobs[0]!.signal.reason, "cancelled");
  assert.equal(jobAbortReason(jobs[0]!.signal), "cancelled");
});

test("QueueService a cancel flag set before the job started aborts at once", async () => {
  await QueueService.requestCancel(12);
  const { jobs, worker } = await startRecordingWorker();
  const startedAt = Date.now();
  await worker.processor({ id: "viz-12", data: { visualizationId: 12 } });
  assert.ok(Date.now() - startedAt < 500, "must not wait for the first interval");
  assert.equal(jobs[0]!.signal.reason, "cancelled");
});

test("QueueService skips overlapping polls while one is in flight", async () => {
  let pending = 0;
  existsImpl = () => {
    pending += 1;
    return new Promise<number>(() => undefined); // never settles: the first poll stays in flight
  };
  const { worker, release } = await startRecordingWorker();
  const running = worker.processor({ id: "viz-13", data: { visualizationId: 13 } });
  await delay(2_300); // initial poll + two interval ticks
  assert.equal(pending, 1);
  release();
  await running;
});

test('QueueService.close aborts active jobs with reason "shutdown", closes worker before queue, resets state, aggregates failures', async () => {
  const { jobs, worker } = await startRecordingWorker();
  const running = worker.processor({ id: "viz-14", data: { visualizationId: 14 } });
  await delay(20);
  queues[0]!.closeError = new Error("queue close boom");
  await assert.rejects(
    QueueService.close(),
    /^Error: Failed to close queue resources: queue visualizations: queue close boom$/
  );
  await running;
  assert.equal(jobs[0]!.signal.reason, "shutdown");
  // 16 §6.15: every queue is closed after the worker, even when the first close fails.
  assert.deepEqual(order, ["worker", "queue", "queue", "queue", "queue"]);
  assert.ok(queues.every((queue) => queue.closed));
  assert.deepEqual(worker.closeCalls, [false]);
  assert.equal(QueueService.isInitialized(), false);
  await assert.rejects(QueueService.enqueueVisualization(1), /must be initialized/);
});

test("QueueService.close is a no-op when never initialized", async () => {
  await QueueService.close();
  assert.deepEqual(order, []);
});

test('jobAbortReason and throwIfJobAborted map "cancelled"/"shutdown" and pass a TimeoutError through', () => {
  const live = new AbortController();
  assert.equal(jobAbortReason(live.signal), null);
  throwIfJobAborted(live.signal);

  for (const reason of ["cancelled", "shutdown"] as const) {
    const controller = new AbortController();
    controller.abort(reason);
    assert.equal(jobAbortReason(controller.signal), reason);
    assert.throws(
      () => throwIfJobAborted(controller.signal),
      (error: unknown) => error instanceof JobAbortedError && error.reason === reason
    );
  }

  const timeout = new AbortController();
  timeout.abort(new DOMException("The operation timed out", "TimeoutError"));
  assert.equal(jobAbortReason(timeout.signal), null);
  assert.throws(
    () => throwIfJobAborted(timeout.signal),
    (error: unknown) => (error as Error).name === "TimeoutError"
  );
});

test("QueueService queue uses maxRetriesPerRequest 1 and the worker null", () => {
  assert.equal(RedisPool.getQueueConnectionOptions().maxRetriesPerRequest, 1);
  assert.equal(RedisPool.getWorkerConnectionOptions().maxRetriesPerRequest, null);
});

test("QueueService.requestCancel sets prvision:cancel:<id> with EX 86400; clearCancel deletes it", async () => {
  await QueueService.requestCancel(21);
  assert.deepEqual(redisCalls[0], ["set", "prvision:cancel:21", "1", "EX", 86_400]);
  assert.equal(await QueueService.isCancelRequested(21), true);
  await QueueService.clearCancel(21);
  assert.equal(await QueueService.isCancelRequested(21), false);
});

test("QueueService.removeQueuedVisualization only removes waiting/delayed jobs", async () => {
  await QueueService.initialize();
  const states = ["waiting", "delayed", "prioritized", "active", "completed", "failed"];
  states.forEach((state, index) => queues[0]!.jobs.set(`viz-${index + 1}`, fakeJob(state)));
  const removed = [];
  for (let index = 0; index < states.length; index += 1) {
    removed.push(await QueueService.removeQueuedVisualization(index + 1));
  }
  assert.deepEqual(removed, [true, true, true, false, false, false]);
  assert.equal(await QueueService.removeQueuedVisualization(99), false);
  assert.equal(await QueueService.getVisualizationJobState(4), "active");
  assert.equal(await QueueService.getVisualizationJobState(99), "missing");
});

// ---------------------------------------------------------------------------------------------------------------
// Sheet 16 §6.15: harness library jobs and live sessions
// ---------------------------------------------------------------------------------------------------------------

function queueNamed(name: string): FakeQueue {
  const queue = queues.find((candidate) => candidate.name === name);
  assert.ok(queue, `queue ${name}`);
  return queue;
}

function workerNamed(name: string): FakeWorker {
  const worker = workers.find((candidate) => candidate.name === name);
  assert.ok(worker, `worker ${name}`);
  return worker;
}

test("QueueService.libraryJobId and liveSessionJobId: scan-<id> for scan and rescan, repair-<id>, live-<id>", () => {
  assert.equal(QueueService.libraryJobId("scan", 4), "scan-4");
  assert.equal(QueueService.libraryJobId("rescan", 4), "scan-4");
  assert.equal(QueueService.libraryJobId("repair", 4), "repair-4");
  assert.equal(QueueService.liveSessionJobId(9), "live-9");
});

test("QueueService.enqueueLibraryJob puts scans and rescans on harness-scans and repairs on harness-repairs", async () => {
  await QueueService.initialize();
  assert.deepEqual(await QueueService.enqueueLibraryJob("scan", 3), { jobId: "scan-3", alreadyQueued: false });
  assert.deepEqual(await QueueService.enqueueLibraryJob("rescan", 5), { jobId: "scan-5", alreadyQueued: false });
  assert.deepEqual(await QueueService.enqueueLibraryJob("repair", 6), { jobId: "repair-6", alreadyQueued: false });
  const scans = queueNamed("harness-scans").added;
  assert.deepEqual(
    scans.map((job) => [job.name, job.data, job.options.jobId, job.options.attempts]),
    [
      ["scan", { libraryJobId: 3 }, "scan-3", 1],
      ["scan", { libraryJobId: 5 }, "scan-5", 1]
    ]
  );
  const repairs = queueNamed("harness-repairs").added;
  assert.deepEqual(
    repairs.map((job) => [job.name, job.data, job.options.jobId, job.options.attempts]),
    [["repair", { libraryJobId: 6 }, "repair-6", 1]]
  );
  assert.ok(repairs[0]?.options.removeOnComplete);
  assert.ok(repairs[0].options.removeOnFail);
  assert.equal(queueNamed("visualizations").added.length, 0);
  assert.equal(queueNamed("live-sessions").added.length, 0);

  queueNamed("harness-repairs").jobs.set("repair-8", fakeJob("active"));
  assert.deepEqual(await QueueService.enqueueLibraryJob("repair", 8), { jobId: "repair-8", alreadyQueued: true });
  assert.equal(queueNamed("harness-repairs").added.length, 1);
  await assert.rejects(QueueService.enqueueLibraryJob("scan", 0), /Invalid library job data/);
});

test("QueueService.removeQueuedLibraryJob and getLibraryJobState use the queue of the kind", async () => {
  await QueueService.initialize();
  queueNamed("harness-scans").jobs.set("scan-1", fakeJob("waiting"));
  queueNamed("harness-scans").jobs.set("scan-2", fakeJob("active"));
  queueNamed("harness-repairs").jobs.set("repair-3", fakeJob("delayed"));
  assert.equal(await QueueService.getLibraryJobState("rescan", 1), "waiting");
  assert.equal(await QueueService.getLibraryJobState("repair", 1), "missing");
  assert.equal(await QueueService.removeQueuedLibraryJob("scan", 2), false);
  assert.equal(await QueueService.removeQueuedLibraryJob("scan", 1), true);
  assert.equal(await QueueService.removeQueuedLibraryJob("repair", 3), true);
  assert.equal(await QueueService.removeQueuedLibraryJob("repair", 99), false);
});

test("QueueService library and live methods before initialize throw", async () => {
  await assert.rejects(QueueService.enqueueLibraryJob("scan", 1), /must be initialized/);
  await assert.rejects(QueueService.getLibraryJobState("repair", 1), /must be initialized/);
  await assert.rejects(QueueService.enqueueLiveSession(1), /must be initialized/);
  await assert.rejects(QueueService.getLiveSessionJobState(1), /must be initialized/);
});

test("QueueService.requestLibraryCancel sets prvision:library-cancel:<id> with EX 86400; clearLibraryCancel deletes it", async () => {
  await QueueService.requestLibraryCancel(31);
  assert.deepEqual(redisCalls[0], ["set", "prvision:library-cancel:31", "1", "EX", 86_400]);
  assert.equal(await QueueService.isLibraryCancelRequested(31), true);
  assert.equal(await QueueService.isCancelRequested(31), false, "visualization and library flags are separate");
  await QueueService.clearLibraryCancel(31);
  assert.equal(await QueueService.isLibraryCancelRequested(31), false);
});

test("QueueService library workers: concurrency 1, lockDuration 300000, maxStalledCount 0; idempotent start", async () => {
  await QueueService.startLibraryScanWorker(() => Promise.resolve());
  await QueueService.startLibraryScanWorker(() => Promise.resolve());
  await QueueService.startLibraryRepairWorker(() => Promise.resolve());
  await QueueService.startLibraryRepairWorker(() => Promise.resolve());
  assert.deepEqual(
    workers.map((worker) => worker.name),
    ["harness-scans", "harness-repairs"]
  );
  for (const worker of workers) {
    assert.equal(worker.options.prefix, "prvision", worker.name);
    assert.equal(worker.options.concurrency, 1, worker.name);
    assert.equal(worker.options.lockDuration, 300_000, worker.name);
    assert.equal(worker.options.maxStalledCount, 0, worker.name);
    assert.equal((worker.options.connection as { maxRetriesPerRequest: unknown }).maxRetriesPerRequest, null);
  }
});

test("QueueService library processor receives { libraryJobId, jobId, signal }; invalid data fails the job", async () => {
  const received: LibraryJob[] = [];
  await QueueService.startLibraryRepairWorker((job) => {
    received.push(job);
    return Promise.resolve();
  });
  await workerNamed("harness-repairs").processor({ id: "repair-4", data: { libraryJobId: 4 } });
  assert.deepEqual(Object.keys(received[0]!).sort(), ["jobId", "libraryJobId", "signal"]);
  assert.equal(received[0]!.libraryJobId, 4);
  assert.equal(received[0]!.jobId, "repair-4");
  assert.equal(received[0]!.signal.aborted, false);
  for (const data of [{}, { libraryJobId: "4" }, { visualizationId: 4 }, null]) {
    await assert.rejects(
      workerNamed("harness-repairs").processor({ id: "repair-x", data }),
      /Invalid library job data/
    );
  }
});

test('QueueService the library cancel flag aborts a scan job with reason "cancelled"', async () => {
  const jobs: LibraryJob[] = [];
  await QueueService.startLibraryScanWorker(async (job) => {
    jobs.push(job);
    await new Promise<void>((resolve) => job.signal.addEventListener("abort", () => resolve()));
  });
  const running = workerNamed("harness-scans").processor({ id: "scan-12", data: { libraryJobId: 12 } });
  await delay(50);
  await QueueService.requestCancel(12); // the visualization flag of the same number must not cancel it
  await delay(1_200);
  assert.equal(jobs[0]!.signal.aborted, false);
  await QueueService.requestLibraryCancel(12);
  await running;
  assert.equal(jobs[0]!.signal.reason, "cancelled");
  assert.equal(jobAbortReason(jobs[0]!.signal), "cancelled");
});

test("QueueService.enqueueLiveSession puts job live-<id> on live-sessions; the worker runs LIVE_MAX_SESSIONS at once", async () => {
  await QueueService.initialize();
  assert.deepEqual(await QueueService.enqueueLiveSession(7), { jobId: "live-7", alreadyQueued: false });
  const added = queueNamed("live-sessions").added[0]!;
  assert.equal(added.name, "live");
  assert.deepEqual(added.data, { liveSessionId: 7 });
  assert.equal(added.options.jobId, "live-7");
  assert.equal(added.options.attempts, 1);
  assert.equal(await QueueService.getLiveSessionJobState(7), "missing"); // the fake records adds without jobs
  queueNamed("live-sessions").jobs.set("live-7", fakeJob("active"));
  assert.equal(await QueueService.getLiveSessionJobState(7), "active");
  assert.deepEqual(await QueueService.enqueueLiveSession(7), { jobId: "live-7", alreadyQueued: true });

  const received: LiveSessionJob[] = [];
  await QueueService.startLiveSessionWorker((job) => {
    received.push(job);
    return Promise.resolve();
  });
  const worker = workerNamed("live-sessions");
  assert.equal(worker.options.concurrency, 2);
  assert.equal(worker.options.lockDuration, 300_000);
  assert.equal(worker.options.maxStalledCount, 0);
  await worker.processor({ id: "live-7", data: { liveSessionId: 7 } });
  assert.deepEqual(Object.keys(received[0]!).sort(), ["jobId", "liveSessionId", "signal"]);
  assert.equal(received[0]!.jobId, "live-7");
  await assert.rejects(
    worker.processor({ id: "live-x", data: { liveSessionId: -1 } }),
    /Invalid live session job data/
  );
});

test('QueueService.close aborts active library and live jobs with "shutdown" and closes every worker and queue', async () => {
  const library: LibraryJob[] = [];
  const live: LiveSessionJob[] = [];
  const waitForAbort = (signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
  await QueueService.startLibraryScanWorker(async (job) => {
    library.push(job);
    await waitForAbort(job.signal);
  });
  await QueueService.startLibraryRepairWorker(async (job) => {
    library.push(job);
    await waitForAbort(job.signal);
  });
  await QueueService.startLiveSessionWorker(async (job) => {
    live.push(job);
    await waitForAbort(job.signal);
  });
  const running = [
    workerNamed("harness-scans").processor({ id: "scan-1", data: { libraryJobId: 1 } }),
    workerNamed("harness-repairs").processor({ id: "repair-2", data: { libraryJobId: 2 } }),
    workerNamed("live-sessions").processor({ id: "live-3", data: { liveSessionId: 3 } })
  ];
  await delay(20);
  await QueueService.close();
  await Promise.all(running);
  assert.deepEqual(
    [...library, ...live].map((job) => job.signal.reason),
    ["shutdown", "shutdown", "shutdown"]
  );
  assert.deepEqual(order, ["worker", "worker", "worker", "queue", "queue", "queue", "queue"]);
  assert.ok(workers.every((worker) => worker.closeCalls.length === 1));
  assert.ok(queues.every((queue) => queue.closed));
  assert.equal(QueueService.isInitialized(), false);
  await assert.rejects(QueueService.enqueueLibraryJob("scan", 1), /must be initialized/);
});
