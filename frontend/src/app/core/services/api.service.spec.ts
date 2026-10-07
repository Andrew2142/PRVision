import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { type Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { errorInterceptor } from '../interceptors/error.interceptor';
import { SUPPRESS_ERROR_TOAST } from '../interceptors/http-context-tokens';
import { ApiError } from '../models/api-error.model';
import { ApiService } from './api.service';
import { NotificationService } from './notification.service';

interface RouteCase {
  name: string;
  call: (api: ApiService) => Observable<unknown>;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  silent: boolean;
}

const ROUTES: RouteCase[] = [
  { name: 'getHealth', call: (a) => a.getHealth(), method: 'GET', path: 'health', silent: true },
  { name: 'getSettings', call: (a) => a.getSettings(), method: 'GET', path: 'settings', silent: true },
  {
    name: 'updateSettings',
    call: (a) => a.updateSettings({ aiModel: 'claude-opus-5-5' }),
    method: 'PUT',
    path: 'settings',
    silent: true,
  },
  { name: 'testGithub', call: (a) => a.testGithub(), method: 'POST', path: 'settings/test-github', silent: true },
  { name: 'testAi', call: (a) => a.testAi(), method: 'POST', path: 'settings/test-ai', silent: true },
  { name: 'listRepositories', call: (a) => a.listRepositories(), method: 'GET', path: 'repositories', silent: true },
  { name: 'getRepository', call: (a) => a.getRepository(3), method: 'GET', path: 'repositories/3', silent: true },
  {
    name: 'createRepository',
    call: (a) => a.createRepository({ localPath: '~/code/app' }),
    method: 'POST',
    path: 'repositories',
    silent: true,
  },
  {
    name: 'redetectRepository',
    call: (a) => a.redetectRepository(3),
    method: 'POST',
    path: 'repositories/3/redetect',
    silent: false,
  },
  {
    name: 'removeRepository',
    call: (a) => a.removeRepository(3),
    method: 'DELETE',
    path: 'repositories/3',
    silent: false,
  },
  {
    name: 'listPullRequests',
    call: (a) => a.listPullRequests(3),
    method: 'GET',
    path: 'repositories/3/pull-requests',
    silent: true,
  },
  {
    name: 'listBranches',
    call: (a) => a.listBranches(3),
    method: 'GET',
    path: 'repositories/3/branches',
    silent: true,
  },
  {
    name: 'listCommits',
    call: (a) => a.listCommits(3, { branch: 'main' }),
    method: 'GET',
    path: 'repositories/3/commits',
    silent: true,
  },
  {
    name: 'createVisualization',
    call: (a) => a.createVisualization({ repositoryId: 3, sourceType: 'working_tree' }),
    method: 'POST',
    path: 'visualizations',
    silent: true,
  },
  {
    name: 'listVisualizations',
    call: (a) => a.listVisualizations({}),
    method: 'GET',
    path: 'visualizations',
    silent: true,
  },
  {
    name: 'getVisualization',
    call: (a) => a.getVisualization(9),
    method: 'GET',
    path: 'visualizations/9',
    silent: true,
  },
  { name: 'getConsole', call: (a) => a.getConsole(9), method: 'GET', path: 'visualizations/9/console', silent: true },
  {
    name: 'cancelVisualization',
    call: (a) => a.cancelVisualization(9),
    method: 'POST',
    path: 'visualizations/9/cancel',
    silent: true,
  },
  {
    name: 'removeVisualization',
    call: (a) => a.removeVisualization(9),
    method: 'DELETE',
    path: 'visualizations/9',
    silent: false,
  },
  {
    name: 'updateRepository',
    call: (a) => a.updateRepository(3, { stateAllowance: 2 }),
    method: 'PATCH',
    path: 'repositories/3',
    silent: false,
  },
  // 16h library block (sheet 16 §15.1)
  {
    name: 'estimateLibraryForFolder',
    call: (a) => a.estimateLibraryForFolder({ localPath: '/home/dev/app', stateAllowance: 3 }),
    method: 'POST',
    path: 'repositories/library-estimate',
    silent: true,
  },
  {
    name: 'getLibrarySummary',
    call: (a) => a.getLibrarySummary(3),
    method: 'GET',
    path: 'repositories/3/library',
    silent: true,
  },
  {
    name: 'estimateLibrary',
    call: (a) => a.estimateLibrary(3),
    method: 'GET',
    path: 'repositories/3/library/estimate',
    silent: true,
  },
  {
    name: 'startLibraryScan',
    call: (a) => a.startLibraryScan(3, { kind: 'scan', spendCapUsd: null }),
    method: 'POST',
    path: 'repositories/3/library/scans',
    silent: true,
  },
  { name: 'getLibraryJob', call: (a) => a.getLibraryJob(5), method: 'GET', path: 'library-jobs/5', silent: true },
  {
    name: 'getLibraryJobEvents',
    call: (a) => a.getLibraryJobEvents(5),
    method: 'GET',
    path: 'library-jobs/5/events',
    silent: true,
  },
  {
    name: 'cancelLibraryJob',
    call: (a) => a.cancelLibraryJob(5),
    method: 'POST',
    path: 'library-jobs/5/cancel',
    silent: true,
  },
  {
    name: 'repairComponent',
    call: (a) => a.repairComponent(9, 11),
    method: 'POST',
    path: 'visualizations/9/components/11/repair',
    silent: true,
  },
  {
    name: 'repairBroken',
    call: (a) => a.repairBroken(9),
    method: 'POST',
    path: 'visualizations/9/repair-broken',
    silent: true,
  },
  // 16j live block (16 §14.6)
  { name: 'startLive', call: (a) => a.startLive(9), method: 'POST', path: 'visualizations/9/live', silent: true },
  { name: 'getLive', call: (a) => a.getLive(9), method: 'GET', path: 'visualizations/9/live', silent: true },
  {
    name: 'openLive',
    call: (a) => a.openLive(9, { componentId: 11, stateName: 'Default' }),
    method: 'POST',
    path: 'visualizations/9/live/open',
    silent: true,
  },
  {
    name: 'heartbeatLive',
    call: (a) => a.heartbeatLive(9, { active: true }),
    method: 'POST',
    path: 'visualizations/9/live/heartbeat',
    silent: true,
  },
  {
    name: 'stopLive',
    call: (a) => a.stopLive(9, { reason: 'user' }),
    method: 'POST',
    path: 'visualizations/9/live/stop',
    silent: true,
  },
];

describe('ApiService', () => {
  const base = environment.apiBaseUrl;
  let api: ApiService;
  let http: HttpTestingController;
  let notifyError: jasmine.Spy<NotificationService['error']>;

  beforeEach(() => {
    notifyError = jasmine.createSpy<NotificationService['error']>('error');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: { error: notifyError } },
      ],
    });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it('getSettings → GET {apiBaseUrl}/settings and unwraps {status,data}', () => {
    let result: unknown;
    api.getSettings().subscribe((v) => (result = v));
    const req = http.expectOne(`${base}/settings`);
    expect(req.request.method).toBe('GET');
    const view = { hasGithubToken: false, githubLogin: null, aiProvider: 'anthropic_api' };
    req.flush({ status: 200, data: view });
    expect(result).toEqual(view);
  });

  it('every typed method hits its 00 §9/§14.4 method + path', () => {
    expect(ROUTES.length).toBe(34);
    for (const route of ROUTES) {
      let result: unknown;
      route.call(api).subscribe((v) => (result = v));
      const req = http.expectOne((r) => r.url === `${base}/${route.path}`, route.name);
      expect(req.request.method).withContext(route.name).toBe(route.method);
      expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).withContext(route.name).toBe(route.silent);
      req.flush({ status: 200, data: { ok: route.name } });
      expect(result).withContext(route.name).toEqual({ ok: route.name });
    }
  });

  it('updateSettings sends the body unchanged (no null secrets)', () => {
    api.updateSettings({ githubToken: '', anthropicApiKey: 'sk-test', aiHarnessEffort: 'high' }).subscribe();
    const req = http.expectOne(`${base}/settings`);
    expect(req.request.body).toEqual({ githubToken: '', anthropicApiKey: 'sk-test', aiHarnessEffort: 'high' });
    // A cleared secret travels as "" (00 §14.4), never null.
    expect((req.request.body as Record<string, unknown>)['githubToken']).toBe('');
    req.flush({ status: 200, data: {} });
  });

  it('listVisualizations serializes statuses as one comma-separated status param', () => {
    api.listVisualizations({ statuses: ['queued', 'rendering'], repositoryId: 4, page: 2, pageSize: 50 }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/visualizations`);
    expect(req.request.params.get('status')).toBe('queued,rendering');
    expect(req.request.params.getAll('status')?.length).toBe(1);
    expect(req.request.params.get('repositoryId')).toBe('4');
    expect(req.request.params.get('page')).toBe('2');
    expect(req.request.params.get('pageSize')).toBe('50');
    req.flush({ status: 200, data: { items: [], page: 2, pageSize: 50, total: 0 } });
  });

  it('listVisualizations omits empty status/repositoryId', () => {
    api.listVisualizations({ statuses: [] }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/visualizations`);
    expect(req.request.params.has('status')).toBeFalse();
    expect(req.request.params.has('repositoryId')).toBeFalse();
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('pageSize')).toBe('20');
    req.flush({ status: 200, data: { items: [], page: 1, pageSize: 20, total: 0 } });
  });

  it('listCommits passes branch, limit and before (00 §16) and omits an absent before', () => {
    api.listCommits(3, { branch: 'feature/x', limit: 30, before: 'a'.repeat(40) }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/repositories/3/commits`);
    expect(req.request.params.get('branch')).toBe('feature/x');
    expect(req.request.params.get('limit')).toBe('30');
    expect(req.request.params.get('before')).toBe('a'.repeat(40));
    req.flush({ status: 200, data: [] });

    api.listCommits(3, { branch: 'main' }).subscribe();
    const first = http.expectOne((r) => r.url === `${base}/repositories/3/commits`);
    expect(first.request.params.has('before')).toBeFalse();
    expect(first.request.params.has('limit')).toBeFalse();
    first.flush({ status: 200, data: [] });
  });

  it('getConsole passes afterId and limit', () => {
    api.getConsole(9, { afterId: 41, limit: 500 }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/visualizations/9/console`);
    expect(req.request.params.get('afterId')).toBe('41');
    expect(req.request.params.get('limit')).toBe('500');
    req.flush({ status: 200, data: [] });
  });

  it('estimateLibrary passes stateAllowance and kind, and omits them when absent', () => {
    api.estimateLibrary(3, { stateAllowance: 4, kind: 'rescan' }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/repositories/3/library/estimate`);
    expect(req.request.params.get('stateAllowance')).toBe('4');
    expect(req.request.params.get('kind')).toBe('rescan');
    req.flush({ status: 200, data: {} });

    api.estimateLibrary(3).subscribe();
    const bare = http.expectOne((r) => r.url === `${base}/repositories/3/library/estimate`);
    expect(bare.request.params.keys()).toEqual([]);
    bare.flush({ status: 200, data: {} });
  });

  it('getLibraryJobEvents passes afterId and limit', () => {
    api.getLibraryJobEvents(5, { afterId: 12, limit: 500 }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}/library-jobs/5/events`);
    expect(req.request.params.get('afterId')).toBe('12');
    expect(req.request.params.get('limit')).toBe('500');
    req.flush({ status: 200, data: [] });
  });

  it('library mutations send their bodies unchanged', () => {
    api.startLibraryScan(3, { kind: 'rescan', spendCapUsd: 12.5, stateAllowance: 2 }).subscribe();
    api.updateRepository(3, { stateAllowance: 4 }).subscribe();
    api.estimateLibraryForFolder({ localPath: '/x', appRoot: 'apps/web', stateAllowance: 1 }).subscribe();
    const scan = http.expectOne(`${base}/repositories/3/library/scans`);
    expect(scan.request.body).toEqual({ kind: 'rescan', spendCapUsd: 12.5, stateAllowance: 2 });
    const patch = http.expectOne(`${base}/repositories/3`);
    expect(patch.request.body).toEqual({ stateAllowance: 4 });
    const estimate = http.expectOne(`${base}/repositories/library-estimate`);
    expect(estimate.request.body).toEqual({ localPath: '/x', appRoot: 'apps/web', stateAllowance: 1 });
    for (const r of [scan, patch, estimate]) r.flush({ status: 200, data: {} });
  });

  it('GETs set SUPPRESS_ERROR_TOAST true by default', () => {
    for (const route of ROUTES.filter((r) => r.method === 'GET')) {
      route.call(api).subscribe();
      const req = http.expectOne((r) => r.url === `${base}/${route.path}`);
      expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).withContext(route.name).toBeTrue();
      req.flush({ status: 200, data: null });
    }
  });

  it('redetect/remove* set it false by default', () => {
    api.redetectRepository(1).subscribe();
    api.removeRepository(1).subscribe();
    api.removeVisualization(1).subscribe();
    for (const path of ['repositories/1/redetect', 'repositories/1', 'visualizations/1']) {
      const req = http.expectOne(`${base}/${path}`);
      expect(req.request.context.get(SUPPRESS_ERROR_TOAST)).withContext(path).toBeFalse();
      req.flush({ status: 200, data: { id: 1 } });
    }
  });

  it('explicit { silent } overrides the default', () => {
    api.removeRepository(1, { silent: true }).subscribe();
    api.getSettings({ silent: false }).subscribe();
    const remove = http.expectOne(`${base}/repositories/1`);
    const settings = http.expectOne(`${base}/settings`);
    expect(remove.request.context.get(SUPPRESS_ERROR_TOAST)).toBeTrue();
    expect(settings.request.context.get(SUPPRESS_ERROR_TOAST)).toBeFalse();
    remove.flush({ status: 200, data: { id: 1 } });
    settings.flush({ status: 200, data: {} });
  });

  it('2xx body without data errors with ApiError status -1 and no toast', () => {
    let error: unknown;
    api.removeVisualization(2).subscribe({ error: (e: unknown) => (error = e) });
    http.expectOne(`${base}/visualizations/2`).flush({ status: 200 });
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(-1);
    expect((error as ApiError).errorReason).toBe('internal_error');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('202 cancel response unwraps', () => {
    let result: unknown;
    api.cancelVisualization(5).subscribe((v) => (result = v));
    http
      .expectOne(`${base}/visualizations/5/cancel`)
      .flush({ status: 202, data: { id: 5, status: 'cancel_requested' } }, { status: 202, statusText: 'Accepted' });
    expect(result).toEqual({ id: 5, status: 'cancel_requested' });
  });

  it('live calls send their bodies unchanged (16 §14.6)', () => {
    api.startLive(9).subscribe();
    api.openLive(9, { componentId: 11, stateName: 'Menu open' }).subscribe();
    api.heartbeatLive(9, { active: false }).subscribe();
    api.stopLive(9, { reason: 'left' }).subscribe();
    const bodies = [
      ['live', {}],
      ['live/open', { componentId: 11, stateName: 'Menu open' }],
      ['live/heartbeat', { active: false }],
      ['live/stop', { reason: 'left' }],
    ] as const;
    for (const [path, body] of bodies) {
      const req = http.expectOne((r) => r.method === 'POST' && r.url === `${base}/visualizations/9/${path}`);
      expect(req.request.body).withContext(path).toEqual(body);
      req.flush({ status: 200, data: {} });
    }
  });

  it('stopLiveBeacon sends a text/plain "{}" beacon to the stop route', async () => {
    const beacon = spyOn(navigator, 'sendBeacon').and.returnValue(true);
    expect(api.stopLiveBeacon(9)).toBeTrue();
    const [url, data] = beacon.calls.mostRecent().args;
    expect(url).toBe(`${base}/visualizations/9/live/stop`);
    expect(data instanceof Blob).toBeTrue();
    expect((data as Blob).type).toBe('text/plain');
    expect(await (data as Blob).text()).toBe('{}');
  });
});
