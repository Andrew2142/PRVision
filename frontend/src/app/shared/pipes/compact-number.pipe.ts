import { Pipe, type PipeTransform } from '@angular/core';

const FORMAT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** "12.3K" (AI token counts). null → "—". */
@Pipe({ name: 'compactNumber' })
export class CompactNumberPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return FORMAT.format(value);
  }
}
