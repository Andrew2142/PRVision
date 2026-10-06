# 04 — Backend Core Infrastructure

Owner: build agent (wave 2)
Depends on: 00 (contracts), 01 (engineering standards), 02 (scaffold, `config-consts` values, package.json, lint), 03 (schema, enums, `table-registry.ts`, `connection.ts`, generated models)
Consumed by: every backend sheet (05–11) and 14

## 1. Purpose

Build every cross-cutting backend piece the feature sheets plug into: the two composition roots
(`app.ts`, `worker.ts`), route registration, local-only request guarding and request context, the response,
query, validation and mapping utilities, encryption, Postgres/Drizzle/Redis access, the BullMQ
`QueueService` for the single `visualizations` queue, the `GitClient` used by 06/07/08, the `ArtifactStore`
that owns the data-dir layout, process/path helpers, the pino logger with secret redaction, the `/artifacts`
static route, health, global 404/error handling, graceful shutdown, config validation, the
`PipelineStepError` class and the shared backend test helpers.

Everything here is copied from Uply-v2 where Uply has an equivalent, then stripped to PRVision's needs and
tightened to the practice decisions (strict TS, no `any`, pino instead of `console`, argv-only child
processes). Each section names the Uply source file and exactly what changes.

## 2. Scope / Out of scope

In scope: every file in §4. Full skeletons are given for each class; implementers fill in bodies exactly as
described.

Out of scope:

- Feature controllers, services, DTOs (05–07) — this sheet only defines how they are registered and composed.
- `GitHubClient` (06), AI providers (05), pipeline steps (07–11).
- Config constant *values* owned by 02 (this sheet lists the names it consumes in §6.1 and adds any missing).
- Schema and models (03).
- Frontend (12/13).

## 3. Dependencies

| Dependency | Used for |
|---|---|
| 00 §4 | Ports, host, env vars, data-dir layout |
| 00 §5, 03 | Enums, `Table`, `DeletionMode`, `TABLE_SCHEMAS`, `getPgPool`, `assertDatabaseReady`, models |
| 00 §8 | `PipelineContext` (shape of what 07 builds with this sheet's pieces) |
| 00 §9 | Envelope shape, `error_reason` codes, `/api/health`, `/artifacts/*` |
| 00 §10 | Queue contract |
| 00 §14 | Revision 2 (overrides earlier sections): §14.2 wire envelope and full `error_reason` list, §14.3 `Table`/`table-registry.ts`, §14.4 `HealthView`, §14.5 Host/Origin checks and child-process env allow-list, §14.6 queue processor and worker options, §14.7 `PipelineStepError`, §14.8 `ArtifactStore`/`GitClient` method lists and config consolidation, §14.10 `logTestStream`, test helpers |
| 02 | `backend/package.json` deps, `tsconfig.json`, ESLint `strictTypeChecked`, `utilities/helpers/env.ts` (02 §6.8 body), every `config-consts/*.config.ts` name and value (02 §6.7), `types/pipeline-errors.ts` (created in the scaffold), `tests/backend/helpers/setup.ts` placeholder |

npm dependencies required (02 adds them; versions as in Uply-v2 where Uply has them):
`express ^5.1.0`, `cors`, `helmet ^8`, `class-validator ^0.14.2`, `class-transformer 0.5.1`, `reflect-metadata 0.2.2`,
`drizzle-orm ^0.45.2`, `pg ^8.16.3`, `ioredis ^5.8`, `bullmq ^5.56`, `dotenv ^17`, `pino ^10`, `pino-pretty ^13`
(runtime dependency: used by the dev transport). Dev: `@types/express ^5`, `@types/cors`, `@types/pg`, `@types/node`.
Exact ranges: 02 §6.9.1.
**Not** copied: `bcrypt`, `cookie-parser`, `nodemailer`, `stripe`, `google-auth-library`, `axios`.

Platform prerequisite: **git ≥ 2.31** (00 §14.1; needed for `GIT_CONFIG_COUNT` and `--no-write-fetch-head`;
checked by `scripts/check-prereqs.mjs` (02) and by `GitClient.assertSupportedVersion()` at worker boot).

## 4. File inventory

Paths relative to `backend/` unless noted.

| File | Responsibility | Uply donor |
|---|---|---|
| `src/app.ts` | API composition root: `createApp()` (pure wiring, testable) + `bootstrap()` (infra, listen, shutdown) | `src/app.ts` |
| `src/worker.ts` | Worker composition root | `src/worker.ts` |
| `src/routes/index.ts` | `registerRoutes(app, deps)`, `RouteDependencies` | `src/routes/index.ts` |
| `src/middleware/local-auth-middleware.ts` | `LocalAuthMiddleware.guardHost` + `.requireLocal` | `middleware/auth-middleware.ts` (replaced) |
| `src/middleware/request-context-middleware.ts` | Request id + access log | new |
| `src/middleware/artifact-path-guard-middleware.ts` | Allow-list + traversal guard for `/artifacts` | new |
| `src/middleware/error-handler-middleware.ts` | `notFoundHandler`, `errorHandler` | inline in Uply `app.ts` |
| `src/middleware/index.ts` | Barrel | `middleware/index.ts` |
| `src/controllers/health-controller.ts` | `HealthController.get` | inline route in Uply |
| `src/controllers/index.ts` | Barrel (feature sheets append) | `controllers/index.ts` |
| `src/services/health/health-service.ts` | `HealthService.check()` → `ApiResponse<HealthView>` | new |
| `src/dtos/health/health-view.dto.ts` | `HealthView` (00 §14.4) | new |
| `src/dtos/shared/id-param.dto.ts` | `IdParamDTO` (`:id` positive int) | new |
| `src/dtos/shared/pagination-query.dto.ts` | `PaginationQueryDTO` (`page`, `pageSize`) | new |
| `src/config-consts/config-validation.ts` | `collectConfigValidationErrors`, `validateConfig` | `config-consts/config-validation.ts` |
| `src/enums/utility/error-reason.ts` | `ErrorReason` const + `ERROR_REASON_VALUES` (complete 00 §14.2 list); appended to the enums barrel | new |
| `src/types/local-user.ts` | `LocalUser` type, `LOCAL_USER` constant | `AuthenticatedUser` in auth-middleware |
| `src/types/express.d.ts` | `Request.localUser`, `Request.requestId` | `types/express.d.ts` |
| `src/types/pipeline-errors.ts` | `PipelineStepError`, `PipelineStage`, `PipelineStepErrorOptions`, `isPipelineStepError`, `isAbortError` (02 creates it with the §10 body; owned here) | new |
| `src/utilities/handlers/response-handler.ts` | `ApiResponse`, `ResponseHandler` | same |
| `src/utilities/handlers/query-conditions.ts` | `Conditions`, `Where`, `OrderBySpec`, `SelectManyOptions` | new |
| `src/utilities/handlers/query-handler.ts` | `QueryHandler` facade | same |
| `src/utilities/handlers/query-handler-drizzle.ts` | `QueryHandlerDrizzle`, `QueryHandlerError` | same |
| `src/utilities/handlers/model-handler.ts` | `ModelHandler.hydrate/toDatabaseValues/removeUndefined` | same |
| `src/utilities/handlers/array-handler.ts` | `ArrayHandler` | same (verbatim) |
| `src/utilities/validation/validation.ts` | `Validation` | same |
| `src/utilities/mappers/dto-mapper.ts` | `DTOMapper.map` | same |
| `src/utilities/context/auth-context.ts` | `AuthContext` (AsyncLocalStorage) | same |
| `src/utilities/processors/encryption.ts` | `Encryption` AES-256-GCM, `EncryptionError` | same (minus bcrypt) |
| `src/utilities/helpers/env.ts` | dotenv loading + non-throwing readers (only imported by `config-consts`); created by 02 (§6.8) | same |
| `src/utilities/helpers/error-message.ts` | `getErrorMessage(unknown)` | same (verbatim) |
| `src/utilities/helpers/paths.ts` | `expandHome`, `toPosixPath`, `isPathInside`, `resolveInside`, `normalizeRepoRelativePath`, `isRealPathInside(Sync)`, `PathOutsideRootError` | new |
| `src/utilities/helpers/process.ts` | `runProcess` (spawn wrapper), `ProcessError` | new |
| `src/utilities/helpers/date.ts` | `toIsoString`, `toIsoStringOrNull` | new |
| `src/utilities/helpers/pagination.ts` | `resolvePageRequest`, `PageRequest`, `PagedResult<T>` | new |
| `src/utilities/helpers/graceful-shutdown.ts` | `installGracefulShutdown`, `closeHttpServer` | new |
| `src/utilities/loggers/logger.ts` | pino `logger`, `createLogger`, `redactSecrets`, `flushLogger`, `REDACT_PATHS`, `logTestStream` (00 §14.10) | new (replaces `console`) |
| `src/utilities/services/db-pool.ts` | `DbPool` | same |
| `src/utilities/services/drizzle-db.ts` | `DrizzleDb`, `Database`, `Transaction`, `DbExecutor` | same |
| `src/utilities/services/redis-pool.ts` | `RedisPool` (three connection profiles), `parseRedisUrl` | same |
| `src/utilities/services/queue-service.ts` | `QueueService`, `VisualizationJob`, `VisualizationJobProcessor`, `JobAbortReason`, `JobAbortedError`, `jobAbortReason`, `throwIfJobAborted` | `services/runs/enqueue/queue-service.ts` |
| `src/utilities/services/git-client.ts` | `GitClient`, `GitCommandError`, `GitNameStatusEntry`, `GitAuthHeader`, parsers | new |
| `src/utilities/services/artifact-store.ts` | `ArtifactStore`, `ArtifactPathError` | new |
| `src/utilities/{handlers,validation,mappers,context,processors,helpers,loggers,services}/index.ts`, `src/utilities/index.ts` | Barrels | same pattern |
| `scripts/validate-config.ts` | CLI wrapper around `validateConfig()` | same |
| `tests/backend/helpers/test-context.ts` | `runWithAuthContext`, `patchStaticMethod`, `injectQueryHandler`, `withTempDir` (owned here; sheet 14 appends `patchMethods`, `withPatches`) | `tests/backend/helpers/test-context.ts` |
| `tests/backend/helpers/git-fixtures.ts` | `createTempGitRepo()` | new |
| `tests/backend/helpers/http.ts` | `startTestServer(app)` | new |
| `tests/backend/**/*.test.ts` | §13 | — |

**Import rule inside `utilities/`:** modules import siblings by direct relative file path, never through
`utilities/index.ts`, to avoid cycles. Outside `utilities/`, import from the barrel.

## 5. Composition roots and routing

### 5.1 `src/app.ts`

Uply's `app.ts` mixes module-level middleware with `bootstrap()`. PRVision splits it into a pure
`createApp(deps)` (unit-testable without DB/Redis) and `bootstrap()` (infrastructure). Stripped from Uply:
cookie parser, session secret, Stripe raw body, recorder SDK CORS branch, tenant origin service,
`Permissions-Policy` block, `urlencoded` parser.

Middleware order (01 §5.12 restates it; this is the implementation):

1. `requestContextMiddleware` — request id, `X-Request-Id` header, access log. First, so even guard
   rejections carry the id.
2. `LocalAuthMiddleware.guardHost` — DNS-rebinding guard (00 §14.5).
3. `helmet` — CORP `same-site` so the UI on `:4210` can load `/artifacts` images from `:3100`.
4. `cors` — frontend origin(s) only, no credentials.
5. `express.json({ limit })` — no `urlencoded`, no cookies.
6. `AuthContext.middleware` — opens the AsyncLocalStorage store. It **must come after `express.json`**:
   body-parser resumes the request from the socket's async context, so a store opened before it is lost in every
   handler of a request that has a body (the same order as Uply and guidelines §4.1).
7. `/artifacts` static mount (with `requireLocal` and the path guard).
8. `registerRoutes` (every `/api` route carries `requireLocal`, which performs the Origin check).
9. `notFoundHandler`, `errorHandler`.

```ts
import "reflect-metadata";
import http from "node:http";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { APP_HOST, APP_PORT, FRONTEND_URL, JSON_BODY_LIMIT, SHUTDOWN_TIMEOUT_MS } from "./config-consts";
import { validateConfig } from "./config-consts/config-validation";
import { HealthController } from "./controllers";
import { assertDatabaseReady } from "./database/schema-readiness";
import {
  LocalAuthMiddleware,
  createArtifactPathGuard,
  errorHandler,
  notFoundHandler,
  requestContextMiddleware,
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
  installGracefulShutdown,
} from "./utilities";

const log = createLogger("app");

export interface AppDependencies {
  localAuth: LocalAuthMiddleware;
  artifactStore: ArtifactStore;
  routes: RouteDependencies;
}

/** Builds the Express app. No I/O; safe to call in tests with stub controllers. */
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
      contentSecurityPolicy: false, // API + PNGs only; no HTML is served
    }),
  );
  app.use(
    cors({
      origin: deps.localAuth.allowedOriginList(),
      credentials: false,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(AuthContext.middleware); // after express.json (see order note above)

  // Static artifacts (00 §9): Origin check → path guard → express.static rooted at <dataDir>/artifacts.
  app.use(
    "/artifacts",
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
      },
    }),
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
    // [05] settingsController: new SettingsController(),
    // [06] repositoriesController: new RepositoriesController(),
    // [07] visualizationsController: new VisualizationsController(),
  };
}

async function bootstrap(): Promise<void> {
  let server: http.Server | null = null;

  // Installed first, so SIGINT/SIGTERM or a crash during boot also closes whatever is already open.
  // Every close step is a no-op for a resource that was never opened.
  const shutdown = installGracefulShutdown(
    [
      { name: "http server", close: async () => { if (server) await closeHttpServer(server); } },
      { name: "queues", close: () => QueueService.close() },
      { name: "redis", close: () => RedisPool.disconnect() },
      { name: "postgres", close: () => DbPool.close() },
    ],
    { role: "api", timeoutMs: SHUTDOWN_TIMEOUT_MS },
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
    log.info({ event: "app.boot.listening", host: APP_HOST, port: APP_PORT, frontendUrl: FRONTEND_URL }, "PRVision API listening");
  } catch (error: unknown) {
    log.fatal({ event: "app.boot.failed", err: error, ...describeBootError(error) }, "Failed to start PRVision API");
    await shutdown.shutdown(1, "boot_failed"); // closes what was opened, flushes logs, exits 1
  }
}

if (require.main === module) {
  // bootstrap() handles its own failures; this only guards against a bug in the shutdown path itself.
  bootstrap().catch((error: unknown) => {
    process.stderr.write(`PRVision API crashed during boot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
```

Boot failure messages must be actionable: `ECONNREFUSED 127.0.0.1:5433` → log adds
`hint: "Is Docker running? npm run infra:up"`; `DatabaseNotReadyError` → its `hint`; `EADDRINUSE` →
`hint: "Port 3100 in use; another PRVision API running?"`; `ConfigValidationError` → `"Fix .env (see
.env.example) or run npm run setup:env"`. Implement as `describeBootError(error: unknown): { hint: string | null }`
in `utilities/helpers/graceful-shutdown.ts` (exported through the utilities barrel and used by both `app.ts`
and `worker.ts`; `worker.ts` must not import `app.ts`). `describeBootError` reads only `code`, `name`, `port`
and `hint` from the error, never its message (which can contain a connection string).

`process.stderr.write` in the last-resort `.catch` is the one place outside `utilities/loggers` that writes to
stderr directly: it runs only if the logger-based shutdown itself threw.

### 5.2 `src/worker.ts`

```ts
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
  type VisualizationJobProcessor,
} from "./utilities";

const log = createLogger("worker");

/**
 * [07] replaces this with:
 *   (job) => new VisualizationWorkerService().run(job)   // job = { visualizationId, jobId, signal } (00 §14.6)
 * Until then the worker boots and fails jobs loudly instead of silently dropping them.
 */
const processVisualization: VisualizationJobProcessor = (job) =>
  // Not `async`: an async function without `await` fails @typescript-eslint/require-await (01 §5.3.1).
  Promise.reject(new Error(`Visualization pipeline not implemented (visualizationId=${job.visualizationId})`));

async function bootstrapWorker(): Promise<void> {
  const shutdown = installGracefulShutdown(
    [
      { name: "queues", close: () => QueueService.close() }, // aborts the active job ("shutdown"), then closes worker + queue
      { name: "redis", close: () => RedisPool.disconnect() },
      { name: "postgres", close: () => DbPool.close() }, // last: the aborted job still writes its final status
    ],
    { role: "worker", timeoutMs: SHUTDOWN_TIMEOUT_MS },
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
    await QueueService.startVisualizationWorker((job) =>
      AuthContext.runAsLocalUser(() => processVisualization(job), { requestId: job.jobId }),
    );
    log.info({ event: "worker.boot.started" }, "PRVision worker started");
  } catch (error: unknown) {
    log.fatal({ event: "worker.boot.failed", err: error, ...describeBootError(error) }, "Failed to start PRVision worker");
    await shutdown.shutdown(1, "boot_failed");
  }
}

if (require.main === module) {
  bootstrapWorker().catch((error: unknown) => {
    process.stderr.write(`PRVision worker crashed during boot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
```

Startup recovery of visualizations left in an active status by a crashed worker is 07's responsibility
(07 adds a call between `QueueService.initialize()` and `startVisualizationWorker`).

### 5.3 `src/routes/index.ts`

Keeps Uply's single explicit route map and `.bind(controller)` style. Every `/api` route carries
`requireLocal`. 04 ships only the health route; 05/06/07 add their controllers to `RouteDependencies`, to
`buildRouteDependencies()` in `app.ts`, and their lines in the marked sections — nothing else changes.

```ts
import type { Express, RequestHandler } from "express";
import type { HealthController } from "../controllers";
// [05] import type { SettingsController } from "../controllers";
// [06] import type { RepositoriesController } from "../controllers";
// [07] import type { VisualizationsController } from "../controllers";

export type RouteDependencies = {
  requireLocal: RequestHandler;
  healthController: HealthController;
  // [05] settingsController: SettingsController;
  // [06] repositoriesController: RepositoriesController;
  // [07] visualizationsController: VisualizationsController;
};

