import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { environment } from '../../../../../environments/environment';
import { errorInterceptor } from '../../../../core/interceptors/error.interceptor';
import {
  type AppCandidateView,
  type RepositoryCreateResponse,
  type RepositoryView,
} from '../../../../core/models/repository.model';
import { GENERIC_POPUP_DIALOG_CONFIG } from '../../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { estimateView } from '../../testing/library-fixtures';
import { AddRepositoryDialogComponent, type AddRepositoryDialogResult } from './add-repository-dialog.component';

const URL = `${environment.apiBaseUrl}/repositories`;
const DETECT_URL = `${URL}/detect-apps`;
const ESTIMATE_URL = `${URL}/library-estimate`;
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
  renderViewport: 'desktop',
  libraryBuildMode: 'grow',
  stateAllowance: 3,
  packageManager: 'pnpm',
  viteConfigPath: 'vite.config.ts',
  tsconfigPath: null,
  entryFilePath: 'src/main.tsx',
  globalStylePaths: ['/src/index.css'],
  lastDetectedAt: '2026-10-03T10:00:00Z',
  createdAt: '2026-10-03T10:00:00Z',
};

/** REPO as POST /api/repositories answers it for a grow repository (16 §14.2). */
const CREATED: RepositoryCreateResponse = { ...REPO, scanJobId: null, scanStartError: null };

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
        provideRouter([]),
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

  /** Answers the pending library estimate request. */
  function answerEstimate(estimate = estimateView()): void {
    httpMock.expectOne(ESTIMATE_URL).flush({ status: 200, data: estimate });
    settle();
  }

  /** Path step with one new supported app: discovery, the library step (grow), then Add answered with `repo`. */
  function addSingleApp(path: string, repo: RepositoryView = REPO): void {
    submitPath(path);
    discover([ONE_APP]);
    answerEstimate();
    primary().click();
    settle();
    httpMock.expectOne(URL).flush({ status: 201, data: { ...repo, scanJobId: null, scanStartError: null } });
    settle();
  }

  /**
   * Selects a value of the closed mat-select with the arrow keys (as a keyboard user does; opening the overlay inside
   * a MatDialog under fakeAsync re-enters ApplicationRef.tick).
   */
  function choose(id: string, optionText: string): void {
    const select = testId(id);
    if (!select) throw new Error(`no select ${id}`);
    const target = Number(optionText);
    for (let guard = 0; guard < 10; guard++) {
      const current = Number(select.textContent?.trim());
      if (current === target) return;
      const event = new KeyboardEvent('keydown', { key: current < target ? 'ArrowDown' : 'ArrowUp', bubbles: true });
      Object.defineProperty(event, 'keyCode', { get: () => (current < target ? 40 : 38) });
      select.dispatchEvent(event);
      appRef.tick();
    }
    throw new Error(`could not select ${optionText}`);
  }

  /** Visible text without Material icon ligatures. */
  function plainText(node: Element | null): string {
    if (!node) return '';
    const copy = node.cloneNode(true) as Element;
    for (const icon of Array.from(copy.querySelectorAll('mat-icon'))) icon.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function pickScan(): void {
    host().querySelector<HTMLInputElement>('[data-mode="scan"] input[type="radio"]')?.click();
    settle();
  }

  function testId(id: string): HTMLElement | null {
    return host().querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  function capInput(): HTMLInputElement {
    const input = host().querySelector<HTMLInputElement>('input[data-testid="spend-cap"]');
    if (!input) throw new Error('no spend cap input');
    return input;
  }

  function popupTitle(): string {
    return host().querySelector('h3')?.textContent?.trim() ?? '';
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

  it('discovers apps for the trimmed path, then the library step adds the single app with the optional name', fakeAsync(() => {
    open();
    submitPath('~/dev/my-shop/  ');
    const detect = httpMock.expectOne(DETECT_URL);
    expect(detect.request.method).toBe('POST');
    expect(detect.request.body).toEqual({ localPath: '~/dev/my-shop/' });
    detect.flush({ status: 200, data: { rootPath: ROOT, hint: null, apps: [ONE_APP] } });
    settle();
    httpMock.expectNone(URL);
    expect(popupTitle()).toBe('Harness library');
    expect(testId('library-step')).not.toBeNull();
    answerEstimate();
    expect(primary().textContent?.trim()).toBe('Add');
    primary().click();
    settle();
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      localPath: ROOT,
      name: undefined,
      appRoot: '.',
      angularProject: undefined,
      renderViewport: undefined,
      libraryBuildMode: 'grow',
      stateAllowance: 3,
    });
    req.flush({ status: 201, data: { ...REPO, scanJobId: null, scanStartError: null } });
    settle();
    expect(text()).toContain('Repository added');
    button('Add another').click();
    settle();
    submitPath('/home/dev/projects/other', '  Other  ');
    discover([{ ...ONE_APP, suggestedName: 'other' }], null, '/home/dev/projects/other');
    answerEstimate();
    primary().click();
    settle();
    expect(httpMock.expectOne(URL).request.body).toEqual({
      localPath: '/home/dev/projects/other',
      name: 'Other',
      appRoot: '.',
      angularProject: undefined,
      renderViewport: undefined,
      libraryBuildMode: 'grow',
      stateAllowance: 3,
    });
    flush();
  }));

  it('primary shows loading while submitting', fakeAsync(() => {
    open();
    submitPath('/home/dev/projects/my-shop');
    expect(primary().disabled).toBeTrue();
    expect(primary().querySelector('svg.animate-spin')).not.toBeNull();
    discover([ONE_APP]);
    expect(primary().disabled).toBeFalse();
    answerEstimate();
    primary().click();
    settle();
    expect(primary().disabled).toBeTrue();
    expect(primary().querySelector('svg.animate-spin')).not.toBeNull();
    httpMock.expectOne(URL).flush({ status: 201, data: { ...REPO, scanJobId: null, scanStartError: null } });
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
    answerEstimate();
    primary().click();
    settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    settle();
    expect(dialog.openDialogs.length).toBe(1);
    httpMock.expectOne(URL).flush({ status: 201, data: { ...REPO, scanJobId: null, scanStartError: null } });
    settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    settle();
    flush();
    expect(closedWith).toEqual({ created: [CREATED], openId: null });
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
    answerEstimate();
    primary().click();
    settle();
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
    expect(closedWith).toEqual({ created: [CREATED], openId: 7 });
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
    expect(closedWith).toEqual({ created: [CREATED], openId: null });
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
    expect(primary().textContent?.trim()).toBe('Continue');
    primary().click();
    settle();
    httpMock.expectNone(URL);
    expect(popupTitle()).toBe('Harness library');
    const estimate = httpMock.expectOne(ESTIMATE_URL);
    expect(estimate.request.body).toEqual({
      localPath: '/home/dev/acme-platform',
      appRoot: 'src/tenant-frontend',
      angularProject: 'tenant-frontend',
      stateAllowance: 3,
    });
    estimate.flush({ status: 200, data: estimateView({ componentCount: 465, toWriteCount: 465 }) });
    settle();
    primary().click();
    settle();
    const req = httpMock.expectOne(URL);
    expect(req.request.body).toEqual({
      localPath: '/home/dev/acme-platform',
      name: 'Acme · tenant-frontend',
      appRoot: 'src/tenant-frontend',
      angularProject: 'tenant-frontend',
      renderViewport: undefined,
      libraryBuildMode: 'grow',
      stateAllowance: 3,
    });
    req.flush({ status: 201, data: { ...ANGULAR_REPO, scanJobId: null, scanStartError: null } });
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

  it('a create error after the app picker is shown inline on the library step; Back returns to the picker', fakeAsync(() => {
    open();
    submitPath('/home/dev/acme-platform');
    discover(ACME_APPS, 'src/tenant-frontend', '/home/dev/acme-platform');
    primary().click();
    settle();
    answerEstimate();
    primary().click();
    settle();
    reject(400, 'missing_node_modules', 'node_modules not found for src/tenant-frontend.', URL);
    expect(popupTitle()).toBe('Harness library');
    expect(text()).toContain('Dependencies not installed');
    expect(notifications.error.calls.count()).toBe(0);
    button('Back').click();
    settle();
    expect(text()).toContain('Choose an app');
    expect(text()).not.toContain('Dependencies not installed');
    flush();
  }));

  describe('library step (16 §15.2)', () => {
    /** Single app → library step with the estimate answered. */
    function toLibraryStep(estimate = estimateView()): void {
      open();
      submitPath('/home/dev/projects/my-shop');
      discover([ONE_APP]);
      answerEstimate(estimate);
    }

    it('opens with Grow as you go, 3 states, the estimate requested for the discovered root', fakeAsync(() => {
      open();
      submitPath('/home/dev/projects/my-shop/src');
      discover([ONE_APP]);
      const req = httpMock.expectOne(ESTIMATE_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ localPath: ROOT, appRoot: '.', angularProject: undefined, stateAllowance: 3 });
      expect(testId('estimate-loading')?.textContent?.trim()).toBe('Counting components…');
      req.flush({ status: 200, data: estimateView() });
      settle();
      expect(host().querySelector('[data-mode="grow"] input[type="radio"]')).toEqual(
        jasmine.objectContaining({ checked: true }),
      );
      expect(testId('state-allowance')?.textContent?.trim()).toBe('3');
      expect(text()).toContain('Grow as you go');
      expect(text()).toContain(
        'No upfront cost. Every run saves the harnesses it writes, and the library fills in over time.',
      );
      expect(text()).toContain('Scan the whole app now');
      expect(text()).toContain(
        'Writes a harness for every component now, so every later run can re-check the whole app without AI cost.',
      );
      expect(text()).toContain(
        'A maximum, not a target. PRVision only adds states that look different; simple components get just Default.',
      );
      expect(testId('estimate-text')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        '201 components. Writing all of them now would cost about $38; growing as you go costs nothing upfront.',
      );
      expect(testId('spend-cap')).toBeNull();
      flush();
    }));

    it('scan mode: "Add and scan", estimate with range, model, states and minutes, and the spending cap', fakeAsync(() => {
      toLibraryStep();
      pickScan();
      expect(primary().textContent?.trim()).toBe('Add and scan');
      expect(testId('estimate-text')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        '201 components · about $38 (between $23 and $61) with claude-opus-5-5 at 3 states · about 84 minutes',
      );
      expect(capInput().value).toBe('62'); // max(1, ceil(61.12))
      expect(text()).toContain(
        'The scan pauses when it reaches the cap. You can continue it later from the repository page.',
      );
      expect(testId('no-cap')).not.toBeNull();
      flush();
    }));

    it('approximate price and truncated count notes', fakeAsync(() => {
      toLibraryStep(
        estimateView({ priceExact: false, model: 'claude-next', priceModel: 'claude-fable-5-1', truncated: true }),
      );
      expect(testId('estimate-price-note')?.textContent?.trim()).toBe(
        "No published price for claude-next; using claude-fable-5-1's price.",
      );
      expect(plainText(testId('estimate-truncated'))).toBe('Only the first 2 000 components are counted.');
      flush();
    }));

    it('a changed allowance asks again after 300 ms and drops the stale answer', fakeAsync(() => {
      open();
      submitPath('/home/dev/projects/my-shop');
      discover([ONE_APP]);
      const first = httpMock.expectOne(ESTIMATE_URL);
      choose('state-allowance', '1');
      tick(250);
      httpMock.expectNone(ESTIMATE_URL);
      expect(first.cancelled).toBeTrue(); // switchMap dropped the answer for 3 states
      tick(50);
      const second = httpMock.expectOne(ESTIMATE_URL);
      expect((second.request.body as { stateAllowance: number }).stateAllowance).toBe(1);
      second.flush({ status: 200, data: estimateView({ stateAllowance: 1, estimatedUsd: 30.1 }) });
      settle();
      pickScan();
      expect(testId('estimate-text')?.textContent).toContain('$30');
      expect(testId('estimate-text')?.textContent).toContain('at 1 state ·');
      flush();
    }));

    it('several allowance changes within 300 ms send one request', fakeAsync(() => {
      toLibraryStep();
      choose('state-allowance', '5');
      tick(100);
      choose('state-allowance', '2');
      tick(299);
      httpMock.expectNone(ESTIMATE_URL);
      tick(1);
      const req = httpMock.expectOne(ESTIMATE_URL);
      expect((req.request.body as { stateAllowance: number }).stateAllowance).toBe(2);
      req.flush({ status: 200, data: estimateView({ stateAllowance: 2 }) });
      settle();
      flush();
    }));

    it('an estimate error is a warning and adding still works', fakeAsync(() => {
      open();
      submitPath('/home/dev/projects/my-shop');
      discover([ONE_APP]);
      httpMock.expectOne(ESTIMATE_URL).flush(
        {
          status: 504,
          error: 'Counting components took too long; the estimate is unavailable.',
          error_reason: 'internal_error',
        },
        { status: 504, statusText: 'Gateway Timeout' },
      );
      settle();
      expect(plainText(testId('estimate-error'))).toBe(
        'Could not estimate: Counting components took too long; the estimate is unavailable.',
      );
      expect(notifications.error.calls.count()).toBe(0);
      expect(primary().disabled).toBeFalse();
      primary().click();
      settle();
      httpMock.expectOne(URL).flush({ status: 201, data: { ...REPO, scanJobId: null, scanStartError: null } });
      settle();
      expect(text()).toContain('Repository added');
      flush();
    }));

    it('scan with a cap sends libraryBuildMode, stateAllowance and scanSpendCapUsd', fakeAsync(() => {
      toLibraryStep();
      pickScan();
      choose('state-allowance', '4');
      tick(300);
      answerEstimate(estimateView({ stateAllowance: 4 }));
      capInput().value = '12.5';
      capInput().dispatchEvent(new Event('input'));
      settle();
      primary().click();
      settle();
      const req = httpMock.expectOne(URL);
      expect(req.request.body).toEqual({
        localPath: ROOT,
        name: undefined,
        appRoot: '.',
        angularProject: undefined,
        renderViewport: undefined,
        libraryBuildMode: 'scan',
        stateAllowance: 4,
        scanSpendCapUsd: 12.5,
      });
      req.flush({ status: 201, data: { ...REPO, libraryBuildMode: 'scan', scanJobId: 41, scanStartError: null } });
      settle();
      const started = testId('scan-started');
      expect(started?.textContent).toContain('Scan started');
      const link = started?.querySelector<HTMLAnchorElement>('a');
      expect(link?.textContent?.trim()).toBe('View progress');
      expect(link?.getAttribute('href')).toBe('/library-jobs/41');
      flush();
    }));

    it('scan with No cap sends scanSpendCapUsd null', fakeAsync(() => {
      toLibraryStep();
      pickScan();
      host().querySelector<HTMLInputElement>('[data-testid="no-cap"] input')?.click();
      settle();
      expect(capInput().disabled).toBeTrue();
      primary().click();
      settle();
      const req = httpMock.expectOne(URL);
      expect((req.request.body as Record<string, unknown>)['scanSpendCapUsd']).toBeNull();
      expect((req.request.body as Record<string, unknown>)['libraryBuildMode']).toBe('scan');
      req.flush({ status: 201, data: { ...REPO, scanJobId: 42, scanStartError: null } });
      settle();
      flush();
    }));

    it('grow never sends a spending cap', fakeAsync(() => {
      toLibraryStep();
      pickScan();
      host().querySelector<HTMLInputElement>('[data-mode="grow"] input[type="radio"]')?.click();
      settle();
      primary().click();
      settle();
      const req = httpMock.expectOne(URL);
      expect(Object.keys(req.request.body as object)).not.toContain('scanSpendCapUsd');
      req.flush({ status: 201, data: { ...REPO, scanJobId: null, scanStartError: null } });
      settle();
      expect(testId('scan-started')).toBeNull();
      flush();
    }));

    it('an empty or out-of-range cap blocks Add and scan', fakeAsync(() => {
      toLibraryStep();
      pickScan();
      capInput().value = '';
      capInput().dispatchEvent(new Event('input'));
      settle();
      primary().click();
      settle();
      httpMock.expectNone(URL);
      expect(testId('spend-cap-missing')?.textContent?.trim()).toBe('Enter a spending cap, or choose No cap.');
      capInput().value = '0.2';
      capInput().dispatchEvent(new Event('input'));
      settle();
      primary().click();
      settle();
      httpMock.expectNone(URL);
      expect(text()).toContain('Enter an amount between $0.50 and $10,000.');
      flush();
    }));

    it('the cap follows the estimate until the user edits it', fakeAsync(() => {
      toLibraryStep();
      pickScan();
      expect(capInput().value).toBe('62');
      choose('state-allowance', '1');
      tick(300);
      answerEstimate(estimateView({ highUsd: 0.4 }));
      expect(capInput().value).toBe('1');
      capInput().value = '7';
      capInput().dispatchEvent(new Event('input'));
      settle();
      choose('state-allowance', '5');
      tick(300);
      answerEstimate(estimateView({ highUsd: 99.1 }));
      expect(capInput().value).toBe('7');
      flush();
    }));

    it('scanStartError: the repository is added and the reason is shown', fakeAsync(() => {
      toLibraryStep();
      pickScan();
      primary().click();
      settle();
      httpMock.expectOne(URL).flush({
        status: 201,
        data: { ...REPO, scanJobId: null, scanStartError: 'Configure an AI provider in Settings first.' },
      });
      settle();
      expect(text()).toContain('Repository added');
      expect(testId('scan-start-error')?.textContent).toContain('Configure an AI provider in Settings first.');
      expect(testId('scan-started')).toBeNull();
      flush();
    }));

    it('Back from the single-app library step returns to the path step', fakeAsync(() => {
      toLibraryStep();
      button('Back').click();
      settle();
      expect(text()).toContain('Add repository');
      expect(inputs()[0]?.value).toBe('/home/dev/projects/my-shop');
      flush();
    }));
  });
});
