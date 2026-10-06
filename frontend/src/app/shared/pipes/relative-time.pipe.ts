import { Pipe, type PipeTransform } from '@angular/core';
import { formatRelativeTime } from '../components/data-grid/data-grid-helpers';

/** Uply `TimeAgoPipe`: "just now", "3 min ago", "2 hr ago", … Naive ISO without a zone is treated as UTC. */
@Pipe({ name: 'relativeTime' })
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | Date | null | undefined, fallback = '—'): string {
    return formatRelativeTime(value, fallback);
  }
}
