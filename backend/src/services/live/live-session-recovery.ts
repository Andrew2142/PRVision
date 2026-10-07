/**
 * Recovery of live sessions (16 §12.7). At worker boot (before the live worker takes jobs) every session still
 * `starting`, `ready` or `stopping` is failed (no live job runs in this process yet), the live worktree folders are
 * removed and the clones' worktree metadata pruned. A periodic sweep fails `starting` sessions older than
 * LIVE_START_TIMEOUT_MS whose job is not active, and closes `stopping` sessions whose job is gone.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  LIVE_START_TIMEOUT_MS,
  RECOVERY_BATCH_LIMIT,
  RECOVERY_SWEEP_INTERVAL_MS,
  RUNNING_RECOVERY_GRACE_MS
} from "../../config-consts";
import { ACTIVE_LIVE_SESSION_STATUSES, LiveSessionStatus, LiveStopReason, Table } from "../../enums";
import { LiveSessionModel, RepositoryModel } from "../../models";
import { ArtifactStore, GitClient, QueryHandler, QueueService, Where, createLogger } from "../../utilities";
import { LIVE_WORKTREE_PREFIX } from "./live-session-worker-service";

export const LIVE_RESTARTED_MESSAGE = "PRVision restarted; start live mode again.";
export const LIVE_START_LOST_MESSAGE = "Live mode did not start in time; start it again.";

const LIVE_WORKTREE_DIR = new RegExp(`^${LIVE_WORKTREE_PREFIX}[1-9]\\d*$`);

/** What boot recovery did (logged by worker.ts). */
export interface LiveRecoveryReport {
  failedSessions: number[];
  removedFolders: string[];
}

export interface LiveSessionRecoveryDependencies {
  queryHandler: QueryHandler;
  queue: Pick<typeof QueueService, "getLiveSessionJobState">;
  git: Pick<GitClient, "worktreePrune">;
  /** `<dataDir>/worktrees`. */
  worktreesRoot: string;
  now: () => Date;
  /** RECOVERY_SWEEP_INTERVAL_MS. */
  intervalMs: number;
  /** LIVE_START_TIMEOUT_MS. */
  startTimeoutMs: number;
}

async function readDirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Boot recovery and the periodic sweep of live sessions. Every step is isolated and never blocks the worker. */
export class LiveSessionRecovery {
  private readonly deps: LiveSessionRecoveryDependencies;
  private readonly log = createLogger("live-recovery");

  constructor(deps: Partial<LiveSessionRecoveryDependencies> = {}) {
    this.deps = {
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      queue: deps.queue ?? QueueService,
      git: deps.git ?? new GitClient(),
      worktreesRoot: deps.worktreesRoot ?? new ArtifactStore().worktreesRoot(),
      now: deps.now ?? ((): Date => new Date()),
      intervalMs: deps.intervalMs ?? RECOVERY_SWEEP_INTERVAL_MS,
      startTimeoutMs: deps.startTimeoutMs ?? LIVE_START_TIMEOUT_MS
    };
  }

  /** Boot recovery (16 §12.7). Runs before the live worker starts; never throws. */
  async recoverOnBoot(): Promise<LiveRecoveryReport> {
    const report: LiveRecoveryReport = { failedSessions: [], removedFolders: [] };
    const now = this.deps.now();

    // 1. Every active session → failed (their hosts died with the previous worker process).
    await this.step("fail_active", async () => {
      const sessions = await this.deps.queryHandler.selectMany(
        LiveSessionModel,
        { status: Where.in([...ACTIVE_LIVE_SESSION_STATUSES]) },
        Table.LIVE_SESSIONS,
        { limit: RECOVERY_BATCH_LIMIT }
      );
      for (const session of sessions) {
        if (await this.fail(session, LIVE_RESTARTED_MESSAGE, now, "boot")) {
          report.failedSessions.push(session.id);
        }
      }
    });

    // 2. Live worktree folders (fs.rm never follows the node_modules symlinks inside them).
    await this.step("remove_folders", async () => {
      for (const name of (await readDirOrEmpty(this.deps.worktreesRoot)).sort()) {
        const target = path.join(this.deps.worktreesRoot, name);
        const stats = await fs.lstat(target);
        if (!LIVE_WORKTREE_DIR.test(name) || stats.isSymbolicLink() || !stats.isDirectory()) {
          continue;
        }
        await fs.rm(target, { recursive: true, force: true });
        report.removedFolders.push(name);
      }
    });

    // 3. Dangling worktree metadata in every registered clone.
    await this.step("prune_worktrees", async () => {
      const repositories = await this.deps.queryHandler.selectMany(RepositoryModel, {}, Table.REPOSITORIES, {
        limit: RECOVERY_BATCH_LIMIT
      });
      for (const repository of repositories) {
        const isDir = await fs
          .stat(repository.localPath)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (isDir) {
          await this.step("prune_worktrees", () => this.deps.git.worktreePrune(repository.localPath));
        }
      }
    });
    return report;
  }

