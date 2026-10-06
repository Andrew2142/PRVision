import { Pipe, type PipeTransform } from '@angular/core';

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** 1024-based sizes: 0 → "0 B", 1536 → "1.5 KB". Negative or non-finite → "—". */
@Pipe({ name: 'bytes' })
export class BytesPipe implements PipeTransform {
  transform(value: number | null | undefined, decimals = 1): string {
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
    if (value === 0) return '0 B';
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
    const unit = UNITS[exponent] ?? 'B';
    const scaled = value / 1024 ** exponent;
    const text = exponent === 0 ? String(Math.round(scaled)) : String(Number(scaled.toFixed(decimals)));
    return `${text} ${unit}`;
  }
}
