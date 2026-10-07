/**
 * AngularRenderService (15 §5.7.10): the `rendering` stage for Angular repositories. Same contract as 10's
 * RenderService (inputs, results, persistence, statuses, repair, timeouts, cancellation, cleanup), but each render
 * group is built per side with the repository's own Angular application builder (an Architect child per side),
 * served by an in-process static host and rendered through 10's BrowserSession.
 *
 * Throws only PipelineStepError (stage "rendering"); per-component and per-side problems are captured in the
 * results and persisted. 10's render-service.ts is not modified (A13); its pure helpers are reused.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ANGULAR_CACHE_DIR_NAME,
  ANGULAR_MAX_BUILDS_PER_GROUP_SIDE,
  HARNESS_MAX_REPAIRS_PER_COMPONENT,
  RENDER_INFRA_RETRIES,
  RENDER_MAX_CAPTURE_HEIGHT_PX,
  RENDER_SETTLE_MAX_MS,
  RENDER_STAGE_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  RENDER_VIEWPORTS
} from "../../../../../config-consts";
import {
  PipelineStepError,
  type ComponentCandidate,
  type ComponentRenderResult,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type MockedModule,
  type PipelineContext,
  type RenderSideResult
} from "../../../../../types/visualization-pipeline";
import { DEFAULT_STATE_NAME } from "../../../../../types/harness-library";
import { ArtifactStore, createLogger, getErrorMessage, isPathInside, redactSecrets } from "../../../../../utilities";
import { angularAppRootRel, angularTargetImportPath } from "../../angular/angular-harness-prompts";
import { validateMockedModules } from "../../mock-rules";
import { ModuleResolver } from "../../module-resolver";
import {
  ArtifactStoreRenderAdapter,
  chooseAttempt,
  deriveRenderStatus,
  QueryHandlerRenderPersistence,
  type ComponentRenderPayload,
  type ComponentRenderPersistence,
  type ItemAttempt,
  type RenderArtifactStore,
  type RenderBrowserSession,
  type RenderComponentInput,
  type RepairHarnessFn,
  type SideAttempt
} from "../../render-service";
import { BrowserLaunchError, BrowserSession } from "../browser-session";
import {
  BUDGET_EXCEEDED_HEADLINE,
  errorSummaryLine,
  fileMissingHeadline,
  formatRenderError,
  headlineFor,
  isRepairableFailure,
  normalizeErrorText,
  truncateRenderError
} from "../render-errors";
import { buildRenderGroups, mockFingerprint } from "../render-groups";
import type { PageRenderOutcome, RenderFailureKind, RenderGroup, RenderSide, RenderWorkItem } from "../render-types";
import {
  isTwoSidedItem,
  repairedHarnessPayload,
  sideHarnessOf,
  sideHarnessResult,
  sideRenderError,
  sidesToRepair,
  twoSidedFingerprint,
  withRepairedSide
} from "../replaced-harness";
import {
  buildHarnessBuildOptions,
  globalInputFiles,
  mergedTargetOptions,
  normalizeWorkspacePath,
  readAngularProject,
  type AngularFileReplacement,
  type AngularProjectInfo
} from "./angular-build-options";
import {
  errorDiagnosticsOfFailedBuild,
  firstDiagnosticLine,
  formatAngularBuildError,
  runExclusionLoop,
  warningLines,
  type ExclusionBuildResult,
  type ExclusionLoopResult
} from "./angular-diagnostics";
import {
  AngularHarnessWorkspaceWriter,
  AngularTemplatesMissingError,
  assertAngularTemplatesPresent,
  installedPackageMajor,
  readAngularConfinedText,
  resolveAngularLayout,
  rewriteAngularTargetSpecifier,
  type AngularSideLayout
} from "./angular-harness-workspace";
import { AngularHostClient, type AngularBuildHost, type AngularBuildOutcome } from "./angular-host-client";
import {
  AngularStaticHost,
  STATIC_HOST_WARNINGS_MAX,
  type AngularStaticHostHandle,
  type AngularStaticHostOptions
} from "./angular-static-host";

const RENDER_STAGE = "rendering";
const HARNESS_NOTES_MAX_CHARS = 4_000;
const NOTES_TRUNCATION_SUFFIX = "… [truncated]";
const SIDES: readonly RenderSide[] = ["base", "head"];
const ANGULAR_JSON_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------------------------

/** Resolves a mock specifier to a repo-relative file on one side, or null. */
export type AngularMockResolver = (specifier: string, fromRepoPath: string) => string | null;

export interface AngularRenderServiceDependencies {
  repairHarness: RepairHarnessFn;
  createPersistence: (visualizationId: number) => ComponentRenderPersistence;
  artifactStore: RenderArtifactStore;
  workspaceWriter: AngularHarnessWorkspaceWriter;
  launchBrowser: () => Promise<RenderBrowserSession>;
  /** One Architect child per side and run (AngularHostClient). */
  createBuildHost: (side: RenderSide, workspaceRoot: string) => AngularBuildHost;
  startStaticHost: (options: AngularStaticHostOptions) => Promise<AngularStaticHostHandle>;
  /** Mock specifier resolution for one side (08's ModuleResolver over the app tsconfig). */
  createMockResolver: (ctx: PipelineContext, side: RenderSide, worktreeDir: string) => Promise<AngularMockResolver>;
  /** Absolute persistent Angular cache dir of a repository (`<dataDir>/cache/angular/<id>`). */
  cacheDirFor: (repositoryId: number) => string;
  now: () => number;
}

/** 08's ModuleResolver over the repository tsconfig (paths, baseUrl, relative). Never resolves into node_modules. */
export async function defaultAngularMockResolver(
  ctx: PipelineContext,
  side: RenderSide,
  worktreeDir: string
): Promise<AngularMockResolver> {
  const resolver = await ModuleResolver.create({
    side,
    rootDir: worktreeDir,
    tsconfigPath: ctx.repository.tsconfigPath,
    viteConfigPath: null,
    sourceRoot: ctx.repository.appRoot,
    warn: () => undefined
  });
  return (specifier, fromRepoPath) => {
    const resolution = resolver.resolveScript(specifier, fromRepoPath);
    return resolution.kind === "internal" ? resolution.path : null;
  };
}

/** Production wiring of every dependency except `repairHarness`. */
export function defaultAngularRenderDependencies(): Omit<AngularRenderServiceDependencies, "repairHarness"> {
  const store = new ArtifactStore();
  return {
    createPersistence: (visualizationId) => new QueryHandlerRenderPersistence(visualizationId),
    artifactStore: new ArtifactStoreRenderAdapter(store),
    workspaceWriter: new AngularHarnessWorkspaceWriter(),
    launchBrowser: () => BrowserSession.launch(),
    createBuildHost: (side, workspaceRoot) => new AngularHostClient(side, workspaceRoot),
    startStaticHost: (options) => AngularStaticHost.start(options),
    createMockResolver: defaultAngularMockResolver,
    cacheDirFor: (repositoryId) => path.join(store.dataDir, ANGULAR_CACHE_DIR_NAME, String(repositoryId)),
    now: () => Date.now()
  };
}

/** `mocks/<hash>.ts` name of a file replacement (10's mockHash formula: component file, specifier, source). */
export function angularMockHash(componentFile: string, specifier: string, source: string): string {
  return createHash("sha256").update(`${componentFile}\n${specifier}\n${source}`).digest("hex").slice(0, 16);
}

/** Renders the components of one Angular visualization (one AngularRenderRun per call). */
export class AngularRenderService {
  private readonly deps: AngularRenderServiceDependencies;

  constructor(
    overrides: Partial<AngularRenderServiceDependencies> & Pick<AngularRenderServiceDependencies, "repairHarness">
  ) {
    this.deps = { ...defaultAngularRenderDependencies(), ...overrides };
  }

