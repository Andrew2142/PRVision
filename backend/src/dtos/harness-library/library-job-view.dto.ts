import type { HarnessLibraryJobModel } from "../../models";
import { priceFor, toIsoString, toIsoStringOrNull } from "../../utilities";

/**
 * A scan, rescan or repair job (16 §14.3). Written by 16e for the run detail's `activeRepairJob`; 16f owns this
 * file and extends it (job routes, events).
 */
export interface LibraryJobView {
  id: number;
  repositoryId: number;
  repositoryName: string;
  kind: "scan" | "rescan" | "repair";
  status: "queued" | "preparing" | "running" | "completed" | "cap_reached" | "failed" | "cancelled";
  visualizationId: number | null;
  componentIds: number[] | null;
  stateAllowance: number;
  spendCapUsd: number | null;
  spentUsd: number;
  priceExact: boolean;
  totalCount: number;
  writtenCount: number;
  failedCount: number;
  skippedCount: number;
  processedCount: number;
  currentLabel: string | null;
  scanSha: string | null;
  aiModel: string;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Maps a job row and its repository name to the view (`priceExact` from the price table, E17). */
export function toLibraryJobView(job: HarnessLibraryJobModel, repositoryName: string): LibraryJobView {
  const componentIds: unknown = job.componentIds;
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    repositoryName,
    kind: job.kind,
    status: job.status,
    visualizationId: job.visualizationId ?? null,
    componentIds: Array.isArray(componentIds)
      ? componentIds.filter((value): value is number => typeof value === "number")
      : null,
    stateAllowance: job.stateAllowance,
    spendCapUsd: job.spendCapUsd ?? null,
    spentUsd: job.spentUsd,
    priceExact: priceFor(job.aiModel).exact,
    totalCount: job.totalCount,
    writtenCount: job.writtenCount,
    failedCount: job.failedCount,
    skippedCount: job.skippedCount,
    processedCount: job.writtenCount + job.failedCount + job.skippedCount,
    currentLabel: job.currentLabel ?? null,
    scanSha: job.scanSha ?? null,
    aiModel: job.aiModel,
    errorMessage: job.errorMessage ?? null,
    createdAt: toIsoString(job.createdAt),
    startedAt: toIsoStringOrNull(job.startedAt),
    completedAt: toIsoStringOrNull(job.completedAt)
  };
}
