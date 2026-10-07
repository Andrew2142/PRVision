import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { DATA_DIR } from "../../../backend/src/config-consts";
import type { VisualizationCreateDTO } from "../../../backend/src/dtos";
import { Table } from "../../../backend/src/enums";
import { VisualizationModel } from "../../../backend/src/models";
import {
  VisualizationsService,
  type VisualizationsServiceDependencies,
  isLiveAvailable
} from "../../../backend/src/services/visualizations/visualizations-service";
import {
  ArtifactStore,
  GitClient,
  GitHubClientError,
  type ApiResponse,
  type GitHubPullRequestDetail,
  type QueryHandler
} from "../../../backend/src/utilities";
import {
  idModel,
  makeComponentRow,
  makeConsoleEventRow,
  makeRepositoryRow,
  makeVisualizationRow
} from "../helpers/factories";
import { recordLogger } from "../helpers/console-recorder";
import { createTempGitRepo } from "../helpers/git-fixtures";
import { InMemoryQueryHandler, installQueryHandlerStub } from "../helpers/query-handler-stub";
import { runWithAuthContext } from "../helpers/test-context";
import { useTempDataDir } from "../helpers/temp-dir";
import { createFakeDb, FakeQueueStatics, fakeTransaction, gitError } from "./helpers/fakes";

const NOW = new Date("2026-03-01T12:00:00.000Z");
/** First-parent history of feature/x, oldest first; its tip is what the fake revParse returns ("c"×40). */
const BRANCH_LINE = ["1".repeat(40), "2".repeat(40), "c".repeat(40)];
/** A commit that exists in the repository but is not on feature/x. */
const OFF_BRANCH_SHA = "9".repeat(40);
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
});

interface Harness {
  store: InMemoryQueryHandler;
  queue: FakeQueueStatics;
  deps: Partial<VisualizationsServiceDependencies>;
  removedArtifacts: number[];
  service(id?: number): VisualizationsService;
}

function prDetail(overrides: Partial<GitHubPullRequestDetail> = {}): GitHubPullRequestDetail {
  return {
    number: 12,
    title: "Restyle the button",
    authorLogin: "octo",
    headRef: "feature/restyle",
    baseRef: "main",
    updatedAt: "2026-01-01T00:00:00Z",
    draft: false,
    htmlUrl: "https://github.com/acme/web/pull/12",
    state: "open",
    merged: false,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    headRepoFullName: "acme/web",
    isFork: false,
    ...overrides
  };
}

function setup(t: TestContext, overrides: Partial<VisualizationsServiceDependencies> = {}): Harness {
  const store = new InMemoryQueryHandler();
  const stub = installQueryHandlerStub(store);
  restores.push(stub.restore);
  const dataDir = useTempDataDir(t);
  store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: dataDir })]);
  const queue = new FakeQueueStatics();
  const removedArtifacts: number[] = [];
  const artifactStore = new ArtifactStore(dataDir);
  const deps: Partial<VisualizationsServiceDependencies> = {
    queryHandler: store as unknown as QueryHandler,
    db: createFakeDb(store).db,
    transaction: fakeTransaction(store),
    git: {
      revParse: (_cwd, rev) =>
        Promise.resolve(
          rev.endsWith("/main") || rev.endsWith("/feature/x")
            ? "c".repeat(40)
            : Promise.reject(gitError("unknown_revision"))
        ),
      isDirty: () => Promise.resolve(true),
      currentBranch: () => Promise.resolve("main"),
      hasCommit: (_cwd, sha) => Promise.resolve(BRANCH_LINE.includes(sha) || sha === OFF_BRANCH_SHA),
      isAncestor: (_cwd, ancestor, descendant) =>
        Promise.resolve(
          BRANCH_LINE.includes(ancestor) &&
            BRANCH_LINE.includes(descendant) &&
            BRANCH_LINE.indexOf(ancestor) <= BRANCH_LINE.indexOf(descendant)
        )
    },
    aiReadiness: () => Promise.resolve({ ready: true, provider: "anthropic_api", model: "claude-opus-5-5" }),
    readGithubToken: () => Promise.resolve({ state: "present", value: "ghp_testtoken" }),
    githubClientFactory: () => ({ getPullRequest: () => Promise.resolve(prDetail()) }),
    queue,
    artifacts: {
      toPublicUrl: (p) => artifactStore.toPublicUrl(p),
      removeVisualization: (id) => {
        removedArtifacts.push(id);
        return Promise.resolve();
      }
    },
    now: () => NOW,
    ...overrides
  };
  return {
    store,
    queue,
    deps,
    removedArtifacts,
    service: (id?: number) =>
      new VisualizationsService(id === undefined ? new VisualizationModel() : idModel(id, VisualizationModel), deps)
  };
}

const createDto = (body: Partial<VisualizationCreateDTO>): VisualizationCreateDTO => ({
  repositoryId: 1,
  sourceType: "local_branch",
  headRef: "feature/x",
  ...body
});

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithAuthContext(fn);

// ---------------------------------------------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------------------------------------------

test("VisualizationsService.create returns 404 for an unknown repository", async (t) => {
  const h = setup(t);
  const response = await run(() => h.service().create(createDto({ repositoryId: 99 })));
  assert.deepEqual(response, { status: 404, error: "Repository not found", error_reason: "not_found" });
  h.store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2, localPath: "/tmp/x", isDeleted: true })]);
  assert.equal((await run(() => h.service().create(createDto({ repositoryId: 2 })))).status, 404);
});

test("VisualizationsService.create returns 400 ai_not_configured when readiness is not ready", async (t) => {
  const h = setup(t, {
    aiReadiness: () =>
      Promise.resolve({ ready: false, reason: "ai_not_configured", message: "Add an Anthropic API key." })
  });
  const response = await run(() => h.service().create(createDto({})));
  assert.deepEqual(response, { status: 400, error: "Add an Anthropic API key.", error_reason: "ai_not_configured" });
  assert.equal(h.store.rows(Table.VISUALIZATIONS).length, 0);
});

