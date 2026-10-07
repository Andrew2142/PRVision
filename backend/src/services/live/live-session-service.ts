/**
 * Live mode, HTTP side (16 §12.2, §12.6, D10). Starts one session per finished run (one Live click serves every card),
 * reports it, queues card opens for the worker, records heartbeats and stops it. The API never starts a build server
 * (E14): it only writes the columns it owns (16 §6.9) and queues the `live-sessions` job.
 */
import { LIVE_MAX_SESSIONS } from "../../config-consts";
import {
  ACTIVE_LIVE_SESSION_STATUSES,
  ErrorReason,
  LiveSessionStatus,
  LiveStopReason,
  Table,
  VisualizationSourceType,
  isTerminalVisualizationStatus
} from "../../enums";
import {
  toLiveSessionView,
  type LiveHeartbeatResponse,
  type LiveSessionView,
  type LiveStopResponse
} from "../../dtos/live/live-session-view.dto";
import { LiveSessionModel, RepositoryModel, VisualizationComponentModel, VisualizationModel } from "../../models";
import type { LiveOpenRequestRecord } from "../../types/harness-library";
import { QueryHandler, QueueService, Where, createLogger, type ApiResponse } from "../../utilities";
import { previousHarnessOf } from "../harness-library/harness-repair-worker-service";
import { planStates } from "../visualizations/pipeline/render/live-planning";
import {
  NO_BASE_COMMIT_MESSAGE,
  NO_HEAD_COMMIT_MESSAGE,
  SNAPSHOT_UNAVAILABLE_MESSAGE
} from "../visualizations/run-workspace-recreator";

export const LIVE_RUN_NOT_FINISHED_MESSAGE = "Live mode is available once the run has finished.";
export const LIVE_NO_COMPONENTS_MESSAGE = "This run has no rendered components to show live.";
export const LIVE_NOT_RUNNING_MESSAGE = "Live mode is not running for this run.";
export const LIVE_BUSY_MESSAGE = "Live mode is busy; try again.";
export const LIVE_NEVER_STARTED_MESSAGE = "Live mode has not been started for this run.";
export const LIVE_COMPONENT_NOT_FOUND_MESSAGE = "This component has no harness to show live in this run.";
export const LIVE_QUEUE_FAILED_MESSAGE = "Could not queue live mode.";

/** §12.2 step 3 (LIVE_MAX_SESSIONS other runs). */
export function liveLimitMessage(max: number = LIVE_MAX_SESSIONS): string {
  return `Live mode is already running for ${String(max)} other runs. Leave one of them first (it also stops by itself after 10 minutes idle).`;
}

/** 400 for a state the component does not declare. */
export function unknownStateMessage(stateName: string, names: readonly string[]): string {
  return `State "${stateName}" is not a state of this component. States: ${names.join(", ")}.`;
}

/** Attempts of the version-guarded append of an open request before 409 (16 §12.3 step 4). */
export const LIVE_OPEN_MAX_ATTEMPTS = 3;
/** Open requests kept in the row at most (the worker drains them every 500 ms; older ones are dropped). */
export const LIVE_OPEN_REQUESTS_MAX = 50;

/** Collaborators; tests replace any subset. */
export interface LiveSessionServiceDependencies {
  queryHandler: QueryHandler;
  queue: Pick<typeof QueueService, "enqueueLiveSession">;
  now: () => Date;
  maxSessions: number;
}

const INTERNAL_ERROR: ApiResponse<never> = {
  status: 500,
  error: "Internal server error",
  error_reason: ErrorReason.INTERNAL_ERROR
};

/** Running sessions take opens; a stopping one does not. */
const RUNNING_STATUSES: readonly LiveSessionStatus[] = [LiveSessionStatus.STARTING, LiveSessionStatus.READY];

/** HTTP-facing live mode (16 §12.6). */
export class LiveSessionService {
  private readonly deps: LiveSessionServiceDependencies;
  private readonly log = createLogger("live");

