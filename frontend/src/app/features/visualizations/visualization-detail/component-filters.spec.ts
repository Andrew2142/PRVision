import { componentView, consoleEvent } from '../testing/visualization-fixtures';
import {
  COMPONENT_FILTER_PREDICATES,
  countComponents,
  defaultComponentFilter,
  isFailed,
  resolveStoppedStageIndex,
} from './component-filters';

describe('component-filters', () => {
  it('changed includes new/deleted', () => {
    const changed = COMPONENT_FILTER_PREDICATES.changed;
    expect(changed(componentView({ visualChange: 'changed' }))).toBeTrue();
    expect(changed(componentView({ visualChange: 'new' }))).toBeTrue();
    expect(changed(componentView({ visualChange: 'deleted' }))).toBeTrue();
    expect(changed(componentView({ visualChange: 'unchanged' }))).toBeFalse();
    expect(changed(componentView({ visualChange: null }))).toBeFalse();
    expect(COMPONENT_FILTER_PREDICATES.unchanged(componentView({ visualChange: 'unchanged' }))).toBeTrue();
  });

  it('failed includes partial with error, excludes partial new', () => {
    expect(isFailed(componentView({ renderStatus: 'failed' }))).toBeTrue();
    expect(isFailed(componentView({ renderStatus: 'partial', headError: 'boom' }))).toBeTrue();
    expect(isFailed(componentView({ renderStatus: 'partial', baseError: 'boom' }))).toBeTrue();
    expect(isFailed(componentView({ renderStatus: 'partial', visualChange: 'new' }))).toBeFalse();
    expect(isFailed(componentView({ renderStatus: 'rendered' }))).toBeFalse();
    expect(isFailed(componentView({ renderStatus: 'skipped' }))).toBeFalse();
  });

  it('counts', () => {
    const list = [
      componentView({ id: 1, visualChange: 'changed' }),
      componentView({ id: 2, visualChange: 'new', renderStatus: 'partial' }),
      componentView({ id: 3, visualChange: 'unchanged' }),
      componentView({ id: 4, visualChange: null, renderStatus: 'failed', headError: 'x' }),
      componentView({ id: 5, visualChange: null, renderStatus: 'skipped' }),
      componentView({ id: 6, visualChange: null, renderStatus: 'pending' }),
    ];
    expect(countComponents(list)).toEqual({ all: 6, changed: 2, unchanged: 1, failed: 1 });
    expect(countComponents([])).toEqual({ all: 0, changed: 0, unchanged: 0, failed: 0 });
  });

  it('resolveStoppedStageIndex: failedStage wins over console', () => {
    const events = [consoleEvent(1, { stage: 'preparing', level: 'error' })];
    expect(resolveStoppedStageIndex('rendering', events)).toBe(4);
  });

  it('falls back to last error stage when failedStage null', () => {
    const events = [
      consoleEvent(1, { stage: 'preparing' }),
      consoleEvent(2, { stage: 'analyzing', level: 'error' }),
      consoleEvent(3, { stage: 'generating_harnesses', level: 'warn' }),
    ];
    expect(resolveStoppedStageIndex(null, events)).toBe(2);
  });

  it('falls back to last known stage', () => {
    const events = [
      consoleEvent(1, { stage: 'preparing' }),
      consoleEvent(2, { stage: 'rendering' }),
      consoleEvent(3, { stage: 'cleanup' }),
    ];
    expect(resolveStoppedStageIndex(null, events)).toBe(4);
  });

  it('unknown → 0', () => {
    expect(resolveStoppedStageIndex(null, [])).toBe(0);
    expect(resolveStoppedStageIndex(null, [consoleEvent(1, { stage: 'mystery', level: 'error' })])).toBe(0);
  });

  it('a replaced row always counts as changed and never as unchanged (00 §17)', () => {
    const replaced = (visualChange: 'changed' | 'unchanged' | null) =>
      componentView({ changeKind: 'replaced', visualChange, baseDisplayName: 'Old', baseFilePath: 'src/Old.tsx' });
    for (const visual of ['changed', 'unchanged', null] as const) {
      expect(COMPONENT_FILTER_PREDICATES.changed(replaced(visual))).toBeTrue();
    }
    expect(COMPONENT_FILTER_PREDICATES.unchanged(replaced('unchanged'))).toBeFalse();
    expect(countComponents([replaced('unchanged'), componentView({ visualChange: 'unchanged' })])).toEqual({
      all: 2,
      changed: 1,
      unchanged: 1,
      failed: 0,
    });
  });

  it('a row with a changed state counts as changed even when its Default looks the same (16 §15.5.4)', () => {
    const row = componentView({ visualChange: 'unchanged', stateCount: 3, changedStateCount: 1 });
    expect(COMPONENT_FILTER_PREDICATES.changed(row)).toBeTrue();
    expect(COMPONENT_FILTER_PREDICATES.unchanged(row)).toBeFalse();
  });

  it('unchanged re-check rows appear under unchanged and all only', () => {
    const recheck = componentView({ changeKind: 'rechecked', visualChange: 'unchanged' });
    expect(COMPONENT_FILTER_PREDICATES.changed(recheck)).toBeFalse();
    expect(COMPONENT_FILTER_PREDICATES.failed(recheck)).toBeFalse();
    expect(COMPONENT_FILTER_PREDICATES.unchanged(recheck)).toBeTrue();
    expect(COMPONENT_FILTER_PREDICATES.all(recheck)).toBeTrue();
    const changedRecheck = componentView({ changeKind: 'rechecked', visualChange: 'changed' });
    expect(COMPONENT_FILTER_PREDICATES.changed(changedRecheck)).toBeTrue();
  });

  it('defaultComponentFilter: changed, else failed, else changed for a re-check run, else all', () => {
    const changed = [
      componentView({ id: 1, visualChange: 'changed' }),
      componentView({ id: 2, renderStatus: 'failed' }),
    ];
    expect(defaultComponentFilter(countComponents(changed), changed)).toBe('changed');
    const failed = [componentView({ id: 1, visualChange: null, renderStatus: 'failed', headError: 'x' })];
    expect(defaultComponentFilter(countComponents(failed), failed)).toBe('failed');
    const cleanRecheck = [
      componentView({ id: 1, visualChange: 'unchanged' }),
      componentView({ id: 2, changeKind: 'rechecked', visualChange: 'unchanged' }),
    ];
    expect(defaultComponentFilter(countComponents(cleanRecheck), cleanRecheck)).toBe('changed');
    const plain = [componentView({ id: 1, visualChange: 'unchanged' })];
    expect(defaultComponentFilter(countComponents(plain), plain)).toBe('all');
  });
});
