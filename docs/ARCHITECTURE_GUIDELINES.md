# ApiWatcher Architecture Guidelines

This document describes how ApiWatcher is written today and how new code should be shaped if we want a rewrite or migration to feel native to this codebase.

The goal is not only feature parity. The goal is to preserve the same architectural style:

- explicit layering
- thin controllers
- DTO-driven validation
- model-based service input
- utility-backed persistence and response handling
- queue/worker execution for long-running work
- small focused tests around services and controllers

This should be the ingestion point for the Uplee-to-ApiWatcher migration.

## 1. Core Architectural Principles

ApiWatcher is written in a deliberate, service-oriented Node/TypeScript style:

- `Express` owns HTTP transport only.
- `routes` wire URLs to controller methods.
- `controllers` translate HTTP into validated DTOs and model objects.
- `services` own business logic.
- `utilities` provide reusable infrastructure and helper abstractions.
- `models` are generated data containers aligned to the database schema.
- `Drizzle` is the storage engine, but most domain services talk through `QueryHandler`.
- background execution is moved into `BullMQ` workers instead of happening inline in request handlers.

The code avoids framework-heavy magic. Most dependencies are created explicitly inside the bootstrap layer or inside controllers/services.

## 2. Repo Shape

Relevant backend structure:

```text
backend/src/
  app.ts                  # Express bootstrap
  worker.ts               # Background worker bootstrap
  routes/                 # Route registration
  controllers/            # HTTP-facing orchestration
  services/               # Business logic
  dtos/                   # Request/response validation contracts
  models/                 # Generated schema-aligned models
  database/               # Drizzle schema + migrations + connection
  middleware/             # Auth and request middleware
  utilities/              # Shared handlers, mappers, context, services
  enums/                  # Table names and common enums
```

Supporting test structure:

```text
tests/
  backend/                # node:test service-level tests
  frontend/               # Angular component/service tests
  e2e/                    # real stack smoke tests
```

Canonical feature footprint:

```text
backend/src/
  controllers/
    tenant-controller.ts
  services/
    tenant-service.ts
  dtos/tenants/
    tenant-create.dto.ts
    tenant-update.dto.ts
    tenant-view.dto.ts
  models/
    tenant-model.ts
```

Not every feature needs every file on day one, but this is the default shape to aim for.

## 3. Runtime Flow

The standard request path is:

1. `app.ts` configures Express, middleware, auth context, and route registration.
2. `routes/index.ts` binds endpoint paths to controller methods.
3. A `controller`:
   - sanitizes request JSON
   - validates against a DTO
   - maps the DTO into a model where appropriate
   - calls a service
   - returns via `ResponseHandler`
4. A `service` performs business logic and persistence.
5. A `service` returns a standardized `ApiResponse`.
6. `ResponseHandler` serializes that response to the HTTP client.

Long-running or scheduled work is queued through `QueueService` and executed in `worker.ts`.

## 4. Layer Responsibilities

### 4.1 `app.ts`

`app.ts` should stay as the composition root.

Responsibilities:

- load environment variables
- configure Express middleware
- initialize DB/Redis/queues
- construct controllers and auth middleware
- register routes
- install fallback 404 and error handlers
- start listening

What should not live here:

- domain logic
- DTO validation
- SQL or Drizzle queries
- feature-specific branching

Example bootstrap pattern:

```ts
import "reflect-metadata";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { AuthController, MonitorController } from "./controllers";
import { AuthMiddleware } from "./middleware";
import { AuthContext, DbPool, QueueService, RedisPool, ResponseHandler } from "./utilities";
import { registerRoutes } from "./routes";

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(helmet());
app.use(express.json());
app.use(cookieParser(process.env.SESSION_SECRET));
app.use(AuthContext.middleware);

async function bootstrap(): Promise<void> {
  await DbPool.getInstance().query("select 1");
  await RedisPool.connect();
  await QueueService.initialize();

  const authController = new AuthController();
  const monitorController = new MonitorController();
  const authMiddleware = new AuthMiddleware();
  const requireAuth = authMiddleware.requireAuth.bind(authMiddleware);
  const responseHandler = new ResponseHandler();

  registerRoutes(app, {
    authController,
    monitorController,
    requireAuth
  });

  app.use((req, res) => {
    return responseHandler.controllerResponse(
      responseHandler.createErrorResponse("Resource not found", 404),
      res
    );
  });
}
```

