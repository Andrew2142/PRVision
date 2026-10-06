import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type SegmentOption, SegmentedControlComponent } from './segmented-control.component';

type Mode = 'side' | 'slider' | 'diff';

@Component({
  selector: 'app-segmented-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SegmentedControlComponent],
  template: `<app-segmented-control [options]="options" [(value)]="mode" ariaLabel="View mode" />`,
})
class HostComponent {
  readonly mode = signal<Mode>('side');
  readonly options: SegmentOption<Mode>[] = [
    { value: 'side', label: 'Side by side' },
    { value: 'slider', label: 'Slider', count: 3 },
    { value: 'diff', label: 'Diff', disabled: true },
  ];
}

describe('SegmentedControlComponent', () => {
  function setup(): { host: HostComponent; buttons: HTMLButtonElement[]; detect: () => void } {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return {
      host: fixture.componentInstance,
      buttons: Array.from(el.querySelectorAll('button')),
      detect: () => {
        fixture.detectChanges();
      },
    };
  }

  it('marks selected with aria-pressed=true', () => {
    const { buttons } = setup();
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(buttons[0]?.classList).toContain('!text-[var(--shell-accent)]');
    expect(buttons[1]?.classList).not.toContain('!text-[var(--shell-accent)]');
    expect(buttons[0]?.closest('[role="group"]')?.getAttribute('aria-label')).toBe('View mode');
  });

  it('click updates model', () => {
    const { host, buttons, detect } = setup();
    buttons[1]?.click();
    detect();
    expect(host.mode()).toBe('slider');
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('disabled option ignored', () => {
    const { host, buttons } = setup();
    expect(buttons[2]?.disabled).toBeTrue();
    buttons[2]?.click();
    expect(host.mode()).toBe('side');
  });

  it('renders count badge', () => {
    const { buttons } = setup();
    expect(buttons[1]?.textContent).toContain('3');
    expect(buttons[0]?.querySelectorAll('span').length).toBe(1);
  });

  describe('tabs mode', () => {
    @Component({
      selector: 'app-segmented-tabs-host',
      changeDetection: ChangeDetectionStrategy.OnPush,
      imports: [SegmentedControlComponent],
      template: `<app-segmented-control
        mode="tabs"
        idPrefix="pv"
        [options]="options"
        [(value)]="mode"
        ariaLabel="Sections"
      />`,
    })
    class TabsHostComponent {
      readonly mode = signal<Mode>('side');
      readonly options: SegmentOption<Mode>[] = [
        { value: 'side', label: 'Side by side', icon: 'view_column' },
        { value: 'slider', label: 'Slider' },
        { value: 'diff', label: 'Diff' },
      ];
    }

    function setupTabs(): {
      host: TabsHostComponent;
      el: HTMLElement;
      tabs: () => HTMLButtonElement[];
      detect: () => void;
    } {
      const fixture = TestBed.createComponent(TabsHostComponent);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      return {
        host: fixture.componentInstance,
        el,
        tabs: () => Array.from(el.querySelectorAll<HTMLButtonElement>('[role="tab"]')),
        detect: () => {
          fixture.detectChanges();
        },
      };
    }
    function key(target: HTMLElement, k: string): void {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    }

    it('uses tablist semantics with roving tabindex and panel ids', () => {
      const { el, tabs } = setupTabs();
      const list = el.querySelector('[role="tablist"]');
      expect(list?.getAttribute('aria-label')).toBe('Sections');
      expect(el.querySelector('[role="group"]')).toBeNull();
      expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
      expect(tabs().map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
      expect(tabs().map((t) => t.id)).toEqual(['pv-tab-side', 'pv-tab-slider', 'pv-tab-diff']);
      expect(tabs().every((t) => t.getAttribute('aria-controls') === 'pv-panel')).toBeTrue();
      expect(tabs().some((t) => t.hasAttribute('aria-pressed'))).toBeFalse();
    });

    it('arrow keys, Home and End move selection and focus (wrapping)', () => {
      const { host, tabs, detect } = setupTabs();
      const first = tabs()[0]!;
      first.focus();
      key(first, 'ArrowRight');
      detect();
      expect(host.mode()).toBe('slider');
      expect(document.activeElement).toBe(tabs()[1]!);
      expect(tabs()[1]?.getAttribute('tabindex')).toBe('0');
      key(tabs()[1]!, 'End');
      detect();
      expect(host.mode()).toBe('diff');
      key(tabs()[2]!, 'ArrowRight');
      detect();
      expect(host.mode()).toBe('side');
      key(tabs()[0]!, 'ArrowLeft');
      detect();
      expect(host.mode()).toBe('diff');
      key(tabs()[2]!, 'Home');
      detect();
      expect(host.mode()).toBe('side');
      expect(document.activeElement).toBe(tabs()[0]!);
    });

    it('ignores other keys and does nothing in toggle mode', () => {
      const tabsSetup = setupTabs();
      key(tabsSetup.tabs()[0]!, 'a');
      tabsSetup.detect();
      expect(tabsSetup.host.mode()).toBe('side');
      const toggle = setup();
      key(toggle.buttons[0]!, 'ArrowRight');
      toggle.detect();
      expect(toggle.host.mode()).toBe('side');
    });
  });
});
