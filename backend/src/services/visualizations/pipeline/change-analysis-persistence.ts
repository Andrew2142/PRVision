/**
 * Candidate persistence shared by the React (08) and Angular (15b) change analysis services (sheet 15 §5.5.7).
 * Extracted from `ChangeAnalysisService` without behaviour change: one transaction, previous rows of the
 * visualization deleted, one `visualization_components` row per ranked draft, `component_count` updated, inserted
 * ids mapped back by (filePath, exportName). `replaced` drafts also write the base_* columns and successor_evidence
 * (00 §17).
 */
import { ComponentRenderStatus, DeletionMode, Table } from "../../../enums";
import type { DraftCandidate } from "../../../types/change-analysis";
import { PipelineStepError } from "../../../types/visualization-pipeline";
import { QueryHandler, getErrorMessage, type Transaction } from "../../../utilities";

/** What `persistAnalysisRows` needs from its caller's dependencies (08's `ChangeAnalysisDeps` subset). */
export interface AnalysisPersistenceDeps {
  runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createQueryHandler(tx?: Transaction): QueryHandler;
}

/** Dedupe/ranking key of a draft: `<filePath>\0<exportName>`. */
export function analysisRowKey(draft: { filePath: string; exportName: string }): string {
  return `${draft.filePath}\u0000${draft.exportName}`;
}

function persistError(message: string, cause?: unknown): PipelineStepError {
  return new PipelineStepError("analyzing", "Could not save the list of components.", {
    code: "ANALYSIS_PERSIST_FAILED",
    detail: `ANALYSIS_PERSIST_FAILED: ${message}`,
    cause
  });
}

/** Reads `id`, `filePath`, `exportName` of returned rows with runtime checks (no casts). */
function mapIdsByKey(rows: readonly Record<string, unknown>[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const row of rows) {
    const id = row.id;
    const filePath = row.filePath;
    const exportName = row.exportName;
    if (typeof id === "number" && typeof filePath === "string" && typeof exportName === "string") {
      ids.set(analysisRowKey({ filePath, exportName }), id);
    }
  }
  return ids;
}

/**
 * Step 10 of 08 §5.13: replaces the visualization's component rows with `ordered` (rank = index), marking the
 * `rendered` keys `pending` and the others `skipped` with their skip reason.
 *
 * @returns inserted row ids by `analysisRowKey`.
 * @throws PipelineStepError ANALYSIS_PERSIST_FAILED (stage "analyzing") on any failure; the transaction rolls back.
 */
export async function persistAnalysisRows(
  deps: AnalysisPersistenceDeps,
  visualizationId: number,
  ordered: readonly DraftCandidate[],
  rendered: ReadonlySet<string>,
  skipReasons: ReadonlyMap<string, string>
): Promise<Map<string, number>> {
  try {
    return await deps.runInTransaction(async (tx) => {
      const qh = deps.createQueryHandler(tx);
      // Idempotent re-run: a retried job must not duplicate rows. 404 (= no previous rows) is fine.
      const deleted = await qh.delete({ visualizationId }, Table.VISUALIZATION_COMPONENTS, DeletionMode.HARD);
      if (deleted.status !== 200 && deleted.status !== 404) {
        throw new Error(`delete failed (${String(deleted.status)})`);
      }
      if (ordered.length > 0) {
        const rows = ordered.map((draft, index) => {
          const isRendered = rendered.has(analysisRowKey(draft));
          return QueryHandler.normalizeData({
            visualizationId,
            filePath: draft.filePath,
            exportName: draft.exportName,
            displayName: draft.displayName,
            changeKind: draft.changeKind,
            renderStatus: isRendered ? ComponentRenderStatus.PENDING : ComponentRenderStatus.SKIPPED,
            rank: index,
            codeDiff: draft.codeDiff,
            mockedModules: [],
            changeReason: draft.reason, // 00 §14.3
            skipReason: isRendered ? null : (skipReasons.get(analysisRowKey(draft)) ?? null), // 00 §14.3
            // 00 §17: a `replaced` row also names the removed base component and the successor evidence
            ...(draft.predecessor
              ? {
                  baseFilePath: draft.predecessor.filePath,
                  baseExportName: draft.predecessor.exportName,
                  baseDisplayName: draft.predecessor.displayName,
                  successorEvidence: draft.predecessor.evidence
                }
              : {})
          });
        });
        const inserted = await qh.insert(rows, Table.VISUALIZATION_COMPONENTS);
        if (inserted.status !== 200 || !Array.isArray(inserted.data)) {
          throw new Error(`insert failed (${String(inserted.status)})`);
        }
        const counted = await qh.update(
          { componentCount: ordered.length },
          { id: visualizationId },
          Table.VISUALIZATIONS
        );
        if (counted.status !== 200) {
          throw new Error(`component_count update failed (${String(counted.status)})`);
        }
        return mapIdsByKey(inserted.data);
      }
      const counted = await qh.update({ componentCount: 0 }, { id: visualizationId }, Table.VISUALIZATIONS);
      if (counted.status !== 200) {
        throw new Error(`component_count update failed (${String(counted.status)})`);
      }
      return new Map<string, number>();
    });
  } catch (error: unknown) {
    throw persistError(getErrorMessage(error), error);
  }
}
