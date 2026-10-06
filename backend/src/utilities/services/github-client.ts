import { Octokit } from "@octokit/rest";
import {
  GITHUB_API_BASE_URL,
  GITHUB_PR_LIST_MAX_PAGES,
  GITHUB_PR_LIST_PAGE_SIZE,
  GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_USER_AGENT
} from "../../config-consts";
import { ErrorReason } from "../../enums";
import type { ApiResponse } from "../handlers/response-handler";
import { createLogger, redactSecrets } from "../loggers/logger";
import type { GitAuthHeader } from "./git-client";

const log = createLogger("github");

/** One open pull request as listed by GitHubClient.listOpenPullRequests. */
export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  authorLogin: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  draft: boolean;
  htmlUrl: string;
}

/** One pull request with the shas and fork information sheet 07 needs. */
export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseSha: string;
  /** null when the fork was deleted. */
  headRepoFullName: string | null;
  /** headRepoFullName !== `${owner}/${repo}` (case-insensitive), or the head repo is gone. */
  isFork: boolean;
}

export type GitHubErrorKind =
  "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "unavailable" | "invalid" | "unknown";

/** Result of GitHubClient.verifyToken (sheet 05 contract, 05 §5.6). */
export type GitHubTokenVerification =
  | { ok: true; login: string }
  | {
      ok: false;
      reason: "unauthorized" | "forbidden" | "rate_limited" | "network" | "unknown";
      status: number | null;
      message: string;
    };

/** Every failure of a GitHubClient call. The message is a fixed sentence; it never contains the token. */
export class GitHubClientError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly httpStatus: number | null,
    readonly retryAfterSeconds: number | null,
    /** GitHub's own `message` field (safe to show; redacted again before use). */
    readonly githubMessage: string | null
  ) {
    super(message);
    this.name = "GitHubClientError";
  }
}

/** Raw `GET /repos/{owner}/{repo}/pulls` item, reduced to the fields this client reads. */
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

/** Raw `GET /repos/{owner}/{repo}/pulls/{n}` payload, reduced. */
export interface RawPullDetail extends RawPull {
  state: string;
  merged: boolean | null;
}

/** The three GitHub REST calls PRVision makes. Production wraps Octokit; tests inject a fake. */
export interface GitHubRestPort {
  getAuthenticatedUser(signal: AbortSignal): Promise<{ login: string }>;
  listPulls(p: { owner: string; repo: string; page: number; perPage: number; signal: AbortSignal }): Promise<RawPull[]>;
  getPull(p: { owner: string; repo: string; pullNumber: number; signal: AbortSignal }): Promise<RawPullDetail>;
}

/**
 * Builds the production port over Octokit. Octokit's logger is silenced (its warnings can echo request URLs)
 * and its retries are off: these calls are interactive, so failing fast beats silent waits.
 *
 * @param token - Plaintext PAT (held only in memory for this request).
 */
export function createOctokitPort(token: string): GitHubRestPort {
  const silent = (): void => undefined;
  const octokit = new Octokit({
    auth: token,
    userAgent: GITHUB_USER_AGENT,
    baseUrl: GITHUB_API_BASE_URL,
    log: { debug: silent, info: silent, warn: silent, error: silent },
    request: { retries: 0 }
  });
  return {
    async getAuthenticatedUser(signal) {
      const { data } = await octokit.rest.users.getAuthenticated({ request: { signal } });
      return { login: data.login };
    },
    async listPulls({ owner, repo, page, perPage, signal }) {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: perPage,
        page,
        request: { signal }
      });
      return data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        user: pr.user ? { login: pr.user.login } : null,
        draft: pr.draft,
        updated_at: pr.updated_at,
        html_url: pr.html_url,
        head: { ref: pr.head.ref, sha: pr.head.sha, repo: headRepoOf(pr.head) },
        base: { ref: pr.base.ref, sha: pr.base.sha }
      }));
    },
    async getPull({ owner, repo, pullNumber, signal }) {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber, request: { signal } });
      return {
        number: pr.number,
        title: pr.title,
        user: userOf(pr),
        draft: pr.draft,
        updated_at: pr.updated_at,
        html_url: pr.html_url,
        state: pr.state,
        merged: pr.merged,
        head: { ref: pr.head.ref, sha: pr.head.sha, repo: headRepoOf(pr.head) },
        base: { ref: pr.base.ref, sha: pr.base.sha }
      };
    }
  };
}

