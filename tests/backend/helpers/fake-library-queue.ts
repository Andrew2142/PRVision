/**
 * Fake of QueueService's library job statics (16 §6.15) for harness library tests: enqueue, remove, state and the
 * cancel flag. Records every call; jobs are keyed `<kind>:<id>` like their BullMQ ids.
 */
import type { LibraryJobQueueKind } from "../../../backend/src/utilities/services/queue-service";

export class FakeLibraryQueue {
  readonly flags = new Set<number>();
  /** BullMQ state per library job id (absent = "missing"). */
  readonly jobStates = new Map<number, string>();
  readonly calls: string[] = [];
  enqueueError: Error | null = null;
  removeResult: boolean | null = null;
  cancelCheckError: Error | null = null;

  libraryJobId(kind: LibraryJobQueueKind, id: number): string {
    return kind === "repair" ? `repair-${String(id)}` : `scan-${String(id)}`;
  }

  enqueueLibraryJob(kind: LibraryJobQueueKind, id: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    this.calls.push(`enqueue:${kind}:${String(id)}`);
    if (this.enqueueError) {
      return Promise.reject(this.enqueueError);
    }
    const alreadyQueued = this.jobStates.has(id);
    this.jobStates.set(id, this.jobStates.get(id) ?? "waiting");
    return Promise.resolve({ jobId: this.libraryJobId(kind, id), alreadyQueued });
  }

  removeQueuedLibraryJob(kind: LibraryJobQueueKind, id: number): Promise<boolean> {
    this.calls.push(`remove:${kind}:${String(id)}`);
    if (this.removeResult !== null) {
      return Promise.resolve(this.removeResult);
    }
    const state = this.jobStates.get(id);
    if (state === "waiting" || state === "delayed" || state === "prioritized") {
      this.jobStates.delete(id);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  getLibraryJobState(kind: LibraryJobQueueKind, id: number): Promise<string> {
    this.calls.push(`state:${kind}:${String(id)}`);
    return Promise.resolve(this.jobStates.get(id) ?? "missing");
  }

  requestLibraryCancel(id: number): Promise<void> {
    this.calls.push(`requestCancel:${String(id)}`);
    this.flags.add(id);
    return Promise.resolve();
  }

  isLibraryCancelRequested(id: number): Promise<boolean> {
    if (this.cancelCheckError) {
      return Promise.reject(this.cancelCheckError);
    }
    return Promise.resolve(this.flags.has(id));
  }

  clearLibraryCancel(id: number): Promise<void> {
    this.calls.push(`clearCancel:${String(id)}`);
    this.flags.delete(id);
    return Promise.resolve();
  }
}
