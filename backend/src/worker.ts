import "reflect-metadata";
import { SHUTDOWN_TIMEOUT_MS } from "./config-consts";
import { validateConfig } from "./config-consts/config-validation";
import { assertDatabaseReady } from "./database/schema-readiness";
import {
  ArtifactStore,
  AuthContext,
  DbPool,
  GitClient,
  QueueService,
  RedisPool,
  createLogger,
  describeBootError,
  installGracefulShutdown,
  type LibraryJobProcessor,
  type VisualizationJobProcessor
} from "./utilities";
import { HarnessRepairWorkerService } from "./services/harness-library/harness-repair-worker-service";
import { LibraryJobRecovery } from "./services/harness-library/library-job-recovery";
import { LibraryScanWorkerService } from "./services/harness-library/library-scan-worker-service";
import { VisualizationWorkerService } from "./services/visualizations/pipeline/visualization-worker-service";

const log = createLogger("worker");

/** [07] The pipeline (00 §14.6): job = { visualizationId, jobId, signal }; 04 wraps it in AuthContext.runAsLocalUser. */
const processVisualization: VisualizationJobProcessor = async ({ visualizationId, jobId, signal }) => {
  await new VisualizationWorkerService().run({ visualizationId, jobId, signal });
};

/** [16f] Scan and rescan jobs (16 §10.4): job = { libraryJobId, jobId, signal }. */
const processLibraryScan: LibraryJobProcessor = async (job) => {
  await new LibraryScanWorkerService().run(job);
};

/** [16g] Repair jobs (16 §11.4): job = { libraryJobId, jobId, signal }. */
const processLibraryRepair: LibraryJobProcessor = async (job) => {
  await new HarnessRepairWorkerService().run(job);
};

async function bootstrapWorker(): Promise<void> {
  let sweep: { stop(): void } | null = null; // [07] periodic recovery sweep, started after the worker
  let librarySweep: { stop(): void } | null = null; // [16f] library job recovery sweep
  const shutdown = installGracefulShutdown(
    [
      {
        name: "recovery-sweep", // [07] first step: no recovery write races the shutdown of the active job
        close: () => {
          sweep?.stop();
          librarySweep?.stop(); // [16f]
          return Promise.resolve();
        }
      },
      { name: "queues", close: () => QueueService.close() }, // aborts the active job ("shutdown"), then closes worker + queue
      { name: "redis", close: () => RedisPool.disconnect() },
      { name: "postgres", close: () => DbPool.close() } // last: the aborted job still writes its final status
    ],
    { role: "worker", timeoutMs: SHUTDOWN_TIMEOUT_MS }
  );

  try {
    validateConfig();
    await new ArtifactStore().ensureRoots();
    await new GitClient().assertSupportedVersion();
    await DbPool.ping();
    await assertDatabaseReady(DbPool.getInstance());
    await RedisPool.connect();
    await QueueService.initialize();
    // [07] boot recovery runs here, before the worker starts taking jobs.
    const recovery = await AuthContext.runAsLocalUser(() => VisualizationWorkerService.recoverOnBoot(), {
      requestId: "boot-recovery"
    });
    log.info({ event: "visualization.recovery.boot_finished", ...recovery }, "Visualization boot recovery finished");
    await QueueService.startVisualizationWorker((job) =>
      AuthContext.runAsLocalUser(() => processVisualization(job), { requestId: job.jobId })
    );
    sweep = VisualizationWorkerService.startRecoverySweep(); // [07]
    // [16f] library job recovery (16 §10.8) runs before the scan worker takes jobs; then the sweep.
    const libraryRecovery = new LibraryJobRecovery();
    const libraryReport = await AuthContext.runAsLocalUser(() => libraryRecovery.recoverOnBoot(), {
      requestId: "library-boot-recovery"
    });
    log.info({ event: "library.recovery.boot_finished", ...libraryReport }, "Library job boot recovery finished");
    await QueueService.startLibraryScanWorker((job) =>
      AuthContext.runAsLocalUser(() => processLibraryScan(job), { requestId: job.jobId })
    );
    librarySweep = libraryRecovery.startSweep(); // [16f]
    // [end 16f]
    // [16g] repair worker (library job recovery above already failed interrupted repairs and removed their worktrees)
    await QueueService.startLibraryRepairWorker((job) =>
      AuthContext.runAsLocalUser(() => processLibraryRepair(job), { requestId: job.jobId })
    );
    // [end 16g]
    log.info({ event: "worker.boot.started" }, "PRVision worker started");
  } catch (error: unknown) {
    log.fatal(
      { event: "worker.boot.failed", err: error, ...describeBootError(error) },
      "Failed to start PRVision worker"
    );
    await shutdown.shutdown(1, "boot_failed");
  }
}

if (require.main === module) {
  bootstrapWorker().catch((error: unknown) => {
    process.stderr.write(
      `PRVision worker crashed during boot: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