test("VisualizationsService.create github_pr returns no_github_remote and github_token_missing (absent and unreadable)", async (t) => {
  const h = setup(t);
  const pr = createDto({ sourceType: "github_pr", prNumber: 12, headRef: undefined });
  const noRemote = await run(() => h.service().create(pr));
  assert.equal(noRemote.status, 400);
  assert.equal(noRemote.error_reason, "no_github_remote");

  h.store.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 3, localPath: "/tmp/r", githubOwner: "acme", githubRepo: "web" })
  ]);
  const prOnGithub = createDto({ repositoryId: 3, sourceType: "github_pr", prNumber: 12, headRef: undefined });
  h.deps.readGithubToken = () => Promise.resolve({ state: "absent" });
  const absent = await run(() => h.service().create(prOnGithub));
  assert.deepEqual(absent, {
    status: 400,
    error: "Add a GitHub token in Settings to visualize pull requests.",
    error_reason: "github_token_missing"
  });
  h.deps.readGithubToken = () => Promise.resolve({ state: "unreadable" });
  const unreadable = await run(() => h.service().create(prOnGithub));
  assert.equal(unreadable.error_reason, "github_token_missing");
  assert.match(String(unreadable.error), /can no longer be decrypted/);
});

test("VisualizationsService.create github_pr maps GitHubClientError not_found to 404 not_found and rate_limited to 429 github_rate_limited", async (t) => {
  const h = setup(t);
  h.store.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 3, localPath: "/tmp/r", githubOwner: "acme", githubRepo: "web" })
  ]);
  const dto = createDto({ repositoryId: 3, sourceType: "github_pr", prNumber: 12, headRef: undefined });
  h.deps.githubClientFactory = () => ({
    getPullRequest: () => Promise.reject(new GitHubClientError("Not found on GitHub", "not_found", 404, null, null))
  });
  const notFound = await run(() => h.service().create(dto));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.error_reason, "not_found");
  assert.match(String(notFound.error), /Pull request #12 was not found in acme\/web/);

  h.deps.githubClientFactory = () => ({
    getPullRequest: () =>
      Promise.reject(new GitHubClientError("GitHub rate limit reached", "rate_limited", 403, 120, null))
  });
  const limited = await run(() => h.service().create(dto));
  assert.equal(limited.status, 429);
  assert.equal(limited.error_reason, "github_rate_limited");
  assert.equal(h.store.rows(Table.VISUALIZATIONS).length, 0);
});

test('VisualizationsService.create github_pr uses "#n title" as the title, the PR base as baseRef (ignoring dto.baseRef) and the fork label as headRef', async (t) => {
  const h = setup(t);
  h.store.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 3, localPath: "/tmp/r", githubOwner: "acme", githubRepo: "web" })
  ]);
  h.deps.githubClientFactory = () => ({
    getPullRequest: () =>
      Promise.resolve(
        prDetail({ baseRef: "develop", headRepoFullName: "forker/web", isFork: true, headRef: "patch-1" })
      )
  });
  const response = await run(() =>
    h
      .service()
      .create(
        createDto({ repositoryId: 3, sourceType: "github_pr", prNumber: 12, headRef: undefined, baseRef: "main" })
      )
  );
  assert.equal(response.status, 202);
  const row = h.store.rows(Table.VISUALIZATIONS)[0];
  assert.equal(row?.title, "#12 Restyle the button");
  assert.equal(row.baseRef, "develop");
  assert.equal(row.headRef, "forker:patch-1");
  assert.equal(row.prNumber, 12);

  h.deps.githubClientFactory = () => ({ getPullRequest: () => Promise.resolve(prDetail({ baseRef: "bad..name" })) });
  const badBase = await run(() =>
    h.service().create(createDto({ repositoryId: 3, sourceType: "github_pr", prNumber: 12, headRef: undefined }))
  );
  assert.equal(badBase.status, 400);
  assert.equal(badBase.error_reason, "validation_failed");
});

test("VisualizationsService.create local_branch defaults baseRef to the repository default and rejects equal branches", async (t) => {
  const h = setup(t);
  const response = await run(() => h.service().create(createDto({})));
  assert.equal(response.status, 202);
  const row = h.store.rows(Table.VISUALIZATIONS)[0];
  assert.equal(row?.baseRef, "main");
  assert.equal(row.headRef, "feature/x");
  assert.equal(row.title, "feature/x → main");

  const equal = await run(() => h.service().create(createDto({ headRef: "main" })));
  assert.deepEqual(equal, { status: 400, error: "Choose two different branches.", error_reason: "validation_failed" });
});

test("VisualizationsService.create local_branch returns 400 when a branch does not exist", async (t) => {
  const h = setup(t);
  const response = await run(() => h.service().create(createDto({ headRef: "feature/missing" })));
  assert.deepEqual(response, {
    status: 400,
    error: 'Branch "feature/missing" does not exist in sample-react-app.',
    error_reason: "validation_failed"
  });
  h.deps.git = {
    ...h.deps.git,
    revParse: () => Promise.reject(gitError("not_a_repository", "fatal: not a git repository\nmore"))
  } as VisualizationsServiceDependencies["git"];
  const broken = await run(() => h.service().create(createDto({})));
  assert.deepEqual(broken, {
    status: 400,
    error: "git failed: fatal: not a git repository",
    error_reason: "not_git_repo"
  });
  h.store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 4, localPath: "/nonexistent/prvision/clone" })]);
  const missing = await run(() => h.service().create(createDto({ repositoryId: 4 })));
  assert.equal(missing.error_reason, "not_git_repo");
  assert.match(String(missing.error), /Repository folder is missing/);
});