### 4.2 `routes/`

Routes are explicit and centralized. They are not discovered automatically.

Guidelines:

- keep route registration declarative
- keep auth requirements visible at the route layer
- bind controller methods with `.bind(controller)`
- prefer one route file as the single public map until the API becomes large enough to split intentionally

Example route registration:

```ts
type RouteDependencies = {
  authController: AuthController;
  monitorController: MonitorController;
  requireAuth: RequestHandler;
};

export function registerRoutes(app: Express, dependencies: RouteDependencies): void {
  const { authController, monitorController, requireAuth } = dependencies;

  app.post("/auth/login", authController.login.bind(authController));

  app.get("/monitors/schedules", requireAuth, monitorController.listSchedules.bind(monitorController));
  app.post("/monitors/schedules", requireAuth, monitorController.createSchedule.bind(monitorController));
  app.put("/monitors/schedules/:id", requireAuth, monitorController.updateSchedule.bind(monitorController));
}
```

### 4.3 `controllers/`

Controllers are intentionally thin.

Responsibilities:

- read `req.params`, `req.body`, and `req.query`
- call `Validation.compileJsonData`
- validate DTOs with `Validation.validate`
- map DTOs to models via `DTOMapper` when the service expects a model
- instantiate the service and call the relevant method
- convert the service result into the standard HTTP response
- handle transport concerns such as cookies in auth flows

Controllers should not:

- contain business rules
- write raw SQL
- reach directly into Drizzle for feature logic
- return ad hoc JSON envelopes

Controller pattern to copy:

```ts
const sanitizedRequestData = this.validation.compileJsonData(req.body);
const [isValid, errorResponse, dto] = await this.validation.validate(
  sanitizedRequestData,
  SomeDTO
);
if (!isValid) {
  return this.responseHandler.controllerResponse(errorResponse!, res);
}

const model = DTOMapper.map(dto!, SomeModel);
const service = new SomeService(model);
const serviceResponse = await service.someAction();
return this.responseHandler.controllerResponse(serviceResponse, res);
```

Example controller method:

```ts
async createSchedule(req: Request, res: Response): Promise<Response> {
  try {
    const sanitizedRequestData = this.validation.compileJsonData(req.body);
    const [isValid, errorResponse, monitorScheduleSaveDTO] = await this.validation.validate(
      sanitizedRequestData,
      MonitorScheduleSaveDTO
    );

    if (!isValid) {
      return this.responseHandler.controllerResponse(errorResponse!, res);
    }

    const monitorScheduleModel = DTOMapper.map(monitorScheduleSaveDTO!, MonitorScheduleModel);
    const monitorService = new MonitorService(monitorScheduleModel);
    const serviceResponse = await monitorService.createSchedule();
    return this.responseHandler.controllerResponse(serviceResponse, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return this.responseHandler.controllerResponse({ status: 500, error: message }, res);
  }
}
```

### 4.4 `services/`

Services are the center of the application.

Responsibilities:

- business rules
- authorization-aware scoping using auth context
- data access through `QueryHandler`
- orchestration across multiple utilities
- queue scheduling and background job creation
- shaping response payloads for controllers

Service conventions:

- one service per domain area
- instantiate a `QueryHandler` inside the service
- read the authenticated actor from `AuthContext` when needed
- return `ApiResponse`
- prefer small private helper methods inside the service for domain-specific substeps

