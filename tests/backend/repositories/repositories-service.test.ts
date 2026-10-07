import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DeletionMode, ERROR_REASON_VALUES, Table } from "../../../backend/src/enums";
import type { LibraryJobView } from "../../../backend/src/dtos";
import { RepositoryModel } from "../../../backend/src/models";
import type {
  DetectedProject,
  DetectionResult
} from "../../../backend/src/services/repositories/project-detection-service";
import {
  RepositoriesService,
  type RepositoriesServiceDependencies
} from "../../../backend/src/services/repositories/repositories-service";
import type { SecretRead } from "../../../backend/src/services/settings/settings-store";
import type { ApiResponse } from "../../../backend/src/utilities/handlers/response-handler";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { GitCommandError, type GitCommitEntry } from "../../../backend/src/utilities/services/git-client";
import { GitHubClient, GitHubClientError } from "../../../backend/src/utilities/services/github-client";
import { idModel, makeLibraryJobRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { createFakeGithubPort, rawPull } from "../helpers/fake-github-port";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { runWithAuthContext } from "../helpers/test-context";
import { fakeGit, type FakeGitState } from "./helpers/detection-fixture";

const NOW = new Date("2026-03-04T05:06:07.000Z");
const TOKEN = "ghp_service_test_token_0123456789";

function project(overrides: Partial<DetectedProject> = {}): DetectedProject {
  return {
    rootPath: "/srv/repos/web-app",
    suggestedName: "web-app",
    githubOwner: "acme",
    githubRepo: "web-app",
    githubRemoteName: "origin",
    defaultBranch: "main",
    framework: "react_vite",
    packageManager: "pnpm",
    appRoot: ".",
    angularProject: null,
    angularBuildConfiguration: null,
    viteConfigPath: "vite.config.ts",
    tsconfigPath: "tsconfig.app.json",
    entryFilePath: "src/main.tsx",
    globalStylePaths: ["/src/index.css"],
    warnings: [],
    ...overrides
  };
}

interface Harness {
  stub: InMemoryQueryHandler;
  detectCalls: string[];
  service(payload?: RepositoryModel, deps?: Partial<RepositoriesServiceDependencies>): RepositoriesService;
}

function harness(
  options: { detection?: DetectionResult; git?: Partial<FakeGitState>; token?: SecretRead } = {}
): Harness {
  const stub = new InMemoryQueryHandler();
  const detectCalls: string[] = [];
  const defaults: Partial<RepositoriesServiceDependencies> = {
    queryHandler: stub as unknown as QueryHandler,
    detector: {
      detect: (inputPath: string) => {
        detectCalls.push(inputPath);
        return Promise.resolve(options.detection ?? { ok: true, project: project() });
      }
    },
    git: fakeGit(options.git),
    readGithubToken: () => Promise.resolve(options.token ?? { state: "present", value: TOKEN }),
    githubClientFactory: () => {
      throw new Error("githubClientFactory not stubbed");
    },
    now: () => NOW
  };
  return {
    stub,
    detectCalls,
    service: (payload = new RepositoryModel(), deps = {}) => new RepositoriesService(payload, { ...defaults, ...deps })
  };
}

function createPayload(localPath: string, name?: string): RepositoryModel {
  const model = new RepositoryModel();
  model.setLocalPath(localPath);
  if (name !== undefined) {
    model.setName(name);
  }
  return model;
}

async function existingFolder(t: TestContext): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-repo-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const call = <T>(fn: () => Promise<T>): Promise<T> => runWithAuthContext(fn);

test("create inserts detected fields and returns 201 with RepositoryView", async () => {
  const h = harness({ detection: { ok: true, project: project({ warnings: ["No vite.config found"] }) } });
  const response = await call(() => h.service(createPayload("/srv/repos/web-app/")).create());
  assert.equal(response.status, 201);
  assert.deepEqual(h.detectCalls, ["/srv/repos/web-app/"]);
  assert.deepEqual(response.data, {
    id: 1,
    name: "web-app",
    localPath: "/srv/repos/web-app",
    githubOwner: "acme",
    githubRepo: "web-app",
    defaultBranch: "main",
    framework: "react_vite",
    packageManager: "pnpm",
    appRoot: ".",
    angularProject: null,
    angularBuildConfiguration: null,
    viteConfigPath: "vite.config.ts",
    tsconfigPath: "tsconfig.app.json",
    entryFilePath: "src/main.tsx",
    globalStylePaths: ["/src/index.css"],
    lastDetectedAt: NOW.toISOString(),
    createdAt: "2026-01-01T00:00:00.000Z",
    renderViewport: "desktop",
    libraryBuildMode: "grow",
    stateAllowance: 3,
    scanJobId: null,
    scanStartError: null
  });
  const row = h.stub.row(Table.REPOSITORIES, 1);
  assert.equal(row?.isDeleted, false);
  assert.deepEqual(row.lastDetectedAt, NOW);
});

test("create uses the name override when provided", async () => {
  const h = harness();
  const response = await call(() => h.service(createPayload("/srv/repos/web-app", "My Web App")).create());
  assert.equal(response.status, 201);
  assert.equal(response.data?.name, "My Web App");
});

test("create returns the detection failure status and error_reason unchanged", async () => {
  const h = harness({
    detection: {
      ok: false,
      failure: { status: 400, errorReason: "missing_node_modules", message: "node_modules not found." }
    }
  });
  const response = await call(() => h.service(createPayload("/srv/x")).create());
  assert.deepEqual(response, { status: 400, error: "node_modules not found.", error_reason: "missing_node_modules" });
  assert.equal(h.stub.callsFor("insert").length, 0);
});

test("create returns 409 conflict when a non-deleted row has the same path", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 4, name: "Existing", localPath: "/srv/repos/web-app" })]);
  const response = await call(() => h.service(createPayload("/srv/repos/link")).create());
  assert.deepEqual(response, {
    status: 409,
    error: 'This folder is already registered as "Existing" (id 4)',
    error_reason: "conflict"
  });
  assert.equal(h.stub.callsFor("insert").length, 0);
});

