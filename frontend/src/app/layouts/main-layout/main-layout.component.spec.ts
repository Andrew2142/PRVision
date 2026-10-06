import { BreakpointObserver, type BreakpointState } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { BehaviorSubject, map } from 'rxjs';
import { APP_VERSION } from '../../core/constants/ui.constants';
import { type ApiHealth, HealthService } from '../../core/services/health.service';
import { ThemeService } from '../../core/services/theme.service';
import { MainLayoutComponent } from './main-layout.component';

@Component({ selector: 'app-dummy-page', changeDetection: ChangeDetectionStrategy.OnPush, template: 'page' })
class DummyPageComponent {}

class FakeHealthService {
  readonly status = signal<ApiHealth>('unknown');
  readonly start = jasmine.createSpy('start');
}

class FakeThemeService {
  readonly isDark = signal(true);
  toggle(): void {
    this.isDark.set(!this.isDark());
  }
}

describe('MainLayoutComponent', () => {
  let fixture: ComponentFixture<MainLayoutComponent>;
  let el: HTMLElement;
  let router: Router;
  let health: FakeHealthService;
  let desktop: BehaviorSubject<boolean>;

  async function setup(isDesktop: boolean): Promise<void> {
    desktop = new BehaviorSubject(isDesktop);
    health = new FakeHealthService();
    await TestBed.configureTestingModule({
      imports: [MainLayoutComponent],
      providers: [
        provideNoopAnimations(),
        provideRouter([
          { path: 'repositories', title: 'Repositories', component: DummyPageComponent },
          { path: 'visualizations', title: 'Visualizations', component: DummyPageComponent },
          { path: 'settings', title: 'Settings', component: DummyPageComponent },
        ]),
        { provide: HealthService, useValue: health },
        { provide: ThemeService, useClass: FakeThemeService },
        {
          provide: BreakpointObserver,
          useValue: {
            observe: () => desktop.pipe(map((matches): BreakpointState => ({ matches, breakpoints: {} }))),
          },
        },
      ],
    }).compileComponents();
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(MainLayoutComponent);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  }

  async function navigate(url: string): Promise<void> {
    await fixture.ngZone?.run(() => router.navigateByUrl(url));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function aside(): HTMLElement {
    const node = el.querySelector<HTMLElement>('aside#app-sidebar');
    if (!node) throw new Error('no sidebar');
    return node;
  }

  function menuButton(): HTMLButtonElement | null {
    return el.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
  }

  function navLinks(): HTMLAnchorElement[] {
    return Array.from(el.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Main"] a'));
  }

  it('renders Repositories, Visualizations, Settings links', async () => {
    await setup(true);
    expect(navLinks().map((a) => a.querySelector('span')?.textContent?.trim())).toEqual([
      'Repositories',
      'Visualizations',
      'Settings',
    ]);
    expect(navLinks().map((a) => a.querySelector('mat-icon')?.textContent?.trim())).toEqual([
      'source',
      'compare',
      'tune',
    ]);
    expect(navLinks().map((a) => a.getAttribute('href'))).toEqual(['/repositories', '/visualizations', '/settings']);
    expect(health.start).toHaveBeenCalled();
  });

  it('active link gets nav-link-active and aria-current', async () => {
    await setup(true);
    await navigate('/visualizations');
    const [repos, visualizations] = navLinks();
    expect(visualizations?.classList).toContain('nav-link-active');
    expect(visualizations?.getAttribute('aria-current')).toBe('page');
    expect(repos?.classList).not.toContain('nav-link-active');
    expect(repos?.hasAttribute('aria-current')).toBeFalse();
  });

  it('desktop shows sidebar without menu button', async () => {
    await setup(true);
    expect(menuButton()).toBeNull();
    expect(aside().hasAttribute('inert')).toBeFalse();
    expect(aside().classList).not.toContain('!fixed');
  });

  it('mobile: menu button opens drawer, Escape closes, focus returns', async () => {
    await setup(false);
    const button = menuButton();
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    button?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(aside().hasAttribute('inert')).toBeFalse();
    expect(document.activeElement).toBe(navLinks()[0] ?? null);
    expect(el.querySelector('button[aria-label="Close navigation"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(aside().hasAttribute('inert')).toBeTrue();
    expect(document.activeElement).toBe(button);
  });

  it('hidden drawer is inert', async () => {
    await setup(false);
    expect(aside().hasAttribute('inert')).toBeTrue();
    expect(aside().classList).toContain('-translate-x-full');
    expect(aside().classList).toContain('!fixed');
  });

  it('theme button toggles and updates aria-label', async () => {
    await setup(true);
    const button = el.querySelector<HTMLButtonElement>('button[aria-label="Switch to light theme"]');
    expect(button?.textContent?.trim()).toBe('light_mode');
    button?.click();
    fixture.detectChanges();
    expect(button?.getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(button?.textContent?.trim()).toBe('dark_mode');
  });

  it('health offline/degraded/online pills', async () => {
    await setup(true);
    const pill = (): HTMLElement | null => el.querySelector('[role="status"] .dd-pill');
    expect(pill()?.textContent?.trim()).toBe('Connecting…');
    expect(pill()?.classList).toContain('dd-pill--muted');
    const cases: [ApiHealth, string, string][] = [
      ['offline', 'API offline', 'dd-pill--danger'],
      ['degraded', 'API degraded', 'dd-pill--warning'],
      ['online', 'API online', 'dd-pill--info'],
    ];
    for (const [status, text, tone] of cases) {
      health.status.set(status);
      fixture.detectChanges();
      expect(pill()?.textContent?.trim()).withContext(status).toBe(text);
      expect(pill()?.classList).withContext(status).toContain(tone);
    }
  });

  it('NavigationEnd closes drawer and sets section title', async () => {
    await setup(false);
    menuButton()?.click();
    fixture.detectChanges();
    expect(aside().hasAttribute('inert')).toBeFalse();
    await navigate('/settings');
    expect(aside().hasAttribute('inert')).toBeTrue();
    expect(el.querySelector('header.pv-topbar')?.textContent).toContain('Settings');
  });

  it('version text uses APP_VERSION', async () => {
    await setup(true);
    expect(aside().textContent).toContain(`localhost:3100 · v${APP_VERSION}`);
  });
});