test("VisualizationsService.create working_tree returns 400 working_tree_clean when isDirty is false", async (t) => {
  const h = setup(t);
  h.deps.git = {
    revParse: () => Promise.resolve("c".repeat(40)),
    isDirty: () => Promise.resolve(false),
    currentBranch: () => Promise.resolve("main"),
    hasCommit: () => Promise.resolve(true),
    isAncestor: () => Promise.resolve(true)
  };
  const clean = await run(() => h.service().create(createDto({ sourceType: "working_tree", headRef: undefined })));
  assert.deepEqual(clean, {
    status: 400,
    error: "There are no uncommitted changes in sample-react-app.",
    error_reason: "working_tree_clean"
  });

  h.deps.git = { ...h.deps.git, isDirty: () => Promise.resolve(true), currentBranch: () => Promise.resolve(null) };
  const created = await run(() => h.service().create(createDto({ sourceType: "working_tree", headRef: undefined })));
  assert.equal(created.status, 202);
  const row = h.store.rows(Table.VISUALIZATIONS)[0];
  assert.equal(row?.title, "Uncommitted changes (detached HEAD)");
  assert.equal(row.baseRef, "HEAD");
  assert.equal(row.headRef, "working-tree");
  const messages = h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).map((e) => e.message);
  assert.ok(messages.includes("Your uncommitted changes are captured when the worker starts this visualization."));
});

const rangeDto = (body: Partial<VisualizationCreateDTO> = {}): VisualizationCreateDTO =>
  createDto({
    sourceType: "commit_range",
    headRef: "feature/x",
    baseSha: BRANCH_LINE[0],
    headSha: BRANCH_LINE[2],
    ...body
  });

test('VisualizationsService.create commit_range stores both commits, the branch as both refs and the title "<branch>: <base>…<head>"', async (t) => {
  const h = setup(t);
  const response = await run(() => h.service().create(rangeDto()));
  assert.equal(response.status, 202);
  const row = h.store.rows(Table.VISUALIZATIONS)[0];
  assert.equal(row?.sourceType, "commit_range");
  assert.equal(row.baseRef, "feature/x");
  assert.equal(row.headRef, "feature/x");
  assert.equal(row.baseSha, BRANCH_LINE[0]);
  assert.equal(row.headSha, BRANCH_LINE[2]);
  assert.equal(row.prNumber, null);
  assert.equal(row.title, "feature/x: 1111111…ccccccc");

  // Adjacent commits work too; the from commit may be the parent of the to commit.
  const adjacent = await run(() => h.service().create(rangeDto({ baseSha: BRANCH_LINE[1] })));
  assert.equal(adjacent.status, 202);
});

test("VisualizationsService.create commit_range accepts every listed commit with its parentSha as base (00 §16.1), merges included, on real git", async (t) => {
  const repo = await createTempGitRepo({ "a.txt": "a" });
  t.after(() => repo.cleanup());
  await repo.commit("second", { "a.txt": "a2" });
  await repo.git(["checkout", "-q", "-b", "topic"]);
  await repo.commit("topic work", { "t.txt": "t" });
  await repo.git(["checkout", "-q", "-b", "feature/x", "main"]);
  await repo.commit("third", { "c.txt": "c" });
  await repo.git(["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
  await repo.commit("after merge", { "d.txt": "d" });

  const git = new GitClient();
  const h = setup(t, { git });
  h.store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2, localPath: repo.dir })]);
  const listed = await git.logCommits(repo.dir, "feature/x", { limit: 50 });
  assert.deepEqual(
    listed.map((commit) => commit.subject),
    ["after merge", "merge topic", "third", "second", "initial"]
  );
  const merge = listed[1];
  assert.equal(merge?.isMerge, true);
  assert.equal(merge.parentSha, listed[2]?.sha, "a merge's parentSha is its first (main-line) parent");

  for (const commit of listed) {
    if (commit.parentSha === null) {
      assert.equal(commit.subject, "initial", "only the root commit has no parent");
      continue;
    }
    const baseSha = commit.parentSha;
    const response = await run(() => h.service().create(rangeDto({ repositoryId: 2, baseSha, headSha: commit.sha })));
    assert.equal(response.status, 202, `${commit.subject}: ${String(response.error)}`);
  }
  const rows = h.store.rows(Table.VISUALIZATIONS);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.sourceType === "commit_range" && row.headRef === "feature/x"));
});

test("VisualizationsService.create commit_range returns 400 validation_failed with a clear message for each invalid pick", async (t) => {
  const h = setup(t);
  const cases: Array<[Partial<VisualizationCreateDTO>, string]> = [
    [{ headRef: "feature/missing" }, 'Branch "feature/missing" does not exist in sample-react-app.'],
    [{ baseSha: "d".repeat(40) }, "The From commit ddddddd does not exist in sample-react-app."],
    [{ headSha: "e".repeat(40) }, "The To commit eeeeeee does not exist in sample-react-app."],
    [{ baseSha: OFF_BRANCH_SHA }, 'The From commit 9999999 is not on branch "feature/x".'],
    [
      { baseSha: BRANCH_LINE[2], headSha: BRANCH_LINE[0] },
      "The From commit ccccccc is not an ancestor of the To commit 1111111. Pick an older From commit."
    ],
    [{ headSha: BRANCH_LINE[0] }, "Choose two different commits."]
  ];
  for (const [body, error] of cases) {
    const response = await run(() => h.service().create(rangeDto(body)));
    assert.deepEqual(response, { status: 400, error, error_reason: "validation_failed" }, error);
  }
  assert.equal(h.store.rows(Table.VISUALIZATIONS).length, 0, "nothing is inserted for an invalid range");
});

test("VisualizationsService.create commit_range maps a git failure to 400 not_git_repo", async (t) => {
  const h = setup(t);
  h.deps.git = {
    ...h.deps.git,
    isAncestor: () => Promise.reject(gitError("not_a_repository", "fatal: not a git repository"))
  } as VisualizationsServiceDependencies["git"];
  const response = await run(() => h.service().create(rangeDto()));
  assert.deepEqual(response, {
    status: 400,
    error: "git failed: fatal: not a git repository",
    error_reason: "not_git_repo"
  });
});