test("create inserts a new row when only a soft-deleted row has the same path", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 4, localPath: "/srv/repos/web-app", isDeleted: true })]);
  const response = await call(() => h.service(createPayload("/srv/repos/web-app")).create());
  assert.equal(response.status, 201);
  assert.equal(response.data?.id, 5);
  assert.equal(h.stub.row(Table.REPOSITORIES, 4)?.isDeleted, true, "the old row is never revived");
});

test("create maps a unique-violation insert (409) to 409 conflict without the constraint text", async () => {
  const h = harness();
  h.stub.failNext("insert", {
    status: 409,
    error: "Duplicate record (repositories_local_path_active_key)",
    error_reason: "conflict"
  });
  const response = await call(() => h.service(createPayload("/srv/repos/web-app")).create());
  assert.deepEqual(response, { status: 409, error: "This folder is already registered", error_reason: "conflict" });
  h.stub.failNext("insert");
  const failed = await call(() => h.service(createPayload("/srv/repos/web-app")).create());
  assert.deepEqual(failed, { status: 500, error: "Repository could not be saved", error_reason: "internal_error" });
});

test("get returns 404 not_found for an unknown or deleted id", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 1 }),
    makeRepositoryRow({ id: 2, localPath: "/x/y", isDeleted: true })
  ]);
  const found = await call(() => h.service(idModel(1)).get());
  assert.equal(found.status, 200);
  assert.equal(found.data?.id, 1);
  for (const id of [2, 99]) {
    assert.deepEqual(await call(() => h.service(idModel(id)).get()), {
      status: 404,
      error: "Repository not found",
      error_reason: "not_found"
    });
  }
});

test("list returns views ordered by name", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 1, name: "zeta", localPath: "/r/1" }),
    makeRepositoryRow({ id: 2, name: "alpha", localPath: "/r/2" }),
    makeRepositoryRow({ id: 3, name: "deleted", localPath: "/r/3", isDeleted: true }),
    makeRepositoryRow({ id: 4, name: "alpha", localPath: "/r/4" })
  ]);
  const response = await call(() => h.service().list());
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.data?.map((view) => [view.id, view.name]),
    [
      [2, "alpha"],
      [4, "alpha"],
      [1, "zeta"]
    ]
  );
  assert.ok(Array.isArray(response.data), "array, not paged");
});

