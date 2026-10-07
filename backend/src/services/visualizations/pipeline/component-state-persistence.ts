/**
 * Per-state rows of a run component (16 §9.4, E9): every state, Default included, gets a
 * `visualization_component_states` row. Render (16e) and repair (16g) replace a component's rows as a whole; the
 * image diff fills the per-state diff columns.
 */
import { DeletionMode, Table } from "../../../enums";
import type { StateDiffResult } from "../../../types/visualization-pipeline";
import type { QueryHandler } from "../../../utilities";
import type { StateRenderPayload } from "./render-service";

function assertOk(response: { status: number; error?: string | string[] }, what: string): void {
  if (response.status >= 400) {
    const detail = response.error === undefined ? String(response.status) : String(response.error);
    throw new Error(`visualization_component_states ${what} failed: ${detail}`);
  }
}

/**
 * Deletes the existing state rows of a component (hard) and inserts the new ones. Run it on a transaction's
 * QueryHandler together with the component row update.
 *
 * @throws Error when a statement fails.
 */
export async function persistComponentStates(
  queryHandler: QueryHandler,
  visualizationId: number,
  componentId: number,
  states: readonly StateRenderPayload[]
): Promise<void> {
  const removed = await queryHandler.delete(
    { visualizationComponentId: componentId },
    Table.VISUALIZATION_COMPONENT_STATES,
    DeletionMode.HARD
  );
  if (removed.status !== 404) {
    assertOk(removed, "delete");
  }
  if (states.length === 0) {
    return;
  }
  const inserted = await queryHandler.insert(
    states.map((state) => ({
      visualizationComponentId: componentId,
      visualizationId,
      ordinal: state.ordinal,
      stateName: state.stateName,
      onBase: state.onBase,
      onHead: state.onHead,
      steps: state.steps,
      renderStatus: state.renderStatus,
      baseImagePath: state.baseImagePath,
      headImagePath: state.headImagePath,
      imageWidth: state.imageWidth,
      imageHeight: state.imageHeight,
      baseError: state.baseError,
      headError: state.headError,
      baseFailureKind: state.baseFailureKind,
      headFailureKind: state.headFailureKind
    })),
    Table.VISUALIZATION_COMPONENT_STATES
  );
  assertOk(inserted, "insert");
}

/**
 * Row aggregates over the states of a component (16 §9.5): states compared, states changed (`changed`, `new` or
 * `deleted`) and the largest diff ratio.
 */
export function aggregateComponentStates(
  states: ReadonlyArray<{ visualChange: string | null; diffPixelRatio: number | null }>
): { stateCount: number; changedStateCount: number; maxDiffPixelRatio: number | null } {
  let changedStateCount = 0;
  let maxDiffPixelRatio: number | null = null;
  for (const state of states) {
    if (state.visualChange === "changed" || state.visualChange === "new" || state.visualChange === "deleted") {
      changedStateCount += 1;
    }
    if (state.diffPixelRatio !== null) {
      maxDiffPixelRatio =
        maxDiffPixelRatio === null ? state.diffPixelRatio : Math.max(maxDiffPixelRatio, state.diffPixelRatio);
    }
  }
  return { stateCount: states.length, changedStateCount, maxDiffPixelRatio };
}

/**
 * Writes the per-state diff results of one component (visual change, diff image, ratio and size).
 *
 * @throws Error when an update fails for another reason than a missing state row.
 */
export async function updateComponentStateDiffs(
  queryHandler: QueryHandler,
  componentId: number,
  diffs: readonly StateDiffResult[]
): Promise<void> {
  for (const diff of diffs) {
    const values: Record<string, unknown> = {
      visualChange: diff.visualChange,
      diffImagePath: diff.diffImagePath,
      diffPixelRatio: diff.diffPixelRatio
    };
    if (diff.width !== null && diff.height !== null) {
      values.imageWidth = diff.width;
      values.imageHeight = diff.height;
    }
    const response = await queryHandler.update(
      values,
      { visualizationComponentId: componentId, ordinal: diff.ordinal },
      Table.VISUALIZATION_COMPONENT_STATES
    );
    if (response.status !== 404) {
      assertOk(response, "update");
    }
  }
}
