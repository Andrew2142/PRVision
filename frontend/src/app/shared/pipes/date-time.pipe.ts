import { Pipe, type PipeTransform } from '@angular/core';
import { formatDateOnly, formatDateTime } from '../components/data-grid/data-grid-helpers';

export type DateTimeStyle = 'medium' | 'date' | 'time';

/** Locale date/time from an ISO string: `medium` = date + short time, `date` = date only, `time` = time with seconds. */
@Pipe({ name: 'dateTime' })
export class DateTimePipe implements PipeTransform {
  transform(value: string | Date | null | undefined, style: DateTimeStyle = 'medium', fallback = '—'): string {
    switch (style) {
      case 'date':
        return formatDateOnly(value, fallback);
      case 'time':
        return formatDateTime(value, { timeStyle: 'medium' }, fallback);
      default:
        return formatDateTime(value, { dateStyle: 'medium', timeStyle: 'short' }, fallback);
    }
  }
}
