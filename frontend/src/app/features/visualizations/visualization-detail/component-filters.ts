import { type VisualChange, type VisualizationStatus } from '../../../core/models/domain-enums.model';
import { type ConsoleEventView, type VisualizationComponentView } from '../../../core/models/visualization.model';
import { stageIndex } from '../../../core/utils/visualization-status.util';

export type ComponentFilter = 'changed' | 'unchanged' | 'failed' | 'all';

export interface ComponentCounts {
  all: number;
  changed: number;
  unchanged: number;
  failed: number;
}

const CHANGED: ReadonlySet<VisualChange> = new Set<VisualChange>(['changed', 'new', 'deleted']);

/** Failed render, or a partial render where a side errored (a partial "new" component has no error and is not failed). */
export function isFailed(c: VisualizationComponentView): boolean {
  return c.renderStatus === 'failed' || (c.renderStatus === 'partial' && (!!c.baseError || !!c.headError));
}

/**
 * A replaced component (00 §17) always counts as changed: a different component took the old one's place. A row with a
 * changed state counts too (16 §15.5.4).
 */
function isChanged(c: VisualizationComponentView): boolean {
  return (
    c.changeKind === 'replaced' || (c.visualChange !== null && CHANGED.has(c.visualChange)) || c.changedStateCount > 0
  );
}

/** Unchanged `rechecked` rows (a clean global-style re-check) appear here and under "all" only. */
export const COMPONENT_FILTER_PREDICATES: Record<ComponentFilter, (c: VisualizationComponentView) => boolean> = {
  changed: isChanged,
  unchanged: (c) => c.visualChange === 'unchanged' && c.changeKind !== 'replaced' && c.changedStateCount === 0,
  failed: isFailed,
  all: () => true,
};

/**
 * Filter a run opens on (16 §15.5.4): changed if any changed; else failed if any failed; else changed when the run has
 * re-check rows (D7: results show only what changed); else all.
 */
export function defaultComponentFilter(
  counts: ComponentCounts,
  list: readonly VisualizationComponentView[],
): ComponentFilter {
  if (counts.changed > 0) return 'changed';
  if (counts.failed > 0) return 'failed';
  return list.some((c) => c.changeKind === 'rechecked') ? 'changed' : 'all';
}

export function countComponents(list: readonly VisualizationComponentView[]): ComponentCounts {
  return {
    all: list.length,
    changed: list.filter(COMPONENT_FILTER_PREDICATES.changed).length,
    unchanged: list.filter(COMPONENT_FILTER_PREDICATES.unchanged).length,
    failed: list.filter(isFailed).length,
  };
}

/**
 * Stage index where a failed/cancelled run stopped. `failedStage` (00 §14.4) wins; when it is null (older rows),
 * fall back to the console: last error event's stage, else last event's stage, else 0.
 */
export function resolveStoppedStageIndex(
  failedStage: VisualizationStatus | null,
  events: readonly ConsoleEventView[],
): number {
  if (failedStage) {
    const idx = stageIndex(failedStage);
    if (idx >= 0) return idx;
  }
  const reversed = [...events].reverse();
  for (const e of reversed) {
    if (e.level === 'error') {
      const idx = stageIndex(e.stage);
      if (idx >= 0) return idx;
    }
  }
  for (const e of reversed) {
    const idx = stageIndex(e.stage);
    if (idx >= 0) return idx;
  }
  return 0;
}
