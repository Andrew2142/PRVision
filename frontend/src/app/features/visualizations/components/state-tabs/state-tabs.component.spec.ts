import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { type ComponentStateView } from '../../../../core/models/visualization.model';
import { stateView } from '../../testing/visualization-fixtures';
import { StateTabsComponent, isChangedState, stateTabLabel } from './state-tabs.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateTabsComponent],
  template: `<app-state-tabs [states]="states()" [(selected)]="selected" idPrefix="cmp-11-states" />`,
})
class HostComponent {
  readonly states = signal<readonly ComponentStateView[]>([]);
  readonly selected = signal(0);
}

describe('StateTabsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement as HTMLElement;
  });

  function render(states: ComponentStateView[], selected = 0): void {
    host.states.set(states);
    host.selected.set(selected);
    fixture.detectChanges();
  }
  const tabs = (): HTMLButtonElement[] => Array.from(el.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  const THREE = [
    stateView(0),
    stateView(1, { name: 'Overdue', visualChange: 'changed' }),
    stateView(2, { name: 'Menu open', onBase: false, visualChange: 'new' }),
  ];

  it('hidden for a single state', () => {
    render([stateView(0)]);
    expect(el.querySelector('[role="tablist"]')).toBeNull();
  });

  it('one tab per state, in order, with the selected one marked', () => {
    render(THREE, 1);
    expect(el.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Component states');
    expect(tabs().map((t) => t.textContent?.trim())).toEqual(['Default', 'Overdue', 'Menu open (new)']);
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs()[0]?.id).toBe('cmp-11-states-tab-0');
    expect(tabs()[0]?.getAttribute('aria-controls')).toBe('cmp-11-states-panel');
  });

  it('a filled dot marks changed, new and deleted states', () => {
    render([...THREE, stateView(3, { name: 'Empty', onHead: false, visualChange: 'deleted' })]);
    const marked = tabs().map((t) => t.querySelector('[data-testid="state-changed-marker"]') !== null);
    expect(marked).toEqual([false, true, true, true]);
    expect(tabs()[1]?.querySelector('[data-testid="state-changed-marker"]')?.getAttribute('aria-label')).toBe(
      'changed',
    );
    expect(tabs()[3]?.textContent?.trim()).toBe('Empty (removed)');
  });

  it('clicking and arrow keys update the selected ordinal (two-way)', () => {
    render(THREE);
    tabs()[2]?.click();
    fixture.detectChanges();
    expect(host.selected()).toBe(2);
    tabs()[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    fixture.detectChanges();
    expect(host.selected()).toBe(0);
  });

  it('labels and changed helper', () => {
    expect(stateTabLabel({ name: 'Default', onBase: true, onHead: true })).toBe('Default');
    expect(stateTabLabel({ name: 'Overdue', onBase: false, onHead: true })).toBe('Overdue (new)');
    expect(stateTabLabel({ name: 'Overdue', onBase: true, onHead: false })).toBe('Overdue (removed)');
    expect(isChangedState({ visualChange: 'unchanged' })).toBeFalse();
    expect(isChangedState({ visualChange: null })).toBeFalse();
    expect(isChangedState({ visualChange: 'changed' })).toBeTrue();
  });
});
