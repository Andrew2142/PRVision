import { Pipe, type PipeTransform } from '@angular/core';

/**
 * `diffPixelRatio` (0..1) → percent: null → "—", 0 → "0%", < 0.01% → "<0.01%", < 1% → 2 decimals,
 * < 10% → 1 decimal, else 0 decimals; values above 1 clamp to "100%".
 */
export function formatDiffPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const percent = Math.min(Math.max(ratio, 0), 1) * 100;
  if (percent === 0) return '0%';
  if (percent < 0.01) return '<0.01%';
  if (percent < 1) return `${percent.toFixed(2)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(0)}%`;
}

@Pipe({ name: 'diffPercent' })
export class DiffPercentPipe implements PipeTransform {
  transform(ratio: number | null | undefined): string {
    return formatDiffPercent(ratio);
  }
}
