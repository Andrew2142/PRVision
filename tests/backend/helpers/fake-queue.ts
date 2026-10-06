/**
 * BullMQ queue fake and job builder (sheet 14 §5.4.11). FakeQueue records add/getJob/remove; makeJob() builds the
 * object 04's QueueService hands the injected processor (00 §14.6).
 */
import type { VisualizationJob } from "../../../backend/src/utilities/services/queue-service";

export type FakeJobState = "waiting" | "delayed" | "prioritized" | "active" | "completed" | "failed";
export interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  state: FakeJobState;
  getState(): Promise<FakeJobState>;
  remove(): Promise<void>;
}

/** Records BullMQ Queue calls; a repeated jobId is a no-op like BullMQ. */
export class FakeQueue {
  readonly jobs = new Map<string, FakeJob>();
  readonly added: FakeJob[] = [];
  failNextAdd: Error | null = null;

  add(name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<FakeJob> {
    if (this.failNextAdd) {
      const error = this.failNextAdd;
      this.failNextAdd = null;
      return Promise.reject(error);
    }
    const id = typeof opts.jobId === "string" ? opts.jobId : `job-${this.added.length + 1}`;
    const existing = this.jobs.get(id);
    if (existing) {
      return Promise.resolve(existing); // BullMQ: same jobId is a no-op
    }
    const job: FakeJob = {
      id,
      name,
      data,
      opts,
      state: "waiting",
      getState: () => Promise.resolve(job.state),
      remove: () => {
        this.jobs.delete(id);
        return Promise.resolve();
      }
    };
    this.jobs.set(id, job);
    this.added.push(job);
    return Promise.resolve(job);
  }

  getJob(id: string): Promise<FakeJob | undefined> {
    return Promise.resolve(this.jobs.get(id));
  }

  waitUntilReady(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The object 04's QueueService hands the injected processor (00 §14.6): { visualizationId, jobId, signal }.
 * cancel()/shutdown() abort with the STRING reasons QueueService uses, so code under test sees exactly what
 * production sees (decide with jobAbortReason(signal), never `instanceof Error`).
 */
export function makeJob(visualizationId: number): { job: VisualizationJob; cancel(): void; shutdown(): void } {
  const controller = new AbortController();
  return {
    job: { visualizationId, jobId: `viz-${visualizationId}`, signal: controller.signal },
    cancel: () => {
      controller.abort("cancelled");
    },
    shutdown: () => {
      controller.abort("shutdown");
    }
  };
}
