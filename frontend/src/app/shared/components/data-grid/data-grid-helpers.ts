import { formatPillLabel, toText } from '../../../core/utils/labels.util';
import { type PillKind, resolvePill } from '../status-pill/status-pill.config';

export { formatPillLabel };

type GridActionTone = 'neutral' | 'primary' | 'danger';

function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Uply's `value || '—'` for cell text: empty values render as a dash. */
function orDash(value: unknown): string {
  const text = toText(value);
  return text === '' ? '—' : text;
}

function parseToUtcMs(value: string | Date): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }

  const s = value.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Shared by the relative-time pipe: ISO without a zone (common from Postgres via JSON) is treated as UTC. */
export function parseDateToUtcMs(value: string | Date): number | null {
  return parseToUtcMs(value);
}

function normalizeDateInput(value: unknown): Date | null {
  if (isNil(value) || value === '') return null;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  const utcMs = parseToUtcMs(toText(value));
  return utcMs === null ? null : new Date(utcMs);
}

export function escapeHtml(value: unknown): string {
  return toText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDateTime(
  value: unknown,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  fallback = '—',
): string {
  const date = normalizeDateInput(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

export function formatDateOnly(value: unknown, fallback = '—'): string {
  return formatDateTime(value, { year: 'numeric', month: 'short', day: 'numeric' }, fallback);
}

export function formatRelativeTime(value: unknown, fallback = '—'): string {
  if (isNil(value) || value === '') return fallback;
  const thenMs = value instanceof Date ? parseToUtcMs(value) : parseToUtcMs(toText(value));
  if (thenMs === null) return fallback;

  const now = new Date();
  const then = new Date(thenMs);
  let diffMs = now.getTime() - thenMs;
  if (diffMs < 0) diffMs = 0;

  if (
    now.getFullYear() === then.getFullYear() &&
    now.getMonth() === then.getMonth() &&
    now.getDate() === then.getDate() &&
    now.getHours() === then.getHours() &&
    now.getMinutes() === then.getMinutes()
  ) {
    return 'just now';
  }

  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  if (min < 60) return min <= 0 ? 'just now' : min === 1 ? '1 min ago' : `${min} min ago`;

  const hr = Math.floor(sec / 3600);
  if (hr < 24) return hr === 1 ? '1 hr ago' : `${hr} hr ago`;

  const day = Math.floor(sec / 86400);
  if (day < 7) return day === 1 ? '1 day ago' : `${day} days ago`;
  if (day < 30) {
    const week = Math.floor(day / 7);
    return week === 1 ? '1 week ago' : `${week} weeks ago`;
  }
  if (day < 365) {
    const month = Math.floor(day / 30);
    return month === 1 ? '1 month ago' : `${month} months ago`;
  }

  const year = Math.floor(day / 365);
  return year === 1 ? '1 year ago' : `${year} years ago`;
}

/** Note: `label` goes through `formatPillLabel` (title-cases `pnpm` to "Pnpm"); for raw values use `renderMonospace`. */
export function renderPill(label: unknown, className = ''): string {
  const classes = ['dd-pill', className.trim()].filter(Boolean).join(' ');
  return `<span class="${escapeHtml(classes)}">${escapeHtml(formatPillLabel(label))}</span>`;
}

/** Cell HTML for an enum value with the `app-status-pill` mapping (sheet 12 §6.16.2). */
export function renderStatusPillHtml(kind: PillKind, value: string | null | undefined, labelOverride?: string): string {
  const spec = resolvePill(kind, value);
  const dot = spec.live ? '<span class="dd-pill__dot dd-pill__dot--pulse" aria-hidden="true"></span>' : '';
  return `<span class="dd-pill dd-pill--${spec.tone}">${dot}${escapeHtml(labelOverride ?? spec.label)}</span>`;
}

export function renderStackedText(primary: unknown, secondary?: unknown): string {
  const secondaryHtml =
    isNil(secondary) || secondary === ''
      ? ''
      : `<span class="dd-grid-stack__secondary">${escapeHtml(secondary)}</span>`;

  return `<div class="dd-grid-stack"><span class="dd-grid-stack__primary">${escapeHtml(orDash(primary))}</span>${secondaryHtml}</div>`;
}

export function renderMutedText(value: unknown): string {
  return `<span class="dd-grid-muted">${escapeHtml(orDash(value))}</span>`;
}

export function renderMonospace(value: unknown): string {
  return `<span class="dd-grid-mono">${escapeHtml(orDash(value))}</span>`;
}

export function renderActionButton(action: string, label: string, tone: GridActionTone = 'neutral'): string {
  return `<button type="button" class="dd-grid-action dd-grid-action--${tone}" data-grid-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
}

export function renderActionLink(label: string, href: string, tone: GridActionTone = 'primary', newTab = true): string {
  const targetAttrs = newTab ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a class="dd-grid-action dd-grid-action--${tone}" href="${escapeHtml(href)}"${targetAttrs}>${escapeHtml(label)}</a>`;
}

export function renderActionGroup(actions: string[]): string {
  return `<div class="dd-grid-actions">${actions.join('')}</div>`;
}

function eventTargetOf(source: Event | EventTarget | null | undefined): EventTarget | null {
  return source && typeof source === 'object' && 'target' in source ? source.target : (source ?? null);
}

export function isGridActionTarget(source: Event | EventTarget | null | undefined): boolean {
  const target = eventTargetOf(source);

  let el = target instanceof HTMLElement ? target : null;
  while (el) {
    if (el.classList.contains('dd-grid-action') || el.dataset['gridAction']) return true;
    el = el.parentElement;
  }

  return false;
}

export function suppressGridActionMouseEvent(params: { event?: Event | null } | Event | null | undefined): boolean {
  if (!params) return false;
  return params instanceof Event ? isGridActionTarget(params) : isGridActionTarget(params.event ?? null);
}

export function extractGridAction(source: Event | EventTarget | null | undefined): string | null {
  const target = eventTargetOf(source);

  let el = target instanceof HTMLElement ? target : null;
  while (el && !el.dataset['gridAction']) {
    el = el.parentElement;
  }
  return el?.dataset['gridAction'] ?? null;
}
