import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { buildRouteDependencies, createApp } from "../../../backend/src/app";
import type { HealthController } from "../../../backend/src/controllers";
import { LocalAuthMiddleware } from "../../../backend/src/middleware";
import * as routesModule from "../../../backend/src/routes";
import { ResponseHandler } from "../../../backend/src/utilities/handlers/response-handler";
import { ArtifactStore } from "../../../backend/src/utilities/services/artifact-store";
import { startTestServer } from "../helpers/http";
import { patchStaticMethod } from "../helpers/test-context";

/** A createApp() instance with a stub HealthController and a temp ArtifactStore, listening on 127.0.0.1:0. */
export interface TestApp {
  baseUrl: string;
  store: ArtifactStore;
  close(): Promise<void>;
}

/**
 * Starts the real middleware pipeline. `extraRoutes` registers test-only routes at the position of
 * registerRoutes (after express.json and AuthContext, before the 404 and error handlers).
 */
export async function startTestApp(extraRoutes?: (app: Express) => void): Promise<TestApp> {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-app-")));
  const store = new ArtifactStore(dataDir);
  await store.ensureRoots();
  const localAuth = new LocalAuthMiddleware({ apiPort: "socket", frontendUrl: "http://localhost:4210" });
  const responseHandler = new ResponseHandler();
  const healthController = {
    get: (_req: Request, res: Response) =>
      responseHandler.controllerResponse({ status: 200, data: { stub: true } }, res)
  } as unknown as HealthController;

  const original = routesModule.registerRoutes;
  const restore = patchStaticMethod(routesModule, "registerRoutes", (app, deps) => {
    original(app, deps);
    extraRoutes?.(app);
  });
  let app: Express;
  try {
    app = createApp({
      localAuth,
      artifactStore: store,
      // Feature controllers are the real ones (cheap to construct; services are created per request), so the
      // fixture keeps compiling as sheets add controllers to RouteDependencies. Only health is stubbed.
      routes: { ...buildRouteDependencies(localAuth), healthController }
    });
  } finally {
    restore();
  }
  const server = await startTestServer(app);
  return {
    baseUrl: server.baseUrl,
    store,
    close: async () => {
      await server.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}