Services should not:

- depend on Express `Request` or `Response`
- know about cookies or route binding
- bypass shared utilities unless there is a strong reason

Recommended service shape:

```ts
export class MonitorService {
  private queryHandler: QueryHandler;
  private authenticatedUser = AuthContext.requireUser();

  constructor(private monitorSchedulePayload: MonitorScheduleModel = new MonitorScheduleModel()) {
    this.queryHandler = new QueryHandler();
  }

  async createSchedule(): Promise<ApiResponse> {
    try {
      const flowDefinitionModel = await this.queryHandler.validateAndSelect(
        FlowDefinitionModel,
        { id: this.monitorSchedulePayload.flowDefinitionId, userId: this.authenticatedUser.id },
        Table.FLOW_DEFINITIONS
      );

      if (!flowDefinitionModel) {
        return { status: 404, error: "Flow not found" };
      }

      this.monitorSchedulePayload.setUserId(this.authenticatedUser.id);
      const payload = QueryHandler.normalizeData(
        this.monitorSchedulePayload as unknown as Record<string, unknown>,
        ["id", "jobKey", "lastRunAt", "nextRunAt", "createdAt", "updatedAt", "isDeleted"]
      );

      const insertResponse = await this.queryHandler.insert(payload, Table.MONITOR_SCHEDULES);
      if (insertResponse.status !== 200) {
        return insertResponse;
      }

      return { status: 200, data: insertResponse.data };
    } catch (error) {
      console.error("Schedule create error:", error);
      return { status: 500, error: "Internal server error" };
    }
  }
}
```

Service writing rules:

- accept validated models or simple primitives, not raw request objects
- read current auth state from `AuthContext`
- scope reads and writes inside the service
- return early with structured error payloads for expected failures
- use private helpers for repeated domain steps
- call infrastructure helpers like `QueueService`, `MailerService`, or `RunConsoleService` from the service layer

Example of a private helper inside a service:

```ts
private async loadOwnedFlow(flowId: number): Promise<FlowDefinitionModel | null> {
  return this.queryHandler.validateAndSelect(
    FlowDefinitionModel,
    { id: flowId, userId: this.authenticatedUser.id },
    Table.FLOW_DEFINITIONS
  );
}
```

### 4.5 `dtos/`

DTOs are the public input contracts.

Guidelines:

- use `class-validator`
- validate request payload shape here, not in models
- keep DTOs narrow and use-case specific
- prefer separate DTOs for create/update/test operations when contracts differ

DTOs are for validation and transport. They are not business entities.

Example DTO:

```ts
import { IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from "class-validator";

export class MonitorScheduleSaveDTO {
  @IsNumber()
  flowDefinitionId!: number;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsIn(["minutes", "hours", "daily"])
  frequencyType!: "minutes" | "hours" | "daily";

  @IsNumber()
  @Min(1)
  frequencyValue!: number;

  @IsString()
  @IsNotEmpty()
  timezone!: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
```

DTO rules of thumb:

- one DTO per request shape
- use explicit validation decorators
- avoid optional fields unless the route truly supports partial input
- use separate create/update DTOs when required fields differ

### 4.6 `models/`

Models are generated data containers derived from `database/schema.ts`.

Characteristics:

- private underscored fields
- public getters/setters
- constructor that hydrates through setters
- no business logic by default
- no validation decorators

Rules:

- treat schema as the source of truth
- regenerate models after schema changes
- put input validation in DTOs, not generated models
- only hand-edit generated models if there is a very strong reason, and prefer generator changes instead

Schema-to-model workflow:

1. Update `backend/src/database/schema.ts`
2. Run `npm run generate:models`
3. Run `npm run db:generate`
4. Run `npm run db:migrate`
5. Adjust DTOs, services, and tests to use the new fields

Example command flow:

```bash
npm run generate:models
npm run db:generate
npm run db:migrate
```

Example generated model shape:

