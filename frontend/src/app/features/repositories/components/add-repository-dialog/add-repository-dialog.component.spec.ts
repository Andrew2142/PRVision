import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { environment } from '../../../../../environments/environment';
import { errorInterceptor } from '../../../../core/interceptors/error.interceptor';
import { type AppCandidateView, type RepositoryView } from '../../../../core/models/repository.model';
import { GENERIC_POPUP_DIALOG_CONFIG } from '../../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { AddRepositoryDialogComponent, type AddRepositoryDialogResult } from './add-repository-dialog.component';

const URL = `${environment.apiBaseUrl}/repositories`;
const DETECT_URL = `${URL}/detect-apps`;
const ROOT = '/home/dev/projects/my-shop';

const REPO: RepositoryView = {
  id: 7,
  name: 'my-shop',
  localPath: '/home/dev/projects/my-shop',
  githubOwner: 'acme',
  githubRepo: 'my-shop',
  defaultBranch: 'main',
  framework: 'react_vite',
  appRoot: '.',
  angularProject: null,
  angularBuildConfiguration: null,
  packageManager: 'pnpm',
  viteConfigPath: 'vite.config.ts',
  tsconfigPath: null,
  entryFilePath: 'src/main.tsx',
  globalStylePaths: ['/src/index.css'],
  lastDetectedAt: '2026-10-03T10:00:00Z',
  createdAt: '2026-10-03T10:00:00Z',
};

const ONE_APP: AppCandidateView = {
  appRoot: '.',
  framework: 'react_vite',
  angularProject: null,
  suggestedName: 'my-shop',
  supported: true,
  reason: null,
  repositoryId: null,
};

const ANGULAR_REPO: RepositoryView = {
  ...REPO,
  id: 9,
  name: 'Acme · tenant-frontend',
  localPath: '/home/dev/acme-platform',
  framework: 'angular',
  appRoot: 'src/tenant-frontend',
  angularProject: 'tenant-frontend',
  angularBuildConfiguration: 'development',
  viteConfigPath: null,
  tsconfigPath: 'src/tenant-frontend/tsconfig.app.json',
  entryFilePath: 'src/tenant-frontend/src/main.ts',
};

const ACME_APPS: AppCandidateView[] = [
  {
    appRoot: 'src/tenant-frontend',
    framework: 'angular',
    angularProject: 'tenant-frontend',
    suggestedName: 'Acme · tenant-frontend',
    supported: true,
    reason: null,
    repositoryId: null,
  },
  {
    appRoot: 'src/core-frontend',
    framework: 'angular',
    angularProject: 'core-frontend',
    suggestedName: 'Acme · core-frontend',
    supported: true,
    reason: null,
    repositoryId: 4,
  },
  {
    appRoot: 'src/public-sites/estates/resident-app',
    framework: 'react_vite',
    angularProject: null,
    suggestedName: 'estates-resident-app',
    supported: false,
    reason: 'React apps in sub-folders are not supported yet.',
    repositoryId: null,
  },
];

