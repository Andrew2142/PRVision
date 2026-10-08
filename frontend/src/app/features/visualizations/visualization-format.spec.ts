import { formatDateTime } from '../../shared/components/data-grid/data-grid-helpers';
import { detailView } from './testing/visualization-fixtures';
import {
  SUMMARY_START_FORMAT,
  formatDuration,
  frameworkChipLabel,
  globalStyleTriggerText,
  harnessOriginLabel,
  noComponentsCopy,
  plainPlaceName,
  refWithSha,
  renderErrorBlock,
  repairAllMessage,
  statesChangedLabel,
  structuralIntro,
  structuralSectionTitle,
  successorEvidenceLines,
  successorEvidenceText,
  summaryLine,
} from './visualization-format';

describe('visualization-format', () => {
  it('refWithSha with and without sha', () => {
    expect(refWithSha('main', 'a1b2c3d4e5f6')).toBe('main @ a1b2c3d');
    expect(refWithSha('main', null)).toBe('main');
  });

  it('formatDuration boundaries', () => {
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(950)).toBe('<1s');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(4200)).toBe('4s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_599_999)).toBe('59m 59s');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(-5)).toBe('<1s');
  });

  it('summaryLine uses absolute start time and omits unknown parts', () => {
    const start = formatDateTime('2026-10-03T10:00:00Z', SUMMARY_START_FORMAT);
    const full = summaryLine(detailView());
    expect(full).toBe(
      `Started ${start} · took 3m 12s · claude-opus-5-5 via Anthropic API · 41.2K in / 3.1K out tokens · 14 AI calls`,
    );
    expect(full).not.toContain('ago');

    const running = summaryLine(detailView({ completedAt: null, aiUsage: null, aiProvider: 'claude_code' }));
    expect(running).toBe(`Started ${start} · claude-opus-5-5 via Claude Code`);

    const queued = summaryLine(detailView({ startedAt: null, completedAt: null, aiUsage: null, aiModel: '' }));
    expect(queued).toBe('');

    const oneCall = summaryLine(
      detailView({ startedAt: null, completedAt: null, aiUsage: { inputTokens: 0, outputTokens: 0, calls: 1 } }),
    );
    expect(oneCall).toBe('claude-opus-5-5 via Anthropic API · 1 AI call');
  });

  it('summaryLine leads with "<checked> checked, <changed> changed" once harnesses rendered (16 D7)', () => {
    const start = formatDateTime('2026-10-03T10:00:00Z', SUMMARY_START_FORMAT);
    expect(summaryLine(detailView({ checkedCount: 201, changedCount: 14 }))).toBe(
      `201 checked, 14 changed · Started ${start} · took 3m 12s · claude-opus-5-5 via Anthropic API · 41.2K in / 3.1K out tokens · 14 AI calls`,
    );
    expect(summaryLine(detailView({ checkedCount: 0 }))).not.toContain('checked');
  });

  it('harness library texts (16 §15.5)', () => {
    expect(globalStyleTriggerText('src/index.css')).toBe(
      'Global style change: src/index.css — every saved harness was re-checked',
    );
    expect(harnessOriginLabel('library')).toBe('Saved harness');
    expect(harnessOriginLabel('written')).toBe('New harness');
    expect(harnessOriginLabel('repaired')).toBe('Repaired harness');
    expect(harnessOriginLabel(null)).toBeNull();
    expect(statesChangedLabel(3, 2)).toBe('2 of 3 states changed');
    expect(statesChangedLabel(1, 1)).toBeNull();
    expect(statesChangedLabel(3, 0)).toBeNull();
    expect(repairAllMessage(3, 0.84)).toBe(
      'Ask the AI to write new harnesses for 3 components? This uses AI credits, about $0.84.',
    );
    expect(repairAllMessage(14, 12.3)).toBe(
      'Ask the AI to write new harnesses for 14 components? This uses AI credits, about $12.',
    );
    expect(repairAllMessage(1, null)).toBe('Ask the AI to write new harnesses for 1 component? This uses AI credits.');
  });

  it('noComponentsCopy per status', () => {
    expect(noComponentsCopy('rendering')).toEqual({
      noComponentsTitle: 'Looking for changed components',
      noComponentsMessage: 'Components appear here once change analysis finishes.',
    });
    expect(noComponentsCopy('queued').noComponentsTitle).toBe('Looking for changed components');
    expect(noComponentsCopy('completed')).toEqual({
      noComponentsTitle: 'No UI components affected',
      noComponentsMessage: 'None of the changed files affect React components PRVision can render.',
    });
    for (const s of ['failed', 'cancelled'] as const) {
      expect(noComponentsCopy(s)).toEqual({
        noComponentsTitle: 'No components',
        noComponentsMessage: 'The run stopped before any components were found.',
      });
    }
  });

  it('noComponentsCopy names Angular components for Angular runs', () => {
    expect(noComponentsCopy('completed', 'angular').noComponentsMessage).toBe(
      'None of the changed files affect Angular components PRVision can render.',
    );
    expect(noComponentsCopy('completed', 'react_vite')).toEqual(noComponentsCopy('completed'));
  });

  it('framework labels (15 §5.9.1)', () => {
    expect(frameworkChipLabel('angular')).toBe('Angular');
    expect(frameworkChipLabel('react_vite')).toBe('React + Vite');
    expect(structuralSectionTitle('angular')).toBe('Template structure');
    expect(structuralSectionTitle('react_vite')).toBe('Structural changes');
    expect(structuralIntro('react_vite')).toBe('DOM differences between the base and head renders.');
    expect(structuralIntro('angular')).toContain('Template differences');
  });

  it('renderErrorBlock says "Build unavailable" for Angular vite_unavailable only', () => {
    expect(
      renderErrorBlock('Head', '[vite_unavailable] The Angular build failed on the head side:', 'angular'),
    ).toEqual({
      side: 'Head',
      title: 'Head render failed · Build unavailable',
      text: '[build_unavailable] The Angular build failed on the head side:',
    });
    expect(renderErrorBlock('Base', '[vite_unavailable] Vite exited', 'react_vite')).toEqual({
      side: 'Base',
      title: 'Base render failed',
      text: '[vite_unavailable] Vite exited',
    });
    expect(renderErrorBlock('Head', '[module_load] Module load failed: x', 'angular').title).toBe('Head render failed');
  });
});

