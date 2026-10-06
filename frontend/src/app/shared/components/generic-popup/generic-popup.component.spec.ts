import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { GenericPopupComponent, type PopupConfig } from './generic-popup.component';

@Component({
  selector: 'app-popup-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GenericPopupComponent],
  template: `
    <button id="opener" type="button">Open</button>
    <app-generic-popup
      [shouldShow]="show()"
      [config]="config()"
      [closeOnBackdrop]="closeOnBackdrop()"
      [closeOnEscape]="closeOnEscape()"
      (closePopup)="closeCount.set(closeCount() + 1)"
    >
      <p>Body text</p>
      @if (withInitial()) {
        <input id="first-field" aria-label="Name" />
        <input id="initial-field" aria-label="Path" cdkFocusInitial />
      }
      <button id="inner" type="button">Inner</button>
    </app-generic-popup>
  `,
})
class HostComponent {
  readonly show = signal(false);
  readonly config = signal<PopupConfig>({
    title: 'Add repository',
    primaryButtonText: 'Add',
    secondaryButtonText: 'Cancel',
  });
  readonly closeOnBackdrop = signal(true);
  readonly closeOnEscape = signal<boolean | null>(null);
  readonly withInitial = signal(false);
  readonly closeCount = signal(0);
}

describe('GenericPopupComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    el = fixture.nativeElement as HTMLElement;
    // Attach to ApplicationRef like a real app so CDK's afterNextRender focus capture runs in the same tick.
    fixture.autoDetectChanges(true);
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  function open(): void {
    host.show.set(true);
    fixture.detectChanges();
    tick(10);
    fixture.detectChanges();
    tick(0);
  }

  function close(): void {
    host.show.set(false);
    fixture.detectChanges();
    tick(300);
    fixture.detectChanges();
  }

  function panel(): HTMLElement | null {
    return el.querySelector<HTMLElement>('[role="dialog"]');
  }

  function escape(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
  }

  it('renders when shouldShow true', fakeAsync(() => {
    expect(panel()).toBeNull();
    open();
    expect(panel()).not.toBeNull();
    expect(panel()?.getAttribute('aria-modal')).toBe('true');
    const titleId = panel()?.getAttribute('aria-labelledby') ?? '';
    expect(el.querySelector(`#${titleId}`)?.textContent?.trim()).toBe('Add repository');
    expect(el.textContent).toContain('Body text');
    close();
    expect(panel()).toBeNull();
  }));

  it('Escape emits closePopup when closeOnEscape', fakeAsync(() => {
    open();
    escape();
    expect(host.closeCount()).toBe(1);
    host.closeOnEscape.set(false);
    fixture.detectChanges();
    escape();
    expect(host.closeCount()).toBe(1);
    close();
  }));

  it('backdrop click respects closeOnBackdrop', fakeAsync(() => {
    open();
    const backdrop = el.querySelector<HTMLElement>('.fixed.inset-0 > [aria-hidden="true"]');
    backdrop?.click();
    expect(host.closeCount()).toBe(1);
    host.closeOnBackdrop.set(false);
    fixture.detectChanges();
    backdrop?.click();
    expect(host.closeCount()).toBe(1);
    close();
  }));

  it('primary disabled while loading', fakeAsync(() => {
    host.config.set({ title: 'Save', primaryButtonText: 'Save', loading: true });
    open();
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('button[mat-flat-button]'));
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.disabled).toBeTrue();
    host.config.set({ title: 'Save', primaryButtonText: 'Save' });
    fixture.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('button[mat-flat-button]')?.disabled).toBeFalse();
    close();
  }));

  it('restores focus after close', fakeAsync(() => {
    const opener = el.querySelector<HTMLButtonElement>('#opener');
    opener?.focus();
    open();
    expect(document.activeElement).not.toBe(opener);
    close();
    flush();
    expect(document.activeElement).toBe(opener);
  }));

  it('locks and unlocks body scroll', fakeAsync(() => {
    document.body.style.overflow = 'auto';
    open();
    expect(document.body.style.overflow).toBe('hidden');
    close();
    expect(document.body.style.overflow).toBe('auto');
  }));

  it('focuses [cdkFocusInitial] element when present, else the panel', fakeAsync(() => {
    open();
    expect(document.activeElement).toBe(panel());
    close();
    host.withInitial.set(true);
    open();
    expect(document.activeElement?.id).toBe('initial-field');
    close();
  }));

  it('Tab cycles inside the panel (focus trap)', fakeAsync(() => {
    open();
    const anchors = Array.from(el.querySelectorAll<HTMLElement>('.cdk-focus-trap-anchor'));
    expect(anchors.length).toBe(2);
    // Tabbing past the last element lands on the end anchor, which wraps focus to the first tabbable.
    anchors[1]?.focus();
    flush();
    expect(panel()?.contains(document.activeElement)).toBeTrue();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close popup');
    // Shift+Tab before the first element lands on the start anchor, which wraps to the last tabbable.
    anchors[0]?.focus();
    flush();
    expect(panel()?.contains(document.activeElement)).toBeTrue();
    expect(document.activeElement?.textContent?.trim()).toBe('Add');
    close();
  }));
});