describe('AddRepositoryDialogComponent', () => {
  let appRef: ApplicationRef;
  let dialog: MatDialog;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let closedWith: AddRepositoryDialogResult | undefined | null;

  beforeEach(() => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['error', 'success', 'info']);
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
      ],
    });
    appRef = TestBed.inject(ApplicationRef);
    dialog = TestBed.inject(MatDialog);
    httpMock = TestBed.inject(HttpTestingController);
    closedWith = null;
  });

  afterEach(() => {
    dialog.closeAll();
    httpMock.verify();
    document.body.style.overflow = '';
  });

  function settle(): void {
    appRef.tick();
    tick(10);
    appRef.tick();
    tick(0);
    appRef.tick();
  }

  function open(): void {
    dialog
      .open<AddRepositoryDialogComponent, undefined, AddRepositoryDialogResult>(
        AddRepositoryDialogComponent,
        GENERIC_POPUP_DIALOG_CONFIG,
      )
      .afterClosed()
      .subscribe((result) => (closedWith = result));
    settle();
  }

  function host(): HTMLElement {
    const el = document.querySelector<HTMLElement>('app-add-repository-dialog');
    if (!el) throw new Error('dialog not open');
    return el;
  }

  function inputs(): HTMLInputElement[] {
    return Array.from(host().querySelectorAll<HTMLInputElement>('input'));
  }

  function type(index: number, value: string): void {
    const input = inputs()[index];
    if (!input) throw new Error(`no input ${String(index)}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    appRef.tick();
  }

  function button(text: string): HTMLButtonElement {
    const found = Array.from(host().querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button "${text}"`);
    return found;
  }

  function primary(): HTMLButtonElement {
    const footer = Array.from(host().querySelectorAll<HTMLButtonElement>('button[mat-flat-button]'));
    const last = footer.at(-1);
    if (!last) throw new Error('no primary button');
    return last;
  }

  function text(): string {
    return host().textContent ?? '';
  }

  function submitPath(path: string, name = ''): void {
    type(0, path);
    if (name) type(1, name);
    primary().click();
    settle();
  }

  function reject(status: number, reason: string, error: string | string[], url = DETECT_URL): void {
    httpMock.expectOne(url).flush({ status, error, error_reason: reason }, { status, statusText: 'Error' });
    settle();
  }

  /** Answers the pending detect-apps request. */
  function discover(apps: AppCandidateView[], hint: string | null = null, rootPath = ROOT): void {
    httpMock.expectOne(DETECT_URL).flush({ status: 200, data: { rootPath, hint, apps } });
    settle();
  }

  /** Path step with one new supported app: discovery, then the one-click create answered with `repo`. */
  function addSingleApp(path: string, repo: RepositoryView = REPO): void {
    submitPath(path);
    discover([ONE_APP]);
    httpMock.expectOne(URL).flush({ status: 201, data: repo });
    settle();
  }

  function appRow(appRoot: string): HTMLElement {
    const row = host().querySelector<HTMLElement>(`[data-app^="${appRoot}|"]`);
    if (!row) throw new Error(`no app row ${appRoot}`);
    return row;
  }

  it('opened via MatDialog: focus starts in the path field and Tab stays inside the dialog', fakeAsync(() => {
    open();
    const panel = host().querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(inputs()[0] ?? null);
    const anchors = Array.from(host().querySelectorAll<HTMLElement>('.cdk-focus-trap-anchor'));
    expect(anchors.length).toBe(2);
    anchors.at(-1)?.focus();
    expect(panel?.contains(document.activeElement)).toBeTrue();
    anchors.at(0)?.focus();
    expect(panel?.contains(document.activeElement)).toBeTrue();
    flush();
  }));

  it('path required and absolute', fakeAsync(() => {
    open();
    primary().click();
    settle();
    expect(text()).toContain('Enter the folder path.');
    type(0, 'relative/path');
    expect(text()).toContain('Use an absolute path starting with / or ~/.');
    httpMock.expectNone(URL);
    httpMock.expectNone(DETECT_URL);
    flush();
  }));

  it('discovers apps for the trimmed path, then creates the single app in one click with the optional name', fakeAsync(() => {
    open();
    submitPath('~/dev/my-shop/  ');
    const detect = httpMock.expectOne(DETECT_URL);
    expect(detect.request.method).toBe('POST');
    expect(detect.request.body).toEqual({ localPath: '~/dev/my-shop/' });
    detect.flush({ status: 200, data: { rootPath: ROOT, hint: null, apps: [ONE_APP] } });
    settle();
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ localPath: ROOT, name: undefined, appRoot: '.', angularProject: undefined });
    req.flush({ status: 201, data: REPO });
    settle();
    expect(text()).toContain('Repository added');
    button('Add another').click();
    settle();
    submitPath('/home/dev/projects/other', '  Other  ');
    discover([{ ...ONE_APP, suggestedName: 'other' }], null, '/home/dev/projects/other');
    expect(httpMock.expectOne(URL).request.body).toEqual({
      localPath: '/home/dev/projects/other',
      name: 'Other',
      appRoot: '.',
      angularProject: undefined,
    });
    flush();
  }));

  it('primary shows loading while submitting', fakeAsync(() => {
    open();
    submitPath('/home/dev/projects/my-shop');
    expect(primary().disabled).toBeTrue();
    expect(primary().querySelector('svg.animate-spin')).not.toBeNull();
    discover([ONE_APP]);
    expect(primary().disabled).toBeTrue();
    httpMock.expectOne(URL).flush({ status: 201, data: REPO });
    settle();
    expect(primary().disabled).toBeFalse();
    flush();
  }));

  it('Escape and backdrop ignored while submitting', fakeAsync(() => {
    open();
    submitPath('/home/dev/projects/my-shop');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    settle();
    host().querySelector<HTMLElement>('div[aria-hidden="true"]')?.click();
    settle();
    expect(dialog.openDialogs.length).toBe(1);
    expect(closedWith).toBeNull();
    discover([ONE_APP]);
    httpMock.expectOne(URL).flush({ status: 201, data: REPO });
    settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    settle();
    flush();
    expect(closedWith).toEqual({ created: [REPO], openId: null });
  }));

  const TIP_CASES: [string, string, string][] = [
    [
      'not_git_repo',
      'Not a git repository',
      'Tip: run `git rev-parse --show-toplevel` inside the project to find the root.',
    ],
    [
      'unsupported_framework',
      'Unsupported project',
      'Supported: Vite + React at the repository root, and Angular 17+ apps built with the application builder.',
    ],
    [
      'missing_node_modules',
      'Dependencies not installed',
      'PRVision links your existing node_modules into its worktrees, so they must be installed first.',
    ],
  ];
  for (const [reason, title, tip] of TIP_CASES) {
    it(`${reason} renders title, message and tip with no toast`, fakeAsync(() => {
      open();
      submitPath('/home/dev/projects/thing');
      reject(400, reason, 'server text');
      expect(text()).toContain(title);
      expect(host().querySelector('[data-testid="rejection-tip"]')?.textContent?.trim()).toBe(tip);
      expect(notifications.error.calls.count()).toBe(0);
      expect(inputs()[0]?.value).toBe('/home/dev/projects/thing');
      flush();
    }));
  }

  it('validation_failed renders details', fakeAsync(() => {
    open();
    submitPath('/x');
    reject(400, 'validation_failed', ['localPath must be an absolute folder path', 'name is too long']);
    expect(text()).toContain('Invalid input');
    expect(text()).toContain('localPath must be an absolute folder path');
    expect(Array.from(host().querySelectorAll('li')).map((li) => li.textContent?.trim())).toEqual(['name is too long']);
    expect(notifications.error.calls.count()).toBe(0);
    flush();
  }));

  it('409 renders the server message', fakeAsync(() => {
    open();
    submitPath('/home/dev/projects/my-shop');
    discover([ONE_APP]);
    reject(409, 'conflict', 'This folder is already registered as "my-shop" (id 3)', URL);
    expect(text()).toContain('This folder is already registered as "my-shop" (id 3)');
    expect(notifications.error.calls.count()).toBe(0);
    flush();
  }));

  it('success switches to detected view with all fields', fakeAsync(() => {
    open();
    addSingleApp('/home/dev/projects/my-shop');
    expect(text()).toContain('Repository added');
    const labels = Array.from(host().querySelectorAll('dt')).map((dt) => dt.textContent?.trim());
    expect(labels).toEqual([
      'Name',
      'Path',
      'Framework',
      'Package manager',
      'Default branch',
      'GitHub',
      'Vite config',
      'tsconfig',
      'Entry file',
      'Global styles',
    ]);
    expect(text()).toContain('React + Vite');
    expect(text()).toContain('acme/my-shop');
    expect(text()).toContain('Not found');
    expect(host().querySelector('app-inline-alert')).toBeNull();
    flush();
  }));

  it('no remote shows info alert', fakeAsync(() => {
    open();
    addSingleApp('/home/dev/projects/my-shop', { ...REPO, githubOwner: null, githubRepo: null });
    expect(text()).toContain('Pull requests need a GitHub remote. Local branches and the working tree still work.');
    flush();
  }));

  it('Open repository closes with openId', fakeAsync(() => {
    open();
    addSingleApp('/home/dev/projects/my-shop');
    button('Open repository').click();
    settle();
    flush();
    expect(closedWith).toEqual({ created: [REPO], openId: 7 });
  }));

  it('Add another resets and keeps created list', fakeAsync(() => {
    open();
    addSingleApp('/home/dev/projects/my-shop');
    button('Add another').click();
    settle();
    expect(text()).toContain('Add repository');
    expect(inputs()[0]?.value).toBe('');
    button('Cancel').click();
    settle();
    flush();
    expect(closedWith).toEqual({ created: [REPO], openId: null });
  }));

  it('Cancel closes with created []', fakeAsync(() => {
    open();
    button('Cancel').click();
    settle();
    flush();
    expect(closedWith).toEqual({ created: [], openId: null });
  }));

  it('several apps show the picker: hint preselected, framework chips, app roots and projects', fakeAsync(() => {
    open();
    submitPath('/home/dev/acme-platform/src/tenant-frontend');
    discover(ACME_APPS, 'src/tenant-frontend', '/home/dev/acme-platform');
    httpMock.expectNone(URL);
    expect(text()).toContain('Choose an app');
    expect(host().querySelector('[data-testid="app-step"]')).not.toBeNull();
    const chips = Array.from(host().querySelectorAll('[data-testid="framework-chip"]')).map((c) =>
      c.textContent?.trim(),
    );
    expect(chips).toEqual(['Angular', 'Angular', 'React + Vite']);
    expect(text()).toContain('src/core-frontend');
    expect(text()).toContain('tenant-frontend');
    const tenant = appRow('src/tenant-frontend').querySelector<HTMLInputElement>('input[type="radio"]');
    expect(tenant?.checked).toBeTrue();
    expect(inputs().at(-1)?.value).toBe('Acme · tenant-frontend');
    expect(primary().disabled).toBeFalse();
    primary().click();
    settle();
    const req = httpMock.expectOne(URL);
    expect(req.request.body).toEqual({
      localPath: '/home/dev/acme-platform',
      name: 'Acme · tenant-frontend',
      appRoot: 'src/tenant-frontend',
      angularProject: 'tenant-frontend',
    });
    req.flush({ status: 201, data: ANGULAR_REPO });
    settle();
    expect(text()).toContain('Repository added');
    const labels = Array.from(host().querySelectorAll('dt')).map((dt) => dt.textContent?.trim());
    expect(labels).toContain('App root');
    expect(labels).toContain('Angular project');
    expect(labels).toContain('Build configuration');
    expect(labels).not.toContain('Vite config');
    flush();
  }));

  it('unsupported apps are disabled and show their reason', fakeAsync(() => {
    open();
    submitPath('/home/dev/acme-platform');
    discover(ACME_APPS, null, '/home/dev/acme-platform');
    const resident = appRow('src/public-sites/estates/resident-app');
    expect(resident.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBeTrue();
    expect(resident.querySelector('[data-testid="unsupported-reason"]')?.textContent?.trim()).toBe(
      'React apps in sub-folders are not supported yet.',
    );
    flush();
  }));

  it('already registered apps are disabled and "Already added" opens the repository', fakeAsync(() => {
    open();
    submitPath('/home/dev/acme-platform');
    discover(ACME_APPS, null, '/home/dev/acme-platform');
    const core = appRow('src/core-frontend');
    expect(core.querySelector<HTMLInputElement>('input[type="radio"]')?.disabled).toBeTrue();
    core.querySelector<HTMLButtonElement>('[data-testid="already-added"]')?.click();
    settle();
    flush();
    expect(closedWith).toEqual({ created: [], openId: 4 });
  }));

  it('a single app that is already registered shows the picker instead of creating', fakeAsync(() => {
    open();
    submitPath('/home/dev/projects/my-shop');
    discover([{ ...ONE_APP, repositoryId: 3 }]);
    httpMock.expectNone(URL);
    expect(host().querySelector('[data-testid="already-added"]')).not.toBeNull();
    expect(primary().disabled).toBeTrue();
    flush();
  }));

  it('Back returns to the path step with the path kept', fakeAsync(() => {
    open();
    submitPath('/home/dev/acme-platform');
    discover(ACME_APPS, null, '/home/dev/acme-platform');
    button('Back').click();
    settle();
    expect(text()).toContain('Add repository');
    expect(inputs()[0]?.value).toBe('/home/dev/acme-platform');
    flush();
  }));

  it('a create error on the app step is shown inline and keeps the picker', fakeAsync(() => {
    open();
    submitPath('/home/dev/acme-platform');
    discover(ACME_APPS, 'src/tenant-frontend', '/home/dev/acme-platform');
    primary().click();
    settle();
    reject(400, 'missing_node_modules', 'node_modules not found for src/tenant-frontend.', URL);
    expect(text()).toContain('Choose an app');
    expect(text()).toContain('Dependencies not installed');
    expect(notifications.error.calls.count()).toBe(0);
    flush();
  }));
});
