import type { Express, RequestHandler } from "express";
import type {
  HarnessLibraryController,
  HealthController,
  RepositoriesController,
  SettingsController,
  VisualizationsController
} from "../controllers";

/** Controllers and guards the route map needs (built by buildRouteDependencies in app.ts). */
export type RouteDependencies = {
  requireLocal: RequestHandler;
  healthController: HealthController;
  settingsController: SettingsController;
  repositoriesController: RepositoriesController;
  visualizationsController: VisualizationsController;
  /** 16f: library and job routes; 16g and 16k add their routes to the same controller. */
  harnessLibraryController: HarnessLibraryController;
};

/** The single explicit route map (guidelines §4.2). Every /api route carries requireLocal. */
export function registerRoutes(app: Express, dependencies: RouteDependencies): void {
  const { requireLocal, healthController } = dependencies;

  // ----- 04: health -----
  app.get("/api/health", requireLocal, healthController.get.bind(healthController));

  // ----- 05: settings (00 §9) -----
  const { settingsController } = dependencies;
  app.get("/api/settings", requireLocal, settingsController.get.bind(settingsController));
  app.put("/api/settings", requireLocal, settingsController.update.bind(settingsController));
  app.post("/api/settings/test-github", requireLocal, settingsController.testGithub.bind(settingsController));
  app.post("/api/settings/test-ai", requireLocal, settingsController.testAi.bind(settingsController));

  // ----- 06: repositories -----
  const { repositoriesController } = dependencies;
  app.get("/api/repositories", requireLocal, repositoriesController.list.bind(repositoriesController));
  app.post("/api/repositories", requireLocal, repositoriesController.create.bind(repositoriesController));
  app.post(
    "/api/repositories/detect-apps",
    requireLocal,
    repositoriesController.detectApps.bind(repositoriesController)
  );
  app.get("/api/repositories/:id", requireLocal, repositoriesController.get.bind(repositoriesController));
  app.patch("/api/repositories/:id", requireLocal, repositoriesController.update.bind(repositoriesController));
  app.post(
    "/api/repositories/:id/redetect",
    requireLocal,
    repositoriesController.redetect.bind(repositoriesController)
  );
  app.delete("/api/repositories/:id", requireLocal, repositoriesController.remove.bind(repositoriesController));
  app.get(
    "/api/repositories/:id/pull-requests",
    requireLocal,
    repositoriesController.listPullRequests.bind(repositoriesController)
  );
  app.get(
    "/api/repositories/:id/branches",
    requireLocal,
    repositoriesController.listBranches.bind(repositoriesController)
  );
  app.get(
    "/api/repositories/:id/commits",
    requireLocal,
    repositoriesController.listCommits.bind(repositoriesController)
  );

  // ----- 07: visualizations -----
  const { visualizationsController } = dependencies;
  app.post("/api/visualizations", requireLocal, visualizationsController.create.bind(visualizationsController));
  app.get("/api/visualizations", requireLocal, visualizationsController.list.bind(visualizationsController));
  app.get("/api/visualizations/:id", requireLocal, visualizationsController.get.bind(visualizationsController));
  app.get(
    "/api/visualizations/:id/console",
    requireLocal,
    visualizationsController.console.bind(visualizationsController)
  );
  app.post(
    "/api/visualizations/:id/continue",
    requireLocal,
    visualizationsController.continueRun.bind(visualizationsController)
  );
  app.post(
    "/api/visualizations/:id/cancel",
    requireLocal,
    visualizationsController.cancel.bind(visualizationsController)
  );
  app.delete("/api/visualizations/:id", requireLocal, visualizationsController.remove.bind(visualizationsController));

  // ----- 16f: library (16 §14.1). library-estimate is a fixed POST path: no POST /api/repositories/:id exists. -----
  const { harnessLibraryController } = dependencies;
  app.post(
    "/api/repositories/library-estimate",
    requireLocal,
    harnessLibraryController.estimateFolder.bind(harnessLibraryController)
  );
  app.get(
    "/api/repositories/:id/library",
    requireLocal,
    harnessLibraryController.summary.bind(harnessLibraryController)
  );
  app.get(
    "/api/repositories/:id/library/estimate",
    requireLocal,
    harnessLibraryController.estimate.bind(harnessLibraryController)
  );
  app.post(
    "/api/repositories/:id/library/scans",
    requireLocal,
    harnessLibraryController.startScan.bind(harnessLibraryController)
  );
  app.get("/api/library-jobs/:id", requireLocal, harnessLibraryController.getJob.bind(harnessLibraryController));
  app.get(
    "/api/library-jobs/:id/events",
    requireLocal,
    harnessLibraryController.jobEvents.bind(harnessLibraryController)
  );
  app.post(
    "/api/library-jobs/:id/cancel",
    requireLocal,
    harnessLibraryController.cancelJob.bind(harnessLibraryController)
  );
  // ----- end 16f -----

  // ----- 16g: repair (16 §14.1, §14.4) -----
  app.post(
    "/api/visualizations/:id/components/:componentId/repair",
    requireLocal,
    harnessLibraryController.repairComponent.bind(harnessLibraryController)
  );
  app.post(
    "/api/visualizations/:id/repair-broken",
    requireLocal,
    harnessLibraryController.repairBroken.bind(harnessLibraryController)
  );
  // ----- end 16g -----
}