```ts
export class MonitorScheduleModel {
  private _id: number;
  private _userId: number;
  private _name: string;
  private _isEnabled: boolean = true;

  constructor(data?: Partial<MonitorScheduleModel>) {
    if (data) {
      Object.entries(data).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          const setterName = `set${key.charAt(0).toUpperCase() + key.slice(1)}`;
          if (typeof (this as any)[setterName] === "function") {
            (this as any)[setterName](value);
          }
        }
      });
    }
  }

  setId(value: number) { this._id = value; }
  setUserId(value: number) { this._userId = value; }
  setName(value: string) { this._name = value; }
  setIsEnabled(value: boolean) { this._isEnabled = value; }

  get id(): number { return this._id; }
  get userId(): number { return this._userId; }
  get name(): string { return this._name; }
  get isEnabled(): boolean { return this._isEnabled; }
}
```

Model usage pattern:

- DTO in
- `DTOMapper.map(dto, ModelClass)`
- service mutates model through setters where needed
- `QueryHandler.normalizeData(model, excludedKeys)` before persistence

### 4.7 `utilities/`

Utilities are heavily used in ApiWatcher. They are a core part of the style.

They are split by role:

- `handlers/`: response shaping, query abstraction, array/model helpers
- `mappers/`: DTO-to-model mapping
- `context/`: auth context propagation
- `processors/`: focused low-level helpers such as encryption
- `services/`: cross-cutting infrastructure such as DB pools, Redis, mail, queue, Playwright runtime
- `validation/`: DTO validation and payload sanitization

Use a utility when the logic is:

- cross-domain
- infrastructure-related
- repeated in multiple services
- not the responsibility of a single feature service

Do not create a utility for feature logic that belongs naturally inside one service.

Example utility patterns:

`DTOMapper`:

```ts
const monitorScheduleModel = DTOMapper.map(monitorScheduleSaveDTO, MonitorScheduleModel);
```

`Validation`:

```ts
const sanitizedRequestData = this.validation.compileJsonData(req.body);
const [isValid, errorResponse, dto] = await this.validation.validate(
  sanitizedRequestData,
  MonitorScheduleSaveDTO
);
```

`ResponseHandler`:

```ts
return this.responseHandler.controllerResponse(
  this.responseHandler.successResponse({ ok: true }),
  res
);
```

Utility extraction rule:

- if multiple services need it, extract it
- if it wraps infrastructure, extract it
- if it only supports one feature’s core business rule, keep it in the service

## 5. Persistence Style

ApiWatcher uses Drizzle, but most services are written against the `QueryHandler` abstraction rather than raw Drizzle queries.

### Default pattern

- schema lives in `database/schema.ts`
- migrations live in `database/migrations/`
- generated models mirror the schema
- `QueryHandler` provides a stable persistence API
- `QueryHandlerDrizzle` is the Drizzle-backed implementation

### Why this matters

This gives services a stable interface:

- `insert`
- `select`
- `update`
- `delete`
- `count`
- `validateAndSelect`
- `selectMany`
- `normalizeData`

This pattern should be preserved in the rewrite. Even when Drizzle is the actual ORM, services should feel insulated from ORM-specific details.

### Conventions

- use `Table` enums instead of scattering table names
- default to soft-delete-aware selects where the table supports `isDeleted`
- normalize model data before persistence
- centralize DB error translation in the query layer where possible

When to bypass `QueryHandler`:

- only for clearly justified complex queries or joins that would become awkward or unreadable
- if bypassed, keep the Drizzle logic in the service, never in the controller

Example standard persistence flow:

```ts
const payload = QueryHandler.normalizeData(
  monitorScheduleModel as unknown as Record<string, unknown>,
  ["id", "createdAt", "updatedAt", "isDeleted"]
);

const insertResponse = await this.queryHandler.insert(payload, Table.MONITOR_SCHEDULES);
if (insertResponse.status !== 200) {
  return insertResponse;
}
```