export function registerRoutes(app: Express, dependencies: RouteDependencies): void {
  const { requireLocal, healthController } = dependencies;

  // ----- 04: health -----
  app.get("/api/health", requireLocal, healthController.get.bind(healthController));

  // ----- 05: settings (00 §9) -----
  // app.get("/api/settings", requireLocal, settingsController.get.bind(settingsController));
  // app.put("/api/settings", requireLocal, settingsController.update.bind(settingsController));
  // app.post("/api/settings/test-github", requireLocal, settingsController.testGithub.bind(settingsController));
  // app.post("/api/settings/test-ai", requireLocal, settingsController.testAi.bind(settingsController));

  // ----- 06: repositories -----
  // app.get("/api/repositories", ...list) / post create / get :id / post :id/redetect / delete :id
  // app.get("/api/repositories/:id/pull-requests", ...) / app.get("/api/repositories/:id/branches", ...)

  // ----- 07: visualizations -----
  // app.post("/api/visualizations", ...) / get list / get :id / get :id/console / post :id/cancel / delete :id
}
```

Express 5 notes for all sheets: path params use `:id` (no regex in paths — validate with `IdParamDTO`);
wildcards must be named (`/*splat`) — the artifacts route avoids this by using `app.use("/artifacts", …)`;
rejected promises from async handlers reach `errorHandler` automatically, but controllers still catch and
return 500 per guidelines.

### 5.4 Controllers barrel and `HealthController`

`src/controllers/index.ts`: `export * from "./health-controller";` (feature sheets append).

```ts
// src/controllers/health-controller.ts
import type { Request, Response } from "express";
import { HealthService } from "../services/health/health-service";
import { ResponseHandler } from "../utilities";

export class HealthController {
  private readonly responseHandler = new ResponseHandler();

  async get(_req: Request, res: Response): Promise<Response> {
    try {
      const serviceResponse = await new HealthService().check();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch {
      return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
    }
  }
}
```

`src/dtos/health/health-view.dto.ts` (exact shape from 00 §14.4; sheet 12 mirrors it):

```ts
/** GET /api/health — always HTTP 200 (00 §14.4). */
export interface HealthView {
  status: "ok" | "degraded";
  database: boolean;
  redis: boolean;
  version: string; // APP_VERSION
}
```

`HealthService.check(): Promise<ApiResponse<HealthView>>` runs two probes concurrently with
`Promise.allSettled`, each raced against `HEALTH_CHECK_TIMEOUT_MS` (`AbortSignal.timeout` + a rejected
promise; the timer is cleared/unref'd so it never keeps the process alive): database `DbPool.ping()`,
redis `RedisPool.ping()`. `database`/`redis` are `true` when the probe resolved in time. `status` is `"ok"`
when both are true, else `"degraded"`. It **always** returns `{ status: 200, data }`; probe errors are logged at
`warn` (`event: "health.probe.failed"`, `probe`, `err`) and never reach the response. git and the data dir are
not part of the view: the worker refuses to boot without a supported git (`GitClient.assertSupportedVersion`),
and the API cannot boot without a writable data dir (`ArtifactStore.ensureRoots`).

## 6. Configuration

### 6.1 Constants consumed (names and values live in 02 §6.7)

02 §6.7 is the **single consolidated list** of every constant, its value and unit (00 §14.8). This sheet does not
restate values. It consumes, from the `config-consts` barrel:

- `app.config.ts`: `NODE_ENV`, `IS_DEVELOPMENT`, `IS_TEST`, `IS_PRODUCTION`, `APP_NAME`, `APP_VERSION`,
  `APP_PORT`, `APP_HOST`, `FRONTEND_URL`, `LOG_LEVEL`, `LOG_TEST_STDOUT`, `DATA_DIR`, `WORKTREES_DIR_NAME`,
  `ARTIFACTS_DIR_NAME`, `FIXTURES_DIR_NAME`, `DATABASE_URL`, `REDIS_URL`, `PRVISION_SECRET_KEY`, `DB_POOL_MAX`
  (via 03's `connection.ts`), `ARTIFACTS_ROUTE`, `JSON_BODY_LIMIT`, `SHUTDOWN_TIMEOUT_MS`,
  `HEALTH_CHECK_TIMEOUT_MS`, `CHILD_PROCESS_BASE_ENV`, `CHILD_PROCESS_MAX_BUFFER_BYTES`, `PROCESS_KILL_GRACE_MS`,
  `GIT_BINARY`, `GIT_MIN_VERSION`, `GIT_DEFAULT_TIMEOUT_MS`, `GIT_FETCH_TIMEOUT_MS`, `GIT_WORKTREE_TIMEOUT_MS`,
  `GIT_MAX_BUFFER_BYTES`, `GIT_REF_NAMESPACE`.
- `queue.config.ts`: `QUEUE_PREFIX`, `VISUALIZATION_QUEUE`, `VISUALIZATION_JOB`, `VISUALIZATION_JOB_ID_PREFIX`,
  `VISUALIZATION_WORKER_CONCURRENCY`, `VISUALIZATION_JOB_ATTEMPTS`, `JOB_RETENTION`, `WORKER_LOCK_DURATION_MS`
  (300 000), `WORKER_MAX_STALLED_COUNT` (0), `WORKER_CLOSE_TIMEOUT_MS`, `CANCEL_KEY_PREFIX`,
  `CANCEL_KEY_TTL_SECONDS`, `CANCEL_POLL_INTERVAL_MS`.
- `pagination.config.ts`: `DEFAULT_PAGE`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`.

`CHILD_PROCESS_BASE_ENV` is an **allow-list** snapshot (00 §14.5): only `CHILD_PROCESS_ENV_ALLOWLIST` names and
`LC_*` variables, so `PRVISION_SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, `NODE_OPTIONS`, `GIT_*` and `ANTHROPIC_*`
can never reach git, Vite or any other child. A constant this sheet needs that is missing from 02 §6.7 is
requested in §16, never defined locally.

`config-consts` is the **only** place `process.env` is read (enforced by 02's architecture check;
`utilities/helpers/env.ts` is the reader it calls). Reads never throw; validation happens in §6.2.

### 6.2 `src/config-consts/config-validation.ts`

Copy the Uply structure (`collect…Errors` returning `string[]`, `validate…` throwing, small `assert*`
helpers). Strip every Uply-specific constant. Signature changes: no `env` parameter (all env already lives in
constants); overrides are typed against the module snapshot so tests can inject bad values. The file imports the
`config-consts` barrel (`"."`), so the barrel must **not** re-export it (02 §6.7); import it by path
(`./config-consts/config-validation`).

```ts
import * as currentConfig from ".";

export type ConfigSnapshot = typeof currentConfig;
export type ConfigValidationOverrides = Partial<ConfigSnapshot>;

export class ConfigValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`PRVision config validation failed:\n- ${errors.join("\n- ")}`);
    this.name = "ConfigValidationError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const LOG_LEVELS: readonly string[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export function collectConfigValidationErrors(overrides: ConfigValidationOverrides = {}): string[] {
  const c: ConfigSnapshot = { ...currentConfig, ...overrides };
  const errors: string[] = [];

  assertOneOf(errors, "NODE_ENV", c.NODE_ENV, ["development", "test", "production"]);
  assertPort(errors, "PORT", c.APP_PORT); // integer 1..65535 (NaN when malformed)
  if (!LOOPBACK_HOSTS.has(c.APP_HOST)) {
    errors.push("HOST must be a loopback address (127.0.0.1, ::1 or localhost); PRVision has no authentication.");
  }
  assertHttpUrl(errors, "FRONTEND_URL", c.FRONTEND_URL); // http(s), loopback host, no path/query
  assertUrlWithProtocol(errors, "DATABASE_URL", c.DATABASE_URL, ["postgres:", "postgresql:"]); // "" → "is required"
  assertUrlWithProtocol(errors, "REDIS_URL", c.REDIS_URL, ["redis:", "rediss:"]);
  assertSecretKey(errors, "PRVISION_SECRET_KEY", c.PRVISION_SECRET_KEY); // base64, decodes to >= 32 bytes
  assertAbsoluteDataDir(errors, "PRVISION_DATA_DIR", c.DATA_DIR); // absolute, not "/"
  assertOneOf(errors, "LOG_LEVEL", c.LOG_LEVEL, LOG_LEVELS);

  assertPositiveInteger(errors, "DB_POOL_MAX", c.DB_POOL_MAX);
  assertPositiveInteger(errors, "SHUTDOWN_TIMEOUT_MS", c.SHUTDOWN_TIMEOUT_MS);
  if (c.SHUTDOWN_TIMEOUT_MS <= c.WORKER_CLOSE_TIMEOUT_MS) {
    errors.push("SHUTDOWN_TIMEOUT_MS must be greater than WORKER_CLOSE_TIMEOUT_MS.");
  }
  assertPositiveInteger(errors, "GIT_DEFAULT_TIMEOUT_MS", c.GIT_DEFAULT_TIMEOUT_MS);
  assertPositiveInteger(errors, "GIT_FETCH_TIMEOUT_MS", c.GIT_FETCH_TIMEOUT_MS);
  assertPositiveInteger(errors, "GIT_WORKTREE_TIMEOUT_MS", c.GIT_WORKTREE_TIMEOUT_MS);
  assertPositiveInteger(errors, "GIT_MAX_BUFFER_BYTES", c.GIT_MAX_BUFFER_BYTES);

  // Queue contract (00 §10, §14.6) is fixed: fail loudly if a value drifts.
  assertEquals(errors, "QUEUE_PREFIX", c.QUEUE_PREFIX, "prvision");
  assertEquals(errors, "VISUALIZATION_QUEUE", c.VISUALIZATION_QUEUE, "visualizations");
  assertEquals(errors, "VISUALIZATION_JOB", c.VISUALIZATION_JOB, "visualize");
  assertEquals(errors, "VISUALIZATION_JOB_ID_PREFIX", c.VISUALIZATION_JOB_ID_PREFIX, "viz-");
  assertEquals(errors, "VISUALIZATION_WORKER_CONCURRENCY", c.VISUALIZATION_WORKER_CONCURRENCY, 1);
  assertEquals(errors, "VISUALIZATION_JOB_ATTEMPTS", c.VISUALIZATION_JOB_ATTEMPTS, 1);
  assertEquals(errors, "WORKER_LOCK_DURATION_MS", c.WORKER_LOCK_DURATION_MS, 300_000);
  assertEquals(errors, "WORKER_MAX_STALLED_COUNT", c.WORKER_MAX_STALLED_COUNT, 0);
  assertEquals(errors, "CANCEL_KEY_PREFIX", c.CANCEL_KEY_PREFIX, "prvision:cancel:");
  assertPositiveInteger(errors, "CANCEL_KEY_TTL_SECONDS", c.CANCEL_KEY_TTL_SECONDS);
  assertPositiveInteger(errors, "CANCEL_POLL_INTERVAL_MS", c.CANCEL_POLL_INTERVAL_MS);

  assertPositiveInteger(errors, "DEFAULT_PAGE_SIZE", c.DEFAULT_PAGE_SIZE);
  if (c.DEFAULT_PAGE_SIZE > c.MAX_PAGE_SIZE || c.MAX_PAGE_SIZE > 100) {
    errors.push("DEFAULT_PAGE_SIZE must be <= MAX_PAGE_SIZE <= 100.");
  }
  // [05]/[10] append assertions for ai.config.ts / render.config.ts constants here.
  return errors;
}

export function validateConfig(overrides: ConfigValidationOverrides = {}): void {
  const errors = collectConfigValidationErrors(overrides);
  if (errors.length > 0) throw new ConfigValidationError(errors);
}
// assert* helpers: copy Uply's (assertNonEmpty, assertPositiveInteger, assertOneOf, assertUrl → assertHttpUrl)
// and add assertPort, assertUrlWithProtocol, assertSecretKey, assertAbsoluteDataDir, assertEquals.
```

Rules:

- Error messages name the variable and the rule, never the value of `DATABASE_URL`, `REDIS_URL` or
  `PRVISION_SECRET_KEY` (`PRVISION_SECRET_KEY must be base64 of at least 32 bytes (run npm run setup:env)`).
  Non-secret values may be echoed (`HOST "0.0.0.0" is not a loopback address`).
- Test-only variables (00 §14.10: `PRVISION_IT_RENDER`, `PRVISION_IT_AI`, `PRVISION_INTEGRATION`,
  `PRVISION_TEST_DATABASE_URL`, plus sheet 14's `PRVISION_KEEP_TEST_ARTIFACTS`, `PRVISION_REAL_DATA_DIR`,
  `PRVISION_IT_AI_*`) are not config constants and are **never** validated; `LOG_TEST_STDOUT` is a boolean and
  needs no check. Unknown environment variables are ignored.
- `scripts/validate-config.ts`: copy Uply's; print the result with `console` (scripts may print) and set
  `process.exitCode = 1` on failure. `npm run validate:config` (02 §6.9.1) runs it.

### 6.3 `src/utilities/helpers/env.ts`

Created by 02 with the exact body of 02 §6.8; this sheet owns it afterwards and keeps its exports and
semantics: dotenv loads the repo-root `.env` (`override: false`, `quiet: true`) unless `NODE_ENV=test`;
`optionalEnv` (trimmed, blank → `undefined`), `optionalIntegerEnv` (`NaN` when malformed, never throws),
`pickEnv(names, prefixes)` (used for the child-process allow-lists). There is no `requireEnv`: required values
are `""` when unset and reported by §6.2. Only `config-consts/**` may import this file (architecture rule
`env-helper`).

## 7. Request pipeline

### 7.1 `src/types/local-user.ts` and `src/types/express.d.ts`

```ts
export interface LocalUser { readonly id: 1; readonly login: "local"; readonly displayName: string; }
export const LOCAL_USER: LocalUser = Object.freeze({ id: 1, login: "local", displayName: "Local user" });
```

```ts
import type { LocalUser } from "./local-user";
declare global {
  namespace Express {
    interface Request { localUser?: LocalUser; requestId?: string; }
  }
}
export {};
```

### 7.2 `AuthContext` (`utilities/context/auth-context.ts`)

Copy Uply's AsyncLocalStorage class. Strip core user, session token and both `*SessionToken` methods. The
store becomes `{ user?: LocalUser; requestId?: string }`. `getUserId()/requireUserId()` return `number`.

```ts
type AuthStore = { user?: LocalUser; requestId?: string };

export class AuthContext {
  private static readonly storage = new AsyncLocalStorage<AuthStore>();

  /** Opens the request store. Mounted after express.json (§5.1); carries the id set by requestContextMiddleware. */
  static middleware(req: Request, _res: Response, next: NextFunction): void {
    AuthContext.storage.run({ requestId: req.requestId }, () => { next(); });
  }
  /** Runs fn inside a fresh store with the local user set (worker jobs, tests). Sync throws become rejections. */
  static runAsLocalUser<T>(fn: () => Promise<T> | T, options: { requestId?: string; user?: LocalUser } = {}): Promise<T> {
    return AuthContext.storage.run({ user: options.user ?? LOCAL_USER, requestId: options.requestId }, async () => {
      const result = await fn();
      return result;
    });
  }
  static setUser(user: LocalUser): void { AuthContext.getStore().user = user; }
  static getUser(): LocalUser | undefined { return AuthContext.storage.getStore()?.user; }
  static requireUser(): LocalUser { /* throw Error("Local user context is not available") when absent */ }
  static getUserId(): number | undefined { return AuthContext.getUser()?.id; }
  static requireUserId(): number { return AuthContext.requireUser().id; }
  static setRequestId(requestId: string): void { AuthContext.getStore().requestId = requestId; }
  static getRequestId(): string | undefined { return AuthContext.storage.getStore()?.requestId; }
  private static getStore(): AuthStore { /* throw when not initialized (Uply behaviour) */ }
}
```

Services keep Uply's `private readonly localUser = AuthContext.requireUser();` pattern only where they need
it (nothing in PRVision is user-scoped; services must not filter by user id).

### 7.3 `LocalAuthMiddleware` (`middleware/local-auth-middleware.ts`)

Replaces Uply's session-based `AuthMiddleware`. There is no login (00 D9) — the threats are other web pages
in the user's browser (CSRF, DNS rebinding) and other machines (prevented by the loopback bind). CORS alone
does not stop a cross-site `POST` from executing; it only hides the response. Hence two guards (00 §14.5):

```ts
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOST_NAMES = ["localhost", "127.0.0.1"] as const;

export class LocalAuthMiddleware {
  private readonly responseHandler = new ResponseHandler();
  private readonly allowedOrigins: ReadonlySet<string>;

  /**
   * @param options.frontendUrl - defaults to FRONTEND_URL.
   * @param options.apiPort - port the Host header must carry; defaults to APP_PORT. Tests that listen on port 0
   *   pass `"socket"` to compare against the port the request actually arrived on (req.socket.localPort).
   */
  constructor(private readonly options: { frontendUrl?: string; apiPort?: number | "socket" } = {}) {
    const frontend = new URL(options.frontendUrl ?? FRONTEND_URL);
    // FRONTEND_URL plus its loopback twin (localhost <-> 127.0.0.1, same scheme and port): the Angular dev
    // server accepts both host names (02 §6.11.2), and the browser sends whichever the user typed.
    this.allowedOrigins = new Set([frontend.origin, twinOrigin(frontend)]);
  }

  allowedOriginList(): string[] { return [...this.allowedOrigins]; }

  /**
   * App-level DNS-rebinding guard. The Host header must be exactly `localhost:<port>` or `127.0.0.1:<port>`
   * (00 §14.5; `[::1]:<port>` too when APP_HOST is "::1"). A missing port, another port, any other name or a
   * missing Host header → 403 forbidden_origin.
   */
  guardHost(req: Request, res: Response, next: NextFunction): void {
    const expectedPort = this.options.apiPort === "socket" ? req.socket.localPort : (this.options.apiPort ?? APP_PORT);
    const host = (req.headers.host ?? "").toLowerCase();
    const allowed = [...LOOPBACK_HOST_NAMES, ...(APP_HOST === "::1" ? ["[::1]"] : [])].map((name) => `${name}:${expectedPort}`);
    if (!allowed.includes(host)) {
      log.warn({ event: "http.host.rejected", host: req.headers.host ?? null, path: req.path }, "Rejected request with non-loopback Host header");
      this.responseHandler.controllerResponse(
        this.responseHandler.createErrorResponse("Forbidden host", 403, ErrorReason.FORBIDDEN_ORIGIN), res);
      return;
    }
    next();
  }

  /**
   * Route-level. For state-changing methods, rejects a present Origin that is not an allowed frontend origin
   * (00 §14.5), Origin "null", and Sec-Fetch-Site: cross-site. Then sets AuthContext.
   */
  requireLocal(req: Request, res: Response, next: NextFunction): void {
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.get("origin");
      const fetchSite = req.get("sec-fetch-site");
      const originRejected = origin !== undefined && !this.allowedOrigins.has(origin); // includes "null"
      const siteRejected = fetchSite === "cross-site";
      if (originRejected || siteRejected) {
        log.warn({ event: "http.origin.rejected", origin: origin ?? null, fetchSite: fetchSite ?? null, method: req.method, path: req.path },
          "Rejected cross-origin state-changing request");
        this.responseHandler.controllerResponse(
          this.responseHandler.createErrorResponse("Forbidden origin", 403, ErrorReason.FORBIDDEN_ORIGIN), res);
        return;
      }
    }
    req.localUser = LOCAL_USER;
    AuthContext.setUser(LOCAL_USER);
    next();
  }
}
```

Notes:

- The API's own origins (`http://localhost:3100`) are **not** allowed for writes: no PRVision page is served
  from the API port, so such an Origin can only come from something else.
