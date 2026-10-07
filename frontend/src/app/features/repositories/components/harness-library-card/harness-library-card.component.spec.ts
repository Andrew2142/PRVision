import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, type TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed, discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { MatDialog, type MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { LIBRARY_SUMMARY_POLL_MS } from '../../../../core/constants/polling.constants';
import { errorInterceptor } from '../../../../core/interceptors/error.interceptor';
import { type HarnessLibrarySummaryView } from '../../../../core/models/harness-library.model';
import { ConfirmDialogService, GENERIC_POPUP_DIALOG_CONFIG } from '../../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { libraryJobView, librarySummaryView, repositoryView } from '../../testing/library-fixtures';
import { ScanDialogComponent } from '../scan-dialog/scan-dialog.component';
import { HarnessLibraryCardComponent } from './harness-library-card.component';

const BASE = environment.apiBaseUrl;
const SUMMARY_URL = `${BASE}/repositories/3/library`;

describe('HarnessLibraryCardComponent', () => {
  let fixture: ComponentFixture<HarnessLibraryCardComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let confirm: jasmine.SpyObj<ConfirmDialogService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  let navigate: jasmine.Spy;

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']);
    confirm = jasmine.createSpyObj<ConfirmDialogService>('ConfirmDialogService', ['confirm']);
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    await TestBed.configureTestingModule({
      imports: [HarnessLibraryCardComponent],
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
    fixture = TestBed.createComponent(HarnessLibraryCardComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    httpMock.verify({ ignoreCancelled: true });
  });

  function summaryReqs(): TestRequest[] {
    return httpMock.match((r) => r.url === SUMMARY_URL);
  }
  /** Renders the card and answers the first summary request. */
  function load(summary: Partial<HarnessLibrarySummaryView> = {}, repo = repositoryView()): void {
    fixture.componentRef.setInput('repository', repo);
    fixture.detectChanges();
    tick(0);
    httpMock.expectOne(SUMMARY_URL).flush({ status: 200, data: librarySummaryView(summary) });
    fixture.detectChanges();
  }
  function done(): void {
    fixture.destroy();
    httpMock.match(() => true);
    discardPeriodicTasks();
  }
  function testId(id: string): HTMLElement | null {
    return el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }
  function actionIds(): string[] {
    return Array.from(testId('library-actions')?.querySelectorAll('button') ?? []).map(
      (b) => b.getAttribute('data-testid') ?? '',
    );
  }

  it('header, build mode chip and the counts line exactly as the summary gives them', fakeAsync(() => {
    load({ counts: { total: 40, ready: 37, needsUpdate: 3, withoutHarness: 0, otherAllowance: 0 } });
    expect(el.querySelector('h3')?.textContent?.trim()).toBe('Harness library');
    expect(testId('build-mode-chip')?.textContent?.trim()).toBe('Grow as you go');
    // Entries off the default branch are already left out by the API (16 E26); the card adds nothing.
    expect(testId('library-counts')?.textContent?.trim()).toBe('40 saved · 37 ready · 3 need updating');
    done();
  }));

  it('"could not be written" only when withoutHarness > 0', fakeAsync(() => {
    load({ counts: { total: 12, ready: 8, needsUpdate: 4, withoutHarness: 2, otherAllowance: 0 } });
    expect(testId('library-counts')?.textContent?.trim()).toBe(
      '12 saved · 8 ready · 4 need updating · 2 could not be written',
    );
    done();
  }));

  it('empty library text', fakeAsync(() => {
    load({ counts: { total: 0, ready: 0, needsUpdate: 0, withoutHarness: 0, otherAllowance: 0 } });
    expect(testId('library-counts')?.textContent?.trim()).toBe(
      'No saved harnesses yet. Runs add them as they go, or scan the whole app.',
    );
    done();
  }));

  it('whole-app chip and the Rescan hint with a primary Rescan', fakeAsync(() => {
    load({
      buildMode: 'scan',
      stateAllowance: 4,
      rescanSuggested: true,
      counts: { total: 201, ready: 190, needsUpdate: 11, withoutHarness: 0, otherAllowance: 150 },
    });
    expect(testId('build-mode-chip')?.textContent?.trim()).toBe('Whole app');
    expect(testId('rescan-hint')?.textContent?.trim()).toBe(
      '150 saved harnesses were written with a different number of states; Rescan to apply 4 states per component.',
    );
    expect(testId('rescan')?.hasAttribute('mat-flat-button')).toBeTrue();
    done();
  }));

  it('no hint and a stroked Rescan when no rescan is suggested', fakeAsync(() => {
    load({ buildMode: 'scan' });
    expect(testId('rescan-hint')).toBeNull();
    expect(testId('rescan')?.hasAttribute('mat-stroked-button')).toBeTrue();
    done();
  }));

  describe('button matrix (16 §15.3)', () => {
    const cases: [string, Partial<HarnessLibrarySummaryView>, string[]][] = [
      ['grow, nothing to continue', { buildMode: 'grow', canContinue: false }, ['scan-whole-app']],
      ['grow, last scan capped', { buildMode: 'grow', canContinue: true }, ['continue-scan']],
      ['scan, last scan completed', { buildMode: 'scan', canContinue: false }, ['scan-whole-app', 'rescan']],
      ['scan, last scan cancelled', { buildMode: 'scan', canContinue: true }, ['continue-scan', 'rescan']],
      ['scan running', { buildMode: 'scan', activeJob: libraryJobView() }, []],
    ];
    for (const [name, summary, expected] of cases) {
      it(
        name,
        fakeAsync(() => {
          load(summary);
          expect(actionIds()).toEqual(expected);
          done();
        }),
      );
    }
  });

  it('active job: progress text, bar, View progress link and Cancel', fakeAsync(() => {
    load({ activeJob: libraryJobView({ processedCount: 84, totalCount: 201, spentUsd: 12.4 }) });
    const active = testId('active-job');
    expect(testId('active-job-progress')?.textContent?.trim()).toBe('84 of 201 harnesses written, about $12 spent');
    expect(active?.querySelector('mat-progress-bar')?.getAttribute('aria-valuenow')).toBe('42');
    const link = Array.from(active?.querySelectorAll('a') ?? []).find((a) => a.textContent?.trim() === 'View progress');
    expect(link?.getAttribute('href')).toBe('/library-jobs/5');
    expect(testId('cancel-scan')).not.toBeNull();
    done();
  }));

  it('polls every 3 s while a scan is active and stops when it ends', fakeAsync(() => {
    load({ activeJob: libraryJobView() });
    tick(LIBRARY_SUMMARY_POLL_MS - 1);
    expect(summaryReqs().length).toBe(0);
    tick(1);
    httpMock.expectOne(SUMMARY_URL).flush({ status: 200, data: librarySummaryView({ activeJob: libraryJobView() }) });
    tick(LIBRARY_SUMMARY_POLL_MS);
    httpMock.expectOne(SUMMARY_URL).flush({ status: 200, data: librarySummaryView({ activeJob: null }) });
    fixture.detectChanges();
    expect(testId('active-job')).toBeNull();
    tick(LIBRARY_SUMMARY_POLL_MS * 3);
    expect(summaryReqs().length).toBe(0);
    done();
  }));

  it('no polling without an active job', fakeAsync(() => {
    load();
    tick(LIBRARY_SUMMARY_POLL_MS * 3);
    expect(summaryReqs().length).toBe(0);
    done();
  }));

  it('Cancel asks first, then cancels the job and refreshes', fakeAsync(() => {
    confirm.confirm.and.returnValue(of(true));
    load({ activeJob: libraryJobView() });
    testId('cancel-scan')?.click();
    expect(confirm.confirm.calls.mostRecent().args[0].confirmColor).toBe('warn');
    const req = httpMock.expectOne(`${BASE}/library-jobs/5/cancel`);
    expect(req.request.method).toBe('POST');
    req.flush({ status: 202, data: { id: 5, status: 'cancel_requested' } }, { status: 202, statusText: 'Accepted' });
    expect(notifications.info.calls.allArgs()).toEqual([
      ['Cancellation requested. The scan stops after the current batch.'],
    ]);
    tick(0);
    expect(summaryReqs().length).toBe(1);
    done();
  }));

  it('declining the cancel confirm sends nothing', fakeAsync(() => {
    confirm.confirm.and.returnValue(of(false));
    load({ activeJob: libraryJobView() });
    testId('cancel-scan')?.click();
    expect(confirm.confirm.calls.count()).toBe(1);
    httpMock.expectNone(`${BASE}/library-jobs/5/cancel`);
    done();
  }));

  it('Scan whole app opens the scan dialog and goes to the new job', fakeAsync(() => {
    const repo = repositoryView();
    dialog.open.and.returnValue({ afterClosed: () => of(libraryJobView({ id: 9 })) } as MatDialogRef<unknown>);
    load({}, repo);
    testId('scan-whole-app')?.click();
    expect(dialog.open.calls.allArgs()).toEqual([
      [
        ScanDialogComponent,
        { ...GENERIC_POPUP_DIALOG_CONFIG, data: { repository: repo, kind: 'scan', label: 'Scan whole app' } },
      ],
    ]);
    expect(navigate.calls.allArgs()).toEqual([[['/library-jobs', 9]]]);
    done();
  }));

  it('Continue scan and Rescan open the dialog with their kind and label; a dismissed dialog stays', fakeAsync(() => {
    dialog.open.and.returnValue({ afterClosed: () => of(undefined) } as MatDialogRef<unknown>);
    load({ buildMode: 'scan', canContinue: true });
    testId('continue-scan')?.click();
    testId('rescan')?.click();
    const data = dialog.open.calls.allArgs().map(([, config]) => config?.data as { kind: string; label: string });
    expect(data.map((d) => [d.kind, d.label])).toEqual([
      ['scan', 'Continue scan'],
      ['rescan', 'Rescan'],
    ]);
    expect(navigate).not.toHaveBeenCalled();
    done();
  }));

  it('a load error offers Retry', fakeAsync(() => {
    fixture.componentRef.setInput('repository', repositoryView());
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(SUMMARY_URL)
      .flush({ status: 500, error: 'boom', error_reason: 'internal_error' }, { status: 500, statusText: 'x' });
    fixture.detectChanges();
    expect(testId('library-error')?.textContent).toContain("Couldn't load the harness library.");
    expect(notifications.error.calls.count()).toBe(0);
    Array.from(el.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Retry')
      ?.click();
    tick(0);
    httpMock.expectOne(SUMMARY_URL).flush({ status: 200, data: librarySummaryView() });
    fixture.detectChanges();
    expect(testId('library-counts')).not.toBeNull();
    done();
  }));

  it('a changed repository reloads the summary', fakeAsync(() => {
    load();
    fixture.componentRef.setInput('repository', repositoryView({ stateAllowance: 5 }));
    fixture.detectChanges();
    tick(0);
    expect(summaryReqs().length).toBe(1);
    done();
  }));
});
