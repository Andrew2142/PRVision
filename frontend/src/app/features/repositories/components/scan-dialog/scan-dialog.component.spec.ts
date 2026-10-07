import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { environment } from '../../../../../environments/environment';
import { errorInterceptor } from '../../../../core/interceptors/error.interceptor';
import { type RepositoryView } from '../../../../core/models/repository.model';
import { GENERIC_POPUP_DIALOG_CONFIG } from '../../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { estimateView, libraryJobView, repositoryView } from '../../testing/library-fixtures';
import {
  ScanDialogComponent,
  type ScanDialogData,
  type ScanDialogLabel,
  type ScanDialogResult,
} from './scan-dialog.component';

const BASE = environment.apiBaseUrl;
const ESTIMATE_URL = `${BASE}/repositories/3/library/estimate`;
const SCANS_URL = `${BASE}/repositories/3/library/scans`;

describe('ScanDialogComponent', () => {
  let appRef: ApplicationRef;
  let dialog: MatDialog;
  let httpMock: HttpTestingController;
  let navigateByUrl: jasmine.Spy;
  let closedWith: ScanDialogResult | null;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        provideRouter([]),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        {
          provide: NotificationService,
          useValue: jasmine.createSpyObj<NotificationService>('NotificationService', ['error', 'success', 'info']),
        },
      ],
    });
    appRef = TestBed.inject(ApplicationRef);
    dialog = TestBed.inject(MatDialog);
    httpMock = TestBed.inject(HttpTestingController);
    navigateByUrl = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    closedWith = null;
  });

  afterEach(() => {
    dialog.closeAll();
    httpMock.verify({ ignoreCancelled: true });
    document.body.style.overflow = '';
  });

  function settle(): void {
    appRef.tick();
    tick(10);
    appRef.tick();
    tick(0);
    appRef.tick();
  }

  function open(kind: 'scan' | 'rescan', label: ScanDialogLabel, repository: RepositoryView = repositoryView()): void {
    dialog
      .open<ScanDialogComponent, ScanDialogData, ScanDialogResult>(ScanDialogComponent, {
        ...GENERIC_POPUP_DIALOG_CONFIG,
        data: { repository, kind, label },
      })
      .afterClosed()
      .subscribe((result) => (closedWith = result));
    settle();
  }

  function host(): HTMLElement {
    const el = document.querySelector<HTMLElement>('app-scan-dialog');
    if (!el) throw new Error('dialog not open');
    return el;
  }

  function testId(id: string): HTMLElement | null {
    return host().querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  function plainText(node: Element | null): string {
    if (!node) return '';
    const copy = node.cloneNode(true) as Element;
    for (const icon of Array.from(copy.querySelectorAll('mat-icon'))) icon.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function primary(): HTMLButtonElement {
    const last = Array.from(host().querySelectorAll<HTMLButtonElement>('button[mat-flat-button]')).at(-1);
    if (!last) throw new Error('no primary button');
    return last;
  }

  function answerEstimate(estimate = estimateView()): void {
    httpMock.expectOne((r) => r.url === ESTIMATE_URL).flush({ status: 200, data: estimate });
    settle();
  }

  /** Steps the closed allowance select with the arrow keys. */
  function stepAllowance(times: number): void {
    const select = testId('scan-state-allowance');
    if (!select) throw new Error('no allowance select');
    for (let i = 0; i < Math.abs(times); i++) {
      const down = times > 0;
      const event = new KeyboardEvent('keydown', { key: down ? 'ArrowDown' : 'ArrowUp', bubbles: true });
      Object.defineProperty(event, 'keyCode', { get: () => (down ? 40 : 38) });
      select.dispatchEvent(event);
      appRef.tick();
    }
  }

  it('Scan whole app: estimate of what is left to write and the default cap', fakeAsync(() => {
    open('scan', 'Scan whole app');
    expect(host().querySelector('h3')?.textContent?.trim()).toBe('Scan whole app');
    const req = httpMock.expectOne((r) => r.url === ESTIMATE_URL);
    expect(req.request.params.get('kind')).toBe('scan');
    expect(req.request.params.get('stateAllowance')).toBe('3');
    expect(testId('estimate-loading')?.textContent?.trim()).toBe('Counting components…');
    req.flush({
      status: 200,
      data: estimateView({ toWriteCount: 12, estimatedUsd: 2.28, lowUsd: 1.37, highUsd: 3.65, estimatedMinutes: 5 }),
    });
    settle();
    expect(testId('estimate-text')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '12 of 201 components to write · about $2.28 (between $1.37 and $3.65) with claude-opus-5-5 at 3 states · about 5 minutes',
    );
    expect(host().querySelector<HTMLInputElement>('input[data-testid="spend-cap"]')?.value).toBe('4');
    expect(testId('scan-state-allowance')).toBeNull();
    expect(primary().textContent?.trim()).toBe('Start');
    flush();
  }));

  it('Start sends the kind and cap and closes with the job', fakeAsync(() => {
    open('scan', 'Continue scan');
    answerEstimate();
    primary().click();
    settle();
    const req = httpMock.expectOne(SCANS_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ kind: 'scan', spendCapUsd: 62 });
    const job = libraryJobView({ id: 9, status: 'queued' });
    req.flush({ status: 202, data: job }, { status: 202, statusText: 'Accepted' });
    settle();
    flush();
    expect(closedWith).toEqual(job);
  }));

  it('No cap sends spendCapUsd null', fakeAsync(() => {
    open('scan', 'Scan whole app');
    answerEstimate();
    host().querySelector<HTMLInputElement>('[data-testid="no-cap"] input')?.click();
    settle();
    primary().click();
    settle();
    expect(httpMock.expectOne(SCANS_URL).request.body).toEqual({ kind: 'scan', spendCapUsd: null });
    flush();
  }));

  it('Rescan: the allowance select starts at the repository allowance; a change re-estimates and is sent', fakeAsync(() => {
    open('rescan', 'Rescan', repositoryView({ libraryBuildMode: 'scan', stateAllowance: 2 }));
    const first = httpMock.expectOne((r) => r.url === ESTIMATE_URL);
    expect(first.request.params.get('kind')).toBe('rescan');
    expect(first.request.params.get('stateAllowance')).toBe('2');
    first.flush({ status: 200, data: estimateView({ kind: 'rescan', stateAllowance: 2 }) });
    settle();
    expect(testId('scan-state-allowance')?.textContent?.trim()).toBe('2');
    stepAllowance(2);
    tick(299);
    httpMock.expectNone((r) => r.url === ESTIMATE_URL);
    tick(1);
    const second = httpMock.expectOne((r) => r.url === ESTIMATE_URL);
    expect(second.request.params.get('stateAllowance')).toBe('4');
    second.flush({ status: 200, data: estimateView({ kind: 'rescan', stateAllowance: 4 }) });
    settle();
    primary().click();
    settle();
    expect(httpMock.expectOne(SCANS_URL).request.body).toEqual({ kind: 'rescan', spendCapUsd: 62, stateAllowance: 4 });
    flush();
  }));

  it('an empty cap without No cap blocks Start', fakeAsync(() => {
    open('scan', 'Scan whole app');
    answerEstimate();
    const input = host().querySelector<HTMLInputElement>('input[data-testid="spend-cap"]');
    if (!input) throw new Error('no cap input');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    settle();
    primary().click();
    settle();
    httpMock.expectNone(SCANS_URL);
    expect(testId('spend-cap-missing')?.textContent?.trim()).toBe('Enter a spending cap, or choose No cap.');
    flush();
  }));

  it('a failed estimate is a warning; Start still works', fakeAsync(() => {
    open('scan', 'Scan whole app');
    httpMock
      .expectOne((r) => r.url === ESTIMATE_URL)
      .flush(
        { status: 400, error: 'No app found.', error_reason: 'unsupported_framework' },
        { status: 400, statusText: 'x' },
      );
    settle();
    expect(plainText(testId('estimate-error'))).toBe('Could not estimate: No app found.');
    const input = host().querySelector<HTMLInputElement>('input[data-testid="spend-cap"]');
    if (!input) throw new Error('no cap input');
    input.value = '5';
    input.dispatchEvent(new Event('input'));
    settle();
    primary().click();
    settle();
    expect(httpMock.expectOne(SCANS_URL).request.body).toEqual({ kind: 'scan', spendCapUsd: 5 });
    flush();
  }));

  it('a running scan (409) renders inline and the dialog stays', fakeAsync(() => {
    open('scan', 'Scan whole app');
    answerEstimate();
    primary().click();
    settle();
    httpMock
      .expectOne(SCANS_URL)
      .flush(
        { status: 409, error: 'A scan is already running for this repository.', error_reason: 'conflict' },
        { status: 409, statusText: 'Conflict' },
      );
    settle();
    expect(plainText(testId('scan-error'))).toContain('A scan is already running for this repository.');
    expect(testId('scan-error-action')).toBeNull();
    expect(closedWith).toBeNull();
    flush();
  }));

  it('ai_not_configured offers Open settings, which closes the dialog and goes to Settings', fakeAsync(() => {
    open('scan', 'Scan whole app');
    answerEstimate();
    primary().click();
    settle();
    httpMock
      .expectOne(SCANS_URL)
      .flush(
        { status: 400, error: 'Add an Anthropic API key in Settings.', error_reason: 'ai_not_configured' },
        { status: 400, statusText: 'Bad Request' },
      );
    settle();
    expect(plainText(testId('scan-error'))).toContain('AI provider not configured');
    const action = testId('scan-error-action');
    expect(action?.textContent?.trim()).toBe('Open settings');
    action?.click();
    settle();
    flush();
    expect(closedWith).toBeUndefined();
    expect(navigateByUrl.calls.allArgs()).toEqual([['/settings']]);
  }));

  it('Cancel closes without a job', fakeAsync(() => {
    open('scan', 'Scan whole app');
    answerEstimate();
    Array.from(host().querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.trim() === 'Cancel')
      ?.click();
    settle();
    flush();
    expect(closedWith).toBeUndefined();
  }));
});
