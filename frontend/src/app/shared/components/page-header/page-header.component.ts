import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';

/** Uply's page header row: back button, eyebrow, h1 (with an optional addon beside it), subtitle, meta slot, right-aligned actions. */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule],
  host: { class: 'block' },
  template: `
    <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div class="flex min-w-0 items-start gap-3">
        @if (routerLinkValue(); as link) {
          <a mat-icon-button [routerLink]="link" [attr.aria-label]="backLabel()" class="mt-0.5 shrink-0">
            <mat-icon aria-hidden="true">arrow_back</mat-icon>
          </a>
        }
        <div class="min-w-0">
          @if (eyebrow()) {
            <p class="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              {{ eyebrow() }}
            </p>
          }
          <div class="flex min-w-0 items-center gap-3">
            <h1 class="min-w-0 truncate font-display text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">
              {{ title() }}
            </h1>
            <ng-content select="[pageHeaderTitleAddon]" />
          </div>
          @if (subtitle()) {
            <p class="mt-1 text-sm text-[var(--color-text-secondary)]">{{ subtitle() }}</p>
          }
          <div class="mt-1 flex flex-wrap items-center gap-2 empty:hidden">
            <ng-content select="[pageHeaderMeta]" />
          </div>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2 sm:gap-3 empty:hidden">
        <ng-content select="[pageHeaderActions]" />
      </div>
    </header>
  `,
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly eyebrow = input<string | null>(null);
  readonly backLink = input<string | readonly unknown[] | null>(null);
  readonly backLabel = input('Back');

  /** RouterLink takes a mutable array; copy a readonly command array. */
  protected readonly routerLinkValue = computed(() => {
    const link = this.backLink();
    return link === null || typeof link === 'string' ? link : [...link];
  });
}
