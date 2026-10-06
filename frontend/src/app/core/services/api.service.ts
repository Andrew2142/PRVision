import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { DEFAULT_PAGE_SIZE } from '../constants/pagination.constants';
import { SUPPRESS_ERROR_TOAST } from '../interceptors/http-context-tokens';
import { ApiError } from '../models/api-error.model';
import { type ApiEnvelope, type DeleteResult, type HealthView, type Paged } from '../models/api.model';
import {
  type AppDiscoveryView,
  type BranchListView,
  type CommitListQuery,
  type CommitView,
  type PullRequestView,
  type RepositoryCreateRequest,
  type RepositoryDetectAppsRequest,
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

  createRepository(body: RepositoryCreateRequest, o: ApiRequestOptions = {}): Observable<RepositoryView> {
    return this.request('POST', 'repositories', { body, silent: true, ...o });
  }

  /** Apps of the repository containing `localPath` (15 §5.4.5). */
  detectRepositoryApps(body: RepositoryDetectAppsRequest, o: ApiRequestOptions = {}): Observable<AppDiscoveryView> {
    return this.request('POST', 'repositories/detect-apps', { body, silent: true, ...o });
  }

  /** Saves repository settings (the screenshot screen size). */
  updateRepository(
    id: number,
    body: { renderViewport: 'desktop' | 'tablet' | 'mobile' },
    o: ApiRequestOptions = {},
  ): Observable<RepositoryView> {
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