  constructor(deps: Partial<LiveSessionServiceDependencies> = {}) {
    this.deps = {
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      queue: deps.queue ?? QueueService,
      now: deps.now ?? ((): Date => new Date()),
      maxSessions: deps.maxSessions ?? LIVE_MAX_SESSIONS
    };
  }

  /**
   * POST /api/visualizations/:id/live (16 §12.2): 202 with a new `starting` session, or 200 with the run's active
   * session (one Live click serves every card).
   */
  async start(visualizationId: number): Promise<ApiResponse<LiveSessionView>> {
    try {
      // 1. The run: visible, finished, something to show, recreatable
      const run = await this.loadVisibleRun(visualizationId);
      if (run === null) {
        return runNotFound();
      }
      if (!isTerminalVisualizationStatus(run.status)) {
        return conflict(LIVE_RUN_NOT_FINISHED_MESSAGE);
      }
      const withHarness = await this.deps.queryHandler.count(
        { visualizationId: run.id, harnessSource: Where.isNotNull() },
        Table.VISUALIZATION_COMPONENTS
      );
      if (withHarness.status !== 200) {
        return INTERNAL_ERROR;
      }
      if ((withHarness.data?.count ?? 0) === 0) {
        return conflict(LIVE_NO_COMPONENTS_MESSAGE);
      }
      const recreatable = recreatableError(run);
      if (recreatable !== null) {
        return conflict(recreatable);
      }

      // 2. The run's active session serves every card
      const active = await this.activeSession(run.id);
      if (active !== null) {
        return { status: 200, data: toLiveSessionView(active) };
      }

      // 3. At most LIVE_MAX_SESSIONS sessions overall
      const running = await this.deps.queryHandler.count(
        { status: Where.in([...ACTIVE_LIVE_SESSION_STATUSES]) },
        Table.LIVE_SESSIONS
      );
      if (running.status !== 200) {
        return INTERNAL_ERROR;
      }
      if ((running.data?.count ?? 0) >= this.deps.maxSessions) {
        return conflict(liveLimitMessage(this.deps.maxSessions));
      }

      // 4. Row, queue, job id
      const now = this.deps.now();
      const inserted = await this.deps.queryHandler.insert(
        {
          visualizationId: run.id,
          status: LiveSessionStatus.STARTING,
          lastHeartbeatAt: now,
          lastActivityAt: now
        },
        Table.LIVE_SESSIONS
      );
      if (inserted.status === 409) {
        // A concurrent start won the partial unique index: serve its session.
        const winner = await this.activeSession(run.id);
        return winner === null ? INTERNAL_ERROR : { status: 200, data: toLiveSessionView(winner) };
      }
      const sessionId = QueryHandler.firstInsertedId(inserted);
      if (inserted.status !== 200 || sessionId === null) {
        this.log.error(
          { event: "live.session.insert_failed", visualizationId, status: inserted.status },
          "Live session insert failed"
        );
        return INTERNAL_ERROR;
      }
      let jobId: string;
      try {
        jobId = (await this.deps.queue.enqueueLiveSession(sessionId)).jobId;
      } catch (error: unknown) {
        this.log.error({ event: "live.session.enqueue_failed", sessionId, err: error }, "Live session enqueue failed");
        await this.deps.queryHandler.update(
          {
            status: LiveSessionStatus.FAILED,
            stopReason: LiveStopReason.ERROR,
            errorMessage: LIVE_QUEUE_FAILED_MESSAGE,
            stoppedAt: this.deps.now()
          },
          { id: sessionId, status: LiveSessionStatus.STARTING },
          Table.LIVE_SESSIONS
        );
        return { status: 500, error: LIVE_QUEUE_FAILED_MESSAGE, error_reason: ErrorReason.INTERNAL_ERROR };
      }
      await this.deps.queryHandler.update({ jobId }, { id: sessionId }, Table.LIVE_SESSIONS);
      const session = await this.loadSession(sessionId);
      if (session === null) {
        return INTERNAL_ERROR;
      }
      this.log.info(
        { event: "live.session.transition", sessionId, from: null, to: LiveSessionStatus.STARTING, reason: null },
        "Live session started"
      );
      return { status: 202, data: toLiveSessionView(session) };
    } catch (error: unknown) {
      return this.unexpected(error, "start");
    }
  }