test("redetect updates detected fields and keeps the name", async () => {
  const h = harness({
    detection: {
      ok: true,
      project: project({
        rootPath: "/srv/repos/web-app",
        suggestedName: "renamed-in-package-json",
        packageManager: "yarn"
      })
    }
  });
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 3, name: "User Name", localPath: "/srv/repos/web-app", packageManager: "npm" })
  ]);
  const response = await call(() => h.service(idModel(3)).redetect());
  assert.equal(response.status, 200);
  assert.deepEqual(h.detectCalls, ["/srv/repos/web-app"]);
  assert.equal(response.data?.name, "User Name");
  assert.equal(response.data.packageManager, "yarn");
  assert.equal(response.data.githubOwner, "acme");
  assert.equal(response.data.lastDetectedAt, NOW.toISOString());
});

test("redetect returns 409 when the folder now resolves to another registered path", async () => {
  const h = harness({ detection: { ok: true, project: project({ rootPath: "/srv/repos/other" }) } });
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 1, localPath: "/srv/repos/link" }),
    makeRepositoryRow({ id: 2, localPath: "/srv/repos/other" })
  ]);
  const response = await call(() => h.service(idModel(1)).redetect());
  assert.equal(response.status, 409);
  assert.equal(response.error_reason, "conflict");
  assert.equal(h.stub.row(Table.REPOSITORIES, 1)?.localPath, "/srv/repos/link");
});

test("redetect leaves the row unchanged when detection fails", async () => {
  const h = harness({
    detection: {
      ok: false,
      failure: { status: 400, errorReason: "not_git_repo", message: "Not a git repository: /srv/x" }
    }
  });
  const seeded = makeRepositoryRow({ id: 3, localPath: "/srv/x" });
  h.stub.seed(Table.REPOSITORIES, [seeded]);
  const response = await call(() => h.service(idModel(3)).redetect());
  assert.deepEqual(response, { status: 400, error: "Not a git repository: /srv/x", error_reason: "not_git_repo" });
  assert.equal(h.stub.callsFor("update").length, 0);
  assert.deepEqual(h.stub.row(Table.REPOSITORIES, 3), seeded);
  assert.equal((await call(() => h.service(idModel(77)).redetect())).status, 404);
});

test("remove returns 409 conflict while a visualization is non-terminal", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  h.stub.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, repositoryId: 1, status: "rendering" })]);
  const response = await call(() => h.service(idModel(1)).remove());
  assert.deepEqual(response, {
    status: 409,
    error: "This repository has visualizations queued or in progress. Cancel them first.",
    error_reason: "conflict"
  });
  assert.equal(h.stub.row(Table.REPOSITORIES, 1)?.isDeleted, false);
});

test("remove counts active visualizations with Where.notIn(terminal statuses)", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  await call(() => h.service(idModel(1)).remove());
  const [countCall] = h.stub.callsFor("count", Table.VISUALIZATIONS);
  assert.deepEqual(countCall?.args, [
    { repositoryId: 1, status: { op: "notIn", values: ["completed", "failed", "cancelled"] } }
  ]);
});

test("remove soft-deletes only the repository row and returns 200 { id }", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 }), makeRepositoryRow({ id: 2, localPath: "/r/2" })]);
  const response = await call(() => h.service(idModel(1)).remove());
  assert.deepEqual(response, { status: 200, data: { id: 1 } });
  const [deleteCall] = h.stub.callsFor("delete");
  assert.deepEqual(deleteCall?.args, [{ id: 1 }, DeletionMode.SOFT]);
  assert.equal(h.stub.row(Table.REPOSITORIES, 1)?.isDeleted, true);
  assert.equal(h.stub.row(Table.REPOSITORIES, 2)?.isDeleted, false);
  assert.equal((await call(() => h.service(idModel(1)).remove())).status, 404, "already removed");
});

test("remove does not modify visualizations of the repository", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  const finished = [
    makeVisualizationRow({
      id: 1,
      repositoryId: 1,
      status: "completed",
      completedAt: new Date("2026-01-02T00:00:00Z")
    }),
    makeVisualizationRow({ id: 2, repositoryId: 1, status: "failed", completedAt: new Date("2026-01-02T00:00:00Z") })
  ];
  h.stub.seed(Table.VISUALIZATIONS, finished);
  const before = h.stub.rows(Table.VISUALIZATIONS);
  assert.equal((await call(() => h.service(idModel(1)).remove())).status, 200);
  assert.deepEqual(h.stub.rows(Table.VISUALIZATIONS), before);
  assert.equal(h.stub.callsFor("update").length + h.stub.callsFor("delete", Table.VISUALIZATIONS).length, 0);
});