Example of an acceptable direct-Drizzle read inside a service:

```ts
const rows = await this.db
  .select({
    totalRuns: count(),
    passedRuns: sql<number>`sum(case when status = 'passed' then 1 else 0 end)`
  })
  .from(schema.monitorRuns)
  .where(eq(schema.monitorRuns.userId, this.authenticatedUser.id));
```

Use direct Drizzle when it improves clarity for reporting, aggregation, or joins. Keep standard CRUD on `QueryHandler`.

## 6. Response Style

ApiWatcher standardizes response envelopes with `ResponseHandler`.

Canonical shape:

```json
{
  "status": 200,
  "data": {}
}
```

Error shape:

```json
{
  "status": 400,
  "error": "Human readable message",
  "error_reason": "optional_machine_reason"
}
```

Rules:

- controllers should always respond through `ResponseHandler`
- services should return `ApiResponse`
- avoid raw `res.json({ ... })` except inside `ResponseHandler`
- keep transport consistency across all endpoints

Example service return:

```ts
return {
  status: 200,
  data: {
    authenticated: true,
    user: serializedUser
  }
};
```

Example error return:

```ts
return {
  status: 404,
  error: "Schedule not found"
};
```

## 7. Auth and Request Context

ApiWatcher currently uses middleware-backed auth context:

- `AuthMiddleware` authenticates the request
- `AuthContext` stores the authenticated user for downstream service access
- services read from `AuthContext` instead of taking the request object

This separation is important and should survive the Uplee migration even if the auth mechanism changes from cookie sessions to JWTs.

For the rewrite:

- keep the `middleware -> AuthContext -> service` chain
- swap auth implementation details without leaking transport concerns into services
- keep tenant, role, and user identity available through shared request context

Example middleware pattern:

```ts
async requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionToken = req.signedCookies?.[SessionService.cookieName];
  if (!sessionToken) {
    this.responseHandler.controllerResponse(
      this.responseHandler.createErrorResponse("Authentication required", 401),
      res
    );
    return;
  }

  const session = await SessionService.getSession(sessionToken);
  if (!session) {
    this.responseHandler.controllerResponse(
      this.responseHandler.createErrorResponse("Session expired", 401),
      res
    );
    return;
  }

  const authUser = { id: 1, email: "owner@example.com", fullName: "Owner", role: "owner" };
  req.authUser = authUser;
  AuthContext.setUser(authUser);
  AuthContext.setSessionToken(sessionToken);
  next();
}
```

Example service-side access:

```ts
const authenticatedUser = AuthContext.requireUser();
const authenticatedUserId = authenticatedUser.id;
```

For the Uplee migration, this same pattern should expose:

- user id
- tenant id
- role
- email
- any request-scoped auth token/session metadata if needed

## 8. Queue and Worker Style

ApiWatcher prefers queued execution for asynchronous and scheduled work.

Current pattern:

- HTTP/API layer creates queued work
- `QueueService` owns BullMQ queues and workers
- `worker.ts` boots queue workers
- long-running run execution happens outside the request cycle

Guidelines:

- interactive requests should enqueue background jobs rather than do heavy work inline
- scheduler logic should be explicit and live in queue utilities/services
- use dedicated worker entrypoints for process separation
- attach progress logging to shared run-console style services where applicable

For the migration, this is one of the most important architectural traits to preserve.

Example enqueue pattern from a service:

```ts
const createdRun = await RunExecutionService.createQueuedRun({
  flowId: flowDefinitionModel.id,
  triggerType: "preview",
  userId: this.authenticatedUser.id
});

const job = await QueueService.enqueuePreviewRun({
  runId: Number(createdRun.id),
  flowId: flowDefinitionModel.id,
  userId: this.authenticatedUser.id,
  triggerType: "preview"
});

return {
  status: 202,
  data: {
    message: "Preview run queued",
    jobId: job.id,
    runId: createdRun.id
  }
};
```

