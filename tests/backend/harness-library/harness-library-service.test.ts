import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Table } from "../../../backend/src/enums";
import type { LibraryEstimateRequestDTO } from "../../../backend/src/dtos";
import {
  HarnessLibraryService,
  type HarnessLibraryServiceDependencies
} from "../../../backend/src/services/harness-library/harness-library-service";
import { HarnessLibraryStore } from "../../../backend/src/services/harness-library/harness-library-store";
import {
  LibraryEstimateTimeoutError,
  type LibraryEstimateInput
} from "../../../backend/src/services/harness-library/library-estimate-service";
import type { DetectionResult } from "../../../backend/src/services/repositories/project-detection-service";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import type { AiReadiness } from "../../../backend/src/utilities/services/ai/ai-provider-factory";
import type { ResolvedAiSettings } from "../../../backend/src/utilities/services/ai/ai-provider";
import type { LibraryEstimateView } from "../../../backend/src/dtos/harness-library/library-estimate-view.dto";
import {
  makeLibraryEntryRow,
  makeLibraryJobEventRow,
  makeLibraryJobRow,
  makeRepositoryRow
} from "../helpers/factories";
import { FakeLibraryQueue } from "../helpers/fake-library-queue";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const JOBS = Table.HARNESS_LIBRARY_JOBS;
const EVENTS = Table.HARNESS_LIBRARY_JOB_EVENTS;

const SETTINGS: ResolvedAiSettings = {
  provider: "anthropic_api",
  model: "claude-opus-5-5",
  harnessEffort: "high",
  summaryEffort: "medium",
  anthropicApiKey: { state: "present", value: "sk-ant-test" }
};

const ESTIMATE: LibraryEstimateView = {
  componentCount: 10,
  toWriteCount: 10,
  truncated: false,
  stateAllowance: 3,
  kind: "scan",
  model: "claude-opus-5-5",
  priceModel: "claude-opus-5-5",
  priceExact: true,
  basis: "default",
  perHarnessUsd: 0.3269,
  estimatedUsd: 3.27,
  lowUsd: 1.96,
  highUsd: 5.23,
  estimatedMinutes: 5,
  warnings: []
};

interface Setup {
  db: InMemoryQueryHandler;
  queue: FakeLibraryQueue;
  events: Array<{ jobId: number; level: string; message: string }>;
  estimates: LibraryEstimateInput[];
  service: HarnessLibraryService;
}

function setup(
  options: {
    readiness?: AiReadiness;
    estimate?: (input: LibraryEstimateInput) => Promise<LibraryEstimateView>;
    detection?: DetectionResult;
    folderExists?: boolean;
    deps?: Partial<HarnessLibraryServiceDependencies>;
  } = {}
): Setup {
  const db = new InMemoryQueryHandler();
  db.now = () => NOW;
  db.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, name: "shop" })]);
  const qh = db as unknown as QueryHandler;
  const queue = new FakeLibraryQueue();
  const events: Setup["events"] = [];
  const estimates: LibraryEstimateInput[] = [];
  const service = new HarnessLibraryService({
    queryHandler: qh,
    store: new HarnessLibraryStore({ queryHandler: qh, now: () => NOW }),
    estimator: {
      estimate: (input) => {
        estimates.push(input);
        return options.estimate ? options.estimate(input) : Promise.resolve({ ...ESTIMATE, kind: input.kind });
      }
    },
    detector: {
      detect: () =>
        Promise.resolve(
          options.detection ?? {
            ok: true,
            project: {
              rootPath: "/srv/repos/new-app",
              suggestedName: "new-app",
              githubOwner: null,
              githubRepo: null,
              githubRemoteName: null,
              defaultBranch: "main",
              framework: "react_vite",
              packageManager: "npm",
              appRoot: ".",
              angularProject: null,
              angularBuildConfiguration: null,
              viteConfigPath: "vite.config.ts",
              tsconfigPath: "tsconfig.json",
              entryFilePath: "src/main.tsx",
              globalStylePaths: [],
              warnings: []
            }
          }
        )
    },
    readAiSettings: () => Promise.resolve(SETTINGS),
    aiReadiness: () =>
      Promise.resolve(options.readiness ?? { ready: true, provider: "anthropic_api", model: SETTINGS.model }),
    queue,
    consoleFactory: (jobId) => ({
      info: (message: string) => {
        events.push({ jobId, level: "info", message });
        return Promise.resolve();
      },
      warn: (message: string) => {
        events.push({ jobId, level: "warn", message });
        return Promise.resolve();
      },
      error: (message: string) => {
        events.push({ jobId, level: "error", message });
        return Promise.resolve();
      }
    }),
    folderExists: () => Promise.resolve(options.folderExists ?? true),
    now: () => NOW,
    ...options.deps
  });
  return { db, queue, events, estimates, service };
}

