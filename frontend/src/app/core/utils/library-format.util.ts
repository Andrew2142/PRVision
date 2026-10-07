import { TERMINAL_LIBRARY_JOB_STATUSES, type LibraryJobStatus } from '../models/domain-enums.model';
import { type LibraryEstimateView, type LibraryJobView } from '../models/harness-library.model';

/** "1 state", "3 states". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Dollars as the library screens print them (16 §15.3): two decimals under $10, else whole dollars. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$0.00';
  if (Math.abs(usd) < 10) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** "84 of 201 harnesses written, about $12 spent" (16 §10.5, D12). */
export function jobProgressText(job: Pick<LibraryJobView, 'processedCount' | 'totalCount' | 'spentUsd'>): string {
  return `${String(job.processedCount)} of ${String(job.totalCount)} harnesses written, about ${formatUsd(job.spentUsd)} spent`;
}

/** Progress bar value 0–100; 0 while the total is unknown. */
export function jobProgressPercent(job: Pick<LibraryJobView, 'processedCount' | 'totalCount'>): number {
  if (job.totalCount <= 0) return 0;
  return Math.min(100, Math.round((job.processedCount / job.totalCount) * 100));
}

export function isTerminalLibraryJob(status: LibraryJobStatus): boolean {
  return (TERMINAL_LIBRARY_JOB_STATUSES as readonly string[]).includes(status);
}

/** Page title of a job (16 §15.7). */
export function libraryJobTitle(job: Pick<LibraryJobView, 'kind' | 'repositoryName' | 'visualizationId'>): string {
  switch (job.kind) {
    case 'scan':
      return `Scan · ${job.repositoryName}`;
    case 'rescan':
      return `Rescan · ${job.repositoryName}`;
    case 'repair':
      return `Repair · run #${String(job.visualizationId ?? '?')}`;
  }
}

/** One rendering of an estimate, shared by the Add repository dialog and the scan dialog (16 §15.2 item 3). */
export interface EstimateText {
  /** Bold lead: "201 components" or "12 of 201 components to write". */
  count: string;
  /** "$38" (printed after "about"). */
  cost: string;
  /** "(between $23 and $61) with claude-opus-5-5 at 3 states · about 84 minutes". */
  detail: string;
  /** Grow mode sentence. */
  growLine: string;
  /** Muted note when the model has no published price; null when the price is exact. */
  priceNote: string | null;
}

export function estimateText(estimate: LibraryEstimateView, countMode: 'components' | 'toWrite'): EstimateText {
  const components = plural(estimate.componentCount, 'component');
  return {
    count: countMode === 'toWrite' ? `${String(estimate.toWriteCount)} of ${components} to write` : components,
    cost: formatUsd(estimate.estimatedUsd),
    detail:
      `(between ${formatUsd(estimate.lowUsd)} and ${formatUsd(estimate.highUsd)}) with ${estimate.model} at ` +
      `${plural(estimate.stateAllowance, 'state')} · about ${plural(estimate.estimatedMinutes, 'minute')}`,
    growLine:
      `${components}. Writing all of them now would cost about ${formatUsd(estimate.estimatedUsd)}; ` +
      'growing as you go costs nothing upfront.',
    priceNote: estimate.priceExact
      ? null
      : `No published price for ${estimate.model}; using ${estimate.priceModel}'s price.`,
  };
}

/** Default spending cap for an estimate: max(1, ceil(highUsd)) (16 §15.2 item 4). */
export function defaultSpendCap(estimate: Pick<LibraryEstimateView, 'highUsd'>): number {
  return Math.max(1, Math.ceil(estimate.highUsd));
}

/** "Could not estimate: <message>." without a doubled full stop. */
export function estimateErrorText(message: string): string {
  return `Could not estimate: ${message.trim().replace(/[.\s]+$/, '')}.`;
}
