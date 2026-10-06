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
  type VisualizationJobProcessor
} from "./utilities";
import { VisualizationWorkerService } from "./services/visualizations/pipeline/visualization-worker-service";

const log = createLogger("worker");

/** [07] The pipeline (00 §14.6): job = { visualizationId, jobId, signal }; 04 wraps it in AuthContext.runAsLocalUser. */
const processVisualization: VisualizationJobProcessor = async ({ visualizationId, jobId, signal }) => {
  await new VisualizationWorkerService().run({ visualizationId, jobId, signal });
};

async function bootstrapWorker(): Promise<void> {
  let sweep: { stop(): void } | null = null; // [07] periodic recovery sweep, started after the worker
  const shutdown = installGracefulShutdown(
    [
      {
        name: "recovery-sweep", // [07] first step: no recovery write races the shutdown of the active job
        close: () => {
          sweep?.stop();
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
