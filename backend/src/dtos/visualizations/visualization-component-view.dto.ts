import type { VisualizationComponentModel } from "../../models";
import type { StructuralChange, SuccessorEvidence } from "../../types";

/** One component of GET /api/visualizations/:id (00 §9 + §14.4). Image URLs are "/artifacts/…" or null. */
export interface VisualizationComponentView {
  id: number;
  filePath: string;
  exportName: string;
  displayName: string;
  changeKind: "modified" | "added" | "removed" | "affected_parent" | "replaced";
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
}

/**
 * Maps a component row to its view. `mockedModules` is not part of the view (00 §9).
 *
 * @param c - Component model.
 * @param toPublicUrl - ArtifactStore.toPublicUrl (relative image path → "/artifacts/…").
 */
export function toVisualizationComponentView(
  c: VisualizationComponentModel,
  toPublicUrl: (relativePath: string | null) => string | null
): VisualizationComponentView {
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
    successorEvidence: c.successorEvidence
  };
}
