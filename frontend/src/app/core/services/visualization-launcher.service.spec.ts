import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { errorInterceptor } from '../interceptors/error.interceptor';
import { NotificationService } from './notification.service';
import { VisualizationLauncherService } from './visualization-launcher.service';

describe('VisualizationLauncherService', () => {
  let service: VisualizationLauncherService;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let router: jasmine.SpyObj<Router>;
  const url = `${environment.apiBaseUrl}/visualizations`;

  beforeEach(() => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', [
      'queued',
      'info',
      'error',
      'success',
      'warn',
      'promptAction',
    ]);
    router = jasmine.createSpyObj<Router>('Router', ['navigate', 'navigateByUrl']);
    router.navigate.and.resolveTo(true);
    router.navigateByUrl.and.resolveTo(true);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
        { provide: Router, useValue: router },
      ],
    });
    service = TestBed.inject(VisualizationLauncherService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  function fail(status: number, reason: string, error = 'Server says no'): void {
    httpMock.expectOne(url).flush({ status, error, error_reason: reason }, { status, statusText: 'Error' });
  }

  it('success toasts queued and navigates to /visualizations/:id', () => {
    const results: (number | null)[] = [];
    service
      .launch({ repositoryId: 1, sourceType: 'github_pr', prNumber: 42 }, 'PR #42 · Fix cart totals')
      .subscribe((v) => results.push(v));
    const req = httpMock.expectOne(url);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ repositoryId: 1, sourceType: 'github_pr', prNumber: 42 });
    req.flush({ status: 202, data: { visualizationId: 7, jobId: 'viz-7' } }, { status: 202, statusText: 'Accepted' });
    expect(results).toEqual([7]);
    expect(notifications.queued.calls.allArgs()).toEqual([
      ['Visualization queued: PR #42 · Fix cart totals. Opening live progress…'],
    ]);
    expect(router.navigate.calls.allArgs()).toEqual([[['/visualizations', 7]]]);
  });

  it('github_token_missing prompts and navigates to /settings on accept', () => {
    notifications.promptAction.and.returnValue(of(true));
    const results: (number | null)[] = [];
    service
      .launch({ repositoryId: 1, sourceType: 'github_pr', prNumber: 1 }, 'PR #1')
      .subscribe((v) => results.push(v));
    fail(400, 'github_token_missing');
    expect(results).toEqual([null]);
    const data = notifications.promptAction.calls.mostRecent().args[0];
    expect(data.title).toBe('GitHub token needed');
    expect(data.actionLabel).toBe('Open settings');
    expect(data.dismissText).toBe('Not now');
    expect(router.navigateByUrl.calls.allArgs()).toEqual([['/settings']]);
    expect(notifications.error.calls.count()).toBe(0);
  });

  it('ai_not_configured prompts', () => {
    notifications.promptAction.and.returnValue(of(false));
    service.launch({ repositoryId: 1, sourceType: 'working_tree' }, 'working tree on main').subscribe();
    fail(400, 'ai_not_configured', 'Add an Anthropic API key in Settings.');
    const data = notifications.promptAction.calls.mostRecent().args[0];
    expect(data.title).toBe('AI provider not configured');
    expect(data.message).toBe('Add an Anthropic API key in Settings.');
    expect(router.navigateByUrl.calls.count()).toBe(0);
    expect(notifications.error.calls.count()).toBe(0);
  });

  it('working_tree_clean info toast, no navigation', () => {
    service.launch({ repositoryId: 1, sourceType: 'working_tree' }, 'working tree on main').subscribe();
    fail(400, 'working_tree_clean');
    expect(notifications.info.calls.allArgs()).toEqual([['The working tree has no uncommitted changes.']]);
    expect(router.navigate.calls.count()).toBe(0);
    expect(router.navigateByUrl.calls.count()).toBe(0);
    expect(notifications.error.calls.count()).toBe(0);
  });

  it('other error toasts message once (createVisualization is silent, interceptor does not toast)', () => {
    service
      .launch(
        { repositoryId: 1, sourceType: 'local_branch', headRef: 'feature/x', baseRef: 'main' },
        'feature/x vs main',
      )
      .subscribe();
    fail(409, 'conflict', 'Already running');
    expect(notifications.error.calls.allArgs()).toEqual([['Already running']]);
  });

  it('never errors (emits null)', () => {
    let errored = false;
    let completed = false;
    const results: (number | null)[] = [];
    service.launch({ repositoryId: 1, sourceType: 'working_tree' }, 'x').subscribe({
      next: (v) => results.push(v),
      error: () => (errored = true),
      complete: () => (completed = true),
    });
    httpMock.expectOne(url).error(new ProgressEvent('error'), { status: 0 });
    expect(results).toEqual([null]);
    expect(errored).toBeFalse();
    expect(completed).toBeTrue();
    expect(notifications.error.calls.count()).toBe(1);
  });
});
