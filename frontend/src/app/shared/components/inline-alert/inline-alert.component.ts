import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

export type InlineAlertTone = 'info' | 'success' | 'warning' | 'error';

const TONE_VAR: Record<InlineAlertTone, string> = {
  info: 'var(--color-info)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  error: 'var(--color-error)',
};

const TONE_ICON: Record<InlineAlertTone, string> = {
  info: 'info',
  success: 'check_circle',
  warning: 'warning',
  error: 'error',
};

/** Uply's run-detail loading/error box, generalized: tinted banner with optional title and actions. */
@Component({
  selector: 'app-inline-alert',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  host: { class: 'block' },
  template: `
    <div
      [attr.role]="role()"
      class="flex flex-col gap-3 rounded-[14px] border px-4 py-3.5 text-[0.94rem] sm:flex-row sm:items-start sm:justify-between"
      [style.border-color]="borderColor()"
      [style.background]="background()"
    >
      <div class="flex min-w-0 gap-3">
        <mat-icon class="mt-0.5 shrink-0" [style.color]="toneVar()" aria-hidden="true">{{ resolvedIcon() }}</mat-icon>
        <div class="min-w-0">
          @if (title()) {
            <p class="font-semibold text-[var(--color-text-primary)]">{{ title() }}</p>
          }
          <div class="text-sm leading-6 text-[var(--color-text-secondary)]"><ng-content /></div>
        </div>
      </div>
      <div class="flex shrink-0 gap-2 empty:hidden"><ng-content select="[inlineAlertAction]" /></div>
    </div>
  `,
})
export class InlineAlertComponent {
  readonly tone = input<InlineAlertTone>('info');
  readonly title = input<string | null>(null);
  readonly icon = input<string | null>(null);

  protected readonly role = computed(() => (this.tone() === 'error' ? 'alert' : 'status'));
  protected readonly toneVar = computed(() => TONE_VAR[this.tone()]);
  protected readonly resolvedIcon = computed(() => this.icon() ?? TONE_ICON[this.tone()]);
  protected readonly borderColor = computed(() => `color-mix(in srgb, ${this.toneVar()} 18%, var(--color-border))`);
  protected readonly background = computed(
    () => `color-mix(in srgb, ${this.toneVar()} 10%, var(--color-bg-secondary))`,
  );
}
