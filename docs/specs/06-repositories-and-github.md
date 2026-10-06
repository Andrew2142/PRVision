# 06 — Repositories and GitHub

Owner: build agent (wave 3)
Depends on: 00 (contracts), 01 (standards), 03 (schema/models), 04 (core infrastructure)
Consumed by: 05 (`POST /api/settings/test-github` calls `GitHubClient.verifyToken`), 07 (visualization create + workspace preparation; `getPullRequest`, `gitAuthHeaders`, `parseGithubRemoteUrl`, `githubErrorToApiResponse`), 13 (Repositories screens)
Contracts: 00 §9 as amended by 00 §14 (wire envelope and `error_reason` list §14.2, `RepositoryCreateRequest` and array list §14.4, delete `{ id }` / 409 `conflict` §14.4).

---

## 1. Purpose

Let the user register an existing local clone of a Vite + React project, detect everything the render pipeline needs about it (framework, package manager, Vite config, tsconfig, entry file, global styles, GitHub remote, default branch), and expose the data the "new visualization" dialog needs: open pull requests from GitHub and local branches plus a dirty-working-tree flag.

This sheet also owns the only GitHub API wrapper in the backend, `GitHubClient`, including token decryption, error mapping and pagination limits.

## 2. Scope / Out of scope

In scope:

- `RepositoriesController` with all seven `/api/repositories…` routes from 00 §9, with the shapes of 00 §14.4: `GET /repositories` returns `RepositoryView[]` (not paged); `POST` takes `{ localPath, name? }` with server-side `~/` expansion; `DELETE` returns `200 { id }` or `409 conflict`.
- DTOs: `repository-create.dto.ts` and the view DTOs `repository-view.dto.ts`, `pull-request-view.dto.ts`, `branch-list-view.dto.ts`. `shared/id-param.dto.ts` is created by sheet 04 (04 §8.7, contract change 5) and only used here.
- `RepositoriesService` (HTTP-facing, returns `ApiResponse`).
- `ProjectDetectionService`: the full detection algorithm in §5.4 and the pure helpers it exports.
- `GitHubClient` in `backend/src/utilities/services/github-client.ts`: Octokit construction, three API methods, `verifyToken` for sheet 05, error mapping and pagination limits.
- Branch listing and dirty-tree detection through `GitClient`.
- Duplicate-path handling, including soft-deleted rows.
- Redetect semantics.
- Route registration lines in `routes/index.ts` and controller construction in `app.ts`.
- The `config-consts` constants this sheet consumes (§5.8; names and values live in 02 §6.7).
- Tests in `tests/backend/repositories/`.

Out of scope:

- Settings storage, encryption of the PAT and the `test-github` endpoint (sheet 05). This sheet provides `GitHubClient` for 05 to call.
- `GitClient`, `QueryHandler`, `ResponseHandler`, `Validation`, `DTOMapper`, `logger`, `Encryption` (sheet 04).
- `SettingsStore` and the encrypted secret format `enc:v1:` (sheet 05). This sheet reads the PAT only through `SettingsStore.readGithubToken()`.
- Schema, migrations, generated `RepositoryModel` (sheet 03).
- Fetching PR refs and creating worktrees (sheet 07).
- Monorepo packages registered from a sub-folder, GitHub Enterprise Server, remote branches, Yarn Plug'n'Play, Next.js, and Angular targets. These are post-prototype. Detection rejects them with a clear message (§5.4).
- Frontend screens (sheet 13).

## 3. Dependencies

| Dependency | Sheet | What this sheet uses |
|---|---|---|
| `repositories`, `visualizations`, `app_settings` tables, `RepositoryModel`, `schema.repositories`, `schema.visualizations`, `schema.appSettings` | 03 | Persistence. Partial unique index on `repositories(local_path) WHERE is_deleted = false`. |
| `QueryHandler` (with `Where` operators and ordered `selectMany`), `DeletionMode`, `ErrorReason` | 03/04 | CRUD. 04 §8.3/§8.4. |
| `ResponseHandler`, `ApiResponse`, `Validation` (discriminated tuple), `DTOMapper`, `IdParamDTO` | 04 | Controller pattern. `Validation.validate` returns 400 with `error_reason: "validation_failed"`. |
| `GitClient`, `GitCommandError`, `GitAuthHeader` | 04 | All git calls (§3.1). |
| `expandHome`, `isPathInside` (`utilities/helpers/paths.ts`), `ArtifactStore.dataDir` | 04 | `~/` expansion; refuse registering a folder inside the data dir, or a repository that contains the data dir. |
| `toIsoString` (`utilities/helpers/date.ts`) | 04 | Date → ISO string in views (03 §9.5). |
| `SettingsStore.readGithubToken(): Promise<SecretRead>` | 05 | Decrypted PAT: `{ state: "absent" } \| { state: "present"; value } \| { state: "unreadable" }`. |
| `createLogger(module)` (pino, redaction) | 04 | Logging. |
| Enums `RepositoryFramework`, `PackageManager`, `VisualizationStatus`, `TERMINAL_VISUALIZATION_STATUSES`, `Table` | 00 §5 | |
| `typescript` (compiler API; a runtime dependency of `backend/`, 02 §6.9.1, 00 §14.1) | 02 | Parse the entry file for global style imports. |
| `@octokit/rest@^22` | 02 | GitHub REST. ESM-only; loaded by static import from the CommonJS build through Node's `require(esm)` (Node ≥ 22.12, 00 §14.1), compiled with `module: nodenext`. |

### 3.1 GitClient methods this sheet relies on (04 §9.5)

`GitClient` is stateless; every method takes the repository path as its first argument. All calls already run with 04's hardening (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, `GIT_TERMINAL_PROMPT=0`, no pager/colour, refs validated by `assertSafeRef` and placed after `--end-of-options`) and with 04's child-process environment (no `PRVISION_*`, `DATABASE_URL`, `REDIS_URL`; 00 §14.5). The names and signatures below are exactly those of 04 §9.5; none of these methods takes an options argument, so their bound is 04's `GIT_DEFAULT_TIMEOUT_MS` (30 s).

| Method | Used for |
|---|---|
| `topLevel(path): Promise<string>` | git root equality (§5.4 step 2). Throws `GitCommandError` (`not_a_repository`) outside a repo. |
| `revParse(cwd, "HEAD"): Promise<string>` | "has at least one commit". 04 runs `rev-parse --verify --quiet --end-of-options HEAD^{commit}`; throws `unknown_revision` on an empty repo. |
| `remoteUrl(cwd, remote): Promise<string \| null>` | GitHub remote discovery. `null` for a missing remote. |
| `symbolicRefDefault(cwd, remote): Promise<string \| null>` | Default branch from `refs/remotes/<remote>/HEAD`. |
| `listBranches(cwd): Promise<string[]>` | Local branches, most recent commit first. |
| `currentBranch(cwd): Promise<string \| null>` | `null` when detached. |
| `isDirty(cwd): Promise<boolean>` | Working-tree dirty flag (`status --porcelain=v1 -z --untracked-files=all`; ignored files excluded). |

`GitCommandError` carries `code: GitErrorCode`, `subcommand`, `exitCode` and an already-redacted `stderr`.

## 4. File inventory

All paths relative to `PRVision/`.