// ----- startScan -----

test("startScan returns 404 for an unknown or removed repository", async () => {
  const { db, service } = setup();
  db.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2, localPath: "/srv/gone", isDeleted: true })]);
  for (const id of [2, 99]) {
    const response = await service.startScan(id, { kind: "scan", spendCapUsd: null });
    assert.equal(response.status, 404);
    assert.equal(response.error_reason, "not_found");
  }
  assert.equal(db.rows(JOBS).length, 0);
});

test("startScan returns 400 ai_not_configured with the readiness message and writes nothing", async () => {
  const { db, service, queue } = setup({
    readiness: { ready: false, reason: "ai_not_configured", message: "Add an Anthropic API key in Settings." }
  });
  const response = await service.startScan(1, { kind: "scan", spendCapUsd: 20, stateAllowance: 5 });
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "ai_not_configured");
  assert.equal(response.error, "Add an Anthropic API key in Settings.");
  assert.equal(db.rows(JOBS).length, 0);
  assert.equal(db.row(Table.REPOSITORIES, 1)?.stateAllowance, 3);
  assert.equal(db.row(Table.REPOSITORIES, 1)?.libraryBuildMode, "grow");
  assert.deepEqual(queue.calls, []);
});

test("startScan returns 409 while a scan or rescan of the repository is active, and maps a unique violation to 409", async () => {
  const { db, service } = setup();
  db.seed(JOBS, [makeLibraryJobRow({ id: 5, kind: "rescan", status: "running", totalCount: 3 })]);
  const running = await service.startScan(1, { kind: "scan", spendCapUsd: null });
  assert.equal(running.status, 409);
  assert.equal(running.error_reason, "conflict");
  assert.equal(running.error, "A scan is already running for this repository.");

  const fresh = setup();
  fresh.db.failNext("insert", { status: 409, error: "duplicate key", error_reason: "conflict" });
  const raced = await fresh.service.startScan(1, { kind: "scan", spendCapUsd: null });
  assert.equal(raced.status, 409);
  assert.equal(raced.error, "A scan is already running for this repository.");
});

test("startScan applies the allowance, switches the repository to scan, inserts and enqueues the job → 202", async () => {
  const { db, service, queue } = setup();
  const response = await service.startScan(1, { kind: "rescan", spendCapUsd: 12.5, stateAllowance: 5 });
  assert.equal(response.status, 202);
  const repository = db.row(Table.REPOSITORIES, 1);
  assert.equal(repository?.stateAllowance, 5);
  assert.equal(repository.libraryBuildMode, "scan");
  const job = db.rows(JOBS)[0];
  assert.equal(job?.kind, "rescan");
  assert.equal(job.status, "queued");
  assert.equal(job.stateAllowance, 5);
  assert.equal(job.spendCapUsd, 12.5);
  assert.equal(job.aiModel, "claude-opus-5-5");
  assert.equal(job.jobId, "scan-1");
  assert.deepEqual(queue.calls, ["enqueue:rescan:1"]);
  assert.equal(response.data?.id, job.id);
  assert.equal(response.data.repositoryName, "shop");
  assert.equal(response.data.kind, "rescan");
  assert.equal(response.data.status, "queued");
  assert.equal(response.data.spendCapUsd, 12.5);
  assert.equal(response.data.priceExact, true);
  assert.equal(response.data.processedCount, 0);
});

