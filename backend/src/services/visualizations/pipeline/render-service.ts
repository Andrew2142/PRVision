/**
 * RenderService (10 §5.13, 16 §9): the `rendering` stage. Writes the harness workspace of both worktrees, starts the
 * repository's own Vite per side and render group, renders every state of every component on every present side in
 * headless Chromium (one page per component, state and side), asks sheet 09 to repair a harness written in this run
 * once when a state failed on every present side, keeps the better attempt and persists render results (component
 * row, per-state rows and, when kept, the repaired harness) per component.
 *
 * Throws only PipelineStepError (stage "rendering"); per-component and per-side problems are captured in the
 * results and persisted.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  HARNESS_MAX_REPAIRS_PER_COMPONENT,
  RENDER_COLD_START_ALLOWANCE_MS,
  RENDER_GROUP_MAX_ITEMS,
  RENDER_INFRA_RETRIES,
  RENDER_ITEM_CONCURRENCY,
  RENDER_MAX_CAPTURE_HEIGHT_PX,
  RENDER_STAGE_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  RENDER_VIEWPORTS
} from "../../../config-consts";
import { Table } from "../../../enums";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type ComponentRenderResult,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type MockedModule,
  type PipelineContext,
  type RenderSideResult,
  type StateRenderResult
} from "../../../types/visualization-pipeline";
import { DEFAULT_STATE_NAME, type HarnessStep } from "../../../types/harness-library";
import {
  ArtifactStore,
  createLogger,
  DrizzleDb,
  getErrorMessage,
  QueryHandler,
  redactSecrets,
  type Transaction
} from "../../../utilities";
import { persistComponentStates } from "./component-state-persistence";
import { targetImportPath, viteRootRelOf } from "./harness-prompts";
import {
  assertInside,
  assertTemplatesPresent,
  BrowserLaunchError,
  BrowserSession,
  BUDGET_EXCEEDED_HEADLINE,
  buildRenderGroups,
  errorSummaryLine,
  fileMissingHeadline,
  formatRenderError,
  harnessRootRelative,
  HarnessTemplatesMissingError,
  HarnessWorkspaceWriter,
  headlineFor,
  isRepairableFailure,
  isTwoSidedItem,
  mockFingerprint,
  normalizeErrorText,
  planItemStates,
  renderStageBudgetMs,
  repairedHarnessPayload,
  sideHarnessOf,
  sideHarnessResult,
  sideMocksOf,
  sideRenderError,
  splitLargeGroups,
  twoSidedFingerprint,
  withRepairedSide,
  resolveSideLayout,
  rewriteTargetSpecifier,
  scanReferencedEnvKeys,
  truncateRenderError,
  ViteHostClient,
  ViteHostStartError,
  type HarnessSideLayout,
  type MockEntryInput,
  type PageRenderOutcome,
  type RenderFailureKind,
  type RenderGroup,
  type RenderSide,
  type RenderWorkItem,
  type StatePlan,
  type ViteHostHandle,
  type ViteHostStartOptions
} from "./render";
import { candidateBasePath } from "./replaced-components";
import { mockHash, validateMockedModules } from "./vite-mock-plugin";

const RENDER_STAGE = "rendering";
const HARNESS_NOTES_MAX_CHARS = 4_000;
const NOTES_TRUNCATION_SUFFIX = "… [truncated]";
const SIDES: readonly RenderSide[] = ["base", "head"];
const VITE_CONFIG_TEMP_DIR_NAME = ".vite-temp";

// ---------------------------------------------------------------------------------------------------------------
// Public API (10 §5.13.1, authoritative per 00 §14.7)
// ---------------------------------------------------------------------------------------------------------------

export interface RenderComponentInput {
  candidate: ComponentCandidate;
  harness: HarnessGenerationResult; // only components with a validated harness are rendered (09 owns the rest)
  basePath: string | null; // repo-relative path on base (≠ filePath for renamed components and R of a replaced row); null for "added"
}

/**
 * Pure helper for 07: joins 09's results to their candidates (by componentId, in candidate rank order) and
 * computes basePath with 08's basePathFor (R's file for a replaced row, 00 §17). Candidates without a harness are
 * omitted.
 */
export function buildRenderInputs(
  candidates: readonly ComponentCandidate[],
  harnesses: readonly HarnessGenerationResult[],
  changedFiles: ChangeAnalysisResult["changedFiles"]
): RenderComponentInput[] {
  const byComponent = new Map(harnesses.map((harness) => [harness.componentId, harness] as const));
  const inputs: RenderComponentInput[] = [];
  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
    const harness = byComponent.get(candidate.componentId);
    if (harness === undefined) {
      continue;
    }
    inputs.push({
      candidate,
      harness,
      basePath: candidateBasePath(candidate, changedFiles)
    });
  }
  return inputs;
}

/** Same signature as 09's HarnessGenerationService.repairHarness; 07 passes a closure over the 09 instance. */
export type RepairHarnessFn = (
  componentId: number,
  previous: HarnessGenerationResult,
  renderError: HarnessRenderError // message = formatRenderError output (10 §5.12.3)
) => Promise<HarnessRepairOutcome>; // passed through unchanged: verdicts carry notesAppendix

export interface RenderArtifactStore {
  imagePaths(
    visualizationId: number,
    componentId: number,
    kind: RenderSide
  ): { absolutePath: string; relativePath: string };
  ensureComponentDir(visualizationId: number, componentId: number): Promise<void>;
  /** 16 §6.14: `artifacts/<v>/<c>/<kind>.png` for ordinal 0, `artifacts/<v>/<c>/s<ordinal>/<kind>.png` for 1–9. */
  stateImagePaths(
    visualizationId: number,
    componentId: number,
    ordinal: number,
    kind: RenderSide
  ): { absolutePath: string; relativePath: string };
  /** mkdir -p of the component dir and, for ordinal > 0, its s<ordinal> subfolder. */
  ensureComponentStateDir(visualizationId: number, componentId: number, ordinal: number): Promise<void>;
}

export interface ComponentRenderPersistence {
  saveRenderResult(componentId: number, payload: ComponentRenderPayload): Promise<void>; // throws on failure
}

/** One state's render on both sides, persisted as a `visualization_component_states` row (16 §9.2, §9.4). */
export interface StateRenderPayload {
  ordinal: number;
  stateName: string;
  onBase: boolean;
  onHead: boolean;
  steps: HarnessStep[];
  renderStatus: "rendered" | "partial" | "failed";
  baseImagePath: string | null;
  headImagePath: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  baseError: string | null;
  headError: string | null;
  baseFailureKind: RenderFailureKind | null;
  headFailureKind: RenderFailureKind | null;
}

export interface ComponentRenderPayload {
  renderStatus: "rendered" | "partial" | "failed";
  baseImagePath: string | null;
  headImagePath: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  baseError: string | null;
  headError: string | null;
  /** Only when the repaired attempt was kept: the repaired harness replaces the original (09 never persists repairs). */
  harness?: { harnessSource: string; harnessNotes: string; mockedModules: MockedModule[] };
  /** Only when repair returned a verdict (component_defect / cannot_render): original notes + "\n\n" + notesAppendix (capped at 4 000). */
  harnessNotes?: string;
  /** 00 §17, replaced rows: the base-side harness of a kept repaired attempt (written to the base_harness columns). */
  baseHarness?: { harnessSource: string; harnessNotes: string; mockedModules: MockedModule[] };
  /** 00 §17, replaced rows: base-side notes after a repair verdict on the base harness. */
  baseHarnessNotes?: string;
  /** 16 §9.2: one entry per rendered state (Default included); [] for rows that never reached a page. */
  states: StateRenderPayload[];
}

