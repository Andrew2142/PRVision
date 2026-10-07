import { setTimeout as delay } from "node:timers/promises";
import {
  Queue,
  Worker,
  type Job,
  type JobsOptions,
  type Processor,
  type QueueOptions,
  type WorkerOptions
} from "bullmq";
import {
  CANCEL_KEY_PREFIX,
  CANCEL_KEY_TTL_SECONDS,
  CANCEL_POLL_INTERVAL_MS,
  JOB_RETENTION,
  LIBRARY_CANCEL_KEY_PREFIX,
  LIBRARY_REPAIR_JOB,
  LIBRARY_REPAIR_JOB_ID_PREFIX,
  LIBRARY_REPAIR_QUEUE,
  LIBRARY_REPAIR_WORKER_CONCURRENCY,
  LIBRARY_SCAN_JOB,
  LIBRARY_SCAN_JOB_ID_PREFIX,
  LIBRARY_SCAN_QUEUE,
  LIBRARY_SCAN_WORKER_CONCURRENCY,
  LIVE_MAX_SESSIONS,
  LIVE_SESSION_JOB,
  LIVE_SESSION_JOB_ID_PREFIX,
  LIVE_SESSION_QUEUE,
  QUEUE_PREFIX,
  VISUALIZATION_JOB,
  VISUALIZATION_JOB_ATTEMPTS,
  VISUALIZATION_JOB_ID_PREFIX,
  VISUALIZATION_QUEUE,
  VISUALIZATION_WORKER_CONCURRENCY,
  WORKER_CLOSE_TIMEOUT_MS,
  WORKER_LOCK_DURATION_MS,
  WORKER_MAX_STALLED_COUNT
} from "../../config-consts";
import { getErrorMessage } from "../helpers/error-message";
import { createLogger } from "../loggers/logger";
import { RedisPool } from "./redis-pool";

const log = createLogger("queue");

/** BullMQ job payload (00 §10). */
export interface VisualizationJobData {
  visualizationId: number;
}

export type JobAbortReason = "cancelled" | "shutdown";

/** What the injected processor receives (00 §14.6). */
export interface VisualizationJob {
  visualizationId: number;
  jobId: string;
  /** Aborted with reason "cancelled" (user cancel) or "shutdown" (worker stopping). */
  signal: AbortSignal;
}

/** The pipeline entry point injected by worker.ts (00 §14.6). */
export type VisualizationJobProcessor = (job: VisualizationJob) => Promise<void>;

/** @deprecated name kept for sheets written against Revision 1; identical to VisualizationJob. */
export type VisualizationJobContext = VisualizationJob;

/** Error form of an abort, for code that must throw an Error (01 §5.7: throw only Error instances). */
export class JobAbortedError extends Error {
  constructor(readonly reason: JobAbortReason) {
    super(reason === "cancelled" ? "Visualization cancelled by user" : "Worker shutting down");
    this.name = "JobAbortedError";
  }
}

/** "cancelled" | "shutdown" when the signal was aborted by QueueService, otherwise null (not aborted, or a timeout). */
export function jobAbortReason(signal: AbortSignal): JobAbortReason | null {
  const reason: unknown = signal.reason;
  return signal.aborted && (reason === "cancelled" || reason === "shutdown") ? reason : null;
}

/** Throws JobAbortedError for a QueueService abort, or the signal's own reason (e.g. a TimeoutError) otherwise. */
export function throwIfJobAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const reason = jobAbortReason(signal);
  if (reason !== null) {
    throw new JobAbortedError(reason);
  }
  signal.throwIfAborted();
}

/**
 * Validates BullMQ job data.
 *
 * @throws Error("Invalid visualization job data") unless it is an object with an integer visualizationId > 0.
 */
export function parseVisualizationJobData(input: unknown): VisualizationJobData {
  const visualizationId = positiveIdField(input, "visualizationId");
  if (visualizationId === null) {
    throw new Error("Invalid visualization job data");
  }
  return { visualizationId };
}

// ---- Harness library jobs and live sessions (16 §6.15) ----

/** Kind of a harness library job; scan and rescan share the `harness-scans` queue. */
export type LibraryJobQueueKind = "scan" | "rescan" | "repair";