test("startScan without an allowance keeps the repository's; a grow repository switches to scan (D3)", async () => {
  const { db, service } = setup();
  const response = await service.startScan(1, { kind: "scan", spendCapUsd: null });
  assert.equal(response.status, 202);
  assert.equal(db.row(Table.REPOSITORIES, 1)?.stateAllowance, 3);
  assert.equal(db.row(Table.REPOSITORIES, 1)?.libraryBuildMode, "scan");
  assert.equal(db.rows(JOBS)[0]?.stateAllowance, 3);
  assert.equal(db.rows(JOBS)[0]?.spendCapUsd, null);
});

test("startScan fails the job with 'Could not queue the scan.' and answers 500 when enqueueing fails", async () => {
  const { db, service, queue, events } = setup();
  queue.enqueueError = new Error("redis down");
  const response = await service.startScan(1, { kind: "scan", spendCapUsd: null });
  assert.equal(response.status, 500);
  assert.equal(response.error, "Could not queue the scan.");
  assert.equal(response.error_reason, "internal_error");
  const job = db.rows(JOBS)[0];
  assert.equal(job?.status, "failed");
  assert.equal(job.errorMessage, "Could not queue the scan.");
  assert.deepEqual(job.completedAt, NOW);
  assert.deepEqual(events, [{ jobId: job.id, level: "error", message: "Could not queue the scan." }]);
});

// ----- summary -----

test("summary counts leave out off_default_branch entries and report the active and last scan jobs", async () => {
  const { db, service } = setup();
  db.seed(Table.HARNESS_LIBRARY_ENTRIES, [
    makeLibraryEntryRow({ id: 1, filePath: "src/A.tsx" }),
    makeLibraryEntryRow({ id: 2, filePath: "src/B.tsx", status: "needs_update", lastError: "boom" }),
    makeLibraryEntryRow({
      id: 3,
      filePath: "src/C.tsx",
      status: "needs_update",
      harnessSource: null,
      states: [],
      stateCount: 0
    }),
    makeLibraryEntryRow({ id: 4, filePath: "src/Gone.tsx", status: "off_default_branch" }),
    makeLibraryEntryRow({ id: 5, filePath: "src/Other.tsx", repositoryId: 2 })
  ]);
  db.seed(JOBS, [
    makeLibraryJobRow({ id: 1, status: "completed", totalCount: 2, writtenCount: 2, completedAt: NOW }),
    makeLibraryJobRow({ id: 2, status: "cap_reached", totalCount: 2, completedAt: NOW }),
    makeLibraryJobRow({ id: 3, status: "running", totalCount: 2 }),
    makeLibraryJobRow({ id: 4, kind: "repair", status: "running", visualizationId: 9, componentIds: [1] })
  ]);
  const response = await service.summary(1);
  assert.equal(response.status, 200);
  const view = response.data;
  assert.deepEqual(view?.counts, { total: 3, ready: 1, needsUpdate: 2, withoutHarness: 1, otherAllowance: 0 });
  assert.equal(view.activeJob?.id, 3);
  assert.equal(view.lastScanJob?.id, 2);
  assert.equal(view.canContinue, false, "an active job hides Continue");
  assert.equal(view.buildMode, "grow");
  assert.equal(view.stateAllowance, 3);
  assert.equal(view.rescanSuggested, false);
});

