import type { LibraryCounts } from "../../types/harness-library";
import type { LibraryJobView } from "./library-job-view.dto";

/** GET /api/repositories/:id/library (16 §14.3). Counts never include `off_default_branch` entries (E26). */
export interface HarnessLibrarySummaryView {
  repositoryId: number;
  buildMode: "grow" | "scan";
  stateAllowance: number;
  /** buildMode "scan" and counts.otherAllowance > 0 (E24). */
  rescanSuggested: boolean;
  counts: { total: number; ready: number; needsUpdate: number; withoutHarness: number; otherAllowance: number };
  /** Active scan or rescan. */
  activeJob: LibraryJobView | null;
  /** Most recent terminal scan or rescan. */
  lastScanJob: LibraryJobView | null;
  /** No active job and lastScanJob ended cancelled, cap_reached or failed. */
  canContinue: boolean;
}

const CONTINUABLE: readonly string[] = ["cancelled", "cap_reached", "failed"];

/** Builds the summary view from the repository's settings, the store counts and the two jobs. */
export function toHarnessLibrarySummaryView(input: {
  repositoryId: number;
  buildMode: "grow" | "scan";
  stateAllowance: number;
  counts: LibraryCounts;
  activeJob: LibraryJobView | null;
  lastScanJob: LibraryJobView | null;
}): HarnessLibrarySummaryView {
  const { counts } = input;
  return {
    repositoryId: input.repositoryId,
    buildMode: input.buildMode,
    stateAllowance: input.stateAllowance,
    rescanSuggested: input.buildMode === "scan" && counts.otherAllowance > 0,
    counts: {
      total: counts.total,
      ready: counts.ready,
      needsUpdate: counts.needsUpdate,
      withoutHarness: counts.withoutHarness,
      otherAllowance: counts.otherAllowance
    },
    activeJob: input.activeJob,
    lastScanJob: input.lastScanJob,
    canContinue:
      input.activeJob === null && input.lastScanJob !== null && CONTINUABLE.includes(input.lastScanJob.status)
  };
}
