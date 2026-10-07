import type { VisualizationComponentModel } from "../../models";
import type { StructuralChange, SuccessorEvidence } from "../../types";
import type { ComponentStateView } from "./component-state-view.dto";

type HarnessOrigin = "library" | "written" | "repaired";

/** Where a run row's harness came from and whether it needs repair (16 §14.5). */
export interface ComponentHarnessView {
  origin: HarnessOrigin | null;
  baseOrigin: HarnessOrigin | null; // replaced rows
  libraryEntryId: number | null;
  baseLibraryEntryId: number | null;
  needsUpdate: boolean;
  sourceChangedSinceWrite: boolean | null;
  /** Listed in the run's active repair job. */
  repairing: boolean;
}

/** One component of GET /api/visualizations/:id (00 §9 + §14.4). Image URLs are "/artifacts/…" or null. */
export interface VisualizationComponentView {
  id: number;
  filePath: string;
  exportName: string;
  displayName: string;
  changeKind: "modified" | "added" | "removed" | "affected_parent" | "replaced" | "rechecked"; // rechecked: 16 §14.5
  renderStatus: "pending" | "rendered" | "partial" | "failed" | "skipped";
  visualChange: "changed" | "unchanged" | "new" | "deleted" | null;
  risk: "none" | "check" | "likely_regression" | null;
  rank: number;
  baseImageUrl: string | null;
  headImageUrl: string | null;
  diffImageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  diffPixelRatio: number | null;
  codeDiff: string | null;
  structuralDiff: StructuralChange[] | null;
  aiNote: string | null;
  harnessSource: string | null;
  harnessNotes: string | null;
  baseError: string | null;
  headError: string | null;
  changeReason: string | null;
  skipReason: string | null;
  /** 00 §17: the removed base component of a `replaced` row (null otherwise). */
  baseFilePath: string | null;
  baseExportName: string | null;
  baseDisplayName: string | null;
  /** 00 §17: why the base and head components were paired (`replaced` rows only). */
  successorEvidence: SuccessorEvidence[] | null;
  // --- 16e block (16 §14.5) ---
  /** Ordinal order; one synthesized Default for rows without state rows (16 §7.9). */
  states: ComponentStateView[];
  stateCount: number;
  changedStateCount: number;
  harness: ComponentHarnessView;
}

/**
 * Maps a component row to its view. `mockedModules` is not part of the view (00 §9).
 *
 * @param c - Component model.
 * @param toPublicUrl - ArtifactStore.toPublicUrl (relative image path → "/artifacts/…").
 * @param extras - 16 §14.5: the state views (already synthesized for legacy rows) and whether a repair job lists it.
 */
export function toVisualizationComponentView(
  c: VisualizationComponentModel,
  toPublicUrl: (relativePath: string | null) => string | null,
  extras: { states: ComponentStateView[]; repairing: boolean }
): VisualizationComponentView {
  const legacy = c.stateCount === 0 && extras.states.length > 0;
  const changedStates = extras.states.filter(
    (state) => state.visualChange === "changed" || state.visualChange === "new" || state.visualChange === "deleted"
  ).length;
  return {
    id: c.id,
    filePath: c.filePath,
    exportName: c.exportName,
    displayName: c.displayName,
    changeKind: c.changeKind,
    renderStatus: c.renderStatus,
    visualChange: c.visualChange,
    risk: c.risk,
    rank: c.rank,
    baseImageUrl: toPublicUrl(c.baseImagePath),
    headImageUrl: toPublicUrl(c.headImagePath),
    diffImageUrl: toPublicUrl(c.diffImagePath),
    imageWidth: c.imageWidth,
    imageHeight: c.imageHeight,
    diffPixelRatio: c.diffPixelRatio !== null && Number.isFinite(c.diffPixelRatio) ? c.diffPixelRatio : null,
    codeDiff: c.codeDiff,
    structuralDiff: c.structuralDiff,
    aiNote: c.aiNote,
    harnessSource: c.harnessSource,
    harnessNotes: c.harnessNotes,
    baseError: c.baseError,
    headError: c.headError,
    changeReason: c.changeReason, // 00 §14.4
    skipReason: c.skipReason, // 00 §14.4
    baseFilePath: c.baseFilePath, // 00 §17
    baseExportName: c.baseExportName,
    baseDisplayName: c.baseDisplayName,
    successorEvidence: c.successorEvidence,
    states: extras.states,
    stateCount: legacy ? extras.states.length : c.stateCount,
    changedStateCount: legacy ? changedStates : c.changedStateCount,
    harness: {
      origin: c.harnessOrigin ?? null,
      baseOrigin: c.baseHarnessOrigin ?? null,
      libraryEntryId: c.libraryEntryId ?? null,
      baseLibraryEntryId: c.baseLibraryEntryId ?? null,
      needsUpdate: c.harnessNeedsUpdate,
      sourceChangedSinceWrite: c.sourceChangedSinceWrite ?? null,
      repairing: extras.repairing
    }
  };
}
