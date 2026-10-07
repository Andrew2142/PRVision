/**
 * Recovery of harness library jobs (16 §10.8), like 07's visualization recovery: at boot (before the library workers
 * take jobs) every active job is failed and the scratch worktrees and renders are removed; a periodic sweep fails
 * queued jobs whose BullMQ job is gone and active jobs whose BullMQ job is not active.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  LIBRARY_JOBS_DIR_NAME,
  QUEUED_RECOVERY_GRACE_MS,
  RECOVERY_BATCH_LIMIT,
  RECOVERY_SWEEP_INTERVAL_MS,
  RUNNING_RECOVERY_GRACE_MS
} from "../../config-consts";
import { ACTIVE_LIBRARY_JOB_STATUSES, ConsoleLevel, LibraryJobStatus, Table } from "../../enums";
import { HarnessLibraryJobModel, RepositoryModel } from "../../models";
import {
  ArtifactStore,
  DrizzleDb,
  GitClient,
  QueryHandler,
  QueueService,
  Where,
  createLogger,
  type Transaction
} from "../../utilities";
import { transitionLibraryJob } from "./library-job-state";
import { REPAIR_WORKTREE_PREFIX, SCAN_WORKTREE_PREFIX } from "./library-workspace";
import { SCAN_RENDERS_DIR_NAME } from "./scan-render-adapters";

export const SCAN_RESTARTED_MESSAGE =
  "PRVision restarted while this scan was running. Continue scan to write the rest.";
export const REPAIR_RESTARTED_MESSAGE = "PRVision restarted during the repair. Run Repair again.";
export const LOST_LIBRARY_JOB_MESSAGE = "The job was lost; start it again.";

/** Active statuses a worker owns (queued jobs are owned by BullMQ until a worker picks them up). */
const PROCESSING_STATUSES = ACTIVE_LIBRARY_JOB_STATUSES.filter((status) => status !== "queued");
const JOB_GONE_STATES: readonly string[] = ["missing", "completed", "failed"];
const LIBRARY_WORKTREE_DIR = new RegExp(`^(?:${SCAN_WORKTREE_PREFIX}|${REPAIR_WORKTREE_PREFIX})[1-9]\\d*$`);
const JOB_DIR = /^[1-9]\d*$/;

/** What boot recovery did (logged by worker.ts). */
export interface LibraryRecoveryReport {
  failedActive: number[];
  failedLostQueued: number[];
  removedWorktrees: string[];
  removedRenderDirs: string[];
}

export interface LibraryJobRecoveryDependencies {
  queryHandler: QueryHandler;
  /** DrizzleDb.transaction. */
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** new QueryHandler(tx). */
  createQueryHandler: (tx: Transaction) => QueryHandler;
  queue: Pick<typeof QueueService, "getLibraryJobState">;
  git: Pick<GitClient, "worktreePrune">;
  /** `<dataDir>/worktrees`. */
  worktreesRoot: string;
  /** `<dataDir>/library-jobs`. */
  libraryJobsRoot: string;
  now: () => Date;
  /** RECOVERY_SWEEP_INTERVAL_MS. */
  intervalMs: number;
}