| File | Action | Responsibility |
|---|---|---|
| `backend/src/controllers/repositories-controller.ts` | create | `RepositoriesController`: seven thin methods. |
| `backend/src/controllers/index.ts` | modify | `export * from "./repositories-controller";` |
| `backend/src/dtos/repositories/repository-create.dto.ts` | create | `RepositoryCreateDTO`: `localPath` (absolute after 04's `expandHome`), optional `name` (00 §14.4 `RepositoryCreateRequest`). |
| `backend/src/dtos/repositories/repository-view.dto.ts` | create | `RepositoryView` interface + `toRepositoryView(model)`. |
| `backend/src/dtos/repositories/pull-request-view.dto.ts` | create | `PullRequestView` interface + `toPullRequestView(summary)`. |
| `backend/src/dtos/repositories/branch-list-view.dto.ts` | create | `BranchListView` interface. |
| `backend/src/dtos/repositories/index.ts` | create | Barrel. |
| `backend/src/dtos/index.ts` | modify | Re-export `repositories`. |
| `backend/src/services/repositories/repositories-service.ts` | create | `RepositoriesService`. |
| `backend/src/services/repositories/project-detection-service.ts` | create | `ProjectDetectionService` + exported pure helpers. |
| `backend/src/services/repositories/index.ts` | create | Barrel. |
| `backend/src/services/index.ts` | modify | Re-export repositories. |
| `backend/src/utilities/services/github-client.ts` | create | `GitHubClient` (incl. `verifyToken`, `gitAuthHeaders`), `GitHubClientError`, `githubErrorToApiResponse`, `parseGithubRemoteUrl`. |
| `backend/src/utilities/index.ts` | modify | Export the GitHub client module. |
| `backend/src/config-consts/app.config.ts` | — (owned by 02) | No change: the constants in §5.8 are already in 02 §6.7; this sheet only imports them. |
| `backend/src/routes/index.ts` | modify | Seven route lines (§5.9). |
| `backend/src/app.ts` | modify | Construct `RepositoriesController` and pass it to `registerRoutes`. |
| `tests/backend/repositories/repository-create-dto.test.ts` | create | DTO tests. |
| `tests/backend/repositories/project-detection-service.test.ts` | create | Detection algorithm against temp-dir fixtures and a fake `GitClient`. |
| `tests/backend/repositories/project-detection-helpers.test.ts` | create | Pure helpers: remote URL parsing, module script discovery, global style extraction, package manager. |
| `tests/backend/repositories/repositories-service.test.ts` | create | Service behaviour with stubbed dependencies. |
| `tests/backend/repositories/github-client.test.ts` | create | Fake Octokit port: mapping, pagination, error mapping. |
| `tests/backend/repositories/helpers/detection-fixture.ts` | create | Builds throw-away project folders under `os.tmpdir()`. |

## 5. Detailed design

### 5.1 Shared conventions in this sheet

- All repo-relative paths stored in the DB use POSIX separators and no leading `./`. Example: `src/main.tsx`, `vite.config.ts`.
- `globalStylePaths` entries are import specifiers that the render harness (sheet 10) can emit verbatim:
  - a file in the repo is stored root-relative with a leading slash: `/src/index.css` (Vite resolves `/…` from the project root);
  - a package stylesheet is stored as the bare specifier: `bootstrap/dist/css/bootstrap.min.css`, `@fontsource/inter`.
  The leading slash is how the two forms are told apart (00 §14.3).
- Every service method returns an `ApiResponse`. Expected failures return early with `{ status, error, error_reason }`. Only unexpected exceptions reach the `catch` block, which logs and returns 500.
- No per-user scoping: PRVision is single-user (00 D9). Services do not read `AuthContext`; tests still wrap calls in `runWithAuthContext` per the fixed test practice.

### 5.2 DTOs

#### `IdParamDTO` (04)

Sheet 04 ships `dtos/shared/id-param.dto.ts` (`@Type(() => Number) @IsInt() @Min(1) @Max(2_147_483_647) id`). "12abc" becomes `NaN` and fails `IsInt`. Controllers validate `this.validation.compileJsonData(req.params)` against it. Every route in this sheet has only `:id`, so `forbidNonWhitelisted` never trips.

#### `dtos/repositories/repository-create.dto.ts`

```ts
import { Transform } from "class-transformer";
import {
  IsOptional, IsString, Matches, MaxLength, MinLength, Validate,
  ValidatorConstraint, type ValidatorConstraintInterface,
} from "class-validator";
import path from "node:path";
import { expandHome } from "../../utilities/helpers/paths";   // 04 §9.7: "~" / "~/x" only; "~user" unchanged

/** Trims, then expands a leading "~" or "~/" (00 §14.4). Non-strings pass through to fail @IsString. Exported for tests. */
export function expandHomePath(value: unknown): unknown {
  return typeof value === "string" ? expandHome(value.trim()) : value;
}

@ValidatorConstraint({ name: "isAbsoluteLocalPath", async: false })
export class IsAbsoluteLocalPathConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0") &&
      path.isAbsolute(value) &&
      !/^[a-z]+:\/\//i.test(value)       // reject URLs such as file:// or https://
    );
  }
  defaultMessage(): string {
    return "localPath must be an absolute folder path (for example /home/me/projects/my-app)";
  }
}

export class RepositoryCreateDTO {
  @Transform(({ value }: { value: unknown }) => expandHomePath(value))
  @IsString()
  @MaxLength(4096)
  @Validate(IsAbsoluteLocalPathConstraint)
  localPath!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(/^[^\x00-\x1f\x7f]+$/, { message: "name must not contain control characters" })
  name?: string;
}
```

The DTO checks shape only. Whether the folder exists, is a git root and is a supported project is business validation in `ProjectDetectionService`. `"~user/x"` is not expanded and fails the absolute-path rule (clear 400). `name: null` is treated as omitted (`@IsOptional` skips `null`), so the detected name is used.

#### View DTOs

```ts
// dtos/repositories/repository-view.dto.ts
import type { RepositoryModel } from "../../models";
import type { PackageManager, RepositoryFramework } from "../../enums";
import { toIsoString } from "../../utilities/helpers/date";

export interface RepositoryView {
  id: number; name: string; localPath: string; githubOwner: string | null; githubRepo: string | null;
  defaultBranch: string; framework: RepositoryFramework; packageManager: PackageManager;
  viteConfigPath: string | null; tsconfigPath: string | null; entryFilePath: string | null; globalStylePaths: string[];
  lastDetectedAt: string; createdAt: string;
}

export function toRepositoryView(model: RepositoryModel): RepositoryView {
  return {
    id: model.id,
    name: model.name,
    localPath: model.localPath,
    githubOwner: model.githubOwner ?? null,
    githubRepo: model.githubRepo ?? null,
    defaultBranch: model.defaultBranch,
    framework: model.framework,
    packageManager: model.packageManager,
    viteConfigPath: model.viteConfigPath ?? null,
    tsconfigPath: model.tsconfigPath ?? null,
    entryFilePath: model.entryFilePath ?? null,
    globalStylePaths: Array.isArray(model.globalStylePaths) ? model.globalStylePaths.filter((s): s is string => typeof s === "string") : [],
    lastDetectedAt: toIsoString(model.lastDetectedAt),
    createdAt: toIsoString(model.createdAt),
  };
}
```

```ts
// dtos/repositories/pull-request-view.dto.ts
import type { GitHubPullRequestSummary } from "../../utilities";

export interface PullRequestView {
  number: number; title: string; author: string; headRef: string; baseRef: string;
  updatedAt: string; draft: boolean; url: string;
}

export function toPullRequestView(pr: GitHubPullRequestSummary): PullRequestView {
  return {
    number: pr.number, title: pr.title, author: pr.authorLogin, headRef: pr.headRef,
    baseRef: pr.baseRef, updatedAt: pr.updatedAt, draft: pr.draft, url: pr.htmlUrl,
  };
}
```

```ts
// dtos/repositories/branch-list-view.dto.ts
export interface BranchListView { current: string | null; branches: string[]; defaultBranch: string; workingTreeDirty: boolean; }
```

These shapes match 00 §9 exactly. Sheet 13 mirrors them in `core/models/*.model.ts`.

### 5.3 Controller — `controllers/repositories-controller.ts`

Every method has the same shape: validate, build model or id, call the service, respond. No business rules.

```ts
import type { Request, Response } from "express";
import { IdParamDTO, RepositoryCreateDTO } from "../dtos";
import { RepositoryModel } from "../models";
import { RepositoriesService } from "../services";
import { type ApiResponse, createLogger, DTOMapper, ResponseHandler, Validation } from "../utilities";

type IdReadResult = { ok: true; id: number } | { ok: false; response: ApiResponse };

/**
 * HTTP transport for registered repositories.
 * Validates params/bodies and delegates every rule to RepositoriesService.
 */
export class RepositoriesController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("repositories-controller");

  /** GET /api/repositories — list registered repositories. */
  async list(_req: Request, res: Response): Promise<Response> {
    try {
      const serviceResponse = await new RepositoriesService().list();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "list", res);
    }
  }

  /** POST /api/repositories — register a local clone after detection. */
  async create(req: Request, res: Response): Promise<Response> {
    try {
      // Validate the body against the create DTO.
      const sanitized = this.validation.compileJsonData(req.body);
      const [isValid, errorResponse, dto] = await this.validation.validate(sanitized, RepositoryCreateDTO);
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }

      // Map into the generated model and hand off to the service.
      const model = DTOMapper.map(dto, RepositoryModel);
      const serviceResponse = await new RepositoriesService(model).create();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "create", res);
    }
  }

  /** GET /api/repositories/:id — one repository. */
  async get(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).get();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "get", res);
    }
  }

  /** POST /api/repositories/:id/redetect — re-run project detection on the stored path. */
  async redetect(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).redetect();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "redetect", res);
    }
  }

  /** DELETE /api/repositories/:id — soft delete the repository and its visualizations. */
  async remove(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).remove();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "remove", res);
    }
  }

  /** GET /api/repositories/:id/pull-requests — open PRs from GitHub. */
  async listPullRequests(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).listPullRequests();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "listPullRequests", res);
    }
  }

  /** GET /api/repositories/:id/branches — local branches + working tree dirty flag. */
  async listBranches(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).listBranches();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "listBranches", res);
    }
  }

  /** Validate the :id route param through IdParamDTO. */
  private async readId(req: Request): Promise<IdReadResult> {
    const [isValid, errorResponse, dto] = await this.validation.validate(this.validation.compileJsonData(req.params), IdParamDTO);
    if (!isValid) return { ok: false, response: errorResponse };
    return { ok: true, id: dto.id };
  }

  private modelWithId(id: number): RepositoryModel {
    const model = new RepositoryModel();
    model.setId(id);
    return model;
  }

  private internalError(error: unknown, action: string, res: Response): Response {
    this.log.error({ event: "repositories.controller.unhandled", err: error, action }, "Unhandled repositories controller error");
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
```

### 5.4 `ProjectDetectionService` — detection algorithm

File: `services/repositories/project-detection-service.ts`.

```ts
export interface DetectedProject {
  rootPath: string;                 // realpath of the git toplevel (== registered localPath)
  suggestedName: string;            // package.json name, else folder basename
  githubOwner: string | null;
  githubRepo: string | null;
  githubRemoteName: string | null;  // "upstream" | "origin" | null (not persisted; logged only)
  defaultBranch: string;
  framework: "react_vite";
  packageManager: "npm" | "pnpm" | "yarn";
  viteConfigPath: string | null;    // repo-relative
  tsconfigPath: string | null;      // repo-relative
  entryFilePath: string | null;     // repo-relative
  globalStylePaths: string[];       // see §5.1
  warnings: string[];               // non-fatal findings, logged at info
}

export interface DetectionFailure {
  status: 400;
  errorReason: "validation_failed" | "not_git_repo" | "unsupported_framework" | "missing_node_modules";
  message: string;
}

export type DetectionResult = { ok: true; project: DetectedProject } | { ok: false; failure: DetectionFailure };

export interface ProjectDetectionDependencies {
  git: Pick<GitClient, "topLevel" | "revParse" | "remoteUrl" | "symbolicRefDefault" | "listBranches" | "currentBranch">;
  dataDir: string;                                  // new ArtifactStore().dataDir
}

export class ProjectDetectionService {
  constructor(private readonly deps: ProjectDetectionDependencies = defaultDetectionDependencies()) {}
  async detect(inputPath: string): Promise<DetectionResult> { /* steps below */ }
}
```

The service never executes code from the target repository. It does not evaluate `vite.config.*`, run package scripts or import anything from `node_modules`. It only reads files, with each read capped at `DETECTION_MAX_FILE_BYTES` (1 MiB), and calls read-only git commands.

Every repository file read goes through one private helper, `readRepoFile(root, repoRelativePath): Promise<string | null>`:

1. `rel = normalizeRepoRelativePath(repoRelativePath)` (04; rejects absolute, NUL and `..`).
2. `real = await fs.realpath(path.join(root, rel))`; missing → `null`. If `!isPathInside(root, real)` → `null` (a committed symlink such as `package.json -> /etc/passwd` or `index.html -> ~/.ssh/config` is treated as missing, never read).
3. `st = await fs.stat(real)`; not a regular file → `null`; `st.size > DETECTION_MAX_FILE_BYTES` → the caller's "too large" failure.
4. Read as UTF-8.

The one exception is `node_modules/<pkg>/package.json` (step 7), which may legitimately resolve outside the root through pnpm or a symlinked `node_modules`; it is read with the size cap and regular-file check but without the inside-root check, and only its `version` field is used. File contents never appear in responses or logs.

Steps run in this order. The first failure returns `{ ok: false, failure }`.

**Step 1 — resolve the folder.**
1. `const resolved = path.resolve(inputPath)` removes trailing slashes, `.` and `..`.
2. `fs.stat(resolved)`: if it is missing or not a directory, fail `validation_failed` with "Folder does not exist: <resolved>" or "Not a folder: <resolved>".
3. `const rootCandidate = await fs.realpath(resolved)` resolves symlinks, so two spellings of one folder compare equal.
4. If `isPathInside(realpath(dataDir), rootCandidate)` (04 `paths.ts`; equal counts as inside), fail `validation_failed` with "Folders inside the PRVision data directory cannot be registered". This blocks registering PRVision's own worktrees.
5. If `isPathInside(rootCandidate, realpath(dataDir))` (the data dir lives inside this folder, e.g. a dotfiles repository at `~` with the default `~/.prvision`), fail `validation_failed` with "This folder contains the PRVision data directory (<dataDir>). Register the project folder itself, or set PRVISION_DATA_DIR outside it." Otherwise worktrees would be created inside the user's own working tree. `realpath(dataDir)` uses the directory created by 04's `ensureRoots()` at boot.

**Step 2 — git toplevel equality.**
1. `toplevel = await git.topLevel(rootCandidate)`. A `GitCommandError` fails `not_git_repo` with "Not a git repository: <path>". If its code is `git_not_found`, the error propagates instead (500): git missing is an installation problem, which the worker's boot check (04) also reports.
2. `realToplevel = await fs.realpath(toplevel)`. If `realToplevel !== rootCandidate`, fail `not_git_repo` with "This folder is inside the git repository <realToplevel>. Register the repository root instead. (Monorepo packages in sub-folders are not supported yet.)"
3. `git.revParse(rootCandidate, "HEAD")`. If it fails with `unknown_revision`, fail `not_git_repo` with "The repository has no commits yet".
4. Shallow clones are not detected here. 04's `GitClient` has no such method, and the case is reported later by sheet 07 when `merge-base` fails, with an unshallow hint.

**Step 3 — read and parse `package.json`.**
1. Read `<root>/package.json`. If missing, fail `unsupported_framework` with "No package.json at the repository root".
2. Over the size cap, fail `unsupported_framework` with "package.json is larger than 1 MiB".
3. If `JSON.parse` fails or the result is not a plain object, fail `unsupported_framework` with "package.json is not valid JSON".
4. Narrow it to `PackageJsonShape` with a type guard (`dependencies`, `devDependencies` and `peerDependencies` must be string→string records when present; anything else is treated as absent):
   ```ts
   interface PackageJsonShape {
     name?: string; packageManager?: string;
     dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
     workspaces?: string[] | { packages?: string[] };
   }
   ```
5. `deps = { ...peerDependencies, ...devDependencies, ...dependencies }`. Later spreads win.

**Step 4 — monorepo note.**
`isWorkspaceRoot = Boolean(pkg.workspaces) || exists("pnpm-workspace.yaml") || exists("lerna.json") || exists("nx.json") || exists("turbo.json")`.
- If `isWorkspaceRoot` and the root `deps` lack either `react` or `vite`, fail `unsupported_framework` with "This looks like a monorepo root (workspaces). The prototype supports a single Vite + React package at the repository root."
- If `isWorkspaceRoot` and the root does declare both, continue and add warning "Workspace root detected; rendering uses the root package and the hoisted node_modules."

**Step 5 — framework checks (Next.js first, for a precise message).**
1. `deps.next` present: fail `unsupported_framework` with "Next.js projects are not supported yet (PRVision renders Vite + React projects)".
2. `deps.react` or `deps["react-dom"]` missing: fail `unsupported_framework` with "React and react-dom must be dependencies of the root package.json".
3. `deps.vite` missing: fail `unsupported_framework` with "Vite was not found in package.json (dependencies or devDependencies)".
4. `deps["@angular/core"]` present: add warning "Angular packages found; only React components are analysed". Not fatal.

**Step 6 — package manager.** This step comes before the node_modules check so error messages can name the right install command. Use the pure helper `detectPackageManager(pkg, existingFiles)`:
1. The corepack `packageManager` field wins when it starts with `pnpm@`, `yarn@` or `npm@`.
2. Otherwise the lockfiles, in this precedence: `pnpm-lock.yaml` → `pnpm`; `yarn.lock` → `yarn`; `package-lock.json` or `npm-shrinkwrap.json` → `npm`.
3. Otherwise `npm`. When more than one lockfile exists, add warning "Multiple lockfiles found; using <pm>".
4. `bun.lockb` or `bun.lock` alone: use `npm` and add warning "Bun lockfile found; Bun is not supported, falling back to npm semantics". The package manager is informational; PRVision never runs installs.

**Step 7 — node_modules.**
1. `.pnp.cjs` or `.pnp.js` exists and `node_modules` does not: fail `missing_node_modules` with "Yarn Plug'n'Play is not supported. Set `nodeLinker: node-modules` in .yarnrc.yml and run yarn install."
2. `<root>/node_modules` missing or not a directory (`fs.stat` follows symlinks): fail `missing_node_modules` with "node_modules not found. Run `<pm> install` in <root> first." `<pm>` is `npm`, `pnpm` or `yarn`.
3. For each of `vite`, `react` and `react-dom`, read `<root>/node_modules/<pkg>/package.json`. If one is missing, fail `missing_node_modules` with "<pkg> is declared but not installed. Run `<pm> install`." pnpm symlinks resolve through `fs.readFile`.
4. Parse the installed Vite `version`. If the major version is below `MIN_VITE_MAJOR` (4), fail `unsupported_framework` with "Vite <version> is not supported (need 4 or newer)". Parse the installed React version. If the major version is below 18, add warning "React <18 detected; the harness uses createRoot and may fail".

**Step 8 — Vite config discovery.** The first existing file wins, in Vite's own `DEFAULT_CONFIG_FILES` order:
`vite.config.js`, `vite.config.mjs`, `vite.config.ts`, `vite.config.cjs`, `vite.config.mts`, `vite.config.cts`.
Store it repo-relative, for example `vite.config.ts`. If none exists, store `null` and add warning "No vite.config found; the render engine will use Vite defaults". The file is never evaluated here.

**Step 9 — tsconfig discovery.** The first existing file wins: `tsconfig.app.json` (where Vite's react-ts template puts app `paths`), then `tsconfig.json`. Otherwise `null`, which is valid for a JavaScript project.

**Step 10 — entry file from `index.html`.**
1. Read `<root>/index.html`. If it exists, call `findModuleScriptSrc(html)`:
   - Strip HTML comments: `html.replace(/<!--[\s\S]*?-->/g, "")`.
   - Iterate `/<script\b([^>]*)>/gi`. For each tag, parse attributes with `/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g` into a lowercase-keyed map.
   - Return the `src` of the first tag whose `type` is `module` (case-insensitive) and whose `src` is non-empty and not absolute-URL (`/^[a-z]+:/i` or `//`).
2. Resolve the src. Strip `?…` and `#…`. If it starts with `/`, resolve it against `<root>`; otherwise resolve it against the directory of `index.html`. The resolved file must exist and stay inside `<root>`, which blocks `../../`. If both hold, store it repo-relative, for example `src/main.tsx`.
3. Fallback when there is no `index.html`, no module script, or the resolved file is missing: probe `src/main.tsx`, `src/main.jsx`, `src/index.tsx`, `src/index.jsx`, `src/main.ts`, `src/main.js`, `src/index.ts`, `src/index.js`. The first that exists wins, with warning "Entry file inferred from convention (<path>)".
4. Otherwise `null`, with warning "No entry file found; global styles were not detected". Not fatal; sheet 10 renders without global styles.

**Step 11 — global styles from the entry file (TypeScript compiler API).**
`extractGlobalStyleImports(sourceText, entryRepoPath, rootPath, fileExists)` is a pure function apart from the injected `fileExists`:

```ts
import ts from "typescript";

const STYLE_EXT = /\.(css|scss|sass|less)$/i;
const CSS_MODULE = /\.module\.(css|scss|sass|less)$/i;

export function extractGlobalStyleImports(
  sourceText: string,
  entryRepoPath: string,                   // "src/main.tsx"
  fileExists: (repoRelativePath: string) => boolean,
): string[] {
  const kind = /\.(tsx|jsx)$/i.test(entryRepoPath) ? ts.ScriptKind.TSX
    : /\.ts$/i.test(entryRepoPath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(entryRepoPath, sourceText, ts.ScriptTarget.Latest, false, kind);
  const results: string[] = [];

  for (const statement of source.statements) {
    // Only top-level side-effect imports: `import "./index.css";`
    if (!ts.isImportDeclaration(statement) || statement.importClause !== undefined) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const raw = statement.moduleSpecifier.text;
    if (raw.includes("?")) continue;                        // ?inline, ?url, ?raw are not global side effects
    if (!STYLE_EXT.test(raw) && !isBarePackageStyle(raw)) continue;
    if (CSS_MODULE.test(raw)) continue;                     // CSS modules are scoped, not global

    if (raw.startsWith("./") || raw.startsWith("../")) {
      const repoRel = path.posix.normalize(path.posix.join(path.posix.dirname(entryRepoPath), raw));
      if (repoRel.startsWith("../") || !fileExists(repoRel)) continue;   // outside root or missing
      results.push(`/${repoRel}`);
    } else if (raw.startsWith("/")) {
      if (fileExists(raw.slice(1))) results.push(raw);
    } else {
      results.push(raw);                                    // bare package specifier, resolved by Vite at render time
    }
    if (results.length >= MAX_GLOBAL_STYLES) break;
  }
  return [...new Set(results)];
}

/** "@fontsource/inter" style imports have no extension but are CSS-only packages. */
function isBarePackageStyle(specifier: string): boolean {
  return /^@fontsource(-variable)?\//.test(specifier);
}
```

The parser runs with `setParentNodes: false`. It does not type-check and tolerates syntax errors: `createSourceFile` always returns a tree. Dynamic `import("./x.css")` and `require` calls are ignored on purpose. Imports of CSS from `App.tsx` and other components are not global. They load naturally when the harness renders the component that imports them.

**Step 12 — GitHub remote.**
1. For `remoteName` in `["upstream", "origin"]`: `url = await git.remoteUrl(root, remoteName)`. If `url` is non-null and `parseGithubRemoteUrl(url)` returns `{ owner, repo }`, use it and stop. The fork workflow, where `origin` is the user's fork and `upstream` is the main repo, therefore lists the main repo's PRs.
2. If no remote parses, set `githubOwner`, `githubRepo` and `githubRemoteName` to `null`. If a remote exists but points elsewhere (another host or GitHub Enterprise), add warning "Remote <name> is not on github.com; pull request features are disabled". Registration still succeeds, so `local_branch` and `working_tree` remain usable.

`parseGithubRemoteUrl(url: string): { owner: string; repo: string } | null` lives in `github-client.ts` because sheet 07 also uses it. Behaviour:

| Input | Result |
|---|---|
| `git@github.com:acme/web-app.git` | `{ acme, web-app }` |
| `git@github.com:acme/web-app` | `{ acme, web-app }` |
| `github.com:acme/web-app.git` (scp form without user) | `{ acme, web-app }` |
| `ssh://git@github.com/acme/web-app.git` | `{ acme, web-app }` |
| `ssh://git@github.com:22/acme/web-app.git` | `{ acme, web-app }` |
| `ssh://git@ssh.github.com:443/acme/web-app.git` | `{ acme, web-app }` (GitHub's SSH-over-443 host) |
| `https://github.com/acme/web-app.git` | `{ acme, web-app }` |
| `https://github.com/acme/web-app/` | `{ acme, web-app }` |
| `https://user:ghp_secret@github.com/acme/web-app.git` | `{ acme, web-app }`. Credentials are discarded and never logged. |
| `https://www.github.com/acme/web-app` | `{ acme, web-app }` |
| `git://github.com/acme/web-app.git` | `{ acme, web-app }` |
| `HTTPS://GitHub.COM/Acme/Web-App.git` | `{ Acme, Web-App }` (host case-insensitive, path case preserved) |
| `https://github.example.com/acme/web-app.git` (GitHub Enterprise) | `null` |
| `git@github-work:acme/web-app.git` (ssh config alias) | `null` |
| `https://gitlab.com/acme/web-app.git` | `null` |
| `https://github.com/acme` (no repo) | `null` |
| `https://github.com/acme/web-app/tree/main` (extra segments) | `null` |
| `/srv/git/web-app.git`, `file:///…` | `null` |

Algorithm:
1. Trim the input.
2. For scp-like input (matches `^(?:[^@/]+@)?([^:/]+):(?!//)(.+)$` and has no `://`), take host = group 1 and path = group 2.
3. Otherwise run `new URL(input)` inside try/catch. The protocol must be one of `https:`, `http:`, `ssh:` or `git:`. Take host = `url.hostname` and path = `url.pathname`.
4. Lowercase the host. Accept only `github.com`, `www.github.com` or `ssh.github.com`. Otherwise return `null`.
5. Strip the leading `/`, one trailing `/` and one trailing `.git`, then split on `/`. Exactly two segments are required.
6. Validate `owner` against `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` and `repo` against `^[A-Za-z0-9._-]{1,100}$` (repo also must not be `.` or `..`).

GitHub Enterprise decision: rejected for the prototype. `parseGithubRemoteUrl` returns `null` and the repository registers without PR support. Supporting GHES later means storing an `api_base_url` per repository and passing `baseUrl` to Octokit. That is a schema change and therefore out of scope.

**Step 13 — default branch resolution.** The first rule that yields a value wins:
1. When a GitHub remote was found: `git.symbolicRefDefault(root, remoteName)` (the `refs/remotes/<remote>/HEAD` symref, prefix stripped). For non-GitHub repos, try `symbolicRefDefault(root, "origin")`.
2. The first of `main`, `master`, `develop` or `trunk` that exists in `git.listBranches(root)`.
3. `git.currentBranch(root)`, when not detached.
4. The first entry of `git.listBranches(root)`.
5. Otherwise fail `not_git_repo` with "Could not determine a default branch (no local branches)".

The resolution is local-only, so detection makes no network calls. When rule 1 misses but a remote exists, add warning "origin/HEAD is not set; run `git remote set-head <remote> --auto` for an accurate default branch".

**Step 14 — name.** `suggestedName` is `pkg.name` when it is a non-empty string of 200 characters or fewer, otherwise `path.basename(root)`. The service applies the user's `name` override.

Return `{ ok: true, project }`.

### 5.5 `RepositoriesService`

```ts
export interface RepositoriesServiceDependencies {
  queryHandler: QueryHandler;
  detector: Pick<ProjectDetectionService, "detect">;
  git: Pick<GitClient, "listBranches" | "currentBranch" | "isDirty">;
  readGithubToken: () => Promise<SecretRead>;                                        // new SettingsStore().readGithubToken()
  githubClientFactory: (token: string) => Pick<GitHubClient, "listOpenPullRequests">; // GitHubClient.fromToken
  now: () => Date;
}

export class RepositoriesService {
  private readonly deps: RepositoriesServiceDependencies;
  private readonly log = createLogger("repositories-service");

  constructor(
    private readonly repositoryPayload: RepositoryModel = new RepositoryModel(),
    deps: Partial<RepositoriesServiceDependencies> = {},
  ) {
    this.deps = { ...defaultRepositoriesDependencies(), ...deps };
  }

  list(): Promise<ApiResponse>;
  get(): Promise<ApiResponse>;
  create(): Promise<ApiResponse>;
  redetect(): Promise<ApiResponse>;
  remove(): Promise<ApiResponse>;
  listPullRequests(): Promise<ApiResponse>;
  listBranches(): Promise<ApiResponse>;
}
```

Shared private helpers:

```ts
/** Load one non-deleted repository by the id in the payload. */
private async loadRepository(): Promise<RepositoryModel | null> {
  return this.deps.queryHandler.validateAndSelect(RepositoryModel, { id: this.repositoryPayload.id }, Table.REPOSITORIES);
  // QueryHandler adds isDeleted = false automatically for soft-delete tables.
}

private notFound(): ApiResponse {
  return { status: 404, error: "Repository not found", error_reason: "not_found" };
}

private detectionFailure(failure: DetectionFailure): ApiResponse {
  return { status: failure.status, error: failure.message, error_reason: failure.errorReason };
}

private detectedFields(project: DetectedProject): Record<string, unknown> {
  return {
    localPath: project.rootPath,
    githubOwner: project.githubOwner,
    githubRepo: project.githubRepo,
    defaultBranch: project.defaultBranch,
    framework: project.framework,
    packageManager: project.packageManager,
    viteConfigPath: project.viteConfigPath,
    tsconfigPath: project.tsconfigPath,
    entryFilePath: project.entryFilePath,
    globalStylePaths: project.globalStylePaths,
    lastDetectedAt: this.deps.now(),
  };
}
```

#### `list()`
1. `queryHandler.selectMany(RepositoryModel, {}, Table.REPOSITORIES, { orderBy: [{ column: "name", direction: "asc" }, { column: "id", direction: "asc" }] })`. The soft-delete filter is added by `QueryHandler`.
2. `selectMany` already returns hydrated `RepositoryModel`s (04 §8.4); map each with `toRepositoryView`.
3. Return `200` with `RepositoryView[]`, unpaged. There is no list DTO in 00, and local users have a handful of repositories.

#### `get()`
`loadRepository()`. If it returns `null`, respond 404 `not_found`. Otherwise respond 200 with `toRepositoryView(model)`.

#### `create()`
1. `const detection = await this.deps.detector.detect(this.repositoryPayload.localPath)`. On failure, return `detectionFailure`.
2. Duplicate check on the canonical path, which only considers non-deleted rows:
   `const existing = await queryHandler.select({ localPath: project.rootPath }, Table.REPOSITORIES, true)`.
   If it is non-empty, return `{ status: 409, error: "This folder is already registered as \"<name>\" (id <id>)", error_reason: "conflict" }`.
3. Soft-deleted rows with the same path are ignored. The partial unique index (`WHERE is_deleted = false`, sheet 03) lets a new row be inserted. Old soft-deleted rows and their hidden visualizations stay as history and are never revived (03 §9.7). A re-registered folder therefore always gets a fresh id and fresh detection, with no stale config from the old row.
4. Insert:
   ```ts
   const insertResponse = await this.deps.queryHandler.insert(
     { name: this.repositoryPayload.name ?? project.suggestedName, ...this.detectedFields(project) },
     Table.REPOSITORIES,
   );
   ```
5. If `insertResponse.status === 409`, a unique-violation race occurred: two concurrent registers. `QueryHandler` reports this as `error_reason: "conflict"` on `repositories_local_path_active_key` (03 §9.4). Return `409 { error: "This folder is already registered", error_reason: "conflict" }` (the raw constraint text from `QueryHandler` is not passed through).
6. Any other non-200 status, or no row returned: log `{ status }` and return `500 { error: "Repository could not be saved", error_reason: "internal_error" }`.
7. Log at info: `{ repositoryId, localPath, githubOwner, githubRepo, packageManager, warnings }` "Repository registered".
8. Return `201` with `toRepositoryView(new RepositoryModel(row))`.

#### `redetect()`
1. `loadRepository()`. If missing, 404.
2. `detect(existing.localPath)`. On failure, return `detectionFailure` and **leave the row unchanged**. The UI shows the error, and the stored config stays as it was until the folder is fixed.
3. If `project.rootPath !== existing.localPath`, the folder is now a symlink to somewhere else, or a path segment was replaced. Check for a duplicate with `queryHandler.select({ localPath: project.rootPath, id: Where.ne(existing.id) }, Table.REPOSITORIES, true)`. On a duplicate, respond `409 conflict`. Otherwise update `localPath` too, since it is part of `detectedFields`. A unique violation from the update (race) is also mapped to `409 conflict`.
4. `queryHandler.update(this.detectedFields(project), { id: existing.id }, Table.REPOSITORIES)`. `name` is **not** changed, so a user-chosen name survives redetect.
5. Reload and return `200` with the view.
6. Redetect is allowed while a visualization for this repository is running. The worker snapshots repository config into `PipelineContext` at start (sheet 07), so a mid-run redetect only affects later runs.

#### `remove()`
Repository deletion follows 03 §9.7: soft-delete the repository row only. Its visualizations are not modified. Sheet 07 hides them by joining on `repositories.is_deleted = false`, and their artifacts stay on disk.
1. `loadRepository()`. If missing, 404.
2. Active-run guard through `QueryHandler` with a `Where` operator (04 §8.3):
   ```ts
   const active = await this.deps.queryHandler.count(
     { repositoryId: id, status: Where.notIn([...TERMINAL_VISUALIZATION_STATUSES]) },
     Table.VISUALIZATIONS,
   );                                                     // isDeleted = false added by default
   ```
   If `active.status !== 200`, return 500. If `(active.data?.count ?? 0) > 0`, return `409 { error: "This repository has visualizations queued or in progress. Cancel them first.", error_reason: "conflict" }` (00 §14.4). Without this guard, the worker would fail a queued run with "repository removed", and a running one would keep using a repository the user believes is gone.
   The count and the soft delete are two statements, so a visualization created between them can still reference a just-deleted repository. That window is accepted: 07's worker loads the repository with the soft-delete filter and fails such a run with "The repository for this visualization was removed." before any git work.
3. `queryHandler.delete({ id }, Table.REPOSITORIES, DeletionMode.SOFT)`. This is a single-row write, so no transaction is needed. `404` (deleted concurrently) → `404 not_found`; any other non-200 → `500 { error: "Repository could not be removed", error_reason: "internal_error" }`.
4. The user's clone is not touched. PRVision refs are removed per run by sheet 07, and worktrees never outlive a run.
5. Log at info `{ repositoryId }` "Repository removed". Return `200 { id }` (00 §14.4).

Known limitation: artifacts of a deleted repository's visualizations stay under `<dataDir>/artifacts/` until the data dir is wiped. This matches 03 §9.7. A purge is listed under Contract changes as a possible follow-up.

#### `listPullRequests()`
1. `loadRepository()`. If missing, 404.
2. If `githubOwner` or `githubRepo` is null, return `400 { error: "This repository has no github.com remote (checked upstream and origin)", error_reason: "no_github_remote" }`.
3. `const secret = await this.deps.readGithubToken()`.
   - `absent`: return `400 { error: "Add a GitHub token in Settings to list pull requests.", error_reason: "github_token_missing" }`.
   - `unreadable`: return `400 { error: "The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again in Settings.", error_reason: "github_token_missing" }`. This is the same wording as sheet 05.
4. `const prs = await this.deps.githubClientFactory(secret.value).listOpenPullRequests(owner, repo)`.
5. On `GitHubClientError`, return `githubErrorToApiResponse(error, { owner, repo })` (§5.6.4). Do not log the error object's request; log `{ kind, status }` only.
6. Return `200` with `prs.map(toPullRequestView)`. GitHub already orders the list by `updated` desc.

#### `listBranches()`
1. `loadRepository()`. If missing, 404.
2. If `fs.stat(localPath)` fails, return `400 { error: "Repository folder is missing: <path>. Restore it or remove the repository.", error_reason: "not_git_repo" }`.
3. `Promise.all([git.listBranches(localPath), git.currentBranch(localPath), git.isDirty(localPath)])`.
4. On `GitCommandError`, return `400 { error: "git failed: <first line of the (already redacted) stderr, max 200 chars>", error_reason: "not_git_repo" }`.
5. `branches` is the list truncated to `BRANCH_LIST_MAX` (500). It is already sorted most recent first. If `current` is non-null and missing after truncation, prepend it. If `defaultBranch` is missing, prepend it too, so the dialog can always preselect both.
6. `workingTreeDirty` is the `isDirty` result. Tracked changes, staged changes and untracked non-ignored files all count. Ignored files do not, because `git status` honours `.gitignore`.
7. Return `200` with the `BranchListView`, using the stored `defaultBranch`.

Branch listing is local only (`refs/heads`). Remote-tracking branches are out of scope; the user checks out or fetches a branch to visualize it.

### 5.6 `GitHubClient` — `utilities/services/github-client.ts`

#### 5.6.1 Types

```ts
export interface GitHubPullRequestSummary {
  number: number; title: string; authorLogin: string; headRef: string; baseRef: string;
  updatedAt: string; draft: boolean; htmlUrl: string;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestSummary {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseSha: string;
  headRepoFullName: string | null;   // null when the fork was deleted
  isFork: boolean;                   // headRepoFullName !== `${owner}/${repo}` (case-insensitive)
}

export type GitHubErrorKind = "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "unavailable" | "invalid" | "unknown";

/** Sheet 05 contract (05 §5.6). */
export type GitHubTokenVerification =
  | { ok: true; login: string }
  | { ok: false; reason: "unauthorized" | "forbidden" | "rate_limited" | "network" | "unknown"; status: number | null; message: string };

/** not_found / invalid on GET /user cannot happen with a valid URL; treat them as unknown. */
function toVerificationReason(kind: GitHubErrorKind): Extract<GitHubTokenVerification, { ok: false }>["reason"] {
  switch (kind) {
    case "unauthorized": return "unauthorized";
    case "forbidden": return "forbidden";
    case "rate_limited": return "rate_limited";
    case "unavailable": return "network";
    default: return "unknown";
  }
}

export class GitHubClientError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly httpStatus: number | null,
    readonly retryAfterSeconds: number | null,
    readonly githubMessage: string | null,   // GitHub's `message` field, safe to show (no secrets)
  ) { super(message); this.name = "GitHubClientError"; }
}
```

#### 5.6.2 Port and Octokit construction

Tests inject a fake port. Production wraps Octokit explicitly, so no casts are needed and Octokit's large types never leak.

```ts
import { Octokit } from "@octokit/rest";

export interface GitHubRestPort {
  getAuthenticatedUser(signal: AbortSignal): Promise<{ login: string }>;
  listPulls(p: { owner: string; repo: string; page: number; perPage: number; signal: AbortSignal }): Promise<RawPull[]>;
  getPull(p: { owner: string; repo: string; pullNumber: number; signal: AbortSignal }): Promise<RawPullDetail>;
}

interface RawPull {
  number: number; title: string; user: { login: string } | null; draft?: boolean;
  updated_at: string; html_url: string; head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string };
}
interface RawPullDetail extends RawPull { state: string; merged: boolean | null; }

export function createOctokitPort(token: string): GitHubRestPort {
  const octokit = new Octokit({
    auth: token,
    userAgent: GITHUB_USER_AGENT,           // "PRVision/0.1 (local developer tool)"
    baseUrl: GITHUB_API_BASE_URL,           // "https://api.github.com"
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    request: { retries: 0 },
  });
  return {
    async getAuthenticatedUser(signal) {
      const { data } = await octokit.rest.users.getAuthenticated({ request: { signal } });
      return { login: data.login };
    },
    async listPulls({ owner, repo, page, perPage, signal }) {
      const { data } = await octokit.rest.pulls.list({
        owner, repo, state: "open", sort: "updated", direction: "desc", per_page: perPage, page, request: { signal },
      });
      return data.map((pr) => ({
        number: pr.number, title: pr.title, user: pr.user ? { login: pr.user.login } : null, draft: pr.draft,
        updated_at: pr.updated_at, html_url: pr.html_url,
        head: { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo ? { full_name: pr.head.repo.full_name } : null },
        base: { ref: pr.base.ref, sha: pr.base.sha },
      }));
    },
    async getPull({ owner, repo, pullNumber, signal }) {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber, request: { signal } });
      return {
        number: pr.number, title: pr.title, user: pr.user ? { login: pr.user.login } : null, draft: pr.draft,
        updated_at: pr.updated_at, html_url: pr.html_url, state: pr.state, merged: pr.merged,
        head: { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo ? { full_name: pr.head.repo.full_name } : null },
        base: { ref: pr.base.ref, sha: pr.base.sha },
      };
    },
  };
}
```

Octokit's own logger is silenced: its warnings can echo request URLs, and its `RequestError` objects carry request options. Octokit redacts the authorization header, but this client still never logs the raw error object (§8). `@octokit/plugin-retry` and `@octokit/plugin-throttling` are **not** used. The UI calls these endpoints interactively, so failing fast with a clear rate-limit message is better than silent waits.

#### 5.6.3 Client

```ts
export class GitHubClient {
  constructor(private readonly port: GitHubRestPort) {}

  /** Construct from a plaintext token (sheet 05's test-github uses this). */
  static fromToken(token: string): GitHubClient {
    return new GitHubClient(createOctokitPort(token));
  }

  /**
   * Sheet 05 contract (05 §5.6): GET /user with the token. Never throws for HTTP or network failures.
   * `message` is a sanitized sentence without the token.
   */
  static async verifyToken(token: string, options: { signal?: AbortSignal; port?: GitHubRestPort } = {}): Promise<GitHubTokenVerification> {
    const port = options.port ?? createOctokitPort(token); // tests inject a fake port
    try {
      // Always bounded by the client timeout, even when the caller passes its own signal.
      const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
      const user = await port.getAuthenticatedUser(options.signal ? AbortSignal.any([options.signal, timeout]) : timeout);
      return { ok: true, login: user.login };
    } catch (error) {
      const mapped = toGitHubClientError(error);
      return { ok: false, reason: toVerificationReason(mapped.kind), status: mapped.httpStatus, message: mapped.message };
    }
  }

  /**
   * Headers for `GitClient.fetch(..., { auth })` (00 §14.8; 04 §9.5 assigns building them to 06), in the
   * order sheet 07 tries them: Basic `x-access-token:<token>` first (the actions/checkout form, accepted
   * for git over HTTPS by classic and fine-grained PATs), then Bearer as a fallback. Scoped to
   * https://github.com/ so redirects to other hosts never receive them. 07 iterates the array in order and
   * never indexes it. Never log the result; it is passed to GitClient only (env, never argv).
   * Throws Error("Invalid token") (programming error) when `token` contains whitespace, ":" or control
   * characters, so a malformed value can never inject a second header line into the git config value.
   */
  static gitAuthHeaders(token: string): GitAuthHeader[] {
    if (!/^[A-Za-z0-9_]+$/.test(token)) throw new Error("Invalid token");
    return [
      { urlPrefix: "https://github.com/", header: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` },
      { urlPrefix: "https://github.com/", header: `AUTHORIZATION: bearer ${token}` },
    ];
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    return this.call(() => this.port.getAuthenticatedUser(this.timeoutSignal()));
  }

  async listOpenPullRequests(owner: string, repo: string): Promise<GitHubPullRequestSummary[]> {
    const results: GitHubPullRequestSummary[] = [];
    for (let page = 1; page <= GITHUB_PR_LIST_MAX_PAGES; page += 1) {
      const batch = await this.call(() => this.port.listPulls({
        owner, repo, page, perPage: GITHUB_PR_LIST_PAGE_SIZE, signal: this.timeoutSignal(),
      }));
      results.push(...batch.map(mapPullSummary));
      if (batch.length < GITHUB_PR_LIST_PAGE_SIZE) break;     // last page
    }
    return results;   // at most 300; older open PRs beyond that are not listed (documented limit)
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GitHubPullRequestDetail> {
    const raw = await this.call(() => this.port.getPull({ owner, repo, pullNumber, signal: this.timeoutSignal() }));
    const summary = mapPullSummary(raw);
    const headRepoFullName = raw.head.repo?.full_name ?? null;
    return {
      ...summary,
      state: raw.state === "closed" ? "closed" : "open",
      merged: raw.merged === true,
      headSha: raw.head.sha,
      baseSha: raw.base.sha,
      headRepoFullName,
      isFork: headRepoFullName === null || headRepoFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase(),
    };
  }

  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);   // 15 000 ms
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toGitHubClientError(error);
    }
  }
}