test("summary flags: canContinue after cap_reached, cancelled or failed; rescanSuggested only for scan repositories", async () => {
  for (const status of ["cap_reached", "cancelled", "failed", "completed"] as const) {
    const { db, service } = setup();
    await db.update({ libraryBuildMode: "scan" }, { id: 1 }, Table.REPOSITORIES);
    db.seed(JOBS, [makeLibraryJobRow({ id: 1, status, completedAt: NOW })]);
    db.seed(Table.HARNESS_LIBRARY_ENTRIES, [makeLibraryEntryRow({ id: 1, stateAllowance: 1 })]);
    const view = (await service.summary(1)).data;
    assert.equal(view?.canContinue, status !== "completed", status);
    assert.equal(view.rescanSuggested, true, status);
    assert.equal(view.counts.otherAllowance, 1);
  }
  const grow = setup();
  grow.db.seed(Table.HARNESS_LIBRARY_ENTRIES, [makeLibraryEntryRow({ id: 1, stateAllowance: 1 })]);
  const growView = (await grow.service.summary(1)).data;
  assert.equal(growView?.rescanSuggested, false);
  assert.equal(growView.canContinue, false, "no scan job yet");
  assert.equal((await grow.service.summary(42)).status, 404);
});

// ----- jobs -----

test("getJob returns the view with the repository name; 404 for unknown jobs and jobs of removed repositories", async () => {
  const { db, service } = setup();
  db.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2, localPath: "/srv/old", isDeleted: true })]);
  db.seed(JOBS, [
    makeLibraryJobRow({ id: 1, status: "running", totalCount: 10, writtenCount: 4, failedCount: 1, skippedCount: 1 }),
    makeLibraryJobRow({ id: 2, repositoryId: 2, status: "completed", completedAt: NOW })
  ]);
  const response = await service.getJob(1);
  assert.equal(response.status, 200);
  assert.equal(response.data?.repositoryName, "shop");
  assert.equal(response.data.processedCount, 6);
  assert.equal((await service.getJob(2)).status, 404);
  assert.equal((await service.getJob(3)).status, 404);
});

test("jobEvents pages oldest first with an exclusive afterId and a limit capped at 500", async () => {
  const { db, service } = setup();
  db.seed(JOBS, [makeLibraryJobRow({ id: 1 }), makeLibraryJobRow({ id: 2 })]);
  db.seed(
    EVENTS,
    [1, 2, 3, 4, 5].map((n) => makeLibraryJobEventRow({ id: n, jobId: n === 3 ? 2 : 1, message: `event ${String(n)}` }))
  );
  const all = await service.jobEvents(1, {});
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.data?.map((event) => event.id),
    [1, 2, 4, 5]
  );
  assert.deepEqual(all.data[0], { id: 1, level: "info", message: "event 1", createdAt: "2026-01-01T00:00:00.000Z" });
  const page = await service.jobEvents(1, { afterId: 1, limit: 2 });
  assert.deepEqual(
    page.data?.map((event) => event.id),
    [2, 4]
  );
  await service.jobEvents(1, { limit: 10_000 });
  const select = db.callsFor("selectMany", EVENTS).at(-1);
  assert.deepEqual(select?.args[2], { orderBy: [{ column: "id", direction: "asc" }], limit: 500 });
  assert.equal((await service.jobEvents(9, {})).status, 404);
});

test("cancelJob: a queued job still in the queue is cancelled at once (200) and its flag cleared", async () => {
  const { db, service, queue, events } = setup();
  db.seed(JOBS, [makeLibraryJobRow({ id: 1, status: "queued" })]);
  queue.jobStates.set(1, "waiting");
  const response = await service.cancelJob(1);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { id: 1, status: "cancelled" });
  assert.equal(db.row(JOBS, 1)?.status, "cancelled");
  assert.deepEqual(db.row(JOBS, 1)?.completedAt, NOW);
  assert.equal(queue.flags.has(1), false);
  assert.deepEqual(events, [{ jobId: 1, level: "info", message: "Cancelled before the worker started." }]);
});

test("cancelJob: a running job (or a queued one a worker already holds) gets the flag and 202", async () => {
  for (const [status, bullState] of [
    ["running", "active"],
    ["preparing", "active"],
    ["queued", "active"]
  ] as const) {
    const { db, service, queue } = setup();
    db.seed(JOBS, [makeLibraryJobRow({ id: 1, status, totalCount: status === "queued" ? 0 : 3 })]);
    queue.jobStates.set(1, bullState);
    const response = await service.cancelJob(1);
    assert.equal(response.status, 202, status);
    assert.deepEqual(response.data, { id: 1, status: "cancel_requested" });
    assert.equal(queue.flags.has(1), true);
    assert.equal(db.row(JOBS, 1)?.status, status);
  }
});

