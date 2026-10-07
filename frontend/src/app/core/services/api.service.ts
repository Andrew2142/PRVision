import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { DEFAULT_PAGE_SIZE } from '../constants/pagination.constants';
import { SUPPRESS_ERROR_TOAST } from '../interceptors/http-context-tokens';
import { ApiError } from '../models/api-error.model';
import { type ApiEnvelope, type DeleteResult, type HealthView, type Paged } from '../models/api.model';
import {
  type CancelLibraryJobResponse,
  type HarnessLibrarySummaryView,
  type LibraryEstimateQuery,
  type LibraryEstimateRequest,
  type LibraryEstimateView,
  type LibraryJobEventView,
  type LibraryJobEventsQuery,
  type LibraryJobView,
  type LibraryScanCreateRequest,
} from '../models/harness-library.model';
import {
  type LiveHeartbeatRequest,
  type LiveHeartbeatResponse,
  type LiveOpenRequest,
  type LiveSessionView,
  type LiveStopRequest,
  type LiveStopResponse,
} from '../models/live-session.model';
import {
  type AppDiscoveryView,
  type BranchListView,
  type CommitListQuery,
  type CommitView,
  type PullRequestView,
  type RepositoryCreateRequest,
  type RepositoryCreateResponse,
  type RepositoryDetectAppsRequest,
  type RepositoryUpdateRequest,
  type RepositoryView,
} from '../models/repository.model';
import {
  type AiTestResultView,
  type GithubTestResultView,
  type SettingsUpdateRequest,
  type SettingsView,
} from '../models/settings.model';
import {
  type CancelVisualizationResponse,
  type ConsoleEventView,
  type ConsoleQuery,
  type CreateVisualizationResponse,
  type VisualizationCreateRequest,
  type VisualizationDetailView,
  type VisualizationListQuery,
  type VisualizationSummaryView,
} from '../models/visualization.model';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface ApiRequestOptions {
  /** true → the error interceptor does not toast; the caller renders or toasts the error itself. */
  silent?: boolean;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestSpec {
  body?: unknown;
  params?: QueryParams;
  silent: boolean;
}

/**
 * The only `HttpClient` user (01 §5.14.3): one typed method per 00 §9/§14.4 route, envelope unwrapping.
 * Silent defaults: every GET and every call whose errors the screen renders inline is silent; the remaining
 * mutations (redetect, remove*) let the interceptor toast. Paths are relative to `apiBaseUrl`.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  // Health (04). Always silent: the top-bar pill is the only feedback.
  getHealth(): Observable<HealthView> {
    return this.request('GET', 'health', { silent: true });
  }

  // Settings (05)
  getSettings(o: ApiRequestOptions = {}): Observable<SettingsView> {
    return this.request('GET', 'settings', { silent: true, ...o });
  }

  updateSettings(body: SettingsUpdateRequest, o: ApiRequestOptions = {}): Observable<SettingsView> {
    return this.request('PUT', 'settings', { body, silent: true, ...o });
  }

  testGithub(o: ApiRequestOptions = {}): Observable<GithubTestResultView> {
    return this.request('POST', 'settings/test-github', { body: {}, silent: true, ...o });
  }

  testAi(o: ApiRequestOptions = {}): Observable<AiTestResultView> {
    return this.request('POST', 'settings/test-ai', { body: {}, silent: true, ...o });
  }

  // Repositories (06)
  listRepositories(o: ApiRequestOptions = {}): Observable<RepositoryView[]> {
    return this.request('GET', 'repositories', { silent: true, ...o });
  }

  getRepository(id: number, o: ApiRequestOptions = {}): Observable<RepositoryView> {
    return this.request('GET', `repositories/${id}`, { silent: true, ...o });
  }

  /** 201 with the repository plus `scanJobId` / `scanStartError` (16 §14.2). */
  createRepository(body: RepositoryCreateRequest, o: ApiRequestOptions = {}): Observable<RepositoryCreateResponse> {
    return this.request('POST', 'repositories', { body, silent: true, ...o });
  }

  /** Apps of the repository containing `localPath` (15 §5.4.5). */
  detectRepositoryApps(body: RepositoryDetectAppsRequest, o: ApiRequestOptions = {}): Observable<AppDiscoveryView> {
    return this.request('POST', 'repositories/detect-apps', { body, silent: true, ...o });
  }

  /** Saves repository settings (screen size, states per component). Not silent: the interceptor toasts errors. */
  updateRepository(id: number, body: RepositoryUpdateRequest, o: ApiRequestOptions = {}): Observable<RepositoryView> {
    return this.request('PATCH', `repositories/${id}`, { body, silent: false, ...o });
  }

  redetectRepository(id: number, o: ApiRequestOptions = {}): Observable<RepositoryView> {
    return this.request('POST', `repositories/${id}/redetect`, { body: {}, silent: false, ...o });
  }

  removeRepository(id: number, o: ApiRequestOptions = {}): Observable<DeleteResult> {
    return this.request('DELETE', `repositories/${id}`, { silent: false, ...o });
  }

  listPullRequests(id: number, o: ApiRequestOptions = {}): Observable<PullRequestView[]> {
    return this.request('GET', `repositories/${id}/pull-requests`, { silent: true, ...o });
  }

  listBranches(id: number, o: ApiRequestOptions = {}): Observable<BranchListView> {
    return this.request('GET', `repositories/${id}/branches`, { silent: true, ...o });
  }

  /** A branch's first-parent commits, newest first (00 §16). */
  listCommits(id: number, q: CommitListQuery, o: ApiRequestOptions = {}): Observable<CommitView[]> {
    return this.request('GET', `repositories/${id}/commits`, {
      params: { branch: q.branch, limit: q.limit, before: q.before, q: q.q },
      silent: true,
      ...o,
    });
  }

  // Visualizations (07)
  createVisualization(
    body: VisualizationCreateRequest,
    o: ApiRequestOptions = {},
  ): Observable<CreateVisualizationResponse> {
    return this.request('POST', 'visualizations', { body, silent: true, ...o });
  }

  listVisualizations(
    q: VisualizationListQuery,
    o: ApiRequestOptions = {},
  ): Observable<Paged<VisualizationSummaryView>> {
    return this.request('GET', 'visualizations', {
      params: {
        page: q.page ?? 1,
        pageSize: q.pageSize ?? DEFAULT_PAGE_SIZE,
        // Comma list, 00 §14.4.
        status: q.statuses?.length ? q.statuses.join(',') : undefined,
        repositoryId: q.repositoryId,
      },
      silent: true,
      ...o,
    });
  }

  getVisualization(id: number, o: ApiRequestOptions = {}): Observable<VisualizationDetailView> {
    return this.request('GET', `visualizations/${id}`, { silent: true, ...o });
  }

  getConsole(id: number, q: ConsoleQuery = {}, o: ApiRequestOptions = {}): Observable<ConsoleEventView[]> {
    return this.request('GET', `visualizations/${id}/console`, {
      params: { afterId: q.afterId, limit: q.limit },
      silent: true,
      ...o,
    });
  }

  /** Continues a run paused for the component-limit choice (00 §19). */
  continueVisualization(
    id: number,
    componentLimit: number,
    o: ApiRequestOptions = {},
  ): Observable<{ id: number; componentLimit: number; jobId: string }> {
    return this.request('POST', `visualizations/${id}/continue`, { body: { componentLimit }, silent: true, ...o });
  }

  cancelVisualization(id: number, o: ApiRequestOptions = {}): Observable<CancelVisualizationResponse> {
    return this.request('POST', `visualizations/${id}/cancel`, { body: {}, silent: true, ...o });
  }

  removeVisualization(id: number, o: ApiRequestOptions = {}): Observable<DeleteResult> {
    return this.request('DELETE', `visualizations/${id}`, { silent: false, ...o });
  }

  // ----- 16h library block (sheet 16 §15.1). 16j appends the live block and 16k the transfer block below it. -----

  /** Estimate for a folder that is not registered yet (Add repository dialog). */
  estimateLibraryForFolder(body: LibraryEstimateRequest, o: ApiRequestOptions = {}): Observable<LibraryEstimateView> {
    return this.request('POST', 'repositories/library-estimate', { body, silent: true, ...o });
  }

  getLibrarySummary(repositoryId: number, o: ApiRequestOptions = {}): Observable<HarnessLibrarySummaryView> {
    return this.request('GET', `repositories/${repositoryId}/library`, { silent: true, ...o });
  }

  estimateLibrary(
    repositoryId: number,
    q: LibraryEstimateQuery = {},
    o: ApiRequestOptions = {},
  ): Observable<LibraryEstimateView> {
    return this.request('GET', `repositories/${repositoryId}/library/estimate`, {
      params: { stateAllowance: q.stateAllowance, kind: q.kind },
      silent: true,
      ...o,
    });
  }

  /** 202 with the queued job. */
  startLibraryScan(
    repositoryId: number,
    body: LibraryScanCreateRequest,
    o: ApiRequestOptions = {},
  ): Observable<LibraryJobView> {
    return this.request('POST', `repositories/${repositoryId}/library/scans`, { body, silent: true, ...o });
  }

  getLibraryJob(jobId: number, o: ApiRequestOptions = {}): Observable<LibraryJobView> {
    return this.request('GET', `library-jobs/${jobId}`, { silent: true, ...o });
  }

  getLibraryJobEvents(
    jobId: number,
    q: LibraryJobEventsQuery = {},
    o: ApiRequestOptions = {},
  ): Observable<LibraryJobEventView[]> {
    return this.request('GET', `library-jobs/${jobId}/events`, {
      params: { afterId: q.afterId, limit: q.limit },
      silent: true,
      ...o,
    });
  }

  cancelLibraryJob(jobId: number, o: ApiRequestOptions = {}): Observable<CancelLibraryJobResponse> {
    return this.request('POST', `library-jobs/${jobId}/cancel`, { body: {}, silent: true, ...o });
  }

  /** 202 with the repair job. */
  repairComponent(visualizationId: number, componentId: number, o: ApiRequestOptions = {}): Observable<LibraryJobView> {
    return this.request('POST', `visualizations/${visualizationId}/components/${componentId}/repair`, {
      body: {},
      silent: true,
      ...o,
    });
  }

  /** 202 with the repair job for every row of the run whose harness needs updating. */
  repairBroken(visualizationId: number, o: ApiRequestOptions = {}): Observable<LibraryJobView> {
    return this.request('POST', `visualizations/${visualizationId}/repair-broken`, { body: {}, silent: true, ...o });
  }

  // ----- end of the 16h library block -----

  // ----- 16j live block (sheet 16 §14.6, §15.6). Every call is silent: the live panel renders its own errors. -----

  /** 202 with a new session, or 200 with the run's active one; 409 `conflict` when two other runs are live. */
  startLive(visualizationId: number, o: ApiRequestOptions = {}): Observable<LiveSessionView> {
    return this.request('POST', `visualizations/${visualizationId}/live`, { body: {}, silent: true, ...o });
  }

  /** The active session, or the most recent one; 404 when the run never had one. */
  getLive(visualizationId: number, o: ApiRequestOptions = {}): Observable<LiveSessionView> {
    return this.request('GET', `visualizations/${visualizationId}/live`, { silent: true, ...o });
  }

  /** 202: asks the session to start the hosts of the component's render group on both sides. */
  openLive(visualizationId: number, body: LiveOpenRequest, o: ApiRequestOptions = {}): Observable<LiveSessionView> {
    return this.request('POST', `visualizations/${visualizationId}/live/open`, { body, silent: true, ...o });
  }

  /** 404 once the session is no longer active. */
  heartbeatLive(
    visualizationId: number,
    body: LiveHeartbeatRequest,
    o: ApiRequestOptions = {},
  ): Observable<LiveHeartbeatResponse> {
    return this.request('POST', `visualizations/${visualizationId}/live/heartbeat`, { body, silent: true, ...o });
  }

  /** Idempotent: 200 `{ id: null, status: "stopped" }` when nothing is running. */
  stopLive(visualizationId: number, body: LiveStopRequest, o: ApiRequestOptions = {}): Observable<LiveStopResponse> {
    return this.request('POST', `visualizations/${visualizationId}/live/stop`, { body, silent: true, ...o });
  }

  /**
   * Stop while the page unloads (`pagehide`): a beacon survives the unload where an XHR does not. The `text/plain`
   * body needs no preflight; the API reads a missing or unreadable body as reason `left` (16 §12.6).
   */
  stopLiveBeacon(visualizationId: number): boolean {
    return navigator.sendBeacon(
      `${this.baseUrl}/visualizations/${visualizationId}/live/stop`,
      new Blob(['{}'], { type: 'text/plain' }),
    );
  }

  // ----- end of the 16j live block -----

  private request<T>(method: HttpMethod, path: string, opts: RequestSpec): Observable<T> {
    return this.http
      .request<unknown>(method, `${this.baseUrl}/${path}`, {
        body: opts.body,
        params: toHttpParams(opts.params),
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, opts.silent),
        responseType: 'json',
      })
      .pipe(map((body) => unwrapEnvelope(body) as T));
  }
}

export function toHttpParams(params: QueryParams | undefined): HttpParams {
  let result = new HttpParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    result = result.set(key, String(value));
  }
  return result;
}

/** 00 §14.2: every 2xx body is `{ status, data }`. Anything else is a contract breach, not data. */
export function unwrapEnvelope(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && 'data' in body) return (body as ApiEnvelope<unknown>).data;
  throw new ApiError('The PRVision API sent a response PRVision cannot read.', -1, 'internal_error');
}
