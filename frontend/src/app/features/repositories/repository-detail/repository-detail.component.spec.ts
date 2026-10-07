import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed, discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type RepositoryView } from '../../../core/models/repository.model';
import { ConfirmDialogService, GENERIC_POPUP_DIALOG_CONFIG } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { NewVisualizationDialogComponent } from '../components/new-visualization-dialog/new-visualization-dialog.component';
import { librarySummaryView } from '../testing/library-fixtures';
import { RepositoryDetailComponent } from './repository-detail.component';

const BASE = environment.apiBaseUrl;

function repo(id: number, overrides: Partial<RepositoryView> = {}): RepositoryView {
  return {
    id,
    name: `repo-${String(id)}`,
    localPath: `/home/dev/projects/repo-${String(id)}`,
    githubOwner: 'acme',
    githubRepo: `repo-${String(id)}`,
    defaultBranch: 'main',
    framework: 'react_vite',
    appRoot: '.',
    angularProject: null,
    angularBuildConfiguration: null,
    renderViewport: 'desktop',
    libraryBuildMode: 'grow',
    stateAllowance: 3,
    packageManager: 'pnpm',
    viteConfigPath: 'vite.config.ts',
    tsconfigPath: 'tsconfig.json',
    entryFilePath: 'src/main.tsx',
    globalStylePaths: [],
    lastDetectedAt: '2026-10-03T10:00:00Z',
    createdAt: '2026-10-01T10:00:00Z',
    ...overrides,
  };
}