- Requests without `Origin` and without `Sec-Fetch-Site` (curl, tests, server-to-server) are allowed — a modern
  browser always sends `Origin` on cross-origin `POST`/`PUT`/`DELETE`.
- `guardHost` runs before CORS, so a preflight from a rebinding page also gets 403.
- Same-site but cross-origin writes (`http://localhost:5173` → `:3100`) carry `Sec-Fetch-Site: same-site` and a
  foreign `Origin`; the Origin check rejects them.
- `twinOrigin(url: URL): string` (module-private) swaps `localhost` ↔ `127.0.0.1` and keeps scheme and port; for
  any other host it returns `url.origin` unchanged.

### 7.4 `requestContextMiddleware`

```ts
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get("x-request-id");
  const requestId = incoming !== undefined && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId; // AuthContext.middleware (after express.json) copies it into the ALS store
  res.setHeader("X-Request-Id", requestId);
  const startedAt = process.hrtime.bigint();
  const method = req.method;
  const path = req.originalUrl.split("?")[0] ?? req.originalUrl; // never log query strings
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const fields = { event: "http.request.completed", requestId, method, path, status: res.statusCode, durationMs: Math.round(durationMs) };
    if (res.statusCode >= 500) log.error(fields, "http request");
    else if (res.statusCode >= 400) log.warn(fields, "http request");
    else if (method === "GET" || method === "HEAD") log.debug(fields, "http request"); // polling noise
    else log.info(fields, "http request");
  });
  next();
}
```

`requestId` is passed explicitly in the `finish` log because the event may fire outside the ALS context.

### 7.5 `notFoundHandler` / `errorHandler` (`middleware/error-handler-middleware.ts`)

```ts
export function notFoundHandler(_req: Request, res: Response): void {
  responseHandler.controllerResponse(responseHandler.createErrorResponse("Resource not found", 404, ErrorReason.NOT_FOUND), res);
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(err); return; }
  const httpError = asHttpError(err); // narrows { status|statusCode: number, type?: string, expose?: boolean }
  if (httpError?.type === "entity.parse.failed") {
    return void responseHandler.controllerResponse(responseHandler.createErrorResponse("Malformed JSON body", 400, ErrorReason.VALIDATION_FAILED), res);
  }
  if (httpError?.type === "entity.too.large") {
    return void responseHandler.controllerResponse(responseHandler.createErrorResponse("Request body too large", 413, ErrorReason.PAYLOAD_TOO_LARGE), res);
  }
  if (httpError && (httpError.status === 404 || httpError.status === 403)) {
    // serve-static (fallthrough:false): missing file → 404; dotfile → 403. Both answer 404 so the response
    // never reveals what exists under the data dir.
    return void responseHandler.controllerResponse(responseHandler.notFound(), res);
  }
  if (httpError?.status === 400) {
    // e.g. serve-static failing to decode a malformed path
    return void responseHandler.controllerResponse(responseHandler.createErrorResponse("Request rejected", 400, ErrorReason.VALIDATION_FAILED), res);
  }
  log.error({ event: "http.request.failed", err, requestId: req.requestId, method: req.method, path: req.path }, "Unhandled request error");
  responseHandler.controllerResponse(responseHandler.internalError(), res);
}
```

The 500 body is always `"Internal server error"` (no `err.message`, unlike Uply's non-production branch —
messages can contain paths or command output).

### 7.6 `/artifacts` guard (`middleware/artifact-path-guard-middleware.ts`)

```ts
/** /artifacts/<vizId>/<componentId>/<base|head|diff>.png — the only servable shape (00 §4). */
export const ARTIFACT_PUBLIC_PATH_PATTERN = /^\/[1-9]\d{0,9}\/[1-9]\d{0,9}\/(base|head|diff)\.png$/;

export function createArtifactPathGuard(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { /* 404 not_found envelope */ return; }
    let decoded: string;
    try { decoded = decodeURIComponent(req.path); } catch { /* 400 validation_failed */ return; }
    if (decoded !== req.path || !ARTIFACT_PUBLIC_PATH_PATTERN.test(decoded)) {
      // Any percent-encoding, "..", backslash, NUL or extra segment is rejected before touching the filesystem.
      log.warn({ event: "artifacts.path.rejected", path: req.path }, "Rejected artifact path");
      /* 404 not_found envelope */ return;
    }
    next();
  };
}
```

`express.static` (send) independently refuses `..` and dotfiles; the guard is defence-in-depth and also
keeps any non-image file that might land in the artifacts dir from being served. `Cache-Control: private,
no-cache` + ETag/Last-Modified lets the browser revalidate cheaply (images can be rewritten during harness
repair within one visualization, so `immutable` would be wrong).

## 8. Response, query, validation and mapping utilities

### 8.1 `ResponseHandler` (`utilities/handlers/response-handler.ts`)

**Deliberate divergence from Uply (00 §14.2):** Uply's `controllerResponse` sends raw `data` on success and
`{ statusCode, message, error }` on failure. PRVision sends the envelope of 00 §14.2 and guidelines §6:
`{ status, data }` on success and `{ status, error, error_reason }` on failure. The HTTP status code always
equals `status`; `error` is a string, or a string array for `validation_failed`. Sheet 12's `ApiService` unwraps
`.data` and maps errors to `ApiError { status, message, reason }`.

```ts
import type { Response } from "express";
import type { ErrorReason } from "../../enums";

export interface ApiResponse<T = unknown> {
  status: number;
  data?: T;
  error?: string | string[];   // string[] only for validation_failed (one message per constraint)
  error_reason?: ErrorReason;
}

export class ResponseHandler {
  controllerResponse(result: ApiResponse, response: Response): Response {
    const { status, data, error, error_reason } = result;
    if (status >= 400 && error === undefined) {
      log.warn({ event: "http.response.malformed", status }, "Error response without an error message");
      return response.status(500).json({ status: 500, error: "Internal server error", error_reason: "internal_error" });
    }
    if (error !== undefined) {
      const reason = error_reason ?? (status >= 500 ? "internal_error" : undefined);
      const body: Record<string, unknown> = { status, error };
      if (reason !== undefined) body.error_reason = reason;
      return response.status(status).json(body);
    }
    return response.status(status).json({ status, data: data ?? null });
  }
  successResponse<T>(data: T, status = 200): ApiResponse<T> { return { status, data }; }
  createErrorResponse(message: string | string[], status = 400, errorReason?: ErrorReason): ApiResponse<never> {
    return errorReason === undefined ? { status, error: message } : { status, error: message, error_reason: errorReason };
  }
  notFound(message = "Resource not found"): ApiResponse<never> { return this.createErrorResponse(message, 404, "not_found"); }
  internalError(): ApiResponse<never> { return this.createErrorResponse("Internal server error", 500, "internal_error"); }
}
```

No 204 responses anywhere (every response has a JSON body). A result with `status >= 400` and no `error`
is a bug: `controllerResponse` logs `warn` (`event: "http.response.malformed"`) and sends
`{ status: 500, error: "Internal server error", error_reason: "internal_error" }` with HTTP 500, so the
envelope invariants hold. Every error the backend emits carries an `error_reason` from §8.2 (services may omit it
only for 500, where `controllerResponse` fills in `internal_error`).

### 8.2 `ErrorReason` (`enums/utility/error-reason.ts`)

The complete list of 00 §14.2, nothing more. A sheet that needs another code requests it from 00 first.

```ts
import { enumValues, type ValueOf } from "./value-of";

export const ErrorReason = {
  VALIDATION_FAILED: "validation_failed", // 400
  NOT_FOUND: "not_found", // 404
  CONFLICT: "conflict", // 409 (unique/FK violation, delete while running)
  FORBIDDEN_ORIGIN: "forbidden_origin", // 403 (LocalAuthMiddleware only)
  PAYLOAD_TOO_LARGE: "payload_too_large", // 413
  INTERNAL_ERROR: "internal_error", // 500
  NOT_GIT_REPO: "not_git_repo", // 400
  UNSUPPORTED_FRAMEWORK: "unsupported_framework", // 400
  MISSING_NODE_MODULES: "missing_node_modules", // 400
  NO_GITHUB_REMOTE: "no_github_remote", // 400
  GITHUB_TOKEN_MISSING: "github_token_missing", // 400
  GITHUB_UNAUTHORIZED: "github_unauthorized", // 400
  GITHUB_RATE_LIMITED: "github_rate_limited", // 429
  GITHUB_UNAVAILABLE: "github_unavailable", // 502
  AI_NOT_CONFIGURED: "ai_not_configured", // 400
  AI_UNAUTHORIZED: "ai_unauthorized", // 400
  ALREADY_TERMINAL: "already_terminal", // 409
  WORKING_TREE_CLEAN: "working_tree_clean", // 400
} as const;
export type ErrorReason = ValueOf<typeof ErrorReason>;
export const ERROR_REASON_VALUES = enumValues(ErrorReason);
```

The status comments are the 01 §5.7.1 table (aligned with sheets 05–07).

### 8.3 Query conditions (`utilities/handlers/query-conditions.ts`)

Uply's `QueryHandler` supports only equality and silently drops `null` and unknown keys. That is unsafe for
`update`/`delete` (a dropped filter widens the write) and too weak for ordered lists. PRVision keeps the
equality-object style and adds a tiny operator vocabulary:

```ts
export type ScalarValue = string | number | boolean | Date;

export type WhereOperator =
  | { readonly op: "ne" | "gt" | "gte" | "lt" | "lte"; readonly value: ScalarValue }
  | { readonly op: "in" | "notIn"; readonly values: readonly (string | number)[] }
  | { readonly op: "isNull" | "isNotNull" };

/** Key = camelCase model property. undefined → ignored; null → IS NULL; scalar → =; WhereOperator → operator. */
export type Conditions = Record<string, ScalarValue | WhereOperator | null | undefined>;

export const Where = {
  ne: (value: ScalarValue): WhereOperator => ({ op: "ne", value }),
  gt: (value: ScalarValue): WhereOperator => ({ op: "gt", value }),
  gte: (value: ScalarValue): WhereOperator => ({ op: "gte", value }),
  lt: (value: ScalarValue): WhereOperator => ({ op: "lt", value }),
  lte: (value: ScalarValue): WhereOperator => ({ op: "lte", value }),
  in: (values: readonly (string | number)[]): WhereOperator => ({ op: "in", values }),
  notIn: (values: readonly (string | number)[]): WhereOperator => ({ op: "notIn", values }),
  isNull: (): WhereOperator => ({ op: "isNull" }),
  isNotNull: (): WhereOperator => ({ op: "isNotNull" }),
} as const;

export function isWhereOperator(value: unknown): value is WhereOperator {
  return typeof value === "object" && value !== null && !(value instanceof Date) && "op" in value;
}

export interface OrderBySpec { column: string; direction: "asc" | "desc"; }
export interface SelectManyOptions {
  limit?: number;                       // default: no limit (Uply's silent default of 10 is removed)
  offset?: number;                      // default 0
  orderBy?: readonly OrderBySpec[];     // default: [{ column: "id", direction: "asc" }]
  search?: Record<string, string>;      // case-insensitive contains (ILIKE, %/_ escaped)
}
```

Example: console polling in 07 without direct Drizzle —
`queryHandler.selectMany(VisualizationConsoleEventModel, { visualizationId, id: Where.gt(afterId) }, Table.VISUALIZATION_CONSOLE_EVENTS, { orderBy: [{ column: "id", direction: "asc" }], limit: 500 })`.

### 8.4 `QueryHandler` facade (`utilities/handlers/query-handler.ts`)

Same delegation shape as Uply. Exact public method list:

| Method | Signature | Change vs Uply |
|---|---|---|
| `static normalizeData` | `(data: object, excludedKeys?: readonly string[]) => Record<string, unknown>` | accepts models directly (no `as unknown as Record` at call sites) |
| `normalizeData` | same, instance | — |
| `insert` | `(data: Record<string, unknown> \| Record<string, unknown>[], table: Table, excludedKeys?: readonly string[]) => Promise<ApiResponse<Record<string, unknown>[]>>` | unknown keys throw `QueryHandlerError`; empty array → 200 `[]` |
| `select` | overloads: `(c, table, isolateData: true) => Promise<Record<string, unknown>[]>`; `(c, table, isolateData?: false) => Promise<ApiResponse<Record<string, unknown>[]>>` | isolate variant **throws** on DB error (Uply returned `[]`) |
| `update` | `(newValues, conditions: Conditions, table, excludedKeys?) => Promise<ApiResponse<{ rowsAffected: number }>>` | empty where → 400; unknown keys throw |
| `delete` | `(conditions: Conditions, table, mode: DeletionMode) => Promise<ApiResponse<{ rowsAffected: number }>>` | `SOFT` on a table without `isDeleted` throws (Uply silently hard-deleted) |
| `count` | `(conditions: Conditions, table) => Promise<ApiResponse<{ count: number }>>` | — |
| `checkDuplicates` | `(keyName: string, keyValue: ScalarValue, table) => Promise<boolean>` | — |
| `validateAndSelect` | `<T extends object>(Model: new () => T, query: Conditions, table) => Promise<T \| null>` | `limit 1`, ordered by id; throws on DB error |
| `selectMany` | `<T extends object>(Model: new () => T, conditions: Conditions, table, options?: SelectManyOptions) => Promise<T[]>` | options object replaces positional `limit, offset, searchFields`; adds ordering; throws on DB error |
| `firstInsertedId` (static) | `(response: ApiResponse<Record<string, unknown>[]>) => number \| null` | new helper |

Constructor: `constructor(db?: DbExecutor)` — pass a transaction to run CRUD inside `DrizzleDb.transaction`.

Stripped from Uply: the `any` constructor param, `grid-query-handler.ts` (not copied at all), the
`APP_IS_PRODUCTION`-dependent DB message leak.

Rule of thumb for callers: methods returning `ApiResponse` never throw for DB errors; methods returning
rows/models throw `QueryHandlerError` (services catch and return 500, pipeline steps let it become a
`PipelineStepError` or a per-component failure).

### 8.5 `QueryHandlerDrizzle` (`utilities/handlers/query-handler-drizzle.ts`)

