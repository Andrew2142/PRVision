import "reflect-metadata";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openEmbeddedDatabase, type EmbeddedDatabase } from "../database/embedded";
import { VisualizationCreateDTO } from "../dtos/visualizations/visualization-create.dto";
import { AiProviderKind, AgentRequestStatus, VisualizationSourceType } from "../enums";
import { RepositoryModel, VisualizationModel } from "../models";
import { AgentRequestsService } from "../services/agent-requests/agent-requests-service";
import { RepositoriesService } from "../services/repositories/repositories-service";
import {
  VisualizationWorkerService,
  type RunOutcome
} from "../services/visualizations/pipeline/visualization-worker-service";
import { VisualizationsService } from "../services/visualizations/visualizations-service";
import { ArtifactStore, AuthContext, DrizzleDb, createLogger, type ApiResponse } from "../utilities";
import { exportHarnesses, importHarnesses } from "./harness-files";
import { LocalQueue } from "./local-queue";
import { exportReport } from "./report-export";
import { RunFolder, type RunStatusFile } from "./run-folder";

/**
 * Headless engine: one visualization in one process, with an embedded database (PGlite) and no server, worker
 * or Redis. Started in the background by the prvision CLI, which sets PRVISION_DATA_DIR to `<run>/data`:
 *
 *   node dist/headless/engine.js --run <dir> --repo <path> [--app-root <dir>] [--angular-project <name>]
 *        [--viewport desktop|tablet|mobile] [--states <1-5>]
 *        (--working | --head <ref> [--base <ref>]) [--limit <n>] [--cli "<command>"]
 *
 * Every AI request goes to the Claude Code session through the run folder (see run-folder.ts); the engine exits
 * when the run completes, fails or is cancelled.
 */

const BRIDGE_TICK_MS = 1_000;
const log = createLogger("headless.engine");

interface EngineArgs {
  run: string;
  repo: string;
  appRoot: string | null;
  angularProject: string | null;
  viewport: "desktop" | "tablet" | "mobile" | null;
  states: number | null;
  working: boolean;
  head: string | null;
  base: string | null;
  limit: number | null;
  cli: string;
}

class EngineError extends Error {}

function parseArgs(argv: readonly string[]): EngineArgs {
  const args: EngineArgs = {
    run: "",
    repo: "",
    appRoot: null,
    angularProject: null,
    viewport: null,
    states: null,
    working: false,
    head: null,
    base: null,
    limit: null,
    cli: "prvision"
  };
  const rest = [...argv];
  const value = (flag: string): string => {
    const next = rest.shift();
    if (next === undefined) {
      throw new EngineError(`${flag} needs a value`);
    }
    return next;
  };
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === "--run") {
      args.run = path.resolve(value(flag));
    } else if (flag === "--repo") {
      args.repo = path.resolve(value(flag));
    } else if (flag === "--app-root") {
      args.appRoot = value(flag);
    } else if (flag === "--angular-project") {
      args.angularProject = value(flag);
    } else if (flag === "--viewport") {
      const viewport = value(flag);
      if (viewport !== "desktop" && viewport !== "tablet" && viewport !== "mobile") {
        throw new EngineError("--viewport must be desktop, tablet or mobile");
      }
      args.viewport = viewport;
    } else if (flag === "--states") {
      args.states = Number(value(flag));
    } else if (flag === "--working") {
      args.working = true;
    } else if (flag === "--head") {
      args.head = value(flag);
    } else if (flag === "--base") {
      args.base = value(flag);
    } else if (flag === "--limit") {
      args.limit = Number(value(flag));
    } else if (flag === "--cli") {
      args.cli = value(flag);
    } else {
      throw new EngineError(`Unknown option ${String(flag)}`);
    }
  }
  if (!args.run || !args.repo) {
    throw new EngineError("--run and --repo are required");
  }
  if (!args.working && args.head === null) {
    throw new EngineError("Pass --working or --head <ref>");
  }
  if (args.states !== null && !(Number.isSafeInteger(args.states) && args.states >= 1 && args.states <= 5)) {
    throw new EngineError("--states must be between 1 and 5");
  }
  if (args.limit !== null && !(Number.isSafeInteger(args.limit) && args.limit > 0)) {
    throw new EngineError("--limit must be a positive integer");
  }
  return args;
}