test("listPullRequests returns 400 no_github_remote without owner/repo", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, githubOwner: null, githubRepo: null })]);
  assert.deepEqual(await call(() => h.service(idModel(1)).listPullRequests()), {
    status: 400,
    error: "This repository has no github.com remote (checked upstream and origin)",
    error_reason: "no_github_remote"
  });
});

test("listPullRequests returns 400 github_token_missing without a token", async () => {
  const h = harness({ token: { state: "absent" } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, githubOwner: "acme", githubRepo: "web" })]);
  assert.deepEqual(await call(() => h.service(idModel(1)).listPullRequests()), {
    status: 400,
    error: "Add a GitHub token in Settings to list pull requests.",
    error_reason: "github_token_missing"
  });
});

test("listPullRequests returns 400 github_token_missing with the decrypt message when the token is unreadable", async () => {
  const h = harness({ token: { state: "unreadable" } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, githubOwner: "acme", githubRepo: "web" })]);
  const response = await call(() => h.service(idModel(1)).listPullRequests());
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "github_token_missing");
  assert.equal(
    response.error,
    "The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again in Settings."
  );
});

test("listPullRequests maps GitHubClientError unauthorized to 400 github_unauthorized, rate_limited to 429 github_rate_limited, unavailable to 502 github_unavailable", async () => {
  const rows: Array<[GitHubClientError, number, string]> = [
    [new GitHubClientError("x", "unauthorized", 401, null, null), 400, "github_unauthorized"],
    [new GitHubClientError("x", "rate_limited", 403, 90, null), 429, "github_rate_limited"],
    [new GitHubClientError("x", "unavailable", null, null, null), 502, "github_unavailable"],
    [new GitHubClientError("x", "not_found", 404, null, null), 400, "github_unauthorized"]
  ];
  for (const [error, status, reason] of rows) {
    const h = harness();
    h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, githubOwner: "acme", githubRepo: "web" })]);
    const tokens: string[] = [];
    const response = await call(() =>
      h
        .service(idModel(1), {
          githubClientFactory: (token) => {
            tokens.push(token);
            return { listOpenPullRequests: () => Promise.reject(error) };
          }
        })
        .listPullRequests()
    );
    assert.equal(response.status, status, error.kind);
    assert.equal(response.error_reason, reason);
    assert.deepEqual(tokens, [TOKEN]);
    assert.ok(!JSON.stringify(response).includes(TOKEN));
  }
});

test("listPullRequests returns PullRequestView[]", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, githubOwner: "acme", githubRepo: "web" })]);
  const fake = createFakeGithubPort({
    pulls: [rawPull({ number: 7 }), rawPull({ number: 8, user: null, draft: true })]
  });
  const response = await call(() =>
    h.service(idModel(1), { githubClientFactory: () => new GitHubClient(fake.port) }).listPullRequests()
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, [
    {
      number: 7,
      title: "Restyle button",
      author: "octocat",
      headRef: "feature/button-restyle",
      baseRef: "main",
      updatedAt: "2026-01-02T10:00:00Z",
      draft: false,
      url: "https://github.com/acme/web/pull/7"
    },
    {
      number: 8,
      title: "Restyle button",
      author: "ghost",
      headRef: "feature/button-restyle",
      baseRef: "main",
      updatedAt: "2026-01-02T10:00:00Z",
      draft: true,
      url: "https://github.com/acme/web/pull/7"
    }
  ]);
  assert.deepEqual([fake.calls[0]?.args.owner, fake.calls[0]?.args.repo], ["acme", "web"]);
});

test("listBranches returns branches, current, default and the isDirty flag", async (t) => {
  const folder = await existingFolder(t);
  const h = harness({ git: { branches: ["feature/a", "main", "dev"], current: "feature/a", dirty: true } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder, defaultBranch: "main" })]);
  assert.deepEqual(await call(() => h.service(idModel(1)).listBranches()), {
    status: 200,
    data: {
      current: "feature/a",
      branches: ["feature/a", "main", "dev"],
      defaultBranch: "main",
      workingTreeDirty: true
    }
  });
  const detached = harness({ git: { branches: ["main"], current: null, dirty: false } });
  detached.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder })]);
  const response = await call(() => detached.service(idModel(1)).listBranches());
  assert.equal(response.data?.current, null);
  assert.equal(response.data.workingTreeDirty, false);
});

