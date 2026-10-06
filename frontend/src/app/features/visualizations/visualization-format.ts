import { type RepositoryFramework, type VisualizationStatus } from '../../core/models/domain-enums.model';
import { type SuccessorEvidence, type VisualizationDetailView } from '../../core/models/visualization.model';
import { providerLabel } from '../../core/utils/labels.util';
import { isTerminalStatus } from '../../core/utils/visualization-status.util';
import { formatDateTime, parseDateToUtcMs } from '../../shared/components/data-grid/data-grid-helpers';

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Absolute start time in the summary line ("Oct 3, 12:01 PM"). */
export const SUMMARY_START_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/** "main @ a1b2c3d", or the bare ref when the sha is unknown. */
export function refWithSha(ref: string, sha: string | null): string {
  return sha ? `${ref} @ ${sha.slice(0, 7)}` : ref;
}

/** 950 → "<1s", 4200 → "4s", 192000 → "3m 12s", 3_900_000 → "1h 5m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/**
 * "Started Oct 3, 12:01 PM · took 3m 12s · claude-opus-5-5 via Anthropic API · 41.2K in / 3.1K out tokens · 14 AI calls"
 * Absolute start time (a relative one would go stale on a finished run, whose header no longer recomputes).
 * "took" only when completedAt is set; parts omitted when unknown.
 */
export function summaryLine(v: VisualizationDetailView): string {
  const parts: string[] = [];
  const started = v.startedAt ? formatDateTime(v.startedAt, SUMMARY_START_FORMAT, '') : '';
  if (started) parts.push(`Started ${started}`);
  if (v.completedAt) {
    const end = parseDateToUtcMs(v.completedAt);
    const start = parseDateToUtcMs(v.startedAt ?? v.createdAt);
    if (end !== null && start !== null) parts.push(`took ${formatDuration(end - start)}`);
  }
  if (v.aiModel) parts.push(v.aiProvider ? `${v.aiModel} via ${providerLabel(v.aiProvider)}` : v.aiModel);
  const usage = v.aiUsage;
  if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
    parts.push(`${COMPACT.format(usage.inputTokens)} in / ${COMPACT.format(usage.outputTokens)} out tokens`);
  }
  if (usage && usage.calls > 0) parts.push(`${usage.calls} AI call${usage.calls === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Copy for the components section before any component exists (13 §5.9.4; Angular wording 15 §5.9.1). */
export function noComponentsCopy(
  status: VisualizationStatus,
  framework: RepositoryFramework = 'react_vite',
): {
  noComponentsTitle: string;
  noComponentsMessage: string;
} {
  if (!isTerminalStatus(status)) {
    return {
      noComponentsTitle: 'Looking for changed components',
      noComponentsMessage: 'Components appear here once change analysis finishes.',
    };
  }
  if (status === 'completed') {
    return {
      noComponentsTitle: 'No UI components affected',
      noComponentsMessage:
        framework === 'angular'
          ? 'None of the changed files affect Angular components PRVision can render.'
          : 'None of the changed files affect React components PRVision can render.',
    };
  }
  return {
    noComponentsTitle: 'No components',
    noComponentsMessage: 'The run stopped before any components were found.',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Framework-aware labels (15 §5.9.1). React keeps the wording of sheet 13.
// ---------------------------------------------------------------------------------------------------------------

/** Header chip of the visualization page. */
export function frameworkChipLabel(framework: RepositoryFramework): string {
  return framework === 'angular' ? 'Angular' : 'React + Vite';
}

/** Title of the structural-diff section of a component card. */
export function structuralSectionTitle(framework: RepositoryFramework): string {
  return framework === 'angular' ? 'Template structure' : 'Structural changes';
}

/** Intro line of the structural-diff list. */
export function structuralIntro(framework: RepositoryFramework): string {
  return framework === 'angular'
    ? 'Template differences between the base and head versions of the component.'
    : 'DOM differences between the base and head renders.';
}

// ---------------------------------------------------------------------------------------------------------------
// Replaced components (00 §17)
// ---------------------------------------------------------------------------------------------------------------

/** "src/app/events/events-list/events-list.component.html" → "events list"; "src/pages/OrderHistory.tsx" → "order history". */
export function plainPlaceName(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '').replace(/\.(component|module|page|view)$/, '');
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** One piece of successor evidence in plain words, e.g. "events list now uses the new component instead of the old one". */
export function successorEvidenceText(evidence: SuccessorEvidence): string {
  switch (evidence.kind) {
    case 'call_site_swap': {
      const separator = evidence.detail.indexOf(': ');
      const place = plainPlaceName(separator === -1 ? evidence.detail : evidence.detail.slice(0, separator));
      return `${place || 'a screen'} now uses the new component instead of the old one`;
    }
    case 'git_rename': {
      const similar = /\((\d+)% similar\)/.exec(evidence.detail)?.[1];
      return similar
        ? `the new file is the old file renamed and edited (${similar}% the same)`
        : 'the new file is the old file renamed and edited';
    }
    case 'name_similarity':
      return 'the new name builds on the old one, in the same part of the app';
    case 'content_similarity': {
      const alike = /(\d+)% alike/.exec(evidence.detail)?.[1];
      return alike ? `the two look alike in their markup (${alike}% the same)` : 'the two look alike in their markup';
    }
  }
}

/** Plain evidence lines of a replaced component, call-site swaps first, duplicates removed. */
export function successorEvidenceLines(evidence: readonly SuccessorEvidence[] | null): string[] {
  return [...new Set((evidence ?? []).map(successorEvidenceText))];
}

const VITE_UNAVAILABLE_TAG = '[vite_unavailable]';

export interface RenderErrorBlock {
  side: 'Base' | 'Head';
  title: string;
  text: string;
}

/**
 * One stored side error for the Render errors panel. `vite_unavailable` also means "Angular build or static host
 * unavailable" (15 §11 item 12), so Angular runs say "Build unavailable"; React text is shown as stored.
 */
export function renderErrorBlock(
  side: 'Base' | 'Head',
  text: string,
  framework: RepositoryFramework,
): RenderErrorBlock {
  if (framework === 'angular' && text.startsWith(VITE_UNAVAILABLE_TAG)) {
    return {
      side,
      title: `${side} render failed · Build unavailable`,
      text: `[build_unavailable]${text.slice(VITE_UNAVAILABLE_TAG.length)}`,
    };
  }
  return { side, title: `${side} render failed`, text };
}
