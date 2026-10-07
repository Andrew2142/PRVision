/**
 * Live session job processor (16 §12.3, D10, E19). Runs in the worker on the `live-sessions` queue: recreates the
 * run's base and head worktrees from its commits and saved snapshot, writes every harness of the run into both
 * sides, marks the session ready, then polls the row every LIVE_POLL_INTERVAL_MS. Open requests start hosts per
 * (side, render group); the session stops on an API stop, 90 s without heartbeat (left), 10 minutes without activity
 * (idle), 4 hours, or worker shutdown. Every path ends with hosts stopped and the worktrees removed.
 *
 * Column ownership (16 §6.9): this worker writes `status` (except the API's → stopping), `hosts`, `error_message`,
 * `stop_reason` (worker-detected stops), `ready_at`, `stopped_at`, and drains `open_requests` with the
 * `open_requests_version` guard. Every update names only its own columns.
 */
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  LIVE_HEARTBEAT_LOSS_MS,
  LIVE_IDLE_TIMEOUT_MS,
  LIVE_MAX_SESSION_MS,
  LIVE_POLL_INTERVAL_MS,
  LIVE_START_TIMEOUT_MS
} from "../../config-consts";
import { LiveSessionStatus, LiveStopReason, Table } from "../../enums";
import { LiveSessionModel, RepositoryModel, VisualizationComponentModel, VisualizationModel } from "../../models";
import type { LiveHostState } from "../../types/harness-library";
import { isPipelineStepError, type PipelineContext, type PreparedWorkspace } from "../../types/visualization-pipeline";
import { ArtifactStore, QueryHandler, Where, createLogger, resolveInside, type LiveSessionJob } from "../../utilities";
import { RunWorkspaceRecreator, type RecreatedWorkspace } from "../visualizations/run-workspace-recreator";
import {
  LiveHostManager,
  buildLivePlan,
  createLiveHostBackend,
  defaultLiveFrontendOrigins,
  hostErrorText,
  type LiveBackendContext,
  type LiveHostBackend,
  type LiveHostManagerOptions
} from "./live-host-manager";

/** Prefix of live worktree folders in `<dataDir>/worktrees` (`GitClient.worktreeAdd` refuses other roots). */
export const LIVE_WORKTREE_PREFIX = "live-";

export const LIVE_START_TIMEOUT_MESSAGE = "Could not prepare the before and after code in time.";
export const LIVE_RUN_REMOVED_MESSAGE = "The run was removed.";
export const LIVE_REPOSITORY_REMOVED_MESSAGE = "The repository was removed.";
export const LIVE_NOTHING_TO_SHOW_MESSAGE = "This run has no rendered components to show live.";
export const LIVE_UNEXPECTED_MESSAGE = "Live mode failed unexpectedly. See the worker log for details.";

/** How one run() call ended. "skipped": the row was not a starting session (nothing was touched). */
export type LiveSessionOutcome = "stopped" | "failed" | "skipped";

/** What the session job needs from its host manager (tests pass a fake). */
export type LiveHostManagerPort = Pick<LiveHostManager, "open" | "checkHealth" | "stopAll" | "snapshot">;

/** Timing limits (16 §16.3); tests shrink them. */
export interface LiveSessionLimits {
  pollIntervalMs: number;
  heartbeatLossMs: number;
  idleTimeoutMs: number;
  maxSessionMs: number;
  startTimeoutMs: number;
}

/** Everything the processor talks to; tests replace any subset. */
export interface LiveSessionWorkerDependencies {
  queryHandler: QueryHandler;
  recreator: Pick<RunWorkspaceRecreator, "recreate">;
  createBackend: (ctx: LiveBackendContext) => LiveHostBackend;
  createHostManager: (options: LiveHostManagerOptions) => LiveHostManagerPort;
  /** `<dataDir>/worktrees`. */
  worktreesRoot: string;
  /** FRONTEND_URL origin and its loopback twin. */
  frontendOrigins: string[];
  now: () => Date;
  /** Resolves after `ms` or as soon as `signal` aborts; never rejects. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  limits: LiveSessionLimits;
}

/** Abort reason of the start timeout. */
class LiveStartTimeoutError extends Error {
  override readonly name = "LiveStartTimeoutError";
}

/** Abort reason when the API stopped the session while it was starting. */
class LiveStopDuringStartError extends Error {
  override readonly name = "LiveStopDuringStartError";
}

/** A user-facing failure of the session. */
class LiveSessionFailure extends Error {
  override readonly name = "LiveSessionFailure";
}

const ACTIVE_BEFORE_STOP: readonly LiveSessionStatus[] = [LiveSessionStatus.STARTING, LiveSessionStatus.READY];

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal, ref: false });
  } catch {
    // Aborted: the caller checks the signal.
  }
}