test("listBranches includes the current and default branches after truncation", async (t) => {
  const folder = await existingFolder(t);
  const many = Array.from({ length: 600 }, (_, index) => `branch-${String(index).padStart(3, "0")}`);
  const h = harness({ git: { branches: [...many, "main"], current: "branch-599" } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder, defaultBranch: "main" })]);
  const response = await call(() => h.service(idModel(1)).listBranches());
  const branches = response.data?.branches ?? [];
  assert.equal(branches.length, 502);
  assert.ok(branches.includes("main"));
  assert.ok(branches.includes("branch-599"));
  assert.deepEqual(branches.slice(2, 4), ["branch-000", "branch-001"]);
});

test("listBranches returns 400 not_git_repo when the folder is missing", async (t) => {
  const folder = await existingFolder(t);
  const missing = path.join(folder, "gone");
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: missing })]);
  assert.deepEqual(await call(() => h.service(idModel(1)).listBranches()), {
    status: 400,
    error: `Repository folder is missing: ${missing}. Restore it or remove the repository.`,
    error_reason: "not_git_repo"
  });

  const broken = harness({
    git: {
      branchError: new GitCommandError(
        "git for-each-ref failed",
        "not_a_repository",
        "for-each-ref",
        128,
        "fatal: not a git repository\nmore"
      )
    }
  });
  broken.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder })]);
  assert.deepEqual(await call(() => broken.service(idModel(1)).listBranches()), {
    status: 400,
    error: "git failed: fatal: not a git repository",
    error_reason: "not_git_repo"
  });
});

/** A first-parent history of `count` commits, newest first, with distinct shas and dates; the last is a root. */
function history(count: number, prefix = "b"): GitCommitEntry[] {
  const shaOf = (n: number): string => `${prefix}${String(n).padStart(39, "0")}`;
  return Array.from({ length: count }, (_, index) => ({
    sha: shaOf(count - index),
    parentSha: count - index > 1 ? shaOf(count - index - 1) : null,
    isMerge: false,
    subject: `commit ${String(count - index)}`,
    authorName: "Ada Lovelace",
    committedAt: new Date(Date.UTC(2026, 0, 1, 0, count - index)).toISOString().replace("Z", "+00:00")
  }));
}

test("listCommits returns the branch's commits newest first as CommitView (shortSha, UTC ISO date), default limit 50", async (t) => {
  const folder = await existingFolder(t);
  const commits = history(60);
  const h = harness({ git: { branches: ["main", "feature/x"], history: { "feature/x": commits } } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder })]);
  const response = await call(() => h.service(idModel(1)).listCommits({ branch: "feature/x" }));
  assert.equal(response.status, 200);
  const data = response.data ?? [];
  assert.equal(data.length, 50);
  assert.deepEqual(data[0], {
    sha: commits[0]?.sha,
    parentSha: commits[1]?.sha,
    isMerge: false,
    shortSha: commits[0]?.sha.slice(0, 7),
    subject: "commit 60",
    authorName: "Ada Lovelace",
    committedAt: "2026-01-01T01:00:00.000Z"
  });

  const limited = await call(() => h.service(idModel(1)).listCommits({ branch: "feature/x", limit: 5 }));
  assert.deepEqual(
    limited.data?.map((commit) => commit.subject),
    ["commit 60", "commit 59", "commit 58", "commit 57", "commit 56"]
  );

  const tail = await call(() =>
    h.service(idModel(1)).listCommits({ branch: "feature/x", before: commits[57]?.sha ?? "" })
  );
  assert.deepEqual(
    tail.data?.map((commit) => [commit.subject, commit.parentSha]),
    [
      ["commit 2", commits[59]?.sha],
      ["commit 1", null]
    ],
    "parentSha is the first parent, null for the root commit"
  );
});

