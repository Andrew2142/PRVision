import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type RepositoryView } from '../../../../core/models/repository.model';
import { DateTimePipe } from '../../../../shared/pipes/date-time.pipe';
import { RelativeTimePipe } from '../../../../shared/pipes/relative-time.pipe';
import { toDetectedRows } from '../../repository-format';

/** "Project detection" card on the repository detail page (13 §5.7.3). */
@Component({
  selector: 'app-detection-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule, MatIconModule, MatTooltipModule, RelativeTimePipe, DateTimePipe],
  template: `
    <mat-card
      class="h-full !rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-md)]"
    >
      <div class="mb-2">
        <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Project detection</h3>
        <p class="mt-1 max-w-2xl text-sm text-[var(--color-text-secondary)]">
          What PRVision found in the clone. Re-detect after changing the project setup.
        </p>
      </div>
      <dl class="divide-y divide-[color:var(--color-border)]">
        @for (row of rows(); track row.label) {
          <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3">
            <dt class="text-sm text-[var(--color-text-tertiary)]">{{ row.label }}</dt>
            <dd
              class="min-w-0 whitespace-pre-line break-words text-right text-sm font-medium text-[var(--color-text-primary)]"
              [class.pv-code]="row.mono"
            >
              @if (row.warn) {
                <span
                  class="inline-flex items-center gap-1 text-[var(--color-warning)]"
                  matTooltip="Rendering may fail without it. Fix the project, then Re-detect."
                  tabindex="0"
                >
                  <mat-icon class="!h-4 !w-4 !text-base" aria-hidden="true">warning</mat-icon>
                  {{ row.value }}
                  <span class="sr-only">Rendering may fail without it. Fix the project, then Re-detect.</span>
                </span>
              } @else {
                {{ row.value }}
              }
            </dd>
          </div>
        }
        <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3">
          <dt class="text-sm text-[var(--color-text-tertiary)]">Last detected</dt>
          <dd
            class="text-right text-sm font-medium text-[var(--color-text-primary)]"
            [title]="repository().lastDetectedAt | dateTime"
          >
            {{ repository().lastDetectedAt | relativeTime }}
          </dd>
        </div>
      </dl>
    </mat-card>
  `,
})
export class DetectionCardComponent {
  readonly repository = input.required<RepositoryView>();
  protected readonly rows = computed(() => toDetectedRows(this.repository(), { includeIdentity: false }));
}