/**
 * Octokit's OpenAPI types declare `head.repo` (and the detail's `user`) non-null, but GitHub returns null for a
 * deleted fork or a deleted account. Widening to the nullable shape keeps the runtime check honest.
 */
function headRepoOf(head: { repo: { full_name: string } | null }): { full_name: string } | null {
  return head.repo ? { full_name: head.repo.full_name } : null;
}

function userOf(pr: { user: { login: string } | null }): { login: string } | null {
  return pr.user ? { login: pr.user.login } : null;
}

/**
 * The only GitHub API wrapper in the backend (06 §5.6): open PR listing, one PR's detail, token verification
 * and git auth headers. Errors are mapped to GitHubClientError; the raw Octokit error is never logged.
 */
export class GitHubClient {
  constructor(private readonly port: GitHubRestPort) {}

  /** Construct from a plaintext token (sheet 05's test-github and 06/07 use this). */
  static fromToken(token: string): GitHubClient {
    return new GitHubClient(createOctokitPort(token));
  }

  /**
   * Sheet 05 contract (05 §5.6): GET /user with the token. Never throws for HTTP, network or abort failures.
   * `message` is a fixed sentence without the token.
   *
   * @param token - Plaintext PAT to verify.
   * @param options - Caller signal (combined with the client timeout) and an injectable port for tests.
   */
  static async verifyToken(
    token: string,
    options: { signal?: AbortSignal; port?: GitHubRestPort } = {}
  ): Promise<GitHubTokenVerification> {
    try {
      const port = options.port ?? createOctokitPort(token);
      // Always bounded by the client timeout, even when the caller passes its own signal.
      const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
      const user = await port.getAuthenticatedUser(
        options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      );
      return { ok: true, login: user.login };
    } catch (error: unknown) {
      const mapped = toGitHubClientError(error);
      log.warn(
        { event: "github.request.failed", kind: mapped.kind, httpStatus: mapped.httpStatus, owner: null, repo: null },
        "GitHub call failed"
      );
      return {
        ok: false,
        reason: toVerificationReason(mapped.kind),
        status: mapped.httpStatus,
        message: mapped.message
      };
    }
  }

  /**
   * Headers for `GitClient.fetch(..., { auth })` (00 §14.8), in the order sheet 07 tries them: Basic
   * `x-access-token:<token>` first, then Bearer. Scoped to https://github.com/ so redirects to other hosts never
   * receive them. Never log the result; it reaches git only through the environment.
   *
   * @throws Error("Invalid token") when the token has characters outside [A-Za-z0-9_] (header injection guard).
   */
  static gitAuthHeaders(token: string): GitAuthHeader[] {
    if (!/^[A-Za-z0-9_]+$/.test(token)) {
      throw new Error("Invalid token");
    }
    return [
      {
        urlPrefix: "https://github.com/",
        header: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
      },
      { urlPrefix: "https://github.com/", header: `AUTHORIZATION: bearer ${token}` }
    ];
  }

  /** GET /user. */
  async getAuthenticatedUser(): Promise<{ login: string }> {
    return this.call(() => this.port.getAuthenticatedUser(this.timeoutSignal()), { owner: null, repo: null });
  }

  /**
   * Open pull requests, most recently updated first, at most GITHUB_PR_LIST_MAX_PAGES pages (300 PRs).
   *
   * @throws GitHubClientError for any HTTP or network failure.
   */
  async listOpenPullRequests(owner: string, repo: string): Promise<GitHubPullRequestSummary[]> {
    const results: GitHubPullRequestSummary[] = [];
    for (let page = 1; page <= GITHUB_PR_LIST_MAX_PAGES; page += 1) {
      const batch = await this.call(
        () =>
          this.port.listPulls({ owner, repo, page, perPage: GITHUB_PR_LIST_PAGE_SIZE, signal: this.timeoutSignal() }),
        { owner, repo }
      );
      results.push(...batch.map(mapPullSummary));
      if (batch.length < GITHUB_PR_LIST_PAGE_SIZE) {
        break; // last page
      }
    }
    return results;
  }