```ts
import {
  and, asc, count, desc, eq, getTableColumns, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne,
  notInArray, type Column, type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { DatabaseError } from "pg";
import { getTableSchema, supportsSoftDelete, tableHasColumn } from "../../database/table-registry";
import { DeletionMode, ErrorReason, type Table } from "../../enums";
import { createLogger } from "../loggers/logger";
import { DrizzleDb, type DbExecutor } from "../services/drizzle-db";
import { ModelHandler } from "./model-handler";
import { isWhereOperator, type Conditions, type SelectManyOptions, type WhereOperator } from "./query-conditions";
import type { ApiResponse } from "./response-handler";

const log = createLogger("query-handler");

export class QueryHandlerError extends Error {
  constructor(message: string, readonly operation: string, readonly table: Table, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QueryHandlerError";
  }
}

export class QueryHandlerDrizzle {
  private readonly db: DbExecutor;

  constructor(db?: DbExecutor) {
    this.db = db ?? DrizzleDb.getInstance();
  }

  normalizeData(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    // Uply dbPrepare: own property names, strip leading "_", drop functions and undefined, keep null.
  }

  async insert(data: Record<string, unknown> | Record<string, unknown>[], table: Table, excludedKeys: readonly string[] = []): Promise<ApiResponse<Record<string, unknown>[]>> {
    const tableSchema = getTableSchema(table);
    const rows = (Array.isArray(data) ? data : [data]).map((row) => this.prepareValues(tableSchema, table, row, excludedKeys, "insert"));
    if (rows.length === 0) return { status: 200, data: [] };
    try {
      const result = await this.db.insert(tableSchema).values(rows as never).returning();
      return { status: 200, data: result as Record<string, unknown>[] };
    } catch (error: unknown) {
      return this.handleDatabaseError(error, "insert", table);
    }
  }

  async select(conditions: Conditions, table: Table, isolateData: true): Promise<Record<string, unknown>[]>;
  async select(conditions: Conditions, table: Table, isolateData?: false): Promise<ApiResponse<Record<string, unknown>[]>>;
  async select(conditions: Conditions, table: Table, isolateData = false): Promise<ApiResponse<Record<string, unknown>[]> | Record<string, unknown>[]> {
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, this.applyDefaultConditions(table, conditions));
    try {
      const rows = (await this.db.select().from(tableSchema).where(where)) as Record<string, unknown>[];
      return isolateData ? rows : { status: 200, data: rows };
    } catch (error: unknown) {
      if (isolateData) throw this.wrap(error, "select", table);
      return this.handleDatabaseError(error, "select", table);
    }
  }

  async update(newValues: Record<string, unknown>, conditions: Conditions, table: Table, excludedKeys: readonly string[] = []): Promise<ApiResponse<{ rowsAffected: number }>> {
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, conditions);
    if (!where) return { status: 400, error: "No valid conditions provided", error_reason: ErrorReason.VALIDATION_FAILED };
    const values = this.withUpdatedAt(tableSchema, this.prepareValues(tableSchema, table, newValues, excludedKeys, "update"));
    try {
      const result = await this.db.update(tableSchema).set(values as never).where(where).returning();
      return result.length > 0
        ? { status: 200, data: { rowsAffected: result.length } }
        : { status: 404, error: "Record not found", error_reason: ErrorReason.NOT_FOUND };
    } catch (error: unknown) {
      return this.handleDatabaseError(error, "update", table);
    }
  }

  async delete(conditions: Conditions, table: Table, deletionMode: DeletionMode): Promise<ApiResponse<{ rowsAffected: number }>> {
    if (deletionMode === DeletionMode.SOFT && !supportsSoftDelete(table)) {
      throw new QueryHandlerError(`Table ${table} does not support soft delete`, "delete", table);
    }
    // where required (400 otherwise); soft → update isDeleted=true + updatedAt; hard → delete; 404 when 0 rows.
  }

  async count(conditions: Conditions, table: Table): Promise<ApiResponse<{ count: number }>> { /* select({ count: count() }) with default conditions; Number() the result */ }

  async checkDuplicates(keyName: string, keyValue: string | number | boolean | Date, table: Table): Promise<boolean> {
    return (await this.select({ [keyName]: keyValue }, table, true)).length > 0;
  }

  async validateAndSelect<T extends object>(ModelClass: new () => T, query: Conditions, table: Table): Promise<T | null> {
    const tableSchema = getTableSchema(table);
    const where = this.buildWhere(tableSchema, table, this.applyDefaultConditions(table, query));
    try {
      const rows = (await this.db.select().from(tableSchema).where(where).orderBy(...this.buildOrderBy(tableSchema, table, undefined)).limit(1)) as Record<string, unknown>[];
      const row = rows[0];
      return row ? ModelHandler.hydrate(ModelClass, row) : null;
    } catch (error: unknown) {
      throw this.wrap(error, "validateAndSelect", table);
    }
  }

  async selectMany<T extends object>(ModelClass: new () => T, conditions: Conditions, table: Table, options: SelectManyOptions = {}): Promise<T[]> {
    // where = default conditions + conditions + search (ilike with escapeLike) ; orderBy = buildOrderBy(options.orderBy)
    // apply .limit(options.limit) only when defined; .offset(options.offset ?? 0); hydrate each row; wrap errors
  }

  /** Public for unit tests (rendered with PgDialect.sqlToQuery). */
  buildWhere(tableSchema: PgTable, table: Table, conditions: Conditions): SQL | undefined {
    const columns = getTableColumns(tableSchema) as Record<string, Column>;
    const parts: SQL[] = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value === undefined) continue;
      const column = columns[key];
      if (!column) throw new QueryHandlerError(`Unknown column "${key}"`, "where", table);
      parts.push(this.toPredicate(column, value));
    }
    return parts.length > 0 ? and(...parts) : undefined;
  }

  private toPredicate(column: Column, value: NonNullable<Conditions[string]> | null): SQL {
    if (value === null) return isNull(column);
    if (!isWhereOperator(value)) return eq(column, value);
    switch (value.op) {
      case "ne": return ne(column, value.value);
      case "gt": return gt(column, value.value);
      case "gte": return gte(column, value.value);
      case "lt": return lt(column, value.value);
      case "lte": return lte(column, value.value);
      case "in": return value.values.length === 0 ? sqlFalse() : inArray(column, [...value.values]);
      case "notIn": return value.values.length === 0 ? sqlTrue() : notInArray(column, [...value.values]);
      case "isNull": return isNull(column);
      case "isNotNull": return isNotNull(column);
    }
  }

  private applyDefaultConditions(table: Table, conditions: Conditions): Conditions {
    if (!supportsSoftDelete(table) || Object.prototype.hasOwnProperty.call(conditions, "isDeleted")) return conditions;
    return { isDeleted: false, ...conditions };
  }

  private prepareValues(tableSchema: PgTable, table: Table, data: Record<string, unknown>, excludedKeys: readonly string[], operation: string): Record<string, unknown> {
    const prepared = this.normalizeData(data, excludedKeys);
    for (const key of Object.keys(prepared)) {
      if (!tableHasColumn(tableSchema, key)) throw new QueryHandlerError(`Unknown column "${key}"`, operation, table);
    }
    return prepared;
  }

  private withUpdatedAt(tableSchema: PgTable, values: Record<string, unknown>): Record<string, unknown> {
    return tableHasColumn(tableSchema, "updatedAt") ? { ...values, updatedAt: new Date() } : values;
  }

  private buildOrderBy(tableSchema: PgTable, table: Table, orderBy: SelectManyOptions["orderBy"]): SQL[] { /* unknown column → QueryHandlerError; default id asc */ }

  private wrap(error: unknown, operation: string, table: Table): QueryHandlerError {
    this.logDatabaseError(error, operation, table);
    return new QueryHandlerError(`Database ${operation} failed on ${table}`, operation, table, { cause: error });
  }

  private handleDatabaseError(error: unknown, operation: string, table: Table): ApiResponse<never> {
    this.logDatabaseError(error, operation, table);
    const dbError = findDatabaseError(error); // walks error.cause up to 3 levels (drizzle wraps pg errors)
    switch (dbError?.code) {
      case "23505": return { status: 409, error: `Duplicate record (${dbError.constraint ?? "unique constraint"})`, error_reason: ErrorReason.CONFLICT };
      case "23503": return { status: 409, error: `Related record conflict (${dbError.constraint ?? "foreign key"})`, error_reason: ErrorReason.CONFLICT };
      case "23502": case "22001": case "22P02": case "22003":
        return { status: 400, error: "Invalid value for database column", error_reason: ErrorReason.VALIDATION_FAILED };
      default: return { status: 500, error: "Internal server error", error_reason: ErrorReason.INTERNAL_ERROR };
    }
  }

  private logDatabaseError(error: unknown, operation: string, table: Table): void {
    const dbError = findDatabaseError(error);
    log.error({ event: "db.query.failed", table, operation, pgCode: dbError?.code ?? null, constraint: dbError?.constraint ?? null,
      detail: dbError?.detail ?? null, err: dbError ? undefined : error }, "Database operation failed");
  }
}
```

`23514` (CHECK violation) intentionally maps to 500: it means the service wrote an invalid enum/state.
Payload values are never logged (they can contain encrypted secrets or large diffs).

### 8.6 `ModelHandler` and `ArrayHandler`

`ArrayHandler`: copy verbatim. `ModelHandler`: copy `toDatabaseValues` and `removeUndefined`, add:

```ts
/** Creates a model and calls set<Key>(value) for each row property, including nulls (DB hydration). */
static hydrate<T extends object>(ModelClass: new () => T, row: Record<string, unknown>): T {
  const model = new ModelClass();
  for (const [key, value] of Object.entries(row)) {
    const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    const setter = (model as unknown as Record<string, unknown>)[setterName];
    if (typeof setter === "function") (setter as (input: unknown) => void).call(model, value);
  }
  return model;
}
```

### 8.7 `Validation` (`utilities/validation/validation.ts`)

Copy Uply's class. Changes:

- Error response: `createErrorResponse(messages, 400, ErrorReason.VALIDATION_FAILED)`.
- `compileJsonData(jsonData: unknown): Record<string, unknown>` never throws: string input is parsed inside
  `try`; parse failure or non-object (arrays, numbers) → `{}`.
- Nested errors are flattened recursively (`error.children`) with property paths
  (`"pageSize: pageSize must not be greater than 100"`). Uply only read top-level constraints.
- `validate()` keeps `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, no skipping. Numeric
  query/path params rely on `@Type(() => Number)` in the DTO (no global implicit conversion, so body
  strings are never silently coerced).

```ts
export type ValidationResult<T> = [true, null, T] | [false, ApiResponse<never>, null];
async validate<T extends object>(sanitizedData: Record<string, unknown>, DTOClass: new () => T): Promise<ValidationResult<T>>;
compileJsonData(jsonData: unknown): Record<string, unknown>;
```

The discriminated tuple lets controllers drop Uply's `errorResponse!` / `dto!` non-null assertions:

```ts
const [isValid, errorResponse, dto] = await this.validation.validate(this.validation.compileJsonData(req.params), IdParamDTO);
if (!isValid) return this.responseHandler.controllerResponse(errorResponse, res);
```

Shared DTOs:

```ts
// dtos/shared/id-param.dto.ts
export class IdParamDTO {
  @Type(() => Number) @IsInt() @Min(1) @Max(2_147_483_647)
  id!: number;
}
// dtos/shared/pagination-query.dto.ts
export class PaginationQueryDTO {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}
```

Feature query DTOs (e.g. 07's `visualization-list-query.dto.ts`) extend `PaginationQueryDTO`.
`utilities/helpers/pagination.ts`:

```ts
export interface PageRequest { page: number; pageSize: number; limit: number; offset: number; }
export interface PagedResult<T> { items: T[]; page: number; pageSize: number; total: number; }
export function resolvePageRequest(input: { page?: number; pageSize?: number }): PageRequest {
  const page = input.page ?? DEFAULT_PAGE;
  const pageSize = Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
```

### 8.8 `DTOMapper` (`utilities/mappers/dto-mapper.ts`)

Copy Uply's `map`. Replace the two `(model as any)` accesses with the `Record<string, unknown>` setter lookup
from `ModelHandler.hydrate`; keep the direct-assignment fallback only for own properties of the model.
Signature: `static map<M extends object>(dto: object, modelClass: new () => M): M`.

### 8.9 `date.ts`

```ts
export function toIsoString(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new RangeError("Invalid Date");
  return value.toISOString();
}
export function toIsoStringOrNull(value: Date | null | undefined): string | null {
  return value ? toIsoString(value) : null;
}
```

## 9. Data access and infrastructure services

### 9.1 `DbPool` (`utilities/services/db-pool.ts`)

```ts
export class DbPool {
  private static listenerPool: Pool | null = null;

  /** Shared pg Pool (03 connection.ts) with an idle-error listener attached once per pool instance. */
  static getInstance(): Pool {
    const pool = getPgPool();
    if (DbPool.listenerPool !== pool) {
      pool.on("error", (error) => { log.error({ event: "db.pool.error", err: error }, "Idle Postgres client error"); });
      DbPool.listenerPool = pool;
    }
    return pool;
  }
  /** select 1; returns latency ms. Throws on failure. */
  static async ping(): Promise<number> { /* hrtime around pool.query("select 1") */ }
  static async close(): Promise<void> { DbPool.listenerPool = null; await closePgPool(); }
}
```

### 9.2 `DrizzleDb` (`utilities/services/drizzle-db.ts`)

Uply exports a default class with an inferred return type. PRVision: named export, explicit types.

```ts
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../database/schema";
import { DbPool } from "./db-pool";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbExecutor = Database | Transaction;

export class DrizzleDb {
  private static instance: Database | null = null;

  static getInstance(): Database {
    DrizzleDb.instance ??= drizzle(DbPool.getInstance(), { schema });
    return DrizzleDb.instance;
  }

  /** Runs fn in a transaction. Use new QueryHandler(tx) inside for CRUD. */
  static async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return DrizzleDb.getInstance().transaction(fn);
  }

  /** Test hook: forget the cached instance (after DbPool.close()). */
  static reset(): void { DrizzleDb.instance = null; }
}
```

Multi-row writes (e.g. 08 inserting all component rows + updating `component_count`) use:

```ts
await DrizzleDb.transaction(async (tx) => {
  const queryHandler = new QueryHandler(tx);
  const inserted = await queryHandler.insert(rows, Table.VISUALIZATION_COMPONENTS);
  if (inserted.status !== 200) throw new Error("component insert failed"); // forces rollback
  await queryHandler.update({ componentCount: rows.length }, { id: visualizationId }, Table.VISUALIZATIONS);
});
```

Transaction rules: inside `DrizzleDb.transaction`, **every** non-200 `ApiResponse` must be turned into a throw.
Postgres aborts the whole transaction on the first failed statement (`25P02 current transaction is aborted`), so
continuing after a failed insert only produces confusing follow-up errors, and returning normally would COMMIT
the partial work. Never `await` network or child-process work inside a transaction (it holds row locks; the pool
session's `idle_in_transaction_session_timeout` of 60 s, 03 §7.1, kills such a transaction). Never mix `tx` and
the global `DrizzleDb.getInstance()` inside one unit of work.

### 9.3 `RedisPool` (`utilities/services/redis-pool.ts`)

Copy Uply's singleton. Changes: configured from `REDIS_URL` via `parseRedisUrl`, `lazyConnect: true`,
logger instead of console (connection `error` events at `warn` with `err.message` only, rate-limited to one
per 10 s to avoid flooding while Docker is down), `ping()`, and a `disconnect()` that falls back to
`connection.disconnect()` if `quit()` rejects and is a no-op when no connection was ever created.

Three connection profiles, because one setting cannot serve all of them:

| Used by | Options | Why |
|---|---|---|
| `RedisPool.getConnection()` (cancel flag `set`/`exists`/`del`, health `ping`) | `maxRetriesPerRequest: 1`, `connectTimeout: 5_000`, `enableOfflineQueue: true` | An HTTP request (cancel) must fail fast with 500 when Redis is down instead of hanging. |
| BullMQ `Queue` (API and worker; enqueue, `getJob`, `remove`) | `getQueueConnectionOptions()` = base + `maxRetriesPerRequest: 1` | BullMQ's production guidance: producers fail fast. |
| BullMQ `Worker` | `getWorkerConnectionOptions()` = base + `maxRetriesPerRequest: null` | Required by BullMQ for the blocking worker connection. |

```ts
import { Redis, type RedisOptions } from "ioredis";

export function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isInteger(db) ? db : 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
  };
}

export class RedisPool {
  private static connection: Redis | null = null;
  private static baseOptions(): RedisOptions { return { ...parseRedisUrl(REDIS_URL), enableReadyCheck: true, connectTimeout: 5_000 }; }
  static getQueueConnectionOptions(): RedisOptions { return { ...RedisPool.baseOptions(), maxRetriesPerRequest: 1 }; }
  static getWorkerConnectionOptions(): RedisOptions { return { ...RedisPool.baseOptions(), maxRetriesPerRequest: null }; }
  static getConnection(): Redis { /* lazily new Redis({ ...baseOptions(), maxRetriesPerRequest: 1, lazyConnect: true }) + listeners */ }
  static async connect(): Promise<void> { /* connect() when status === "wait"; then ping() */ }
  static async ping(): Promise<number> { /* latency ms */ }
  static async disconnect(): Promise<void> { /* quit(), fallback disconnect(); null the singleton */ }
}
```

BullMQ receives connection **options** (not the shared client) so it manages its own blocking connections,
exactly as Uply does.

### 9.4 `QueueService` (`utilities/services/queue-service.ts`)

Rewritten from Uply `services/runs/enqueue/queue-service.ts` for the single queue of 00 §10. Kept patterns:
all-or-nothing `initialize()` with `closeAfterStartupFailure`, idempotent worker-start guard, `close()` that
closes every resource with `Promise.allSettled` and aggregates failures, `createQueue`/`createWorker` factories
as test seams, workers closed before queues. Removed: scheduler/billing/alert/SMTP queues, repeatable jobs,
bulk chunking, inline "execute without queue" fallback (enqueue without an initialized queue is an error).
Moved to `utilities/services/` (00 §7) and decoupled from the pipeline: the processor is **injected** by
`worker.ts` (00 §14.6), so `utilities` never imports `services`.

Processor contract (00 §14.6): the processor receives **one object** `{ visualizationId, jobId, signal }`.
`signal` aborts on user cancel (Redis flag polled every `CANCEL_POLL_INTERVAL_MS`) or worker shutdown, and
`signal.reason` is the **string** `"cancelled"` or `"shutdown"`. Because `signal.throwIfAborted()` and every
signal-aware API reject with `signal.reason`, code that awaits with this signal may see a thrown **string**:
callers decide by `signal.aborted` / `jobAbortReason(signal)`, never by `error instanceof Error`, and use
`throwIfJobAborted(signal)` when they want an `Error` instance.

```ts
import { Queue, Worker, type Job, type JobsOptions, type Processor, type QueueOptions, type WorkerOptions } from "bullmq";

export interface VisualizationJobData { visualizationId: number; }
export type JobAbortReason = "cancelled" | "shutdown";

/** What the injected processor receives (00 §14.6). */
export interface VisualizationJob {
  visualizationId: number;
  jobId: string;
  /** Aborted with reason "cancelled" (user cancel) or "shutdown" (worker stopping). */
  signal: AbortSignal;
}
export type VisualizationJobProcessor = (job: VisualizationJob) => Promise<void>;
/** @deprecated name kept for sheets written against Revision 1; identical to VisualizationJob. */
export type VisualizationJobContext = VisualizationJob;

/** Error form of an abort, for code that must throw an Error (01 §5.7: throw only Error instances). */
export class JobAbortedError extends Error {
  constructor(readonly reason: JobAbortReason) {
    super(reason === "cancelled" ? "Visualization cancelled by user" : "Worker shutting down");
    this.name = "JobAbortedError";
  }
}

/** "cancelled" | "shutdown" when the signal was aborted by QueueService, otherwise null (not aborted, or a timeout). */
export function jobAbortReason(signal: AbortSignal): JobAbortReason | null {
  const reason: unknown = signal.reason;
  return signal.aborted && (reason === "cancelled" || reason === "shutdown") ? reason : null;
}

/** Throws JobAbortedError for a QueueService abort, or the signal's own reason (e.g. a TimeoutError) otherwise. */
export function throwIfJobAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = jobAbortReason(signal);
  if (reason !== null) throw new JobAbortedError(reason);
  signal.throwIfAborted();
}

export function parseVisualizationJobData(input: unknown): VisualizationJobData {
  // object with integer visualizationId > 0, else throw Error("Invalid visualization job data")
}

export class QueueService {
  private static queue: Queue<VisualizationJobData> | null = null;
  private static worker: Worker<VisualizationJobData> | null = null;
  private static initialized = false;
  private static readonly activeJobs = new Map<number, { controller: AbortController; cancelTimer: NodeJS.Timeout; polling: boolean }>();

  static visualizationJobId(visualizationId: number): string { return `${VISUALIZATION_JOB_ID_PREFIX}${visualizationId}`; }

  /** Opens the queue. Idempotent; all-or-nothing. */
  static async initialize(): Promise<void> {
    if (QueueService.initialized) return;
    try {
      QueueService.queue = QueueService.createQueue(VISUALIZATION_QUEUE, {
        connection: RedisPool.getQueueConnectionOptions(), prefix: QUEUE_PREFIX,
      });
      await QueueService.queue.waitUntilReady();
      QueueService.initialized = true;
    } catch (error: unknown) {
      await QueueService.closeAfterStartupFailure(error);
      throw error;
    }
  }

  /** Worker process only. Starts the single concurrency-1 worker with the injected processor. */
  static async startVisualizationWorker(processor: VisualizationJobProcessor): Promise<void> {
    if (QueueService.worker) return;
    await QueueService.initialize();
    try {
      const worker = QueueService.createWorker(VISUALIZATION_QUEUE, async (job: Job<VisualizationJobData>) => {
        const data = parseVisualizationJobData(job.data);
        const controller = new AbortController();
        const entry = {
          controller,
          polling: false,
          cancelTimer: setInterval(() => {
            QueueService.pollCancel(data.visualizationId, entry);
          }, CANCEL_POLL_INTERVAL_MS),
        };
        QueueService.activeJobs.set(data.visualizationId, entry);
        QueueService.pollCancel(data.visualizationId, entry); // a cancel requested while the job was waiting
        try {
          await processor({
            visualizationId: data.visualizationId,
            jobId: job.id ?? QueueService.visualizationJobId(data.visualizationId),
            signal: controller.signal,
          });
        } finally {
          clearInterval(entry.cancelTimer);
          QueueService.activeJobs.delete(data.visualizationId);
        }
      }, {
        connection: RedisPool.getWorkerConnectionOptions(),
        prefix: QUEUE_PREFIX,
        concurrency: VISUALIZATION_WORKER_CONCURRENCY,
        lockDuration: WORKER_LOCK_DURATION_MS, // 300 000 (00 §14.6)
        maxStalledCount: WORKER_MAX_STALLED_COUNT, // 0: a stalled job fails, never re-runs (00 §14.6)
      });
      worker.on("active", (job) => { log.info({ event: "queue.job.started", jobId: job.id, visualizationId: job.data.visualizationId }, "Visualization job started"); });
      worker.on("completed", (job) => { log.info({ event: "queue.job.completed", jobId: job.id }, "Visualization job completed"); });
      worker.on("failed", (job, error) => { log.error({ event: "queue.job.failed", jobId: job?.id ?? null, err: error }, "Visualization job failed"); });
      worker.on("stalled", (jobId) => { log.warn({ event: "queue.job.stalled", jobId }, "Visualization job stalled (will be failed, not retried)"); });
      worker.on("error", (error) => { log.error({ event: "queue.worker.error", err: error }, "Visualization worker error"); });
      QueueService.worker = worker;
    } catch (error: unknown) {
      await QueueService.closeAfterStartupFailure(error);
      throw error;
    }
  }