function mapPullSummary(raw: RawPull): GitHubPullRequestSummary {
  return {
    number: raw.number, title: raw.title, authorLogin: raw.user?.login ?? "ghost",
    headRef: raw.head.ref, baseRef: raw.base.ref, updatedAt: raw.updated_at,
    draft: raw.draft === true, htmlUrl: raw.html_url,
  };
}
```

#### 5.6.4 Error mapping

`toGitHubClientError(error: unknown): GitHubClientError` reads the error structurally, so the code does not depend on `@octokit/request-error` directly:

```ts
function toGitHubClientError(error: unknown): GitHubClientError {
  if (error instanceof GitHubClientError) return error;
  const status = readNumber(error, "status");                       // RequestError.status
  const headers = readRecord(readRecord(error, "response"), "headers");
  const ghMessage = readString(readRecord(readRecord(error, "response"), "data"), "message");
  const remaining = headers?.["x-ratelimit-remaining"];
  const retryAfter = parseRetryAfter(headers);                      // retry-after seconds, or x-ratelimit-reset − now
  const isRateLimit = (status === 403 || status === 429) &&
    (remaining === "0" || retryAfter !== null || /rate limit/i.test(ghMessage ?? ""));

  if (isAbortOrTimeout(error)) return new GitHubClientError("GitHub did not respond in time", "unavailable", null, null, null);
  if (isRateLimit) return new GitHubClientError("GitHub rate limit reached", "rate_limited", status, retryAfter, ghMessage);
  if (status === 401) return new GitHubClientError("GitHub rejected the token", "unauthorized", 401, null, ghMessage);
  if (status === 403) return new GitHubClientError("GitHub denied access", "forbidden", 403, null, ghMessage);
  if (status === 404) return new GitHubClientError("Not found on GitHub", "not_found", 404, null, ghMessage);
  if (status === 422) return new GitHubClientError("GitHub rejected the request", "invalid", 422, null, ghMessage);
  if (status === null || status >= 500) return new GitHubClientError("GitHub is unavailable", "unavailable", status, null, ghMessage);
  return new GitHubClientError(`GitHub request failed (${status})`, "unknown", status, null, ghMessage);
}
```

`isAbortOrTimeout` is true for `name === "AbortError" || name === "TimeoutError"`, and for an error whose `cause` has one of those names. `status === null` with a network `cause` (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`) maps to `unavailable`.