  /** GET /api/visualizations/:id/live: the active session, else the most recent one; 404 when there never was one. */
  async get(visualizationId: number): Promise<ApiResponse<LiveSessionView>> {
    try {
      const run = await this.loadVisibleRun(visualizationId);
      if (run === null) {
        return runNotFound();
      }
      const session = (await this.activeSession(run.id)) ?? (await this.latestSession(run.id));
      if (session === null) {
        return { status: 404, error: LIVE_NEVER_STARTED_MESSAGE, error_reason: ErrorReason.NOT_FOUND };
      }
      return { status: 200, data: toLiveSessionView(session) };
    } catch (error: unknown) {
      return this.unexpected(error, "get");
    }
  }

  /**
   * POST /api/visualizations/:id/live/open: queues the card for the worker (it starts the hosts of the card's render
   * group on both sides) and counts as activity; 202 with the session.
   */
  async open(
    visualizationId: number,
    input: { componentId: number; stateName: string }
  ): Promise<ApiResponse<LiveSessionView>> {
    try {
      const run = await this.loadVisibleRun(visualizationId);
      if (run === null) {
        return runNotFound();
      }
      const session = await this.activeSession(run.id);
      if (session === null || !RUNNING_STATUSES.includes(session.status)) {
        return conflict(LIVE_NOT_RUNNING_MESSAGE);
      }
      const row = await this.deps.queryHandler.validateAndSelect(
        VisualizationComponentModel,
        { id: input.componentId, visualizationId: run.id },
        Table.VISUALIZATION_COMPONENTS
      );
      const repository = row === null ? null : await this.loadRepository(run.repositoryId);
      const harness = row === null || repository === null ? null : previousHarnessOf(row, repository.framework);
      if (row === null || harness === null) {
        return { status: 404, error: LIVE_COMPONENT_NOT_FOUND_MESSAGE, error_reason: ErrorReason.NOT_FOUND };
      }
      const names = planStates(harness.states, harness.baseHarness?.states ?? null, {
        base: row.changeKind !== "added",
        head: row.changeKind !== "removed"
      }).map((state) => state.name);
      if (!names.includes(input.stateName)) {
        return {
          status: 400,
          error: [unknownStateMessage(input.stateName, names)],
          error_reason: ErrorReason.VALIDATION_FAILED
        };
      }
      const appended = await this.appendOpenRequest(session.id, row.id);
      if (appended === "busy") {
        return conflict(LIVE_BUSY_MESSAGE);
      }
      if (appended === "gone") {
        return conflict(LIVE_NOT_RUNNING_MESSAGE);
      }
      const current = await this.loadSession(session.id);
      return current === null ? INTERNAL_ERROR : { status: 202, data: toLiveSessionView(current) };
    } catch (error: unknown) {
      return this.unexpected(error, "open");
    }
  }

  /**
   * POST /api/visualizations/:id/live/heartbeat: `last_heartbeat_at = now` (and `last_activity_at` when active);
   * 404 when no session is active, so the page knows it stopped.
   */
  async heartbeat(visualizationId: number, input: { active: boolean }): Promise<ApiResponse<LiveHeartbeatResponse>> {
    try {
      const run = await this.loadVisibleRun(visualizationId);
      if (run === null) {
        return runNotFound();
      }
      const session = await this.activeSession(run.id);
      if (session === null) {
        return { status: 404, error: LIVE_NOT_RUNNING_MESSAGE, error_reason: ErrorReason.NOT_FOUND };
      }
      const now = this.deps.now();
      const updated = await this.deps.queryHandler.update(
        { lastHeartbeatAt: now, ...(input.active ? { lastActivityAt: now } : {}) },
        { id: session.id, status: Where.in([...ACTIVE_LIVE_SESSION_STATUSES]) },
        Table.LIVE_SESSIONS
      );
      if (updated.status === 404) {
        return { status: 404, error: LIVE_NOT_RUNNING_MESSAGE, error_reason: ErrorReason.NOT_FOUND };
      }
      if (updated.status !== 200) {
        return INTERNAL_ERROR;
      }
      return { status: 200, data: { status: session.status } };
    } catch (error: unknown) {
      return this.unexpected(error, "heartbeat");
    }
  }