  /** Starts the periodic sweep (unref'd interval; overlapping ticks are skipped). */
  startSweep(): { stop(): void } {
    let running = false;
    const timer = setInterval(() => {
      if (running) {
        return;
      }
      running = true;
      this.sweepOnce()
        .catch((error: unknown) => {
          this.log.warn({ event: "live.recovery.sweep_failed", err: error }, "Live recovery sweep failed");
        })
        .finally(() => {
          running = false;
        });
    }, this.deps.intervalMs);
    timer.unref();
    return {
      stop: () => {
        clearInterval(timer);
      }
    };
  }

  /**
   * One sweep: `starting` sessions older than the start timeout whose job is not active → failed; `stopping` sessions
   * whose job is gone → stopped (their worker can no longer finish them).
   */
  async sweepOnce(): Promise<void> {
    const now = this.deps.now();
    await this.step("fail_stuck_starting", async () => {
      const sessions = await this.deps.queryHandler.selectMany(
        LiveSessionModel,
        {
          status: LiveSessionStatus.STARTING,
          createdAt: Where.lt(new Date(now.getTime() - this.deps.startTimeoutMs))
        },
        Table.LIVE_SESSIONS,
        { limit: RECOVERY_BATCH_LIMIT }
      );
      for (const session of sessions) {
        if ((await this.deps.queue.getLiveSessionJobState(session.id)) !== "active") {
          await this.fail(session, LIVE_START_LOST_MESSAGE, now, "sweep");
        }
      }
    });
    await this.step("close_orphaned_stopping", async () => {
      const sessions = await this.deps.queryHandler.selectMany(
        LiveSessionModel,
        {
          status: LiveSessionStatus.STOPPING,
          updatedAt: Where.lt(new Date(now.getTime() - RUNNING_RECOVERY_GRACE_MS))
        },
        Table.LIVE_SESSIONS,
        { limit: RECOVERY_BATCH_LIMIT }
      );
      for (const session of sessions) {
        if ((await this.deps.queue.getLiveSessionJobState(session.id)) === "active") {
          continue;
        }
        const updated = await this.deps.queryHandler.update(
          { status: LiveSessionStatus.STOPPED, stoppedAt: now },
          { id: session.id, status: LiveSessionStatus.STOPPING },
          Table.LIVE_SESSIONS
        );
        if (updated.status === 200) {
          this.log.warn(
            {
              event: "live.session.transition",
              sessionId: session.id,
              from: "stopping",
              to: "stopped",
              reason: "sweep"
            },
            "Orphaned stopping live session closed"
          );
        }
      }
    });
  }

  /** Guarded → failed with the message. False when another writer moved the row first. */
  private async fail(session: LiveSessionModel, message: string, now: Date, reason: string): Promise<boolean> {
    const updated = await this.deps.queryHandler.update(
      { status: LiveSessionStatus.FAILED, stopReason: LiveStopReason.ERROR, errorMessage: message, stoppedAt: now },
      { id: session.id, status: session.status },
      Table.LIVE_SESSIONS
    );
    if (updated.status === 200) {
      this.log.warn(
        { event: "live.session.transition", sessionId: session.id, from: session.status, to: "failed", reason },
        "Live session failed by recovery"
      );
      return true;
    }
    if (updated.status !== 404) {
      throw new Error(`live_sessions recovery update failed (${String(updated.status)})`);
    }
    return false;
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error: unknown) {
      this.log.warn({ event: "live.recovery.step_failed", step: name, err: error }, "Live recovery step failed");
    }
  }
}
