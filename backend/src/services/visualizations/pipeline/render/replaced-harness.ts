/**
 * Two-sided render items (00 §17), shared by the React (10) and Angular (15d) render engines. A `replaced` row
 * renders the base side with R's own harness and target file and the head side with A's; mocks, render groups and
 * repairs are per side. Every other row keeps one harness for both sides.
 */
import { createHash } from "node:crypto";
import { HARNESS_MAX_REPAIRS_PER_COMPONENT } from "../../../../config-consts";
import type {
  HarnessGenerationResult,
  HarnessRenderError,
  MockedModule,
  SideHarness
} from "../../../../types/visualization-pipeline";
import { isRepairableFailure } from "./render-errors";
import { mockFingerprint, NO_MOCKS_GROUP_KEY } from "./render-groups";
import type { RenderFailureKind, RenderSide, RenderWorkItem } from "./render-types";

/** The parts of a side attempt the repair decision reads (10's SideAttempt). */
export interface SideAttemptView {
  result: { ok: boolean; error: string | null };
  kind: RenderFailureKind | null;
}

/** True when the item renders a `replaced` row with a harness per side (00 §17). */
export function isTwoSidedItem(item: Pick<RenderWorkItem, "candidate" | "harness">): boolean {
  return (
    item.candidate.changeKind === "replaced" &&
    item.harness.baseHarness !== undefined &&
    item.harness.baseHarness !== null
  );
}

/** The harness a side renders: the base harness of a replaced row on base, else the (head) harness. */
export function sideHarnessOf(harness: HarnessGenerationResult, side: RenderSide): SideHarness {
  if (side === "base" && harness.baseHarness !== undefined && harness.baseHarness !== null) {
    return harness.baseHarness;
  }
  return {
    harnessSource: harness.harnessSource,
    mockedModules: harness.mockedModules,
    notes: harness.notes,
    states: harness.states,
    origin: harness.origin,
    libraryEntryId: harness.libraryEntryId
  };
}

/** The harness of a replaced row with one side swapped for 09's repaired result. */
export function withRepairedSide(
  harness: HarnessGenerationResult,
  side: RenderSide,
  repaired: HarnessGenerationResult
): HarnessGenerationResult {
  const sideHarness: SideHarness = {
    harnessSource: repaired.harnessSource,
    mockedModules: repaired.mockedModules,
    notes: repaired.notes,
    states: repaired.states,
    origin: repaired.origin,
    libraryEntryId: repaired.libraryEntryId
  };
  return side === "base" ? { ...harness, baseHarness: sideHarness } : { ...harness, ...sideHarness };
}

/** The harness of one side as a 09 `HarnessGenerationResult` (what repairHarness expects as `previous`). */
export function sideHarnessResult(harness: HarnessGenerationResult, side: RenderSide): HarnessGenerationResult {
  return { componentId: harness.componentId, ...sideHarnessOf(harness, side) };
}

/** Accepted mocks of the side: the base list of a two-sided item on base, else the item's list. */
export function sideMocksOf(item: RenderWorkItem, side: RenderSide): MockedModule[] {
  return side === "base" && isTwoSidedItem(item) ? (item.baseAcceptedMocks ?? []) : item.acceptedMocks;
}

/** Render-group key of a two-sided item: both sides' mock fingerprints ("none" when neither side mocks). */
export function twoSidedFingerprint(
  basePath: string,
  baseMocks: readonly MockedModule[],
  headPath: string,
  headMocks: readonly MockedModule[]
): string {
  const base = mockFingerprint(basePath, baseMocks);
  const head = mockFingerprint(headPath, headMocks);
  if (base === NO_MOCKS_GROUP_KEY && head === NO_MOCKS_GROUP_KEY) {
    return NO_MOCKS_GROUP_KEY;
  }
  return createHash("sha256").update(`${base}\u0000${head}`).digest("hex").slice(0, 16);
}

/**
 * Sides of a two-sided item whose own harness should be repaired (00 §17 "repair applies per side"): every side that
 * failed with a repairable kind and has repair budget left. One side failing is enough, because each side renders
 * its own harness.
 */
export function sidesToRepair(
  attempt: Record<RenderSide, SideAttemptView | null>,
  repairsUsed: Partial<Record<RenderSide, number>>
): RenderSide[] {
  return (["base", "head"] as const).filter((side) => {
    const sideAttempt = attempt[side];
    return (
      sideAttempt !== null &&
      !sideAttempt.result.ok &&
      sideAttempt.kind !== null &&
      isRepairableFailure(sideAttempt.kind) &&
      (repairsUsed[side] ?? 0) < HARNESS_MAX_REPAIRS_PER_COMPONENT
    );
  });
}

/** HarnessRenderError for repairing one side's harness of a replaced row (`sides` = `[side]`, `targetSide` = side). */
export function sideRenderError(side: RenderSide, attempt: SideAttemptView): HarnessRenderError {
  const kind = attempt.kind;
  if (kind !== "module_load" && kind !== "render_error" && kind !== "timeout") {
    throw new Error("Invariant: sideRenderError called for a non-repairable failure");
  }
  return { sides: [side], kind, message: attempt.result.error ?? "", otherSideMessage: null, targetSide: side };
}

/** The `harness` and `baseHarness` fields of a render payload that keeps a repaired attempt. */
export function repairedHarnessPayload(harness: HarnessGenerationResult): {
  harness: { harnessSource: string; harnessNotes: string; mockedModules: MockedModule[] };
  baseHarness?: { harnessSource: string; harnessNotes: string; mockedModules: MockedModule[] };
} {
  const base = harness.baseHarness;
  return {
    harness: {
      harnessSource: harness.harnessSource,
      harnessNotes: harness.notes,
      mockedModules: harness.mockedModules
    },
    ...(base !== undefined && base !== null
      ? {
          baseHarness: {
            harnessSource: base.harnessSource,
            harnessNotes: base.notes,
            mockedModules: base.mockedModules
          }
        }
      : {})
  };
}