function restartedMessage(kind: string): string {
  return kind === "repair" ? REPAIR_RESTARTED_MESSAGE : SCAN_RESTARTED_MESSAGE;
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

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Boot recovery and the periodic sweep of library jobs. Every step is isolated and never blocks the worker. */
export class LibraryJobRecovery {
  private readonly deps: LibraryJobRecoveryDependencies;
  private readonly log = createLogger("library-recovery");

  constructor(deps: Partial<LibraryJobRecoveryDependencies> = {}) {
    this.deps = {
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      transaction: deps.transaction ?? ((fn) => DrizzleDb.transaction(fn)),
      createQueryHandler: deps.createQueryHandler ?? ((tx) => new QueryHandler(tx)),
      queue: deps.queue ?? QueueService,
      git: deps.git ?? new GitClient(),
      worktreesRoot: deps.worktreesRoot ?? new ArtifactStore().worktreesRoot(),
      libraryJobsRoot: deps.libraryJobsRoot ?? path.join(DATA_DIR, LIBRARY_JOBS_DIR_NAME),
      now: deps.now ?? ((): Date => new Date()),
      intervalMs: deps.intervalMs ?? RECOVERY_SWEEP_INTERVAL_MS
    };
  }

  /** Boot recovery (16 §10.8). Runs before the library workers start; never throws. */
  async recoverOnBoot(): Promise<LibraryRecoveryReport> {
    const report: LibraryRecoveryReport = {
      failedActive: [],
      failedLostQueued: [],
      removedWorktrees: [],
      removedRenderDirs: []
    };
    const now = this.deps.now();

    // 1. Jobs a worker was processing (preparing, running) → failed: no library job runs in this process yet.
    //    Queued jobs keep waiting in BullMQ; step 5 fails only those whose BullMQ job is gone (07's rule).
    await this.step("fail_active", async () => {
      const jobs = await this.deps.queryHandler.selectMany(
        HarnessLibraryJobModel,
        { status: Where.in([...PROCESSING_STATUSES]) },
        Table.HARNESS_LIBRARY_JOBS,
        { limit: RECOVERY_BATCH_LIMIT }
      );
      for (const job of jobs) {
        if (await this.failJob(job, restartedMessage(job.kind), now, "boot")) {
          report.failedActive.push(job.id);
        }
      }
    });

    // 2. Scan and repair worktrees (fs.rm never follows the node_modules symlinks inside them).
    await this.step("remove_worktrees", async () => {
      for (const name of (await readDirOrEmpty(this.deps.worktreesRoot)).sort()) {
        const target = path.join(this.deps.worktreesRoot, name);
        const stats = await fs.lstat(target);
        if (!LIBRARY_WORKTREE_DIR.test(name) || stats.isSymbolicLink() || !stats.isDirectory()) {
          continue;
        }
        await fs.rm(target, { recursive: true, force: true });
        report.removedWorktrees.push(name);
      }
    });

    // 3. Scratch renders of every job folder.
    await this.step("remove_renders", async () => {
      for (const name of (await readDirOrEmpty(this.deps.libraryJobsRoot)).sort()) {
        if (!JOB_DIR.test(name)) {
          continue;
        }
        const renders = path.join(this.deps.libraryJobsRoot, name, SCAN_RENDERS_DIR_NAME);
        const stats = await fs.lstat(renders).catch(() => null);
        if (stats === null) {
          continue;
        }
        await fs.rm(renders, { recursive: true, force: true });
        report.removedRenderDirs.push(name);
      }
    });

    // 4. Dangling worktree metadata in every registered clone.
    await this.step("prune_worktrees", async () => {
      const repositories = await this.deps.queryHandler.selectMany(RepositoryModel, {}, Table.REPOSITORIES, {
        limit: RECOVERY_BATCH_LIMIT
      });
      for (const repository of repositories) {
        if (await isDirectory(repository.localPath)) {
          await this.step("prune_worktrees", () => this.deps.git.worktreePrune(repository.localPath));
        }
      }
    });

    // 5. Queued jobs whose BullMQ job is gone.
    await this.step("fail_lost_queued", async () => {
      report.failedLostQueued.push(...(await this.failLostQueued(now)));
    });
    return report;
  }

  /** Starts the periodic sweep (unref'd interval; overlapping ticks are skipped). */
  startSweep(): { stop(): void } {
    let running = false;
    const tick = async (): Promise<void> => {
      running = true;
      try {
        await this.sweepOnce();
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      if (running) {
        return;
      }
      tick().catch((error: unknown) => {
        this.log.warn({ event: "library.recovery.sweep_failed", err: error }, "Library recovery sweep failed");
      });
    }, this.deps.intervalMs);
    timer.unref();
    return {
      stop: () => {
        clearInterval(timer);
      }
    };
  }

  /** One sweep: lost queued jobs, then preparing/running jobs whose BullMQ job is not active. */
  async sweepOnce(): Promise<void> {
    const now = this.deps.now();
    await this.step("fail_lost_queued", async () => {
      await this.failLostQueued(now);
    });
    await this.step("fail_running_without_job", async () => {
      const jobs = await this.deps.queryHandler.selectMany(
        HarnessLibraryJobModel,
        {
          status: Where.in([...PROCESSING_STATUSES]),
          updatedAt: Where.lt(new Date(now.getTime() - RUNNING_RECOVERY_GRACE_MS))
        },
        Table.HARNESS_LIBRARY_JOBS,
        { limit: RECOVERY_BATCH_LIMIT }
      );
      for (const job of jobs) {
        const state = await this.deps.queue.getLibraryJobState(job.kind, job.id);
        if (state === "active") {
          continue;
        }
        await this.failJob(job, restartedMessage(job.kind), now, "sweep");
      }
    });
  }

  private async failLostQueued(now: Date): Promise<number[]> {
    const failed: number[] = [];
    const jobs = await this.deps.queryHandler.selectMany(
      HarnessLibraryJobModel,
      {
        status: LibraryJobStatus.QUEUED,
        createdAt: Where.lt(new Date(now.getTime() - QUEUED_RECOVERY_GRACE_MS))
      },
      Table.HARNESS_LIBRARY_JOBS,
      { limit: RECOVERY_BATCH_LIMIT }
    );
    for (const job of jobs) {
      const state = await this.deps.queue.getLibraryJobState(job.kind, job.id);
      if (!JOB_GONE_STATES.includes(state)) {
        continue; // waiting, delayed, prioritized or active
      }
      if (await this.failJob(job, LOST_LIBRARY_JOB_MESSAGE, now, "lost_queued")) {
        failed.push(job.id);
      }
    }
    return failed;
  }

  /** Guarded transition to failed plus one error event, in one transaction. False when the guard lost. */
  private async failJob(job: HarnessLibraryJobModel, message: string, now: Date, reason: string): Promise<boolean> {
    return this.deps.transaction(async (tx) => {
      const qh = this.deps.createQueryHandler(tx);
      const ok = await transitionLibraryJob(qh, {
        jobId: job.id,
        from: job.status,
        to: LibraryJobStatus.FAILED,
        fields: { errorMessage: message, currentLabel: null },
        now
      });
      if (!ok) {
        return false;
      }
      const inserted = await qh.insert(
        { jobId: job.id, level: ConsoleLevel.ERROR, message },
        Table.HARNESS_LIBRARY_JOB_EVENTS
      );
      if (inserted.status !== 200) {
        throw new Error(`Recovery event insert failed (${String(inserted.status)})`); // rolls back
      }
      this.log.warn(
        { event: "library.recovery.job_failed", jobId: job.id, kind: job.kind, status: job.status, reason },
        "Library job failed by recovery"
      );
      return true;
    });
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error: unknown) {
      this.log.warn({ event: "library.recovery.step_failed", step: name, err: error }, "Library recovery step failed");
    }
  }
}
