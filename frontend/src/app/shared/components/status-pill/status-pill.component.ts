import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type PillKind, resolvePill } from './status-pill.config';

/** Uply's `dd-pill` with PRVision's kind/value mapping. */
@Component({
  selector: 'app-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span [class]="pillClass()" [attr.aria-label]="ariaLabel()">
    @if (spec().live) {
      <span class="dd-pill__dot dd-pill__dot--pulse" aria-hidden="true"></span>
    }
    {{ text() }}</span
  >`,
})
export class StatusPillComponent {
  readonly kind = input.required<PillKind>();
  readonly value = input<string | null | undefined>();
  readonly label = input<string | null>(null);
  readonly ariaPrefix = input<string | null>(null);

  protected readonly spec = computed(() => resolvePill(this.kind(), this.value()));
  protected readonly pillClass = computed(() => `dd-pill dd-pill--${this.spec().tone}`);
  protected readonly text = computed(() => this.label() ?? this.spec().label);
  protected readonly ariaLabel = computed(() => {
    const prefix = this.ariaPrefix();
    return prefix ? `${prefix}: ${this.text()}` : null;
  });
}