`githubErrorToApiResponse(error, context: { owner: string; repo: string; pullNumber?: number }): ApiResponse` turns the client error into HTTP. 401 and 403 are deliberately not passed through: the frontend shell copied from Uply-v2 treats 401 as "session expired".

| `kind` | HTTP | `error_reason` | Message |
|---|---|---|---|
| `unauthorized` | 400 | `github_unauthorized` | "GitHub rejected the token (expired or revoked). Update it in Settings." |
| `forbidden` | 400 | `github_unauthorized` | "The GitHub token cannot access {owner}/{repo}. A fine-grained token needs Pull requests: Read and Contents: Read on this repository." Append the GitHub message when it mentions SAML: "Authorize the token for SSO in your organization settings." |
| `not_found`, with `pullNumber` | 404 | `not_found` | "Pull request #{n} was not found in {owner}/{repo}, or the token cannot see this repository." |
| `not_found`, without `pullNumber` | 400 | `github_unauthorized` | "Repository {owner}/{repo} was not found, or the token cannot access it. Fine-grained tokens return 404 for repositories outside their selection." |
| `rate_limited` | 429 | `github_rate_limited` | "GitHub rate limit reached. Try again in {n} minutes." (`n = ceil(retryAfterSeconds / 60)`, minimum 1). Without `retryAfterSeconds`: "GitHub rate limit reached. Try again later." |
| `invalid` | 400 | `validation_failed` | "GitHub rejected the request: {githubMessage, ≤ 200 chars}" |
| `unavailable` | 502 | `github_unavailable` | "GitHub could not be reached. Check your network and try again." |
| `unknown` | 502 | `github_unavailable` | "GitHub request failed (HTTP {status})." |

