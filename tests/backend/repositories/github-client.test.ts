import assert from "node:assert/strict";
import test from "node:test";
import { GITHUB_PR_LIST_MAX_PAGES, GITHUB_PR_LIST_PAGE_SIZE } from "../../../backend/src/config-consts";
import {
  GitHubClient,
  GitHubClientError,
  githubErrorToApiResponse,
  toGitHubClientError,
  type GitHubErrorKind
} from "../../../backend/src/utilities/services/github-client";
import { recordLogger } from "../helpers/console-recorder";
import {
  createFakeGithubPort,
  githubHttpError,
  networkError,
  rawPull,
  rawPullDetail
} from "../helpers/fake-github-port";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function pulls(count: number): Array<ReturnType<typeof rawPull>> {
  return Array.from({ length: count }, (_, index) => rawPull({ number: index + 1, title: `PR ${String(index + 1)}` }));
}

async function rejection(promise: Promise<unknown>): Promise<GitHubClientError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof GitHubClientError, `expected GitHubClientError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected a rejection");
}

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

test("listOpenPullRequests stops after a short page", async () => {
  const fake = createFakeGithubPort({ pulls: pulls(GITHUB_PR_LIST_PAGE_SIZE + 5) });
  const result = await new GitHubClient(fake.port).listOpenPullRequests("acme", "web");
  assert.equal(result.length, GITHUB_PR_LIST_PAGE_SIZE + 5);
  assert.deepEqual(
    fake.calls.map((call) => [call.args.page, call.args.perPage, call.args.owner, call.args.repo]),
    [
      [1, GITHUB_PR_LIST_PAGE_SIZE, "acme", "web"],
      [2, GITHUB_PR_LIST_PAGE_SIZE, "acme", "web"]
    ]
  );
  assert.ok(fake.calls.every((call) => call.args.signal instanceof AbortSignal));
  assert.deepEqual(result[0], {
    number: 1,
    title: "PR 1",
    authorLogin: "octocat",
    headRef: "feature/button-restyle",
    baseRef: "main",
    updatedAt: "2026-01-02T10:00:00Z",
    draft: false,
    htmlUrl: "https://github.com/acme/web/pull/7"
  });
});

test("listOpenPullRequests requests at most GITHUB_PR_LIST_MAX_PAGES pages", async () => {
  const fake = createFakeGithubPort({ pulls: pulls(GITHUB_PR_LIST_PAGE_SIZE * (GITHUB_PR_LIST_MAX_PAGES + 2)) });
  const result = await new GitHubClient(fake.port).listOpenPullRequests("acme", "web");
  assert.equal(fake.calls.length, GITHUB_PR_LIST_MAX_PAGES);
  assert.equal(result.length, GITHUB_PR_LIST_PAGE_SIZE * GITHUB_PR_LIST_MAX_PAGES);
});

test('maps a null user to "ghost" and undefined draft to false', async () => {
  const withoutDraft = rawPull({ number: 2, user: null });
  delete (withoutDraft as { draft?: boolean }).draft;
  const fake = createFakeGithubPort({ pulls: [withoutDraft, rawPull({ number: 3, draft: true })] });
  const [ghost, draft] = await new GitHubClient(fake.port).listOpenPullRequests("acme", "web");
  assert.equal(ghost?.authorLogin, "ghost");
  assert.equal(ghost.draft, false);
  assert.equal(draft?.draft, true);
});

test("getPullRequest flags forks and deleted head repos as isFork", async () => {
  const fake = createFakeGithubPort({
    pullDetails: {
      1: rawPullDetail({ number: 1, head: { ref: "a", sha: "1".repeat(40), repo: { full_name: "ACME/Web" } } }),
      2: rawPullDetail({ number: 2, head: { ref: "b", sha: "2".repeat(40), repo: { full_name: "someone/web" } } }),
      3: rawPullDetail({
        number: 3,
        head: { ref: "c", sha: "3".repeat(40), repo: null },
        state: "closed",
        merged: true
      })
    }
  });
  const client = new GitHubClient(fake.port);
  const same = await client.getPullRequest("acme", "web", 1);
  assert.equal(same.isFork, false);
  assert.equal(same.headSha, "1".repeat(40));
  assert.equal(same.baseSha, "b".repeat(40));
  assert.equal(same.state, "open");
  assert.equal(same.merged, false);
  assert.equal((await client.getPullRequest("acme", "web", 2)).isFork, true);
  const deleted = await client.getPullRequest("acme", "web", 3);
  assert.equal(deleted.isFork, true);
  assert.equal(deleted.headRepoFullName, null);
  assert.equal(deleted.state, "closed");
  assert.equal(deleted.merged, true);
  assert.equal((await rejection(client.getPullRequest("acme", "web", 99))).kind, "not_found");
});

test("maps 401 to unauthorized, 403 to forbidden, 404 to not_found, 422 to invalid", () => {
  const rows: Array<[number, GitHubErrorKind]> = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [422, "invalid"],
    [500, "unavailable"],
    [503, "unavailable"],
    [409, "unknown"]
  ];
  for (const [status, kind] of rows) {
    const mapped = toGitHubClientError(githubHttpError(status, "Message from GitHub"));
    assert.equal(mapped.kind, kind, String(status));
    assert.equal(mapped.httpStatus, status);
    assert.equal(mapped.githubMessage, "Message from GitHub");
  }
  // A plain 403 carries x-ratelimit-reset on every GitHub response; that alone is not a rate limit.
  const forbidden = toGitHubClientError(
    githubHttpError(403, "Resource not accessible by personal access token", {
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600)
    })
  );
  assert.equal(forbidden.kind, "forbidden");
});

test("maps 403 with x-ratelimit-remaining 0 to rate_limited with retryAfterSeconds from x-ratelimit-reset", () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const mapped = toGitHubClientError(
    githubHttpError(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset)
    })
  );
  assert.equal(mapped.kind, "rate_limited");
  assert.equal(mapped.httpStatus, 403);
  assert.ok(mapped.retryAfterSeconds !== null && mapped.retryAfterSeconds >= 598 && mapped.retryAfterSeconds <= 600);
  assert.equal(
    toGitHubClientError(githubHttpError(403, "You have exceeded a secondary rate limit")).kind,
    "rate_limited"
  );
});

test("maps 429 with retry-after to rate_limited", () => {
  const mapped = toGitHubClientError(githubHttpError(429, "Too Many Requests", { "retry-after": "120" }));
  assert.equal(mapped.kind, "rate_limited");
  assert.equal(mapped.retryAfterSeconds, 120);
});

test("maps AbortError/TimeoutError and network errors to unavailable", () => {
  for (const error of [
    namedError("AbortError"),
    namedError("TimeoutError"),
    // Octokit wraps fetch failures in a RequestError (status 500) whose cause is the original error.
    Object.assign(new Error("request failed"), { name: "HttpError", status: 500, cause: namedError("TimeoutError") }),
    networkError(),
    Object.assign(new Error("connect ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } })
  ]) {
    const mapped = toGitHubClientError(error);
    assert.equal(mapped.kind, "unavailable", error.message);
  }
  assert.equal(toGitHubClientError(namedError("TimeoutError")).message, "GitHub did not respond in time");
});

test("githubErrorToApiResponse never returns HTTP 401 or 403", () => {
  const kinds: GitHubErrorKind[] = [
    "unauthorized",
    "forbidden",
    "not_found",
    "rate_limited",
    "unavailable",
    "invalid",
    "unknown"
  ];
  const expected: Record<GitHubErrorKind, [number, string]> = {
    unauthorized: [400, "github_unauthorized"],
    forbidden: [400, "github_unauthorized"],
    not_found: [400, "github_unauthorized"],
    rate_limited: [429, "github_rate_limited"],
    unavailable: [502, "github_unavailable"],
    invalid: [400, "validation_failed"],
    unknown: [502, "github_unavailable"]
  };
  for (const kind of kinds) {
    const response = githubErrorToApiResponse(new GitHubClientError("x", kind, 418, null, "Validation Failed"), {
      owner: "acme",
      repo: "web"
    });
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 403);
    assert.deepEqual([response.status, response.error_reason], expected[kind], kind);
    assert.equal(typeof response.error, "string");
  }
  const rate = (seconds: number | null): unknown =>
    githubErrorToApiResponse(new GitHubClientError("x", "rate_limited", 403, seconds, null), { owner: "a", repo: "b" })
      .error;
  assert.equal(rate(30), "GitHub rate limit reached. Try again in 1 minutes.");
  assert.equal(rate(601), "GitHub rate limit reached. Try again in 11 minutes.");
  assert.equal(rate(null), "GitHub rate limit reached. Try again later.");
  const saml = githubErrorToApiResponse(
    new GitHubClientError("x", "forbidden", 403, null, "Resource protected by organization SAML enforcement."),
    { owner: "acme", repo: "web" }
  );
  assert.ok(String(saml.error).endsWith("Authorize the token for SSO in your organization settings."));
  const invalid = githubErrorToApiResponse(
    new GitHubClientError("x", "invalid", 422, null, `Bad ${TOKEN} ${"y".repeat(400)}`),
    { owner: "a", repo: "b" }
  );
  assert.ok(!String(invalid.error).includes(TOKEN), "githubMessage is redacted");
  assert.ok(String(invalid.error).length <= "GitHub rejected the request: ".length + 200);
});

test("githubErrorToApiResponse distinguishes PR-not-found (404 not_found) from repo-not-found (400 github_unauthorized)", () => {
  const error = new GitHubClientError("Not found on GitHub", "not_found", 404, null, "Not Found");
  const pr = githubErrorToApiResponse(error, { owner: "acme", repo: "web", pullNumber: 12 });
  assert.equal(pr.status, 404);
  assert.equal(pr.error_reason, "not_found");
  assert.equal(pr.error, "Pull request #12 was not found in acme/web, or the token cannot see this repository.");
  const repo = githubErrorToApiResponse(error, { owner: "acme", repo: "web" });
  assert.equal(repo.status, 400);
  assert.equal(repo.error_reason, "github_unauthorized");
  assert.ok(String(repo.error).startsWith("Repository acme/web was not found"));
});

test("verifyToken returns ok with the login on success", async () => {
  const fake = createFakeGithubPort({ login: "octo-dev" });
  assert.deepEqual(await GitHubClient.verifyToken(TOKEN, { port: fake.port }), { ok: true, login: "octo-dev" });
  const controller = new AbortController();
  await GitHubClient.verifyToken(TOKEN, { port: fake.port, signal: controller.signal });
  const signal = fake.calls[1]?.args.signal;
  assert.ok(signal instanceof AbortSignal);
  controller.abort();
  assert.equal(signal.aborted, true, "the caller's signal is combined with the client timeout");
});

test("verifyToken never throws: 401 → unauthorized, 403 → forbidden, rate limit → rate_limited, timeout → network", async () => {
  const rows: Array<[unknown, string, number | null]> = [
    [githubHttpError(401, "Bad credentials"), "unauthorized", 401],
    [githubHttpError(403, "Forbidden"), "forbidden", 403],
    [githubHttpError(429, "Too Many Requests", { "retry-after": "60" }), "rate_limited", 429],
    [namedError("TimeoutError"), "network", null],
    [networkError(), "network", null],
    [githubHttpError(404, "Not Found"), "unknown", 404],
    ["a thrown string", "network", null]
  ];
  for (const [error, reason, status] of rows) {
    const fake = createFakeGithubPort({ errors: { getAuthenticatedUser: [error] } });
    const result = await GitHubClient.verifyToken(TOKEN, { port: fake.port });
    if (result.ok) {
      assert.fail(`expected a failure for ${String(error)}`);
    }
    assert.equal(result.reason, reason, String(error));
    assert.equal(result.status, status);
    assert.ok(result.message.length > 0);
  }
});

test("verifyToken message never contains the token", async () => {
  const recorder = recordLogger();
  try {
    const leaky = Object.assign(new Error(`Request failed with token ${TOKEN}`), {
      status: 401,
      response: { status: 401, headers: { authorization: `token ${TOKEN}` }, data: { message: `Bad ${TOKEN}` } },
      request: { headers: { authorization: `token ${TOKEN}` } }
    });
    const fake = createFakeGithubPort({ errors: { getAuthenticatedUser: [leaky] } });
    const result = await GitHubClient.verifyToken(TOKEN, { port: fake.port });
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!recorder.text().includes(TOKEN), "logs never contain the token");
    assert.ok(recorder.lines.some((line) => line.event === "github.request.failed"));
  } finally {
    recorder.restore();
  }
});

test("gitAuthHeaders returns Basic x-access-token then Bearer, both scoped to https://github.com/", () => {
  const headers = GitHubClient.gitAuthHeaders(TOKEN);
  assert.deepEqual(headers, [
    {
      urlPrefix: "https://github.com/",
      header: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`
    },
    { urlPrefix: "https://github.com/", header: `AUTHORIZATION: bearer ${TOKEN}` }
  ]);
  assert.doesNotThrow(() => GitHubClient.gitAuthHeaders("github_pat_11ABC_def"));
});

test('gitAuthHeaders throws for a token containing whitespace, ":" or a newline', () => {
  for (const token of ["ghp abc", "ghp:abc", "ghp\nAUTHORIZATION: x", "ghp\tabc", "", "ghp\u0000"]) {
    assert.throws(() => GitHubClient.gitAuthHeaders(token), /Invalid token/, JSON.stringify(token));
  }
});