  /**
   * One pull request with shas and fork flag (sheet 07).
   *
   * @throws GitHubClientError for any HTTP or network failure (404 → kind not_found).
   */
  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequestDetail> {
    const raw = await this.call(() => this.port.getPull({ owner, repo, pullNumber, signal: this.timeoutSignal() }), {
      owner,
      repo
    });
    const summary = mapPullSummary(raw);
    const headRepoFullName = raw.head.repo?.full_name ?? null;
    return {
      ...summary,
      state: raw.state === "closed" ? "closed" : "open",
      merged: raw.merged === true,
      headSha: raw.head.sha,
      baseSha: raw.base.sha,
      headRepoFullName,
      isFork: headRepoFullName === null || headRepoFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
    };
  }

  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  }

  private async call<T>(
    operation: () => Promise<T>,
    context: { owner: string | null; repo: string | null }
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      const mapped = toGitHubClientError(error);
      // Only kind and status: never the error object (it carries request options), headers or the token.
      log.warn(
        { event: "github.request.failed", kind: mapped.kind, httpStatus: mapped.httpStatus, ...context },
        "GitHub call failed"
      );
      throw mapped;
    }
  }
}

function mapPullSummary(raw: RawPull): GitHubPullRequestSummary {
  return {
    number: raw.number,
    title: raw.title,
    authorLogin: raw.user?.login ?? "ghost",
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    updatedAt: raw.updated_at,
    draft: raw.draft === true,
    htmlUrl: raw.html_url
  };
}

/** not_found / invalid on GET /user cannot happen with a valid URL; treat them as unknown. */
function toVerificationReason(kind: GitHubErrorKind): Extract<GitHubTokenVerification, { ok: false }>["reason"] {
  switch (kind) {
    case "unauthorized":
      return "unauthorized";
    case "forbidden":
      return "forbidden";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
      return "network";
    default:
      return "unknown";
  }
}

/**
 * Maps anything an Octokit call can throw to a GitHubClientError, reading the error structurally (no dependency
 * on @octokit/request-error).
 *
 * @param error - The thrown value.
 */
export function toGitHubClientError(error: unknown): GitHubClientError {
  if (error instanceof GitHubClientError) {
    return error;
  }
  const status = readNumber(error, "status");
  const response = readRecord(error, "response");
  const headers = readRecord(response, "headers");
  const ghMessage = readString(readRecord(response, "data"), "message");
  const remaining = readHeader(headers, "x-ratelimit-remaining");
  const retryAfter = parseRetryAfter(headers);
  const isRateLimit =
    (status === 403 || status === 429) &&
    (remaining === "0" || retryAfter !== null || /rate limit/i.test(ghMessage ?? ""));

  if (isAbortOrTimeout(error)) {
    return new GitHubClientError("GitHub did not respond in time", "unavailable", null, null, null);
  }
  if (isRateLimit) {
    return new GitHubClientError("GitHub rate limit reached", "rate_limited", status, retryAfter, ghMessage);
  }
  if (status === 401) {
    return new GitHubClientError("GitHub rejected the token", "unauthorized", 401, null, ghMessage);
  }
  if (status === 403) {
    return new GitHubClientError("GitHub denied access", "forbidden", 403, null, ghMessage);
  }
  if (status === 404) {
    return new GitHubClientError("Not found on GitHub", "not_found", 404, null, ghMessage);
  }
  if (status === 422) {
    return new GitHubClientError("GitHub rejected the request", "invalid", 422, null, ghMessage);
  }
  if (status === null || status >= 500) {
    return new GitHubClientError("GitHub is unavailable", "unavailable", status, null, ghMessage);
  }
  return new GitHubClientError(`GitHub request failed (${String(status)})`, "unknown", status, null, ghMessage);
}

/**
 * Turns a GitHubClientError into the HTTP response of 06 §5.6.4. Never 401/403 (the frontend treats 401 as
 * "session expired"); never includes headers, URLs or the request. Sheet 07 reuses `.error` as its user message.
 *
 * @param error - The mapped client error.
 * @param context - Repository (and PR number for PR lookups) named in the message.
 */