test("listCommits with q returns a SHA match first, then message and author matches newest first", async (t) => {
  const folder = await existingFolder(t);
  const commits = history(6).map((commit, index) =>
    index === 1
      ? { ...commit, subject: "feat: grouped sidebar" }
      : index === 4
        ? { ...commit, authorName: "Sidebar Sam" }
        : commit
  );
  const h = harness({ git: { branches: ["main"], history: { main: commits } } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder })]);

  const byText = await call(() => h.service(idModel(1)).listCommits({ branch: "main", q: "SIDEBAR" }));
  assert.deepEqual(
    byText.data?.map((commit) => commit.sha),
    [commits[1]?.sha, commits[4]?.sha],
    "case-insensitive message and author matches, newest first"
  );

  const target = commits[3]?.sha ?? "";
  const bySha = await call(() => h.service(idModel(1)).listCommits({ branch: "main", q: target }));
  assert.deepEqual(
    bySha.data?.map((commit) => commit.sha),
    [target]
  );

  assert.deepEqual(await call(() => h.service(idModel(1)).listCommits({ branch: "main", q: "no-such-text" })), {
    status: 200,
    data: []
  });
});

test("listCommits pages with before (exclusive) and rejects a before that is not on the branch", async (t) => {
  const folder = await existingFolder(t);
  const commits = history(10);
  const other = history(3, "c");
  const h = harness({ git: { branches: ["main", "feature/x"], history: { "feature/x": commits, main: other } } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder })]);
  const before = commits[3]?.sha ?? "";
  const page = await call(() => h.service(idModel(1)).listCommits({ branch: "feature/x", before, limit: 3 }));
  assert.deepEqual(
    page.data?.map((commit) => commit.subject),
    ["commit 6", "commit 5", "commit 4"]
  );
  const last = await call(() =>
    h.service(idModel(1)).listCommits({ branch: "feature/x", before: commits[9]?.sha ?? "" })
  );
  assert.deepEqual(last, { status: 200, data: [] });

  const foreign = other[0]?.sha ?? "";
  assert.deepEqual(await call(() => h.service(idModel(1)).listCommits({ branch: "feature/x", before: foreign })), {
    status: 400,
    error: `Commit ${foreign.slice(0, 7)} is not on branch "feature/x".`,
    error_reason: "validation_failed"
  });
  const unknown = "d".repeat(40);
  const missing = await call(() => h.service(idModel(1)).listCommits({ branch: "feature/x", before: unknown }));
  assert.equal(missing.error_reason, "validation_failed");
});

test("listCommits returns 400 validation_failed for an unknown branch, 400 not_git_repo for a missing folder, 404 for an unknown repository", async (t) => {
  const folder = await existingFolder(t);
  const h = harness({ git: { branches: ["main"] } });
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 1, localPath: folder }),
    makeRepositoryRow({ id: 2, localPath: path.join(folder, "gone") })
  ]);
  assert.deepEqual(await call(() => h.service(idModel(1)).listCommits({ branch: "feature/missing" })), {
    status: 400,
    error: 'Branch "feature/missing" does not exist in sample-react-app.',
    error_reason: "validation_failed"
  });
  const gone = await call(() => h.service(idModel(2)).listCommits({ branch: "main" }));
  assert.equal(gone.error_reason, "not_git_repo");
  assert.match(String(gone.error), /Repository folder is missing/);
  const notFound = await call(() => h.service(idModel(9)).listCommits({ branch: "main" }));
  assert.deepEqual(notFound, { status: 404, error: "Repository not found", error_reason: "not_found" });
});

test("listCommits maps a git failure to 400 not_git_repo with the first stderr line and an unexpected error to 500", async (t) => {
  const folder = await existingFolder(t);
  const h = harness({ git: { branches: ["main"], history: { main: history(2) } } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder })]);
  const failing: Partial<RepositoriesServiceDependencies> = {
    git: {
      ...fakeGit({ branches: ["main"], history: { main: history(2) } }),
      logCommits: () =>
        Promise.reject(new GitCommandError("git log failed", "command_failed", "log", 128, "fatal: bad object\nmore"))
    }
  };
  assert.deepEqual(await call(() => h.service(idModel(1), failing).listCommits({ branch: "main" })), {
    status: 400,
    error: "git failed: fatal: bad object",
    error_reason: "not_git_repo"
  });
  h.stub.failNext("validateAndSelect", new Error("db down"));
  assert.deepEqual(await call(() => h.service(idModel(1)).listCommits({ branch: "main" })), {
    status: 500,
    error: "Internal server error",
    error_reason: "internal_error"
  });
});