test("cancelJob: 409 already_terminal for a finished job, 404 for an unknown one", async () => {
  const { db, service, queue } = setup();
  db.seed(JOBS, [makeLibraryJobRow({ id: 1, status: "completed", completedAt: NOW })]);
  const response = await service.cancelJob(1);
  assert.equal(response.status, 409);
  assert.equal(response.error_reason, "already_terminal");
  assert.equal(response.error, "This job is already completed.");
  assert.equal(queue.flags.size, 0);
  assert.equal((await service.cancelJob(2)).status, 404);
});

// ----- estimates -----

test("estimate defaults to the repository's allowance and kind scan, and passes the repository's app fields", async () => {
  const { service, estimates } = setup();
  const response = await service.estimate(1, {});
  assert.equal(response.status, 200);
  assert.equal(response.data?.kind, "scan");
  assert.deepEqual(estimates[0], {
    rootDir: "/tmp/prvision-test-repo/sample-react-app",
    framework: "react_vite",
    appRoot: ".",
    tsconfigPath: "tsconfig.json",
    viteConfigPath: "vite.config.ts",
    angularProject: null,
    stateAllowance: 3,
    kind: "scan",
    repositoryId: 1,
    model: "claude-opus-5-5"
  });
  await service.estimate(1, { stateAllowance: 1, kind: "rescan" });
  const second = estimates[1];
  assert.equal(second?.stateAllowance, 1);
  assert.equal(second.kind, "rescan");
});

test("estimate answers 504 internal_error when counting times out, 400 for a missing folder, 404 when unknown", async () => {
  const timedOut = setup({ estimate: () => Promise.reject(new LibraryEstimateTimeoutError(60_000)) });
  const response = await timedOut.service.estimate(1, {});
  assert.equal(response.status, 504);
  assert.equal(response.error_reason, "internal_error");
  assert.equal(response.error, "Counting components took too long; the estimate is unavailable.");

  const missing = setup({ folderExists: false });
  const gone = await missing.service.estimate(1, {});
  assert.equal(gone.status, 400);
  assert.equal(gone.error_reason, "not_git_repo");
  assert.equal(missing.estimates.length, 0);

  assert.equal((await missing.service.estimate(77, {})).status, 404);
});

test("estimateFolder detects the unregistered folder, estimates it as a new repository and writes nothing", async () => {
  const { db, service, estimates } = setup();
  const request = { localPath: "/srv/repos/new-app", stateAllowance: 2 } as LibraryEstimateRequestDTO;
  const response = await service.estimateFolder(request);
  assert.equal(response.status, 200);
  assert.deepEqual(estimates[0], {
    rootDir: "/srv/repos/new-app",
    framework: "react_vite",
    appRoot: ".",
    tsconfigPath: "tsconfig.json",
    viteConfigPath: "vite.config.ts",
    angularProject: null,
    stateAllowance: 2,
    kind: "scan",
    repositoryId: null,
    model: "claude-opus-5-5"
  });
  for (const method of ["insert", "update", "delete"] as const) {
    assert.equal(db.callsFor(method).length, 0, method);
  }
});

test("estimateFolder returns detection failures like POST /api/repositories", async () => {
  const { service, estimates } = setup({
    detection: {
      ok: false,
      failure: { status: 400, errorReason: "unsupported_framework", message: "No package.json found." }
    }
  });
  const response = await service.estimateFolder({
    localPath: "/srv/x",
    stateAllowance: 3
  });
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "unsupported_framework");
  assert.equal(response.error, "No package.json found.");
  assert.equal(estimates.length, 0);
});

test("unexpected failures answer 500 internal_error", async () => {
  const { db, service } = setup();
  db.failNext("validateAndSelect", new Error("db down"));
  const response = await service.summary(1);
  assert.equal(response.status, 500);
  assert.equal(response.error_reason, "internal_error");
});