  /**
   * Renders every present side of every input (10 §5.13.1 contract).
   *
   * @param ctx - Pipeline context of the visualization (framework "angular").
   * @param inputs - From buildRenderInputs (rank order).
   * @returns One result per finished component, in input order (components unfinished because of cancellation
   *   are omitted).
   * @throws PipelineStepError (stage "rendering") for fatal problems (browser, templates, workspace, persistence).
   */
  async renderAll(ctx: PipelineContext, inputs: RenderComponentInput[]): Promise<ComponentRenderResult[]> {
    const run = new AngularRenderRun(ctx, this.deps);
    return run.execute(inputs);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------------------------------------------

interface ResolvedMock {
  specifier: string;
  source: string;
  hash: string;
  /** Workspace-relative path of the replaced repository file. */
  replace: string;
}

interface AngularItem {
  work: RenderWorkItem;
  /** Accepted mocks resolved per side (dropped on a side where the specifier does not resolve). */
  sideMocks: Record<RenderSide, ResolvedMock[]>;
}

interface SideState {
  layout: AngularSideLayout;
  project: AngularProjectInfo | null;
  /** Set when the side cannot build at all (project missing, Architect not loadable). */
  broken: string | null;
  host: AngularBuildHost | null;
  resolver: AngularMockResolver | null;
  tailwindMajor: 3 | 4 | null;
  globalStylesExpected: boolean;
  sideWideFiles: Set<string>;
  announced: boolean;
  warningsForwarded: boolean;
  sideWideReported: boolean;
}

type ItemSlot =
  | { state: "ready"; host: AngularStaticHostHandle; counter: { rendered: number; stylesChecked: boolean } }
  | { state: "failed"; attempt: SideAttempt }
  | { state: "not_needed" };

interface SideBuild {
  slots: Map<number, ItemSlot>;
  hosts: AngularStaticHostHandle[];
  cancelled: boolean;
}

interface RepairEntry {
  item: AngularItem;
  attempt: ItemAttempt;
}

class RenderPersistError extends Error {
  override readonly name = "RenderPersistError";
}

function capNotes(text: string): string {
  return text.length > HARNESS_NOTES_MAX_CHARS
    ? `${text.slice(0, HARNESS_NOTES_MAX_CHARS - NOTES_TRUNCATION_SUFFIX.length)}${NOTES_TRUNCATION_SUFFIX}`
    : text;
}

function otherSide(side: RenderSide): RenderSide {
  return side === "head" ? "base" : "head";
}

function failedSideResult(
  side: RenderSide,
  failureKind: RenderFailureKind,
  error: string,
  durationMs = 0,
  consoleErrors: string[] = []
): RenderSideResult {
  return { side, ok: false, imagePath: null, width: null, height: null, error, consoleErrors, durationMs, failureKind };
}

function describeSide(side: SideAttempt | null, label: RenderSide): string | null {
  if (side === null) {
    return null;
  }
  return side.result.ok
    ? `${label} ok (${String(side.result.width)}×${String(side.result.height)})`
    : `${label} failed (${side.kind ?? "error"})`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

class AngularRenderRun {
  private readonly log: ReturnType<typeof createLogger>;
  private readonly persistence: ComponentRenderPersistence;
  private deadline = 0;
  private cancelled = false;
  private budgetExceeded = false;
  private readonly results = new Map<number, ComponentRenderResult>();
  private readonly payloads = new Map<number, ComponentRenderPayload>();
  private session: RenderBrowserSession | null = null;
  private relaunchUsed = false;
  private relaunching: Promise<boolean> | null = null;
  private readonly liveStaticHosts = new Set<AngularStaticHostHandle>();
  private sides: Record<RenderSide, SideState> | null = null;
  private readonly tempImages = new Set<string>();
  private repairQueue: RepairEntry[] = [];
  private stripPaths: string[] = [];
  private cacheDir = "";
  private cacheWarned = false;

  constructor(
    private readonly ctx: PipelineContext,
    private readonly deps: AngularRenderServiceDependencies
  ) {
    this.log = createLogger("render", { visualizationId: ctx.visualizationId });
    this.persistence = deps.createPersistence(ctx.visualizationId);
  }

  async execute(inputs: RenderComponentInput[]): Promise<ComponentRenderResult[]> {
    const startedAt = this.deps.now();
    this.deadline = startedAt + RENDER_STAGE_TIMEOUT_MS;
    const onAbort = (): void => {
      this.abortInFlight().catch((error: unknown) => {
        this.log.warn({ event: "render.cleanup.failed", err: error }, "Aborting in-flight renders failed");
      });
    };
    try {
      // 1. Fatal checks: templates, project name, workspace on at least one side.
      await assertAngularTemplatesPresent(this.deps.workspaceWriter.templatesDir);
      const sides = await this.resolveSides();
      this.sides = sides;
      // 2. Plan.
      const items = await this.planItems(inputs, sides);
      if (items.length > 0) {
        // 3. Workspaces.
        await this.prepareWorkspaces(sides, items);
        const groups = buildRenderGroups(items.map((item) => item.work));
        this.log.info(
          { event: "render.run.started", components: items.length, groups: groups.length, framework: "angular" },
          "Render run started"
        );
        await this.console(
          "info",
          `Rendering ${String(items.length)} component(s) in ${String(groups.length)} render group(s).`
        );
        if (this.ctx.workspace.dependencyDrift) {
          await this.console(
            "warn",
            "Dependencies differ between base and head, but both sides render with the repository's installed node_modules. Dependency changes are not reflected in screenshots."
          );
        }
        // 4. Browser (fatal on failure).
        this.session = await this.launchBrowserOrThrow();
        this.ctx.signal.addEventListener("abort", onAbort, { once: true });
        const byId = new Map(items.map((item) => [item.work.candidate.componentId, item] as const));
        // 5. Groups.
        for (const group of groups) {
          if (await this.shouldStop()) {
            break;
          }
          await this.renderGroup(group, byId, group.key, null);
        }
        // 6. Repair rounds.
        await this.runRepairRounds(byId);
        // 7. Budget exceeded → remaining items failed (persisted). Cancelled → remaining items untouched.
        await this.failUnfinishedIfBudgetExceeded(items);
      }
    } catch (error) {
      throw this.toStepError(error);
    } finally {
      this.ctx.signal.removeEventListener("abort", onAbort);
      await this.cleanup();
    }
    await this.console("info", this.summaryLine(startedAt));
    this.log.info(
      {
        event: "render.run.finished",
        components: inputs.length,
        durationMs: this.deps.now() - startedAt,
        framework: "angular",
        ...this.counts()
      },
      "Render run finished"
    );
    return this.orderedResults(inputs);
  }

  // ----- fatal errors and console -----

  private toStepError(error: unknown): PipelineStepError {
    let stepError: PipelineStepError;
    if (error instanceof PipelineStepError) {
      stepError = error;
    } else if (error instanceof RenderPersistError) {
      stepError = new PipelineStepError(RENDER_STAGE, "Could not save render results.", {
        code: "RENDER_PERSIST_FAILED",
        cause: error.cause
      });
    } else if (error instanceof AngularTemplatesMissingError) {
      stepError = new PipelineStepError(RENDER_STAGE, error.message, {
        code: "RENDER_TEMPLATES_MISSING",
        cause: error
      });
    } else if (error instanceof BrowserLaunchError) {
      stepError = new PipelineStepError(RENDER_STAGE, error.userMessage, {
        code: "RENDER_BROWSER_LAUNCH_FAILED",
        detail: error.detail,
        cause: error
      });
    } else {
      stepError = new PipelineStepError(RENDER_STAGE, "Rendering failed unexpectedly.", {
        code: "RENDER_UNEXPECTED",
        cause: error
      });
    }
    this.log.error(
      { event: "render.stage.fatal", userMessage: stepError.userMessage, err: stepError.cause ?? stepError },
      "Render stage failed"
    );
    return stepError;
  }

  private async console(level: "info" | "warn" | "error", message: string): Promise<void> {
    try {
      await this.ctx.console[level](RENDER_STAGE, redactSecrets(message));
    } catch (error) {
      this.log.warn({ event: "render.console.failed", err: error }, "Writing a console event failed");
    }
  }

  private async shouldStop(): Promise<boolean> {
    if (this.cancelled || this.ctx.signal.aborted) {
      this.cancelled = true;
      return true;
    }
    let cancelledFlag = false;
    try {
      cancelledFlag = await this.ctx.isCancelled();
    } catch (error) {
      this.log.warn({ event: "render.cancel_check.failed", err: error }, "Cancellation check failed");
    }
    if (cancelledFlag) {
      this.cancelled = true;
      return true;
    }
    if (this.deps.now() >= this.deadline) {
      this.budgetExceeded = true;
      return true;
    }
    return false;
  }

  // ----- sides -----

  private async resolveSides(): Promise<Record<RenderSide, SideState>> {
    const projectName = this.ctx.repository.angularProject;
    if (projectName === null || projectName === "") {
      throw new PipelineStepError(RENDER_STAGE, "The repository has no Angular project configured; re-detect it.", {
        code: "ANGULAR_PROJECT_MISSING"
      });
    }
    this.cacheDir = this.deps.cacheDirFor(this.ctx.repository.id);
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (error) {
      this.log.warn({ event: "render.angular.cache_warning", err: error }, "Angular cache dir could not be created");
    }
    const build = async (side: RenderSide, worktreeDir: string): Promise<SideState> => {
      let layout: AngularSideLayout;
      try {
        layout = resolveAngularLayout(side, worktreeDir, this.ctx.repository.appRoot);
      } catch (error) {
        throw new PipelineStepError(RENDER_STAGE, `Could not write render harness files: ${getErrorMessage(error)}`, {
          code: "RENDER_HARNESS_WRITE_FAILED",
          cause: error
        });
      }
      const state: SideState = {
        layout,
        project: null,
        broken: null,
        host: null,
        resolver: null,
        tailwindMajor: null,
        globalStylesExpected: false,
        sideWideFiles: new Set(["angular.json"]),
        announced: false,
        warningsForwarded: false,
        sideWideReported: false
      };
      const text = await readAngularConfinedText(
        layout.worktreeDir,
        path.join(layout.workspaceRoot, "angular.json"),
        ANGULAR_JSON_MAX_BYTES
      );
      if (text === null) {
        state.broken = `angular.json not found in ${this.ctx.repository.appRoot} on the ${side} side`;
        return state;
      }
      try {
        state.project = readAngularProject(text, projectName);
      } catch (error) {
        state.broken = `${getErrorMessage(error)} on the ${side} side`;
        return state;
      }
      const options = mergedTargetOptions(state.project.build, this.ctx.repository.angularBuildConfiguration);
      for (const file of globalInputFiles(options)) {
        state.sideWideFiles.add(file);
      }
      state.globalStylesExpected = Array.isArray(options.styles) && options.styles.length > 0;
      const tailwind = await installedPackageMajor(layout.workspaceRoot, "tailwindcss");
      state.tailwindMajor = tailwind === 3 || tailwind === 4 ? tailwind : null;
      return state;
    };
    const [base, head] = await Promise.all([
      build("base", this.ctx.workspace.baseDir),
      build("head", this.ctx.workspace.headDir)
    ]);
    if (base.broken !== null && head.broken !== null) {
      throw new PipelineStepError(RENDER_STAGE, `The Angular workspace could not be read: ${head.broken}.`, {
        code: "ANGULAR_WORKSPACE_UNREADABLE",
        detail: base.broken
      });
    }
    this.stripPaths = [
      base.layout.worktreeDir,
      head.layout.worktreeDir,
      this.ctx.repository.localPath,
      ...(await Promise.all([realpathOrNull(base.layout.worktreeDir), realpathOrNull(head.layout.worktreeDir)])).filter(
        (entry): entry is string => entry !== null
      )
    ];
    return { base, head };
  }

  // ----- planning -----

  private async planItems(
    inputs: readonly RenderComponentInput[],
    sides: Record<RenderSide, SideState>
  ): Promise<AngularItem[]> {
    const items: AngularItem[] = [];
    const seen = new Set<number>();
    for (const input of inputs) {
      const { candidate, harness } = input;
      if (seen.has(candidate.componentId)) {
        this.log.warn(
          { event: "render.plan.duplicate", componentId: candidate.componentId },
          "Duplicate component in render inputs ignored"
        );
        continue;
      }
      seen.add(candidate.componentId);
      const paths = { base: input.basePath, head: candidate.changeKind === "removed" ? null : candidate.filePath };
      const present = { base: paths.base !== null, head: paths.head !== null };
      if (!present.base && !present.head) {
        await this.console("warn", `${candidate.displayName}: component file not found on either side.`);
        await this.finalizeImmediate(
          candidate.componentId,
          {
            renderStatus: "failed",
            baseImagePath: null,
            headImagePath: null,
            imageWidth: null,
            imageHeight: null,
            baseError: "Component file not found on either side.",
            headError: "Component file not found on either side."
          },
          { componentId: candidate.componentId, base: null, head: null, states: [] }
        );
        continue;
      }
      const plannedFailures: RenderWorkItem["plannedFailures"] = { base: null, head: null };
      for (const side of SIDES) {
        const sidePath = paths[side];
        if (sidePath === null) {
          continue;
        }
        const layout = sides[side].layout;
        const absolute = path.join(layout.worktreeDir, sidePath);
        if (!isPathInside(layout.worktreeDir, absolute) || !(await fileExists(absolute))) {
          plannedFailures[side] = {
            kind: "file_missing",
            error: this.formatPlanned("file_missing", fileMissingHeadline(sidePath, side))
          };
          await this.console("warn", `${candidate.displayName}: ${fileMissingHeadline(sidePath, side)}`);
          continue;
        }
        const broken = sides[side].broken;
        if (broken !== null) {
          plannedFailures[side] = { kind: "vite_unavailable", error: this.formatPlanned("vite_unavailable", broken) };
        }
      }
      const item: AngularItem = {
        work: {
          candidate,
          harness,
          paths,
          acceptedMocks: [],
          fingerprint: "none",
          sides: present,
          primarySide: present.head ? "head" : "base",
          repairsUsed: 0,
          mockLabels: new Map(),
          plannedFailures
        },
        sideMocks: { base: [], head: [] }
      };
      await this.applyHarness(item, harness, sides);
      const presentSides = SIDES.filter((side) => present[side]);
      if (presentSides.every((side) => plannedFailures[side] !== null)) {
        const attempt: ItemAttempt = {
          attemptNo: 0,
          harness,
          base: this.plannedAttempt(item.work, "base"),
          head: this.plannedAttempt(item.work, "head")
        };
        await this.finalizeAttempt(item, attempt, "original");
        continue;
      }
      items.push(item);
    }
    return items;
  }

  /**
   * Sets the harness, accepted mocks (resolved per side), fingerprint and mock labels of an item. A replaced row
   * (00 §17) takes each side's mocks from that side's own harness.
   */
  private async applyHarness(
    item: AngularItem,
    harness: HarnessGenerationResult,
    sides: Record<RenderSide, SideState>
  ): Promise<void> {
    const work = item.work;
    work.harness = harness;
    const twoSided = isTwoSidedItem(work);
    const accepted: Record<RenderSide, MockedModule[]> = { base: [], head: [] };
    for (const side of twoSided ? SIDES : (["head"] as const)) {
      const validation = validateMockedModules(sideHarnessOf(harness, side).mockedModules);
      for (const rejection of validation.rejected) {
        await this.console(
          "warn",
          `File replacement "${rejection.specifier}" for ${work.candidate.displayName} was ignored: ${rejection.reason}.`
        );
      }
      accepted[side] = validation.accepted;
    }
    work.acceptedMocks = accepted.head;
    if (twoSided) {
      work.baseAcceptedMocks = accepted.base;
      work.fingerprint = twoSidedFingerprint(
        work.paths.base ?? work.candidate.filePath,
        accepted.base,
        work.paths.head ?? work.candidate.filePath,
        accepted.head
      );
    } else {
      accepted.base = accepted.head;
      work.fingerprint = mockFingerprint(
        work.paths.head ?? work.paths.base ?? work.candidate.filePath,
        work.acceptedMocks
      );
    }
    work.mockLabels = new Map();
    item.sideMocks = { base: [], head: [] };
    for (const side of SIDES) {
      const sidePath = work.paths[side];
      if (sidePath === null || accepted[side].length === 0) {
        continue;
      }
      const state = sides[side];
      const resolver = await this.resolverFor(state);
      for (const mock of accepted[side]) {
        const resolved: string | null = resolver === null ? null : resolver(mock.specifier, sidePath);
        const appRoot = this.ctx.repository.appRoot;
        const insideApp = resolved !== null && (appRoot === "." || resolved.startsWith(`${appRoot}/`));
        if (resolved === null || !resolved.endsWith(".ts") || !insideApp || resolved === sidePath) {
          await this.console(
            "warn",
            `${work.candidate.displayName}: file replacement "${mock.specifier}" does not resolve to a TypeScript file of the app on the ${side} side; it is not applied there.`
          );
          continue;
        }
        const componentFile = path.join(state.layout.worktreeDir, sidePath);
        const hash = angularMockHash(componentFile, mock.specifier, mock.source);
        const replace = normalizeWorkspacePath(
          toPosix(path.relative(state.layout.workspaceRoot, path.join(state.layout.worktreeDir, resolved)))
        );
        item.sideMocks[side].push({ specifier: mock.specifier, source: mock.source, hash, replace });
        work.mockLabels.set(hash, mock.specifier);
      }
    }
  }

  private async resolverFor(state: SideState): Promise<AngularMockResolver | null> {
    if (state.resolver !== null) {
      return state.resolver;
    }
    try {
      state.resolver = await this.deps.createMockResolver(this.ctx, state.layout.side, state.layout.worktreeDir);
    } catch (error) {
      this.log.warn({ event: "render.angular.mock_resolver.failed", err: error }, "Mock resolver could not be created");
      return null;
    }
    return state.resolver;
  }

  private formatPlanned(kind: RenderFailureKind, headline: string): string {
    return formatRenderError({
      kind,
      headline: headlineFor(kind, headline),
      stack: null,
      componentStack: null,
      serverErrors: [],
      consoleErrors: [],
      viteOrigin: null,
      mockLabels: new Map(),
      stripPaths: this.stripPaths
    });
  }

  private sanitize(error: string): string {
    return truncateRenderError(redactSecrets(normalizeErrorText(error, null, this.stripPaths)));
  }

  private plannedAttempt(item: RenderWorkItem, side: RenderSide): SideAttempt | null {
    if (!item.sides[side]) {
      return null;
    }
    const planned = item.plannedFailures[side];
    if (planned === null) {
      return null;
    }
    return { result: failedSideResult(side, planned.kind, planned.error), kind: planned.kind, tempImagePath: null };
  }

  // ----- workspaces -----

  private async prepareWorkspaces(sides: Record<RenderSide, SideState>, items: readonly AngularItem[]): Promise<void> {
    try {
      for (const side of SIDES) {
        const state = sides[side];
        if (state.project === null) {
          continue;
        }
        const prepared = await this.deps.workspaceWriter.prepareSide(
          state.layout,
          state.project,
          this.ctx.repository.angularBuildConfiguration
        );
        for (const file of prepared.tsconfigFiles) {
          state.sideWideFiles.add(file);
        }
        for (const warning of prepared.warnings) {
          await this.console("warn", warning);
        }
      }
      for (const item of items) {
        await this.writeItemFiles(item, sides);
      }
    } catch (error) {
      if (error instanceof PipelineStepError) {
        throw error;
      }
      throw new PipelineStepError(RENDER_STAGE, `Could not write render harness files: ${getErrorMessage(error)}`, {
        code: "RENDER_HARNESS_WRITE_FAILED",
        cause: error
      });
    }
  }

  /** Writes components/<id>.ts and the item's mocks on every present side that can build. */
  private async writeItemFiles(item: AngularItem, sides: Record<RenderSide, SideState>): Promise<void> {
    const work = item.work;
    for (const side of SIDES) {
      const planned = work.plannedFailures[side];
      if (!work.sides[side] || planned?.kind === "file_missing" || planned?.kind === "vite_unavailable") {
        continue;
      }
      const layout = sides[side].layout;
      // 00 §17: a replaced row writes each side's own harness, which already imports that side's target
      let source = sideHarnessOf(work.harness, side).harnessSource;
      const basePath = work.paths.base;
      const headPath = work.paths.head;
      if (!isTwoSidedItem(work) && side === "base" && basePath !== null && headPath !== null && basePath !== headPath) {
        const appRoot = angularAppRootRel(this.ctx.repository.appRoot);
        try {
          source = rewriteAngularTargetSpecifier(
            source,
            angularTargetImportPath(headPath, appRoot),
            angularTargetImportPath(basePath, appRoot)
          );
          work.plannedFailures.base = null;
        } catch (error) {
          work.plannedFailures.base = {
            kind: "module_load",
            error: this.formatPlanned("module_load", getErrorMessage(error))
          };
          continue;
        }
      }
      await this.deps.workspaceWriter.writeComponentHarness(layout, work.candidate.componentId, source);
      for (const mock of item.sideMocks[side]) {
        await this.deps.workspaceWriter.writeMock(layout, mock.hash, mock.source);
      }
    }
  }

  // ----- browser -----

  private async launchBrowserOrThrow(): Promise<RenderBrowserSession> {
    try {
      return await this.deps.launchBrowser();
    } catch (error) {
      if (error instanceof BrowserLaunchError) {
        throw error;
      }
      throw new BrowserLaunchError(`Chromium could not be started: ${getErrorMessage(error)}`, getErrorMessage(error));
    }
  }

  private async ensureBrowser(): Promise<boolean> {
    if (this.session?.isConnected() === true) {
      return true;
    }
    if (this.relaunching !== null) {
      return this.relaunching;
    }
    if (this.relaunchUsed) {
      return false;
    }
    this.relaunchUsed = true;
    this.relaunching = (async (): Promise<boolean> => {
      await this.console("warn", "Chromium disconnected; restarting the browser.");
      this.log.warn({ event: "render.browser.relaunched" }, "Relaunching Chromium");
      await settle(this.session?.close(), this.log);
      try {
        this.session = await this.deps.launchBrowser();
        return true;
      } catch (error) {
        this.log.warn({ event: "render.browser.relaunched", err: error }, "Relaunching Chromium failed");
        return false;
      }
    })();
    try {
      return await this.relaunching;
    } finally {
      this.relaunching = null;
    }
  }

  // ----- groups: build per side, then render -----

  /**
   * Builds the group on both sides (in parallel), then renders its items in rank order.
   *
   * @param buildKey - `<groupKey>` for the first pass, `<groupKey>-r<n>` for repair rebuilds.
   * @param originals - For repair groups: the attempts to compare with (null for the first pass).
   */
  private async renderGroup(
    group: RenderGroup,
    byId: ReadonlyMap<number, AngularItem>,
    buildKey: string,
    originals: ReadonlyMap<number, RepairEntry> | null
  ): Promise<void> {
    const sides = this.requireSides();
    const items = group.items
      .map((work) => byId.get(work.candidate.componentId))
      .filter((item): item is AngularItem => item !== undefined);
    const [base, head] = await Promise.all([
      this.buildSide("base", group, items, buildKey, sides.base),
      this.buildSide("head", group, items, buildKey, sides.head)
    ]);
    try {
      if (base.cancelled || head.cancelled) {
        this.cancelled = true;
        return;
      }
      for (const item of items) {
        if (await this.shouldStop()) {
          return;
        }
        const componentId = item.work.candidate.componentId;
        const attempt = await this.renderItem(
          item,
          {
            base: base.slots.get(componentId) ?? { state: "not_needed" },
            head: head.slots.get(componentId) ?? { state: "not_needed" }
          },
          item.work.repairsUsed
        );
        if (attempt === null) {
          return;
        }
        if (originals === null) {
          await this.finalizeAttempt(item, attempt, "original");
          if (this.needsRepair(item.work, attempt)) {
            this.repairQueue.push({ item, attempt });
          }
          continue;
        }
        await this.keepBetterAttempt(item, attempt, originals);
      }
    } finally {
      await Promise.all([...base.hosts, ...head.hosts].map((host) => this.stopStaticHost(host)));
    }
  }

  private requireSides(): Record<RenderSide, SideState> {
    if (this.sides === null) {
      throw new Error("Invariant: sides are resolved before rendering");
    }
    return this.sides;
  }

  /** Runs the exclusion/bisect build loop for one side of a group and starts a static host per successful build. */
  private async buildSide(
    side: RenderSide,
    group: RenderGroup,
    items: readonly AngularItem[],
    buildKey: string,
    state: SideState
  ): Promise<SideBuild> {
    const result: SideBuild = { slots: new Map(), hosts: [], cancelled: false };
    const needed = items.filter((item) => item.work.sides[side] && item.work.plannedFailures[side] === null);
    for (const item of items) {
      const planned = item.work.plannedFailures[side];
      if (item.work.sides[side] && planned !== null) {
        result.slots.set(item.work.candidate.componentId, {
          state: "failed",
          attempt: {
            result: failedSideResult(side, planned.kind, planned.error),
            kind: planned.kind,
            tempImagePath: null
          }
        });
      }
    }
    if (needed.length === 0) {
      return result;
    }
    const failAll = (kind: RenderFailureKind, headline: string): SideBuild => {
      for (const item of needed) {
        result.slots.set(item.work.candidate.componentId, {
          state: "failed",
          attempt: this.sideFailure(side, kind, headline)
        });
      }
      return result;
    };
    if (state.broken !== null || state.project === null) {
      return failAll("vite_unavailable", state.broken ?? "The Angular workspace is not available on this side.");
    }
    const project = state.project;
    state.host ??= this.deps.createBuildHost(side, state.layout.workspaceRoot);
    const host = state.host;
    const mockOwners = new Map<string, number[]>();
    for (const item of needed) {
      for (const mock of item.sideMocks[side]) {
        const owners = mockOwners.get(mock.hash) ?? [];
        owners.push(item.work.candidate.componentId);
        mockOwners.set(mock.hash, owners);
      }
    }
    const byId = new Map(needed.map((item) => [item.work.candidate.componentId, item] as const));
    const outputs = new Map<number, AngularBuildOutcome & { status: "success" }>();
    const targetFiles = new Map<number, string>();
    for (const item of needed) {
      const sidePath = item.work.paths[side];
      if (sidePath !== null) {
        const absolute = path.join(state.layout.worktreeDir, sidePath);
        targetFiles.set(item.work.candidate.componentId, toPosix(path.relative(state.layout.workspaceRoot, absolute)));
      }
    }
    const loop: ExclusionLoopResult = await runExclusionLoop({
      side,
      componentIds: needed.map((item) => item.work.candidate.componentId),
      budget: ANGULAR_MAX_BUILDS_PER_GROUP_SIDE,
      mockOwners,
      sideWideFiles: state.sideWideFiles,
      targetFiles,
      build: async (componentIds, buildNo): Promise<ExclusionBuildResult> => {
        const key = buildNo === 1 ? buildKey : `${buildKey}-x${String(buildNo)}`;
        const outcome = await this.runBuild(side, state, project, host, key, componentIds, byId);
        if (outcome.status === "success") {
          for (const id of componentIds) {
            outputs.set(id, outcome);
          }
        }
        return this.toExclusionResult(side, state, outcome);
      }
    });
    if (loop.cancelled) {
      result.cancelled = true;
      return result;
    }
    if (loop.sideWide !== null && !state.sideWideReported) {
      state.sideWideReported = true;
      await this.console(
        "error",
        `The Angular build failed on the ${side} side: ${firstDiagnosticLine(loop.sideWide.diagnostics)}`
      );
    }
    for (const exclusion of loop.exclusions) {
      this.log.warn(
        {
          event: "render.angular.exclusion",
          side,
          buildKey,
          buildNo: exclusion.buildNo,
          excluded: exclusion.componentIds,
          reason: exclusion.reason
        },
        "Angular build items excluded"
      );
      if (exclusion.reason === "attributed") {
        await this.console(
          "warn",
          `Angular build on the ${side} side failed for ${String(exclusion.componentIds.length)} harness(es); rebuilding without them.`
        );
      }
    }
    for (const [componentId, failure] of loop.failures) {
      result.slots.set(componentId, {
        state: "failed",
        attempt: {
          result: failedSideResult(
            side,
            failure.kind,
            formatAngularBuildError(failure.kind, failure.headline, failure.diagnostics, this.stripPaths)
          ),
          kind: failure.kind,
          tempImagePath: null
        }
      });
    }
    for (const build of loop.builds) {
      const outcome = outputs.get(build.componentIds[0] ?? -1);
      let staticHost: AngularStaticHostHandle | null = null;
      let failure: string | null = null;
      try {
        staticHost = await this.deps.startStaticHost({
          side,
          groupKey: group.key,
          distDir: build.outputDir,
          buildLogs: outcome?.logs ?? [],
          tailwindMajor: state.tailwindMajor,
          warnings: warningLines(outcome?.logs ?? [], STATIC_HOST_WARNINGS_MAX)
        });
        this.liveStaticHosts.add(staticHost);
        result.hosts.push(staticHost);
        this.log.debug(
          { event: "render.angular.static_host", side, origin: staticHost.origin, groupKey: group.key },
          "Static host started"
        );
      } catch (error) {
        failure = `The static host for the ${side} side could not start: ${getErrorMessage(error)}`;
        this.log.warn({ event: "render.angular.static_host", side, err: error }, "Static host failed to start");
      }
      if (staticHost !== null && !state.warningsForwarded) {
        state.warningsForwarded = true;
        for (const warning of staticHost.warnings) {
          await this.console("info", `Angular build warning (${side}): ${warning}`);
        }
      }
      const counter = { rendered: 0, stylesChecked: false };
      for (const id of build.componentIds) {
        result.slots.set(
          id,
          staticHost === null
            ? { state: "failed", attempt: this.sideFailure(side, "vite_unavailable", failure ?? "Static host failed.") }
            : { state: "ready", host: staticHost, counter }
        );
      }
    }
    return result;
  }

  private async runBuild(
    side: RenderSide,
    state: SideState,
    project: AngularProjectInfo,
    host: AngularBuildHost,
    buildKey: string,
    componentIds: readonly number[],
    byId: ReadonlyMap<number, AngularItem>
  ): Promise<AngularBuildOutcome> {
    const replacements: AngularFileReplacement[] = [];
    const replaced = new Set<string>();
    for (const id of componentIds) {
      for (const mock of byId.get(id)?.sideMocks[side] ?? []) {
        if (replaced.has(mock.replace)) {
          continue; // same file replaced twice within a group: identical by fingerprint; first wins otherwise
        }
        replaced.add(mock.replace);
        replacements.push({ replace: mock.replace, with: `.prvision-harness/mocks/${mock.hash}.ts` });
      }
    }
    try {
      await this.deps.workspaceWriter.writeRegistry(state.layout, componentIds);
    } catch (error) {
      return {
        status: "unavailable",
        sticky: false,
        message: `Could not write the harness registry: ${getErrorMessage(error)}`,
        durationMs: 0,
        logs: []
      };
    }
    const built = buildHarnessBuildOptions({
      target: project.build,
      configuration: this.ctx.repository.angularBuildConfiguration,
      buildKey,
      mockReplacements: replacements,
      cacheDir: this.cacheDir
    });
    const outcome = await host.build(
      {
        buildKey,
        projectName: project.name,
        builderName: built.builderName,
        options: built.options,
        projectExtensions: built.projectExtensions
      },
      this.ctx.signal
    );
    this.log.info(
      {
        event: "render.angular.build",
        side,
        buildKey,
        items: componentIds.length,
        success: outcome.status === "success",
        status: outcome.status,
        durationMs: outcome.durationMs,
        diagnostics: outcome.status === "failed" ? errorDiagnosticsOfFailedBuild(outcome.logs).length : 0
      },
      "Angular build finished"
    );
    if (outcome.logs.some((entry) => entry.level === "warn" && /\bcache\b/i.test(entry.message)) && !this.cacheWarned) {
      this.cacheWarned = true;
      this.log.warn({ event: "render.angular.cache_warning", side }, "Angular build cache warning");
    }
    if (outcome.status === "success") {
      const seconds = (outcome.durationMs / 1000).toFixed(1);
      if (!state.announced) {
        state.announced = true;
        const versions = host.versions();
        await this.console(
          "info",
          `Angular ${versions?.core ?? "unknown"} build (${project.build.builder}) for the ${side} side: ${String(
            componentIds.length
          )} component(s) in ${seconds} s.`
        );
      } else {
        this.log.debug({ event: "render.angular.build", side, buildKey, seconds }, "Angular build ready");
      }
    }
    return outcome;
  }

  private async toExclusionResult(
    side: RenderSide,
    state: SideState,
    outcome: AngularBuildOutcome
  ): Promise<ExclusionBuildResult> {
    switch (outcome.status) {
      case "success":
        return { status: "success", outputDir: outcome.outputDir };
      case "failed":
        return { status: "failed", diagnostics: errorDiagnosticsOfFailedBuild(outcome.logs) };
      case "cancelled":
        return { status: "cancelled" };
      case "timeout":
        return { status: "timeout", message: outcome.message };
      case "unavailable": {
        if (outcome.sticky) {
          const message = `Could not load the Angular build tools from ${this.ctx.repository.appRoot}: ${outcome.message}`;
          state.broken = message;
          await this.console("error", `${message} (${side} side)`);
          return { status: "unavailable", message };
        }
        await this.console("warn", `Angular build on the ${side} side: ${outcome.message}`);
        return { status: "unavailable", message: outcome.message };
      }
    }
  }

  private async stopStaticHost(host: AngularStaticHostHandle): Promise<void> {
    await settle(host.stop(), this.log);
    this.liveStaticHosts.delete(host);
  }

  // ----- rendering one item -----

  private async renderItem(
    item: AngularItem,
    slots: { base: ItemSlot; head: ItemSlot },
    attemptNo: number
  ): Promise<ItemAttempt | null> {
    const work = item.work;
    const [base, head] = await Promise.all([
      work.sides.base ? this.renderSide(work, "base", slots.base, attemptNo) : Promise.resolve(null),
      work.sides.head ? this.renderSide(work, "head", slots.head, attemptNo) : Promise.resolve(null)
    ]);
    if (base?.kind === "cancelled" || head?.kind === "cancelled" || this.ctx.signal.aborted) {
      this.cancelled = true;
      for (const side of [base, head]) {
        if (side?.tempImagePath) {
          await removeQuietly(side.tempImagePath);
          this.tempImages.delete(side.tempImagePath);
        }
      }
      return null;
    }
    return { attemptNo, harness: work.harness, base, head };
  }

  private sideFailure(side: RenderSide, kind: RenderFailureKind, headline: string, durationMs = 0): SideAttempt {
    return {
      result: failedSideResult(side, kind, this.formatPlanned(kind, headline), durationMs),
      kind,
      tempImagePath: null
    };
  }

  private async renderSide(
    work: RenderWorkItem,
    side: RenderSide,
    slot: ItemSlot,
    attemptNo: number
  ): Promise<SideAttempt> {
    const name = work.candidate.displayName;
    const componentId = work.candidate.componentId;
    if (slot.state === "failed") {
      return slot.attempt;
    }
    if (slot.state === "not_needed") {
      return this.sideFailure(side, "vite_unavailable", "No Angular build was made for this side.");
    }
    if (!slot.host.isAlive()) {
      return this.sideFailure(
        side,
        "vite_unavailable",
        `The static host stopped (${slot.host.exitReason() ?? "unknown"}).`
      );
    }
    const final = this.deps.artifactStore.imagePaths(this.ctx.visualizationId, componentId, side);
    const tempImagePath = `${final.absolutePath}.attempt${String(attemptNo)}.png`;
    try {
      await this.deps.artifactStore.ensureComponentDir(this.ctx.visualizationId, componentId);
    } catch (error) {
      return this.sideFailure(side, "screenshot", `Could not create the artifact folder: ${getErrorMessage(error)}`);
    }
    let outcome: PageRenderOutcome | null = null;
    let retries = 0;
    for (;;) {
      // The build already compiled everything: no cold-start allowance (15 §5.7.10 step 4).
      const timeoutMs = Math.min(RENDER_TIMEOUT_MS, this.deadline - this.deps.now());
      if (timeoutMs <= 0) {
        return this.sideFailure(side, "budget_exceeded", BUDGET_EXCEEDED_HEADLINE);
      }
      if (!(await this.ensureBrowser()) || this.session === null) {
        return this.sideFailure(side, "browser", "Chromium disconnected and could not be restarted.");
      }
      this.tempImages.add(tempImagePath);
      const counter = slot.counter;
      outcome = await this.session.renderComponent({
        host: slot.host,
        componentId,
        stateName: DEFAULT_STATE_NAME, // 16a compile shim (16 §6.12): 16e renders one page per state
        timeoutMs,
        outputPath: tempImagePath,
        signal: this.ctx.signal,
        checkStylesheets: counter.stylesChecked
          ? null
          : {
              globalStylesExpected: this.requireSides()[side].globalStylesExpected,
              tailwindMajor: slot.host.tailwindMajor
            },
        viewport: RENDER_VIEWPORTS[this.ctx.repository.renderViewport ?? "desktop"],
        mockLabels: work.mockLabels,
        stripPaths: this.stripPaths
      });
      counter.rendered += 1;
      if (!outcome.ok && outcome.infraRetryable && retries < RENDER_INFRA_RETRIES && !this.ctx.signal.aborted) {
        retries += 1;
        this.log.debug(
          { event: "render.page.retry", componentId, side, kind: outcome.kind },
          "Retrying a render after an infrastructure failure"
        );
        continue;
      }
      break;
    }
    if (!outcome.ok) {
      this.tempImages.delete(tempImagePath);
      await removeQuietly(tempImagePath);
      const error = this.sanitize(outcome.error);
      if (outcome.kind !== "cancelled") {
        this.log.warn(
          { event: "render.page.failed", componentId, side, kind: outcome.kind, error: error.slice(0, 500) },
          "Side render failed"
        );
      }
      return {
        result: failedSideResult(side, outcome.kind, error, outcome.durationMs, outcome.consoleErrors),
        kind: outcome.kind,
        tempImagePath: null
      };
    }
    slot.counter.stylesChecked = true;
    await this.reportPageWarnings(name, side, outcome);
    return {
      result: {
        side,
        ok: true,
        imagePath: final.relativePath,
        width: outcome.width,
        height: outcome.height,
        error: null,
        consoleErrors: outcome.consoleErrors,
        durationMs: outcome.durationMs,
        failureKind: null
      },
      kind: null,
      tempImagePath
    };
  }

  private async reportPageWarnings(
    name: string,
    side: RenderSide,
    outcome: Extract<PageRenderOutcome, { ok: true }>
  ): Promise<void> {
    if (outcome.mode === "empty") {
      await this.console("warn", `${name} rendered nothing on the ${side} side.`);
    }
    if (outcome.unstable === true) {
      await this.console(
        "warn",
        `${name} (${side}): the app never became stable within ${String(
          Math.round(RENDER_SETTLE_MAX_MS / 1000)
        )} s (pending timers or requests); captured anyway.`
      );
    }
    if (!outcome.stable) {
      await this.console("warn", `${name} did not stabilise on the ${side} side; using the last frame.`);
    }
    const unmatched = outcome.httpUnmatched ?? [];
    if (unmatched.length > 0) {
      await this.console(
        "warn",
        `${name} (${side}): ${String(unmatched.length)} HTTP request(s) had no fixture: ${unmatched.slice(0, 3).join(", ")}.`
      );
    }
    const skipped = outcome.skippedInputs ?? [];
    if (skipped.length > 0) {
      await this.console(
        "info",
        `${name} (${side}): inputs not declared on this side were skipped: ${skipped.join(", ")}.`
      );
    }
    if (outcome.truncated) {
      await this.console(
        "warn",
        `${name} is taller than ${String(RENDER_MAX_CAPTURE_HEIGHT_PX)} px on the ${side} side; the image is truncated.`
      );
    }
    if (outcome.stylesheetWarning !== null) {
      await this.console("warn", outcome.stylesheetWarning);
    }
  }

  // ----- finalize and persist -----

  private async finalizeAttempt(
    item: AngularItem,
    attempt: ItemAttempt,
    which: "original" | "repaired"
  ): Promise<void> {
    const componentId = item.work.candidate.componentId;
    for (const side of SIDES) {
      const sideAttempt = attempt[side];
      if (sideAttempt === null) {
        continue;
      }
      const final = this.deps.artifactStore.imagePaths(this.ctx.visualizationId, componentId, side);
      if (sideAttempt.result.ok && sideAttempt.tempImagePath !== null) {
        try {
          await fs.rename(sideAttempt.tempImagePath, final.absolutePath);
        } catch (error) {
          sideAttempt.result = failedSideResult(
            side,
            "screenshot",
            this.formatPlanned("screenshot", `Could not store the image: ${getErrorMessage(error)}`),
            sideAttempt.result.durationMs,
            sideAttempt.result.consoleErrors
          );
          sideAttempt.kind = "screenshot";
        }
        this.tempImages.delete(sideAttempt.tempImagePath);
      } else {
        await removeQuietly(final.absolutePath);
      }
    }
    const result: ComponentRenderResult = {
      componentId,
      base: attempt.base?.result ?? null,
      head: attempt.head?.result ?? null,
      states: [] // 16a compile shim (16 §6.12): 16e renders and reports every state
    };
    const sizeSource = result.head?.ok === true ? result.head : result.base?.ok === true ? result.base : null;
    const payload: ComponentRenderPayload = {
      renderStatus: deriveRenderStatus(result),
      baseImagePath: result.base?.ok === true ? result.base.imagePath : null,
      headImagePath: result.head?.ok === true ? result.head.imagePath : null,
      imageWidth: sizeSource?.width ?? null,
      imageHeight: sizeSource?.height ?? null,
      baseError: result.base?.ok === false ? result.base.error : null,
      headError: result.head?.ok === false ? result.head.error : null,
      ...(which === "repaired" ? repairedHarnessPayload(attempt.harness) : {})
    };
    await this.persist(componentId, payload);
    this.results.set(componentId, result);
    await this.reportAttempt(item.work.candidate, attempt);
  }

  private async finalizeImmediate(
    componentId: number,
    payload: ComponentRenderPayload,
    result: ComponentRenderResult
  ): Promise<void> {
    await this.persist(componentId, payload);
    this.results.set(componentId, result);
  }

  private async persist(componentId: number, payload: ComponentRenderPayload): Promise<void> {
    try {
      await this.persistence.saveRenderResult(componentId, payload);
    } catch (error) {
      throw new RenderPersistError(`Persisting the render result of component ${String(componentId)} failed`, {
        cause: error
      });
    }
    this.payloads.set(componentId, payload);
  }

  private async reportAttempt(candidate: ComponentCandidate, attempt: ItemAttempt): Promise<void> {
    const name = candidate.displayName;
    const parts = [describeSide(attempt.base, "base"), describeSide(attempt.head, "head")].filter(
      (part): part is string => part !== null
    );
    const allOk = SIDES.every((side) => attempt[side] === null || attempt[side].result.ok);
    if (allOk) {
      await this.console("info", `Rendered ${name}: ${parts.join(", ")}.`);
      return;
    }
    for (const side of SIDES) {
      const sideAttempt = attempt[side];
      if (sideAttempt === null || sideAttempt.result.ok) {
        continue;
      }
      await this.console(
        "warn",
        `${name}: ${side} failed (${sideAttempt.kind ?? "error"}): ${errorSummaryLine(sideAttempt.result.error ?? "")}`
      );
    }
  }

  // ----- repair (10 §5.13.6, 15 §5.7.10 step 6) -----

  private needsRepair(work: RenderWorkItem, attempt: ItemAttempt): boolean {
    if (isTwoSidedItem(work)) {
      return sidesToRepair(attempt, work.sideRepairsUsed ?? {}).length > 0; // 00 §17: per side
    }
    const primary = attempt[work.primarySide];
    if (primary === null || primary.result.ok || primary.kind === null || !isRepairableFailure(primary.kind)) {
      return false;
    }
    const other = attempt[otherSide(work.primarySide)];
    const othersFailed = other === null || !other.result.ok;
    return othersFailed && work.repairsUsed < HARNESS_MAX_REPAIRS_PER_COMPONENT;
  }

  private async runRepairRounds(byId: ReadonlyMap<number, AngularItem>): Promise<void> {
    while (this.repairQueue.length > 0) {
      const queue = this.repairQueue;
      this.repairQueue = [];
      const repaired: RepairEntry[] = [];
      for (const entry of queue) {
        if (await this.shouldStop()) {
          return;
        }
        if (await this.requestRepair(entry)) {
          repaired.push(entry);
        }
      }
      if (repaired.length === 0) {
        continue;
      }
      const originals = new Map(repaired.map((entry) => [entry.item.work.candidate.componentId, entry] as const));
      for (const group of buildRenderGroups(repaired.map((entry) => entry.item.work))) {
        if (await this.shouldStop()) {
          return;
        }
        const round = Math.max(...group.items.map((work) => work.repairsUsed), 1);
        await this.renderGroup(group, byId, `${group.key}-r${String(round)}`, originals);
      }
    }
  }

  /**
   * Repairs each failed side's own harness of a replaced row (00 §17); returns true when at least one side got a
   * repaired harness, which was written and must be rebuilt.
   */
  private async requestSideRepairs(entry: RepairEntry): Promise<boolean> {
    const { item, attempt } = entry;
    const work = item.work;
    const componentId = work.candidate.componentId;
    const used = { ...work.sideRepairsUsed };
    let harness = work.harness;
    let repairedAny = false;
    for (const side of sidesToRepair(attempt, used)) {
      const sideAttempt = attempt[side];
      if (sideAttempt === null) {
        continue;
      }
      const name =
        side === "base"
          ? (work.candidate.predecessor?.displayName ?? work.candidate.displayName)
          : work.candidate.displayName;
      await this.console(
        "info",
        `Repairing the ${side} harness for ${name} after a render failure (${sideAttempt.kind ?? "error"}).`
      );
      this.log.info({ event: "render.repair.requested", componentId, side }, "Harness repair requested");
      used[side] = (used[side] ?? 0) + 1;
      let outcome: HarnessRepairOutcome;
      try {
        outcome = await this.deps.repairHarness(
          componentId,
          sideHarnessResult(harness, side),
          sideRenderError(side, sideAttempt)
        );
      } catch (error) {
        const message = getErrorMessage(error);
        this.log.warn(
          { event: "render.repair.result", componentId, side, outcome: "error", err: error },
          "Harness repair threw"
        );
        await this.console("warn", `Harness repair for ${name} failed: ${message}`);
        outcome = { ok: false, reason: "ai_error", message };
      }
      if (outcome.ok) {
        harness = withRepairedSide(harness, side, outcome.result);
        repairedAny = true;
        continue;
      }
      if (outcome.reason === "component_defect" || outcome.reason === "cannot_render") {
        const previous = this.payloads.get(componentId);
        const notes = capNotes(`${sideHarnessOf(harness, side).notes}\n\n${outcome.notesAppendix}`);
        harness = withRepairedSide(harness, side, { ...sideHarnessResult(harness, side), notes });
        if (previous !== undefined) {
          const { harness: _ignored, baseHarness: _ignoredBase, ...rest } = previous;
          await this.persist(
            componentId,
            side === "base" ? { ...rest, baseHarnessNotes: notes } : { ...rest, harnessNotes: notes }
          );
        }
        await this.console(
          "warn",
          outcome.reason === "component_defect"
            ? `Harness repair for ${name}: the failure looks like a defect in the component itself.`
            : `Harness repair for ${name}: the AI considers it not renderable in isolation.`
        );
      } else {
        await this.console("info", `No repaired harness for ${name} (${outcome.reason}); keeping the first result.`);
      }
      this.log.info({ event: "render.repair.result", componentId, side, outcome: "none" }, "No repaired harness");
    }
    work.sideRepairsUsed = used;
    if (!repairedAny) {
      work.harness = harness;
      return false;
    }
    const sides = this.requireSides();
    await this.applyHarness(item, harness, sides);
    work.repairsUsed += 1;
    try {
      await this.writeItemFiles(item, sides);
    } catch (error) {
      throw new PipelineStepError(RENDER_STAGE, `Could not write render harness files: ${getErrorMessage(error)}`, {
        code: "RENDER_HARNESS_WRITE_FAILED",
        cause: error
      });
    }
    return true;
  }

  /** Calls 09's repairHarness; returns true when a repaired harness was written and must be rebuilt. */
  private async requestRepair(entry: RepairEntry): Promise<boolean> {
    if (isTwoSidedItem(entry.item.work)) {
      return this.requestSideRepairs(entry);
    }
    const { item, attempt } = entry;
    const work = item.work;
    const componentId = work.candidate.componentId;
    const name = work.candidate.displayName;
    const primary = attempt[work.primarySide];
    await this.console(
      "info",
      `Repairing the harness for ${name} after a render failure (${work.primarySide}: ${primary?.kind ?? "error"}).`
    );
    this.log.info({ event: "render.repair.requested", componentId }, "Harness repair requested");
    let outcome: HarnessRepairOutcome;
    try {
      outcome = await this.deps.repairHarness(componentId, work.harness, toRenderError(work, attempt));
    } catch (error) {
      const message = getErrorMessage(error);
      this.log.warn(
        { event: "render.repair.result", componentId, outcome: "error", err: error },
        "Harness repair threw"
      );
      await this.console("warn", `Harness repair for ${name} failed: ${message}`);
      outcome = { ok: false, reason: "ai_error", message };
    }
    if (!outcome.ok) {
      if (outcome.reason === "component_defect" || outcome.reason === "cannot_render") {
        const previous = this.payloads.get(componentId);
        if (previous !== undefined) {
          const harnessNotes = capNotes(`${work.harness.notes}\n\n${outcome.notesAppendix}`);
          const { harness: _ignored, ...rest } = previous;
          await this.persist(componentId, { ...rest, harnessNotes });
        }
        await this.console(
          "warn",
          outcome.reason === "component_defect"
            ? `Harness repair for ${name}: the failure looks like a defect in the component itself.`
            : `Harness repair for ${name}: the AI considers it not renderable in isolation.`
        );
      } else {
        await this.console("info", `No repaired harness for ${name} (${outcome.reason}); keeping the first result.`);
      }
      this.log.info({ event: "render.repair.result", componentId, outcome: "none" }, "No repaired harness");
      return false;
    }
    const sides = this.requireSides();
    await this.applyHarness(item, outcome.result, sides);
    work.repairsUsed += 1;
    try {
      await this.writeItemFiles(item, sides);
    } catch (error) {
      throw new PipelineStepError(RENDER_STAGE, `Could not write render harness files: ${getErrorMessage(error)}`, {
        code: "RENDER_HARNESS_WRITE_FAILED",
        cause: error
      });
    }
    return true;
  }

  private async keepBetterAttempt(
    item: AngularItem,
    repaired: ItemAttempt,
    originals: ReadonlyMap<number, RepairEntry>
  ): Promise<void> {
    const work = item.work;
    const original = originals.get(work.candidate.componentId);
    if (original === undefined) {
      return;
    }
    const name = work.candidate.displayName;
    const componentId = work.candidate.componentId;
    if (chooseAttempt(work.primarySide, original.attempt, repaired) === "repaired") {
      await this.finalizeAttempt(item, repaired, "repaired");
      const summary = [describeSide(repaired.base, "base"), describeSide(repaired.head, "head")]
        .filter((part): part is string => part !== null)
        .join(", ");
      await this.console("info", `Repaired harness rendered ${name}: ${summary}.`);
      this.log.info({ event: "render.repair.result", componentId, outcome: "applied" }, "Repaired harness kept");
      if (this.needsRepair(work, repaired)) {
        this.repairQueue.push({ item, attempt: repaired });
      }
      return;
    }
    for (const side of SIDES) {
      const temp = repaired[side]?.tempImagePath ?? null;
      if (temp !== null) {
        await removeQuietly(temp);
        this.tempImages.delete(temp);
      }
    }
    work.harness = original.attempt.harness;
    await this.console("info", `Repaired harness for ${name} did not improve the result; keeping the first result.`);
    this.log.info({ event: "render.repair.result", componentId, outcome: "kept_original" }, "Original attempt kept");
  }

  // ----- budget, results, cleanup -----

  private async failUnfinishedIfBudgetExceeded(items: readonly AngularItem[]): Promise<void> {
    if (!this.budgetExceeded || this.cancelled) {
      return;
    }
    const unfinished = items.filter((item) => !this.results.has(item.work.candidate.componentId));
    if (unfinished.length === 0) {
      return;
    }
    const minutes = Math.round(RENDER_STAGE_TIMEOUT_MS / 60_000);
    await this.console(
      "warn",
      `The render stage exceeded its ${String(minutes)}-minute budget; ${String(unfinished.length)} component(s) were not rendered.`
    );
    for (const item of unfinished) {
      const work = item.work;
      const attempt: ItemAttempt = {
        attemptNo: work.repairsUsed,
        harness: work.harness,
        base: work.sides.base ? this.sideFailure("base", "budget_exceeded", BUDGET_EXCEEDED_HEADLINE) : null,
        head: work.sides.head ? this.sideFailure("head", "budget_exceeded", BUDGET_EXCEEDED_HEADLINE) : null
      };
      await this.finalizeAttempt(item, attempt, "original");
    }
  }

  private counts(): { rendered: number; partial: number; failed: number } {
    const counts = { rendered: 0, partial: 0, failed: 0 };
    for (const result of this.results.values()) {
      counts[deriveRenderStatus(result)] += 1;
    }
    return counts;
  }

  private summaryLine(startedAt: number): string {
    const seconds = Math.round((this.deps.now() - startedAt) / 1000);
    const { rendered, partial, failed } = this.counts();
    return `Render stage finished in ${String(seconds)} s: ${String(rendered)} rendered, ${String(partial)} partial, ${String(failed)} failed.`;
  }

  private orderedResults(inputs: readonly RenderComponentInput[]): ComponentRenderResult[] {
    const ordered: ComponentRenderResult[] = [];
    const seen = new Set<number>();
    for (const input of inputs) {
      const id = input.candidate.componentId;
      const result = this.results.get(id);
      if (result !== undefined && !seen.has(id)) {
        seen.add(id);
        ordered.push(result);
      }
    }
    return ordered;
  }

  private buildHosts(): AngularBuildHost[] {
    if (this.sides === null) {
      return [];
    }
    return SIDES.map((side) => this.sides?.[side].host ?? null).filter(
      (host): host is AngularBuildHost => host !== null
    );
  }

  private async abortInFlight(): Promise<void> {
    await settle(this.session?.closeAllContexts(), this.log);
    await Promise.all([...this.liveStaticHosts].map((host) => settle(host.stop(), this.log)));
    await Promise.all(this.buildHosts().map((host) => settle(host.stop(), this.log)));
  }

  /** Contexts, static hosts, build children, browser and unfinalized temp images. Never throws. */
  private async cleanup(): Promise<void> {
    await settle(this.session?.closeAllContexts(), this.log);
    await Promise.all([...this.liveStaticHosts].map((host) => settle(host.stop(), this.log)));
    this.liveStaticHosts.clear();
    await Promise.all(this.buildHosts().map((host) => settle(host.stop(), this.log)));
    await settle(this.session?.close(), this.log);
    for (const temp of this.tempImages) {
      await removeQuietly(temp);
    }
    this.tempImages.clear();
  }
}

/** HarnessRenderError for 09 (09 §5.1) from the attempt that triggered repair. */
function toRenderError(work: RenderWorkItem, attempt: ItemAttempt): HarnessRenderError {
  const primary = attempt[work.primarySide];
  if (primary === null) {
    throw new Error("Invariant: toRenderError called without a primary-side attempt");
  }
  const kind = primary.kind;
  if (kind !== "module_load" && kind !== "render_error" && kind !== "timeout") {
    throw new Error("Invariant: toRenderError called for a non-repairable failure");
  }
  const other = attempt[otherSide(work.primarySide)];
  const otherError = other?.result.error ?? null;
  return {
    sides: SIDES.filter((side) => work.sides[side]),
    kind,
    message: primary.result.error ?? "",
    otherSideMessage: otherError !== null && otherError !== "" ? otherError.slice(0, 1_000) : null
  };
}

async function settle(promise: Promise<void> | undefined, log: ReturnType<typeof createLogger>): Promise<void> {
  if (promise === undefined) {
    return;
  }
  try {
    await promise;
  } catch (error) {
    log.warn({ event: "render.cleanup.failed", err: error }, "Render cleanup step failed");
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, { force: true });
  } catch {
    // Best effort: a leftover temp image is removed with the visualization's artifacts.
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}