function errorText(response: ApiResponse): string {
  const { error } = response;
  return Array.isArray(error) ? error.join(" ") : (error ?? `status ${String(response.status)}`);
}

/** Hands AI requests to the Claude Code session through the run folder and keeps status.json current. */
class AgentBridge {
  private readonly written = new Set<number>();
  private readonly requests = new AgentRequestsService();
  private stopped = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly folder: RunFolder,
    private readonly visualizationId: number,
    private readonly context: { title: string; repository: string; cli: string }
  ) {}

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  /** One pass: claim new requests, apply submissions, refresh status.json. */
  async tick(): Promise<void> {
    const claimed = await this.requests.claim(this.visualizationId);
    for (const request of claimed.data ?? []) {
      if (this.written.has(request.id)) {
        continue;
      }
      await this.folder.writeRequest(request, this.context);
      this.written.add(request.id);
      log.info({ event: "headless.request.written", requestId: request.id, purpose: request.purpose }, "Request");
    }
    for (const submission of await this.folder.pendingSubmissions()) {
      const response =
        submission.kind === "submit"
          ? await this.requests.answer(submission.id, asObject(submission.body))
          : await this.requests.fail(submission.id, failMessage(submission.body));
      const accepted = response.status === 200;
      const errors = accepted ? undefined : Array.isArray(response.error) ? response.error : [errorText(response)];
      await this.folder.writeResult(submission.id, submission.kind, { accepted, ...(errors ? { errors } : {}) });
    }
    await this.writeStatus();
  }

  async writeStatus(override: Partial<RunStatusFile> = {}): Promise<void> {
    const listed = await this.requests.list(this.visualizationId);
    const openRequests = (listed.data ?? [])
      .filter((r) => r.status === AgentRequestStatus.CLAIMED || r.status === AgentRequestStatus.PENDING)
      .filter((r) => this.written.has(r.id))
      .map((r) => r.id);
    const viz = await new VisualizationsService(modelWithId(this.visualizationId)).get();
    const detail = viz.data as
      { status?: string; title?: string; componentCount?: number; changedCount?: number } | undefined;
    await this.folder.writeStatus({
      state: detail?.status ?? "unknown",
      title: detail?.title ?? null,
      visualizationId: this.visualizationId,
      componentCount: detail?.componentCount ?? 0,
      changedCount: detail?.changedCount ?? 0,
      openRequests,
      message: null,
      reportDir: null,
      ...override
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await AuthContext.runAsLocalUser(() => this.tick(), { requestId: "headless-bridge" });
      } catch (error: unknown) {
        log.warn({ event: "headless.bridge.tick_failed", err: error }, "Bridge tick failed");
      }
      await delay(BRIDGE_TICK_MS);
    }
  }
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function failMessage(body: unknown): string {
  const message = asObject(body).message;
  return typeof message === "string" && message.trim() ? message : "The agent could not answer this request.";
}

function modelWithId(id: number): VisualizationModel {
  const model = new VisualizationModel();
  model.setId(id);
  return model;
}

async function registerRepository(args: EngineArgs): Promise<{ id: number; name: string; framework: string }> {
  const model = new RepositoryModel({
    localPath: args.repo,
    ...(args.appRoot !== null ? { appRoot: args.appRoot } : {}),
    ...(args.angularProject !== null ? { angularProject: args.angularProject } : {}),
    ...(args.viewport !== null ? { renderViewport: args.viewport } : {}),
    ...(args.states !== null ? { stateAllowance: args.states } : {})
  });
  const created = await new RepositoriesService(model).create();
  if (created.status !== 201 || !created.data) {
    throw new EngineError(errorText(created));
  }
  return { id: created.data.id, name: created.data.name, framework: created.data.framework };
}