/** The live session job (16 §12.3). One instance per job. */
export class LiveSessionWorkerService {
  private readonly deps: LiveSessionWorkerDependencies;
  private readonly log = createLogger("live");

  constructor(deps: Partial<LiveSessionWorkerDependencies> = {}) {
    this.deps = {
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      recreator: deps.recreator ?? new RunWorkspaceRecreator(),
      createBackend: deps.createBackend ?? createLiveHostBackend,
      createHostManager: deps.createHostManager ?? ((options) => new LiveHostManager(options)),
      worktreesRoot: deps.worktreesRoot ?? new ArtifactStore().worktreesRoot(),
      frontendOrigins: deps.frontendOrigins ?? defaultLiveFrontendOrigins(),
      now: deps.now ?? ((): Date => new Date()),
      sleep: deps.sleep ?? defaultSleep,
      limits: deps.limits ?? {
        pollIntervalMs: LIVE_POLL_INTERVAL_MS,
        heartbeatLossMs: LIVE_HEARTBEAT_LOSS_MS,
        idleTimeoutMs: LIVE_IDLE_TIMEOUT_MS,
        maxSessionMs: LIVE_MAX_SESSION_MS,
        startTimeoutMs: LIVE_START_TIMEOUT_MS
      }
    };
  }

  /** `<dataDir>/worktrees/live-<sessionId>`. */
  liveRoot(sessionId: number): string {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new Error(`Invalid live session id ${String(sessionId)}`);
    }
    return resolveInside(this.deps.worktreesRoot, `${LIVE_WORKTREE_PREFIX}${String(sessionId)}`);
  }

  /**
   * Runs the session until it stops. Never throws for session failures (recorded on the row); rethrows only when the
   * row cannot be loaded at all (DB down), so BullMQ marks the job failed and recovery fixes the row later.
   */
  async run(job: LiveSessionJob): Promise<LiveSessionOutcome> {
    const sessionId = job.liveSessionId;
    const row = await this.loadSession(sessionId);
    if (row === null) {
      this.log.warn({ event: "live.session.skipped", sessionId, status: null }, "Live session row missing");
      return "skipped";
    }
    if (row.status === LiveSessionStatus.STOPPING) {
      // Stopped by the API before the job started: nothing to release.
      await this.finishStopped(sessionId, null, []);
      return "stopped";
    }
    if (row.status !== LiveSessionStatus.STARTING) {
      this.log.warn({ event: "live.session.skipped", sessionId, status: row.status }, "Live session is not starting");
      return "skipped";
    }

    const hosts = new HostsWriter(this.deps.queryHandler, sessionId, this.log);
    let recreated: RecreatedWorkspace | null = null;
    let manager: LiveHostManagerPort | null = null;
    let outcome: LiveSessionOutcome = "stopped";
    let workerReason: LiveStopReason | null = null;
    let failure: string | null = null;
    try {
      const started = await this.startSession(row, hosts, job.signal);
      recreated = started.recreated;
      manager = started.manager;
      if (started.stop !== null) {
        workerReason = started.stop;
      } else {
        const ready = await this.transition(sessionId, ACTIVE_BEFORE_STOP, LiveSessionStatus.READY, {
          readyAt: this.deps.now()
        });
        workerReason = ready ? await this.loop(sessionId, manager, job.signal) : null;
      }
    } catch (error: unknown) {
      if (error instanceof LiveStopDuringStartError) {
        workerReason = null; // the API's stop_reason stays
      } else if (job.signal.aborted && !(error instanceof LiveSessionFailure)) {
        workerReason = LiveStopReason.SHUTDOWN;
      } else {
        outcome = "failed";
        failure = this.failureMessage(error);
        this.log.warn({ event: "live.session.failed", sessionId, message: failure, err: error }, "Live session failed");
      }
    } finally {
      if (outcome === "stopped") {
        await this.transition(sessionId, ACTIVE_BEFORE_STOP, LiveSessionStatus.STOPPING, {
          ...(workerReason !== null ? { stopReason: workerReason } : {})
        });
      }
      if (manager !== null) {
        await manager.stopAll(); // never throws
      }
      if (recreated !== null) {
        await recreated.cleanup(); // never throws: worktrees removed, pruned, folder deleted
      } else {
        await this.removeLiveRoot(sessionId);
      }
      await hosts.drain();
      const finalHosts = manager?.snapshot() ?? [];
      if (outcome === "failed") {
        await this.finishFailed(sessionId, failure ?? LIVE_UNEXPECTED_MESSAGE, finalHosts);
      } else {
        await this.finishStopped(sessionId, workerReason, finalHosts);
      }
    }
    return outcome;
  }

  // ----- start (16 §12.3 steps 1–3) -----

  private async startSession(
    row: LiveSessionModel,
    hosts: HostsWriter,
    jobSignal: AbortSignal
  ): Promise<{ recreated: RecreatedWorkspace; manager: LiveHostManagerPort; stop: LiveStopReason | null }> {
    const sessionId = row.id;
    const start = new AbortController();
    const timer = setTimeout(() => {
      start.abort(new LiveStartTimeoutError(LIVE_START_TIMEOUT_MESSAGE));
    }, this.deps.limits.startTimeoutMs);
    timer.unref();
    // While preparing, an API stop aborts the start (the poll loop has not started yet).
    const watcher = setInterval(() => {
      this.loadSession(sessionId)
        .then((current) => {
          if (current === null || current.status === LiveSessionStatus.STOPPING) {
            start.abort(new LiveStopDuringStartError("stopped"));
          }
        })
        .catch((error: unknown) => {
          this.log.warn({ event: "live.session.watch_failed", sessionId, err: error }, "Live start watch failed");
        });
    }, this.deps.limits.pollIntervalMs);
    watcher.unref();
    const signal = AbortSignal.any([jobSignal, start.signal]);
    let recreated: RecreatedWorkspace | null = null;
    try {
      const visualization = await this.deps.queryHandler.validateAndSelect(
        VisualizationModel,
        { id: row.visualizationId },
        Table.VISUALIZATIONS
      );
      if (visualization === null) {
        throw new LiveSessionFailure(LIVE_RUN_REMOVED_MESSAGE);
      }
      const repository = await this.deps.queryHandler.validateAndSelect(
        RepositoryModel,
        { id: visualization.repositoryId },
        Table.REPOSITORIES
      );
      if (repository === null) {
        throw new LiveSessionFailure(LIVE_REPOSITORY_REMOVED_MESSAGE);
      }
      recreated = await this.deps.recreator.recreate({
        visualization,
        repository,
        rootDir: this.liveRoot(sessionId),
        console: this.logConsole(sessionId),
        signal
      });
      this.throwIfStartAborted(signal);
      const rows = await this.deps.queryHandler.selectMany(
        VisualizationComponentModel,
        { visualizationId: visualization.id },
        Table.VISUALIZATION_COMPONENTS,
        {
          orderBy: [
            { column: "rank", direction: "asc" },
            { column: "id", direction: "asc" }
          ]
        }
      );
      const plan = buildLivePlan(rows, repository);
      if (plan.items.length === 0) {
        throw new LiveSessionFailure(LIVE_NOTHING_TO_SHOW_MESSAGE);
      }
      const stripPaths = stripPathsOf(recreated.workspace, repository.localPath);
      const backend = this.deps.createBackend({
        repository,
        workspace: recreated.workspace,
        frontendOrigins: this.deps.frontendOrigins,
        stripPaths
      });
      try {
        await backend.prepare(plan, signal);
      } catch (error: unknown) {
        this.throwIfStartAborted(signal);
        await backend.close();
        throw new LiveSessionFailure(`Could not write the live harness files: ${hostErrorText(error, stripPaths)}`, {
          cause: error
        });
      }
      this.throwIfStartAborted(signal);
      const manager = this.deps.createHostManager({
        sessionId,
        plan,
        backend,
        stripPaths,
        now: this.deps.now,
        onChange: (list) => {
          hosts.write(list);
        }
      });
      this.log.info(
        { event: "live.session.prepared", sessionId, components: plan.items.length, groups: plan.groups.length },
        "Live session prepared"
      );
      return { recreated, manager, stop: null };
    } catch (error: unknown) {
      if (recreated !== null) {
        await recreated.cleanup();
      }
      throw this.startError(error, signal, jobSignal);
    } finally {
      clearTimeout(timer);
      clearInterval(watcher);
    }
  }

  private throwIfStartAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
    }
  }

  /** Maps an abort during the start to its cause (stop, shutdown, timeout); other errors pass through. */
  private startError(error: unknown, signal: AbortSignal, jobSignal: AbortSignal): unknown {
    if (!signal.aborted) {
      return error;
    }
    if (jobSignal.aborted) {
      return error; // run() maps a shutdown abort to stop reason "shutdown"
    }
    const reason: unknown = signal.reason;
    if (reason instanceof LiveStopDuringStartError) {
      return reason;
    }
    if (reason instanceof LiveStartTimeoutError) {
      return new LiveSessionFailure(LIVE_START_TIMEOUT_MESSAGE, { cause: error });
    }
    return error;
  }

  // ----- poll loop (16 §12.3 step 4) -----

  private async loop(
    sessionId: number,
    manager: LiveHostManagerPort,
    signal: AbortSignal
  ): Promise<LiveStopReason | null> {
    const limits = this.deps.limits;
    for (;;) {
      if (signal.aborted) {
        return LiveStopReason.SHUTDOWN;
      }
      const row = await this.loadSession(sessionId);
      if (row === null) {
        return LiveStopReason.USER; // the run (and its sessions) was hard-deleted
      }
      if (row.status !== LiveSessionStatus.READY) {
        return null; // stopping (the API's stop_reason stays) or moved by recovery
      }
      const now = this.deps.now().getTime();
      if (now - row.lastHeartbeatAt.getTime() > limits.heartbeatLossMs) {
        return LiveStopReason.LEFT;
      }
      if (now - row.lastActivityAt.getTime() > limits.idleTimeoutMs) {
        return LiveStopReason.IDLE;
      }
      if (now - row.createdAt.getTime() > limits.maxSessionMs) {
        return LiveStopReason.MAX_DURATION;
      }
      await this.drainOpenRequests(row, manager);
      manager.checkHealth();
      await this.deps.sleep(limits.pollIntervalMs, signal);
    }
  }

  /**
   * Takes the queued open requests: writes `[]` with version + 1 guarded by the version read in this tick. A
   * concurrent append makes the update miss; the next tick re-reads and nothing is lost.
   */
  private async drainOpenRequests(row: LiveSessionModel, manager: LiveHostManagerPort): Promise<void> {
    const requests = Array.isArray(row.openRequests) ? row.openRequests : [];
    if (requests.length === 0) {
      return;
    }
    const drained = await this.deps.queryHandler.update(
      { openRequests: [], openRequestsVersion: row.openRequestsVersion + 1 },
      { id: row.id, openRequestsVersion: row.openRequestsVersion },
      Table.LIVE_SESSIONS
    );
    if (drained.status === 404) {
      return;
    }
    if (drained.status !== 200) {
      throw new Error(`live_sessions drain failed (${String(drained.status)})`);
    }
    const seen = new Set<number>();
    for (const request of requests) {
      if (seen.has(request.componentId)) {
        continue;
      }
      seen.add(request.componentId);
      const opened = manager.open(request.componentId);
      if (!opened.known) {
        this.log.warn(
          { event: "live.request.unknown_component", sessionId: row.id, componentId: request.componentId },
          "Open request for a component without a live harness ignored"
        );
      }
      opened.done.catch((error: unknown) => {
        this.log.warn({ event: "live.host.open_failed", sessionId: row.id, err: error }, "Opening a live host failed");
      });
    }
  }

  // ----- row writes -----

  private async loadSession(sessionId: number): Promise<LiveSessionModel | null> {
    return this.deps.queryHandler.validateAndSelect(LiveSessionModel, { id: sessionId }, Table.LIVE_SESSIONS);
  }

  /** Guarded status change (`where status in from`); false when another writer moved the row first. */
  private async transition(
    sessionId: number,
    from: readonly LiveSessionStatus[],
    to: LiveSessionStatus,
    fields: Record<string, unknown> = {}
  ): Promise<boolean> {
    try {
      const result = await this.deps.queryHandler.update(
        { ...fields, status: to },
        { id: sessionId, status: Where.in([...from]) },
        Table.LIVE_SESSIONS
      );
      if (result.status === 200) {
        this.log.info(
          {
            event: "live.session.transition",
            sessionId,
            from: from.join("|"),
            to,
            reason: typeof fields.stopReason === "string" ? fields.stopReason : null
          },
          "Live session transition"
        );
        return true;
      }
      if (result.status !== 404) {
        this.log.warn({ event: "live.session.update_failed", sessionId, status: result.status }, "Update failed");
      }
      return false;
    } catch (error: unknown) {
      this.log.warn({ event: "live.session.update_failed", sessionId, err: error }, "Live session update failed");
      return false;
    }
  }

  private async finishStopped(sessionId: number, reason: LiveStopReason | null, hosts: LiveHostState[]): Promise<void> {
    await this.transition(
      sessionId,
      [LiveSessionStatus.STARTING, LiveSessionStatus.READY, LiveSessionStatus.STOPPING],
      LiveSessionStatus.STOPPED,
      // reason null: the API's stop wrote stop_reason with → stopping (16 §6.9 column ownership).
      { stoppedAt: this.deps.now(), hosts, ...(reason !== null ? { stopReason: reason } : {}) }
    );
  }

  private async finishFailed(sessionId: number, message: string, hosts: LiveHostState[]): Promise<void> {
    await this.transition(
      sessionId,
      [LiveSessionStatus.STARTING, LiveSessionStatus.READY, LiveSessionStatus.STOPPING],
      LiveSessionStatus.FAILED,
      { errorMessage: message, stopReason: LiveStopReason.ERROR, stoppedAt: this.deps.now(), hosts }
    );
  }

  private failureMessage(error: unknown): string {
    if (error instanceof LiveSessionFailure) {
      return error.message;
    }
    if (isPipelineStepError(error)) {
      return error.userMessage;
    }
    return LIVE_UNEXPECTED_MESSAGE;
  }

  /** Removes `<dataDir>/worktrees/live-<id>` when the recreator never returned (it cleans up after itself). */
  private async removeLiveRoot(sessionId: number): Promise<void> {
    try {
      await fs.rm(this.liveRoot(sessionId), { recursive: true, force: true });
    } catch (error: unknown) {
      this.log.warn({ event: "live.session.cleanup_failed", sessionId, err: error }, "Live folder removal failed");
    }
  }

  /** The recreator's console: structured logs only (live sessions have no event table). */
  private logConsole(sessionId: number): PipelineContext["console"] {
    const write = (level: "info" | "warn" | "error", stage: string, message: string): Promise<void> => {
      this.log[level]({ event: "live.session.console", sessionId, stage }, message);
      return Promise.resolve();
    };
    return {
      info: (stage, message) => write("info", stage, message),
      warn: (stage, message) => write("warn", stage, message),
      error: (stage, message) => write("error", stage, message)
    };
  }
}