test("VisualizationsService.create inserts queued with job_id viz-<id> in one transaction, then enqueues and returns 202 { visualizationId, jobId }", async (t) => {
  const h = setup(t);
  const logs = recordLogger();
  t.after(logs.restore);
  const response = await run(() => h.service().create(createDto({})));
  assert.deepEqual(response, { status: 202, data: { visualizationId: 1, jobId: "viz-1" } });
  const row = h.store.rows(Table.VISUALIZATIONS)[0];
  assert.equal(row?.status, "queued");
  assert.equal(row.jobId, "viz-1");
  assert.equal(row.aiProvider, "anthropic_api");
  assert.equal(row.aiModel, "claude-opus-5-5");
  assert.equal(row.componentCount, 0);
  assert.equal(row.changedCount, 0);
  assert.deepEqual(h.queue.enqueued, [1]);
  // Insert + job_id update happen before the enqueue (enqueue after commit).
  const insertIndex = h.store.calls.findIndex((c) => c.method === "insert" && c.table === Table.VISUALIZATIONS);
  const updateIndex = h.store.calls.findIndex((c) => c.method === "update" && c.table === Table.VISUALIZATIONS);
  assert.ok(insertIndex >= 0 && updateIndex > insertIndex);
  assert.deepEqual(
    h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).map((e) => [e.stage, e.message]),
    [["queued", "Queued: feature/x → main"]]
  );
  assert.ok(logs.lines.some((l) => l.event === "visualization.job.queued"));
});

test("VisualizationsService.create rolls back the insert when the job_id update fails", async (t) => {
  const h = setup(t);
  h.store.failNext("update");
  const response = await run(() => h.service().create(createDto({})));
  assert.deepEqual(response, { status: 500, error: "Internal server error", error_reason: "internal_error" });
  assert.equal(h.store.rows(Table.VISUALIZATIONS).length, 0, "insert rolled back");
  assert.deepEqual(h.queue.enqueued, []);
});

test("VisualizationsService.create marks the row failed and returns 500 internal_error when enqueue throws", async (t) => {
  const h = setup(t);
  h.queue.enqueueError = new Error("connect ECONNREFUSED 127.0.0.1:6380");
  const response = await run(() => h.service().create(createDto({})));
  assert.deepEqual(response, {
    status: 500,
    error: "Could not queue the visualization: the job queue (Redis) is unavailable.",
    error_reason: "internal_error"
  });
  const row = h.store.rows(Table.VISUALIZATIONS)[0];
  assert.equal(row?.status, "failed");
  assert.equal(row.failedStage, "queued");
  assert.match(String(row.errorMessage), /Could not queue the job/);
  assert.deepEqual(row.completedAt, NOW);
  const events = h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS);
  assert.equal(events.at(-1)?.level, "error");
  assert.equal(events.at(-1)?.message, "Could not queue the job (Redis unavailable).");
});

// ---------------------------------------------------------------------------------------------------------------
// list / get / console
// ---------------------------------------------------------------------------------------------------------------

test("VisualizationsService.list hides deleted visualizations and those of deleted repositories, filters by repositoryId and a status list, pages, and returns total", async (t) => {
  const h = setup(t);
  h.store.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 2, name: "other", localPath: "/tmp/o" }),
    makeRepositoryRow({ id: 3, name: "gone", localPath: "/tmp/g", isDeleted: true })
  ]);
  const at = (minutes: number): Date => new Date(Date.parse("2026-01-01T00:00:00Z") + minutes * 60_000);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, repositoryId: 1, status: "queued", createdAt: at(1) }),
    makeVisualizationRow({ id: 2, repositoryId: 1, status: "rendering", createdAt: at(2) }),
    makeVisualizationRow({ id: 3, repositoryId: 1, status: "completed", createdAt: at(3), completedAt: at(4) }),
    makeVisualizationRow({ id: 4, repositoryId: 1, status: "queued", createdAt: at(4), isDeleted: true }),
    makeVisualizationRow({ id: 5, repositoryId: 3, status: "queued", createdAt: at(5) }),
    makeVisualizationRow({ id: 6, repositoryId: 2, status: "queued", createdAt: at(2) })
  ]);

  const all = await run(() => h.service().list({}));
  assert.equal(all.status, 200);
  const data = all.data as {
    items: Array<{ id: number; repositoryName: string; completedAt: string | null }>;
    total: number;
    page: number;
    pageSize: number;
  };
  assert.deepEqual(
    data.items.map((i) => i.id),
    [3, 6, 2, 1],
    "newest first, id desc as tie-break; deleted rows and deleted repos hidden"
  );
  assert.equal(data.total, 4);
  assert.deepEqual([data.page, data.pageSize], [1, 20]);
  assert.equal(data.items.find((i) => i.id === 6)?.repositoryName, "other");
  assert.equal(data.items.find((i) => i.id === 3)?.completedAt, at(4).toISOString());

  const filtered = await run(() => h.service().list({ repositoryId: 1, status: ["queued", "rendering"] }));
  assert.deepEqual(
    (filtered.data as typeof data).items.map((i) => i.id),
    [2, 1]
  );
  assert.equal((filtered.data as typeof data).total, 2);

  const paged = await run(() => h.service().list({ page: 2, pageSize: 3 }));
  assert.deepEqual(
    (paged.data as typeof data).items.map((i) => i.id),
    [1]
  );
  assert.equal((paged.data as typeof data).total, 4);

  const unknownRepo = await run(() => h.service().list({ repositoryId: 42 }));
  assert.deepEqual(unknownRepo, { status: 200, data: { items: [], page: 1, pageSize: 20, total: 0 } });
});

