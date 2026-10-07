/**
 * Live hosts of one live session (16 §12.4, E19): the session's plan (render work items rebuilt from the run's rows,
 * render groups), the harness workspaces of both sides, and one host per (side, render group), started lazily when a
 * card of the group is opened. At most LIVE_MAX_HOSTS_PER_SIDE run per side; starting another one stops the least
 * recently used. React hosts are the repository's own Vite with the live plugin; Angular hosts are one build of the
 * group's harnesses served by AngularStaticHost with its live option. Host starts are serialized per side (one
 * Angular build child and one harness registry per side; no two Vite optimizers racing on one side).
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  ANGULAR_CACHE_DIR_NAME,
  ANGULAR_MAX_BUILDS_PER_GROUP_SIDE,
  FRONTEND_URL,
  LIVE_MAX_HOSTS_PER_SIDE,
  RENDER_GROUP_MAX_ITEMS
} from "../../config-consts";
import { RepositoryFramework } from "../../enums";
import type { RepositoryModel, VisualizationComponentModel } from "../../models";
import type { LiveHostState } from "../../types/harness-library";
import type { PreparedWorkspace, WorktreeSide } from "../../types/visualization-pipeline";
import { ArtifactStore, createLogger, getErrorMessage, redactSecrets } from "../../utilities";
import { candidateFromRow, previousHarnessOf, renamedFrom } from "../harness-library/harness-repair-worker-service";
import { angularAppRootRel, angularTargetImportPath } from "../visualizations/pipeline/angular/angular-harness-prompts";
import { targetImportPath, viteRootRelOf } from "../visualizations/pipeline/harness-prompts";
import { validateMockedModules } from "../visualizations/pipeline/mock-rules";
import { ModuleResolver } from "../visualizations/pipeline/module-resolver";
import {
  buildHarnessBuildOptions,
  normalizeWorkspacePath,
  readAngularProject,
  type AngularFileReplacement,
  type AngularProjectInfo
} from "../visualizations/pipeline/render/angular/angular-build-options";
import {
  errorDiagnosticsOfFailedBuild,
  firstDiagnosticLine,
  runExclusionLoop,
  warningLines,
  type ExclusionBuildResult
} from "../visualizations/pipeline/render/angular/angular-diagnostics";
import {
  AngularHarnessWorkspaceWriter,
  assertAngularTemplatesPresent,
  installedPackageMajor,
  readAngularConfinedText,
  resolveAngularLayout,
  rewriteAngularTargetSpecifier,
  type AngularSideLayout
} from "../visualizations/pipeline/render/angular/angular-harness-workspace";
import {
  AngularHostClient,
  type AngularBuildHost,
  type AngularBuildOutcome
} from "../visualizations/pipeline/render/angular/angular-host-client";
import { angularMockHash } from "../visualizations/pipeline/render/angular/angular-render-service";
import {
  AngularStaticHost,
  STATIC_HOST_WARNINGS_MAX,
  type AngularStaticHostHandle,
  type AngularStaticHostOptions
} from "../visualizations/pipeline/render/angular/angular-static-host";
import {
  HarnessWorkspaceWriter,
  assertTemplatesPresent,
  harnessRootRelative,
  resolveSideLayout,
  rewriteTargetSpecifier,
  scanReferencedEnvKeys
} from "../visualizations/pipeline/render/harness-workspace";
import { planLiveItems } from "../visualizations/pipeline/render/live-planning";
import { liveFrontendOrigins } from "../visualizations/pipeline/render/live/live-page-headers";
import { buildRenderGroups, splitLargeGroups } from "../visualizations/pipeline/render/render-groups";
import type {
  HarnessSideLayout,
  MockEntryInput,
  RenderWorkItem,
  ViteHostHandle,
  ViteHostStartOptions
} from "../visualizations/pipeline/render/render-types";
import { isTwoSidedItem, sideHarnessOf, sideMocksOf } from "../visualizations/pipeline/render/replaced-harness";
import { ViteHostClient } from "../visualizations/pipeline/render/vite-host-client";

const SIDES: readonly WorktreeSide[] = ["base", "head"];
const ANGULAR_JSON_MAX_BYTES = 1024 * 1024;
const HOST_ERROR_MAX_CHARS = 1_000;

// ---------------------------------------------------------------------------------------------------------------
// Plan (16 §12.3 step 2)
// ---------------------------------------------------------------------------------------------------------------

/** One render group of the session: its index is the `<n>` of `live-<n>` folders (never the raw group key). */
export interface LiveGroupPlan {
  index: number;
  key: string;
  items: RenderWorkItem[];
}

