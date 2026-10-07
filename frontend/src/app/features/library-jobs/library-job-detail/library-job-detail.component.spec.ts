import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed, discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { MatDialog, type MatDialogRef } from '@angular/material/dialog';
import { Title } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type LibraryJobView } from '../../../core/models/harness-library.model';
import { ConfirmDialogService, GENERIC_POPUP_DIALOG_CONFIG } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { ScanDialogComponent } from '../../repositories/components/scan-dialog/scan-dialog.component';
import { libraryJobEvent, libraryJobView, repositoryView } from '../../repositories/testing/library-fixtures';
import { LibraryJobDetailComponent, libraryJobPageView } from './library-job-detail.component';

const BASE = environment.apiBaseUrl;

describe('LibraryJobDetailComponent', () => {
  let fixture: ComponentFixture<LibraryJobDetailComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let confirm: jasmine.SpyObj<ConfirmDialogService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  let navigate: jasmine.Spy;

  beforeEach(async () => {
    confirm = jasmine.createSpyObj<ConfirmDialogService>('ConfirmDialogService', ['confirm']);
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    await TestBed.configureTestingModule({
      imports: [LibraryJobDetailComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        {
          provide: NotificationService,
          useValue: jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']),
        },
        { provide: ConfirmDialogService, useValue: confirm },
        { provide: MatDialog, useValue: dialog },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(LibraryJobDetailComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    httpMock.verify({ ignoreCancelled: true });
  });

  function load(job: Partial<LibraryJobView> = {}, id = '5'): void {
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(`${BASE}/library-jobs/${id}`)
      .flush({ status: 200, data: libraryJobView({ id: Number(id), ...job }) });
    for (const r of httpMock.match((req) => req.url.endsWith('/events'))) {
      r.flush({ status: 200, data: [libraryJobEvent(1, { message: 'Scanning 201 components at a1b2c3d.' })] });
    }
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
  function plainText(node: Element | null): string {
    if (!node) return '';
    const copy = node.cloneNode(true) as Element;
    for (const icon of Array.from(copy.querySelectorAll('mat-icon'))) icon.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  it('running scan: title, status pill, progress card, cap, counts, current label, allowance and console', fakeAsync(() => {
    load();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Scan · my-shop');
    expect(TestBed.inject(Title).getTitle()).toContain('Scan · my-shop');
    expect(el.querySelector('[aria-label="Status: Running"]')).not.toBeNull();
    expect(el.querySelector('a[aria-label="Back to repository"]')?.getAttribute('href')).toBe('/repositories/3');
    expect(testId('job-progress-text')?.textContent?.trim()).toBe('84 of 201 harnesses written, about $12 spent');
    expect(testId('job-progress')?.querySelector('mat-progress-bar')?.getAttribute('aria-valuenow')).toBe('42');
    expect(testId('job-cap')?.textContent?.trim()).toBe('Cap $20');
    expect(testId('job-counts')?.textContent?.trim()).toBe('80 saved · 3 need updating · 1 skipped');
    expect(testId('job-current')?.textContent?.trim()).toBe('Writing InvoiceRow (src/components/InvoiceRow.tsx)');
    expect(testId('job-allowance')?.textContent?.trim()).toBe('3 states per component');
    expect(testId('cancel-job')).not.toBeNull();
    expect(testId('continue-scan')).toBeNull();
    expect(testId('job-outcome')).toBeNull();
    expect(el.querySelector('app-console-panel')?.textContent).toContain('Scanning 201 components at a1b2c3d.');
    done();
  }));

  it('no cap pill without a cap', fakeAsync(() => {
    load({ spendCapUsd: null });
    expect(testId('job-cap')).toBeNull();
    done();
  }));

  it('cap reached: "Paused at cap" pill, warning and Continue scan', fakeAsync(() => {
    load({ status: 'cap_reached', completedAt: '2026-10-03T10:40:00Z' });
    expect(el.querySelector('[aria-label="Status: Paused at cap"]')).not.toBeNull();
    expect(plainText(testId('job-outcome'))).toContain(
      'Paused at the spending cap. Continue the scan to write the rest.',
    );
    expect(testId('cancel-job')).toBeNull();
    expect(testId('continue-scan')).not.toBeNull();
    expect(testId('job-current')).toBeNull();
    done();
  }));

  it('failed shows the error message; completed shows the done line without Continue', fakeAsync(() => {
    load({ status: 'failed', errorMessage: 'The default branch main was not found in the clone.' });
    expect(plainText(testId('job-outcome'))).toContain('The default branch main was not found in the clone.');
    expect(testId('continue-scan')).not.toBeNull();
    done();
  }));

  it('completed: "Done: <written> saved, <failed> need updating, <skipped> skipped."', fakeAsync(() => {
    load({ status: 'completed', writtenCount: 190, failedCount: 9, skippedCount: 2, processedCount: 201 });
    expect(plainText(testId('job-outcome'))).toContain('Done: 190 saved, 9 need updating, 2 skipped.');
    expect(testId('continue-scan')).toBeNull();
    done();
  }));

  it('repair job: title, back link to the run, no Continue', fakeAsync(() => {
    load({ kind: 'repair', visualizationId: 42, componentIds: [1, 2], status: 'completed', spendCapUsd: null });
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Repair · run #42');
    expect(el.querySelector('a[aria-label="Back to run"]')?.getAttribute('href')).toBe('/visualizations/42');
    expect(testId('continue-scan')).toBeNull();
    done();
  }));

  it('Cancel asks first and cancels', fakeAsync(() => {
    confirm.confirm.and.returnValue(of(true));
    load();
    testId('cancel-job')?.click();
    expect(confirm.confirm.calls.mostRecent().args[0].confirmColor).toBe('warn');
    httpMock
      .expectOne(`${BASE}/library-jobs/5/cancel`)
      .flush({ status: 202, data: { id: 5, status: 'cancel_requested' } }, { status: 202, statusText: 'Accepted' });
    fixture.detectChanges();
    expect(plainText(testId('cancel-job'))).toBe('Cancelling…');
    done();
  }));

  it('Continue scan loads the repository, opens the scan dialog with kind scan and goes to the new job', fakeAsync(() => {
    dialog.open.and.returnValue({ afterClosed: () => of(libraryJobView({ id: 6 })) } as MatDialogRef<unknown>);
    load({ status: 'cancelled' });
    testId('continue-scan')?.click();
    const repo = repositoryView();
    httpMock.expectOne(`${BASE}/repositories/3`).flush({ status: 200, data: repo });
    expect(dialog.open.calls.allArgs()).toEqual([
      [
        ScanDialogComponent,
        { ...GENERIC_POPUP_DIALOG_CONFIG, data: { repository: repo, kind: 'scan', label: 'Continue scan' } },
      ],
    ]);
    expect(navigate.calls.allArgs()).toEqual([[['/library-jobs', 6]]]);
    done();
  }));

  it('invalid id → not found without request; 404 → not found', fakeAsync(() => {
    fixture.componentRef.setInput('id', 'x');
    fixture.detectChanges();
    tick(5000);
    httpMock.expectNone(() => true);
    fixture.detectChanges();
    expect(el.textContent).toContain('Job not found');
    done();
  }));

  it('a 404 shows the not-found panel', fakeAsync(() => {
    fixture.componentRef.setInput('id', '8');
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(`${BASE}/library-jobs/8`)
      .flush({ status: 404, error: 'Not found', error_reason: 'not_found' }, { status: 404, statusText: 'x' });
    httpMock.match(() => true);
    fixture.detectChanges();
    expect(el.textContent).toContain('Job not found');
    done();
  }));

  it('libraryJobPageView: rescan title and singular allowance', () => {
    const view = libraryJobPageView(libraryJobView({ kind: 'rescan', stateAllowance: 1 }));
    expect(view.title).toBe('Rescan · my-shop');
    expect(view.allowanceText).toBe('1 state per component');
  });
});