  /**
   * POST /api/visualizations/:id/live/stop: the active session → `stopping` with the reason (`left` unless the body
   * says `user`); idempotent (200 `{ id: null, status: "stopped" }` when nothing is active).
   */
  async stop(visualizationId: number, input: { reason?: "user" | "left" }): Promise<ApiResponse<LiveStopResponse>> {
    try {
      const run = await this.loadVisibleRun(visualizationId);
      if (run === null) {
        return runNotFound();
      }
      const reason = input.reason ?? LiveStopReason.LEFT;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const session = await this.activeSession(run.id);
        if (session === null) {
          return { status: 200, data: { id: null, status: "stopped" } };
        }
        if (session.status === LiveSessionStatus.STOPPING) {
          return { status: 200, data: { id: session.id, status: "stopping" } };
        }
        if (await requestStop(this.deps.queryHandler, session.id, reason)) {
          this.log.info(
            { event: "live.session.transition", sessionId: session.id, from: session.status, to: "stopping", reason },
            "Live session stop requested"
          );
          return { status: 200, data: { id: session.id, status: "stopping" } };
        }
      }
      return { status: 200, data: { id: null, status: "stopped" } };
    } catch (error: unknown) {
      return this.unexpected(error, "stop");
    }
  }

  // ----- helpers -----

  /**
   * Appends one open request with the `open_requests_version` guard (16 §12.3 step 4). A miss (the worker drained, or
   * another open appended, in between) is retried; LIVE_OPEN_MAX_ATTEMPTS misses → "busy".
   */
  private async appendOpenRequest(sessionId: number, componentId: number): Promise<"ok" | "busy" | "gone"> {
    for (let attempt = 0; attempt < LIVE_OPEN_MAX_ATTEMPTS; attempt += 1) {
      const session = await this.loadSession(sessionId);
      if (session === null || !RUNNING_STATUSES.includes(session.status)) {
        return "gone";
      }
      const now = this.deps.now();
      const record: LiveOpenRequestRecord = { componentId, requestedAt: now.toISOString() };
      const current = Array.isArray(session.openRequests) ? session.openRequests : [];
      const next = [...current.filter((request) => request.componentId !== componentId), record].slice(
        -LIVE_OPEN_REQUESTS_MAX
      );
      const updated = await this.deps.queryHandler.update(
        {
          openRequests: next,
          openRequestsVersion: session.openRequestsVersion + 1,
          lastActivityAt: now
        },
        {
          id: sessionId,
          openRequestsVersion: session.openRequestsVersion,
          status: Where.in([...RUNNING_STATUSES])
        },
        Table.LIVE_SESSIONS
      );
      if (updated.status === 200) {
        return "ok";
      }
      if (updated.status !== 404) {
        throw new Error(`live_sessions open append failed (${String(updated.status)})`);
      }
    }
    this.log.warn({ event: "live.session.open_busy", sessionId, componentId }, "Open request lost the version race");
    return "busy";
  }

  /** A run whose repository is visible (a removed repository hides its runs). */
  private async loadVisibleRun(visualizationId: number): Promise<VisualizationModel | null> {
    const run = await this.deps.queryHandler.validateAndSelect(
      VisualizationModel,
      { id: visualizationId },
      Table.VISUALIZATIONS
    );
    if (run === null) {
      return null;
    }
    return (await this.loadRepository(run.repositoryId)) === null ? null : run;
  }

  private async loadRepository(repositoryId: number): Promise<RepositoryModel | null> {
    return this.deps.queryHandler.validateAndSelect(RepositoryModel, { id: repositoryId }, Table.REPOSITORIES);
  }

  private async loadSession(sessionId: number): Promise<LiveSessionModel | null> {
    return this.deps.queryHandler.validateAndSelect(LiveSessionModel, { id: sessionId }, Table.LIVE_SESSIONS);
  }

  private async activeSession(visualizationId: number): Promise<LiveSessionModel | null> {
    const rows = await this.deps.queryHandler.selectMany(
      LiveSessionModel,
      { visualizationId, status: Where.in([...ACTIVE_LIVE_SESSION_STATUSES]) },
      Table.LIVE_SESSIONS,
      { orderBy: [{ column: "id", direction: "desc" }], limit: 1 }
    );
    return rows[0] ?? null;
  }

  private async latestSession(visualizationId: number): Promise<LiveSessionModel | null> {
    const rows = await this.deps.queryHandler.selectMany(LiveSessionModel, { visualizationId }, Table.LIVE_SESSIONS, {
      orderBy: [{ column: "id", direction: "desc" }],
      limit: 1
    });
    return rows[0] ?? null;
  }

  private unexpected(error: unknown, action: string): ApiResponse<never> {
    this.log.error({ event: "live.service.failed", err: error, action }, "Live session service failed");
    return INTERNAL_ERROR;
  }
}

