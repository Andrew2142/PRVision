import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { type VisualizationStatus } from '../../../../core/models/domain-enums.model';
import { PIPELINE_STAGES, stageIndex } from '../../../../core/utils/visualization-status.util';

type StepState = 'done' | 'current' | 'pending' | 'failed' | 'cancelled';

const STEP_VIEW: Record<StepState, { circle: string; label: string; sr: string }> = {
  done: {
    circle: 'bg-[var(--shell-accent)] text-[var(--shell-accent-contrast)]',
    label: 'text-[var(--color-text-secondary)]',
    sr: '(done)',
  },
  current: {
    circle: 'border-2 border-[var(--shell-accent)] text-[var(--shell-accent)]',
    label: 'font-semibold text-[var(--color-text-primary)]',
    sr: '(in progress)',
  },
  pending: {
    circle: 'border border-[color:var(--color-border-light)] text-[var(--color-text-disabled)]',
    label: 'text-[var(--color-text-tertiary)]',
    sr: '(pending)',
  },
  failed: {
    circle: 'bg-[var(--color-error)] text-white',
    label: 'font-semibold text-[var(--color-error)]',
    sr: '(failed here)',
  },
  cancelled: {
    circle: 'bg-[var(--color-warning)] text-white',
    label: 'font-semibold text-[var(--color-warning)]',
    sr: '(cancelled here)',
  },
};

/** Seven-stage progress for a visualization (13 §5.9.5). A failed/cancelled run stops at `stoppedStageIndex`. */
@Component({
  selector: 'app-pipeline-stepper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  host: { class: 'block' },
  template: `
    <ol class="flex flex-col gap-3 md:flex-row md:items-center md:gap-0" aria-label="Pipeline progress">
      @for (s of steps(); track s.status) {
        <li
          class="flex min-w-0 items-center gap-2 md:flex-1"
          [class.md:flex-none]="s.last"
          [attr.aria-current]="s.ariaCurrent"
        >
          <span class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full" [class]="s.circleClass">
            @if (s.state === 'current') {
              <span
                class="dd-pill__dot--pulse absolute -inset-1 rounded-full border-2 border-[color:color-mix(in_srgb,var(--shell-accent)_45%,transparent)]"
                aria-hidden="true"
              ></span>
            }
            <mat-icon class="!h-4 !w-4 !text-base !leading-4" aria-hidden="true">{{ s.icon }}</mat-icon>
          </span>
          <span class="min-w-0 text-sm leading-tight" [class]="s.labelClass">
            {{ s.label }} <span class="sr-only">{{ s.srText }}</span>
          </span>
          @if (!s.last) {
            <span class="mx-2 hidden h-px min-w-3 flex-1 md:block" [class]="s.connectorClass" aria-hidden="true"></span>
          }
        </li>
      }
    </ol>
  `,
})
export class PipelineStepperComponent {
  readonly status = input.required<VisualizationStatus>();
  /** Where a failed or cancelled run stopped (from `failedStage`, console inference only as a fallback). */
  readonly stoppedStageIndex = input<number>(0);

  protected readonly steps = computed(() => {
    const status = this.status();
    const current = stageIndex(status);
    return PIPELINE_STAGES.map((stage, i) => {
      let state: StepState;
      if (status === 'completed') state = 'done';
      else if (status === 'failed' || status === 'cancelled') {
        const stop = this.stoppedStageIndex();
        state = i < stop ? 'done' : i === stop ? (status === 'failed' ? 'failed' : 'cancelled') : 'pending';
      } else state = i < current ? 'done' : i === current ? 'current' : 'pending';
      const view = STEP_VIEW[state];
      const icon =
        state === 'done' ? 'check' : state === 'failed' ? 'close' : state === 'cancelled' ? 'block' : stage.icon;
      return {
        ...stage,
        state,
        icon,
        circleClass: view.circle,
        labelClass: view.label,
        srText: view.sr,
        connectorClass: state === 'done' ? 'bg-[var(--shell-accent)]' : 'bg-[var(--color-border)]',
        ariaCurrent: state === 'current' ? 'step' : null,
        last: i === PIPELINE_STAGES.length - 1,
      };
    });
  });
}