/** The session's plan: groups and, per component, its group and sides. */
export interface LiveSessionPlan {
  items: RenderWorkItem[];
  groups: LiveGroupPlan[];
  groupOf: ReadonlyMap<number, number>;
}

/**
 * Rebuilds the run's render work items from its component rows (16 §12.3 step 2, E2: the run's harness snapshots)
 * and groups them like the render engine. States come from the snapshots (`previousHarnessOf`, legacy shapes
 * accepted). A renamed same-harness row renders its old path on the base side (`renamedFrom` of the row's code diff,
 * as repair does), which `planLiveItems` alone cannot know.
 */
export function buildLivePlan(
  rows: readonly VisualizationComponentModel[],
  repository: RepositoryModel
): LiveSessionPlan {
  const inputs = [];
  const basePaths = new Map<number, string | null>();
  for (const row of rows) {
    const previous = previousHarnessOf(row, repository.framework);
    if (previous === null) {
      continue;
    }
    inputs.push({ row, states: previous.states, baseStates: previous.baseHarness?.states ?? null });
    basePaths.set(row.id, candidateFromRow(row).basePath);
  }
  const items = planLiveItems(inputs, repository);
  for (const item of items) {
    const basePath = basePaths.get(item.candidate.componentId) ?? null;
    if (
      !isTwoSidedItem(item) &&
      item.paths.base !== null &&
      basePath !== null &&
      basePath !== item.paths.base &&
      renamedFrom(item.candidate.codeDiff) === basePath
    ) {
      item.paths = { ...item.paths, base: basePath };
    }
  }
  const groups = splitLargeGroups(buildRenderGroups(items), RENDER_GROUP_MAX_ITEMS).map((group, index) => ({
    index,
    key: group.key,
    items: group.items
  }));
  const groupOf = new Map<number, number>();
  for (const group of groups) {
    for (const item of group.items) {
      groupOf.set(item.candidate.componentId, group.index);
    }
  }
  return { items, groups, groupOf };
}

// ---------------------------------------------------------------------------------------------------------------
// Backends (React: Vite live hosts; Angular: one build per group + static live host)
// ---------------------------------------------------------------------------------------------------------------

/** A running live host as the manager sees it. */
export interface LiveRunningHost {
  readonly origin: string;
  readonly harnessUrlPath: string;
  /** Non-fatal note shown as the host's `error` while it is ready (Angular: components left out of the build). */
  readonly note: string | null;
  isAlive(): boolean;
  exitReason(): string | null;
  /** Idempotent; never throws. */
  stop(): Promise<void>;
}

/** Framework-specific part of live hosting. */
export interface LiveHostBackend {
  /** Writes the harness workspace of both sides with every harness of the plan. */
  prepare(plan: LiveSessionPlan, signal: AbortSignal): Promise<void>;
  /** Starts the host of one group on one side. Throws with a user-facing message when it cannot. */
  start(side: WorktreeSide, group: LiveGroupPlan, signal: AbortSignal): Promise<LiveRunningHost>;
  /** Releases per-side resources (Angular build children). Never throws. */
  close(): Promise<void>;
}

/** What both backends need from the session. */
export interface LiveBackendContext {
  repository: RepositoryModel;
  workspace: PreparedWorkspace;
  /** FRONTEND_URL origin and its loopback twin (frame-ancestors). */
  frontendOrigins: string[];
  /** Absolute paths stripped from user-facing errors (worktrees, clone). */
  stripPaths: readonly string[];
}

