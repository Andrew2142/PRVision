import { QueueService } from "../utilities";

/**
 * The job queue of a headless run: one process, one visualization, no Redis. It answers the queue calls the
 * visualization services make; the engine itself runs the job right after create or continue.
 */
export class LocalQueue {
  private readonly cancelled = new Set<number>();

  visualizationJobId(visualizationId: number): string {
    return QueueService.visualizationJobId(visualizationId);
  }

  enqueueVisualization(visualizationId: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    return Promise.resolve({ jobId: this.visualizationJobId(visualizationId), alreadyQueued: false });
  }

  requeueVisualization(visualizationId: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    return this.enqueueVisualization(visualizationId);
  }

  removeQueuedVisualization(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** The engine is running the job whenever anyone asks. */
  getVisualizationJobState(): Promise<string> {
    return Promise.resolve("active");
  }

  requestCancel(visualizationId: number): Promise<void> {
    this.cancelled.add(visualizationId);
    return Promise.resolve();
  }

  isCancelRequested(visualizationId: number): Promise<boolean> {
    return Promise.resolve(this.cancelled.has(visualizationId));
  }

  clearCancel(visualizationId: number): Promise<void> {
    this.cancelled.delete(visualizationId);
    return Promise.resolve();
  }
}
