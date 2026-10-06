import { Clipboard } from '@angular/cdk/clipboard';
import { type ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { type ConsoleEventView } from '../../../../core/models/visualization.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { consoleEvent, consoleEvents } from '../../testing/visualization-fixtures';
import { ConsolePanelComponent } from './console-panel.component';

describe('ConsolePanelComponent', () => {
  let fixture: ComponentFixture<ConsolePanelComponent>;
  let el: HTMLElement;
  let notifications: jasmine.SpyObj<NotificationService>;
  let clipboard: jasmine.SpyObj<Clipboard>;

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success']);
    clipboard = jasmine.createSpyObj<Clipboard>('Clipboard', ['copy']);
    await TestBed.configureTestingModule({
      imports: [ConsolePanelComponent],
      providers: [
        { provide: NotificationService, useValue: notifications },
        { provide: Clipboard, useValue: clipboard },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ConsolePanelComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  function render(events: readonly ConsoleEventView[], inputs: { live?: boolean; defaultOpen?: boolean } = {}): void {
    fixture.componentRef.setInput('events', events);
    if (inputs.live !== undefined) fixture.componentRef.setInput('live', inputs.live);
    if (inputs.defaultOpen !== undefined) fixture.componentRef.setInput('defaultOpen', inputs.defaultOpen);
    fixture.detectChanges();
  }
  const log = (): HTMLElement | null => el.querySelector('[role="log"]');
  const details = (): HTMLDetailsElement => el.querySelector('details')!;
  /** Runs the requestAnimationFrame scheduled by the auto-scroll effect. */
  async function frame(): Promise<void> {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        resolve();
      }),
    );
    fixture.detectChanges();
  }
  function scroller(height = 100): HTMLElement {
    const s = log()!;
    s.style.maxHeight = `${height}px`;
    s.style.height = `${height}px`;
    s.style.overflow = 'auto'; // Tailwind utilities have no CSS under Karma
    return s;
  }

  it('renders level, stage and message as text (HTML not interpreted)', () => {
    render([
      consoleEvent(1, { level: 'warn', stage: 'rendering', message: '<img src=x onerror=alert(1)><b>bold</b>' }),
    ]);
    const row = el.querySelector('.pv-console__row');
    expect(row?.textContent).toContain('warn');
    expect(row?.textContent).toContain('[rendering]');
    expect(row?.textContent).toContain('<img src=x onerror=alert(1)><b>bold</b>');
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.querySelector('b')).toBeNull();
  });

  it('uses pv-console__* classes, no text-slate-* classes', () => {
    render([consoleEvent(1, { level: 'error' })]);
    expect(el.querySelector('.pv-console')).not.toBeNull();
    expect(el.querySelector('.pv-console__level--error')).not.toBeNull();
    expect(el.querySelector('.pv-console__muted')).not.toBeNull();
    expect(el.innerHTML).not.toMatch(/text-slate-/);
  });

  it('role=log and aria-live=polite while live', () => {
    render([consoleEvent(1)], { live: true });
    expect(log()?.getAttribute('aria-live')).toBe('polite');
    expect(log()?.getAttribute('aria-relevant')).toBe('additions');
    expect(log()?.getAttribute('tabindex')).toBe('0');
    expect(el.textContent).toContain('Live');
  });

  it('aria-live=off when not live', () => {
    render([consoleEvent(1)], { live: false });
    expect(log()?.getAttribute('aria-live')).toBe('off');
    expect(el.textContent).toContain('Finished');
  });

  it('auto-scrolls when at bottom', async () => {
    render(consoleEvents(1, 10), { live: true });
    const s = scroller();
    await frame();
    render(consoleEvents(1, 60), { live: true });
    await frame();
    expect(s.scrollTop).toBeGreaterThan(0);
    expect(s.scrollHeight - s.scrollTop - s.clientHeight).toBeLessThan(24);
    expect(el.textContent).not.toContain('Jump to latest');
  });

  it('does not scroll when user scrolled up and shows Jump to latest with unseen count', async () => {
    render(consoleEvents(1, 40), { live: true });
    const s = scroller();
    await frame();
    await frame();
    s.scrollTop = 0;
    s.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    render(consoleEvents(1, 45), { live: true });
    await frame();
    expect(s.scrollTop).toBe(0);
    const jump = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Jump to latest'));
    expect(jump?.textContent).toContain('Jump to latest (5 new)');
    jump?.click();
    fixture.detectChanges();
    expect(s.scrollTop).toBeGreaterThan(0);
    expect(el.textContent).not.toContain('Jump to latest');
  });

  it('Issues filter hides info', () => {
    render([consoleEvent(1), consoleEvent(2, { level: 'warn' }), consoleEvent(3, { level: 'error' })]);
    expect(el.querySelectorAll('.pv-console__row').length).toBe(3);
    const issues = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Issues'));
    expect(issues?.textContent).toContain('2');
    issues?.click();
    fixture.detectChanges();
    const levels = Array.from(el.querySelectorAll('.pv-console__row span.uppercase')).map((s) => s.textContent);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('Show earlier increases render limit', () => {
    render(consoleEvents(1, 520));
    expect(el.querySelectorAll('.pv-console__row').length).toBe(500);
    const more = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Show earlier'));
    expect(more?.textContent).toContain('Show earlier events (20)');
    more?.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.pv-console__row').length).toBe(520);
    expect(el.textContent).not.toContain('Show earlier');
  });

  it('opens by default while live and collapses when defaultOpen becomes false unless user toggled', fakeAsync(() => {
    render([consoleEvent(1)], { live: true, defaultOpen: true });
    expect(details().open).toBeTrue();
    render([consoleEvent(1)], { live: false, defaultOpen: false });
    tick();
    expect(details().open).toBeFalse();

    // A user toggle wins over later defaultOpen changes.
    details().open = true;
    details().dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    render([consoleEvent(1)], { live: false, defaultOpen: false });
    tick();
    expect(details().open).toBeTrue();
  }));

  it('copy writes plain text', () => {
    render([consoleEvent(1, { level: 'warn', stage: 'rendering', message: 'Missing <Provider>' })]);
    const copy = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Copy'));
    copy?.click();
    const text = clipboard.copy.calls.mostRecent().args[0];
    expect(text).toMatch(/^\d{2}:\d{2}:\d{2} WARN \[rendering\] Missing <Provider>$/);
    expect(notifications.success.calls.allArgs()).toEqual([['Console copied']]);
  });

  it('empty console shows the placeholder', () => {
    render([], { live: true });
    expect(el.textContent).toContain('No console events yet');
    expect(log()).toBeNull();
  });
});