Every `error_reason` above is from 00 §14.2. `githubMessage` is GitHub's own `message` field; it is passed through 04's `redactSecrets` before use. The function returns an `ApiResponse<never>` and never includes headers, URLs or the request.

Sheet 07 maps the same `GitHubClientError` to a `PipelineStepError` with the same message text, through `githubErrorToApiResponse(...).error`. This keeps the wording in one place.

Required token permissions, quoted in Settings help (sheet 13) and in the messages above: fine-grained PAT with access to the selected repositories, **Pull requests: Read-only** and **Contents: Read-only**. Metadata: Read is implicit. Contents is also what HTTPS `git fetch` with the token needs in sheet 07.

### 5.7 Data written to `repositories`

| Column | Source |
|---|---|
| `name` | DTO `name` override, else `suggestedName`. Never changed by redetect. |
| `local_path` | `realpath` of the git toplevel. |
| `github_owner`, `github_repo` | §5.4 step 12, or null. |
| `default_branch` | §5.4 step 13. |
| `framework` | Always `react_vite`. |
| `package_manager` | §5.4 step 6. |
| `vite_config_path`, `tsconfig_path`, `entry_file_path` | Repo-relative or null. |
| `global_style_paths` | jsonb `string[]`, §5.1 specifier format, max `MAX_GLOBAL_STYLES` (20). |
| `last_detected_at` | `now()` at create and at each successful redetect. |

