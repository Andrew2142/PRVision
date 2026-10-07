import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { type LibraryEstimateView } from '../../../../core/models/harness-library.model';
import { estimateErrorText, estimateText } from '../../../../core/utils/library-format.util';
import { InlineAlertComponent } from '../../../../shared/components/inline-alert/inline-alert.component';

/**
 * The harness library estimate (16 §15.2 item 3), shared by the Add repository library step and the scan dialog.
 * Purely presentational: the host requests the estimate and passes the state in.
 */
@Component({
  selector: 'app-library-estimate-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatProgressSpinnerModule, InlineAlertComponent],
  host: { class: 'block', 'data-testid': 'library-estimate' },
  template: `
    @if (loading()) {
      <p class="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]" data-testid="estimate-loading">
        <mat-spinner diameter="16" class="!inline-block" />
        Counting components…
      </p>
    } @else if (errorText() !== null) {
      <app-inline-alert tone="warning" data-testid="estimate-error">{{ errorText() }}</app-inline-alert>
    } @else {
      @if (text(); as t) {
        <div
          class="flex flex-col gap-2 rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-tertiary)] px-4 py-3 text-sm leading-6 text-[var(--color-text-secondary)]"
        >
          @if (mode() === 'scan') {
            <p data-testid="estimate-text">
              <strong class="text-[var(--color-text-primary)]">{{ t.count }}</strong> · about
              <strong class="text-[var(--color-text-primary)]">{{ t.cost }}</strong> {{ t.detail }}
            </p>
          } @else {
            <p data-testid="estimate-text">{{ t.growLine }}</p>
          }
          @if (t.priceNote) {
            <p class="text-xs text-[var(--color-text-tertiary)]" data-testid="estimate-price-note">
              {{ t.priceNote }}
            </p>
          }
        </div>
        @if (t.truncated) {
          <app-inline-alert class="mt-2" tone="warning" data-testid="estimate-truncated"
            >Only the first 2 000 components are counted.</app-inline-alert
          >
        }
      }
    }
  `,
})
export class LibraryEstimatePanelComponent {
  readonly estimate = input<LibraryEstimateView | null>(null);
  readonly loading = input(false);
  /** Server message of a failed estimate; adding or scanning still works. */
  readonly error = input<string | null>(null);
  /** `scan`: cost of writing now. `grow`: what writing everything would cost, and that growing costs nothing. */
  readonly mode = input<'scan' | 'grow'>('scan');
  /** `toWrite` (scan dialog): "12 of 201 components to write" instead of "201 components". */
  readonly countMode = input<'components' | 'toWrite'>('components');

  protected readonly errorText = computed(() => {
    const e = this.error();
    return e === null ? null : estimateErrorText(e);
  });
  protected readonly text = computed(() => {
    const e = this.estimate();
    return e ? { ...estimateText(e, this.countMode()), truncated: e.truncated } : null;
  });
}