/** Absolute prefixes removed from user-facing host errors. */
function stripPathsOf(workspace: PreparedWorkspace, localPath: string): string[] {
  return [workspace.baseDir, workspace.headDir, localPath];
}

/**
 * Serialized writes of the `hosts` column: the newest list wins, writes never overlap, and `drain()` waits until the
 * last one landed (before the final status write).
 */
class HostsWriter {
  private pending: LiveHostState[] | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly queryHandler: QueryHandler,
    private readonly sessionId: number,
    private readonly log: ReturnType<typeof createLogger>
  ) {}

  write(hosts: LiveHostState[]): void {
    this.pending = hosts;
    this.running ??= this.flush().finally(() => {
      this.running = null;
    });
  }

  async drain(): Promise<void> {
    while (this.running !== null) {
      await this.running;
    }
  }

  private async flush(): Promise<void> {
    while (this.pending !== null) {
      const hosts = this.pending;
      this.pending = null;
      try {
        const result = await this.queryHandler.update({ hosts }, { id: this.sessionId }, Table.LIVE_SESSIONS);
        if (result.status !== 200 && result.status !== 404) {
          this.log.warn(
            { event: "live.hosts.persist_failed", sessionId: this.sessionId, status: result.status },
            "Host list write failed"
          );
        }
      } catch (error: unknown) {
        this.log.warn(
          { event: "live.hosts.persist_failed", sessionId: this.sessionId, err: error },
          "Host list write failed"
        );
      }
    }
  }
}
