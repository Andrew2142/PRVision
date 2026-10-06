import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number | null;
  icon?: string;
  disabled?: boolean;
}

/**
 * Uply's time-range button group (monitor detail "Performance trend"), generalized. `mode="tabs"` gives the same look
 * with tablist semantics: `role="tab"`, `aria-selected`, roving tabindex and arrow/Home/End keys (selection follows
 * focus). Tabs point at one panel, `<idPrefix>-panel`, and have ids `<idPrefix>-tab-<value>`.
 */
@Component({
  selector: 'app-segmented-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  host: { class: 'block max-w-full' },
  template: `
    <div
      [attr.role]="isTabs() ? 'tablist' : 'group'"
      [attr.aria-label]="ariaLabel()"
      class="inline-flex w-max max-w-full flex-wrap gap-1 rounded-2xl border border-[color:color-mix(in_srgb,var(--shell-accent)_10%,var(--color-border))] bg-[color:color-mix(in_srgb,var(--color-bg-tertiary)_58%,transparent)] p-1"
      [class.max-sm:w-full]="fullWidthOnMobile()"
    >
      @for (option of options(); track option.value) {
        <button
          type="button"
          [disabled]="option.disabled"
          [attr.aria-pressed]="isTabs() ? null : value() === option.value"
          [attr.role]="isTabs() ? 'tab' : null"
          [attr.aria-selected]="isTabs() ? value() === option.value : null"
          [attr.tabindex]="isTabs() ? (value() === option.value ? 0 : -1) : null"
          [attr.id]="isTabs() ? idPrefix() + '-tab-' + option.value : null"
          [attr.aria-controls]="isTabs() ? idPrefix() + '-panel' : null"
          [attr.data-value]="option.value"
          (click)="select(option)"
          (keydown)="onKeydown($event)"
          class="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-[0.8125rem] font-extrabold text-[var(--color-text-secondary)] transition hover:bg-[color:color-mix(in_srgb,var(--shell-accent)_7%,transparent)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40 max-sm:flex-1"
          [class.bg-[color:color-mix(in_srgb,var(--shell-accent)_12%,var(--color-bg-secondary))]]="
            value() === option.value
          "
          [class.!text-[var(--shell-accent)]]="value() === option.value"
          [class.shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--shell-accent)_16%,transparent)]]="
            value() === option.value
          "
        >
          @if (option.icon) {
            <mat-icon class="!h-4 !w-4 !text-base !leading-4" aria-hidden="true">{{ option.icon }}</mat-icon>
          }
          <span>{{ option.label }}</span>
          @if (option.count !== undefined && option.count !== null) {
            <span class="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-[0.6875rem] tabular-nums">{{
              option.count
            }}</span>
          }
        </button>
      }
    </div>
  `,
})
export class SegmentedControlComponent<T extends string> {
  readonly options = input.required<readonly SegmentOption<T>[]>();
  readonly value = model.required<T>();
  readonly ariaLabel = input.required<string>();
  readonly fullWidthOnMobile = input(true);
  /** `toggle` (default): a button group with `aria-pressed`. `tabs`: a tablist that switches a page section. */
  readonly mode = input<'toggle' | 'tabs'>('toggle');
  /** Prefix for tab and panel ids in `tabs` mode. */
  readonly idPrefix = input('segment');

  protected readonly isTabs = computed(() => this.mode() === 'tabs');

  protected select(option: SegmentOption<T>): void {
    if (!option.disabled) this.value.set(option.value);
  }

  /** Tabs mode only: Arrow keys move to the next/previous enabled tab (wrapping), Home/End to the first/last. */
  protected onKeydown(event: KeyboardEvent): void {
    if (!this.isTabs()) return;
    const enabled = this.options().filter((o) => !o.disabled);
    if (!enabled.length) return;
    const current = enabled.findIndex((o) => o.value === this.value());
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (current + 1) % enabled.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (current - 1 + enabled.length) % enabled.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = enabled[next];
    if (!target) return;
    this.value.set(target.value);
    const container = (event.currentTarget as HTMLElement).parentElement;
    container?.querySelector<HTMLButtonElement>(`[data-value="${target.value}"]`)?.focus();
  }
}