Example worker pattern:

```ts
QueueService.scheduledWorker = new Worker(
  "scheduled-runs",
  async (job) => {
    const runId = await RunExecutionService.executeScheduledRun(job.data.scheduleId);
    return { runId };
  },
  QueueService.queueOptions()
);
```

Queue rules:

- request path creates jobs
- worker executes jobs
- service updates user-visible state
- queue utility owns BullMQ wiring

## 9. Validation and Sanitization Style

ApiWatcher validates early in the controller layer.

Pattern:

- compile incoming JSON with `Validation.compileJsonData`
- validate with DTO class
- map to model only after validation succeeds

This means:

- services can assume validated inputs
- models stay simple
- controllers own transport-shape concerns

Keep this pattern during the rewrite. Do not move validation deep into services unless it is a business rule rather than input-shape validation.

Example full validation pipeline:

```ts
const requestData = req.body;
const sanitizedRequestData = this.validation.compileJsonData(requestData);
const [isValid, errorResponse, dto] = await this.validation.validate(
  sanitizedRequestData,
  UserLoginDTO
);

if (!isValid) {
  return this.responseHandler.controllerResponse(errorResponse!, res);
}

const authService = new AuthService();
const serviceResponse = await authService.login(dto as UserLoginDTO);
```

## 10. Testing Style

The backend test style is pragmatic and service-focused.

Characteristics:

- uses `node:test` and `assert`
- patches static methods and injected dependencies directly
- uses auth-context helpers to simulate authenticated calls
- tests the service unit more than the HTTP transport

Common testing pattern:

- construct model input
- patch `QueryHandler` or infrastructure methods
- call the service directly
- assert returned status/data and side effects

Guidelines:

- test services first
- add route/controller tests for transport-specific logic only
- use e2e tests for real-stack behavior, not as the primary safety net
- prefer narrow deterministic tests over large fixture-heavy integration tests

Example service test pattern:

```ts
test("MonitorService.createSchedule accepts schedules for any owned flow", async (testContext) => {
  await runWithAuthContext(async () => {
    const monitorScheduleModel = new MonitorScheduleModel();
    monitorScheduleModel.setFlowDefinitionId(41);
    monitorScheduleModel.setName("Checkout every 10 minutes");

    const monitorService = new MonitorService(monitorScheduleModel);
    (monitorService as unknown as { queryHandler: Record<string, unknown> }).queryHandler = {
      validateAndSelect: async () => flowModel,
      insert: async () => ({ status: 200, data: [{ id: 71 }] }),
      update: async () => ({ status: 200, data: [] }),
      select: async () => []
    };

    const response = await monitorService.createSchedule();
    assert.equal(response.status, 200);
  });
});
```

Example auth-context helper pattern:

```ts
await runWithAuthContext(async () => {
  const service = new SomeService();
  const response = await service.someAction();
  assert.equal(response.status, 200);
});
```

## 11. Naming and Style Conventions

### File naming

- kebab-case files
- suffix by role:
  - `*-controller.ts`
  - `*-service.ts`
  - `*-model.ts`
  - `*.dto.ts`

### Class naming

- `AuthController`
- `MonitorService`
- `MonitorScheduleModel`
- `MonitorScheduleSaveDTO`

### Export style

- domain folders expose `index.ts` barrel files
- cross-cutting folders also use barrel exports
- import from barrels when it improves readability and keeps imports stable

Example barrel file:

```ts
export * from "./auth-controller";
export * from "./tenant-controller";
export * from "./tenant-user-controller";
```

Barrel rule:

- use barrels at folder boundaries
- avoid deep relative imports when a stable barrel exists
- keep barrels explicit rather than wildcard-exporting entire trees from many nested layers

### Code style

