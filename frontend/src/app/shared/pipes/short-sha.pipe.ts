import { Pipe, type PipeTransform } from '@angular/core';

/** First `length` characters of a commit SHA; null → "—". */
@Pipe({ name: 'shortSha' })
export class ShortShaPipe implements PipeTransform {
  transform(sha: string | null | undefined, length = 7): string {
    if (!sha) return '—';
    return sha.slice(0, length);
  }
}