test("VisualizationsService.get returns components ordered by rank, then id, with artifact URLs, changeReason, skipReason and failedStage", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 1,
      status: "failed",
      failedStage: "rendering",
      errorMessage: "Vite failed",
      completedAt: new Date("2026-01-01T00:10:00Z"),
      startedAt: new Date("2026-01-01T00:01:00Z"),
      aiUsage: { inputTokens: 10, outputTokens: 5, calls: 1, cacheReadInputTokens: 3 }
    })
  ]);
  h.store.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 1, rank: 1, displayName: "B", renderStatus: "skipped", skipReason: "Over the cap" }),
    makeComponentRow({
      id: 2,
      rank: 0,
      displayName: "A",
      renderStatus: "rendered",
      baseImagePath: "artifacts/1/2/base.png",
      headImagePath: "artifacts/1/2/head.png",
      diffImagePath: "artifacts/1/2/diff.png",
      diffPixelRatio: 0.25,
      visualChange: "changed"
    }),
    makeComponentRow({ id: 3, rank: 1, displayName: "C", filePath: "src/C.tsx" }),
    makeComponentRow({ id: 4, visualizationId: 2, rank: 0, displayName: "other viz" })
  ]);
  const response = await run(() => h.service(1).get());
  assert.equal(response.status, 200);
  const view = response.data as Record<string, unknown> & { components: Array<Record<string, unknown>> };
  assert.deepEqual(
    view.components.map((c) => c.id),
    [2, 1, 3]
  );
  assert.equal(view.failedStage, "rendering");
  assert.equal(view.errorMessage, "Vite failed");
  assert.equal(view.repositoryName, "sample-react-app");
  assert.equal(view.framework, "react_vite");
  assert.deepEqual(view.aiUsage, { inputTokens: 10, outputTokens: 5, calls: 1 });
  assert.equal(view.startedAt, "2026-01-01T00:01:00.000Z");
  const first = view.components[0];
  assert.equal(first?.baseImageUrl, "/artifacts/1/2/base.png");
  assert.equal(first.diffImageUrl, "/artifacts/1/2/diff.png");
  assert.equal(first.diffPixelRatio, 0.25);
  assert.equal(first.changeReason, "Component code changed");
  assert.equal(view.components[1]?.skipReason, "Over the cap");
  assert.equal(view.components[1].baseImageUrl, null);
  assert.ok(first);
  assert.equal("mockedModules" in first, false);
  assert.equal("jobId" in view, false);

  assert.equal((await run(() => h.service(99).get())).status, 404);
});

test("VisualizationsService.get maps a replaced row's base component and successor evidence (00 §17)", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "completed", completedAt: new Date() })]);
  const evidence = [{ kind: "call_site_swap" as const, detail: "src/pages/Notes.tsx: <NoteForm> → <NoteFormModal>" }];
  h.store.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({
      id: 1,
      displayName: "NoteFormModal",
      filePath: "src/components/NoteFormModal.tsx",
      changeKind: "replaced",
      baseFilePath: "src/components/NoteForm.tsx",
      baseExportName: "default",
      baseDisplayName: "NoteForm",
      baseHarnessSource: "base harness",
      baseHarnessNotes: "base notes",
      baseMockedModules: [],
      successorEvidence: evidence
    }),
    makeComponentRow({ id: 2, rank: 1, displayName: "Notes", filePath: "src/pages/Notes.tsx" })
  ]);
  const response = await run(() => h.service(1).get());
  assert.equal(response.status, 200);
  const [replaced, modified] = (response.data as { components: Array<Record<string, unknown>> }).components;
  assert.deepEqual(
    {
      changeKind: replaced?.changeKind,
      baseFilePath: replaced?.baseFilePath,
      baseExportName: replaced?.baseExportName,
      baseDisplayName: replaced?.baseDisplayName,
      successorEvidence: replaced?.successorEvidence
    },
    {
      changeKind: "replaced",
      baseFilePath: "src/components/NoteForm.tsx",
      baseExportName: "default",
      baseDisplayName: "NoteForm",
      successorEvidence: evidence
    }
  );
  assert.equal("baseHarnessSource" in (replaced ?? {}), false, "harness columns are not part of the view");
  assert.deepEqual(
    [modified?.baseFilePath, modified?.baseExportName, modified?.baseDisplayName, modified?.successorEvidence],
    [null, null, null, null]
  );
});

test("VisualizationsService.get carries the repository framework for Angular apps (15 §5.9.1)", async (t) => {
  const h = setup(t);
  h.store.seed(Table.REPOSITORIES, [
    makeRepositoryRow({
      id: 2,
      name: "monorepo · web",
      localPath: "/tmp/prvision-test-repo/monorepo",
      framework: "angular",
      appRoot: "apps/web",
      angularProject: "web",
      angularBuildConfiguration: "development",
      viteConfigPath: null
    })
  ]);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 7, repositoryId: 2 })]);
  const response = await run(() => h.service(7).get());
  assert.equal(response.status, 200);
  const view = response.data as Record<string, unknown>;
  assert.equal(view.framework, "angular");
  assert.equal(view.repositoryName, "monorepo · web");
});

test("VisualizationsService.console returns a bare array of events after afterId (exclusive), ascending, capped at limit", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1 })]);
  h.store.seed(
    Table.VISUALIZATION_CONSOLE_EVENTS,
    [5, 1, 3, 2, 4].map((id) => makeConsoleEventRow({ id, message: `m${id}` }))
  );
  h.store.seed(Table.VISUALIZATION_CONSOLE_EVENTS, [makeConsoleEventRow({ id: 6, visualizationId: 2 })]);
  const all = await run(() => h.service(1).console({}));
  assert.equal(all.status, 200);
  assert.ok(Array.isArray(all.data));
  assert.deepEqual(
    (all.data as Array<{ id: number }>).map((e) => e.id),
    [1, 2, 3, 4, 5]
  );
  const after = await run(() => h.service(1).console({ afterId: 2, limit: 2 }));
  assert.deepEqual(after.data, [
    { id: 3, level: "info", stage: "preparing", message: "m3", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: 4, level: "info", stage: "preparing", message: "m4", createdAt: "2026-01-01T00:00:00.000Z" }
  ]);
  const call = h.store.callsFor("selectMany", Table.VISUALIZATION_CONSOLE_EVENTS).at(0);
  assert.equal((call?.args[2] as { limit: number }).limit, 500, "default limit is CONSOLE_PAGE_LIMIT_MAX");
  assert.equal((await run(() => h.service(42).console({}))).status, 404);
});

