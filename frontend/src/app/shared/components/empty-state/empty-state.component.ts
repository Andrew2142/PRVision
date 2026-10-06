import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export function formatEmptyStateMessage(title: string | null | undefined, message: string | null | undefined): string {
  const cleanTitle = (title ?? '').trim();
  const cleanMessage = (message ?? '').trim();
  if (!cleanTitle) return cleanMessage;
  if (!cleanMessage) return cleanTitle;
  const separator = /[.!?]$/.test(cleanTitle) ? ' ' : '. ';
  return `${cleanTitle}${separator}${cleanMessage}`;
}

/** Uply's dotted, text-only empty box (`.dd-grid-empty-state`), plus an optional action slot. */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dd-grid-empty-state justify-between gap-4">
      <span>{{ text() }}</span>
      <span class="shrink-0 empty:hidden"><ng-content select="[emptyStateAction]" /></span>
    </div>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
    }
  `,
})
export class EmptyStateComponent {
  /** Kept for call-site parity with Uply; empty states are text-only. */
  readonly icon = input<string | null>(null);
  readonly title = input<string | null>('No data');
  readonly message = input<string | null>('There is nothing here yet.');
  protected readonly text = computed(() => formatEmptyStateMessage(this.title(), this.message()));
}