### 5.8 Constants (from `config-consts/app.config.ts`, owned by 02)

These names and values are part of 02 §6.7 (the single consolidated list, 00 §14.8). This sheet imports them from the
`config-consts` barrel and never redefines them; they are repeated here for reference only.

```ts
export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_USER_AGENT = "PRVision/0.1 (local developer tool)";
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
export const GITHUB_PR_LIST_PAGE_SIZE = 100;     // GitHub max per_page
export const GITHUB_PR_LIST_MAX_PAGES = 3;       // ≤ 300 open PRs listed
export const DETECTION_MAX_FILE_BYTES = 1_048_576;
export const MIN_VITE_MAJOR = 4;
export const MAX_GLOBAL_STYLES = 20;
export const BRANCH_LIST_MAX = 500;
```

None of these come from the environment. A different value is a change to 02 §6.7, requested under "Contract changes".

### 5.9 Routes (`routes/index.ts`) and composition

```ts
app.get("/api/repositories", requireLocal, repositoriesController.list.bind(repositoriesController));
app.post("/api/repositories", requireLocal, repositoriesController.create.bind(repositoriesController));
app.get("/api/repositories/:id", requireLocal, repositoriesController.get.bind(repositoriesController));
app.post("/api/repositories/:id/redetect", requireLocal, repositoriesController.redetect.bind(repositoriesController));
app.delete("/api/repositories/:id", requireLocal, repositoriesController.remove.bind(repositoriesController));
app.get("/api/repositories/:id/pull-requests", requireLocal, repositoriesController.listPullRequests.bind(repositoriesController));
app.get("/api/repositories/:id/branches", requireLocal, repositoriesController.listBranches.bind(repositoriesController));
```

