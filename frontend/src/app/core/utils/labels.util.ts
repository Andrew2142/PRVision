import { type VisualizationSummaryView } from '../models/visualization.model';

/** Text for a primitive (string, number, boolean, bigint) or Date; '' for null, undefined and other objects. */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** Copied from Uply's data-grid-helpers: snake/kebab case → Title Case; values with @ : / are kept as-is. */
export function formatPillLabel(value: unknown): string {
  const text = (value ? toText(value) : '—').trim();
  if (!text || text === '—') return '—';
  if (/[@:/]/.test(text)) return text;

  return text
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

/** First 7 characters of a SHA; "?" when unknown. */
function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '?';
}

/**
 * github_pr → "PR #42"; local_branch → "Branch feature/x"; working_tree → "Working tree";
 * commit_range → "Commits a1b2c3d…e4f5a6b on feature/x" (00 §16).
 */
export function sourceLabel(
  v: Pick<VisualizationSummaryView, 'sourceType' | 'prNumber' | 'headRef' | 'baseSha' | 'headSha'>,
): string {
  switch (v.sourceType) {
    case 'github_pr':
      return v.prNumber === null ? 'Pull request' : `PR #${v.prNumber}`;
    case 'local_branch':
      return `Branch ${v.headRef}`;
    case 'working_tree':
      return 'Working tree';
    case 'commit_range':
      return `Commits ${short(v.baseSha)}…${short(v.headSha)} on ${v.headRef}`;
  }
}

/**
 * "main ← feature/x"; working_tree → "<baseRef> ← working tree" (07 stores headRef "working-tree" for this type);
 * commit_range → "feature/x: a1b2c3d ← e4f5a6b" (both refs are the branch).
 */
export function refsLabel(
  v: Pick<VisualizationSummaryView, 'baseRef' | 'headRef' | 'sourceType' | 'baseSha' | 'headSha'>,
): string {
  if (v.sourceType === 'commit_range') return `${v.headRef}: ${short(v.baseSha)} ← ${short(v.headSha)}`;
  const head = v.sourceType === 'working_tree' ? 'working tree' : v.headRef;
  return `${v.baseRef} ← ${head}`;
}

/** True only for strings starting with "https://github.com/". */
export function isSafeGithubUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('https://github.com/');
}

/** Shared by 13's Settings (Test AI result) and visualization detail (summary line). */
export function providerLabel(p: string): string {
  return p === 'anthropic_api' ? 'Anthropic API' : p === 'claude_code' ? 'Claude Code' : formatPillLabel(p);
}
