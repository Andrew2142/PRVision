import "reflect-metadata";
import http from "node:http";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import {
  APP_HOST,
  APP_PORT,
  ARTIFACTS_ROUTE,
  FRONTEND_URL,
  JSON_BODY_LIMIT,
  SHUTDOWN_TIMEOUT_MS
} from "./config-consts";
import { validateConfig } from "./config-consts/config-validation";
import { HealthController, RepositoriesController, SettingsController, VisualizationsController } from "./controllers";
import { assertDatabaseReady } from "./database/schema-readiness";
import {
  LocalAuthMiddleware,
  createArtifactPathGuard,
  errorHandler,
  notFoundHandler,
  requestContextMiddleware
} from "./middleware";
import { registerRoutes, type RouteDependencies } from "./routes";
import {
  ArtifactStore,
  AuthContext,
  DbPool,
  QueueService,
  RedisPool,
  closeHttpServer,
  createLogger,
  describeBootError,
  installGracefulShutdown
} from "./utilities";

const log = createLogger("app");

/** What createApp wires together (stub controllers and a temp ArtifactStore in tests). */
export interface AppDependencies {
  localAuth: LocalAuthMiddleware;
  artifactStore: ArtifactStore;
  routes: RouteDependencies;
}

/** Builds the Express app (middleware order: 04 §5.1). No I/O; safe to call in tests with stub controllers. */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.set("query parser", "simple"); // Express 5 default, stated explicitly: no nested objects from ?a[b]=c

  app.use(requestContextMiddleware);
  app.use(deps.localAuth.guardHost.bind(deps.localAuth));
  app.use(
    helmet({
      // Frontend (localhost:4210) loads /artifacts images from localhost:3100: same-site, not same-origin.
      crossOriginResourcePolicy: { policy: "same-site" },
      contentSecurityPolicy: false // API + PNGs only; no HTML is served
    })
  );
  app.use(
    cors({
      origin: deps.localAuth.allowedOriginList(),
      credentials: false,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600
    })
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  // After express.json: body-parser loses an AsyncLocalStorage store opened earlier.
  app.use((req, res, next) => {
    AuthContext.middleware(req, res, next);
  });

  // Static artifacts (00 §9): Origin check → path guard → express.static rooted at <dataDir>/artifacts.
  app.use(
    ARTIFACTS_ROUTE,
    deps.localAuth.requireLocal.bind(deps.localAuth),
    createArtifactPathGuard(),
    express.static(deps.artifactStore.artifactsRoot(), {
      dotfiles: "deny",
      index: false,
      redirect: false,
      fallthrough: false, // missing file → 404 via errorHandler, never falls into API routes
      etag: true,
      lastModified: true,
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "private, no-cache");
        res.setHeader("X-Content-Type-Options", "nosniff");
      }
    })
  );

  registerRoutes(app, deps.routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Constructs controllers. Feature sheets add their controller here and to RouteDependencies. */
export function buildRouteDependencies(localAuth: LocalAuthMiddleware): RouteDependencies {
  return {
    requireLocal: localAuth.requireLocal.bind(localAuth),
    healthController: new HealthController(),
    settingsController: new SettingsController(),
    repositoriesController: new RepositoriesController(),
    visualizationsController: new VisualizationsController()
  };
}

async function bootstrap(): Promise<void> {
  let server: http.Server | null = null;

  // Installed first, so SIGINT/SIGTERM or a crash during boot also closes whatever is already open.
  // Every close step is a no-op for a resource that was never opened.
  const shutdown = installGracefulShutdown(
    [
      {
        name: "http server",
        close: async () => {
          if (server) {
            await closeHttpServer(server);
          }
        }
      },
      { name: "queues", close: () => QueueService.close() },
      { name: "redis", close: () => RedisPool.disconnect() },
      { name: "postgres", close: () => DbPool.close() }
    ],
    { role: "api", timeoutMs: SHUTDOWN_TIMEOUT_MS }
  );

  try {
    validateConfig(); // before any connection: a bad config never touches DB/Redis

    const artifactStore = new ArtifactStore();
    await artifactStore.ensureRoots();

    await DbPool.ping();
    await assertDatabaseReady(DbPool.getInstance());
    await RedisPool.connect();
    await QueueService.initialize();

    const localAuth = new LocalAuthMiddleware();
    const app = createApp({ localAuth, artifactStore, routes: buildRouteDependencies(localAuth) });

    const listening = http.createServer(app);
    listening.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(APP_PORT, APP_HOST, () => {
        listening.off("error", reject);
        resolve();
      });
    });
    server = listening;
    log.info(
      { event: "app.boot.listening", host: APP_HOST, port: APP_PORT, frontendUrl: FRONTEND_URL },
      "PRVision API listening"
    );
  } catch (error: unknown) {
    log.fatal({ event: "app.boot.failed", err: error, ...describeBootError(error) }, "Failed to start PRVision API");
    await shutdown.shutdown(1, "boot_failed"); // closes what was opened, flushes logs, exits 1
  }
}

if (require.main === module) {
  // bootstrap() handles its own failures; this only guards against a bug in the shutdown path itself.
  bootstrap().catch((error: unknown) => {
    process.stderr.write(
      `PRVision API crashed during boot: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