describe('replaced components (00 §17)', () => {
  it('plainPlaceName turns a file into words', () => {
    expect(plainPlaceName('src/app/events/events-list/events-list.component.html')).toBe('events list');
    expect(plainPlaceName('src/pages/OrderHistory.tsx')).toBe('order history');
    expect(plainPlaceName('src/app/event_types.component.ts')).toBe('event types');
  });

  it('successorEvidenceText words each evidence kind plainly', () => {
    expect(
      successorEvidenceText({
        kind: 'call_site_swap',
        detail: 'src/app/events/events-list/events-list.component.html: <app-event-form> → <app-event-form-modal>',
      }),
    ).toBe('events list now uses the new component instead of the old one');
    expect(successorEvidenceText({ kind: 'git_rename', detail: 'a.ts → b.ts (51% similar)' })).toBe(
      'the new file is the old file renamed and edited (51% the same)',
    );
    expect(successorEvidenceText({ kind: 'git_rename', detail: 'a.ts → b.ts' })).toBe(
      'the new file is the old file renamed and edited',
    );
    expect(successorEvidenceText({ kind: 'name_similarity', detail: 'A → AModal' })).toBe(
      'the new name builds on the old one, in the same part of the app',
    );
    expect(successorEvidenceText({ kind: 'content_similarity', detail: 'template tokens 71% alike' })).toBe(
      'the two look alike in their markup (71% the same)',
    );
  });

  it('successorEvidenceLines drops repeated lines and handles null', () => {
    const swap = { kind: 'call_site_swap' as const, detail: 'src/a/list.component.html: <x> → <y>' };
    const swapTs = { kind: 'call_site_swap' as const, detail: 'src/a/list.component.ts: import X → import Y' };
    expect(successorEvidenceLines([swap, swapTs])).toEqual(['list now uses the new component instead of the old one']);
    expect(successorEvidenceLines(null)).toEqual([]);
  });
});