- explicit comments for section intent
- descriptive method names
- low magic
- favor small helpers over giant methods when logic branches
- constructors often instantiate their own lightweight dependencies unless explicit composition is needed at bootstrap

### Error handling

- controllers catch exceptions and return standard 500 payloads
- services prefer returning structured errors instead of throwing for expected business failures
- utilities may translate lower-level errors into service-friendly payloads

## 12. Rewrite Rules for the Uplee Migration

When moving Uplee into the ApiWatcher architecture, these are the governing rules for the merge project.

### Migration charter

`Uplee-v2` is the only destination codebase. The old `Uplee` app is a behavior and domain reference only; it must not remain a runtime dependency, shared package, or compatibility layer.

The migration is backend-first:

- rebuild the backend foundation in the `Uplee-v2` architecture
- reconnect frontend services and screens after each backend slice is stable
- keep temporary compatibility code small and remove it once a slice is fully ported
- avoid redesign unless a backend contract cleanup forces a small UI adjustment

During the migration phase, old data migration and test migration are out of scope. Manual verification is acceptable while slices are being ported; full automated testing can be tightened after the migration is complete.

### Source of truth

Use old `Uplee` as the product and behavior source of truth:

- backend bootstrap and module behavior
- Drizzle schema/domain concepts
- feature modules and services
- frontend routes, core services, models, and feature screens

Use `Uplee-v2` as the structure and style source of truth:

- `backend/src/app.ts`
- `backend/src/worker.ts`
- `backend/src/routes`
- `backend/src/controllers`
- `backend/src/services`
- `backend/src/dtos`
- `backend/src/models`
- `backend/src/database/schema.ts`
- `backend/src/enums`
- `backend/src/middleware`
- `backend/src/utilities`
- frontend core services, models, and feature folders
- root package scripts

### Compatibility target

Preserve the public behavior of the existing Uplee API families unless a deliberate product cleanup replaces them:

- `/api/auth`
- `/api/tenants`
- `/api/users`
- monitor/test-case APIs
- run/test-run APIs
- `/api/incidents`
- notification and alerting APIs
- `/api/dashboard`
- `/api/billing`

Preserve the user-facing feature concepts:

- auth
- tenants and workspace settings
- users and roles
- monitors/test cases
- runs/test runs
- incidents
- notifications and alerting
- recording and snapshots
- billing

Use current product terminology in new code. Prefer tenants, users, monitors, runs, incidents, alerts/contact groups, branding, snapshots, and billing over placeholder scaffold terminology.

### Schema and contract rules

Schemas come first. Generated models follow the schema. DTOs handle transport validation separately.

DTO naming should stay use-case specific:

- `<feature>-create.dto.ts`
- `<feature>-update.dto.ts`
- `<feature>-view.dto.ts`
- action-specific DTOs when a command is not plain create/update

Backend contracts should stay close enough to existing Uplee behavior that frontend services can reconnect with minimal friction.

### Persistence rules

Use `QueryHandler` as the default persistence facade for service CRUD.

Direct Drizzle is acceptable when `QueryHandler` cannot express the query cleanly, especially for:

- multi-table joins or `with` clauses
- aggregations such as `count` and `sum`
- ordering-heavy read models
- reporting/dashboard queries

When direct Drizzle is used in a service, add a short comment explaining why `QueryHandler` is insufficient for that query.

### Migration order

Port features in this order unless a dependency forces a small adjustment:

1. Auth foundation
2. Tenants and users
3. Monitor/test-case core
4. Execution and scheduling
5. Incidents, notifications, and dashboard
6. Recording and snapshots
7. Billing
8. Frontend reconnect
9. Cleanup and consolidation

Clean scaffold drift as you go:

- stale placeholder exports
- placeholder domain references
- script path inconsistencies
- generated output committed by accident
- scaffold leftovers that no longer match the product

### Keep

- ApiWatcher folder/layer structure
- controller/service/query-handler style
- DTO validation flow
- generated model pattern
- utility-heavy shared infrastructure
- worker/queue pattern
- service-level test style