// ---------------------------------------------------------------------------------------------------------------
// cancel / remove
// ---------------------------------------------------------------------------------------------------------------

test("VisualizationsService.cancel returns 409 already_terminal for completed, failed and cancelled", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "completed", completedAt: NOW }),
    makeVisualizationRow({ id: 2, status: "failed", completedAt: NOW, failedStage: "rendering" }),
    makeVisualizationRow({ id: 3, status: "cancelled", completedAt: NOW, failedStage: "queued" })
  ]);
  for (const [id, status] of [
    [1, "completed"],
    [2, "failed"],
    [3, "cancelled"]
  ] as const) {
    assert.deepEqual(await run(() => h.service(id).cancel()), {
      status: 409,
      error: `This visualization is already ${status}.`,
      error_reason: "already_terminal"
    });
  }
  assert.equal(h.queue.flags.size, 0, "no flag for terminal rows");
});

test('VisualizationsService.cancel sets the flag, removes the queued job and returns 200 { id, status: "cancelled" }', async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "queued" })]);
  h.queue.jobStates.set(1, "waiting");
  const response = await run(() => h.service(1).cancel());
  assert.deepEqual(response, { status: 200, data: { id: 1, status: "cancelled" } });
  const row = h.store.row(Table.VISUALIZATIONS, 1);
  assert.equal(row?.status, "cancelled");
  assert.equal(row.failedStage, "queued");
  assert.deepEqual(row.completedAt, NOW);
  assert.deepEqual(h.queue.calls.slice(0, 2), ["requestCancel:1", "remove:1"], "flag set before the removal");
  assert.ok(h.queue.calls.includes("clearCancel:1"));
  assert.equal(h.queue.flags.has(1), false);
  assert.equal(
    h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).at(-1)?.message,
    "Cancelled before the worker started."
  );
  assert.equal(h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).at(-1)?.stage, "cancelled");
});

test("VisualizationsService.cancel treats a missing job as removable", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "queued" }),
    makeVisualizationRow({ id: 2, status: "queued" })
  ]);
  const missing = await run(() => h.service(1).cancel());
  assert.deepEqual(missing, { status: 200, data: { id: 1, status: "cancelled" } });
  h.queue.jobStates.set(2, "failed");
  assert.deepEqual(await run(() => h.service(2).cancel()), { status: 200, data: { id: 2, status: "cancelled" } });
});

test('VisualizationsService.cancel returns 202 { id, status: "cancel_requested" } when the job is active, or when the queued→cancelled guard loses', async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "rendering" }),
    makeVisualizationRow({ id: 2, status: "queued" }),
    makeVisualizationRow({ id: 3, status: "queued" })
  ]);
  const running = await run(() => h.service(1).cancel());
  assert.deepEqual(running, { status: 202, data: { id: 1, status: "cancel_requested" } });
  assert.equal(h.queue.flags.has(1), true, "flag stays set for the worker");
  const event = h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).at(-1);
  assert.equal(event?.stage, "rendering");
  assert.equal(event.message, "Cancellation requested. The run stops at the next checkpoint.");

  h.queue.jobStates.set(2, "active");
  assert.deepEqual(await run(() => h.service(2).cancel()), {
    status: 202,
    data: { id: 2, status: "cancel_requested" }
  });
  assert.equal(h.store.row(Table.VISUALIZATIONS, 2)?.status, "queued");

  // The worker moved the row to preparing between the read and the guarded write.
  h.queue.removeResult = true;
  const original = h.store.update.bind(h.store);
  h.store.update = async (values, conditions, table, excluded) => {
    if (table === Table.VISUALIZATIONS && values.status === "cancelled") {
      await original({ status: "preparing" }, { id: 3 }, table);
    }
    return original(values, conditions, table, excluded);
  };
  assert.deepEqual(await run(() => h.service(3).cancel()), {
    status: 202,
    data: { id: 3, status: "cancel_requested" }
  });
  assert.equal(h.store.row(Table.VISUALIZATIONS, 3)?.status, "preparing");
});

test("VisualizationsService.cancel returns 409 already_terminal and clears the flag when the run finished between the first read and the re-read", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "summarizing" })]);
  const originalRequest = h.queue.requestCancel.bind(h.queue);
  h.queue.requestCancel = async (id) => {
    await originalRequest(id);
    await h.store.update({ status: "completed", completedAt: NOW }, { id }, Table.VISUALIZATIONS); // worker finishes
  };
  const response = await run(() => h.service(1).cancel());
  assert.deepEqual(response, {
    status: 409,
    error: "This visualization is already completed.",
    error_reason: "already_terminal"
  });
  assert.equal(h.queue.flags.has(1), false, "stale flag cleared");
});

test("VisualizationsService.remove returns 409 conflict while non-terminal; otherwise soft-deletes (conditioned on a terminal status), removes artifacts and returns 200 { id }", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "rendering" }),
    makeVisualizationRow({ id: 2, status: "completed", completedAt: NOW })
  ]);
  assert.deepEqual(await run(() => h.service(1).remove()), {
    status: 409,
    error: "This visualization is still running. Cancel it and wait until it stops before deleting.",
    error_reason: "conflict"
  });
  assert.equal(h.store.row(Table.VISUALIZATIONS, 1)?.isDeleted, false);

  assert.deepEqual(await run(() => h.service(2).remove()), { status: 200, data: { id: 2 } });
  assert.equal(h.store.row(Table.VISUALIZATIONS, 2)?.isDeleted, true);
  const conditions = h.store.callsFor("delete", Table.VISUALIZATIONS)[0]?.args[0] as Record<string, unknown>;
  assert.deepEqual(conditions.status, { op: "in", values: ["completed", "failed", "cancelled"] });
  assert.deepEqual(h.removedArtifacts, [2]);
  assert.equal((await run(() => h.service(2).remove())).status, 404, "already deleted");
});