/** BullMQ payload of a scan, rescan or repair job. */
export interface LibraryJobData {
  libraryJobId: number;
}

/** What an injected library job processor receives. `signal` aborts with "cancelled" or "shutdown". */
export interface LibraryJob {
  libraryJobId: number;
  jobId: string;
  signal: AbortSignal;
}

export type LibraryJobProcessor = (job: LibraryJob) => Promise<void>;

/** BullMQ payload of a live session job. */
export interface LiveSessionJobData {
  liveSessionId: number;
}

/** What the injected live session processor receives. `signal` aborts with "shutdown" only (stop goes through the row). */
export interface LiveSessionJob {
  liveSessionId: number;
  jobId: string;
  signal: AbortSignal;
}

export type LiveSessionJobProcessor = (job: LiveSessionJob) => Promise<void>;

/** @throws Error("Invalid library job data") unless it is an object with an integer libraryJobId > 0. */
export function parseLibraryJobData(input: unknown): LibraryJobData {
  const libraryJobId = positiveIdField(input, "libraryJobId");
  if (libraryJobId === null) {
    throw new Error("Invalid library job data");
  }
  return { libraryJobId };
}

/** @throws Error("Invalid live session job data") unless it is an object with an integer liveSessionId > 0. */
export function parseLiveSessionJobData(input: unknown): LiveSessionJobData {
  const liveSessionId = positiveIdField(input, "liveSessionId");
  if (liveSessionId === null) {
    throw new Error("Invalid live session job data");
  }
  return { liveSessionId };
}