/** Narrow interface over BrowserSession so tests can stub it. */
export type RenderBrowserSession = Pick<
  BrowserSession,
  "renderComponent" | "closeAllContexts" | "close" | "isConnected"
>;

export interface RenderServiceDependencies {
  repairHarness: RepairHarnessFn;
  createPersistence: (visualizationId: number) => ComponentRenderPersistence; // default: new QueryHandlerRenderPersistence(id)
  artifactStore: RenderArtifactStore;
  workspaceWriter: HarnessWorkspaceWriter;
  launchBrowser: () => Promise<RenderBrowserSession>; // BrowserSession.launch
  startViteHost: (
    options: ViteHostStartOptions,
    harnessUrlPath: string,
    signal: AbortSignal
  ) => Promise<ViteHostHandle>; // ViteHostClient.start
  scanEnvKeys: (roots: string[]) => Promise<string[]>;
  now: () => number;
}

/** Persists render results through QueryHandler (the default persistence facade; it sets updated_at). */
export class QueryHandlerRenderPersistence implements ComponentRenderPersistence {
  /**
   * @param visualizationId - The run.
   * @param queryHandler - When given (tests), every statement runs on it without a transaction.
   * @param runInTransaction - Default DrizzleDb.transaction (used only without an explicit queryHandler).
   */
  constructor(
    private readonly visualizationId: number,
    private readonly queryHandler: QueryHandler | null = null,
    private readonly runInTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) =>
      DrizzleDb.transaction(fn)
  ) {}

  /**
   * Writes the render columns (and the repaired harness or verdict notes) of one component row and replaces its
   * state rows (16 §9.4), in one transaction.
   *
   * @throws Error when a statement fails.
   */
  async saveRenderResult(componentId: number, payload: ComponentRenderPayload): Promise<void> {
    if (this.queryHandler !== null) {
      await this.write(this.queryHandler, componentId, payload);
      return;
    }
    await this.runInTransaction(async (tx) => {
      await this.write(new QueryHandler(tx), componentId, payload);
    });
  }

  private async write(queryHandler: QueryHandler, componentId: number, payload: ComponentRenderPayload): Promise<void> {
    const row: Record<string, unknown> = {
      renderStatus: payload.renderStatus,
      baseImagePath: payload.baseImagePath,
      headImagePath: payload.headImagePath,
      imageWidth: payload.imageWidth,
      imageHeight: payload.imageHeight,
      baseError: payload.baseError,
      headError: payload.headError
    };
    if (payload.harness) {
      row.harnessSource = payload.harness.harnessSource;
      row.harnessNotes = payload.harness.harnessNotes;
      row.mockedModules = payload.harness.mockedModules;
    } else if (payload.harnessNotes !== undefined) {
      row.harnessNotes = payload.harnessNotes;
    }
    if (payload.baseHarness) {
      row.baseHarnessSource = payload.baseHarness.harnessSource;
      row.baseHarnessNotes = payload.baseHarness.harnessNotes;
      row.baseMockedModules = payload.baseHarness.mockedModules;
    } else if (payload.baseHarnessNotes !== undefined) {
      row.baseHarnessNotes = payload.baseHarnessNotes;
    }
    const response = await queryHandler.update(
      row,
      { id: componentId, visualizationId: this.visualizationId },
      Table.VISUALIZATION_COMPONENTS
    );
    if (response.status !== 200) {
      throw new Error(
        `visualization_components update failed for id ${String(componentId)}: ${String(response.error ?? response.status)}`
      );
    }
    await persistComponentStates(queryHandler, this.visualizationId, componentId, payload.states);
  }
}

/** RenderArtifactStore over sheet 04's ArtifactStore (componentImagePath + resolveSafe). */
export class ArtifactStoreRenderAdapter implements RenderArtifactStore {
  constructor(private readonly store: ArtifactStore = new ArtifactStore()) {}

  /** Data-dir-relative and absolute path of `artifacts/<v>/<c>/<side>.png`. */
  imagePaths(
    visualizationId: number,
    componentId: number,
    kind: RenderSide
  ): { absolutePath: string; relativePath: string } {
    const relativePath = this.store.componentImagePath(visualizationId, componentId, kind);
    return { relativePath, absolutePath: this.store.resolveSafe(relativePath) };
  }

  /** mkdir -p of the component's artifact dir. */
  async ensureComponentDir(visualizationId: number, componentId: number): Promise<void> {
    await this.store.ensureComponentDir(visualizationId, componentId);
  }

  /** Paths of one state's image (16 §6.14). */
  stateImagePaths(
    visualizationId: number,
    componentId: number,
    ordinal: number,
    kind: RenderSide
  ): { absolutePath: string; relativePath: string } {
    const relativePath = this.store.componentStateImagePath(visualizationId, componentId, ordinal, kind);
    return { relativePath, absolutePath: this.store.resolveSafe(relativePath) };
  }

  /** mkdir -p of one state's artifact dir. */
  async ensureComponentStateDir(visualizationId: number, componentId: number, ordinal: number): Promise<void> {
    await this.store.ensureComponentStateDir(visualizationId, componentId, ordinal);
  }
}

/** Production wiring of every dependency except `repairHarness`. */
export function defaultRenderDependencies(): Omit<RenderServiceDependencies, "repairHarness"> {
  return {
    createPersistence: (visualizationId) => new QueryHandlerRenderPersistence(visualizationId),
    artifactStore: new ArtifactStoreRenderAdapter(),
    workspaceWriter: new HarnessWorkspaceWriter(),
    launchBrowser: () => BrowserSession.launch(),
    startViteHost: (options, harnessUrlPath, signal) => ViteHostClient.start(options, harnessUrlPath, signal),
    scanEnvKeys: scanReferencedEnvKeys,
    now: () => Date.now()
  };
}

/** One state's status (16 §9.3): every present side ok → rendered, some → partial, none → failed. */
export function deriveStateStatus(
  base: Pick<RenderSideResult, "ok"> | null,
  head: Pick<RenderSideResult, "ok"> | null
): "rendered" | "partial" | "failed" {
  const sides = [base, head].filter((side): side is Pick<RenderSideResult, "ok"> => side !== null);
  const okCount = sides.filter((side) => side.ok).length;
  if (sides.length === 0 || okCount === 0) {
    return "failed";
  }
  return okCount === sides.length ? "rendered" : "partial";
}

/**
 * Row status (16 §9.3): with states, rendered when every state rendered, failed when every state failed, else
 * partial; without states (rows that never reached a page), from the Default sides as before.
 */
export function deriveRenderStatus(result: ComponentRenderResult): "rendered" | "partial" | "failed" {
  if (result.states.length === 0) {
    return deriveStateStatus(result.base, result.head);
  }
  const statuses = result.states.map((state) => deriveStateStatus(state.base, state.head));
  if (statuses.every((status) => status === "rendered")) {
    return "rendered";
  }
  return statuses.every((status) => status === "failed") ? "failed" : "partial";
}

export interface SideAttempt {
  result: RenderSideResult;
  kind: RenderFailureKind | null;
  tempImagePath: string | null;
}

/** One state's render of an attempt (16 §9.2). A side is null when the state does not exist there. */
export interface StateAttempt {
  plan: StatePlan;
  base: SideAttempt | null;
  head: SideAttempt | null;
}