test("VisualizationsService.remove returns 200 even when artifact removal throws", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "failed", completedAt: NOW, failedStage: "queued" })
  ]);
  h.deps.artifacts = {
    toPublicUrl: () => null,
    removeVisualization: () => Promise.reject(new Error("EACCES"))
  };
  const logs = recordLogger();
  t.after(logs.restore);
  assert.deepEqual(await run(() => h.service(1).remove()), { status: 200, data: { id: 1 } });
  assert.ok(logs.lines.some((l) => l.event === "visualization.artifacts.remove_failed"));
});

test('VisualizationsService every 500 response is { error: "Internal server error", error_reason: "internal_error" } without exception text', async (t) => {
  const h = setup(t);
  const boom = new Error("SECRET /home/user/path exploded");
  h.deps.db = {
    select: () => {
      throw boom;
    }
  } as unknown as VisualizationsServiceDependencies["db"];
  h.deps.aiReadiness = () => Promise.reject(boom);
  const expected: ApiResponse = { status: 500, error: "Internal server error", error_reason: "internal_error" };
  assert.deepEqual(await run(() => h.service().create(createDto({}))), expected);
  assert.deepEqual(await run(() => h.service().list({})), expected);
  for (const action of ["get", "cancel", "remove"] as const) {
    assert.deepEqual(await run(() => h.service(1)[action]()), expected, action);
  }
  assert.deepEqual(await run(() => h.service(1).console({})), expected);
});

// ---------------------------------------------------------------------------------------------------------------
// 16e (16 §14.5): states, harness status, active repair job, live availability, repair estimate
// ---------------------------------------------------------------------------------------------------------------

test("VisualizationsService.get maps state rows with step summaries and synthesizes Default for legacy rows", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 1,
      status: "completed",
      completedAt: new Date(),
      componentCount: 2,
      checkedCount: 2,
      reusedHarnessCount: 1,
      newHarnessCount: 1
    })
  ]);
  h.store.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({
      id: 1,
      rank: 0,
      displayName: "InvoiceRow",
      renderStatus: "partial",
      stateCount: 2,
      changedStateCount: 1,
      harnessOrigin: "library",
      libraryEntryId: 9,
      harnessNeedsUpdate: true,
      sourceChangedSinceWrite: true
    }),
    makeComponentRow({
      id: 2,
      rank: 1,
      displayName: "Legacy",
      changeKind: "added",
      renderStatus: "rendered",
      visualChange: "new",
      headImagePath: "artifacts/1/2/head.png",
      imageWidth: 100,
      imageHeight: 40
    })
  ]);
  h.store.seed(Table.VISUALIZATION_COMPONENT_STATES, [
    {
      visualizationComponentId: 1,
      visualizationId: 1,
      ordinal: 1,
      stateName: "Menu open",
      onBase: true,
      onHead: true,
      steps: [{ action: "click", target: { by: "role", role: "button", name: "More actions" } }],
      renderStatus: "partial",
      visualChange: null,
      headError: "[step_failed] x",
      headFailureKind: "step_failed",
      baseImagePath: "artifacts/1/1/s1/base.png"
    },
    {
      visualizationComponentId: 1,
      visualizationId: 1,
      ordinal: 0,
      stateName: "Default",
      onBase: true,
      onHead: true,
      renderStatus: "rendered",
      visualChange: "changed",
      diffPixelRatio: 0.1,
      diffImagePath: "artifacts/1/1/diff.png"
    }
  ]);
  const response = await run(() => h.service(1).get());
  assert.equal(response.status, 200);
  const view = response.data as Record<string, unknown> & { components: Array<Record<string, unknown>> };
  assert.equal(view.checkedCount, 2);
  assert.equal(view.reusedHarnessCount, 1);
  assert.equal(view.newHarnessCount, 1);
  const [row, legacy] = view.components as Array<{
    states: Array<Record<string, unknown>>;
    stateCount: number;
    changedStateCount: number;
    harness: Record<string, unknown>;
  }>;
  assert.deepEqual(
    row?.states.map((state) => [state.ordinal, state.name, state.stepSummary, state.baseImageUrl, state.diffImageUrl]),
    [
      [0, "Default", [], null, "/artifacts/1/1/diff.png"],
      [1, "Menu open", ['Click button "More actions"'], "/artifacts/1/1/s1/base.png", null]
    ]
  );
  assert.ok(row);
  assert.equal(row.states[1]?.headError, "[step_failed] x");
  assert.deepEqual([row.stateCount, row.changedStateCount], [2, 1]);
  assert.deepEqual(row.harness, {
    origin: "library",
    baseOrigin: null,
    libraryEntryId: 9,
    baseLibraryEntryId: null,
    needsUpdate: true,
    sourceChangedSinceWrite: true,
    repairing: false
  });
  assert.deepEqual(legacy?.states, [
    {
      ordinal: 0,
      name: "Default",
      onBase: false,
      onHead: true,
      steps: [],
      stepSummary: [],
      renderStatus: "rendered",
      visualChange: "new",
      baseImageUrl: null,
      headImageUrl: "/artifacts/1/2/head.png",
      diffImageUrl: null,
      imageWidth: 100,
      imageHeight: 40,
      diffPixelRatio: null,
      baseError: null,
      headError: null
    }
  ]);
  assert.ok(legacy);
  assert.deepEqual([legacy.stateCount, legacy.changedStateCount], [1, 1]);
});