function positiveIdField(input: unknown, field: string): number | null {
  if (typeof input === "object" && input !== null && field in input) {
    const value: unknown = (input as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
}

type ActiveJobEntry = { controller: AbortController; cancelTimer: NodeJS.Timeout; polling: boolean };

/** Cancel-flag polling target: which flag an active job watches. */
type CancelFlag = { keyPrefix: string; id: number };

type AnyQueue = Queue<VisualizationJobData> | Queue<LibraryJobData> | Queue<LiveSessionJobData>;
type AnyWorker = Worker<VisualizationJobData> | Worker<LibraryJobData> | Worker<LiveSessionJobData>;

/**
 * BullMQ wiring (00 §10, §14.6, §21 item 7): the `visualizations` queue plus the `harness-scans`, `harness-repairs`
 * and `live-sessions` queues of sheet 16 §6.15. Rewritten from Uply-v2's QueueService: all-or-nothing initialize,
 * idempotent worker start, aggregated close. Processors are injected by worker.ts, so utilities never import
 * pipeline services. QueueService stays the only BullMQ owner.
 */
export class QueueService {
  private static queue: Queue<VisualizationJobData> | null = null;
  private static scanQueue: Queue<LibraryJobData> | null = null;
  private static repairQueue: Queue<LibraryJobData> | null = null;
  private static liveQueue: Queue<LiveSessionJobData> | null = null;
  private static worker: Worker<VisualizationJobData> | null = null;
  private static scanWorker: Worker<LibraryJobData> | null = null;
  private static repairWorker: Worker<LibraryJobData> | null = null;
  private static liveWorker: Worker<LiveSessionJobData> | null = null;
  private static initialized = false;
  private static readonly activeJobs = new Map<number, ActiveJobEntry>();
  private static readonly activeLibraryJobs = new Map<number, ActiveJobEntry>();
  private static readonly activeLiveJobs = new Map<number, AbortController>();

  /** `viz-<visualizationId>`: the idempotent BullMQ job id. */
  static visualizationJobId(visualizationId: number): string {
    return `${VISUALIZATION_JOB_ID_PREFIX}${visualizationId}`;
  }

  /** `scan-<id>` for scan and rescan jobs, `repair-<id>` for repair jobs (16 §6.15). */
  static libraryJobId(kind: LibraryJobQueueKind, libraryJobId: number): string {
    return `${kind === "repair" ? LIBRARY_REPAIR_JOB_ID_PREFIX : LIBRARY_SCAN_JOB_ID_PREFIX}${libraryJobId}`;
  }

  /** `live-<liveSessionId>`. */
  static liveSessionJobId(liveSessionId: number): string {
    return `${LIVE_SESSION_JOB_ID_PREFIX}${liveSessionId}`;
  }

  /**
   * Opens all four queues (the API enqueues, the worker processes). Idempotent; all-or-nothing (a failure closes
   * what was opened and rethrows).
   */
  static async initialize(): Promise<void> {
    if (QueueService.initialized) {
      return;
    }
    try {
      const options = (): QueueOptions => ({
        connection: RedisPool.getQueueConnectionOptions(),
        prefix: QUEUE_PREFIX
      });
      const queue = QueueService.createQueue<VisualizationJobData>(VISUALIZATION_QUEUE, options());
      QueueService.queue = queue;
      const scanQueue = QueueService.createQueue<LibraryJobData>(LIBRARY_SCAN_QUEUE, options());
      QueueService.scanQueue = scanQueue;
      const repairQueue = QueueService.createQueue<LibraryJobData>(LIBRARY_REPAIR_QUEUE, options());
      QueueService.repairQueue = repairQueue;
      const liveQueue = QueueService.createQueue<LiveSessionJobData>(LIVE_SESSION_QUEUE, options());
      QueueService.liveQueue = liveQueue;
      await Promise.all([
        queue.waitUntilReady(),
        scanQueue.waitUntilReady(),
        repairQueue.waitUntilReady(),
        liveQueue.waitUntilReady()
      ]);
      QueueService.initialized = true;
    } catch (error: unknown) {
      await QueueService.closeAfterStartupFailure(error);
      throw error;
    }
  }

  /**
   * Worker process only. Starts the single concurrency-1 worker with the injected processor. Each job gets an
   * AbortController that aborts with "cancelled" when the Redis cancel flag appears (polled every
   * CANCEL_POLL_INTERVAL_MS) or "shutdown" when close() runs.
   */
  static async startVisualizationWorker(processor: VisualizationJobProcessor): Promise<void> {
    if (QueueService.worker) {
      return;
    }
    await QueueService.initialize();
    try {
      const worker = QueueService.createWorker<VisualizationJobData>(
        VISUALIZATION_QUEUE,
        async (job: Job<VisualizationJobData>) => {
          const data = parseVisualizationJobData(job.data);
          const controller = new AbortController();
          const flag: CancelFlag = { keyPrefix: CANCEL_KEY_PREFIX, id: data.visualizationId };
          const entry: ActiveJobEntry = {
            controller,
            polling: false,
            cancelTimer: setInterval(() => {
              QueueService.pollCancel(flag, entry);
            }, CANCEL_POLL_INTERVAL_MS)
          };
          QueueService.activeJobs.set(data.visualizationId, entry);
          QueueService.pollCancel(flag, entry); // a cancel requested while the job was waiting
          try {
            await processor({
              visualizationId: data.visualizationId,
              jobId: job.id ?? QueueService.visualizationJobId(data.visualizationId),
              signal: controller.signal
            });
          } finally {
            clearInterval(entry.cancelTimer);
            QueueService.activeJobs.delete(data.visualizationId);
          }
        },
        {
          connection: RedisPool.getWorkerConnectionOptions(),
          prefix: QUEUE_PREFIX,
          concurrency: VISUALIZATION_WORKER_CONCURRENCY,
          lockDuration: WORKER_LOCK_DURATION_MS, // 300 000 (00 §14.6)
          maxStalledCount: WORKER_MAX_STALLED_COUNT // 0: a stalled job fails, never re-runs (00 §14.6)
        }
      );
      worker.on("active", (job) => {
        log.info(
          { event: "queue.job.started", jobId: job.id, visualizationId: job.data.visualizationId },
          "Visualization job started"
        );
      });
      worker.on("completed", (job) => {
        log.info({ event: "queue.job.completed", jobId: job.id }, "Visualization job completed");
      });
      worker.on("failed", (job, error) => {
        log.error({ event: "queue.job.failed", jobId: job?.id ?? null, err: error }, "Visualization job failed");
      });
      worker.on("stalled", (jobId) => {
        log.warn({ event: "queue.job.stalled", jobId }, "Visualization job stalled (will be failed, not retried)");
      });
      worker.on("error", (error) => {
        log.error({ event: "queue.worker.error", err: error }, "Visualization worker error");
      });
      QueueService.worker = worker;
    } catch (error: unknown) {
      await QueueService.closeAfterStartupFailure(error);
      throw error;
    }
  }

  /**
   * Idempotent enqueue (jobId viz-<id>).
   *
   * @returns The job id, and alreadyQueued=true when a job with that id already exists.
   * @throws Error when the queue is not initialized.
   */
  static async enqueueVisualization(visualizationId: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    const queue = QueueService.requireQueue();
    const data = parseVisualizationJobData({ visualizationId });
    const jobId = QueueService.visualizationJobId(visualizationId);
    const existing = await queue.getJob(jobId);
    if (existing) {
      return { jobId, alreadyQueued: true };
    }
    const options: JobsOptions = {
      jobId,
      attempts: VISUALIZATION_JOB_ATTEMPTS,
      removeOnComplete: JOB_RETENTION.removeOnComplete,
      removeOnFail: JOB_RETENTION.removeOnFail
    };
    await queue.add(VISUALIZATION_JOB, data, options); // BullMQ ignores a duplicate jobId, so a race is harmless
    log.info({ event: "queue.job.enqueued", jobId, visualizationId }, "Visualization job enqueued");
    return { jobId, alreadyQueued: false };
  }

  /**
   * Enqueues a visualization that already ran once (a run paused in awaiting_confirmation and continued): the
   * finished viz-<id> job kept for retention is removed first, because a duplicate jobId would be ignored.
   */
  static async requeueVisualization(visualizationId: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    const job = await QueueService.requireQueue().getJob(QueueService.visualizationJobId(visualizationId));
    if (job) {
      const state = await job.getState();
      if (state === "completed" || state === "failed") {
        await job.remove();
      }
    }
    return QueueService.enqueueVisualization(visualizationId);
  }

  /** Removes the job if it is still waiting/delayed/prioritized. Returns true when removed (it will never run). */
  static async removeQueuedVisualization(visualizationId: number): Promise<boolean> {
    const job = await QueueService.requireQueue().getJob(QueueService.visualizationJobId(visualizationId));
    if (!job) {
      return false;
    }
    const state = await job.getState();
    if (state !== "waiting" && state !== "delayed" && state !== "prioritized") {
      return false;
    }
    try {
      await job.remove();
      return true;
    } catch (error: unknown) {
      // The worker locked it between getState and remove: it is running now; the caller falls back to the flag.
      log.warn({ event: "queue.job.remove_failed", visualizationId, err: error }, "Queued job could not be removed");
      return false;
    }
  }

  /** BullMQ state of the visualization's job, or "missing". */
  static async getVisualizationJobState(visualizationId: number): Promise<string> {
    const job = await QueueService.requireQueue().getJob(QueueService.visualizationJobId(visualizationId));
    return job ? job.getState() : "missing";
  }

  /** Sets prvision:cancel:<id> = "1" EX 86400 (00 §10). Callable from API or worker. */
  static async requestCancel(visualizationId: number): Promise<void> {
    await RedisPool.getConnection().set(QueueService.cancelKey(visualizationId), "1", "EX", CANCEL_KEY_TTL_SECONDS);
  }

  /** True when the cancel flag of the visualization is set. */
  static async isCancelRequested(visualizationId: number): Promise<boolean> {
    return (await RedisPool.getConnection().exists(QueueService.cancelKey(visualizationId))) === 1;
  }

  /** Deletes the cancel flag (07 calls it when the job ends). */
  static async clearCancel(visualizationId: number): Promise<void> {
    await RedisPool.getConnection().del(QueueService.cancelKey(visualizationId));
  }

  // ----- harness library jobs (16 §6.15) -----

  /**
   * Worker process only. Starts the `harness-scans` worker (scan and rescan jobs, concurrency 1). Each job's signal
   * aborts with "cancelled" when `prvision:library-cancel:<id>` appears (polled every CANCEL_POLL_INTERVAL_MS) or
   * "shutdown" when close() runs. Idempotent.
   */
  static async startLibraryScanWorker(processor: LibraryJobProcessor): Promise<void> {
    if (QueueService.scanWorker) {
      return;
    }
    await QueueService.initialize();
    try {
      QueueService.scanWorker = QueueService.createLibraryWorker(
        LIBRARY_SCAN_QUEUE,
        LIBRARY_SCAN_JOB_ID_PREFIX,
        LIBRARY_SCAN_WORKER_CONCURRENCY,
        processor
      );
    } catch (error: unknown) {
      await QueueService.closeAfterStartupFailure(error);
      throw error;
    }
  }

  /** Worker process only. Starts the `harness-repairs` worker (concurrency 1); same signal rules as scans. */
  static async startLibraryRepairWorker(processor: LibraryJobProcessor): Promise<void> {
    if (QueueService.repairWorker) {
      return;
    }
    await QueueService.initialize();
    try {
      QueueService.repairWorker = QueueService.createLibraryWorker(
        LIBRARY_REPAIR_QUEUE,
        LIBRARY_REPAIR_JOB_ID_PREFIX,
        LIBRARY_REPAIR_WORKER_CONCURRENCY,
        processor
      );
    } catch (error: unknown) {
      await QueueService.closeAfterStartupFailure(error);
      throw error;
    }
  }

  /**
   * Idempotent enqueue of a library job: scan and rescan go to `harness-scans` (job `scan`, id `scan-<id>`), repair
   * to `harness-repairs` (job `repair`, id `repair-<id>`).
   *
   * @returns The job id, and alreadyQueued=true when a job with that id already exists.
   * @throws Error when the queue is not initialized.
   */
  static async enqueueLibraryJob(
    kind: LibraryJobQueueKind,
    libraryJobId: number
  ): Promise<{ jobId: string; alreadyQueued: boolean }> {
    const queue = QueueService.requireLibraryQueue(kind);
    const data = parseLibraryJobData({ libraryJobId });
    const jobId = QueueService.libraryJobId(kind, libraryJobId);
    if (await queue.getJob(jobId)) {
      return { jobId, alreadyQueued: true };
    }
    const jobName = kind === "repair" ? LIBRARY_REPAIR_JOB : LIBRARY_SCAN_JOB;
    await queue.add(jobName, data, QueueService.jobOptions(jobId)); // a duplicate jobId is ignored by BullMQ
    log.info({ event: "queue.job.enqueued", jobId, libraryJobId, kind }, "Library job enqueued");
    return { jobId, alreadyQueued: false };
  }

  /** Removes the library job if it is still waiting/delayed/prioritized. Returns true when removed. */
  static async removeQueuedLibraryJob(kind: LibraryJobQueueKind, libraryJobId: number): Promise<boolean> {
    const job = await QueueService.requireLibraryQueue(kind).getJob(QueueService.libraryJobId(kind, libraryJobId));
    return job ? QueueService.removeIfWaiting(job, { libraryJobId, kind }) : false;
  }

  /** BullMQ state of the library job, or "missing". */
  static async getLibraryJobState(kind: LibraryJobQueueKind, libraryJobId: number): Promise<string> {
    const job = await QueueService.requireLibraryQueue(kind).getJob(QueueService.libraryJobId(kind, libraryJobId));
    return job ? job.getState() : "missing";
  }

  /** Sets prvision:library-cancel:<id> = "1" EX 86400. Callable from API or worker. */
  static async requestLibraryCancel(libraryJobId: number): Promise<void> {
    await RedisPool.getConnection().set(QueueService.libraryCancelKey(libraryJobId), "1", "EX", CANCEL_KEY_TTL_SECONDS);
  }

  /** True when the library job's cancel flag is set. */
  static async isLibraryCancelRequested(libraryJobId: number): Promise<boolean> {
    return (await RedisPool.getConnection().exists(QueueService.libraryCancelKey(libraryJobId))) === 1;
  }

  /** Deletes the library job's cancel flag. */
  static async clearLibraryCancel(libraryJobId: number): Promise<void> {
    await RedisPool.getConnection().del(QueueService.libraryCancelKey(libraryJobId));
  }

  // ----- live sessions (16 §6.15) -----

  /** Idempotent enqueue of a live session job (queue `live-sessions`, job `live`, id `live-<id>`). */
  static async enqueueLiveSession(liveSessionId: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    const queue = QueueService.requireLiveQueue();
    const data = parseLiveSessionJobData({ liveSessionId });
    const jobId = QueueService.liveSessionJobId(liveSessionId);
    if (await queue.getJob(jobId)) {
      return { jobId, alreadyQueued: true };
    }
    await queue.add(LIVE_SESSION_JOB, data, QueueService.jobOptions(jobId));
    log.info({ event: "queue.job.enqueued", jobId, liveSessionId }, "Live session job enqueued");
    return { jobId, alreadyQueued: false };
  }

  /** BullMQ state of the live session job, or "missing". */
  static async getLiveSessionJobState(liveSessionId: number): Promise<string> {
    const job = await QueueService.requireLiveQueue().getJob(QueueService.liveSessionJobId(liveSessionId));
    return job ? job.getState() : "missing";
  }

  /**
   * Worker process only. Starts the `live-sessions` worker with concurrency LIVE_MAX_SESSIONS. A session's signal
   * aborts with "shutdown" only: there is no cancel flag, a stop goes through the session row (16 §12.3).
   */
  static async startLiveSessionWorker(processor: LiveSessionJobProcessor): Promise<void> {
    if (QueueService.liveWorker) {
      return;
    }
    await QueueService.initialize();
    try {
      const worker = QueueService.createWorker<LiveSessionJobData>(
        LIVE_SESSION_QUEUE,
        async (job: Job<LiveSessionJobData>) => {
          const data = parseLiveSessionJobData(job.data);
          const controller = new AbortController();
          QueueService.activeLiveJobs.set(data.liveSessionId, controller);
          try {
            await processor({
              liveSessionId: data.liveSessionId,
              jobId: job.id ?? QueueService.liveSessionJobId(data.liveSessionId),
              signal: controller.signal
            });
          } finally {
            QueueService.activeLiveJobs.delete(data.liveSessionId);
          }
        },
        QueueService.workerOptions(LIVE_MAX_SESSIONS)
      );
      QueueService.attachWorkerLogs(worker, LIVE_SESSION_QUEUE);
      QueueService.liveWorker = worker;
    } catch (error: unknown) {
      await QueueService.closeAfterStartupFailure(error);
      throw error;
    }
  }

  /** True after initialize() succeeded and until close(). */
  static isInitialized(): boolean {
    return QueueService.initialized;
  }

  /**
   * Aborts the active jobs of every worker (reason "shutdown"), closes every worker (each forced after
   * WORKER_CLOSE_TIMEOUT_MS), then every queue. No-op when nothing was opened. Always resets state; throws one
   * aggregated error if any close failed.
   */
  static async close(): Promise<void> {
    for (const entry of [...QueueService.activeJobs.values(), ...QueueService.activeLibraryJobs.values()]) {
      clearInterval(entry.cancelTimer);
      if (!entry.controller.signal.aborted) {
        entry.controller.abort("shutdown");
      }
    }
    for (const controller of QueueService.activeLiveJobs.values()) {
      if (!controller.signal.aborted) {
        controller.abort("shutdown");
      }
    }

    const workers: Array<[string, AnyWorker | null]> = [
      [VISUALIZATION_QUEUE, QueueService.worker],
      [LIBRARY_SCAN_QUEUE, QueueService.scanWorker],
      [LIBRARY_REPAIR_QUEUE, QueueService.repairWorker],
      [LIVE_SESSION_QUEUE, QueueService.liveWorker]
    ];
    const queues: Array<[string, AnyQueue | null]> = [
      [VISUALIZATION_QUEUE, QueueService.queue],
      [LIBRARY_SCAN_QUEUE, QueueService.scanQueue],
      [LIBRARY_REPAIR_QUEUE, QueueService.repairQueue],
      [LIVE_SESSION_QUEUE, QueueService.liveQueue]
    ];
    const failures: string[] = [];

    for (const [name, worker] of workers) {
      if (!worker) {
        continue;
      }
      try {
        await QueueService.closeWorker(worker);
      } catch (error: unknown) {
        failures.push(`worker ${name}: ${getErrorMessage(error)}`);
      }
    }
    for (const [name, queue] of queues) {
      if (!queue) {
        continue;
      }
      try {
        await queue.close();
      } catch (error: unknown) {
        failures.push(`queue ${name}: ${getErrorMessage(error)}`);
      }
    }

    QueueService.worker = null;
    QueueService.scanWorker = null;
    QueueService.repairWorker = null;
    QueueService.liveWorker = null;
    QueueService.queue = null;
    QueueService.scanQueue = null;
    QueueService.repairQueue = null;
    QueueService.liveQueue = null;
    QueueService.initialized = false;
    QueueService.activeJobs.clear();
    QueueService.activeLibraryJobs.clear();
    QueueService.activeLiveJobs.clear();

    if (failures.length > 0) {
      throw new Error(`Failed to close queue resources: ${failures.join("; ")}`);
    }
  }

  private static async closeWorker(worker: AnyWorker): Promise<void> {
    const timeoutController = new AbortController();
    const timedOut = (async (): Promise<"timeout"> => {
      await delay(WORKER_CLOSE_TIMEOUT_MS, undefined, { signal: timeoutController.signal, ref: false });
      return "timeout";
    })();
    // Rejects with an AbortError once the worker closed in time; that outcome is expected and ignored.
    timedOut.catch(() => undefined);
    const closing = (async (): Promise<"closed"> => {
      await worker.close();
      return "closed";
    })();
    try {
      const outcome = await Promise.race([closing, timedOut]);
      if (outcome === "timeout") {
        closing.catch((error: unknown) => {
          log.warn({ event: "queue.worker.error", err: error }, "Graceful worker close failed after timeout");
        });
        log.warn(
          { event: "queue.worker.error", timeoutMs: WORKER_CLOSE_TIMEOUT_MS },
          "Worker did not close in time; forcing close"
        );
        await worker.close(true);
      }
    } finally {
      timeoutController.abort();
    }
  }

  /** Fire-and-forget by design (interval callback): never rejects, never overlaps a previous poll of the same job. */
  private static pollCancel(flag: CancelFlag, entry: { controller: AbortController; polling: boolean }): void {
    if (entry.controller.signal.aborted || entry.polling) {
      return;
    }
    entry.polling = true;
    QueueService.checkCancel(flag, entry).catch((error: unknown) => {
      log.warn(
        { event: "queue.cancel.poll_failed", key: `${flag.keyPrefix}${String(flag.id)}`, err: error },
        "Cancel flag poll failed"
      );
    });
  }

  private static async checkCancel(
    flag: CancelFlag,
    entry: { controller: AbortController; polling: boolean }
  ): Promise<void> {
    try {
      const key = `${flag.keyPrefix}${String(flag.id)}`;
      if ((await RedisPool.getConnection().exists(key)) === 1 && !entry.controller.signal.aborted) {
        log.info({ event: "queue.job.cancel_seen", key }, "Cancel flag seen; aborting active job");
        entry.controller.abort("cancelled");
      }
    } finally {
      entry.polling = false;
    }
  }

  private static cancelKey(visualizationId: number): string {
    return `${CANCEL_KEY_PREFIX}${visualizationId}`;
  }

  private static libraryCancelKey(libraryJobId: number): string {
    return `${LIBRARY_CANCEL_KEY_PREFIX}${libraryJobId}`;
  }

  private static requireQueue(): Queue<VisualizationJobData> {
    if (!QueueService.queue || !QueueService.initialized) {
      throw new Error("QueueService must be initialized before use");
    }
    return QueueService.queue;
  }

  private static requireLibraryQueue(kind: LibraryJobQueueKind): Queue<LibraryJobData> {
    const queue = kind === "repair" ? QueueService.repairQueue : QueueService.scanQueue;
    if (!queue || !QueueService.initialized) {
      throw new Error("QueueService must be initialized before use");
    }
    return queue;
  }

  private static requireLiveQueue(): Queue<LiveSessionJobData> {
    if (!QueueService.liveQueue || !QueueService.initialized) {
      throw new Error("QueueService must be initialized before use");
    }
    return QueueService.liveQueue;
  }

  /** attempts 1 and JOB_RETENTION, shared by every queue (00 §10, 16 §6.15). */
  private static jobOptions(jobId: string): JobsOptions {
    return {
      jobId,
      attempts: VISUALIZATION_JOB_ATTEMPTS,
      removeOnComplete: JOB_RETENTION.removeOnComplete,
      removeOnFail: JOB_RETENTION.removeOnFail
    };
  }

  /** lockDuration WORKER_LOCK_DURATION_MS and maxStalledCount 0 for every worker (00 §14.6, 16 §6.15). */
  private static workerOptions(concurrency: number): WorkerOptions {
    return {
      connection: RedisPool.getWorkerConnectionOptions(),
      prefix: QUEUE_PREFIX,
      concurrency,
      lockDuration: WORKER_LOCK_DURATION_MS,
      maxStalledCount: WORKER_MAX_STALLED_COUNT
    };
  }

  /** Removes a waiting/delayed/prioritized job; false when it is in any other state or the worker locked it first. */
  private static async removeIfWaiting(
    job: { getState(): Promise<string>; remove(): Promise<void> },
    logFields: Record<string, unknown>
  ): Promise<boolean> {
    const state = await job.getState();
    if (state !== "waiting" && state !== "delayed" && state !== "prioritized") {
      return false;
    }
    try {
      await job.remove();
      return true;
    } catch (error: unknown) {
      log.warn({ event: "queue.job.remove_failed", ...logFields, err: error }, "Queued job could not be removed");
      return false;
    }
  }

  /** A scan or repair worker: one cancel-flag poller and AbortController per active job. */
  private static createLibraryWorker(
    queueName: string,
    jobIdPrefix: string,
    concurrency: number,
    processor: LibraryJobProcessor
  ): Worker<LibraryJobData> {
    const worker = QueueService.createWorker<LibraryJobData>(
      queueName,
      async (job: Job<LibraryJobData>) => {
        const data = parseLibraryJobData(job.data);
        const controller = new AbortController();
        const flag: CancelFlag = { keyPrefix: LIBRARY_CANCEL_KEY_PREFIX, id: data.libraryJobId };
        const entry: ActiveJobEntry = {
          controller,
          polling: false,
          cancelTimer: setInterval(() => {
            QueueService.pollCancel(flag, entry);
          }, CANCEL_POLL_INTERVAL_MS)
        };
        QueueService.activeLibraryJobs.set(data.libraryJobId, entry);
        QueueService.pollCancel(flag, entry); // a cancel requested while the job was waiting
        try {
          await processor({
            libraryJobId: data.libraryJobId,
            jobId: job.id ?? `${jobIdPrefix}${String(data.libraryJobId)}`,
            signal: controller.signal
          });
        } finally {
          clearInterval(entry.cancelTimer);
          QueueService.activeLibraryJobs.delete(data.libraryJobId);
        }
      },
      QueueService.workerOptions(concurrency)
    );
    QueueService.attachWorkerLogs(worker, queueName);
    return worker;
  }

  private static attachWorkerLogs(worker: Worker<LibraryJobData> | Worker<LiveSessionJobData>, queue: string): void {
    worker.on("active", (job) => {
      log.info({ event: "queue.job.started", queue, jobId: job.id }, "Job started");
    });
    worker.on("completed", (job) => {
      log.info({ event: "queue.job.completed", queue, jobId: job.id }, "Job completed");
    });
    worker.on("failed", (job, error) => {
      log.error({ event: "queue.job.failed", queue, jobId: job?.id ?? null, err: error }, "Job failed");
    });
    worker.on("stalled", (jobId) => {
      log.warn({ event: "queue.job.stalled", queue, jobId }, "Job stalled (will be failed, not retried)");
    });
    worker.on("error", (error) => {
      log.error({ event: "queue.worker.error", queue, err: error }, "Worker error");
    });
  }

  private static async closeAfterStartupFailure(startupError: unknown): Promise<void> {
    try {
      // Best-effort cleanup prevents leaked Redis connections after a partial startup.
      await QueueService.close();
    } catch (closeError: unknown) {
      log.error({ event: "queue.worker.error", err: closeError }, "QueueService cleanup failed after startup error");
    }
    log.error({ event: "queue.worker.error", err: startupError }, "QueueService startup failed");
  }

  private static createQueue<T>(name: string, options: QueueOptions): Queue<T> {
    return new Queue<T>(name, options);
  }

  private static createWorker<T>(name: string, processor: Processor<T>, options: WorkerOptions): Worker<T> {
    return new Worker<T>(name, processor, options);
  }
}