export interface ItemAttempt {
  attemptNo: number;
  harness: HarnessGenerationResult;
  /** Mirror state 0 (Default). */
  base: SideAttempt | null;
  head: SideAttempt | null;
  /** 16 §9.2: every state in ordinal order. */
  states: StateAttempt[];
}

/** An attempt from its states; `base`/`head` mirror state 0. */
export function attemptOf(attemptNo: number, harness: HarnessGenerationResult, states: StateAttempt[]): ItemAttempt {
  const first = states[0];
  return { attemptNo, harness, base: first?.base ?? null, head: first?.head ?? null, states };
}

/** Prefers primary-side successes, summed over states (16 §9.6); ties go to the repaired attempt. */
export function chooseAttempt(
  primarySide: RenderSide,
  original: ItemAttempt,
  repaired: ItemAttempt
): "original" | "repaired" {
  const stateScore = (state: Pick<StateAttempt, "base" | "head">): number =>
    (state[primarySide]?.result.ok === true ? 2 : 0) +
    (state.base?.result.ok === true ? 1 : 0) +
    (state.head?.result.ok === true ? 1 : 0);
  const score = (attempt: ItemAttempt): number =>
    attempt.states.length === 0
      ? stateScore(attempt)
      : attempt.states.reduce((sum, state) => sum + stateScore(state), 0);
  return score(repaired) >= score(original) ? "repaired" : "original";
}

const STATE_PREFIX = (name: string): string => (name === DEFAULT_STATE_NAME ? "" : `State "${name}": `);

/**
 * The result and the render columns of a finalized attempt (16 §9.2, §9.3): `base`/`head` and the row images
 * mirror state 0; the row errors are each side's first failing state, prefixed with the state name when it is not
 * Default; one StateRenderPayload per state.
 */
export function composeRenderOutcome(
  componentId: number,
  attempt: ItemAttempt
): { result: ComponentRenderResult; payload: ComponentRenderPayload } {
  const states: StateRenderResult[] = attempt.states.map((state) => ({
    ordinal: state.plan.ordinal,
    stateName: state.plan.name,
    base: state.base?.result ?? null,
    head: state.head?.result ?? null
  }));
  const result: ComponentRenderResult = {
    componentId,
    base: attempt.base?.result ?? null,
    head: attempt.head?.result ?? null,
    states
  };
  const firstError = (side: RenderSide): string | null => {
    for (const state of attempt.states) {
      const sideResult = state[side]?.result;
      if (sideResult?.ok === false) {
        return `${STATE_PREFIX(state.plan.name)}${sideResult.error ?? ""}`;
      }
    }
    const mirror = result[side];
    return mirror?.ok === false ? mirror.error : null;
  };
  const sizeSource = result.head?.ok === true ? result.head : result.base?.ok === true ? result.base : null;
  const payloadStates: StateRenderPayload[] = attempt.states.map((state) => {
    const base = state.base?.result ?? null;
    const head = state.head?.result ?? null;
    const size = head?.ok === true ? head : base?.ok === true ? base : null;
    return {
      ordinal: state.plan.ordinal,
      stateName: state.plan.name,
      onBase: state.plan.onBase,
      onHead: state.plan.onHead,
      steps: state.plan.steps,
      renderStatus: deriveStateStatus(base, head),
      baseImagePath: base?.ok === true ? base.imagePath : null,
      headImagePath: head?.ok === true ? head.imagePath : null,
      imageWidth: size?.width ?? null,
      imageHeight: size?.height ?? null,
      baseError: base?.ok === false ? base.error : null,
      headError: head?.ok === false ? head.error : null,
      baseFailureKind: base?.ok === false ? (state.base?.kind ?? base.failureKind) : null,
      headFailureKind: head?.ok === false ? (state.head?.kind ?? head.failureKind) : null
    };
  });
  return {
    result,
    payload: {
      renderStatus: deriveRenderStatus(result),
      baseImagePath: result.base?.ok === true ? result.base.imagePath : null,
      headImagePath: result.head?.ok === true ? result.head.imagePath : null,
      imageWidth: sizeSource?.width ?? null,
      imageHeight: sizeSource?.height ?? null,
      baseError: firstError("base"),
      headError: firstError("head"),
      states: payloadStates
    }
  };
}

/** The state (and side) whose failure triggers the single fix-up of a written harness (16 §9.6), or null. */
export function repairTarget(
  item: Pick<RenderWorkItem, "primarySide" | "repairsUsed" | "origin">,
  attempt: ItemAttempt
): StateAttempt | null {
  if (item.origin === "library" || item.repairsUsed >= HARNESS_MAX_REPAIRS_PER_COMPONENT) {
    return null;
  }
  const other = otherSide(item.primarySide);
  for (const state of attempt.states) {
    const primary = state[item.primarySide];
    if (primary === null || primary.result.ok || primary.kind === null || !isRepairableFailure(primary.kind)) {
      continue;
    }
    const otherAttempt = state[other];
    if (otherAttempt === null || !otherAttempt.result.ok) {
      return state;
    }
  }
  return null;
}

/**
 * Replaced rows (00 §17, 16 §9.6): per side whose harness was written in this run, the first state that failed on
 * that side with a repairable kind, while the side has repair budget left.
 */
export function sideRepairTargets(
  item: Pick<RenderWorkItem, "origin" | "baseOrigin" | "sideRepairsUsed">,
  attempt: ItemAttempt
): Array<{ side: RenderSide; state: StateAttempt }> {
  const targets: Array<{ side: RenderSide; state: StateAttempt }> = [];
  for (const side of SIDES) {
    const origin = side === "base" ? (item.baseOrigin ?? item.origin) : item.origin;
    if (origin === "library" || (item.sideRepairsUsed?.[side] ?? 0) >= HARNESS_MAX_REPAIRS_PER_COMPONENT) {
      continue;
    }
    const state = attempt.states.find((candidate) => {
      const sideAttempt = candidate[side];
      return (
        sideAttempt !== null &&
        !sideAttempt.result.ok &&
        sideAttempt.kind !== null &&
        isRepairableFailure(sideAttempt.kind)
      );
    });
    if (state !== undefined) {
      targets.push({ side, state });
    }
  }
  return targets;
}

/** HarnessRenderError for 09 (09 §5.1, 16 §9.6) from the state that triggered repair. */
export function stateRenderError(
  item: Pick<RenderWorkItem, "primarySide" | "sides">,
  state: StateAttempt
): HarnessRenderError {
  const primary = state[item.primarySide];
  if (primary === null) {
    throw new Error("Invariant: stateRenderError called without a primary-side attempt");
  }
  const kind = primary.kind;
  if (kind !== "module_load" && kind !== "render_error" && kind !== "timeout" && kind !== "step_failed") {
    throw new Error("Invariant: stateRenderError called for a non-repairable failure");
  }
  const other = state[otherSide(item.primarySide)];
  const otherError = other?.result.error ?? null;
  return {
    sides: SIDES.filter((side) => item.sides[side]),
    kind,
    message: primary.result.error ?? "",
    otherSideMessage: otherError !== null && otherError !== "" ? otherError.slice(0, 1_000) : null,
    ...(state.plan.name !== DEFAULT_STATE_NAME ? { stateName: state.plan.name } : {})
  };
}

/** Runs `fn` over `items` with at most `concurrency` in flight (16 §9.2 item pool). */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** " (Overdue)" for a non-Default state, "" for Default: appended to console lines about one state. */
export function stateSuffix(name: string): string {
  return name === DEFAULT_STATE_NAME ? "" : ` (${name})`;
}