test("unexpected failures return 500 internal_error and every error response carries a known error_reason", async (t) => {
  const folder = await existingFolder(t);
  const responses: ApiResponse[] = [];
  for (const method of ["get", "list", "create", "redetect", "remove", "listPullRequests", "listBranches"] as const) {
    const h = harness();
    h.stub.failNext(
      method === "list" ? "selectMany" : method === "create" ? "select" : "validateAndSelect",
      new Error("db down")
    );
    const service = h.service(method === "create" ? createPayload("/srv/x") : idModel(1));
    const response = await call((): Promise<ApiResponse> => service[method]());
    assert.deepEqual(response, { status: 500, error: "Internal server error", error_reason: "internal_error" }, method);
    responses.push(response);
  }
  // Collect the expected-failure paths exercised above once more and check their reasons.
  const h = harness({ token: { state: "absent" } });
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: folder, githubOwner: "a", githubRepo: "b" })]);
  responses.push(await call(() => h.service(idModel(9)).get()));
  responses.push(await call(() => h.service(idModel(1)).listPullRequests()));
  for (const response of responses) {
    assert.ok(response.error_reason && ERROR_REASON_VALUES.includes(response.error_reason), JSON.stringify(response));
  }
});

test("remove deletes the working-tree snapshot folders of the repository's runs (soft-deleted runs too), best effort (16 §11.2)", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 }), makeRepositoryRow({ id: 2, localPath: "/r/2" })]);
  const done = new Date("2026-01-02T00:00:00Z");
  h.stub.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 3,
      repositoryId: 1,
      sourceType: "working_tree",
      prNumber: null,
      status: "completed",
      completedAt: done
    }),
    makeVisualizationRow({
      id: 4,
      repositoryId: 1,
      sourceType: "working_tree",
      prNumber: null,
      status: "failed",
      completedAt: done,
      isDeleted: true
    }),
    makeVisualizationRow({
      id: 5,
      repositoryId: 1,
      sourceType: "local_branch",
      prNumber: null,
      status: "completed",
      completedAt: done
    }),
    makeVisualizationRow({
      id: 6,
      repositoryId: 2,
      sourceType: "working_tree",
      prNumber: null,
      status: "completed",
      completedAt: done
    })
  ]);
  const removed: number[] = [];
  const response = await call(() =>
    h
      .service(idModel(1), {
        removeWorkingTreeSnapshot: (id) => {
          removed.push(id);
          return id === 3 ? Promise.reject(new Error("EACCES")) : Promise.resolve();
        }
      })
      .remove()
  );
  assert.deepEqual(response, { status: 200, data: { id: 1 } });
  assert.deepEqual(
    removed.sort(),
    [3, 4],
    "only working-tree runs of this repository; a failure does not stop the rest"
  );
});

// ----- 16f block (16 §14.2, §10.1): library build mode, state allowance, scan on create, remove guard -----

function libraryJobView(id: number): LibraryJobView {
  return {
    id,
    repositoryId: 1,
    repositoryName: "web-app",
    kind: "scan",
    status: "queued",
    visualizationId: null,
    componentIds: null,
    stateAllowance: 4,
    spendCapUsd: 20,
    spentUsd: 0,
    priceExact: true,
    totalCount: 0,
    writtenCount: 0,
    failedCount: 0,
    skippedCount: 0,
    processedCount: 0,
    currentLabel: null,
    scanSha: null,
    aiModel: "claude-opus-5-5",
    errorMessage: null,
    createdAt: NOW.toISOString(),
    startedAt: null,
    completedAt: null
  };
}

