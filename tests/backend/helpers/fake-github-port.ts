/**
 * Fake GitHubRestPort (sheet 14 §5.4.12) shared by 06 (github-client, repositories service) and 07 (PR creation
 * through a real GitHubClient over this port), plus raw PR payload builders and an Octokit-like HTTP error.
 */

/*
 * Structural copy of sheet 06's port (06 §5.6.2). Sheet 06 creates utilities/services/github-client.ts in wave 3,
 * after this helper (wave 2), so it cannot be imported yet without breaking `npm run typecheck`. Passing
 * `createFakeGithubPort().port` to the real GitHubClient type-checks it against the real interface at the call
 * site; wave 6 replaces this copy with `import type { GitHubRestPort }` (14 build notes, deviation 3).
 */
export interface RawPull {
  number: number;
  title: string;
  user: { login: string } | null;
  draft?: boolean;
  updated_at: string;
  html_url: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string };
}
export interface RawPullDetail extends RawPull {
  state: string;
  merged: boolean | null;
}
export interface GitHubRestPort {
  getAuthenticatedUser(signal: AbortSignal): Promise<{ login: string }>;
  listPulls(p: { owner: string; repo: string; page: number; perPage: number; signal: AbortSignal }): Promise<RawPull[]>;
  getPull(p: { owner: string; repo: string; pullNumber: number; signal: AbortSignal }): Promise<RawPullDetail>;
}

export interface FakeGithubState {
  login?: string;
  pulls?: Array<ReturnType<typeof rawPull>>;
  pullDetails?: Record<number, ReturnType<typeof rawPullDetail>>;
  /** Throw this error from the named method (once per entry, in order). */
  errors?: Partial<Record<keyof GitHubRestPort, unknown[]>>;
}

/** A GitHubRestPort over in-memory state; records every call. */
export function createFakeGithubPort(state: FakeGithubState = {}): {
  port: GitHubRestPort;
  calls: Array<{ method: keyof GitHubRestPort; args: Record<string, unknown> }>;
} {
  const calls: Array<{ method: keyof GitHubRestPort; args: Record<string, unknown> }> = [];
  const scriptedError = (method: keyof GitHubRestPort): { error: unknown } | null => {
    const queue = state.errors?.[method];
    if (!queue || queue.length === 0) {
      return null;
    }
    return { error: queue.shift() };
  };
  const port: GitHubRestPort = {
    getAuthenticatedUser(signal) {
      calls.push({ method: "getAuthenticatedUser", args: { signal } });
      const failure = scriptedError("getAuthenticatedUser");
      if (failure) {
        return rejectWith(failure.error);
      }
      return Promise.resolve({ login: state.login ?? "octo" });
    },
    listPulls(p) {
      calls.push({ method: "listPulls", args: p });
      const failure = scriptedError("listPulls");
      if (failure) {
        return rejectWith(failure.error);
      }
      const all = state.pulls ?? [];
      return Promise.resolve(all.slice((p.page - 1) * p.perPage, p.page * p.perPage) as unknown as RawPull[]);
    },
    getPull(p) {
      calls.push({ method: "getPull", args: p });
      const failure = scriptedError("getPull");
      if (failure) {
        return rejectWith(failure.error);
      }
      const detail = state.pullDetails?.[p.pullNumber];
      if (!detail) {
        return Promise.reject(githubHttpError(404, "Not Found"));
      }
      return Promise.resolve(detail as unknown as RawPullDetail);
    }
  };
  return { port, calls };
}

/** Rejects with exactly the scripted value (tests script non-Error values on purpose to exercise mappers). */
function rejectWith<T>(error: unknown): Promise<T> {
  return new Promise<T>(() => {
    throw error;
  });
}

/** Raw `GET /repos/{owner}/{repo}/pulls` item (Octokit snake_case). */
export function rawPull(overrides: Record<string, unknown> = {}): Record<string, unknown> & RawPull {
  return {
    number: 7,
    title: "Restyle button",
    user: { login: "octocat" },
    draft: false,
    updated_at: "2026-01-02T10:00:00Z",
    html_url: "https://github.com/acme/web/pull/7",
    head: { ref: "feature/button-restyle", sha: "a".repeat(40), repo: { full_name: "acme/web" } },
    base: { ref: "main", sha: "b".repeat(40) },
    ...overrides
  };
}

/** Raw `GET /repos/{owner}/{repo}/pulls/{n}` payload. */
export function rawPullDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> & RawPullDetail {
  return { ...rawPull(), state: "open", merged: false, ...overrides };
}

/** Octokit-like HTTP error (status + response headers) as GitHubClient's mapper reads it. */
export function githubHttpError(status: number, message: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), {
    name: "HttpError",
    status,
    response: { status, headers, data: { message } },
    request: { headers: { authorization: "token [REDACTED]" } }
  });
}

/** What fetch throws when DNS fails (undici: TypeError with a cause code). */
export const networkError = (): Error => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