### Change

- domain schema and routes should shift toward Uplee parity
- auth implementation can change to JWT
- request context should expand to include tenant and role
- queue jobs should support Uplee scheduling, incidents, notifications, and browser execution

### Do not carry over from Uplee

- Nest module structure
- decorator-driven controller/service wiring
- business logic coupled to framework classes
- framework-specific guards/interceptors as the main abstraction model

### Rewrite target shape for each migrated feature

For every Uplee feature area, create:

1. DTOs for request validation
2. model usage aligned to schema
3. controller methods for transport orchestration
4. service methods for business logic
5. route entries
6. tests at the service layer

If the feature needs cross-cutting helpers:

- add them under `utilities/` if they are generic or infrastructure-like
- otherwise keep them private to the service

### Validation during migration

While actively porting slices, validate manually before moving on:

- endpoints load and return expected shapes
- auth and protected routes behave correctly
- CRUD flows work for the migrated slice
- queued jobs run through the worker path
- frontend screens reconnect successfully to the migrated backend slice

After the migration stabilizes, add or restore automated coverage around the final behavior.

## 13. Recommended Migration Mapping

Suggested mapping for Uplee domains:

- `auth`, `tenants`, `users` -> controllers + services + tenant-aware auth context
- `dashboard` -> service-heavy read models, likely with some direct Drizzle queries where aggregation is needed
- `test-cases`, `test-runs`, `incidents`, `notifications` -> standard ApiWatcher service pattern backed by schema + queue
- `recording`, `snapshots` -> service + utility/service support for Playwright and file persistence
- `billing` -> service-oriented domain with utility helpers for Stripe, mail, invoice generation, and pricing

## 14. Anti-Patterns to Avoid

Avoid the following if we want the result to stay in ApiWatcher style:

- controllers containing business rules
- controllers performing direct Drizzle calls
- service methods that accept `Request` or `Response`
- feature code returning inconsistent JSON shapes
- adding validation decorators to generated models
- spreading one-off helper functions across random feature files when they belong in `utilities/`
- importing queue, mail, or DB primitives everywhere instead of going through shared services/utilities
- recreating Nest-like modules inside Express

## 15. Practical Checklist for New Features

When adding or migrating a feature, use this checklist:

- define or update schema first
- generate/update models from schema
- create DTOs for every input shape
- add or update model-aware service methods
- keep controller methods thin and validation-first
- return standardized `ApiResponse`
- register routes explicitly
- add service tests
- queue long-running work instead of blocking the request path
- extract reusable helpers into `utilities/` only when they are truly cross-cutting

Suggested implementation order per feature:

1. Add or update schema.
2. Regenerate models.
3. Create DTOs.
4. Add service logic.
5. Add controller methods.
6. Register routes.
7. Add service tests.
8. Add queue or worker support if the feature is asynchronous.

Suggested feature scaffold:

```text
backend/src/controllers/<feature>-controller.ts
backend/src/services/<feature>-service.ts
backend/src/dtos/<feature>/<feature>-create.dto.ts
backend/src/dtos/<feature>/<feature>-update.dto.ts
backend/src/dtos/<feature>/<feature>-view.dto.ts
tests/backend/services/<feature>-service.test.ts
```

For read-heavy or utility-heavy features, add only what is justified, but start from this scaffold rather than inventing a new structure.

## 16. Decision Summary for the Merge Project

For the Uplee rewrite, "written like ApiWatcher" should mean:

- Express composition root
- explicit routes/controllers/services
- DTO validation before service entry
- generated schema models
- `QueryHandler` as the default persistence facade
- `ResponseHandler` as the response contract
- auth context middleware
- BullMQ worker processes for async execution
- focused service tests as the main regression harness

If a migrated feature preserves these traits, it will feel native to ApiWatcher even when the business domain comes from Uplee.