  /** Idempotent enqueue (jobId viz-<id>). Returns alreadyQueued=true if a job with that id already exists. */
  static async enqueueVisualization(visualizationId: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    const queue = QueueService.requireQueue();
    const data = parseVisualizationJobData({ visualizationId });
    const jobId = QueueService.visualizationJobId(visualizationId);
    const existing = await queue.getJob(jobId);
    if (existing) return { jobId, alreadyQueued: true };
    const options: JobsOptions = {
      jobId,
      attempts: VISUALIZATION_JOB_ATTEMPTS,
      removeOnComplete: JOB_RETENTION.removeOnComplete,
      removeOnFail: JOB_RETENTION.removeOnFail,
    };
    await queue.add(VISUALIZATION_JOB, data, options); // BullMQ ignores a duplicate jobId, so a race is harmless
    log.info({ event: "queue.job.enqueued", jobId, visualizationId }, "Visualization job enqueued");
    return { jobId, alreadyQueued: false };
  }

  /** Removes the job if it is still waiting/delayed/prioritized. Returns true when removed (it will never run). */
  static async removeQueuedVisualization(visualizationId: number): Promise<boolean> {
    const job = await QueueService.requireQueue().getJob(QueueService.visualizationJobId(visualizationId));
    if (!job) return false;
    const state = await job.getState();
    if (state !== "waiting" && state !== "delayed" && state !== "prioritized") return false;
    try {
      await job.remove();
      return true;
    } catch (error: unknown) {
      // The worker locked it between getState and remove: it is running now; the caller falls back to the flag.
      log.warn({ event: "queue.job.remove_failed", visualizationId, err: error }, "Queued job could not be removed");
      return false;
    }
  }

  static async getVisualizationJobState(visualizationId: number): Promise<string | "missing"> {
    const job = await QueueService.requireQueue().getJob(QueueService.visualizationJobId(visualizationId));
    return job ? job.getState() : "missing";
  }

  /** Sets prvision:cancel:<id> = "1" EX 86400 (00 §10). Callable from API or worker. */
  static async requestCancel(visualizationId: number): Promise<void> {
    await RedisPool.getConnection().set(QueueService.cancelKey(visualizationId), "1", "EX", CANCEL_KEY_TTL_SECONDS);
  }
  static async isCancelRequested(visualizationId: number): Promise<boolean> {
    return (await RedisPool.getConnection().exists(QueueService.cancelKey(visualizationId))) === 1;
  }
  static async clearCancel(visualizationId: number): Promise<void> {
    await RedisPool.getConnection().del(QueueService.cancelKey(visualizationId));
  }

  static isInitialized(): boolean { return QueueService.initialized; }

  /**
   * Aborts active jobs (reason "shutdown"), closes the worker (force after WORKER_CLOSE_TIMEOUT_MS),
   * then the queue. No-op when nothing was opened. Always resets state; throws one aggregated error if any
   * close failed.
   */
  static async close(): Promise<void> { /* see algorithm below */ }

  /** Fire-and-forget by design (interval callback): never rejects, never overlaps a previous poll of the same job. */
  private static pollCancel(visualizationId: number, entry: { controller: AbortController; polling: boolean }): void {
    if (entry.controller.signal.aborted || entry.polling) return;
    entry.polling = true;
    QueueService.checkCancel(visualizationId, entry).catch((error: unknown) => {
      log.warn({ event: "queue.cancel.poll_failed", visualizationId, err: error }, "Cancel flag poll failed");
    });
  }
  private static async checkCancel(visualizationId: number, entry: { controller: AbortController; polling: boolean }): Promise<void> {
    try {
      if ((await QueueService.isCancelRequested(visualizationId)) && !entry.controller.signal.aborted) {
        log.info({ event: "queue.job.cancel_seen", visualizationId }, "Cancel flag seen; aborting active job");
        entry.controller.abort("cancelled");
      }
    } finally {
      entry.polling = false;
    }
  }
  private static cancelKey(visualizationId: number): string { return `${CANCEL_KEY_PREFIX}${visualizationId}`; }
  private static requireQueue(): Queue<VisualizationJobData> {
    if (!QueueService.queue) throw new Error("QueueService must be initialized before use");
    return QueueService.queue;
  }
  private static async closeAfterStartupFailure(startupError: unknown): Promise<void> { /* Uply behaviour, logger */ }
  private static createQueue(name: string, options: QueueOptions): Queue<VisualizationJobData> { return new Queue<VisualizationJobData>(name, options); }
  private static createWorker(name: string, processor: Processor<VisualizationJobData>, options: WorkerOptions): Worker<VisualizationJobData> {
    return new Worker<VisualizationJobData>(name, processor, options);
  }
}
```

`pollCancel` is a fire-and-forget boundary (an interval callback cannot `await`): it calls the async
`checkCancel` and attaches `.catch(handler)`, the one form 01 §5.9.1 allows, so nothing floats.

`close()` algorithm:

1. For each entry in `activeJobs`: `clearInterval`, `controller.abort("shutdown")`.
2. If a worker exists: `await Promise.race([worker.close(), timeout(WORKER_CLOSE_TIMEOUT_MS)])`; on timeout
   log `warn` and `await worker.close(true)` (force — BullMQ releases the lock; with `maxStalledCount: 0` the
   job ends up failed and 07's startup recovery marks the row).
3. Close the queue.
4. Null all references, `initialized = false`, clear `activeJobs`.
5. Aggregate rejected closes into `Error("Failed to close queue resources: …")` (Uply wording).

Contract for 07 (orchestrator): check `job.signal.aborted` between stages and per component, pass the signal
into every long call (`runProcess`, AI providers, Playwright); when aborted, read `jobAbortReason(job.signal)`:
`"cancelled"` → status `cancelled`; `"shutdown"` → status `failed` with message "Worker stopped before the
visualization finished"; `null` with `signal.aborted` (07's own `AbortSignal.any([job.signal,
AbortSignal.timeout(VISUALIZATION_MAX_RUNTIME_MS)])`) → `failed` with the timeout message. 07 also calls
`clearCancel(id)` when the job ends, and `PipelineContext.isCancelled()` delegates to `isCancelRequested`.

### 9.5 `GitClient` (`utilities/services/git-client.ts`)

All git access in PRVision goes through this class (06 detection/branches, 07 worktrees/fetch/patch, 08
diffs/file reads). It never uses a shell, never runs in the user's working tree except read-only commands
and `worktree add/remove/prune` (which only touch `.git/worktrees`), and maps every failure to
`GitCommandError`.

Hardening applied to **every** invocation:

```ts
/** Top-level options placed before the subcommand. */
const GIT_SAFE_ARGS: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",   // never run the user's hooks (post-checkout runs on worktree add)
  "-c", "core.fsmonitor=false",       // fsmonitor can execute a configured program
  "-c", "core.quotepath=false",       // UTF-8 paths unescaped
  "-c", "color.ui=never",
  "-c", "advice.detachedHead=false",
  "-c", "gc.auto=0",                  // no background gc in the user's repo
  "-c", "maintenance.auto=false",
  "-c", "credential.helper=",         // no credential helpers (keychain prompts, stored creds); 00 §14.8
  "-c", "protocol.ext.allow=never",   // ext:: remotes run arbitrary commands
  "-c", "filter.lfs.required=false",  // LFS pointers stay pointers (with GIT_LFS_SKIP_SMUDGE) even without git-lfs
  "-c", "submodule.recurse=false",
  "--no-pager",
];

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",           // fail instead of prompting for credentials
  GCM_INTERACTIVE: "never",
  GIT_LFS_SKIP_SMUDGE: "1",           // no LFS downloads into worktrees
  GIT_OPTIONAL_LOCKS: "0",            // status/diff never take index.lock in the user's repo
  LC_ALL: "C", LANG: "C",             // stable stderr for error mapping
  GIT_PAGER: "cat", PAGER: "cat",
};
```

Diff-producing commands also pass `--no-ext-diff --no-textconv --no-color` (user-configured external diff
drivers and textconv filters are programs). Every ref argument is validated by `assertSafeRef()` and placed
after `--end-of-options` where the subcommand supports it; every path argument goes after `--`. The child
environment is `{ ...CHILD_PROCESS_BASE_ENV, ...GIT_ENV, ...callEnv }` — an allow-list (00 §14.5), so
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*` from the parent can never redirect a command, and
the only way a token reaches git is the per-call `GIT_CONFIG_COUNT` env of `fetch`.

Every method takes an optional last parameter `options?: GitCallOptions` (`{ signal?, timeoutMs? }`); the
signal is forwarded to `runProcess`, so cancelling a job kills a running git command.

```ts
export type GitErrorCode =
  | "git_not_found" | "unsupported_version" | "not_a_repository" | "unknown_revision" | "no_merge_base"
  | "auth_failed" | "network" | "worktree_exists" | "patch_failed" | "invalid_argument"
  | "timeout" | "aborted" | "output_too_large" | "command_failed";

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: GitErrorCode,
    readonly subcommand: string,
    readonly exitCode: number | null,
    readonly stderr: string,        // redacted via redactSecrets, truncated to 4,000 chars
    options?: { cause?: unknown },
  ) { super(message, options); this.name = "GitCommandError"; }
}

/** One `--name-status -z` record, uninterpreted (08 maps it to 00 §8 changedFiles). */
export interface GitNameStatusEntry {
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X"; // first letter of git's status column
  score?: number;                                        // R/C similarity, e.g. 87
  path: string;                                          // new path (R/C) or the only path, as git printed it
  previousPath?: string;                                 // R/C only
}
export interface GitStatusEntry { index: string; worktree: string; path: string; originalPath?: string; }
export interface GitVersion { raw: string; major: number; minor: number; patch: number; }
export interface GitAuthHeader { urlPrefix: string; header: string; } // e.g. { urlPrefix: "https://github.com/", header: "AUTHORIZATION: basic <b64>" }
export interface GitCallOptions { signal?: AbortSignal; timeoutMs?: number; }

export class GitClient {
  constructor(private readonly options: { binary?: string; runner?: typeof runProcess } = {}) {}
  // methods below
}
```

Method table (cwd = absolute repository or worktree path; passed as `-C <cwd>`; spawn `cwd` is the data dir):

| Method | Returns | argv after `GIT_SAFE_ARGS -C <cwd>` | Timeout | Special exit / error mapping |
|---|---|---|---|---|
| `version(options?)` | `GitVersion` | `--version` (no `-C`) | default | ENOENT → `git_not_found` |
| `assertSupportedVersion(options?)` | `void` | uses `version()` | default | < `GIT_MIN_VERSION` → `unsupported_version` |
| `isRepository(path, options?)` | `boolean` | `rev-parse --is-inside-work-tree` | default | `not_a_repository` → `false` |
| `topLevel(path, options?)` | `string` (absolute) | `rev-parse --show-toplevel` | default | |
| `revParse(cwd, rev, options?)` | `string` sha | `rev-parse --verify --quiet --end-of-options <rev>^{commit}` | default | exit 1 → `unknown_revision` |
| `hasCommit(cwd, sha, options?)` | `boolean` | `cat-file -e --end-of-options <sha>^{commit}` | default | exit 1/128 → `false` |
| `mergeBase(cwd, a, b, options?)` | `string` sha | `merge-base --end-of-options <a> <b>` | default | exit 1 → `no_merge_base` |
| `fetch(cwd, { remote, refspecs, auth?, depth? }, options?)` | `void` | `fetch --no-tags --no-recurse-submodules --no-write-fetch-head --no-auto-maintenance --quiet [--depth=<n>] --end-of-options <remote> <refspec…>` (`credential.helper=` comes from `GIT_SAFE_ARGS`); when `auth`: env `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.<urlPrefix>.extraHeader`, `GIT_CONFIG_VALUE_0=<header>` | `options.timeoutMs ?? GIT_FETCH_TIMEOUT_MS` | stderr auth patterns → `auth_failed`; network patterns → `network`; `couldn't find remote ref` → `unknown_revision` |
| `deleteRef(cwd, ref, options?)` | `void` | `update-ref -d --end-of-options <ref>`; `ref` must start with `refs/prvision/` (else `invalid_argument` before spawning) | default | stderr `not exist` / `unable to resolve` / `cannot lock ref` for a missing ref → success (idempotent) |
| `worktreeAdd(repoPath, dir, sha, options?)` | `void` | `worktree add --detach --quiet <dir> <sha>`; `sha` must match `^[0-9a-f]{40}([0-9a-f]{24})?$`, `dir` must be absolute and inside `<dataDir>/worktrees/` | `GIT_WORKTREE_TIMEOUT_MS` | `already exists` → `worktree_exists` |
| `worktreeRemove(repoPath, dir, options?)` | `void` | `worktree remove --force --force <dir>` | `GIT_WORKTREE_TIMEOUT_MS` | `is not a working tree` / `No such file` → success (idempotent) |
| `worktreePrune(repoPath, options?)` | `void` | `worktree prune` | default | |
| `worktreeList(repoPath, options?)` | `string[]` (absolute dirs) | `worktree list --porcelain -z` | default | parse `worktree <path>` records |
| `diffNameStatus(cwd, from, to \| null, { renames?, pathspecs? }?, options?)` | `GitNameStatusEntry[]` | `diff --name-status -z (-M \| --no-renames) --no-ext-diff --no-textconv --no-color --end-of-options <from> [<to>] -- [pathspecs…]` (`renames` default true; `to` `null` = `from` vs working tree; pathspecs pass `normalizeRepoRelativePath`) | default | see parser |
| `diffNameStatusNoIndex(cwd, left, right, { renames? }?, options?)` | `GitNameStatusEntry[]` | `diff --no-index --name-status -z (-M \| --no-renames) --no-ext-diff --no-textconv --no-color -- <left> <right>` (`left`/`right` are cwd-relative, pass `normalizeRepoRelativePath`; `cwd` need not be a repository) | default, `allowedExitCodes: [0, 1]` (1 = "differences found") | paths are returned exactly as git prints them (prefixed with `left/` / `right/`; 08 strips the prefixes) |
| `diffUnified(cwd, base, head \| null, { paths?, contextLines? }, options?)` | `string` | `diff --no-ext-diff --no-textconv --no-color -M -U<n=3> <base> [<head>] -- [paths…]` | default | |
| `diffBinaryHead(cwd, options?)` | `string` (patch) | `-c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.relative=false diff --binary --no-ext-diff --no-textconv --no-color --ignore-submodules=all HEAD --` (staged + unstaged tracked changes; the `-c` options keep `a/`/`b/` prefixes so `git apply` works whatever the user's config) | default, maxBuffer `GIT_MAX_BUFFER_BYTES` | over the cap → `output_too_large` |
| `applyPatch(cwd, patch, options?)` | `void` | `apply --whitespace=nowarn --binary -` with `input: patch`; empty/whitespace patch → no-op without spawning | default | non-zero → `patch_failed` |
| `lsUntracked(cwd, options?)` | `string[]` POSIX | `ls-files --others --exclude-standard -z` | default | |
| `statusPorcelain(cwd, options?)` | `GitStatusEntry[]` | `status --porcelain=v1 -z --untracked-files=all` | default | see parser |
| `isDirty(cwd, options?)` | `boolean` | `statusPorcelain(cwd).length > 0` | | |
| `listBranches(cwd, options?)` | `string[]` | `for-each-ref --format=%(refname:short) --sort=-committerdate refs/heads/` | default | |
| `currentBranch(cwd, options?)` | `string \| null` | `symbolic-ref --quiet --short HEAD` | default | exit 1 (detached) → `null` |
| `remoteUrl(cwd, remote = "origin", options?)` | `string \| null` | `remote get-url --end-of-options <remote>` | default | exit 2 / `No such remote` → `null` |
| `symbolicRefDefault(cwd, remote = "origin", options?)` | `string \| null` (`"main"`) | `symbolic-ref --quiet --short refs/remotes/<remote>/HEAD` → strip `<remote>/` | default | exit 1/128 → `null` |
| `showFile(cwd, rev, path, options?)` | `string \| null` | `cat-file blob <rev>:<path>` (not `git show`, which may apply textconv) | default, maxBuffer 16 MiB | `does not exist` / `Not a valid object name` / `path ... exists on disk, but not in` → `null` (callers resolve `rev` first) |
| `listFiles(cwd, rev, options?)` | `string[]` | `ls-tree -r --name-only -z --end-of-options <rev>` | default | |
| `logSubject(cwd, rev, options?)` | `string` | `log -1 --format=%s --end-of-options <rev>` | default | |

Core runner and error mapping:

```ts
private async run(cwd: string | null, args: readonly string[], options: {
  timeoutMs?: number; maxBufferBytes?: number; input?: string; env?: Record<string, string>;
  allowedExitCodes?: readonly number[]; signal?: AbortSignal;
} = {}): Promise<ProcessResult> {
  const argv = [...GIT_SAFE_ARGS, ...(cwd === null ? [] : ["-C", cwd]), ...args];
  const subcommand = args[0] ?? "unknown";
  try {
    return await (this.options.runner ?? runProcess)(this.options.binary ?? GIT_BINARY, argv, {
      cwd: DATA_DIR,
      env: { ...CHILD_PROCESS_BASE_ENV, ...GIT_ENV, ...options.env },
      timeoutMs: options.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
      maxBufferBytes: options.maxBufferBytes ?? GIT_MAX_BUFFER_BYTES,
      input: options.input,
      allowedExitCodes: options.allowedExitCodes ?? [0],
      signal: options.signal,
      logLabel: `git ${subcommand}`,
    });
  } catch (error: unknown) {
    throw toGitCommandError(error, subcommand);
  }
}

const STDERR_PATTERNS: ReadonlyArray<[RegExp, GitErrorCode]> = [
  [/not a git repository|cannot change to/i, "not_a_repository"],
  [/authentication failed|could not read username|terminal prompts disabled|invalid username or password|\b40[13]\b|permission denied \(publickey\)/i, "auth_failed"],
  [/could not resolve host|failed to connect|connection (timed out|refused)|network is unreachable|unable to access/i, "network"],
  [/couldn't find remote ref|unknown revision|bad revision|invalid object name|not a valid object name|needed a single revision|ambiguous argument/i, "unknown_revision"],
  [/already exists|is a missing but already registered worktree/i, "worktree_exists"],
];

export function toGitCommandError(error: unknown, subcommand: string): GitCommandError {
  if (!(error instanceof ProcessError)) return new GitCommandError(`git ${subcommand} failed`, "command_failed", subcommand, null, "", { cause: error });
  const stderr = redactSecrets(error.stderr).slice(0, 4_000);
  const code: GitErrorCode =
    error.kind === "spawn_failed" ? "git_not_found"
    : error.kind === "timeout" ? "timeout"
    : error.kind === "aborted" ? "aborted"
    : error.kind === "max_buffer" ? "output_too_large"
    : subcommand === "apply" ? "patch_failed"
    : STDERR_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "command_failed";
  return new GitCommandError(`git ${subcommand} failed (${code})`, code, subcommand, error.exitCode, stderr, { cause: error });
}
```

Methods with meaningful non-zero exits pass `allowedExitCodes` (e.g. `currentBranch` passes `[0, 1]` and
returns `null` on 1) instead of catching errors. `run()` logs every mapped failure once at `warn` (`event: "git.command.failed"`, `subcommand`, `code`,
`exitCode`, `stderr` already redacted and cut to 2 000 chars) except `aborted`, which is logged at `debug`;
callers do not log the same error again.

Argument validation (throw `GitCommandError(..., "invalid_argument", ...)` before spawning):

```ts
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[A-Za-z0-9._\/+-]{1,255}(\^\{commit\})?$/;
export function assertSafeRef(ref: string): void { if (!SAFE_REF.test(ref) || ref.endsWith(".lock") || ref.endsWith("/")) throw ... }
// refspecs: "+<src>:<dst>" where src/dst pass SAFE_REF; dst must start with "refs/prvision/" (00 §4) or "refs/remotes/".
// paths: absolute for cwd/dir args (no NUL); repo-relative args pass normalizeRepoRelativePath (§9.7).
// remote: SAFE_REF-like name or an https:// URL (no credentials in the URL — rejected if url.username/password set).
```

Parsers (pure, exported for tests):

- `parseNameStatusZ(stdout): GitNameStatusEntry[]`: split on `\0` (drop the trailing empty token); read the
  status token; `R<score>`/`C<score>` consume two paths (old → `previousPath`, new → `path`) and set `score`;
  every other status consumes one path. `status` is the first letter (`A M D R C T U X`); an unknown letter
  throws `GitCommandError(..., "command_failed")` (git output format changed). No interpretation: mapping to
  00 §8 `changedFiles` (`C`→`A`, `T`/`U`→`M`, dropping `X`) is 08's job. Paths are returned as-is (git emits
  POSIX; with `core.quotepath=false` and `-z` they are never quoted).
