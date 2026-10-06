import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { APP_VERSION } from '../../core/constants/ui.constants';
import { HealthService } from '../../core/services/health.service';
import { ThemeService } from '../../core/services/theme.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Uply's app shell: gradient sidebar, PRVision top bar (section title, API pill, theme toggle), responsive drawer. */
@Component({
  selector: 'app-main-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './main-layout.component.html',
  host: { '(document:keydown.escape)': 'onEscape()' },
})
export class MainLayoutComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly health = inject(HealthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly injector = inject(Injector);

  protected readonly navGroups: readonly NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { path: '/repositories', label: 'Repositories', icon: 'source' },
        { path: '/visualizations', label: 'Visualizations', icon: 'compare' },
      ],
    },
    { label: 'Configure', items: [{ path: '/settings', label: 'Settings', icon: 'tune' }] },
  ];
  protected readonly appVersion = APP_VERSION;
  protected readonly apiHost = new URL(environment.apiBaseUrl).host;

  protected readonly isDesktop = toSignal(this.breakpoints.observe('(min-width: 1024px)').pipe(map((s) => s.matches)), {
    initialValue: true,
  });
  protected readonly drawerOpen = signal(false);
  protected readonly sidebarHidden = computed(() => !this.isDesktop() && !this.drawerOpen());
  protected readonly sectionTitle = signal('');

  // Optional (not .required): the first NavigationEnd can arrive before the view queries resolve.
  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');
  private readonly firstNavLink = viewChild<ElementRef<HTMLElement>>('firstNavLink');
  // The menu button hosts MatIconButton, so read the element explicitly.
  private readonly menuButton = viewChild<unknown, ElementRef<HTMLElement>>('menuButton', { read: ElementRef });

  constructor() {
    this.health.start(); // idempotent; polls GET /api/health every HEALTH_POLL_MS
    this.sectionTitle.set(this.deepestTitle());
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.drawerOpen.set(false);
        this.sectionTitle.set(this.deepestTitle());
        this.scrollContainer()?.nativeElement.scrollTo({ top: 0 });
      });
  }

  protected openDrawer(): void {
    this.drawerOpen.set(true);
    // After render: the sidebar is `inert` until the view updates, and inert elements cannot take focus.
    afterNextRender(
      () => {
        this.firstNavLink()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected closeDrawer(restoreFocus = true): void {
    if (!this.drawerOpen()) return;
    this.drawerOpen.set(false);
    if (restoreFocus) this.menuButton()?.nativeElement.focus();
  }

  protected onEscape(): void {
    this.closeDrawer();
  }

  private deepestTitle(): string {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.title ?? '';
  }
}