describe('RepositoryDetailComponent', () => {
  let fixture: ComponentFixture<RepositoryDetailComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let confirm: jasmine.SpyObj<ConfirmDialogService>;
  let navigate: jasmine.Spy;
  let dialog: jasmine.SpyObj<MatDialog>;

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']);
    confirm = jasmine.createSpyObj<ConfirmDialogService>('ConfirmDialogService', ['confirm']);
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    await TestBed.configureTestingModule({
      imports: [RepositoryDetailComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
        { provide: ConfirmDialogService, useValue: confirm },
        { provide: MatDialog, useValue: dialog },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(RepositoryDetailComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    // The recent visualizations and harness library cards issue their own GETs; they are not under test here.
    httpMock.match((req) => req.url.includes('/visualizations') || req.url.endsWith('/library'));
    httpMock.verify();
  });

  function render(id: string): void {
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
  }

  function respond(id: number, view: RepositoryView = repo(id)): void {
    httpMock.expectOne(`${BASE}/repositories/${String(id)}`).flush({ status: 200, data: view });
    fixture.detectChanges();
  }

  function button(text: string): HTMLButtonElement {
    const found = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes(text),
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
  }

  it('renders header, detection card and recent visualizations; the old launch tabs are gone (00 §16)', () => {
    render('3');
    respond(3);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('repo-3');
    expect(el.textContent).toContain('/home/dev/projects/repo-3');
    expect(el.textContent).toContain('default: main');
    expect(el.querySelector('app-detection-card')).not.toBeNull();
    expect(el.querySelector('app-recent-visualizations')).not.toBeNull();
    expect(el.querySelector('mat-tab-group')).toBeNull();
    expect(el.querySelector('app-pull-request-table')).toBeNull();
    expect(el.querySelector('app-local-sources')).toBeNull();
  });

  it('New visualization sits with Re-detect and Remove and opens the stepper dialog for this repository', () => {
    render('3');
    respond(3);
    const actions = el.querySelector('[data-testid="new-visualization"]')?.parentElement;
    const labels = Array.from(actions?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim() ?? '');
    expect(labels.some((t) => t.includes('Re-detect'))).toBeTrue();
    expect(labels.some((t) => t.includes('Remove'))).toBeTrue();
    expect(labels.at(-1)).toContain('New visualization');
    button('New visualization').click();
    expect(dialog.open.calls.allArgs()).toEqual([
      [NewVisualizationDialogComponent, { ...GENERIC_POPUP_DIALOG_CONFIG, data: { repository: repo(3) } }],
    ]);
  });

  it('header chips: framework only for a root React app', () => {
    render('3');
    respond(3);
    const chips = Array.from(el.querySelectorAll('[data-testid="app-chip"]')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['React + Vite']);
  });

  it('header chips: framework, app root and Angular project for an app inside a monorepo (15 §5.9.1)', () => {
    render('4');
    respond(
      4,
      repo(4, {
        framework: 'angular',
        appRoot: 'apps/web',
        angularProject: 'web',
        angularBuildConfiguration: 'development',
        viteConfigPath: null,
      }),
    );
    const chips = Array.from(el.querySelectorAll('[data-testid="app-chip"]')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['Angular', 'app root: apps/web', 'project: web']);
  });

  it('invalid id → not found without request', () => {
    render('abc');
    httpMock.expectNone(() => true);
    expect(el.textContent).toContain('Repository not found');
    expect(el.textContent).toContain('It may have been removed.');
  });

  it('404 → not found', () => {
    render('9');
    httpMock
      .expectOne(`${BASE}/repositories/9`)
      .flush(
        { status: 404, error: 'Repository 9 not found', error_reason: 'not_found' },
        { status: 404, statusText: 'x' },
      );
    fixture.detectChanges();
    expect(el.textContent).toContain('Repository not found');
    expect(notifications.error.calls.count()).toBe(0);
  });

  it('id change cancels the previous load', () => {
    render('1');
    const first = httpMock.expectOne(`${BASE}/repositories/1`);
    render('2');
    expect(first.cancelled).toBeTrue();
    respond(2);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('repo-2');
  });

  it('shows No GitHub remote in the header when the repository has none', () => {
    render('3');
    respond(3, repo(3, { githubOwner: null, githubRepo: null }));
    expect(el.textContent).toContain('No GitHub remote');
  });

  it('GitHub link only for safe owner/repo', () => {
    render('3');
    respond(3);
    const link = el.querySelector<HTMLAnchorElement>('a.dd-pill');
    expect(link?.href).toBe('https://github.com/acme/repo-3');
    expect(link?.rel).toBe('noopener noreferrer');

    render('4');
    respond(4, repo(4, { githubOwner: 'acme', githubRepo: 'evil"><script>' }));
    expect(el.querySelector('a.dd-pill')).toBeNull();
    expect(el.textContent).toContain('No GitHub remote');
  });

  it('remove confirm navigates to list', () => {
    render('3');
    respond(3);
    confirm.confirm.and.returnValue(of(true));
    button('Remove').click();
    const req = httpMock.expectOne(`${BASE}/repositories/3`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ status: 200, data: { id: 3 } });
    expect(confirm.confirm.calls.mostRecent().args[0].confirmColor).toBe('warn');
    // A re-registered repository starts with an empty library (16 §6.3, §15.4).
    expect(confirm.confirm.calls.mostRecent().args[0].message).toBe(
      'PRVision will forget "repo-3". Your local clone is not touched. ' +
        'Export the harness library first if you want to keep it.',
    );
    expect(notifications.success.calls.allArgs()).toEqual([['Repository removed']]);
    expect(navigate.calls.mostRecent().args).toEqual([['/repositories']]);
  });

  it('remove 409 conflict toasts once and stays', () => {
    render('3');
    respond(3);
    confirm.confirm.and.returnValue(of(true));
    button('Remove').click();
    httpMock
      .expectOne({ method: 'DELETE', url: `${BASE}/repositories/3` })
      .flush(
        { status: 409, error: 'This repository has visualizations queued or in progress.', error_reason: 'conflict' },
        { status: 409, statusText: 'Conflict' },
      );
    fixture.detectChanges();
    expect(notifications.error.calls.allArgs()).toEqual([
      ['This repository has visualizations queued or in progress.'],
    ]);
    expect(navigate.calls.count()).toBe(0);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('repo-3');
    expect(button('Remove').disabled).toBeFalse();
  });

  it('re-detect refreshes the repository', () => {
    render('3');
    respond(3);
    button('Re-detect').click();
    httpMock
      .expectOne({ method: 'POST', url: `${BASE}/repositories/3/redetect` })
      .flush({ status: 200, data: repo(3, { defaultBranch: 'develop' }) });
    fixture.detectChanges();
    expect(el.textContent).toContain('default: develop');
    expect(notifications.success.calls.allArgs()).toEqual([['Detection refreshed']]);
  });

  it('places the settings card under detection and the harness library card above recent visualizations (16 §15.3)', fakeAsync(() => {
    render('3');
    respond(3);
    tick(0);
    httpMock
      .expectOne(`${BASE}/repositories/3/library`)
      .flush({ status: 200, data: librarySummaryView({ repositoryId: 3 }) });
    fixture.detectChanges();
    const settings = el.querySelector('app-repository-settings-card');
    const library = el.querySelector('app-harness-library-card');
    const recent = el.querySelector('app-recent-visualizations');
    expect(settings?.previousElementSibling?.tagName.toLowerCase()).toBe('app-detection-card');
    expect(library?.nextElementSibling).toBe(recent);
    expect(library?.textContent).toContain('40 saved · 37 ready · 3 need updating');
    fixture.destroy();
    httpMock.match(() => true);
    discardPeriodicTasks();
  }));

  it('a saved state allowance updates the page and reloads the library summary', fakeAsync(() => {
    render('3');
    respond(3);
    tick(0);
    httpMock.expectOne(`${BASE}/repositories/3/library`).flush({ status: 200, data: librarySummaryView() });
    fixture.detectChanges();
    const select = el.querySelector<HTMLElement>('[data-testid="settings-state-allowance"]');
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
    Object.defineProperty(down, 'keyCode', { get: () => 40 });
    select?.dispatchEvent(down);
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="settings-save"]')?.click();
    const patch = httpMock.expectOne({ method: 'PATCH', url: `${BASE}/repositories/3` });
    expect(patch.request.body).toEqual({ stateAllowance: 4 });
    patch.flush({ status: 200, data: repo(3, { stateAllowance: 4 }) });
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(`${BASE}/repositories/3/library`)
      .flush({ status: 200, data: librarySummaryView({ stateAllowance: 4 }) });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="settings-saved"]')?.textContent?.trim()).toBe(
      'New harnesses use 4 states from now on.',
    );
    fixture.destroy();
    httpMock.match(() => true);
    discardPeriodicTasks();
  }));
});
