/**
 * AiUsageRecorder (09 §5.11): the only writer of `visualizations.ai_usage` (00 §14.7). Used by harness
 * generation and repair (09) and by the summary (11).
 */
import { Table } from "../../../enums";
import { VisualizationModel } from "../../../models";
import type { AiUsage } from "../../../types/visualization-pipeline";
import { QueryHandler, ZERO_USAGE, addUsage } from "../../../utilities";

/** The stored shape of `visualizations.ai_usage` (matches VisualizationDetailView.aiUsage). */
export interface StoredAiUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Null or malformed jsonb → ZERO_USAGE. */
export function toStoredUsage(value: unknown): StoredAiUsage {
  const zero: StoredAiUsage = {
    inputTokens: ZERO_USAGE.inputTokens,
    outputTokens: ZERO_USAGE.outputTokens,
    calls: ZERO_USAGE.calls
  };
  if (typeof value !== "object" || value === null) {
    return zero;
  }
  const { inputTokens, outputTokens, calls } = value as Record<string, unknown>;
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(calls)) {
    return zero;
  }
  return { inputTokens, outputTokens, calls };
}

/** Serialized read-add-write accumulation of AI usage for one visualization. */
export class AiUsageRecorder {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly visualizationId: number,
    private readonly queryHandler: QueryHandler = new QueryHandler()
  ) {}

  /**
   * Serialized read-add-write of visualizations.ai_usage. Reads the stored value on every call (no in-memory
   * total), so several recorder instances used one after another (09 generation, 09 repair during rendering,
   * 11 summary) never lose updates.
   *
   * @returns The stored total after this addition.
   * @throws QueryHandlerError on a DB error, Error when the update does not return 200 (infrastructure failure).
   */
  add(usage: AiUsage): Promise<StoredAiUsage> {
    const previous = this.chain; // never rejects (see below); no .then() chains (01 §5.9.1)
    const run = (async (): Promise<StoredAiUsage> => {
      await previous;
      const row = await this.queryHandler.validateAndSelect(
        VisualizationModel,
        { id: this.visualizationId },
        Table.VISUALIZATIONS
      );
      const current = toStoredUsage(row?.aiUsage ?? null);
      const next = addUsage(current, usage);
      const stored: StoredAiUsage = {
        inputTokens: next.inputTokens,
        outputTokens: next.outputTokens,
        calls: next.calls
      };
      const response = await this.queryHandler.update(
        { aiUsage: stored },
        { id: this.visualizationId },
        Table.VISUALIZATIONS
      );
      if (response.status !== 200) {
        throw new Error(`ai_usage update failed (${response.status})`);
      }
      return stored;
    })();
    this.chain = run.catch(() => undefined); // keep the chain alive; the error surfaces to this caller
    return run;
  }
}