`requireLocal` is the bound `LocalAuthMiddleware.requireLocal` handler carried by `RouteDependencies` (04 §5.3). Add `repositoriesController: RepositoriesController` to `RouteDependencies`, and construct it in `buildRouteDependencies()` in `app.ts` (04 §5.1) next to the other controllers.

## 6. Error handling and edge cases

| Situation | Response |
|---|---|
| `localPath` relative, empty, a URL, or containing NUL | 400 `validation_failed` (DTO) |
| `localPath` is `~/x` | Expanded to `$HOME/x`, then validated |
| Folder missing or a file | 400 `validation_failed` |
| Folder inside the PRVision data dir | 400 `validation_failed` |
| Folder that contains the PRVision data dir | 400 `validation_failed` |
| `package.json`, `index.html` or the entry file is a symlink pointing outside the root | Treated as missing (never read) |
| `localPath` is `~user/x` | 400 `validation_failed` (not expanded, not absolute) |
| Not a git repo | 400 `not_git_repo` |
| Sub-folder of a git repo (monorepo package) | 400 `not_git_repo`, message names the toplevel |
| Repo without commits | 400 `not_git_repo` |
| Registered through a symlink | Stored as the realpath; a second register through another spelling is a 409 duplicate |
| No or invalid package.json | 400 `unsupported_framework` |
| Workspace root without react/vite | 400 `unsupported_framework` (monorepo message) |
| Next.js | 400 `unsupported_framework` |
| React or Vite missing from deps | 400 `unsupported_framework` |
| Vite < 4 installed | 400 `unsupported_framework` |
| node_modules missing, a package not installed, or Yarn PnP | 400 `missing_node_modules` with the right install command |
| No vite config, tsconfig or entry file | Success with null fields and warnings |
| `index.html` script src escapes the root or points to a URL | Ignored; fall back to convention probing |
| Entry file has syntax errors | The TS parser still yields statements; imports before the error are found |
| Remote not on github.com, GHES, or ssh alias | Success with null owner/repo; PR routes return 400 `no_github_remote` |
| Remote URL with embedded credentials | Owner/repo parsed; URL never stored or logged |
| `origin/HEAD` unset | Fallback chain; warning logged |
| Path already registered (non-deleted) | 409 `conflict` |
| Path registered before but soft-deleted | New row inserted; old row untouched |
| Concurrent duplicate register | DB unique violation → 409 `conflict` |
| Redetect fails | Error returned; row unchanged |
| Redetect after the folder moved | 400 `validation_failed` or `not_git_repo`; the user removes and re-registers |
| Delete while a visualization is queued or running | 409 `conflict` |
| Visualization created between the active-run count and the soft delete | Accepted window; 07's worker fails it with "The repository for this visualization was removed." |
| Delete with finished visualizations | Repository soft-deleted; visualizations hidden by 07's join; artifacts kept |
| PR list without token | 400 `github_token_missing` |
| PR list with a bad, expired or revoked token | 400 `github_unauthorized` |
| Token not granted this repo (fine-grained 404) | 400 `github_unauthorized` |
| GitHub rate limit | 429 `github_rate_limited`, message with wait time |
| GitHub down or timeout (15 s) | 502 `github_unavailable` |
| More than 300 open PRs | First 300 by `updated desc` |
| Branch listing on a detached HEAD | `current: null` |
| More than 500 branches | Truncated; current and default always included |
| Folder deleted after registration (branches route) | 400 `not_git_repo` "Repository folder is missing…" |
| Stored token cannot be decrypted (secret key changed) | `SettingsStore` returns `unreadable` → 400 `github_token_missing` "…can no longer be decrypted…" |

## 7. Logging / console events

This sheet writes no `visualization_console_events`; those belong to visualizations (07). It uses pino via `createLogger(module)`:

Every call carries `event` (01 §5.8); the message is the constant text in the first column.

| Message | `event` | Level | Fields |
|---|---|---|---|
| Repository registered | `repositories.repository.registered` | info | `repositoryId, localPath, githubOwner, githubRepo, packageManager, warnings` |
| Detection rejected | `repositories.detection.rejected` | info | `localPath, errorReason` (the message is user-facing and safe) |
| Detection warnings on redetect | `repositories.detection.warnings` | info | `repositoryId, warnings` |
| Repository removed | `repositories.repository.removed` | info | `repositoryId` |
| GitHub call failed | `github.request.failed` | warn | `kind, httpStatus, owner, repo` (never the error object, headers or token) |
| GitCommandError in branches | `repositories.branches.git_failed` | warn | `repositoryId, exitCode, stderr` (first 500 chars) |
| Unhandled repositories controller error | `repositories.controller.unhandled` | error | `action, err` |

## 8. Security notes

- **No code execution during detection.** Vite configs, package scripts and `node_modules` are never evaluated. Only bounded file reads and read-only git commands run.
- **Token handling.** The PAT is decrypted only by `SettingsStore.readGithubToken()` (sheet 05). It lives in memory for one request, and is passed straight to `GitHubClient.fromToken`. It is never returned in a response, written to logs, or put in a URL or console event. The pino redaction paths from sheet 04 should include `*.token`, `*.authorization`, `*.headers.authorization`. As a second line of defence, this sheet never passes Octokit errors to the logger: it logs only `kind` and `httpStatus`.
- **Remote URLs** may embed credentials (`https://user:token@github.com/...`). `parseGithubRemoteUrl` returns only owner and repo; the raw URL is never persisted or logged.
- **Path safety.** realpath canonicalization, refusal of folders inside the data dir and of folders that contain it, every detection read confined to the realpath of the root (symlinks escaping the root are treated as missing), the entry-script `src` confined to the repo root, and style imports confined to the root.
- **Header injection.** `gitAuthHeaders` rejects tokens outside `[A-Za-z0-9_]`, so the env-carried git config value cannot contain a newline or a second header.
- **Local-only server.** The 127.0.0.1 bind and Host/Origin checks are sheet 04's job. The repositories API can read the file structure of any folder the OS user can read, so it must never be exposed beyond loopback.
- **PRs from forks** are flagged by `GitHubPullRequestDetail.isFork`. Sheet 07 warns before rendering them, because rendering executes the PR's code (Vite config, components) on the user's machine.

## 9. Tests

All tests use `node:test` + `node:assert/strict`, live in `tests/backend/repositories/`, and wrap service calls in `runWithAuthContext`. File-system fixtures are created by `helpers/detection-fixture.ts` under `fs.mkdtemp(path.join(os.tmpdir(), "prvision-detect-"))` and removed in `after`. Git is faked through the injected `git` dependency, so no `git` binary is needed.

`helpers/detection-fixture.ts`:

```ts
export interface FixtureSpec {
  packageJson?: Record<string, unknown> | string;          // string = raw (for invalid JSON)
  files?: Record<string, string>;                          // repo-relative path → content
  installed?: Record<string, string>;                      // package → version (writes node_modules/<pkg>/package.json)
  noNodeModules?: boolean;
}
export async function createDetectionFixture(spec: FixtureSpec): Promise<{ root: string; cleanup(): Promise<void> }>;
export function fakeGit(overrides: Partial<FakeGitState>): ProjectDetectionDependencies["git"];
// FakeGitState: toplevel, hasCommits, remotes: Record<name,url>, symbolicDefault, branches, current, dirty
```

`repository-create-dto.test.ts`:
- `accepts an absolute path`
- `expands ~/ to the home directory`
- `rejects a relative path`
- `rejects an empty string`
- `rejects file:// URLs`
- `rejects strings containing NUL`
- `trims name and rejects names over 200 chars`
- `rejects unknown properties (forbidNonWhitelisted)`
- `does not expand ~user/x and rejects it as not absolute`
- `rejects names with control characters`

`project-detection-helpers.test.ts`:
- `parseGithubRemoteUrl parses all supported forms` (table-driven over every row in §5.4 step 12)
- `parseGithubRemoteUrl rejects GHES, aliases, non-GitHub hosts and malformed paths`
- `findModuleScriptSrc picks the first type=module script regardless of attribute order and quotes`
- `findModuleScriptSrc ignores commented-out scripts and absolute URLs`
- `extractGlobalStyleImports returns root-relative paths for relative css/scss imports`
- `extractGlobalStyleImports keeps bare package stylesheet specifiers`
- `extractGlobalStyleImports ignores CSS modules, ?inline imports, named imports and dynamic imports`
- `extractGlobalStyleImports skips files that do not exist or escape the root`
- `extractGlobalStyleImports tolerates syntax errors after the imports`
- `detectPackageManager prefers the packageManager field, then pnpm > yarn > npm lockfiles, default npm`

`project-detection-service.test.ts`:
- `detects a standard Vite React TS project` (vite.config.ts, tsconfig.app.json, index.html → src/main.tsx, `import "./index.css"` → `/src/index.css`, pnpm)
- `fails validation_failed for a missing folder`
- `fails validation_failed for a folder inside the data dir`
- `fails validation_failed for a folder that contains the data dir`
- `treats a package.json symlink pointing outside the root as missing`
- `fails not_git_repo when rev-parse fails`
- `fails not_git_repo when the folder is a sub-folder of the toplevel`
- `fails not_git_repo when the repo has no commits`
- `fails unsupported_framework without package.json`
- `fails unsupported_framework for invalid package.json`
- `fails unsupported_framework for a workspace root without react/vite`
- `accepts a workspace root that declares react and vite, with a warning`
- `fails unsupported_framework for Next.js even when vite is present`
- `fails unsupported_framework when react-dom is missing`
- `fails unsupported_framework when Vite 3 is installed`
- `fails missing_node_modules without node_modules and names the right package manager`
- `fails missing_node_modules for Yarn PnP`
- `fails missing_node_modules when vite is declared but not installed`
- `discovers vite.config.js before vite.config.ts (Vite order)`
- `prefers tsconfig.app.json over tsconfig.json`
- `falls back to src/main.jsx when index.html has no module script`
- `returns null entry and no styles when nothing is found, with warnings`
- `uses upstream before origin for the GitHub remote`
- `returns null owner/repo for a GitLab remote, with a warning`
- `default branch: symbolic ref, then main/master, then current, then first branch`
- `uses the package.json name, else the folder basename`

`repositories-service.test.ts`:
- `create inserts detected fields and returns 201 with RepositoryView`
- `create uses the name override when provided`
- `create returns the detection failure status and error_reason unchanged`
- `create returns 409 conflict when a non-deleted row has the same path`
- `create inserts a new row when only a soft-deleted row has the same path`
- `create maps a unique-violation insert (409) to 409 conflict without the constraint text`
- `get returns 404 not_found for an unknown or deleted id`
- `list returns views ordered by name`
- `redetect updates detected fields and keeps the name`
- `redetect leaves the row unchanged when detection fails`
- `remove returns 409 conflict while a visualization is non-terminal`
- `remove counts active visualizations with Where.notIn(terminal statuses)`
- `remove soft-deletes only the repository row and returns 200 { id }`
- `remove does not modify visualizations of the repository`
- `listPullRequests returns 400 no_github_remote without owner/repo`
- `listPullRequests returns 400 github_token_missing without a token`
- `listPullRequests returns 400 github_token_missing with the decrypt message when the token is unreadable`
- `listPullRequests maps GitHubClientError unauthorized to 400 github_unauthorized, rate_limited to 429 github_rate_limited, unavailable to 502 github_unavailable`
- `listPullRequests returns PullRequestView[]`
- `listBranches returns branches, current, default and the isDirty flag`
- `listBranches includes the current and default branches after truncation`
- `listBranches returns 400 not_git_repo when the folder is missing`

`github-client.test.ts`, using a fake `GitHubRestPort`:
- `listOpenPullRequests stops after a short page`
- `listOpenPullRequests requests at most GITHUB_PR_LIST_MAX_PAGES pages`
- `maps a null user to "ghost" and undefined draft to false`
- `getPullRequest flags forks and deleted head repos as isFork`
- `maps 401 to unauthorized, 403 to forbidden, 404 to not_found, 422 to invalid`
- `maps 403 with x-ratelimit-remaining 0 to rate_limited with retryAfterSeconds from x-ratelimit-reset`
- `maps 429 with retry-after to rate_limited`
- `maps AbortError/TimeoutError and network errors to unavailable`
- `githubErrorToApiResponse never returns HTTP 401 or 403`
- `githubErrorToApiResponse distinguishes PR-not-found (404 not_found) from repo-not-found (400 github_unauthorized)`
- `verifyToken returns ok with the login on success`
- `verifyToken never throws: 401 → unauthorized, 403 → forbidden, rate limit → rate_limited, timeout → network`
- `verifyToken message never contains the token`
- `gitAuthHeaders returns Basic x-access-token then Bearer, both scoped to https://github.com/`
- `gitAuthHeaders throws for a token containing whitespace, ":" or a newline`

## 10. Acceptance criteria

- [ ] All seven routes are registered exactly as in 00 §9 and reachable behind the local auth middleware.
- [ ] `RepositoriesController` methods only validate, map and delegate. No `fs`, git, Drizzle or GitHub calls in the controller.
- [ ] `POST /api/repositories` with the fixture repo (`<dataDir>/fixtures/sample-react-app`) returns 201 with every `RepositoryView` field populated: `framework: "react_vite"`, an entry file, and at least one global style.
- [ ] Each failure in §6 returns the listed status and `error_reason` (verified by tests).
- [ ] `GET /api/repositories` returns `{ status: 200, data: RepositoryView[] }` (array, not paged), ordered by name.
- [ ] `POST /api/repositories` with `{ "localPath": "~/…" }` expands the home directory; the stored `localPath` is the realpath of the git toplevel.
- [ ] Registering the same folder twice returns 409 `conflict`. Deleting and then re-registering it returns 201 with a new id.
- [ ] `POST /:id/redetect` updates `lastDetectedAt` and detected fields but not `name`. A failed redetect leaves the row unchanged.
- [ ] `DELETE /:id` returns 409 `conflict` while visualizations are queued or running, and otherwise soft-deletes only the repository row and returns `200 { id }`.
- [ ] Every error response in this sheet carries an `error_reason` from 00 §14.2 (unit test iterates the error paths).
- [ ] `GET /:id/pull-requests` lists open PRs (most recently updated first, at most 300) with a valid token. Without a token it returns `github_token_missing`; with a revoked token it returns `github_unauthorized`.
- [ ] `GET /:id/branches` reports `workingTreeDirty: true` after `touch newfile` in the clone and `false` after removing it.
- [ ] No git process is spawned outside `GitClient`. No env var is read outside `config-consts`. No `any`. Explicit return types everywhere.
- [ ] grep finds no code path that logs the token, the raw remote URL or an Octokit error object.
- [ ] All tests in §9 pass under `npm run test:backend`.

## 11. Contract changes requested

Resolved:

1. `global_style_paths` value format — Resolved — 00 §14.3.
2. `error_reason` codes `github_rate_limited` (429) and `github_unavailable` (502) — Resolved — 00 §14.2 (used in §5.6.4).
3. Delete response `200 { id }` and `409 conflict` while non-terminal visualizations exist — Resolved — 00 §14.4.
4. Duplicate registration — Resolved — 00 §14.2: 409 now uses `error_reason: "conflict"` (was `validation_failed`).
5. GitClient methods used by this sheet — Resolved — 04 §9.5 defines every method in §3.1 with these exact signatures; auth headers come from `GitHubClient.gitAuthHeaders(token)` (00 §14.8).
6. `GitHubClient.verifyToken(token, { signal })` for sheet 05 — Resolved — 00 §14.8 (implemented in §5.6.3).
7. Runtime dependency `typescript` and Node engine — Resolved — 00 §14.1 (Node `>=22.12`; `typescript` is a runtime dependency).
8. `GET /api/repositories` returns an array and create takes `{ localPath, name? }` with `~/` expansion — Resolved — 00 §14.4.

Open:

9. **Artifact purge on repository delete (optional follow-up, 03 §9.7).** Repository delete leaves artifacts of its hidden visualizations on disk. If the lead wants them reclaimed, 03 §9.7 should allow 06 to call `ArtifactStore.removeVisualization(id)` (00 §14.12; `removeVisualizationArtifacts` is only a deprecated alias) for each of the repository's visualizations after the soft delete.