/**
 * Console lines of a finalized attempt (both render engines): one info line when every state rendered, else one
 * warning per failed state and side. A saved (library) harness failing for a harness-attributable reason gets the
 * 16 §18 "Repair it from the card" line instead.
 */
export async function reportStateAttempt(
  item: Pick<RenderWorkItem, "candidate" | "origin" | "baseOrigin">,
  attempt: ItemAttempt,
  write: (level: "info" | "warn", message: string) => Promise<void>
): Promise<void> {
  const name = item.candidate.displayName;
  const states = attempt.states.length > 0 ? attempt.states : [];
  const allOk = states.every((state) => SIDES.every((side) => state[side] === null || state[side].result.ok));
  if (allOk) {
    const parts = [describeSide(attempt.base, "base"), describeSide(attempt.head, "head")].filter(
      (part): part is string => part !== null
    );
    const count = states.length > 1 ? ` (${String(states.length)} states)` : "";
    await write("info", `Rendered ${name}: ${parts.join(", ")}${count}.`);
    return;
  }
  for (const state of states) {
    for (const side of SIDES) {
      const sideAttempt = state[side];
      if (sideAttempt === null || sideAttempt.result.ok) {
        continue;
      }
      const origin = side === "base" ? (item.baseOrigin ?? item.origin) : item.origin;
      const summary = errorSummaryLine(sideAttempt.result.error ?? "");
      if (origin === "library" && sideAttempt.kind !== null && isRepairableFailure(sideAttempt.kind)) {
        await write(
          "warn",
          `${name}: the saved harness no longer renders on the ${side} side (${state.plan.name}: ${summary}). Repair it from the card.`
        );
        continue;
      }
      await write(
        "warn",
        `${name}${stateSuffix(state.plan.name)}: ${side} failed (${sideAttempt.kind ?? "error"}): ${summary}`
      );
    }
  }
}

/** Renders the components of one visualization (one RenderRun per call). */
export class RenderService {
  private readonly deps: RenderServiceDependencies;

  constructor(overrides: Partial<RenderServiceDependencies> & Pick<RenderServiceDependencies, "repairHarness">) {
    this.deps = { ...defaultRenderDependencies(), ...overrides };
  }

