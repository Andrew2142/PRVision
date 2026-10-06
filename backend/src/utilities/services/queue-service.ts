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
  if (typeof input === "object" && input !== null && "visualizationId" in input) {
    const visualizationId: unknown = input.visualizationId;
    if (typeof visualizationId === "number" && Number.isSafeInteger(visualizationId) && visualizationId > 0) {
      return { visualizationId };
    }
  }
  throw new Error("Invalid visualization job data");
}

type ActiveJobEntry = { controller: AbortController; cancelTimer: NodeJS.Timeout; polling: boolean };

/**
 * BullMQ wiring for the single `visualizations` queue (00 §10, §14.6). Rewritten from Uply-v2's QueueService:
 * all-or-nothing initialize, idempotent worker start, aggregated close. The processor is injected by worker.ts,
 * so utilities never import pipeline services.
 */
export class QueueService {
  private static queue: Queue<VisualizationJobData> | null = null;
  private static worker: Worker<VisualizationJobData> | null = null;
  private static initialized = false;
  private static readonly activeJobs = new Map<number, ActiveJobEntry>();

  /** `viz-<visualizationId>`: the idempotent BullMQ job id. */
  static visualizationJobId(visualizationId: number): string {
    return `${VISUALIZATION_JOB_ID_PREFIX}${visualizationId}`;
  }

  /** Opens the queue. Idempotent; all-or-nothing (a failure closes what was opened and rethrows). */
  static async initialize(): Promise<void> {
    if (QueueService.initialized) {
      return;
    }
    try {
      const queue = QueueService.createQueue(VISUALIZATION_QUEUE, {
        connection: RedisPool.getQueueConnectionOptions(),
        prefix: QUEUE_PREFIX
      });
      QueueService.queue = queue;
      await queue.waitUntilReady();
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
      const worker = QueueService.createWorker(
        VISUALIZATION_QUEUE,
        async (job: Job<VisualizationJobData>) => {
          const data = parseVisualizationJobData(job.data);
          const controller = new AbortController();
          const entry: ActiveJobEntry = {
            controller,
            polling: false,
            cancelTimer: setInterval(() => {
              QueueService.pollCancel(data.visualizationId, entry);
            }, CANCEL_POLL_INTERVAL_MS)
          };
          QueueService.activeJobs.set(data.visualizationId, entry);
          QueueService.pollCancel(data.visualizationId, entry); // a cancel requested while the job was waiting
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

  /** True after initialize() succeeded and until close(). */
  static isInitialized(): boolean {
    return QueueService.initialized;
  }

  /**
   * Aborts active jobs (reason "shutdown"), closes the worker (forced after WORKER_CLOSE_TIMEOUT_MS), then the
   * queue. No-op when nothing was opened. Always resets state; throws one aggregated error if any close failed.
   */
  static async close(): Promise<void> {
    for (const entry of QueueService.activeJobs.values()) {
      clearInterval(entry.cancelTimer);
      if (!entry.controller.signal.aborted) {
        entry.controller.abort("shutdown");
      }
    }

    const worker = QueueService.worker;
    const queue = QueueService.queue;
    const failures: string[] = [];

    if (worker) {
      try {
        await QueueService.closeWorker(worker);
      } catch (error: unknown) {
        failures.push(`worker: ${getErrorMessage(error)}`);
      }
    }
    if (queue) {
      try {
        await queue.close();
      } catch (error: unknown) {
        failures.push(`queue: ${getErrorMessage(error)}`);
      }
    }

    QueueService.worker = null;
    QueueService.queue = null;
    QueueService.initialized = false;
    QueueService.activeJobs.clear();

    if (failures.length > 0) {
      throw new Error(`Failed to close queue resources: ${failures.join("; ")}`);
    }
  }

  private static async closeWorker(worker: Worker<VisualizationJobData>): Promise<void> {
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
  private static pollCancel(visualizationId: number, entry: { controller: AbortController; polling: boolean }): void {
    if (entry.controller.signal.aborted || entry.polling) {
      return;
    }
    entry.polling = true;
    QueueService.checkCancel(visualizationId, entry).catch((error: unknown) => {
      log.warn({ event: "queue.cancel.poll_failed", visualizationId, err: error }, "Cancel flag poll failed");
    });
  }

  private static async checkCancel(
    visualizationId: number,
    entry: { controller: AbortController; polling: boolean }
  ): Promise<void> {
    try {
      if ((await QueueService.isCancelRequested(visualizationId)) && !entry.controller.signal.aborted) {
        log.info({ event: "queue.job.cancel_seen", visualizationId }, "Cancel flag seen; aborting active job");
        entry.controller.abort("cancelled");
      }
    } finally {
      entry.polling = false;
    }
  }

  private static cancelKey(visualizationId: number): string {
    return `${CANCEL_KEY_PREFIX}${visualizationId}`;
  }

  private static requireQueue(): Queue<VisualizationJobData> {
    if (!QueueService.queue || !QueueService.initialized) {
      throw new Error("QueueService must be initialized before use");
    }
    return QueueService.queue;
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

  private static createQueue(name: string, options: QueueOptions): Queue<VisualizationJobData> {
    return new Queue<VisualizationJobData>(name, options);
  }

  private static createWorker(
    name: string,
    processor: Processor<VisualizationJobData>,
    options: WorkerOptions
  ): Worker<VisualizationJobData> {
    return new Worker<VisualizationJobData>(name, processor, options);
  }
}