- `parseStatusPorcelainZ(stdout)`: records `XY<space><path>\0`; when `X` is `R` or `C` the next token is the
  original path.
- `parseWorktreeListZ(stdout)`: blocks separated by an empty token; take `worktree <path>` lines.
- `parseGitVersion("git version 2.43.0")` → `{ major: 2, minor: 43, patch: 0 }` (tolerates suffixes like
  `.windows.1`, `(Apple Git-146)`).

Token handling for `fetch`: the header travels in the child's environment (`GIT_CONFIG_*`), not argv, so it
is not visible in `ps`. It is scoped to `urlPrefix` so a redirect to another host does not receive it.
`credential.helper=` disables the user's helpers for this call (no keychain prompts, deterministic auth).
Building the header (`"AUTHORIZATION: basic " + base64("x-access-token:" + token)`) is 06's job; the
GitClient never logs `auth`.

### 9.6 `runProcess` (`utilities/helpers/process.ts`)

`spawn`-based (needed for stdin input) with the semantics of `execFile` + `timeout` + `maxBuffer` +
`signal`. Never `shell: true`.

```ts
export interface RunProcessOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;   // default CHILD_PROCESS_BASE_ENV (never raw process.env)
  timeoutMs: number;                        // required: no unbounded children
  maxBufferBytes?: number;                  // per stream; default CHILD_PROCESS_MAX_BUFFER_BYTES (10 MiB)
  input?: string | Buffer;
  allowedExitCodes?: readonly number[];     // default [0]
  signal?: AbortSignal;
  logLabel?: string;                        // e.g. "git diff"; args are never logged
}
export interface ProcessResult { stdout: string; stderr: string; exitCode: number; durationMs: number; }

export type ProcessErrorKind = "spawn_failed" | "timeout" | "aborted" | "max_buffer" | "non_zero_exit";
export class ProcessError extends Error {
  constructor(message: string, readonly kind: ProcessErrorKind, readonly command: string,
    readonly exitCode: number | null, readonly signalName: NodeJS.Signals | null,
    readonly stdout: string, readonly stderr: string, readonly durationMs: number, options?: { cause?: unknown }) {
    super(message, options); this.name = "ProcessError";
  }
}

export async function runProcess(command: string, args: readonly string[], options: RunProcessOptions): Promise<ProcessResult>;
```

Algorithm:

1. If `options.signal?.aborted` → reject `aborted` without spawning.
2. `spawn(command, [...args], { cwd, env: options.env ?? CHILD_PROCESS_BASE_ENV, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true, windowsHide: true, shell: false })`.
   `detached: true` puts the child in its own process group so a kill reaches its grandchildren too
   (`git fetch` → `git-remote-https`/`ssh`; `npm` → `node`). It also keeps a terminal Ctrl-C from hitting the
   child directly: children die through the abort signal during graceful shutdown instead.
3. Collect stdout/stderr `Buffer` chunks with running byte counts. Exceeding `maxBufferBytes` on either stream
   → mark `max_buffer`, kill.
4. Timer `timeoutMs` → mark `timeout`, kill. Abort listener → mark `aborted`, kill.
   Kill = `process.kill(-child.pid, "SIGTERM")` (whole group; fall back to `child.kill("SIGTERM")` when the
   group kill throws `ESRCH`), then `SIGKILL` to the group after `PROCESS_KILL_GRACE_MS` if the child has not
   closed. The grace timer is `unref()`ed.
5. Write `input` to stdin then `end()`; ignore `EPIPE` on stdin (child may exit early).
6. On `error` event (ENOENT/EACCES) → reject `spawn_failed`.
7. On `close(code, signal)`: clear timers/listeners; if a kill reason was marked → reject with that kind;
   else if `code` in `allowedExitCodes` → resolve; else reject `non_zero_exit`.
8. Decode both streams as UTF-8 once at the end. `durationMs` via `performance.now()`.
9. Log one `debug` line `{ label: logLabel ?? path.basename(command), exitCode, durationMs, kind? }`; never the
   argv, env or stdin (they may contain tokens or patches).

Sheets 07 (`npm`/`node` checks), 10 (Vite server) must use `runProcess` or, for long-lived children, a
`spawn`/`fork` with an env built from `CHILD_PROCESS_BASE_ENV` plus explicit call-specific values, and their own
lifecycle — never `process.env` (which only `config-consts` may read). 05's Claude Code child starts from
`AI_CLAUDE_CODE_PARENT_ENV` (02 §6.7) instead. None of these environments may contain `PRVISION_SECRET_KEY`,
`DATABASE_URL` or `REDIS_URL` (00 §14.5); the allow-list guarantees it.

`ProcessError.message` is `"<label> failed (<kind>[, exit <code>])"` — it never contains argv, env or output.
`stdout`/`stderr` on the error are raw; callers that persist or log them pass them through `redactSecrets()` and
truncate (`GitCommandError` does this).

### 9.7 `paths.ts`

```ts
export class PathOutsideRootError extends Error { constructor(readonly root: string, readonly attempted: string) { super(`Path escapes root`); this.name = "PathOutsideRootError"; } }

/** "~" or "~/x" → homedir-based absolute path. Other inputs returned unchanged. "~user" is not supported (returned unchanged). */
export function expandHome(input: string, homeDir: string = os.homedir()): string;
/** Backslashes → "/" (for values coming from tools); does not resolve. */
export function toPosixPath(input: string): string;
/** True when child (resolved) equals or is inside parent (resolved). Uses path.relative; rejects ".." prefixes and absolute results. */
export function isPathInside(parent: string, child: string): boolean;
/** path.resolve(root, ...segments) and assert isPathInside; rejects NUL bytes. Throws PathOutsideRootError. */
export function resolveInside(root: string, ...segments: string[]): string;
/** Repo-relative POSIX path: strips leading "./", rejects absolute, NUL, empty and any ".." segment. Throws PathOutsideRootError. */
export function normalizeRepoRelativePath(input: string): string;
/**
 * Symlink-safe containment: realpath(root) vs realpath of `candidate`, or of its deepest existing ancestor when
 * `candidate` does not exist yet (a file about to be written). Use it before reading or writing any path that
 * could traverse a symlink created by repository content (worktrees, harness folder, untracked files).
 */
export async function isRealPathInside(root: string, candidate: string): Promise<boolean>;
export function isRealPathInsideSync(root: string, candidate: string): boolean;
```

`paths.ts` imports only `node:os`, `node:path` and `node:fs` (no config, no logger), so any layer may use it.
`isPathInside`/`resolveInside` are **lexical**: they stop `../` escapes but not symlinks. Code that handles paths
inside a worktree (repository-controlled content) must also use `isRealPathInside`. `config-consts` has its own
`resolveDataDir` (02 §6.7) and does not import this file.

### 9.8 `ArtifactStore` (`utilities/services/artifact-store.ts`)

Owns the data-dir layout of 00 §4. Paths stored in the DB are **relative to the data dir, POSIX**
(`artifacts/12/345/base.png`, 00 §14.3); absolute paths never leave the backend. The method list of 00 §14.8 is
authoritative; the extra methods below are what 07 uses for worktrees.

```ts
export type ArtifactImageKind = "base" | "head" | "diff";
export type WorktreeSide = "base" | "head";

export class ArtifactPathError extends Error {
  constructor(message: string, readonly attemptedPath: string) { super(message); this.name = "ArtifactPathError"; }
}

export class ArtifactStore {
  /** Absolute data dir (DATA_DIR by default). Read by 06 to refuse registering a folder inside it. */
  constructor(readonly dataDir: string = DATA_DIR) {
    if (!path.isAbsolute(dataDir)) throw new ArtifactPathError("Data dir must be absolute", dataDir);
  }

  // ----- roots -----
  artifactsRoot(): string { return path.join(this.dataDir, ARTIFACTS_DIR_NAME); }
  worktreesRoot(): string { return path.join(this.dataDir, WORKTREES_DIR_NAME); }
  fixturesRoot(): string { return path.join(this.dataDir, FIXTURES_DIR_NAME); }
  /** mkdir -p dataDir (mode 0o700, chmod 0o700 if it already existed), artifacts, worktrees, fixtures. */
  async ensureRoots(): Promise<void>;

  // ----- path builders (pure; ids validated as positive safe integers, else ArtifactPathError) -----
  /** "artifacts/<v>/<c>/<kind>.png" — the value stored in *_image_path and RenderSideResult.imagePath (00 §14.8). */
  componentImagePath(visualizationId: number, componentId: number, kind: ArtifactImageKind): string;
  /** Absolute <dataDir>/artifacts/<v>/<c> (00 §14.8). */
  componentDir(visualizationId: number, componentId: number): string;
  /** Absolute <dataDir>/artifacts/<v>. */
  visualizationArtifactsDir(visualizationId: number): string;
  /** Absolute <dataDir>/worktrees/<v> (07). */
  visualizationWorktreeRoot(visualizationId: number): string;
  /** Absolute <dataDir>/worktrees/<v>/<side> (07). */
  worktreeDir(visualizationId: number, side: WorktreeSide): string;

  // ----- safe resolution -----
  /**
   * dataDir-relative POSIX path → absolute path (00 §14.8). Throws ArtifactPathError on absolute input, NUL,
   * backslash, a `..` segment, a lexical escape, or a symlink anywhere on the path that resolves outside the
   * data dir (isRealPathInsideSync against realpath(dataDir)). Synchronous by design: callers use it to build
   * paths; the realpath walk touches only the few existing ancestors.
   */
  resolveSafe(relativePath: string): string;

  // ----- I/O (00 §14.8) -----
  /** mkdir -p <dataDir>/artifacts/<v>/<c> (mode 0o700). */
  async ensureComponentDir(visualizationId: number, componentId: number): Promise<void>;
  /** Reads a dataDir-relative file. Missing file → the fs ENOENT error (callers check `code === "ENOENT"`). */
  async read(relativePath: string): Promise<Buffer>;
  /**
   * Atomic write: parent dirs are created, data goes to "<file>.<pid>.<random>.tmp" in the same directory, then
   * rename. Returns relativePath. Never follows a symlink at the destination (rename replaces the link itself).
   */
  async write(relativePath: string, data: Buffer | string): Promise<string>;
  async exists(relativePath: string): Promise<boolean>;
  /** rm -rf <dataDir>/artifacts/<v>; no error when missing (00 §14.8). */
  async removeVisualization(visualizationId: number): Promise<void>;
  /** @deprecated Alias of removeVisualization (00 §14.12). New code calls removeVisualization. */
  async removeVisualizationArtifacts(visualizationId: number): Promise<void>;
  /** mkdir -p for an absolute directory that must be inside the data dir (07). */
  async ensureDir(absoluteDir: string): Promise<void>;
  /** rm -rf <dataDir>/worktrees/<v> — call only after GitClient.worktreeRemove + worktreePrune (07). */
  async removeVisualizationWorktreeRoot(visualizationId: number): Promise<void>;

  // ----- public URLs -----
  /** "artifacts/12/345/base.png" → "/artifacts/12/345/base.png"; null → null; any other shape → ArtifactPathError. */
  toPublicUrl(relativePath: string | null): string | null;
}
```

Rules:

- Every method that touches the filesystem passes through `resolveSafe` (relative input) or
  `resolveInside` + `isRealPathInside` (absolute input).
- `rm` is only ever called on `artifacts/<positive int>` or `worktrees/<positive int>`, with
  `fs.rm(dir, { recursive: true, force: true })`; Node's recursive `rm` removes symlinks without following them,
  so a symlink planted inside a worktree cannot make it delete outside the data dir.
- `toPublicUrl` checks the `artifacts/<int>/<int>/<kind>.png` shape so it matches the `/artifacts` guard
  exactly.
- `express.static` follows symlinks under `artifacts/`; nothing but `ArtifactStore.write` creates files there
  (PNG bytes only), and the data dir is `0700`, so no foreign symlink can appear in it.

### 9.9 `Encryption` (`utilities/processors/encryption.ts`)