  /**
   * Renders every present side of every input.
   *
   * @param ctx - Pipeline context of the visualization.
   * @param inputs - From buildRenderInputs (rank order).
   * @returns One result per finished component, in input order (components unfinished because of cancellation
   *   are omitted).
   * @throws PipelineStepError (stage "rendering") for fatal problems (browser, templates, harness IO, persistence).
   */
  async renderAll(ctx: PipelineContext, inputs: RenderComponentInput[]): Promise<ComponentRenderResult[]> {
    const run = new RenderRun(ctx, this.deps);
    return run.execute(inputs);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// RenderRun (per-call state)
// ---------------------------------------------------------------------------------------------------------------

type HostSlot =
  | {
      state: "ready";
      handle: ViteHostHandle;
      rendered: number;
      /** Pages started on this host (the cold-start allowance goes to the first page only, 16 §9.2). */
      started: number;
      labels: Map<string, string>;
      stylesChecked: boolean;
      /** A stylesheet check is running on an in-flight page (items render concurrently). */
      stylesCheckPending: boolean;
    }
  | { state: "failed"; message: string }
  | { state: "not_needed" };

interface SideLayouts {
  base: HarnessSideLayout;
  head: HarnessSideLayout;
}

interface RepairEntry {
  item: RenderWorkItem;
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

class RenderRun {
  private readonly log: ReturnType<typeof createLogger>;
  private readonly persistence: ReturnType<RenderServiceDependencies["createPersistence"]>;
  private deadline = 0;
  private budgetMs = RENDER_STAGE_TIMEOUT_MS;
  private cancelled = false;
  private budgetExceeded = false;
  private readonly results = new Map<number, ComponentRenderResult>();
  private readonly payloads = new Map<number, ComponentRenderPayload>();
  private session: RenderBrowserSession | null = null;
  private relaunchUsed = false;
  private relaunching: Promise<boolean> | null = null;
  private readonly liveHosts = new Set<ViteHostHandle>();
  private readonly brokenSides: Record<RenderSide, string | null> = { base: null, head: null };
  private readonly hostAnnounced: Record<RenderSide, boolean> = { base: false, head: false };
  private readonly warningsForwarded: Record<RenderSide, boolean> = { base: false, head: false };
  private readonly stylesheetWarned: Record<RenderSide, boolean> = { base: false, head: false };
  private readonly writtenComponents: Record<RenderSide, Set<number>> = { base: new Set(), head: new Set() };
  private readonly tempImages = new Set<string>();
  private repairQueue: RepairEntry[] = [];
  private classNameWarned = false;
  private groupCounter = 0;
  private totalGroups = 0;
  private stripPaths: string[] = [];
  /** `<real node_modules>/.vite-temp` → whether it existed when the run started. */
  private readonly viteTempDirs = new Map<string, boolean>();

  constructor(
    private readonly ctx: PipelineContext,
    private readonly deps: RenderServiceDependencies
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
    let items: RenderWorkItem[] = [];
    try {
      // 0. Templates must exist (fatal otherwise).
      await assertTemplatesPresent(this.deps.workspaceWriter.templatesDir);
      // 1. Layouts and plan.
      const layouts = await this.resolveLayouts();
      items = await this.planItems(inputs, layouts);
      if (items.length > 0) {
        // 2. Workspaces.
        await this.prepareWorkspaces(layouts, items);
        const envKeys = await this.deps.scanEnvKeys([layouts.base.viteRoot, layouts.head.viteRoot]);
        const groups = splitLargeGroups(buildRenderGroups(items), RENDER_GROUP_MAX_ITEMS);
        this.totalGroups = groups.length;
        this.budgetMs = renderStageBudgetMs("react_vite", items, groups);
        this.deadline = startedAt + this.budgetMs;
        this.log.info(
          { event: "render.run.started", components: items.length, groups: groups.length },
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
        // 3. Browser (fatal on failure).
        this.session = await this.launchBrowserOrThrow();
        this.ctx.signal.addEventListener("abort", onAbort, { once: true });
        // 4. Groups.
        for (const group of groups) {
          if (await this.shouldStop()) {
            break;
          }
          await this.renderGroup(group, layouts, envKeys);
        }
        // 5. Repair rounds.
        await this.runRepairRounds(layouts, envKeys);
        // 6. Budget exceeded → remaining items failed (persisted). Cancelled → remaining items untouched.
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
        ...this.counts()
      },
      "Render run finished"
    );
    return this.orderedResults(inputs);
  }

  // ----- fatal errors -----

  private toStepError(error: unknown): PipelineStepError {
    let stepError: PipelineStepError;
    if (error instanceof PipelineStepError) {
      stepError = error;
    } else if (error instanceof RenderPersistError) {
      stepError = new PipelineStepError(RENDER_STAGE, "Could not save render results.", {
        code: "RENDER_PERSIST_FAILED",
        cause: error.cause
      });
    } else if (error instanceof HarnessTemplatesMissingError) {
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

  // ----- console -----

  private async console(level: "info" | "warn" | "error", message: string): Promise<void> {
    try {
      await this.ctx.console[level](RENDER_STAGE, redactSecrets(message));
    } catch (error) {
      this.log.warn({ event: "render.console.failed", err: error }, "Writing a console event failed");
    }
  }

  // ----- stop conditions -----

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

  // ----- planning -----

  private async resolveLayouts(): Promise<SideLayouts> {
    const viteConfigPath = this.ctx.repository.viteConfigPath;
    const build = async (side: RenderSide, worktreeDir: string): Promise<HarnessSideLayout> => {
      let layout: HarnessSideLayout;
      try {
        layout = resolveSideLayout(side, worktreeDir, viteConfigPath);
      } catch (error) {
        throw new PipelineStepError(RENDER_STAGE, `Could not write render harness files: ${getErrorMessage(error)}`, {
          code: "RENDER_HARNESS_WRITE_FAILED",
          cause: error
        });
      }
      if (layout.configFile !== null && !(await fileExists(layout.configFile))) {
        layout = { ...layout, configFile: null };
      }
      return layout;
    };
    const [base, head] = await Promise.all([
      build("base", this.ctx.workspace.baseDir),
      build("head", this.ctx.workspace.headDir)
    ]);
    for (const layout of [base, head]) {
      const nodeModules = await realpathOrNull(path.join(layout.viteRoot, "node_modules"));
      if (nodeModules !== null) {
        const tempDir = path.join(nodeModules, VITE_CONFIG_TEMP_DIR_NAME);
        if (!this.viteTempDirs.has(tempDir)) {
          this.viteTempDirs.set(tempDir, await directoryExists(tempDir));
        }
      }
    }
    this.stripPaths = [
      base.worktreeDir,
      head.worktreeDir,
      this.ctx.repository.localPath,
      ...(await Promise.all([realpathOrNull(base.worktreeDir), realpathOrNull(head.worktreeDir)])).filter(
        (entry): entry is string => entry !== null
      )
    ];
    return { base, head };
  }

  private async planItems(inputs: readonly RenderComponentInput[], layouts: SideLayouts): Promise<RenderWorkItem[]> {
    const items: RenderWorkItem[] = [];
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

      const paths = {
        base: input.basePath,
        head: candidate.changeKind === "removed" ? null : candidate.filePath
      };
      const sides = { base: paths.base !== null, head: paths.head !== null };
      if (!sides.base && !sides.head) {
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
            headError: "Component file not found on either side.",
            states: []
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
        const layout = layouts[side];
        const absolute = path.join(layout.worktreeDir, sidePath);
        try {
          assertInside(layout.worktreeDir, absolute);
        } catch (error) {
          plannedFailures[side] = {
            kind: "file_missing",
            error: this.formatPlanned("file_missing", getErrorMessage(error))
          };
          continue;
        }
        if (!(await fileExists(absolute))) {
          plannedFailures[side] = {
            kind: "file_missing",
            error: this.formatPlanned("file_missing", fileMissingHeadline(sidePath, side))
          };
          await this.console("warn", `${candidate.displayName}: ${fileMissingHeadline(sidePath, side)}`);
        }
      }

      const item = this.buildItem(candidate, harness, paths, sides, plannedFailures, layouts);
      await this.reportRejectedMocks(candidate, harness.mockedModules);
      if (isTwoSidedItem(item)) {
        await this.reportRejectedMocks(candidate, sideHarnessOf(harness, "base").mockedModules);
      }

      const presentSides = SIDES.filter((side) => sides[side]);
      if (presentSides.every((side) => plannedFailures[side] !== null)) {
        // No side on disk: final failed result immediately (no servers needed).
        const attempt = attemptOf(
          0,
          harness,
          item.states.map((plan) => ({
            plan,
            base: plan.onBase ? this.plannedAttempt(item, "base") : null,
            head: plan.onHead ? this.plannedAttempt(item, "head") : null
          }))
        );
        await this.finalizeAttempt(item, attempt, "original");
        continue;
      }
      items.push(item);
    }
    return items;
  }

  private buildItem(
    candidate: ComponentCandidate,
    harness: HarnessGenerationResult,
    paths: RenderWorkItem["paths"],
    sides: RenderWorkItem["sides"],
    plannedFailures: RenderWorkItem["plannedFailures"],
    layouts: SideLayouts
  ): RenderWorkItem {
    const item: RenderWorkItem = {
      candidate,
      harness,
      paths,
      acceptedMocks: [],
      fingerprint: "none",
      sides,
      primarySide: sides.head ? "head" : "base",
      repairsUsed: 0,
      mockLabels: new Map(),
      plannedFailures,
      states: [],
      origin: harness.origin
    };
    this.applyHarness(item, harness, layouts);
    return item;
  }

  /**
   * Sets the harness, accepted mocks, fingerprint and mock labels of an item. A replaced row (00 §17) keeps one mock
   * list per side, each from that side's own harness, and its group key covers both.
   */
  private applyHarness(item: RenderWorkItem, harness: HarnessGenerationResult, layouts: SideLayouts): void {
    item.harness = harness;
    item.origin = harness.origin;
    item.acceptedMocks = validateMockedModules(harness.mockedModules).accepted;
    if (isTwoSidedItem(item)) {
      item.baseOrigin = sideHarnessOf(harness, "base").origin;
      item.baseAcceptedMocks = validateMockedModules(sideHarnessOf(harness, "base").mockedModules).accepted;
      item.fingerprint = twoSidedFingerprint(
        item.paths.base ?? item.candidate.filePath,
        item.baseAcceptedMocks,
        item.paths.head ?? item.candidate.filePath,
        item.acceptedMocks
      );
    } else {
      item.fingerprint = mockFingerprint(
        item.paths.head ?? item.paths.base ?? item.candidate.filePath,
        item.acceptedMocks
      );
    }
    item.mockLabels = new Map();
    for (const side of SIDES) {
      const sidePath = item.paths[side];
      if (sidePath === null) {
        continue;
      }
      const componentFile = path.join(layouts[side].worktreeDir, sidePath);
      for (const mock of sideMocksOf(item, side)) {
        item.mockLabels.set(mockHash(componentFile, mock.specifier, mock.source), mock.specifier);
      }
    }
    item.states = planItemStates(item); // a repaired harness may declare other states (16 §9.6)
  }

  private async reportRejectedMocks(candidate: ComponentCandidate, mocks: readonly MockedModule[]): Promise<void> {
    for (const rejection of validateMockedModules(mocks).rejected) {
      await this.console(
        "warn",
        `Mock "${rejection.specifier}" for ${candidate.displayName} was ignored: ${rejection.reason}.`
      );
    }
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

  /** Defensive normalization of a session error: no absolute worktree/clone paths, no secrets, capped length. */
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

  private async prepareWorkspaces(layouts: SideLayouts, items: readonly RenderWorkItem[]): Promise<void> {
    try {
      for (const side of SIDES) {
        const layout = layouts[side];
        const { missingStyles } = await this.deps.workspaceWriter.prepareSide(
          layout,
          this.ctx.repository.globalStylePaths
        );
        for (const missing of missingStyles) {
          await this.console("warn", `Global style ${missing.replace(/^\//, "")} does not exist on the ${side} side.`);
        }
      }
      for (const item of items) {
        await this.writeItemHarness(item, layouts);
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

  /**
   * Writes components/<id>.tsx on every present side whose file exists; the base side imports the old path of a
   * rename. A replaced row (00 §17) writes each side's own harness, which already imports that side's target.
   */
  private async writeItemHarness(item: RenderWorkItem, layouts: SideLayouts): Promise<void> {
    const source = item.harness.harnessSource;
    const twoSided = isTwoSidedItem(item);
    if (
      !this.classNameWarned &&
      (source.includes("className=") ||
        (twoSided && sideHarnessOf(item.harness, "base").harnessSource.includes("className=")))
    ) {
      this.classNameWarned = true;
      await this.console(
        "warn",
        `Harness for ${item.candidate.displayName} uses className; Tailwind classes in harness files may not be generated.`
      );
    }
    for (const side of SIDES) {
      if (!item.sides[side] || item.plannedFailures[side]?.kind === "file_missing") {
        continue;
      }
      let sideSource = sideHarnessOf(item.harness, side).harnessSource;
      const basePath = item.paths.base;
      const headPath = item.paths.head;
      if (!twoSided && side === "base" && basePath !== null && headPath !== null && basePath !== headPath) {
        const viteRootRel = viteRootRelOf(this.ctx.repository.viteConfigPath);
        try {
          sideSource = rewriteTargetSpecifier(
            source,
            targetImportPath(headPath, viteRootRel),
            targetImportPath(basePath, viteRootRel)
          );
          item.plannedFailures.base = null;
        } catch (error) {
          item.plannedFailures.base = {
            kind: "module_load",
            error: this.formatPlanned("module_load", getErrorMessage(error))
          };
          continue;
        }
      }
      await this.deps.workspaceWriter.writeComponentHarness(layouts[side], item.candidate.componentId, sideSource);
      this.writtenComponents[side].add(item.candidate.componentId);
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

  /** Relaunches Chromium at most once per run. Returns false when no usable browser is available. */
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
      const old = this.session;
      await settle(old?.close(), this.log);
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

  // ----- groups and hosts -----

  private async renderGroup(group: RenderGroup, layouts: SideLayouts, envKeys: string[]): Promise<void> {
    this.groupCounter += 1;
    const groupNo = this.groupCounter;
    const needs = {
      base: group.items.some((item) => item.sides.base && item.plannedFailures.base === null),
      head: group.items.some((item) => item.sides.head && item.plannedFailures.head === null)
    };
    const [base, head] = await Promise.all([
      this.openHost("base", group, layouts.base, envKeys, needs.base, groupNo),
      this.openHost("head", group, layouts.head, envKeys, needs.head, groupNo)
    ]);
    try {
      // 16 §9.2: RENDER_ITEM_CONCURRENCY items at a time; each renders its states in order, base ∥ head.
      let stopped = false;
      await runPool(group.items, RENDER_ITEM_CONCURRENCY, async (item) => {
        if (stopped || (await this.shouldStop())) {
          stopped = true;
          return;
        }
        const attempt = await this.renderItem(item, { base, head }, item.repairsUsed);
        if (attempt === null) {
          stopped = true; // cancelled mid-item
          return;
        }
        await this.finalizeAttempt(item, attempt, "original");
        if (this.needsRepair(item, attempt)) {
          this.repairQueue.push({ item, attempt });
        }
      });
    } finally {
      await Promise.all([this.closeHost(base), this.closeHost(head)]);
    }
  }

  private async openHost(
    side: RenderSide,
    group: RenderGroup,
    layout: HarnessSideLayout,
    envKeys: string[],
    needed: boolean,
    groupNo: number
  ): Promise<HostSlot> {
    if (!needed) {
      return { state: "not_needed" };
    }
    const broken = this.brokenSides[side];
    if (broken !== null) {
      return { state: "failed", message: broken };
    }
    const groupItems = group.items.filter((item) => item.sides[side] && item.plannedFailures[side] === null);
    const mocks: MockEntryInput[] = [];
    const labels = new Map<string, string>();
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
        labels.set(mockHash(componentFile, mock.specifier, mock.source), mock.specifier);
      }
    }
    const componentFile = (id: number): string => harnessRootRelative(layout, "components", `${String(id)}.tsx`);
    const options: ViteHostStartOptions = {
      side,
      groupKey: group.key,
      worktreeDir: layout.worktreeDir,
      viteRoot: layout.viteRoot,
      harnessDir: layout.harnessDir,
      cacheDir: layout.cacheDir,
      configFile: layout.configFile,
      optimizeEntries: [
        harnessRootRelative(layout, "entry.tsx"),
        harnessRootRelative(layout, "globals.ts"),
        ...[...this.writtenComponents[side]].sort((a, b) => a - b).map(componentFile)
      ],
      warmupFiles: [
        harnessRootRelative(layout, "entry.tsx"),
        ...groupItems.map((item) => componentFile(item.candidate.componentId))
      ],
      referencedEnvKeys: envKeys,
      mocks
    };
    const startedAt = this.deps.now();
    try {
      const handle = await this.deps.startViteHost(options, layout.harnessUrlPath, this.ctx.signal);
      this.liveHosts.add(handle);
      const seconds = ((this.deps.now() - startedAt) / 1000).toFixed(1);
      if (!this.hostAnnounced[side]) {
        this.hostAnnounced[side] = true;
        await this.console("info", `Vite ${handle.viteVersion} ready for the ${side} side in ${seconds} s.`);
      } else {
        this.log.debug(
          { event: "render.vite_host.ready", side, groupKey: group.key, group: groupNo, groups: this.totalGroups },
          "Vite host ready for another render group"
        );
      }
      if (!this.warningsForwarded[side]) {
        this.warningsForwarded[side] = true;
        for (const warning of handle.warnings) {
          await this.console(warning.startsWith("Removed dev-only") ? "info" : "warn", warning);
        }
      }
      return {
        state: "ready",
        handle,
        rendered: 0,
        started: 0,
        labels,
        stylesChecked: false,
        stylesCheckPending: false
      };
    } catch (error) {
      if (this.ctx.signal.aborted) {
        return { state: "failed", message: "Cancelled." };
      }
      const startError =
        error instanceof ViteHostStartError ? error : new ViteHostStartError(getErrorMessage(error), "exited", null);
      const message = redactSecrets(startError.message);
      if (startError.sticky) {
        this.brokenSides[side] = message;
        await this.console("error", `Vite could not start on the ${side} side: ${message}`);
      } else {
        await this.console(
          "warn",
          `Vite on the ${side} side failed to start for render group ${String(groupNo)}: ${message}`
        );
      }
      return { state: "failed", message };
    }
  }

  private async closeHost(slot: HostSlot): Promise<void> {
    if (slot.state !== "ready") {
      return;
    }
    await settle(slot.handle.stop(), this.log);
    this.liveHosts.delete(slot.handle);
  }

  // ----- rendering one item -----

  /** Renders every state in ordinal order, base ∥ head per state (a state absent on a side is not requested). */
  private async renderItem(
    item: RenderWorkItem,
    hosts: { base: HostSlot; head: HostSlot },
    attemptNo: number
  ): Promise<ItemAttempt | null> {
    const harness = item.harness;
    const states: StateAttempt[] = [];
    for (const plan of item.states) {
      const [base, head] = await Promise.all([
        item.sides.base && plan.onBase
          ? this.renderSide(item, "base", hosts.base, attemptNo, plan)
          : Promise.resolve(null),
        item.sides.head && plan.onHead
          ? this.renderSide(item, "head", hosts.head, attemptNo, plan)
          : Promise.resolve(null)
      ]);
      states.push({ plan, base, head });
      if (base?.kind === "cancelled" || head?.kind === "cancelled" || this.ctx.signal.aborted) {
        this.cancelled = true;
        for (const state of states) {
          for (const side of [state.base, state.head]) {
            if (side?.tempImagePath) {
              await removeQuietly(side.tempImagePath);
              this.tempImages.delete(side.tempImagePath);
            }
          }
        }
        return null;
      }
    }
    return attemptOf(attemptNo, harness, states);
  }

  private sideFailure(side: RenderSide, kind: RenderFailureKind, headline: string, durationMs = 0): SideAttempt {
    return {
      result: failedSideResult(side, kind, this.formatPlanned(kind, headline), durationMs),
      kind,
      tempImagePath: null
    };
  }

  private async renderSide(
    item: RenderWorkItem,
    side: RenderSide,
    slot: HostSlot,
    attemptNo: number,
    state: StatePlan
  ): Promise<SideAttempt> {
    const name = `${item.candidate.displayName}${stateSuffix(state.name)}`;
    const componentId = item.candidate.componentId;
    const planned = item.plannedFailures[side];
    if (planned !== null) {
      return { result: failedSideResult(side, planned.kind, planned.error), kind: planned.kind, tempImagePath: null };
    }
    if (slot.state === "failed") {
      return this.sideFailure(side, "vite_unavailable", slot.message);
    }
    if (slot.state === "not_needed") {
      return this.sideFailure(side, "vite_unavailable", "No Vite dev server was started for this side.");
    }
    if (!slot.handle.isAlive()) {
      return this.sideFailure(
        side,
        "vite_unavailable",
        `The Vite dev server exited (${slot.handle.exitReason() ?? "unknown"}).`
      );
    }

    const final = this.deps.artifactStore.stateImagePaths(this.ctx.visualizationId, componentId, state.ordinal, side);
    const tempImagePath = `${final.absolutePath}.attempt${String(attemptNo)}.png`;
    try {
      await this.deps.artifactStore.ensureComponentStateDir(this.ctx.visualizationId, componentId, state.ordinal);
    } catch (error) {
      return this.sideFailure(side, "screenshot", `Could not create the artifact folder: ${getErrorMessage(error)}`);
    }

    let outcome: PageRenderOutcome | null = null;
    let retries = 0;
    for (;;) {
      const budget = this.deadline - this.deps.now();
      const coldStart = slot.started === 0;
      slot.started += 1;
      const timeoutMs = Math.min(RENDER_TIMEOUT_MS + (coldStart ? RENDER_COLD_START_ALLOWANCE_MS : 0), budget);
      if (timeoutMs <= 0) {
        return this.sideFailure(side, "budget_exceeded", BUDGET_EXCEEDED_HEADLINE);
      }
      if (!(await this.ensureBrowser()) || this.session === null) {
        return this.sideFailure(side, "browser", "Chromium disconnected and could not be restarted.");
      }
      this.tempImages.add(tempImagePath);
      const checkStyles = !slot.stylesChecked && !slot.stylesCheckPending;
      slot.stylesCheckPending ||= checkStyles;
      outcome = await this.session.renderComponent({
        host: slot.handle,
        componentId,
        stateName: state.name,
        timeoutMs,
        outputPath: tempImagePath,
        signal: this.ctx.signal,
        checkStylesheets: checkStyles
          ? {
              globalStylesExpected: this.ctx.repository.globalStylePaths.length > 0,
              tailwindMajor: slot.handle.tailwindMajor
            }
          : null,
        viewport: RENDER_VIEWPORTS[this.ctx.repository.renderViewport ?? "desktop"],
        mockLabels: slot.labels,
        stripPaths: this.stripPaths
      });
      slot.rendered += 1;
      if (checkStyles) {
        slot.stylesCheckPending = false; // a failed page leaves the check to the next page (stylesChecked stays false)
      }
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
          {
            event: "render.page.failed",
            componentId,
            side,
            state: state.ordinal,
            kind: outcome.kind,
            error: error.slice(0, 500)
          },
          "Side render failed"
        );
      }
      return {
        result: failedSideResult(side, outcome.kind, error, outcome.durationMs, outcome.consoleErrors),
        kind: outcome.kind,
        tempImagePath: null
      };
    }

    slot.stylesChecked = true;
    if (outcome.mode === "empty") {
      await this.console("warn", `${name} rendered nothing on the ${side} side.`);
    }
    if (!outcome.stable) {
      await this.console("warn", `${name} did not stabilise on the ${side} side; using the last frame.`);
    }
    if (outcome.truncated) {
      await this.console(
        "warn",
        `${name} is taller than ${String(RENDER_MAX_CAPTURE_HEIGHT_PX)} px on the ${side} side; the image is truncated.`
      );
    }
    if (outcome.stylesheetWarning !== null && !this.stylesheetWarned[side]) {
      this.stylesheetWarned[side] = true;
      await this.console("warn", outcome.stylesheetWarning);
    }
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

  // ----- finalize and persist -----

  private async finalizeAttempt(
    item: RenderWorkItem,
    attempt: ItemAttempt,
    which: "original" | "repaired"
  ): Promise<void> {
    const componentId = item.candidate.componentId;
    for (const state of attempt.states) {
      for (const side of SIDES) {
        const sideAttempt = state[side];
        if (sideAttempt === null) {
          continue;
        }
        const final = this.deps.artifactStore.stateImagePaths(
          this.ctx.visualizationId,
          componentId,
          state.plan.ordinal,
          side
        );
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
    }
    const finalized = attemptOf(attempt.attemptNo, attempt.harness, attempt.states);
    const { result, payload } = composeRenderOutcome(componentId, finalized);
    await this.persist(componentId, {
      ...payload,
      ...(which === "repaired" ? repairedHarnessPayload(attempt.harness) : {})
    });
    this.results.set(componentId, result);
    await this.reportAttempt(item, finalized);
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

  private async reportAttempt(item: RenderWorkItem, attempt: ItemAttempt): Promise<void> {
    await reportStateAttempt(item, attempt, (level, message) => this.console(level, message));
  }

  // ----- repair (10 §5.13.6) -----

  /** 16 §9.6: only harnesses written in this run, per state in ordinal order (per side for replaced rows). */
  private needsRepair(item: RenderWorkItem, attempt: ItemAttempt): boolean {
    if (isTwoSidedItem(item)) {
      return sideRepairTargets(item, attempt).length > 0; // 00 §17: per side
    }
    return repairTarget(item, attempt) !== null;
  }

  private async runRepairRounds(layouts: SideLayouts, envKeys: string[]): Promise<void> {
    while (this.repairQueue.length > 0) {
      // Items render concurrently (16 §9.2): repair in rank order, not completion order.
      const queue = [...this.repairQueue].sort(
        (a, b) =>
          a.item.candidate.rank - b.item.candidate.rank || a.item.candidate.componentId - b.item.candidate.componentId
      );
      this.repairQueue = [];
      const repaired: RepairEntry[] = [];
      for (const entry of queue) {
        if (await this.shouldStop()) {
          return;
        }
        const ready = await this.requestRepair(entry, layouts);
        if (ready) {
          repaired.push(entry);
        }
      }
      if (repaired.length === 0) {
        continue;
      }
      const originals = new Map(repaired.map((entry) => [entry.item.candidate.componentId, entry] as const));
      for (const group of buildRenderGroups(repaired.map((entry) => entry.item))) {
        if (await this.shouldStop()) {
          return;
        }
        await this.renderRepairGroup(group, layouts, envKeys, originals);
      }
    }
  }

  /**
   * Repairs each failed side's own harness of a replaced row (00 §17); returns true when at least one side got a
   * repaired harness, which was written and must be rendered.
   */
  private async requestSideRepairs(entry: RepairEntry, layouts: SideLayouts): Promise<boolean> {
    const { item, attempt } = entry;
    const componentId = item.candidate.componentId;
    const used = { ...item.sideRepairsUsed };
    let harness = item.harness;
    let repairedAny = false;
    for (const { side, state } of sideRepairTargets(item, attempt)) {
      const sideAttempt = state[side];
      if (sideAttempt === null) {
        continue;
      }
      const name =
        side === "base"
          ? (item.candidate.predecessor?.displayName ?? item.candidate.displayName)
          : item.candidate.displayName;
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
          sideRenderError(side, sideAttempt, state.plan.name)
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
        await this.reportRejectedMocks(item.candidate, outcome.result.mockedModules);
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
    item.sideRepairsUsed = used;
    if (!repairedAny) {
      item.harness = harness;
      return false;
    }
    this.applyHarness(item, harness, layouts);
    item.repairsUsed += 1;
    try {
      await this.writeItemHarness(item, layouts);
    } catch (error) {
      throw new PipelineStepError(RENDER_STAGE, `Could not write render harness files: ${getErrorMessage(error)}`, {
        code: "RENDER_HARNESS_WRITE_FAILED",
        cause: error
      });
    }
    return true;
  }

  /** Calls 09's repairHarness; returns true when a repaired harness was written and must be rendered. */
  private async requestRepair(entry: RepairEntry, layouts: SideLayouts): Promise<boolean> {
    if (isTwoSidedItem(entry.item)) {
      return this.requestSideRepairs(entry, layouts);
    }
    const { item, attempt } = entry;
    const componentId = item.candidate.componentId;
    const name = item.candidate.displayName;
    const target = repairTarget(item, attempt);
    if (target === null) {
      return false;
    }
    const primary = target[item.primarySide];
    await this.console(
      "info",
      `Repairing the harness for ${name}${stateSuffix(target.plan.name)} after a render failure (${item.primarySide}: ${primary?.kind ?? "error"}).`
    );
    this.log.info({ event: "render.repair.requested", componentId }, "Harness repair requested");
    let outcome: HarnessRepairOutcome;
    try {
      outcome = await this.deps.repairHarness(componentId, item.harness, stateRenderError(item, target));
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
          const harnessNotes = capNotes(`${item.harness.notes}\n\n${outcome.notesAppendix}`);
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

    this.applyHarness(item, outcome.result, layouts);
    item.repairsUsed += 1;
    await this.reportRejectedMocks(item.candidate, outcome.result.mockedModules);
    try {
      await this.writeItemHarness(item, layouts);
    } catch (error) {
      throw new PipelineStepError(RENDER_STAGE, `Could not write render harness files: ${getErrorMessage(error)}`, {
        code: "RENDER_HARNESS_WRITE_FAILED",
        cause: error
      });
    }
    return true;
  }

  private async renderRepairGroup(
    group: RenderGroup,
    layouts: SideLayouts,
    envKeys: string[],
    originals: ReadonlyMap<number, RepairEntry>
  ): Promise<void> {
    this.groupCounter += 1;
    const groupNo = this.groupCounter;
    const needs = {
      base: group.items.some((item) => item.sides.base && item.plannedFailures.base === null),
      head: group.items.some((item) => item.sides.head && item.plannedFailures.head === null)
    };
    const [base, head] = await Promise.all([
      this.openHost("base", group, layouts.base, envKeys, needs.base, groupNo),
      this.openHost("head", group, layouts.head, envKeys, needs.head, groupNo)
    ]);
    try {
      for (const item of group.items) {
        if (await this.shouldStop()) {
          return;
        }
        const original = originals.get(item.candidate.componentId);
        if (original === undefined) {
          continue;
        }
        const repaired = await this.renderItem(item, { base, head }, item.repairsUsed);
        if (repaired === null) {
          return;
        }
        const name = item.candidate.displayName;
        const componentId = item.candidate.componentId;
        if (chooseAttempt(item.primarySide, original.attempt, repaired) === "repaired") {
          await this.finalizeAttempt(item, repaired, "repaired");
          const summary = [describeSide(repaired.base, "base"), describeSide(repaired.head, "head")]
            .filter((part): part is string => part !== null)
            .join(", ");
          await this.console("info", `Repaired harness rendered ${name}: ${summary}.`);
          this.log.info({ event: "render.repair.result", componentId, outcome: "applied" }, "Repaired harness kept");
          if (this.needsRepair(item, repaired)) {
            this.repairQueue.push({ item, attempt: repaired });
          }
        } else {
          for (const state of repaired.states) {
            for (const side of SIDES) {
              const temp = state[side]?.tempImagePath ?? null;
              if (temp !== null) {
                await removeQuietly(temp);
                this.tempImages.delete(temp);
              }
            }
          }
          item.harness = original.attempt.harness;
          item.states = original.attempt.states.map((state) => state.plan);
          await this.console(
            "info",
            `Repaired harness for ${name} did not improve the result; keeping the first result.`
          );
          this.log.info(
            { event: "render.repair.result", componentId, outcome: "kept_original" },
            "Original attempt kept"
          );
        }
      }
    } finally {
      await Promise.all([this.closeHost(base), this.closeHost(head)]);
    }
  }

  // ----- budget, results, cleanup -----

  private async failUnfinishedIfBudgetExceeded(items: readonly RenderWorkItem[]): Promise<void> {
    if (!this.budgetExceeded || this.cancelled) {
      return;
    }
    const unfinished = items.filter((item) => !this.results.has(item.candidate.componentId));
    if (unfinished.length === 0) {
      return;
    }
    const minutes = Math.round(this.budgetMs / 60_000);
    await this.console(
      "warn",
      `The render stage exceeded its ${String(minutes)}-minute budget; ${String(unfinished.length)} component(s) were not rendered.`
    );
    for (const item of unfinished) {
      const attempt = attemptOf(
        item.repairsUsed,
        item.harness,
        item.states.map((plan) => ({
          plan,
          base:
            item.sides.base && plan.onBase
              ? this.sideFailure("base", "budget_exceeded", BUDGET_EXCEEDED_HEADLINE)
              : null,
          head:
            item.sides.head && plan.onHead
              ? this.sideFailure("head", "budget_exceeded", BUDGET_EXCEEDED_HEADLINE)
              : null
        }))
      );
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

  private async abortInFlight(): Promise<void> {
    await settle(this.session?.closeAllContexts(), this.log);
    await Promise.all([...this.liveHosts].map((host) => settle(host.stop(), this.log)));
  }

  /** Contexts, hosts, browser and unfinalized temp images. Never throws. */
  private async cleanup(): Promise<void> {
    await settle(this.session?.closeAllContexts(), this.log);
    await Promise.all([...this.liveHosts].map((host) => settle(host.stop(), this.log)));
    this.liveHosts.clear();
    await settle(this.session?.close(), this.log);
    for (const temp of this.tempImages) {
      await removeQuietly(temp);
    }
    this.tempImages.clear();
    await this.removeViteConfigTempDirs();
  }

  /**
   * Vite 6/7 bundle the config into `<node_modules>/.vite-temp/` (the user's real node_modules, through the worktree
   * symlink) and delete the file but not the folder. Remove the folder again when this run created it and it is
   * empty (rmdir never deletes content).
   */
  private async removeViteConfigTempDirs(): Promise<void> {
    for (const [dir, existedBefore] of this.viteTempDirs) {
      if (existedBefore) {
        continue;
      }
      try {
        await fs.rmdir(dir);
      } catch {
        // Not created, or not empty (another Vite is using it): leave it.
      }
    }
  }
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
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
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
