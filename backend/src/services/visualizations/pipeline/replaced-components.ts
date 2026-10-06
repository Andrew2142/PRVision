/**
 * Helpers for `replaced` candidates downstream of analysis (00 §17). A replaced row stands for two components: the
 * removed base component R (`candidate.predecessor`) and the added head component A (the candidate's own
 * file/export). Harness generation, rendering and the structural diff treat each side as that side's own component.
 */
import type {
  ChangeAnalysisResult,
  ComponentCandidate,
  ComponentPredecessor,
  WorktreeSide
} from "../../../types/visualization-pipeline";
import { basePathFor, headPathFor } from "./change-source";

/** A `replaced` candidate with its predecessor present. */
export type ReplacedCandidate = ComponentCandidate & { changeKind: "replaced"; predecessor: ComponentPredecessor };

/** True for a `replaced` candidate that names its predecessor. */
export function isReplacedCandidate(candidate: ComponentCandidate): candidate is ReplacedCandidate {
  return candidate.changeKind === "replaced" && candidate.predecessor !== undefined && candidate.predecessor !== null;
}

/**
 * One side of a replaced candidate as a one-sided candidate: base = R as a "removed" component (base sources only),
 * head = A as an "added" component (head sources only). Same componentId, rank, code diff and reason.
 */
export function replacedSideCandidate(candidate: ReplacedCandidate, side: WorktreeSide): ComponentCandidate {
  const { predecessor: _predecessor, ...rest } = candidate;
  if (side === "head") {
    return { ...rest, changeKind: "added" };
  }
  return {
    ...rest,
    filePath: candidate.predecessor.filePath,
    exportName: candidate.predecessor.exportName,
    displayName: candidate.predecessor.displayName,
    changeKind: "removed"
  };
}

/** Base-side component path: R's file for a replaced candidate, else 08's rename-aware `basePathFor`. */
export function candidateBasePath(
  candidate: ComponentCandidate,
  changedFiles: ChangeAnalysisResult["changedFiles"]
): string | null {
  return isReplacedCandidate(candidate)
    ? candidate.predecessor.filePath
    : basePathFor(candidate.filePath, candidate.changeKind, changedFiles);
}

/** Head-side component path (A's file for a replaced candidate). */
export function candidateHeadPath(candidate: ComponentCandidate): string | null {
  return headPathFor(candidate.filePath, candidate.changeKind);
}

/** Export compared on the base side: R's export for a replaced candidate. */
export function candidateBaseExport(candidate: ComponentCandidate): string {
  return isReplacedCandidate(candidate) ? candidate.predecessor.exportName : candidate.exportName;
}

/** "EventFormComponent → EventFormModalComponent" for a replaced candidate, else the display name. */
export function candidateLabel(candidate: ComponentCandidate): string {
  return isReplacedCandidate(candidate)
    ? `${candidate.predecessor.displayName} → ${candidate.displayName}`
    : candidate.displayName;
}
