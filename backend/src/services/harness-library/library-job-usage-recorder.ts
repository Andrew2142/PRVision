/**
 * Spend accounting of library jobs (16 §10.5, D13, E16): the job's AI usage recorder, the spending-cap guard 09
 * consults before every AI call, and a composite recorder for repairs (usage on the run and on the job, §11.4).
 */
import { LIBRARY_ESTIMATE_DEFAULT_CALL_USAGE } from "../../config-consts";
import { Table } from "../../enums";
import { HarnessLibraryJobModel } from "../../models";
import type { AiUsage } from "../../types/visualization-pipeline";
import { QueryHandler, addUsage, usageCostUsd } from "../../utilities";
import { toStoredUsage, type AiUsageRecorder, type StoredAiUsage } from "../visualizations/pipeline/ai-usage-recorder";

/** Calls a job must have made before its own mean cost per call replaces the default expectation (16 §10.5). */
export const SPEND_CAP_MEAN_AFTER_CALLS = 3;

/** Running totals of a job's AI usage, as the cap guard reads them. */
export interface JobSpendTotals {
  spentUsd: number;
  calls: number;
}

/** Notified after every recorded usage (the cap guard releases one in-flight reservation). */
export interface UsageRecordedListener {
  onUsageRecorded(totals: JobSpendTotals): void;
}

function storedFrom(usage: AiUsage): StoredAiUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    calls: usage.calls,
    ...(usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {})
  };
}

/**
 * `Pick<AiUsageRecorder, "add">` of one library job: serialized read-add-write of `harness_library_jobs.ai_usage`,
 * then `spent_usd = usageCostUsd(job.ai_model, total).usd`. Usage of failed calls counts (00 §14.4).
 */
export class LibraryJobUsageRecorder implements Pick<AiUsageRecorder, "add"> {
  private chain: Promise<unknown> = Promise.resolve();
  private totals: JobSpendTotals;

  /**
   * @param jobId - The job.
   * @param aiModel - `harness_library_jobs.ai_model` (the model the job was started with).
   * @param initial - Totals already stored on the job (a new job: 0).
   */
  constructor(
    private readonly jobId: number,
    private readonly aiModel: string,
    private readonly queryHandler: Pick<QueryHandler, "validateAndSelect" | "update"> = new QueryHandler(),
    initial: JobSpendTotals = { spentUsd: 0, calls: 0 },
    private readonly listener: UsageRecordedListener | null = null
  ) {
    this.totals = { ...initial };
  }

  /** The totals after the last recorded usage. */
  current(): JobSpendTotals {
    return { ...this.totals };
  }

  /**
   * Adds one call's usage to the job.
   *
   * @returns The stored total after this addition.
   * @throws Error when the job row cannot be read or updated.
   */
  add(usage: AiUsage): Promise<StoredAiUsage> {
    const previous = this.chain;
    const run = (async (): Promise<StoredAiUsage> => {
      await previous;
      try {
        const row = await this.queryHandler.validateAndSelect(
          HarnessLibraryJobModel,
          { id: this.jobId },
          Table.HARNESS_LIBRARY_JOBS
        );
        if (row === null) {
          throw new Error(`Library job ${String(this.jobId)} not found while recording AI usage`);
        }
        const stored = storedFrom(addUsage(toStoredUsage(row.aiUsage ?? null), usage));
        const spentUsd = usageCostUsd(this.aiModel, stored).usd;
        const response = await this.queryHandler.update(
          { aiUsage: stored, spentUsd },
          { id: this.jobId },
          Table.HARNESS_LIBRARY_JOBS
        );
        if (response.status !== 200) {
          throw new Error(`Library job ai_usage update failed (${String(response.status)})`);
        }
        this.totals = { spentUsd, calls: stored.calls };
        return stored;
      } finally {
        this.listener?.onUsageRecorded(this.current());
      }
    })();
    this.chain = run.catch(() => undefined); // keep the chain alive; the error surfaces to this caller
    return run;
  }
}

/**
 * The spending cap (E16): an AI call starts only when the spend so far plus the expected cost of the calls in flight
 * and of this one stays within the cap. Calls in flight finish, so the overshoot is bounded by their estimation
 * error. `inFlight` lives in the job processor's memory (one scan worker, concurrency 1).
 */
export class SpendCapGuard implements UsageRecordedListener {
  private inFlightCalls = 0;
  private totals: JobSpendTotals = { spentUsd: 0, calls: 0 };
  private readonly defaultCallUsd: number;

  /**
   * @param capUsd - `spend_cap_usd`; null = no cap (every call starts).
   * @param model - The job's model (prices the default expectation).
   */
  constructor(
    private readonly capUsd: number | null,
    model: string,
    initial: JobSpendTotals = { spentUsd: 0, calls: 0 }
  ) {
    this.defaultCallUsd = usageCostUsd(model, LIBRARY_ESTIMATE_DEFAULT_CALL_USAGE).usd;
    this.totals = { ...initial };
  }

  /** Reservations not yet released by a recorded usage. */
  get inFlight(): number {
    return this.inFlightCalls;
  }

  /** The job's mean cost per call after SPEND_CAP_MEAN_AFTER_CALLS calls, before that the default expectation. */
  expectedCallUsd(): number {
    if (this.totals.calls >= SPEND_CAP_MEAN_AFTER_CALLS && this.totals.calls > 0) {
      return this.totals.spentUsd / this.totals.calls;
    }
    return this.defaultCallUsd;
  }

  /** `HarnessGenerationDeps.shouldStartCall`: admits the call and reserves it, or refuses it. */
  readonly shouldStartCall = (): Promise<boolean> => {
    if (!this.fits(this.inFlightCalls + 1)) {
      return Promise.resolve(false);
    }
    this.inFlightCalls += 1;
    return Promise.resolve(true);
  };

  /** Whether one more call would fit now (no reservation): the check between batches. */
  canStartCall(): boolean {
    return this.fits(this.inFlightCalls + 1);
  }

  /** Every recorded usage releases one reservation (never below 0) and refreshes the totals. */
  onUsageRecorded(totals: JobSpendTotals): void {
    this.totals = { ...totals };
    this.inFlightCalls = Math.max(0, this.inFlightCalls - 1);
  }

  private fits(calls: number): boolean {
    if (this.capUsd === null) {
      return true;
    }
    return this.totals.spentUsd + calls * this.expectedCallUsd() <= this.capUsd;
  }
}

/** Records every usage on several recorders (repairs: the run and the job, 16 §11.4). Returns the first's total. */
export class CompositeUsageRecorder implements Pick<AiUsageRecorder, "add"> {
  constructor(private readonly recorders: ReadonlyArray<Pick<AiUsageRecorder, "add">>) {
    if (recorders.length === 0) {
      throw new Error("CompositeUsageRecorder needs at least one recorder");
    }
  }

  async add(usage: AiUsage): Promise<StoredAiUsage> {
    const results = await Promise.all(this.recorders.map((recorder) => recorder.add(usage)));
    const first = results[0];
    if (first === undefined) {
      throw new Error("CompositeUsageRecorder needs at least one recorder");
    }
    return first;
  }
}