/** §12.2 step 1 / §11.1: why a run's worktrees cannot be recreated, or null. */
function recreatableError(
  run: Pick<VisualizationModel, "baseSha" | "headSha" | "sourceType" | "workingTreeSnapshot">
): string | null {
  if ((run.baseSha ?? "") === "") {
    return NO_BASE_COMMIT_MESSAGE;
  }
  if (run.sourceType === VisualizationSourceType.WORKING_TREE) {
    return run.workingTreeSnapshot ? null : SNAPSHOT_UNAVAILABLE_MESSAGE;
  }
  return (run.headSha ?? "") === "" ? NO_HEAD_COMMIT_MESSAGE : null;
}

/** The API's only status write (16 §6.9): starting/ready → stopping with the reason. False when the guard missed. */
async function requestStop(
  queryHandler: Pick<QueryHandler, "update">,
  sessionId: number,
  reason: LiveStopReason
): Promise<boolean> {
  const updated = await queryHandler.update(
    { status: LiveSessionStatus.STOPPING, stopReason: reason },
    { id: sessionId, status: Where.in([...RUNNING_STATUSES]) },
    Table.LIVE_SESSIONS
  );
  if (updated.status === 200) {
    return true;
  }
  if (updated.status === 404) {
    return false;
  }
  throw new Error(`live_sessions stop failed (${String(updated.status)})`);
}

/**
 * Stops the running live sessions of the given runs (`stopping`, reason `user`): a deleted run or a removed
 * repository (16 §12.6). Best effort for the caller; returns how many sessions were asked to stop.
 *
 * @throws Error when a statement fails (callers log and continue).
 */
export async function stopLiveSessionsOfRuns(
  queryHandler: Pick<QueryHandler, "selectMany" | "update">,
  visualizationIds: readonly number[]
): Promise<number> {
  if (visualizationIds.length === 0) {
    return 0;
  }
  const sessions = await queryHandler.selectMany(
    LiveSessionModel,
    { visualizationId: Where.in([...visualizationIds]), status: Where.in([...RUNNING_STATUSES]) },
    Table.LIVE_SESSIONS
  );
  let stopped = 0;
  for (const session of sessions) {
    if (await requestStop(queryHandler, session.id, LiveStopReason.USER)) {
      stopped += 1;
    }
  }
  return stopped;
}

function runNotFound(): ApiResponse<never> {
  return { status: 404, error: "Visualization not found", error_reason: ErrorReason.NOT_FOUND };
}

function conflict(message: string): ApiResponse<never> {
  return { status: 409, error: message, error_reason: ErrorReason.CONFLICT };
}