test("create with libraryBuildMode scan stores the choices and starts the scan with the cap (16 §10.1)", async () => {
  const h = harness();
  const started: Array<[number, unknown]> = [];
  const payload = createPayload("/srv/repos/web-app");
  payload.setLibraryBuildMode("scan");
  payload.setStateAllowance(4);
  const response = await call(() =>
    h
      .service(payload, {
        startScan: (id, input) => {
          started.push([id, input]);
          return Promise.resolve({ status: 202, data: libraryJobView(9) });
        }
      })
      .create({ scanSpendCapUsd: 20 })
  );
  assert.equal(response.status, 201);
  assert.equal(response.data?.scanJobId, 9);
  assert.equal(response.data.scanStartError, null);
  assert.equal(response.data.libraryBuildMode, "scan");
  assert.equal(response.data.stateAllowance, 4);
  assert.deepEqual(started, [[1, { kind: "scan", spendCapUsd: 20 }]]);
  const row = h.stub.row(Table.REPOSITORIES, 1);
  assert.equal(row?.libraryBuildMode, "scan");
  assert.equal(row.stateAllowance, 4);
});

test("create with scan answers 201 with scanStartError when the scan cannot start (AI not ready)", async () => {
  const h = harness();
  const payload = createPayload("/srv/repos/web-app");
  payload.setLibraryBuildMode("scan");
  const response = await call(() =>
    h
      .service(payload, {
        startScan: () =>
          Promise.resolve({
            status: 400,
            error: "Add an Anthropic API key in Settings.",
            error_reason: "ai_not_configured"
          })
      })
      .create({ scanSpendCapUsd: null })
  );
  assert.equal(response.status, 201);
  assert.equal(response.data?.scanJobId, null);
  assert.equal(response.data.scanStartError, "Add an Anthropic API key in Settings.");
  assert.equal(h.stub.row(Table.REPOSITORIES, 1)?.isDeleted, false, "the repository is still created");
});

test("create without a build mode stores grow and the default allowance and never starts a scan", async () => {
  const h = harness();
  let startCalls = 0;
  const response = await call(() =>
    h
      .service(createPayload("/srv/repos/web-app"), {
        startScan: () => {
          startCalls += 1;
          return Promise.resolve({ status: 202, data: libraryJobView(1) });
        }
      })
      .create()
  );
  assert.equal(response.status, 201);
  assert.equal(startCalls, 0);
  assert.equal(h.stub.row(Table.REPOSITORIES, 1)?.libraryBuildMode, "grow");
  assert.equal(h.stub.row(Table.REPOSITORIES, 1)?.stateAllowance, 3);
});

test("updateSettings saves the state allowance and the screen size; nothing to update is 400", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  const allowance = await call(() => h.service(idModel(1)).updateSettings({ stateAllowance: 5 }));
  assert.equal(allowance.status, 200);
  assert.equal(allowance.data?.stateAllowance, 5);
  assert.equal(allowance.data.renderViewport, "desktop");
  const both = await call(() => h.service(idModel(1)).updateSettings({ renderViewport: "mobile", stateAllowance: 1 }));
  assert.equal(both.data?.renderViewport, "mobile");
  assert.equal(both.data.stateAllowance, 1);
  const empty = await call(() => h.service(idModel(1)).updateSettings({}));
  assert.deepEqual(empty, { status: 400, error: "Nothing to update.", error_reason: "validation_failed" });
  assert.equal((await call(() => h.service(idModel(9)).updateSettings({ stateAllowance: 2 }))).status, 404);
  assert.equal(h.stub.callsFor("insert", Table.HARNESS_LIBRARY_JOBS).length, 0, "changing the allowance starts no job");
});

test("remove returns 409 while a scan or repair of the repository is active", async () => {
  for (const job of [
    makeLibraryJobRow({ id: 1, status: "running", totalCount: 2 }),
    makeLibraryJobRow({ id: 2, kind: "repair", status: "queued", visualizationId: 5, componentIds: [1] })
  ]) {
    const h = harness();
    h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
    h.stub.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 5, status: "completed", completedAt: NOW })]);
    h.stub.seed(Table.HARNESS_LIBRARY_JOBS, [job]);
    const response = await call(() => h.service(idModel(1)).remove());
    assert.deepEqual(response, {
      status: 409,
      error: "A scan or repair is running for this repository. Cancel it first.",
      error_reason: "conflict"
    });
    assert.equal(h.stub.row(Table.REPOSITORIES, 1)?.isDeleted, false);
  }
  const finished = harness();
  finished.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  finished.stub.seed(Table.HARNESS_LIBRARY_JOBS, [makeLibraryJobRow({ id: 1, status: "completed", completedAt: NOW })]);
  assert.equal((await call(() => finished.service(idModel(1)).remove())).status, 200);
});