/** First line of an error, worktree paths stripped, secrets redacted, capped. */
export function hostErrorText(error: unknown, stripPaths: readonly string[]): string {
  let text = redactSecrets(getErrorMessage(error)).split("\n")[0] ?? "";
  for (const prefix of [...stripPaths].sort((a, b) => b.length - a.length)) {
    if (prefix !== "") {
      text = text.split(`${prefix}/`).join("").split(prefix).join(".");
    }
  }
  return text.slice(0, HOST_ERROR_MAX_CHARS);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** React dependencies (tests replace the writer and the host start). */
export interface ReactLiveBackendDependencies {
  writer: Pick<HarnessWorkspaceWriter, "templatesDir" | "prepareSide" | "writeComponentHarness">;
  startViteHost: (
    options: ViteHostStartOptions,
    harnessUrlPath: string,
    signal: AbortSignal
  ) => Promise<ViteHostHandle>;
  scanEnvKeys: (roots: string[]) => Promise<string[]>;
}

/** React: the repository's own Vite per (side, group) with the live plugin (16 §12.4). */
export class ReactLiveBackend implements LiveHostBackend {
  private readonly deps: ReactLiveBackendDependencies;
  private layouts: Record<WorktreeSide, HarnessSideLayout> | null = null;
  private envKeys: string[] = [];
  private readonly written: Record<WorktreeSide, Set<number>> = { base: new Set(), head: new Set() };

  constructor(
    private readonly ctx: LiveBackendContext,
    deps: Partial<ReactLiveBackendDependencies> = {}
  ) {
    this.deps = {
      writer: deps.writer ?? new HarnessWorkspaceWriter(),
      startViteHost:
        deps.startViteHost ??
        ((options, harnessUrlPath, signal) => ViteHostClient.start(options, harnessUrlPath, signal)),
      scanEnvKeys: deps.scanEnvKeys ?? scanReferencedEnvKeys
    };
  }

  async prepare(plan: LiveSessionPlan, signal: AbortSignal): Promise<void> {
    await assertTemplatesPresent(this.deps.writer.templatesDir);
    const layout = async (side: WorktreeSide, dir: string): Promise<HarnessSideLayout> => {
      const resolved = resolveSideLayout(side, dir, this.ctx.repository.viteConfigPath);
      return resolved.configFile !== null && !(await fileExists(resolved.configFile))
        ? { ...resolved, configFile: null }
        : resolved;
    };
    const layouts = {
      base: await layout("base", this.ctx.workspace.baseDir),
      head: await layout("head", this.ctx.workspace.headDir)
    };
    this.layouts = layouts;
    for (const side of SIDES) {
      signal.throwIfAborted();
      await this.deps.writer.prepareSide(layouts[side], this.ctx.repository.globalStylePaths);
    }
    const viteRootRel = viteRootRelOf(this.ctx.repository.viteConfigPath);
    for (const item of plan.items) {
      signal.throwIfAborted();
      for (const side of SIDES) {
        if (!item.sides[side]) {
          continue;
        }
        let source = sideHarnessOf(item.harness, side).harnessSource;
        const basePath = item.paths.base;
        const headPath = item.paths.head;
        if (
          !isTwoSidedItem(item) &&
          side === "base" &&
          basePath !== null &&
          headPath !== null &&
          basePath !== headPath
        ) {
          try {
            source = rewriteTargetSpecifier(
              source,
              targetImportPath(headPath, viteRootRel),
              targetImportPath(basePath, viteRootRel)
            );
          } catch {
            continue; // the base page reports the missing harness module itself
          }
        }
        await this.deps.writer.writeComponentHarness(layouts[side], item.candidate.componentId, source);
        this.written[side].add(item.candidate.componentId);
      }
    }
    this.envKeys = await this.deps.scanEnvKeys([layouts.base.viteRoot, layouts.head.viteRoot]);
  }

  /** The Vite start options of one group on one side: the render engine's openHost options plus `live`. */
  startOptions(side: WorktreeSide, group: LiveGroupPlan): { options: ViteHostStartOptions; harnessUrlPath: string } {
    const layouts = this.layouts;
    if (layouts === null) {
      throw new Error("Invariant: live workspaces are prepared before hosts start");
    }
    const layout = layouts[side];
    const groupItems = group.items.filter(
      (item) => item.sides[side] && this.written[side].has(item.candidate.componentId)
    );
    const mocks: MockEntryInput[] = [];
    for (const item of groupItems) {
      const sidePath = item.paths[side];
      if (sidePath === null) {
        continue;
      }
      const componentFile = path.join(layout.worktreeDir, sidePath);
      for (const mock of sideMocksOf(item, side)) {
        mocks.push({
          componentId: item.candidate.componentId,
          componentFile,
          specifier: mock.specifier,
          source: mock.source
        });
      }
    }
    const componentFile = (id: number): string => harnessRootRelative(layout, "components", `${String(id)}.tsx`);
    return {
      harnessUrlPath: layout.harnessUrlPath,
      options: {
        side,
        groupKey: group.key,
        worktreeDir: layout.worktreeDir,
        viteRoot: layout.viteRoot,
        harnessDir: layout.harnessDir,
        // One optimizer cache per live host: hosts of one side may run at the same time (16 §12.4 LRU).
        cacheDir: path.join(layout.harnessDir, `.vite-cache-live-${String(group.index)}`),
        configFile: layout.configFile,
        optimizeEntries: [
          harnessRootRelative(layout, "entry.tsx"),
          harnessRootRelative(layout, "globals.ts"),
          ...[...this.written[side]].sort((a, b) => a - b).map(componentFile)
        ],
        warmupFiles: [
          harnessRootRelative(layout, "entry.tsx"),
          ...groupItems.map((item) => componentFile(item.candidate.componentId))
        ],
        referencedEnvKeys: this.envKeys,
        mocks,
        live: { frontendOrigins: this.ctx.frontendOrigins }
      }
    };
  }

  async start(side: WorktreeSide, group: LiveGroupPlan, signal: AbortSignal): Promise<LiveRunningHost> {
    const { options, harnessUrlPath } = this.startOptions(side, group);
    const handle = await this.deps.startViteHost(options, harnessUrlPath, signal);
    return {
      origin: handle.origin,
      harnessUrlPath: handle.harnessUrlPath,
      note: null,
      isAlive: () => handle.isAlive(),
      exitReason: () => handle.exitReason(),
      stop: () => handle.stop()
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** One side of an Angular session. */
interface AngularLiveSide {
  layout: AngularSideLayout;
  project: AngularProjectInfo | null;
  broken: string | null;
  host: AngularBuildHost | null;
  tailwindMajor: 3 | 4 | null;
  sideWideFiles: Set<string>;
  /** componentId → this side's accepted mocks (file replacements). */
  mocks: Map<number, Array<{ specifier: string; hash: string; replace: string }>>;
  written: Set<number>;
}

/** Angular dependencies (tests replace any subset). */
export interface AngularLiveBackendDependencies {
  writer: Pick<
    AngularHarnessWorkspaceWriter,
    "templatesDir" | "prepareSide" | "writeComponentHarness" | "writeMock" | "writeRegistry"
  >;
  createBuildHost: (side: WorktreeSide, workspaceRoot: string) => AngularBuildHost;
  startStaticHost: (options: AngularStaticHostOptions) => Promise<AngularStaticHostHandle>;
  /** Resolves a mock specifier to a repo-relative file on one side (08's ModuleResolver over the app tsconfig). */
  createMockResolver: (
    repository: RepositoryModel,
    side: WorktreeSide,
    worktreeDir: string
  ) => Promise<(specifier: string, fromRepoPath: string) => string | null>;
  /** `<dataDir>/cache/angular/<repositoryId>` (shared with runs, 15 §5.7.6). */
  cacheDir: string;
}

async function defaultMockResolver(
  repository: RepositoryModel,
  side: WorktreeSide,
  worktreeDir: string
): Promise<(specifier: string, fromRepoPath: string) => string | null> {
  const resolver = await ModuleResolver.create({
    side,
    rootDir: worktreeDir,
    tsconfigPath: repository.tsconfigPath,
    viteConfigPath: null,
    sourceRoot: repository.appRoot,
    warn: () => undefined
  });
  return (specifier, fromRepoPath) => {
    const resolution = resolver.resolveScript(specifier, fromRepoPath);
    return resolution.kind === "internal" ? resolution.path : null;
  };
}

/**
 * Angular: one build of the group's harnesses per side (`.prvision-harness/dist/live-<n>`, 15 §5.7.6 options and the
 * exclusion loop), served by AngularStaticHost with its live option (16 §12.4). One build child per side.
 */
export class AngularLiveBackend implements LiveHostBackend {
  private readonly deps: AngularLiveBackendDependencies;
  private sides: Record<WorktreeSide, AngularLiveSide> | null = null;

  constructor(
    private readonly ctx: LiveBackendContext,
    deps: Partial<AngularLiveBackendDependencies> = {}
  ) {
    this.deps = {
      writer: deps.writer ?? new AngularHarnessWorkspaceWriter(),
      createBuildHost: deps.createBuildHost ?? ((side, workspaceRoot) => new AngularHostClient(side, workspaceRoot)),
      startStaticHost: deps.startStaticHost ?? ((options) => AngularStaticHost.start(options)),
      createMockResolver: deps.createMockResolver ?? defaultMockResolver,
      cacheDir:
        deps.cacheDir ?? path.join(new ArtifactStore().dataDir, ANGULAR_CACHE_DIR_NAME, String(ctx.repository.id))
    };
  }

  async prepare(plan: LiveSessionPlan, signal: AbortSignal): Promise<void> {
    await assertAngularTemplatesPresent(this.deps.writer.templatesDir);
    const projectName = this.ctx.repository.angularProject;
    if (projectName === null || projectName === "") {
      throw new Error("The repository has no Angular project configured; re-detect it.");
    }
    await fs.mkdir(this.deps.cacheDir, { recursive: true }).catch(() => undefined);
    const sides = {
      base: await this.resolveSide("base", this.ctx.workspace.baseDir, projectName),
      head: await this.resolveSide("head", this.ctx.workspace.headDir, projectName)
    };
    this.sides = sides;
    for (const side of SIDES) {
      signal.throwIfAborted();
      const state = sides[side];
      if (state.project === null) {
        continue;
      }
      const prepared = await this.deps.writer.prepareSide(
        state.layout,
        state.project,
        this.ctx.repository.angularBuildConfiguration
      );
      for (const file of prepared.tsconfigFiles) {
        state.sideWideFiles.add(file);
      }
    }
    const appRoot = angularAppRootRel(this.ctx.repository.appRoot);
    for (const item of plan.items) {
      signal.throwIfAborted();
      for (const side of SIDES) {
        const state = sides[side];
        if (!item.sides[side] || state.project === null) {
          continue;
        }
        let source = sideHarnessOf(item.harness, side).harnessSource;
        const basePath = item.paths.base;
        const headPath = item.paths.head;
        if (
          !isTwoSidedItem(item) &&
          side === "base" &&
          basePath !== null &&
          headPath !== null &&
          basePath !== headPath
        ) {
          try {
            source = rewriteAngularTargetSpecifier(
              source,
              angularTargetImportPath(headPath, appRoot),
              angularTargetImportPath(basePath, appRoot)
            );
          } catch {
            continue;
          }
        }
        const mocks = await this.sideMocks(item, side, state);
        await this.deps.writer.writeComponentHarness(state.layout, item.candidate.componentId, source);
        for (const mock of mocks) {
          await this.deps.writer.writeMock(state.layout, mock.hash, mock.source);
        }
        state.mocks.set(
          item.candidate.componentId,
          mocks.map(({ specifier, hash, replace }) => ({ specifier, hash, replace }))
        );
        state.written.add(item.candidate.componentId);
      }
    }
  }

  async start(side: WorktreeSide, group: LiveGroupPlan, signal: AbortSignal): Promise<LiveRunningHost> {
    const state = this.sides?.[side];
    if (state === undefined) {
      throw new Error("Invariant: live workspaces are prepared before hosts start");
    }
    if (state.broken !== null || state.project === null) {
      throw new Error(state.broken ?? `The Angular workspace is not available on the ${side} side.`);
    }
    const project = state.project;
    state.host ??= this.deps.createBuildHost(side, state.layout.workspaceRoot);
    const host = state.host;
    const ids = group.items
      .filter((item) => item.sides[side] && state.written.has(item.candidate.componentId))
      .map((item) => item.candidate.componentId);
    if (ids.length === 0) {
      throw new Error(`No harness of this group could be written on the ${side} side.`);
    }
    const buildKey = `live-${String(group.index)}`;
    const mockOwners = new Map<string, number[]>();
    const targetFiles = new Map<number, string>();
    for (const item of group.items) {
      const id = item.candidate.componentId;
      for (const mock of state.mocks.get(id) ?? []) {
        mockOwners.set(mock.hash, [...(mockOwners.get(mock.hash) ?? []), id]);
      }
      const sidePath = item.paths[side];
      if (sidePath !== null) {
        targetFiles.set(
          id,
          toPosix(path.relative(state.layout.workspaceRoot, path.join(state.layout.worktreeDir, sidePath)))
        );
      }
    }
    const outcomes = new Map<number, AngularBuildOutcome & { status: "success" }>();
    const loop = await runExclusionLoop({
      side,
      componentIds: ids,
      budget: ANGULAR_MAX_BUILDS_PER_GROUP_SIDE,
      mockOwners,
      sideWideFiles: state.sideWideFiles,
      targetFiles,
      build: async (componentIds, buildNo): Promise<ExclusionBuildResult> => {
        const key = buildNo === 1 ? buildKey : `${buildKey}-x${String(buildNo)}`;
        const outcome = await this.runBuild(state, project, host, key, componentIds, signal);
        if (outcome.status === "success") {
          outcomes.set(buildNo, outcome);
        }
        return toExclusionResult(outcome);
      }
    });
    signal.throwIfAborted();
    if (loop.cancelled) {
      throw new Error("The live build was cancelled.");
    }
    // One host per (side, group): the build that holds the most components is served.
    const served = [...loop.builds].sort((a, b) => b.componentIds.length - a.componentIds.length)[0];
    if (served === undefined) {
      const failure = [...loop.failures.values()][0];
      const detail =
        loop.sideWide !== null
          ? firstDiagnosticLine(loop.sideWide.diagnostics)
          : failure !== undefined
            ? `${failure.headline} ${firstDiagnosticLine(failure.diagnostics)}`.trim()
            : "no build succeeded";
      throw new Error(`The Angular build failed on the ${side} side: ${detail}`);
    }
    const left = ids.filter((id) => !served.componentIds.includes(id));
    const names = left
      .map((id) => group.items.find((item) => item.candidate.componentId === id)?.candidate.displayName ?? String(id))
      .join(", ");
    const outcome = outcomes.get(served.buildNo);
    const staticHost = await this.deps.startStaticHost({
      side,
      groupKey: group.key,
      distDir: served.outputDir,
      buildLogs: outcome?.logs ?? [],
      tailwindMajor: state.tailwindMajor,
      warnings: warningLines(outcome?.logs ?? [], STATIC_HOST_WARNINGS_MAX),
      live: { frontendOrigins: this.ctx.frontendOrigins }
    });
    return {
      origin: staticHost.origin,
      harnessUrlPath: staticHost.harnessUrlPath,
      note: left.length === 0 ? null : `Could not build ${names} for live mode on the ${side} side.`,
      isAlive: () => staticHost.isAlive(),
      exitReason: () => staticHost.exitReason(),
      stop: () => staticHost.stop()
    };
  }

  async close(): Promise<void> {
    for (const side of SIDES) {
      const host = this.sides?.[side].host ?? null;
      if (host !== null) {
        await host.stop().catch(() => undefined); // stop() never throws; belt and braces
      }
    }
  }

  private async resolveSide(side: WorktreeSide, worktreeDir: string, projectName: string): Promise<AngularLiveSide> {
    const layout = resolveAngularLayout(side, worktreeDir, this.ctx.repository.appRoot);
    const state: AngularLiveSide = {
      layout,
      project: null,
      broken: null,
      host: null,
      tailwindMajor: null,
      sideWideFiles: new Set(["angular.json"]),
      mocks: new Map(),
      written: new Set()
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
    } catch (error: unknown) {
      state.broken = `${getErrorMessage(error)} on the ${side} side`;
      return state;
    }
    const tailwind = await installedPackageMajor(layout.workspaceRoot, "tailwindcss");
    state.tailwindMajor = tailwind === 3 || tailwind === 4 ? tailwind : null;
    return state;
  }

  /** The item's accepted mocks on one side as file replacements (15 §5.7.6), unresolvable ones left out. */
  private async sideMocks(
    item: RenderWorkItem,
    side: WorktreeSide,
    state: AngularLiveSide
  ): Promise<Array<{ specifier: string; source: string; hash: string; replace: string }>> {
    const sidePath = item.paths[side];
    const accepted = validateMockedModules(sideHarnessOf(item.harness, side).mockedModules).accepted;
    if (sidePath === null || accepted.length === 0) {
      return [];
    }
    let resolve: (specifier: string, fromRepoPath: string) => string | null;
    try {
      resolve = await this.deps.createMockResolver(this.ctx.repository, side, state.layout.worktreeDir);
    } catch {
      return [];
    }
    const appRoot = this.ctx.repository.appRoot;
    const out = [];
    for (const mock of accepted) {
      const resolved = resolve(mock.specifier, sidePath);
      const insideApp = resolved !== null && (appRoot === "." || resolved.startsWith(`${appRoot}/`));
      if (resolved === null || !resolved.endsWith(".ts") || !insideApp || resolved === sidePath) {
        continue;
      }
      const componentFile = path.join(state.layout.worktreeDir, sidePath);
      out.push({
        specifier: mock.specifier,
        source: mock.source,
        hash: angularMockHash(componentFile, mock.specifier, mock.source),
        replace: normalizeWorkspacePath(
          toPosix(path.relative(state.layout.workspaceRoot, path.join(state.layout.worktreeDir, resolved)))
        )
      });
    }
    return out;
  }

  private async runBuild(
    state: AngularLiveSide,
    project: AngularProjectInfo,
    host: AngularBuildHost,
    buildKey: string,
    componentIds: readonly number[],
    signal: AbortSignal
  ): Promise<AngularBuildOutcome> {
    const replacements: AngularFileReplacement[] = [];
    const replaced = new Set<string>();
    for (const id of componentIds) {
      for (const mock of state.mocks.get(id) ?? []) {
        if (!replaced.has(mock.replace)) {
          replaced.add(mock.replace);
          replacements.push({ replace: mock.replace, with: `.prvision-harness/mocks/${mock.hash}.ts` });
        }
      }
    }
    try {
      await this.deps.writer.writeRegistry(state.layout, componentIds);
    } catch (error: unknown) {
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
      cacheDir: this.deps.cacheDir
    });
    return host.build(
      {
        buildKey,
        projectName: project.name,
        builderName: built.builderName,
        options: built.options,
        projectExtensions: built.projectExtensions
      },
      signal
    );
  }
}

function toExclusionResult(outcome: AngularBuildOutcome): ExclusionBuildResult {
  switch (outcome.status) {
    case "success":
      return { status: "success", outputDir: outcome.outputDir };
    case "failed":
      return { status: "failed", diagnostics: errorDiagnosticsOfFailedBuild(outcome.logs) };
    case "cancelled":
      return { status: "cancelled" };
    case "timeout":
      return { status: "timeout", message: outcome.message };
    case "unavailable":
      return { status: "unavailable", message: outcome.message };
  }
}

/** The backend of the repository's framework. */
export function createLiveHostBackend(ctx: LiveBackendContext): LiveHostBackend {
  return ctx.repository.framework === RepositoryFramework.ANGULAR
    ? new AngularLiveBackend(ctx)
    : new ReactLiveBackend(ctx);
}

/** FRONTEND_URL origin and its loopback twin. */
export function defaultLiveFrontendOrigins(): string[] {
  return liveFrontendOrigins(FRONTEND_URL);
}

// ---------------------------------------------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------------------------------------------

interface HostEntry {
  side: WorktreeSide;
  group: LiveGroupPlan;
  componentIds: number[];
  status: LiveHostState["status"];
  host: LiveRunningHost | null;
  error: string | null;
  lastUsedAt: Date;
  /** Set while a start is queued or running. */
  starting: Promise<void> | null;
}

export interface LiveHostManagerOptions {
  sessionId: number;
  plan: LiveSessionPlan;
  backend: LiveHostBackend;
  /** Called after every change of the host list (the worker persists `hosts`). */
  onChange: (hosts: LiveHostState[]) => void;
  /** Default LIVE_MAX_HOSTS_PER_SIDE. */
  maxHostsPerSide?: number;
  now?: () => Date;
  /** Absolute paths stripped from host errors. */
  stripPaths?: readonly string[];
}

/** Hosts of one session, per (side, render group), started lazily (16 §12.4, E19). */
export class LiveHostManager {
  private readonly entries = new Map<string, HostEntry>();
  private readonly sideQueues: Record<WorktreeSide, Promise<void>> = {
    base: Promise.resolve(),
    head: Promise.resolve()
  };
  private readonly abort = new AbortController();
  private readonly maxHostsPerSide: number;
  private readonly now: () => Date;
  private readonly log;
  private stopped = false;

  constructor(private readonly options: LiveHostManagerOptions) {
    this.maxHostsPerSide = options.maxHostsPerSide ?? LIVE_MAX_HOSTS_PER_SIDE;
    this.now = options.now ?? ((): Date => new Date());
    this.log = createLogger("live", { sessionId: options.sessionId });
  }

  /** The host list as stored in `live_sessions.hosts` (side, then group order). */
  snapshot(): LiveHostState[] {
    return [...this.entries.values()]
      .sort((a, b) => (a.side === b.side ? a.group.index - b.group.index : a.side === "base" ? -1 : 1))
      .map((entry) => ({
        side: entry.side,
        groupKey: entry.group.key,
        componentIds: [...entry.componentIds],
        status: entry.status,
        origin: entry.status === "ready" ? (entry.host?.origin ?? null) : null,
        harnessUrlPath: entry.status === "ready" ? (entry.host?.harnessUrlPath ?? null) : null,
        error: entry.error,
        lastUsedAt: entry.lastUsedAt.toISOString()
      }));
  }

  /**
   * Opens a card (16 §12.3 step 4): ensures the hosts of the component's group on every side it exists on. Starts run
   * in the background (the returned promise settles when they have); unknown components are ignored.
   *
   * @returns False when the component is not part of the plan.
   */
  open(componentId: number): { known: boolean; done: Promise<void> } {
    const groupIndex = this.options.plan.groupOf.get(componentId);
    const group = groupIndex === undefined ? undefined : this.options.plan.groups[groupIndex];
    const item = group?.items.find((candidate) => candidate.candidate.componentId === componentId);
    if (group === undefined || item === undefined || this.stopped) {
      return { known: false, done: Promise.resolve() };
    }
    const starts = SIDES.filter((side) => item.sides[side]).map((side) => this.ensure(side, group));
    return { known: true, done: Promise.all(starts).then(() => undefined) };
  }

  /** Marks ready hosts whose process or server died as failed (opening the card again restarts them). */
  checkHealth(): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.status === "ready" && entry.host !== null && !entry.host.isAlive()) {
        const reason = entry.host.exitReason() ?? "stopped";
        entry.status = "failed";
        entry.error = `The live server of the ${entry.side} side stopped unexpectedly (${reason}). Open the card again to restart it.`;
        entry.host = null;
        changed = true;
        this.log.warn(
          {
            event: "live.host.failed",
            sessionId: this.options.sessionId,
            side: entry.side,
            groupKey: entry.group.key,
            reason
          },
          "Live host died"
        );
      }
    }
    if (changed) {
      this.emit();
    }
  }

  /** Stops every host and start in flight, then the backend. Never throws; idempotent. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    this.abort.abort("stopped");
    const pending = [...this.entries.values()]
      .map((entry) => entry.starting)
      .filter((p): p is Promise<void> => p !== null);
    await Promise.allSettled(pending);
    for (const entry of this.entries.values()) {
      await this.stopEntry(entry, "stopped");
    }
    try {
      await this.options.backend.close();
    } catch (error: unknown) {
      this.log.warn({ event: "live.host.close_failed", err: error }, "Live backend close failed");
    }
    this.emit();
  }

  /** Read through a method so a check after an await is not narrowed away by the one before it. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private key(side: WorktreeSide, group: LiveGroupPlan): string {
    return `${side}\u0000${String(group.index)}`;
  }

  private ensure(side: WorktreeSide, group: LiveGroupPlan): Promise<void> {
    const key = this.key(side, group);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        side,
        group,
        componentIds: group.items.filter((item) => item.sides[side]).map((item) => item.candidate.componentId),
        status: "stopped",
        host: null,
        error: null,
        lastUsedAt: this.now(),
        starting: null
      };
      this.entries.set(key, entry);
    }
    entry.lastUsedAt = this.now();
    if (entry.starting !== null) {
      this.emit();
      return entry.starting;
    }
    if (entry.status === "ready" && entry.host?.isAlive() === true) {
      this.emit();
      return Promise.resolve();
    }
    entry.status = "starting";
    entry.error = null;
    entry.host = null;
    this.emit();
    const current = entry;
    const run = this.sideQueues[side].then(() => this.start(current));
    current.starting = run.finally(() => {
      current.starting = null;
    });
    this.sideQueues[side] = current.starting.catch(() => undefined);
    return current.starting;
  }

  private async start(entry: HostEntry): Promise<void> {
    if (this.isStopped()) {
      entry.status = "stopped";
      return;
    }
    await this.evictFor(entry);
    const startedAt = Date.now();
    try {
      const host = await this.options.backend.start(entry.side, entry.group, this.abort.signal);
      if (this.isStopped()) {
        await host.stop();
        entry.status = "stopped";
        return;
      }
      entry.host = host;
      entry.status = "ready";
      entry.error = host.note;
      this.log.info(
        {
          event: "live.host.started",
          sessionId: this.options.sessionId,
          side: entry.side,
          groupKey: entry.group.key,
          port: portOf(host.origin),
          ms: Date.now() - startedAt
        },
        "Live host started"
      );
    } catch (error: unknown) {
      entry.host = null;
      entry.status = this.isStopped() ? "stopped" : "failed";
      entry.error = this.isStopped() ? null : hostErrorText(error, this.options.stripPaths ?? []);
      if (!this.isStopped()) {
        this.log.warn(
          {
            event: "live.host.failed",
            sessionId: this.options.sessionId,
            side: entry.side,
            groupKey: entry.group.key,
            ms: Date.now() - startedAt,
            err: error
          },
          "Live host failed to start"
        );
      }
    } finally {
      this.emit();
    }
  }

  /** Stops least recently used ready hosts of the side until one more fits (16 §12.4). */
  private async evictFor(entry: HostEntry): Promise<void> {
    const running = (): HostEntry[] =>
      [...this.entries.values()].filter(
        (other) => other.side === entry.side && other !== entry && other.status === "ready"
      );
    while (running().length >= this.maxHostsPerSide) {
      const victim = running().sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime())[0];
      if (victim === undefined) {
        return;
      }
      await this.stopEntry(victim, "evicted");
      this.emit();
    }
  }

  private async stopEntry(entry: HostEntry, why: "stopped" | "evicted"): Promise<void> {
    const host = entry.host;
    entry.host = null;
    if (why === "stopped" || entry.status !== "failed") {
      entry.status = "stopped";
      entry.error = null;
    }
    if (host === null) {
      return;
    }
    try {
      await host.stop();
    } catch (error: unknown) {
      this.log.warn({ event: "live.host.stop_failed", err: error }, "Live host stop failed");
    }
    this.log.info(
      {
        event: "live.host.stopped",
        sessionId: this.options.sessionId,
        side: entry.side,
        groupKey: entry.group.key,
        port: portOf(host.origin),
        reason: why
      },
      "Live host stopped"
    );
  }

  private emit(): void {
    try {
      this.options.onChange(this.snapshot());
    } catch (error: unknown) {
      this.log.warn({ event: "live.hosts.persist_failed", err: error }, "Host list change handler failed");
    }
  }
}

function portOf(origin: string): number | null {
  try {
    const port = Number.parseInt(new URL(origin).port, 10);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}
