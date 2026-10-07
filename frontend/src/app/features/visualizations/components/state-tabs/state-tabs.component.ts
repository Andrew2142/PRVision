import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { type VisualChange } from '../../../../core/models/domain-enums.model';
import { type ComponentStateView } from '../../../../core/models/visualization.model';
import {
  type SegmentOption,
  SegmentedControlComponent,
} from '../../../../shared/components/segmented-control/segmented-control.component';

const CHANGED: ReadonlySet<VisualChange> = new Set<VisualChange>(['changed', 'new', 'deleted']);

/** Tab text of a state: its name, plus "(new)" / "(removed)" when only one side has it. */
export function stateTabLabel(state: Pick<ComponentStateView, 'name' | 'onBase' | 'onHead'>): string {
  if (state.onHead && !state.onBase) return `${state.name} (new)`;
  if (state.onBase && !state.onHead) return `${state.name} (removed)`;
  return state.name;
}

export function isChangedState(state: Pick<ComponentStateView, 'visualChange'>): boolean {
  return state.visualChange !== null && CHANGED.has(state.visualChange);
}

/**
 * One tab per state of a component (16 §15.5.2), with a dot on states that changed. Hidden when the component has
 * a single state. `selected` is the state's ordinal.
 */
@Component({
  selector: 'app-state-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SegmentedControlComponent],
  host: { class: 'block' },
  template: `
    @if (states().length > 1) {
      <app-segmented-control
        mode="tabs"
        ariaLabel="Component states"
        [idPrefix]="idPrefix()"
        [options]="options()"
        [value]="selectedValue()"
        [fullWidthOnMobile]="false"
        (valueChange)="select($event)"
      />
    }
  `,
})
export class StateTabsComponent {
  readonly states = input.required<readonly ComponentStateView[]>();
  readonly selected = model.required<number>();
  /** Tab ids are `<idPrefix>-tab-<ordinal>`; the panel they control is `<idPrefix>-panel`. */
  readonly idPrefix = input('state');

  protected readonly options = computed<SegmentOption<string>[]>(() =>
    this.states().map((state) => ({
      value: String(state.ordinal),
      label: stateTabLabel(state),
      marker: isChangedState(state) ? { testId: 'state-changed-marker', label: 'changed' } : null,
    })),
  );
  protected readonly selectedValue = computed(() => String(this.selected()));

  protected select(value: string): void {
    this.selected.set(Number(value));
  }
}
