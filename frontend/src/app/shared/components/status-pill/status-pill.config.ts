import { formatPillLabel } from '../../../core/utils/labels.util';

export type PillTone = 'success' | 'danger' | 'warning' | 'info' | 'active' | 'accent' | 'muted' | 'outline';
export type PillKind = 'visualization' | 'render' | 'visual' | 'risk' | 'change' | 'source' | 'console' | 'libraryJob';

export interface PillSpec {
  tone: PillTone;
  label: string;
  live?: boolean;
}

/** Kind → enum value → tone/label (sheet 12 §6.16.2). */
export const STATUS_PILL_MAP: Readonly<Record<PillKind, Readonly<Record<string, PillSpec>>>> = {
  visualization: {
    queued: { tone: 'muted', label: 'Queued' },
    preparing: { tone: 'info', label: 'Preparing', live: true },
    analyzing: { tone: 'info', label: 'Analyzing', live: true },
    awaiting_confirmation: { tone: 'warning', label: 'Needs your choice' },
    generating_harnesses: { tone: 'info', label: 'Generating harnesses', live: true },
    rendering: { tone: 'info', label: 'Rendering', live: true },
    diffing: { tone: 'info', label: 'Diffing', live: true },
    summarizing: { tone: 'info', label: 'Summarizing', live: true },
    completed: { tone: 'info', label: 'Completed' },
    failed: { tone: 'danger', label: 'Failed' },
    cancelled: { tone: 'muted', label: 'Cancelled' },
  },
  render: {
    pending: { tone: 'muted', label: 'Pending' },
    rendered: { tone: 'info', label: 'Rendered' },
    partial: { tone: 'warning', label: 'Partial render' },
    failed: { tone: 'danger', label: 'Render failed' },
    skipped: { tone: 'outline', label: 'Skipped' },
  },
  visual: {
    changed: { tone: 'accent', label: 'Changed' },
    unchanged: { tone: 'muted', label: 'Unchanged' },
    new: { tone: 'active', label: 'New' },
    deleted: { tone: 'warning', label: 'Deleted' },
  },
  risk: {
    none: { tone: 'info', label: 'No risk' },
    check: { tone: 'warning', label: 'Check' },
    likely_regression: { tone: 'danger', label: 'Likely regression' },
  },
  change: {
    modified: { tone: 'outline', label: 'Modified' },
    added: { tone: 'outline', label: 'Added' },
    removed: { tone: 'outline', label: 'Removed' },
    affected_parent: { tone: 'outline', label: 'Affected parent' },
    replaced: { tone: 'accent', label: 'Replaced' },
    rechecked: { tone: 'muted', label: 'Re-checked' },
  },
  source: {
    github_pr: { tone: 'info', label: 'Pull request' },
    local_branch: { tone: 'outline', label: 'Branch' },
    working_tree: { tone: 'outline', label: 'Working tree' },
    commit_range: { tone: 'outline', label: 'Commits' },
  },
  console: {
    info: { tone: 'muted', label: 'Info' },
    warn: { tone: 'warning', label: 'Warn' },
    error: { tone: 'danger', label: 'Error' },
  },
  // Scan, rescan and repair jobs (16 §15.7).
  libraryJob: {
    queued: { tone: 'active', label: 'Queued' },
    preparing: { tone: 'active', label: 'Preparing', live: true },
    running: { tone: 'active', label: 'Running', live: true },
    completed: { tone: 'success', label: 'Completed' },
    cap_reached: { tone: 'warning', label: 'Paused at cap' },
    failed: { tone: 'danger', label: 'Failed' },
    cancelled: { tone: 'muted', label: 'Cancelled' },
  },
};

/** Unknown or null value → muted pill with the title-cased value. */
export function resolvePill(kind: PillKind, value: string | null | undefined): PillSpec {
  const table = STATUS_PILL_MAP[kind];
  const spec = value !== null && value !== undefined && Object.hasOwn(table, value) ? table[value] : undefined;
  return spec ?? { tone: 'muted', label: formatPillLabel(value ?? '—') };
}