test("VisualizationsService.get lists the active repair job and marks its components repairing", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "completed", completedAt: new Date() })]);
  h.store.seed(Table.VISUALIZATION_COMPONENTS, [makeComponentRow({ id: 1 }), makeComponentRow({ id: 2, rank: 1 })]);
  h.store.seed(Table.HARNESS_LIBRARY_JOBS, [
    {
      repositoryId: 1,
      kind: "repair",
      status: "completed",
      visualizationId: 1,
      componentIds: [1, 2],
      stateAllowance: 3,
      aiModel: "claude-opus-5-5"
    },
    {
      repositoryId: 1,
      kind: "repair",
      status: "running",
      visualizationId: 1,
      componentIds: [2],
      stateAllowance: 3,
      aiModel: "claude-opus-5-5",
      writtenCount: 0
    }
  ]);
  const view = (await run(() => h.service(1).get())).data as {
    activeRepairJob: Record<string, unknown> | null;
    components: Array<{ id: number; harness: { repairing: boolean } }>;
  };
  const job = view.activeRepairJob;
  assert.ok(job);
  assert.equal(job.kind, "repair");
  assert.deepEqual(job.componentIds, [2]);
  assert.equal(job.repositoryName, "sample-react-app");
  assert.equal(job.priceExact, true);
  assert.equal(job.status, "running");
  assert.deepEqual(
    view.components.map((component) => [component.id, component.harness.repairing]),
    [
      [1, false],
      [2, true]
    ]
  );
});

test("isLiveAvailable: terminal, a harness snapshot, base_sha and a recreatable head", () => {
  const run = {
    status: "completed" as const,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    sourceType: "local_branch" as const,
    workingTreeSnapshot: false
  };
  const withHarness = [{ harnessSource: "export default 1;" }];
  assert.equal(isLiveAvailable(run, withHarness), true);
  assert.equal(isLiveAvailable({ ...run, status: "rendering" }, withHarness), false, "not terminal");
  assert.equal(isLiveAvailable({ ...run, status: "failed" }, withHarness), true, "failed runs are terminal");
  assert.equal(isLiveAvailable(run, [{ harnessSource: null }]), false, "no harness");
  assert.equal(isLiveAvailable({ ...run, baseSha: null }, withHarness), false, "no base commit");
  assert.equal(isLiveAvailable({ ...run, headSha: null }, withHarness), false, "no head commit");
  const workingTree = { ...run, sourceType: "working_tree" as const, headSha: null };
  assert.equal(isLiveAvailable(workingTree, withHarness), false, "no snapshot");
  assert.equal(isLiveAvailable({ ...workingTree, workingTreeSnapshot: true }, withHarness), true);
});

test("VisualizationsService.get: repairEstimateUsd at allowance 1 and 3; null without broken rows or AI settings", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "completed", completedAt: new Date(), needsUpdateCount: 2 }),
    makeVisualizationRow({ id: 2, status: "completed", completedAt: new Date(), needsUpdateCount: 0 })
  ]);
  const estimate = async (id: number): Promise<unknown> =>
    ((await run(() => h.service(id).get())).data as { repairEstimateUsd: unknown }).repairEstimateUsd;
  // claude-opus-5-5, default usage (26 000 in incl. 4 500 cache reads, 9 000 out): 0.2669 per harness.
  await h.store.update({ stateAllowance: 1 }, { id: 1 }, Table.REPOSITORIES);
  assert.equal(await estimate(1), 0.53);
  // allowance 3: +3 000 output tokens × $20/MTok = +0.06 per harness → 0.3269 × 2
  await h.store.update({ stateAllowance: 3 }, { id: 1 }, Table.REPOSITORIES);
  assert.equal(await estimate(1), 0.65);
  assert.equal(await estimate(2), null, "nothing needs updating");
  const noAi = setup(t, {
    aiReadiness: () => Promise.resolve({ ready: false, reason: "ai_not_configured", message: "No key" })
  });
  noAi.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "completed", completedAt: new Date(), needsUpdateCount: 2 })
  ]);
  assert.equal(
    ((await run(() => noAi.service(1).get())).data as { repairEstimateUsd: unknown }).repairEstimateUsd,
    null
  );
});

test("VisualizationsService.list carries checkedCount", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, componentCount: 6, checkedCount: 5 })]);
  const response = await run(() => h.service().list({}));
  const items = (response.data as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items[0]?.checkedCount, 5);
});

// ---- 16d blocks: continue wording (E12) and the working-tree snapshot deleted with the run (16 §11.2) ----

test("VisualizationsService.continueRun words the limit as new harnesses (16 E12)", async (t) => {
  const h = setup(t);
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "awaiting_confirmation" })]);
  const response = await run(() => h.service(1).continueRun(20));
  assert.equal(response.status, 202);
  const messages = h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).map((row) => row.message);
  assert.ok(messages.includes("Continuing: writing up to 20 new harnesses."), messages.join("\n"));
  assert.equal(h.store.row(Table.VISUALIZATIONS, 1)?.componentLimit, 20);
});

test("VisualizationsService.remove deletes the run's working-tree snapshot folder, best effort", async (t) => {
  const removed: number[] = [];
  const h = setup(t, {
    removeWorkingTreeSnapshot: (id) => {
      removed.push(id);
      return Promise.resolve();
    }
  });
  h.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1, status: "rendering" }),
    makeVisualizationRow({ id: 2, status: "completed", completedAt: NOW })
  ]);
  assert.equal((await run(() => h.service(1).remove())).status, 409);
  assert.deepEqual(removed, [], "nothing is removed while the run is active");
  assert.deepEqual(await run(() => h.service(2).remove()), { status: 200, data: { id: 2 } });
  assert.deepEqual(removed, [2]);

  const failing = setup(t, { removeWorkingTreeSnapshot: () => Promise.reject(new Error("EACCES")) });
  failing.store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 3, status: "failed", completedAt: NOW, failedStage: "queued" })
  ]);
  const logs = recordLogger();
  t.after(logs.restore);
  assert.deepEqual(await run(() => failing.service(3).remove()), { status: 200, data: { id: 3 } });
  assert.ok(logs.lines.some((line) => line.event === "visualization.snapshot.remove_failed"));
});

test("VisualizationsService.remove's default snapshot removal deletes <dataDir>/snapshots/<id>/", async (t) => {
  const h = setup(t);
  const dir = path.join(DATA_DIR, "snapshots", "424242");
  fs.mkdirSync(path.join(dir, "untracked"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  h.store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 424242, status: "completed", completedAt: NOW })]);
  assert.equal((await run(() => h.service(424242).remove())).status, 200);
  assert.equal(fs.existsSync(dir), false);
});