Copy Uply's `encrypt`/`decrypt`/`getSecretKey`. Remove `hash`, `verify`, `getBcrypt`, `getBcryptRounds` and
the `BCRYPT_ROUNDS` import. Key source: `PRVISION_SECRET_KEY` (from config-consts, not `requireEnv`).
Compatible behaviour kept: key = `sha256(utf8(secret))`, AES-256-GCM, 12-byte random IV, payload
`base64(iv).base64(tag).base64(ciphertext)`. Changed: malformed input throws instead of returning the input
unchanged (Uply's passthrough would hand ciphertext-shaped garbage to GitHub/Anthropic as a token).

```ts
export class EncryptionError extends Error {
  constructor(readonly reason: "missing_key" | "malformed_payload" | "decrypt_failed", options?: { cause?: unknown }) {
    super(`Encryption error: ${reason}`, options); this.name = "EncryptionError";
  }
}

export class Encryption {
  static encrypt(value: string): string;
  /** Throws EncryptionError("malformed_payload") when not 3 base64 parts with a 12-byte IV and 16-byte tag;
   *  EncryptionError("decrypt_failed") when GCM auth fails (wrong key / tampered). */
  static decrypt(payload: string): string;
  static isEncryptedPayload(value: string): boolean;
  /** Test hook: overrides the key for the current process. */
  static setKeyForTesting(secret: string | null): void;
  private static getSecretKey(): Buffer; // throws EncryptionError("missing_key") when PRVISION_SECRET_KEY is ""
}
```

05 maps `decrypt_failed` to "Stored token can't be decrypted (secret key changed?) — re-enter it" and treats
the secret as absent. Plaintext and keys are never logged; `EncryptionError` messages contain only the reason.

### 9.10 Logger (`utilities/loggers/logger.ts`)

```ts
import { Writable } from "node:stream";
import pino, { type Logger, type LoggerOptions } from "pino";
import { IS_DEVELOPMENT, IS_TEST, LOG_LEVEL, LOG_TEST_STDOUT, PRVISION_SECRET_KEY } from "../../config-consts";
import { AuthContext } from "../context/auth-context";

/** Keys whose values are replaced by "[REDACTED]" wherever they appear (one level of nesting via "*."). */
export const REDACT_PATHS: string[] = [
  "token", "*.token", "githubToken", "*.githubToken", "apiKey", "*.apiKey", "anthropicApiKey", "*.anthropicApiKey",
  "githubTokenEncrypted", "*.githubTokenEncrypted", "anthropicApiKeyEncrypted", "*.anthropicApiKeyEncrypted",
  "password", "*.password", "secret", "*.secret", "secretKey", "*.secretKey",
  "authorization", "*.authorization", "Authorization", "*.Authorization", "auth", "*.auth", "cookie", "*.cookie",
  "headers.authorization", "*.headers.authorization", "req.headers.authorization", "headers.cookie",
  "err.request.headers.authorization", "err.response.headers.authorization",
  "env", "*.env", "databaseUrl", "redisUrl", "DATABASE_URL", "REDIS_URL", "PRVISION_SECRET_KEY",
  'headers["x-api-key"]', '*.headers["x-api-key"]',
];

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/(authorization:\s*(basic|bearer|token)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[REDACTED]@"],   // credentials in URLs (incl. postgres://user:pass@)
  [/(x-access-token:)[^\s@"']+/gi, "$1[REDACTED]"],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]"],
];

/**
 * Scrubs known secret shapes from free text (stderr, AI errors, messages persisted to the DB), plus the literal
 * value of PRVISION_SECRET_KEY should it ever appear.
 */
export function redactSecrets(text: string): string {
  const scrubbed = SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
  return PRVISION_SECRET_KEY.length >= 16 ? scrubbed.split(PRVISION_SECRET_KEY).join("[REDACTED]") : scrubbed;
}

/** Test destination (00 §14.10): under NODE_ENV=test the root logger writes here instead of stdout. */
export interface LogTestStream {
  /** Registers a listener for every log line (a JSON string); returns the unsubscribe function. */
  subscribe(listener: (line: string) => void): () => void;
}
const testListeners = new Set<(line: string) => void>();
const testDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    const line = chunk.toString();
    for (const listener of testListeners) listener(line);
    if (LOG_TEST_STDOUT) process.stdout.write(line);
    callback();
  },
});
export const logTestStream: LogTestStream = {
  subscribe(listener) {
    testListeners.add(listener);
    return () => { testListeners.delete(listener); };
  },
};

const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const options: LoggerOptions = {
  // An invalid LOG_LEVEL must not crash at import (pino throws on unknown levels): fall back to "info";
  // validateConfig() then reports the bad value at boot.
  level: VALID_LEVELS.has(LOG_LEVEL) ? LOG_LEVEL : "info",
  base: { app: "prvision", pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  serializers: {
    err: (error: unknown): unknown => {
      // Non-Error values (an abort reason string, a plain object) are logged as-is after redaction.
      if (typeof error === "string") return redactSecrets(error);
      if (typeof error !== "object" || error === null) return error;
      const serialized = pino.stdSerializers.err(error as Error) as unknown as Record<string, unknown>;
      delete serialized.request; delete serialized.response; delete serialized.config; delete serialized.headers;
      for (const key of ["message", "stack", "stderr", "stdout"]) {
        const value = serialized[key];
        if (typeof value === "string") serialized[key] = redactSecrets(value);
      }
      return serialized;
    },
  },
  mixin: () => { const requestId = AuthContext.getRequestId(); return requestId ? { requestId } : {}; },
  transport: IS_DEVELOPMENT
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,app" } }
    : undefined,
};

/** Root logger. JSON to stdout (production), pino-pretty (development), logTestStream (test). */
export const logger: Logger = IS_TEST ? pino(options, testDestination) : pino(options);

export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ module, ...bindings });
}
export async function flushLogger(): Promise<void> {
  await new Promise<void>((resolve) => { logger.flush(() => { resolve(); }); });
}
```

Rules:

- `utilities/loggers/` is the only place allowed to write to stdout/stderr (02's lint bans `console.*`
  elsewhere; the two last-resort `process.stderr.write` calls in `app.ts`/`worker.ts` are the documented
  exceptions).
- Every call is `log.<level>({ event, ...fields }, "Static message")` (01 §5.8). The snippets in this sheet show
  the `event` names; the full list is §12.
- Production (`NODE_ENV=production`) logs JSON lines to stdout. Under `NODE_ENV=test` every line goes to
  `logTestStream` (dropped unless a test subscribed or `PRVISION_TEST_LOG_STDOUT=1`); child loggers inherit the
  destination, which is why tests subscribe instead of patching loggers (00 §14.10).
- Pino's `redact` only matches the listed key paths; free text is protected by `redactSecrets`, which every sheet
  applies before persisting or logging command output, AI error text or upstream messages.

### 9.11 Graceful shutdown (`utilities/helpers/graceful-shutdown.ts`)

```ts
export interface ShutdownStep { name: string; close: () => Promise<void>; }
export interface GracefulShutdownOptions {
  role: "api" | "worker";
  timeoutMs: number;
  processLike?: Pick<NodeJS.Process, "on" | "exit">; // test seam
}
export interface ShutdownController { shutdown(exitCode: number, reason: string): Promise<void>; }

export function installGracefulShutdown(steps: readonly ShutdownStep[], options: GracefulShutdownOptions): ShutdownController;
export async function closeHttpServer(server: http.Server, graceMs = 5_000): Promise<void>;
/** Maps ECONNREFUSED (5433/6380), DatabaseNotReadyError, EADDRINUSE, ConfigValidationError to a one-line hint. */
export function describeBootError(error: unknown): { hint: string | null };
```

Behaviour:

1. `SIGINT`/`SIGTERM` → `shutdown(0, signal)`. A second signal while shutting down → log `warn` "forced
   exit" → `exit(1)` immediately.
2. `unhandledRejection` / `uncaughtException` → log `fatal` with `{ event: "process.crashed", err }` →
   `shutdown(1, "crash")`. After an uncaught exception the process state is suspect, so the force timer
   (step 3) is what guarantees the exit.
3. `shutdown`: idempotent; logs `info` "Shutting down" with role/reason; starts an unref'd force timer
   (`timeoutMs` → log `error` + `exit(1)`); runs steps **sequentially in the given order**, each in
   try/catch (failure logs `error` and sets exit code 1, then continues); clears the timer; `await flushLogger()`;
   `exit(code)`.
4. `closeHttpServer`: `server.close()` (stop accepting; Node ≥ 19 also closes idle keep-alive sockets);
   after `graceMs` call `server.closeAllConnections()`; resolves when `close` callback fires; ignores
   `ERR_SERVER_NOT_RUNNING`.

Order: API → http server, queues, redis, postgres. Worker → queues (aborts the active job first), redis,
postgres. `installGracefulShutdown` is called at the **start** of `bootstrap()` (§5.1/§5.2) so a signal or a
boot failure also closes what is open; therefore every close step is a no-op for a resource that was never
opened (`QueueService.close`, `RedisPool.disconnect`, `DbPool.close`, the http-server step). `exit` is
`process.exit` (or `processLike.exit` in tests); apart from the last-resort boot `.catch` in `app.ts`/`worker.ts`,
nothing else in the backend calls `process.exit`.

## 10. `PipelineStepError` (`src/types/pipeline-errors.ts`)

Created by 02 in the scaffold with this exact body (01 §5.7.3 is the same code; 00 §14.12 fixes the
constructor `(stage, userMessage, options?: { cause?; detail?; code? })` with `stage` typed as the non-terminal
`VisualizationStatus` values). Re-exported from `types/visualization-pipeline.ts`. This sheet owns the file afterwards.

```ts
import type { NonTerminalVisualizationStatus } from "../enums";

/**
 * Stage a fatal pipeline failure is attributed to (00 §14.7): every non-terminal VisualizationStatus
 * (queued + the working stages, 00 §11). 07 stores it in visualizations.failed_stage (00 §14.3).
 */
export type PipelineStage = NonTerminalVisualizationStatus;

export interface PipelineStepErrorOptions {
  /** Underlying error; logged through the err serializer, never shown to users. */
  cause?: unknown;
  /** Technical detail for logs; becomes `message`. Defaults to userMessage. */
  detail?: string;
  /** Machine hint for the orchestrator, e.g. a GitErrorCode such as "auth_failed". */
  code?: string;
}

/**
 * The only error pipeline step services (07–11) may throw. Fatal for the visualization.
 * - message:     internal detail for logs (redacted by the logger's err serializer)
 * - userMessage: one safe sentence stored in visualizations.error_message and shown in the UI
 * Per-component failures are recorded in results, never thrown.
 */
export class PipelineStepError extends Error {
  override readonly name = "PipelineStepError";
  readonly stage: PipelineStage;
  readonly userMessage: string;
  readonly code: string | null;

  constructor(stage: PipelineStage, userMessage: string, options: PipelineStepErrorOptions = {}) {
    super(options.detail ?? userMessage, { cause: options.cause });
    this.stage = stage;
    this.userMessage = userMessage;
    this.code = options.code ?? null;
  }
}

/** Type guard used by the orchestrator (07). */
export function isPipelineStepError(error: unknown): error is PipelineStepError {
  return error instanceof PipelineStepError;
}

/**
 * True for the DOMException named "AbortError" (AbortSignal.abort() without a reason, aborted fetch).
 * NOT a cancellation test: a job signal aborts with the string reason "cancelled" | "shutdown" (00 §14.6) and
 * a timeout with a TimeoutError. Decide cancellation by `signal.aborted` and `jobAbortReason(signal)` (04 §9.4).
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
```

`code` carries a machine hint (e.g. a `GitErrorCode` like `auth_failed`) so 07 can choose console wording.
Calls in other sheets use the positional form: `new PipelineStepError("analyzing", "Could not save the list of
components.", { detail: "ANALYSIS_PERSIST_FAILED: …", cause })` — not an options object as first argument.

## 11. Error handling and edge cases

| Situation | Behaviour |
|---|---|
| Config invalid at boot | `ConfigValidationError` lists every problem; process exits 1 before touching DB/Redis |
| Postgres / Redis down at boot | Fatal log with hint, exit 1 (no partial start; queue init is all-or-nothing) |
| Redis drops after boot | ioredis reconnects; enqueue/cancel calls fail fast (`maxRetriesPerRequest: 1`) → services return 500 instead of hanging; health shows `redis: false`; log rate-limited. The worker's blocking connection waits and resumes. |
| Migrations missing | `DatabaseNotReadyError` hint "Run npm run db:migrate", exit 1 |
| Port in use | Fatal "EADDRINUSE" with hint, exit 1 |
| Request with `Host: evil.example:3100`, `Host: localhost` (no port) or `Host: localhost:9999` | 403 `forbidden_origin` (DNS rebinding, 00 §14.5) |
| Invalid `LOG_LEVEL` | Logger falls back to `info` at import; `validateConfig()` then fails boot listing `LOG_LEVEL` |
| Cross-site `POST`/`PUT`/`DELETE` | 403 `forbidden_origin`; GETs still subject to CORS (response unreadable cross-origin) |
| Malformed JSON / body > 1 MB | 400 `validation_failed` / 413 `payload_too_large` |
| Unknown route | 404 `not_found` envelope |
| `/artifacts/../../etc/passwd`, `%2e%2e`, `/artifacts/1/2/base.txt` | 404 from the guard; filesystem never touched |
| Missing artifact file | 404 `not_found` (serve-static, `fallthrough: false`) |
| Unhandled exception in a handler | 500 `internal_error`, generic message, stack logged with requestId |
| QueryHandler unknown column key | `QueryHandlerError` thrown (programming error, surfaces in tests) |
| QueryHandler `update`/`delete` with no conditions | 400 `validation_failed`, no write |
| Soft delete on a non-soft table | `QueryHandlerError` thrown |
| `Where.in([])` | Matches nothing (`false`), not a SQL error |
| Enqueue twice for the same visualization | Second call returns `alreadyQueued: true`; one job runs |
| Cancel while waiting | 07 calls `removeQueuedVisualization` → `true` → mark cancelled directly |
| Cancel while running | Flag set → worker poller aborts `job.signal` with reason `"cancelled"` within ~1 s |
| Cancel requested while the job was still waiting but already picked up | The poll at job start sees the flag and aborts immediately |
| Worker SIGTERM mid-job | Active job aborted with reason `"shutdown"`; force-close after `WORKER_CLOSE_TIMEOUT_MS`; job fails (no retry) |
| Code awaiting with an aborted job signal | Rejects with the **string** reason (`"cancelled"`/`"shutdown"`); use `jobAbortReason`/`throwIfJobAborted`, never `instanceof Error` |
| Symlink inside the data dir pointing outside it | `resolveSafe` throws `ArtifactPathError`; `rm` never follows it |
| Long query / forgotten transaction | Postgres `statement_timeout` (30 s) / `idle_in_transaction_session_timeout` (60 s) end it (03 §7.1) |
| Git missing / too old | `git_not_found` / `unsupported_version`; worker refuses to start (the API still runs; health does not report git) |
| Git prompts for credentials | Never — `GIT_TERMINAL_PROMPT=0` makes it fail fast → `auth_failed` |
| Git command hangs | Killed at timeout (SIGTERM → SIGKILL) → `timeout` |
| Huge diff output | `output_too_large` at `GIT_MAX_BUFFER_BYTES` |
| Ref like `--upload-pack=x` | `invalid_argument` before spawn |
| `worktreeRemove` on an already-removed dir | Success (idempotent) |
| `PRVISION_SECRET_KEY` rotated | Decrypt → `EncryptionError("decrypt_failed")`; 05 treats secret as missing |
| `DATA_DIR` not writable | `ensureRoots` throws at boot (EACCES) → fatal with path |
| SIGINT during boot (e.g. while waiting for Postgres) | Shutdown handlers are already installed: opened resources close, exit 0 |
| Second SIGINT during shutdown | Immediate exit 1 |

## 12. Logging / console events

This sheet emits **no** `visualization_console_events` rows (that is 07's `VisualizationConsoleService`).
Structured pino logs (module = `createLogger` name). Every line carries `event` (01 §5.8):

| Module | Level | `event` | Message | Fields |
|---|---|---|---|---|
| `app` / `worker` | info | `app.boot.listening` / `worker.boot.started` | `PRVision API listening` / `PRVision worker started` | host, port, frontendUrl |
| `app` / `worker` | fatal | `app.boot.failed` / `worker.boot.failed` | `Failed to start …` | err, hint |
| `http` | debug/info/warn/error | `http.request.completed` | `http request` | requestId, method, path, status, durationMs |
| `errors` | error | `http.request.failed` | `Unhandled request error` | err, requestId, method, path |
| `http` | warn | `http.response.malformed` | `Error response without an error message` | status |
| `local-auth` | warn | `http.host.rejected` / `http.origin.rejected` | `Rejected request with non-loopback Host header` / `Rejected cross-origin state-changing request` | host / origin, fetchSite, method, path |
| `artifacts` | warn | `artifacts.path.rejected` | `Rejected artifact path` | path |
| `health` | warn | `health.probe.failed` | `Health probe failed` | probe, err |
| `query-handler` | error | `db.query.failed` | `Database operation failed` | table, operation, pgCode, constraint, detail |
| `db` | error | `db.pool.error` | `Idle Postgres client error` | err |
| `redis` | info/warn | `redis.connection.ready` / `redis.connection.error` | `Redis connected` / `Redis connection error` (rate-limited) | message |
| `queue` | info | `queue.job.enqueued` / `queue.job.started` / `queue.job.completed` / `queue.job.cancel_seen` | `Visualization job enqueued` / `… started` / `… completed` / `Cancel flag seen; aborting active job` | jobId, visualizationId |
| `queue` | warn/error | `queue.job.stalled` / `queue.job.failed` / `queue.worker.error` / `queue.cancel.poll_failed` / `queue.job.remove_failed` | as in §9.4 | jobId, visualizationId, err |
| `git` | warn | `git.command.failed` | `git command failed` | subcommand, code, exitCode, stderr (redacted, 2 000 chars) |
| `process` | debug | `process.finished` | `process finished` | label, exitCode, durationMs, kind |
| `shutdown` | info/warn/error/fatal | `process.shutdown.started` / `process.shutdown.forced` / `process.shutdown.step_failed` / `process.shutdown.timeout` / `process.crashed` | `Shutting down` / `forced exit` / `Shutdown step failed` / `Shutdown timed out` / `Unhandled error` | role, reason, step, err |

Never logged: argv of child processes, environment, request/response bodies, query strings, decrypted
secrets, ciphertext, DB row payloads, `DATABASE_URL`.

## 13. Security notes

- **Network exposure:** `HOST` must be loopback (enforced by config validation). `guardHost` defeats DNS
  rebinding (Host must be `localhost:<PORT>`/`127.0.0.1:<PORT>`, 00 §14.5); `requireLocal` defeats cross-site
  writes (Origin must be `FRONTEND_URL` or its loopback twin when present). CORS allows only the frontend origins
  and never credentials.
- **Secrets at rest:** AES-256-GCM via `Encryption`; key only from env; ciphertext never returned in views.
- **Secrets in logs:** pino `redact` paths + `err` serializer stripping HTTP request/response objects +
  `redactSecrets()` for free text. Sheets persisting error text (`error_message`, `base_error`, console
  messages) must pass it through `redactSecrets()` first.
- **Child processes:** argv arrays only, no shell, mandatory timeout, buffer caps, abort support, process-group
  kill, environment from the `CHILD_PROCESS_BASE_ENV` **allow-list** (00 §14.5: never `PRVISION_SECRET_KEY`,
  `DATABASE_URL`, `REDIS_URL`, `NODE_OPTIONS`, `GIT_*`) — important because 10 runs the user's Vite config, which
  is arbitrary code.
- **Git:** user hooks, fsmonitor, external diff/textconv, LFS smudge, `ext::` transport and credential helpers
  disabled for every call; refs validated and placed after `--end-of-options`; paths after `--`; token passed via
  env-scoped `http.<prefix>.extraHeader`, never argv or URL; `--no-write-fetch-head`; refs PRVision writes or
  deletes are confined to `refs/prvision/`; `GIT_OPTIONAL_LOCKS=0` so PRVision never contends for the user's
  index lock.
- **Filesystem:** all data-dir paths resolved through `resolveSafe` (lexical + realpath check, so symlinks
  cannot escape) or `resolveInside` + `isRealPathInside`; deletes restricted to numeric visualization folders and
  never follow symlinks; `/artifacts` allow-list regex + `dotfiles: "deny"`; data dir created `0700`.
- **Errors to clients:** generic 500 text; no stack traces, SQL, paths or command output in responses.
- **Express:** `x-powered-by` disabled, `trust proxy` off, JSON body limit 1 MB, Helmet defaults with
  `crossOriginResourcePolicy: same-site`.

## 14. Tests

`node:test` + `node:assert/strict`. No real Postgres/Redis needed unless stated; git tests use real `git` in
temp dirs.

### 14.1 Helpers

`tests/backend/helpers/test-context.ts` — adapted from Uply's (same exported names where they exist):

```ts
/** Runs callback inside a fresh AuthContext store with LOCAL_USER (overridable) and requestId "test-request". */
export async function runWithAuthContext<T>(callback: () => Promise<T> | T, overrides: Partial<LocalUser> = {}): Promise<T> {
  return AuthContext.runAsLocalUser(callback, { user: { ...LOCAL_USER, ...overrides } as LocalUser, requestId: "test-request" });
}
/** Uply's helper, unchanged: replaces a static member and returns a restore function. */
export function patchStaticMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): () => void;
/** Replaces a service's private `queryHandler` with a partial fake (unimplemented methods throw "not stubbed: <name>"). */
export function injectQueryHandler(service: object, fake: Partial<Record<keyof QueryHandler, unknown>>): void;
/** Creates a temp dir under os.tmpdir() (prefix "prvision-test-"), passes it to fn, removes it afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T>;
```

`tests/backend/helpers/git-fixtures.ts`:

```ts
export interface TempGitRepo {
  dir: string;
  git(args: readonly string[]): Promise<string>;                          // runProcess("git", ["-C", dir, ...args])
  commit(message: string, files: Record<string, string | null>): Promise<string>; // null deletes; returns sha
  cleanup(): Promise<void>;
}
/** git init -b main with user.name/email set locally and one initial commit of `files`. */
export async function createTempGitRepo(files: Record<string, string>): Promise<TempGitRepo>;
```

`tests/backend/helpers/http.ts`:

```ts
/** Listens on 127.0.0.1:0, returns baseUrl ("http://127.0.0.1:<port>") and close(). Use global fetch. */
export async function startTestServer(app: Express): Promise<{ baseUrl: string; close(): Promise<void> }>;
```

### 14.2 Test files and cases

`tests/backend/utilities/response-handler.test.ts`
- `success responses are wrapped as { status, data }`
- `undefined data is sent as null`
- `errors are { status, error, error_reason } and omit error_reason when absent`
- `validation message arrays are preserved`

`tests/backend/utilities/query-handler.test.ts` (no DB: inject a fake `DbExecutor` built on a recording pg
client; render predicates with `new PgDialect().sqlToQuery()`)
- `buildWhere renders equality, IS NULL and every Where operator`
- `buildWhere ignores undefined values`
- `buildWhere throws QueryHandlerError for unknown keys`
- `Where.in([]) renders a false predicate`
- `select adds isDeleted = false for repositories and visualizations only`
- `explicit isDeleted condition overrides the default`
- `update without conditions returns 400 and does not execute`
- `update stamps updatedAt only on tables that have it`
- `soft delete on visualization_components throws`
- `23505 maps to 409 conflict with the constraint name; 23503 → 409; 22P02 → 400; 23514 → 500`
- `isolated select and selectMany throw QueryHandlerError on DB failure`
- `selectMany applies default id asc order and no limit by default`
- `normalizeData strips underscores, functions and undefined but keeps null`
- `firstInsertedId reads data[0].id`

`tests/backend/utilities/model-handler.test.ts`
- `hydrate calls setters including for null values`; `toDatabaseValues drops null and excluded keys`

`tests/backend/utilities/validation.test.ts`
- `valid body passes and returns the DTO instance`
- `unknown property is rejected (forbidNonWhitelisted)`
- `IdParamDTO accepts "12" and rejects "0", "-1", "abc", "1.5"`
- `PaginationQueryDTO rejects pageSize 101`
- `nested errors are flattened with property paths`
- `compileJsonData returns {} for arrays, numbers and invalid JSON strings`
- `error response carries error_reason validation_failed`

`tests/backend/utilities/dto-mapper.test.ts`
- `maps via setters`; `skips null/undefined`; `throws on non-object`

`tests/backend/utilities/encryption.test.ts`
- `round-trips unicode text`; `produces a different payload each call (random IV)`
- `payload format is three base64 parts with 12-byte IV and 16-byte tag`
- `decrypt of a payload produced by Uply's algorithm with the same secret succeeds` (fixture computed in-test with node:crypto)
- `tampered ciphertext throws decrypt_failed`; `wrong key throws decrypt_failed`
- `malformed payload throws malformed_payload`; `empty key throws missing_key`

`tests/backend/utilities/logger.test.ts`
- `redactSecrets masks ghp_, github_pat_, sk-ant- tokens, Authorization headers and URL credentials`
- `redactSecrets leaves ordinary text untouched`
- `logger redacts configured paths` (subscribe to `logTestStream`, log `{ token: "ghp_…", nested: { apiKey: "x" } }`, assert `[REDACTED]`)
- `err serializer drops request/response objects and redacts message/stack/stderr`
- `err serializer logs a string abort reason unchanged and does not throw`
- `logTestStream receives JSON lines from child loggers and unsubscribe stops delivery`
- `redactSecrets removes the literal PRVISION_SECRET_KEY value`

`tests/backend/utilities/paths.test.ts`
- `expandHome expands ~ and ~/x only`; `isPathInside handles prefixes (/a/b vs /a/bc)`
- `resolveInside rejects ../ escapes and NUL`; `normalizeRepoRelativePath strips ./ and rejects .., absolute, empty`

`tests/backend/utilities/process.test.ts` (uses `process.execPath` as the child)
- `resolves stdout/stderr/exitCode for a successful child`
- `rejects non_zero_exit unless allowedExitCodes includes the code`
- `kills and rejects timeout`; `kills and rejects aborted on AbortSignal`; `pre-aborted signal never spawns`
- `rejects max_buffer when output exceeds the cap`
- `rejects spawn_failed for a missing binary`
- `passes stdin input`; `does not inherit PRVISION_SECRET_KEY, DATABASE_URL or REDIS_URL` (child prints its env as JSON; the preload sets all three)
- `kills the whole process group on timeout` (child spawns a grandchild that writes a marker after 2 s; assert no marker)
- `error message never contains argv`

`tests/backend/utilities/git-client.test.ts` (real git via `createTempGitRepo`)
- `version parses and assertSupportedVersion passes on the CI git`
- `isRepository true for repo, false for plain dir`
- `revParse returns full sha; unknown ref → unknown_revision`
- `mergeBase of two branches`
- `diffNameStatus reports A, M, D and R with previousPath and score`
- `diffNameStatus with to=null compares against the working tree`; `renames:false passes --no-renames`; `pathspecs are passed after --`
- `diffNameStatusNoIndex lists differences of two directories and treats exit code 1 as success`
- `deleteRef removes refs/prvision/pr-1, is idempotent, and rejects refs/heads/main with invalid_argument`
- `fetch argv contains --no-write-fetch-head and -c credential.helper=` (fake runner)
- `diffBinaryHead argv contains -c diff.noprefix=false and --ignore-submodules=all, and applies cleanly with diff.noprefix=true set in the repo config`
- `child env is the allow-list: every env key passed to the runner is in CHILD_PROCESS_BASE_ENV, GIT_ENV or the per-call env` (fake runner captures env; no `process.env` mutation after import, 00 §14.12)
- `diffUnified limited to paths`
- `diffBinaryHead + applyPatch reproduce working-tree changes in a worktree`
- `applyPatch with a bad patch → patch_failed`; `empty patch is a no-op`
- `lsUntracked and statusPorcelain list untracked and modified files (incl. rename record)`
- `listBranches, currentBranch (null when detached)`
- `remoteUrl null without origin; symbolicRefDefault null without origin/HEAD`
- `showFile returns content and null for a missing path`
- `worktreeAdd creates a detached checkout; worktreeRemove is idempotent; worktreeList includes it`
- `user hooks do not run on worktreeAdd` (install a post-checkout hook that writes a marker file; assert absent)
- `unsafe refs (--foo, a..b, @{u}) throw invalid_argument without spawning` (fake runner asserts not called)
- `fetch passes the auth header via GIT_CONFIG_* env, not argv` (fake runner captures argv/env)
- `toGitCommandError maps stderr samples to codes` (table-driven)
- `parseNameStatusZ / parseStatusPorcelainZ / parseWorktreeListZ / parseGitVersion` (pure)

`tests/backend/utilities/artifact-store.test.ts` (temp data dir)
- `path builders produce the 00 §4 layout`; `componentImagePath is POSIX relative`
- `componentImagePath returns artifacts/<v>/<c>/<kind>.png`; `componentDir is absolute under artifacts`
- `resolveSafe rejects absolute, NUL, backslash and ../ escapes`
- `resolveSafe rejects a symlink inside the artifacts root that points outside it` (sheet 14 case)
- `write is atomic, creates parents and returns the relative path`; `read returns the bytes`; `ensureComponentDir creates the folder`
- `removeVisualization tolerates missing dirs and does not follow a symlink`; `removeVisualizationArtifacts is the same operation`
- `toPublicUrl maps relative paths and rejects others`; `non-positive ids throw`

`tests/backend/utilities/queue-service.test.ts` (fake queue/worker via patched `createQueue`/`createWorker`, Uply pattern; fake Redis via `patchStaticMethod(RedisPool, "getConnection", …)`)
- `initialize creates the visualizations queue with prefix prvision`
- `initialize failure closes partial resources and rethrows`
- `enqueueVisualization uses jobId viz-<id>, name visualize, attempts 1`
- `enqueueVisualization returns alreadyQueued when the job exists and does not add`
- `enqueue before initialize throws`
- `startVisualizationWorker uses concurrency 1, lockDuration 300000 and maxStalledCount 0`
- `processor receives { visualizationId, jobId, signal }; invalid job data fails the job`
- `cancel flag aborts the signal with reason "cancelled"`; `a flag set before the job started aborts at once`
- `overlapping polls are skipped while one is in flight`
- `close aborts active jobs with reason "shutdown", closes worker before queue, resets state, aggregates failures`; `close is a no-op when never initialized`
- `jobAbortReason and throwIfJobAborted map "cancelled"/"shutdown" and pass a TimeoutError through`
- `queue uses maxRetriesPerRequest 1 and the worker null`
- `requestCancel sets prvision:cancel:<id> with EX 86400`; `removeQueuedVisualization only removes waiting/delayed jobs`

`tests/backend/config/config-validation.test.ts`
- `accepts the default constants with valid required values`
- `reports missing DATABASE_URL, REDIS_URL, PRVISION_SECRET_KEY`
- `rejects non-loopback HOST`; `rejects short or non-base64 secret key`; `rejects relative data dir and "/"`
- `rejects queue contract drift (e.g. VISUALIZATION_WORKER_CONCURRENCY 2, WORKER_LOCK_DURATION_MS 60000)`
- `rejects NaN PORT and an unknown LOG_LEVEL`
- `error text never contains the secret value or the database password`
- `ConfigSnapshot has no key for any test-only variable` (no snapshot key reads `PRVISION_IT_RENDER`, `PRVISION_IT_AI`, `PRVISION_INTEGRATION`, `PRVISION_TEST_DATABASE_URL`, `PRVISION_KEEP_TEST_ARTIFACTS`, `PRVISION_REAL_DATA_DIR` or `PRVISION_IT_AI_*`; `process.env` is never mutated after import, 00 §14.12)

`tests/backend/middleware/local-auth-middleware.test.ts`
- `guardHost allows localhost:<PORT> and 127.0.0.1:<PORT>`; `rejects other hosts, another port, a missing port and a missing Host with 403 forbidden_origin`
- `guardHost with apiPort "socket" compares against the listening port`
- `requireLocal allows GET from any origin (CORS handles reads)`
- `requireLocal rejects POST with foreign Origin, the API's own origin, Origin "null", or Sec-Fetch-Site cross-site`
- `requireLocal allows POST from FRONTEND_URL, its 127.0.0.1 twin, and from curl (no Origin)`
- `requireLocal sets AuthContext user and req.localUser`

`tests/backend/http/app.test.ts` (`createApp` with stub `HealthController`, temp `ArtifactStore`, `new LocalAuthMiddleware({ apiPort: "socket" })` because `startTestServer` listens on port 0; requests send `Host: 127.0.0.1:<port>`, which `fetch` does by default)
- `unknown route → 404 not_found envelope`
- `malformed JSON → 400 validation_failed`; `2 MB body → 413 payload_too_large`
- `thrown error in a handler → 500 internal_error with generic message`
- `responses carry X-Request-Id; a valid incoming X-Request-Id is echoed`
- `AuthContext request id is available inside a POST handler with a JSON body` (regression test for the express.json ordering)
- `Host evil.test → 403 forbidden_origin before CORS`
- `CORS preflight from http://localhost:4210 succeeds; from another origin has no ACAO header`
- `Cross-Origin-Resource-Policy is same-site`

`tests/backend/http/artifacts-route.test.ts`
- `serves an existing base.png with image/png, ETag and Cache-Control private, no-cache`
- `missing file → 404 envelope`
- `traversal attempts (../, %2e%2e, %2f, backslash) → 404 without fs access`
- `non-png or extra segments → 404`; `POST → 404`

`tests/backend/services/health-service.test.ts` (patch `DbPool.ping`, `RedisPool.ping`)
- `both probes ok → { status: "ok", database: true, redis: true, version: APP_VERSION }`
- `one failure → degraded with that flag false`; `slow probe → false after HEALTH_CHECK_TIMEOUT_MS`
- `always HTTP 200`; `response has exactly the four HealthView keys`

`tests/backend/utilities/graceful-shutdown.test.ts` (fake `processLike` emitter + fake exit)
- `runs steps in order and exits 0`; `failing step logs and exits 1 after running the rest`
- `second signal forces exit 1`; `timeout forces exit 1`; `unhandledRejection triggers shutdown(1)`

`tests/backend/types/pipeline-errors.test.ts` (created by 02 §10; this sheet keeps it passing)
- `carries stage, userMessage, detail, code and cause`; `message defaults to userMessage`; `isPipelineStepError narrows`; `re-exported from visualization-pipeline`

`tests/backend/utilities/response-handler.test.ts` additions
- `a 500 without error_reason gets internal_error`; `status >= 400 without error becomes a 500 envelope`

## 15. Acceptance criteria

- [ ] Every file in §4 exists; no file under `backend/src` other than `config-consts/**` and `utilities/helpers/env.ts` reads `process.env`.
- [ ] `npm run typecheck`, `npm run lint` (strictTypeChecked, zero suppressions added), `npm run check:architecture` and `npm test` pass.
- [ ] No `any`, no `console.*` outside `utilities/loggers`, no `child_process.exec`/`shell: true` anywhere; every log call has an `event` from §12.
- [ ] No constant is defined in this sheet's files that is not in 02 §6.7 (grep `export const [A-Z_]* =` under `src/utilities`, `src/middleware` returns only module-private helpers such as `REDACT_PATHS`, `ARTIFACT_PUBLIC_PATH_PATTERN`).
- [ ] `npm run dev --prefix backend` with Docker up logs `PRVision API listening` on `127.0.0.1:3100`; with Docker down it exits 1 with a hint; Ctrl-C while it waits for Postgres exits cleanly.
- [ ] `curl -s localhost:3100/api/health` returns exactly `{ "status": 200, "data": { "status": "ok", "database": true, "redis": true, "version": "0.1.0" } }`; with Redis stopped it returns HTTP 200 with `"status": "degraded", "redis": false`.
- [ ] `curl -s -H 'Host: evil.test' localhost:3100/api/health` and `curl -s -H 'Host: localhost:9999' localhost:3100/api/health` return 403 `forbidden_origin`.
- [ ] `curl -s -X POST -H 'Content-Type: application/json' -H 'Origin: https://evil.test' -d '{}' localhost:3100/api/settings/test-github` returns 403 `forbidden_origin` once 05 lands; until then the same check is exercised on `/artifacts`: `curl -s -X POST -H 'Origin: https://evil.test' localhost:3100/artifacts/1/2/base.png` returns 403, and without `Origin` 404.
- [ ] `curl -s localhost:3100/nope` returns `{ "status": 404, "error": "Resource not found", "error_reason": "not_found" }`; a malformed JSON body returns 400 `validation_failed`; a 2 MB body 413 `payload_too_large`.
- [ ] A PNG placed at `<dataDir>/artifacts/1/2/base.png` is served at `/artifacts/1/2/base.png`; `/artifacts/1/2/../../x`, `/artifacts/1/2/base.txt` and a dotfile return 404.
- [ ] `npm run dev:worker --prefix backend` starts, logs `PRVision worker started`; an enqueued job (`QueueService.enqueueVisualization(1)` from a REPL) fails with "Visualization pipeline not implemented" until 07 lands.
- [ ] Ctrl-C on API and worker exits 0 within `SHUTDOWN_TIMEOUT_MS`, closing server, queues, Redis and Postgres (one log line per step).
- [ ] `QueueService` honours 00 §10 and §14.6 exactly: prefix, queue/job names, jobId `viz-<id>`, attempts 1, concurrency 1, `lockDuration` 300 000, `maxStalledCount` 0, processor argument `{ visualizationId, jobId, signal }`, `signal.reason` `"cancelled"`/`"shutdown"`, cancel key and TTL.
- [ ] `GitClient` implements every method in §9.5 (including `diffNameStatusNoIndex`, `deleteRef`) with the listed argv; tests show hooks are not executed, tokens never appear in argv, and every child env key comes from `CHILD_PROCESS_BASE_ENV`, `GIT_ENV` or the per-call env (so a parent `GIT_DIR` can never reach git).
- [ ] `ArtifactStore` exposes the 00 §14.8 methods (`componentDir`, `ensureComponentDir`, `componentImagePath`, `read`, `write`, `removeVisualization`, `toPublicUrl`, `resolveSafe`) plus the worktree helpers 07 uses.
- [ ] Setting `HOST=0.0.0.0` (or `PORT=abc`, or a 10-byte `PRVISION_SECRET_KEY`) makes both processes refuse to start with a config-validation error that names the variable and never prints the secret.
- [ ] Log output in dev is pretty, contains `requestId` for request-scoped lines (including inside a POST handler), and a deliberately logged `{ token: "ghp_…" }` prints `[REDACTED]`; under `NODE_ENV=test` nothing is printed unless `PRVISION_TEST_LOG_STDOUT=1`.

## 16. Contract changes requested

1. **`HealthView` and health service.** Resolved — 00 §14.4 (exact four-field shape; §5.4 now matches it).
2. **Additional `error_reason` codes.** Resolved — 00 §14.2 (complete list in §8.2).
3. **Envelope `error` may be `string[]`.** Resolved — 00 §14.2.
4. **Config constant names.** Resolved — 00 §14.8 (02 §6.7 is the single list; §6.1 only names what this sheet consumes).
5. **Shared DTOs owned by 04.** Resolved — 00 §14.8.
6. **Additional 04 files.** Resolved — 00 §14.12 ("Module map"): 00 §7 lists the core files and this sheet's §4 inventory is authoritative for the rest (`middleware/{request-context,artifact-path-guard,error-handler}-middleware.ts`, `utilities/handlers/query-conditions.ts`, `utilities/helpers/{date,pagination,graceful-shutdown}.ts`, `types/local-user.ts`, `services/health/health-service.ts`, `dtos/health/health-view.dto.ts`, `dtos/shared/*`, `enums/utility/error-reason.ts`).
7. **Queue job context.** Resolved — 00 §14.6 (processor argument `{ visualizationId, jobId, signal }`, string abort reasons; `JobAbortedError` remains as the Error form via `throwIfJobAborted`).
8. **git ≥ 2.31.** Resolved — 00 §14.1.
9. **Response envelope vs Uply.** Resolved — 00 §14.2.

10. **Allowed write origins.** Resolved — 00 §14.12 ("Origin check"): `FRONTEND_URL` and its `127.0.0.1` twin
    (`http://127.0.0.1:4210`), as §7.3 implements.
11. **`PipelineStepError` options and stage type.** Resolved — 00 §14.12: `options?: { cause?: unknown; detail?: string;
    code?: string }`, `stage` typed as the non-terminal `VisualizationStatus` values, always positional (§10).
12. **Error status codes.** Resolved — 00 §14.12 (HTTP status per `error_reason`; 01 §5.7.1 holds the table; §8.2
    comments match it).

Open: none.