export function githubErrorToApiResponse(
  error: GitHubClientError,
  context: { owner: string; repo: string; pullNumber?: number }
): ApiResponse<never> {
  const slug = `${context.owner}/${context.repo}`;
  const githubMessage = error.githubMessage === null ? null : redactSecrets(error.githubMessage).slice(0, 200);
  switch (error.kind) {
    case "unauthorized":
      return {
        status: 400,
        error: "GitHub rejected the token (expired or revoked). Update it in Settings.",
        error_reason: ErrorReason.GITHUB_UNAUTHORIZED
      };
    case "forbidden": {
      const base = `The GitHub token cannot access ${slug}. A fine-grained token needs Pull requests: Read and Contents: Read on this repository.`;
      const saml = /saml/i.test(githubMessage ?? "")
        ? " Authorize the token for SSO in your organization settings."
        : "";
      return { status: 400, error: `${base}${saml}`, error_reason: ErrorReason.GITHUB_UNAUTHORIZED };
    }
    case "not_found":
      return context.pullNumber === undefined
        ? {
            status: 400,
            error: `Repository ${slug} was not found, or the token cannot access it. Fine-grained tokens return 404 for repositories outside their selection.`,
            error_reason: ErrorReason.GITHUB_UNAUTHORIZED
          }
        : {
            status: 404,
            error: `Pull request #${String(context.pullNumber)} was not found in ${slug}, or the token cannot see this repository.`,
            error_reason: ErrorReason.NOT_FOUND
          };
    case "rate_limited":
      return {
        status: 429,
        error:
          error.retryAfterSeconds === null
            ? "GitHub rate limit reached. Try again later."
            : `GitHub rate limit reached. Try again in ${String(Math.max(1, Math.ceil(error.retryAfterSeconds / 60)))} minutes.`,
        error_reason: ErrorReason.GITHUB_RATE_LIMITED
      };
    case "invalid":
      return {
        status: 400,
        error: `GitHub rejected the request: ${githubMessage ?? "no details"}`,
        error_reason: ErrorReason.VALIDATION_FAILED
      };
    case "unavailable":
      return {
        status: 502,
        error: "GitHub could not be reached. Check your network and try again.",
        error_reason: ErrorReason.GITHUB_UNAVAILABLE
      };
    case "unknown":
      return {
        status: 502,
        error: `GitHub request failed (HTTP ${error.httpStatus === null ? "unknown" : String(error.httpStatus)}).`,
        error_reason: ErrorReason.GITHUB_UNAVAILABLE
      };
  }
}

const GITHUB_HOSTS: readonly string[] = ["github.com", "www.github.com", "ssh.github.com"];
const SCP_LIKE = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const URL_PROTOCOLS: readonly string[] = ["https:", "http:", "ssh:", "git:"];

/**
 * Owner and repo of a github.com remote URL (https, ssh, scp-like, git://), or null for anything else (GitHub
 * Enterprise, ssh config aliases, other hosts, malformed paths). Embedded credentials are discarded.
 *
 * @param url - Remote URL as printed by `git remote get-url`. Never logged or stored.
 */
export function parseGithubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const input = url.trim();
  let host: string;
  let pathname: string;
  const scp = input.includes("://") ? null : SCP_LIKE.exec(input);
  if (scp) {
    host = scp[1] ?? "";
    pathname = scp[2] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      return null;
    }
    if (!URL_PROTOCOLS.includes(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname;
    pathname = parsed.pathname;
  }
  if (!GITHUB_HOSTS.includes(host.toLowerCase())) {
    return null;
  }
  let trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed.endsWith(".git")) {
    trimmed = trimmed.slice(0, -4);
  }
  const segments = trimmed.split("/");
  if (segments.length !== 2) {
    return null;
  }
  const [owner = "", repo = ""] = segments;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    return null;
  }
  return { owner, repo };
}

// ----- structural readers (no dependency on Octokit error classes) -----

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "object" && field !== null ? (field as Record<string, unknown>) : null;
}

function readNumber(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function readString(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function readHeader(headers: Record<string, unknown> | null, name: string): string | null {
  const field = headers?.[name];
  if (typeof field === "string") {
    return field;
  }
  return typeof field === "number" ? String(field) : null;
}

/**
 * Seconds until the rate limit resets: the `retry-after` header, else `x-ratelimit-reset − now` when the primary
 * limit is exhausted (`x-ratelimit-remaining: 0`). GitHub sends x-ratelimit-reset on every response, so it only
 * counts together with remaining 0 (otherwise every 403 would look like a rate limit).
 */
function parseRetryAfter(headers: Record<string, unknown> | null): number | null {
  const retryAfter = readHeader(headers, "retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
    return Number(retryAfter.trim());
  }
  const reset = readHeader(headers, "x-ratelimit-reset");
  if (readHeader(headers, "x-ratelimit-remaining") === "0" && reset !== null && /^\d+$/.test(reset.trim())) {
    return Math.max(0, Number(reset.trim()) - Math.floor(Date.now() / 1000));
  }
  return null;
}

function isAbortOrTimeout(error: unknown): boolean {
  const names = ["AbortError", "TimeoutError"];
  const name = readName(error);
  if (name !== null && names.includes(name)) {
    return true;
  }
  const cause = typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  const causeName = readName(cause);
  return causeName !== null && names.includes(causeName);
}

function readName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}