async function createRun(args: EngineArgs, repositoryId: number, queue: LocalQueue): Promise<number> {
  const dto = new VisualizationCreateDTO();
  dto.repositoryId = repositoryId;
  dto.aiProvider = AiProviderKind.AGENT;
  if (args.working) {
    dto.sourceType = VisualizationSourceType.WORKING_TREE;
  } else {
    dto.sourceType = VisualizationSourceType.LOCAL_BRANCH;
    if (args.head !== null) {
      dto.headRef = args.head;
    }
    if (args.base !== null) {
      dto.baseRef = args.base;
    }
  }
  const created = await new VisualizationsService(undefined, { queue }).create(dto);
  const data = created.data as { visualizationId?: number } | undefined;
  if (created.status !== 202 || typeof data?.visualizationId !== "number") {
    throw new EngineError(errorText(created));
  }
  return data.visualizationId;
}

/** Waits for the user's choice on a paused run (continue.json), or uses --limit straight away. */
async function waitForLimit(folder: RunFolder, preset: number | null): Promise<number> {
  if (preset !== null) {
    return preset;
  }
  for (;;) {
    const limit = await folder.takeContinue();
    if (limit !== null) {
      return limit;
    }
    await delay(BRIDGE_TICK_MS);
  }
}

async function runPipeline(args: EngineArgs, folder: RunFolder): Promise<void> {
  const queue = new LocalQueue();
  const repository = await registerRepository(args);
  const imported = await importHarnesses(repository.id, repository.framework, args.repo);
  log.info({ event: "headless.harnesses.imported", count: imported }, "Saved harnesses loaded");
  const visualizationId = await createRun(args, repository.id, queue);
  const detail = await new VisualizationsService(modelWithId(visualizationId)).get();
  const title = (detail.data as { title?: string } | undefined)?.title ?? repository.name;
  const bridge = new AgentBridge(folder, visualizationId, { title, repository: args.repo, cli: args.cli });
  bridge.start();

  const controller = new AbortController();
  const stop = (): void => {
    queue.requestCancel(visualizationId).catch(() => undefined);
    controller.abort("cancelled");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    const worker = new VisualizationWorkerService({ queue });
    let outcome: RunOutcome = await worker.run({
      visualizationId,
      jobId: queue.visualizationJobId(visualizationId),
      signal: controller.signal
    });
    while (outcome === "paused") {
      await bridge.writeStatus();
      const limit = await waitForLimit(folder, args.limit);
      const continued = await new VisualizationsService(modelWithId(visualizationId), { queue }).continueRun(limit);
      if (continued.status !== 202) {
        throw new EngineError(errorText(continued));
      }
      outcome = await worker.run({
        visualizationId,
        jobId: queue.visualizationJobId(visualizationId),
        signal: controller.signal
      });
    }
    log.info({ event: "headless.run.finished", visualizationId, outcome }, "Run finished");
  } finally {
    await bridge.stop();
  }
  // Save what this run wrote to .prvision/harnesses and write the report, then report the end state.
  const saved = await exportHarnesses(repository.id, args.repo);
  log.info({ event: "headless.harnesses.exported", count: saved }, "Harnesses saved to .prvision");
  const reportDir = path.join(args.run, "report");
  await exportReport(visualizationId, reportDir, { name: repository.name, path: args.repo });
  await bridge.writeStatus({ reportDir });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const folder = new RunFolder(args.run);
  await folder.init();
  let database: EmbeddedDatabase | null = null;
  try {
    database = await openEmbeddedDatabase();
    DrizzleDb.use(database.db);
    await new ArtifactStore().ensureRoots();
    await AuthContext.runAsLocalUser(() => runPipeline(args, folder), { requestId: "headless" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ event: "headless.engine.failed", err: error }, "Headless engine failed");
    await folder.writeStatus({
      state: "error",
      title: null,
      visualizationId: null,
      componentCount: 0,
      changedCount: 0,
      openRequests: [],
      message,
      reportDir: null
    });
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      log.fatal({ event: "headless.engine.crashed", err: error }, "Headless engine crashed");
      process.exitCode = 1;
    })
    .finally(() => {
      // Child processes (Vite hosts, browsers) are closed by the pipeline; nothing else should keep the loop alive.
      process.exit();
    });
}
