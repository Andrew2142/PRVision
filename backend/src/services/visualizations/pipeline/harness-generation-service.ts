/**
 * HarnessGenerationService (09 §5.9–5.11): the generating_harnesses stage. One instance per visualization; the
 * orchestrator (07) calls generateAll() and hands the same instance to the render stage (10), which calls
 * repairHarness() after a render failure.
 *
 * - generateAll persists every generation outcome (harness fields, or render_status skipped/failed with the side
 *   errors for components that never render, 00 §14.7) through a HarnessResultPersistence (default: the
 *   visualization_components row; scans pass NoopHarnessPersistence, 16 §8.6.1) and throws only PipelineStepError
 *   (auth/config AI errors, persistence failures). Options (16 §8.6.1) pick the sides to write per row, the state
 *   allowance and the prompt purpose; `shouldStartCall` (scans' spending cap, 16 §10.5) can stop new AI calls.
 * - repairHarness never writes visualization_components and never throws: 10 persists the attempt it keeps.
 * - Every AI call's usage, including usage attached to AiProviderError, goes through AiUsageRecorder.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import {
  HARNESS_CONCURRENCY_ANTHROPIC_API,
  HARNESS_CONCURRENCY_CLAUDE_CODE,
  HARNESS_MAX_CALLS_PER_COMPONENT,
  HARNESS_MAX_REPAIRS_PER_COMPONENT,
  HARNESS_RETRY_DELAY_MS
} from "../../../config-consts";
import { ComponentRenderStatus, Table } from "../../../enums";
import { VisualizationComponentModel } from "../../../models";
import {
  AiProviderError,
  PipelineStepError,
  type AiStructuredRequest,
  type AiUsage,
  type ComponentCandidate,
  type ComponentSourceQueries,
  type HarnessGenerationBatchResult,
  type HarnessGenerationFailure,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type PipelineContext,
  type SideHarness,
  type WorktreeSide
} from "../../../types/visualization-pipeline";
import { QueryHandler, ZERO_USAGE, addUsage, createLogger, getErrorMessage, redactSecrets } from "../../../utilities";
import { AiUsageRecorder } from "./ai-usage-recorder";
import {
  HarnessContextBuilder,
  SafeFileReader,
  type HarnessContextOptions,
  type HarnessContextPackage
} from "./harness-context-builder";
import { REACT_HARNESS_PROMPTS, type HarnessAiResponse, type HarnessPromptSet } from "./harness-prompts";
import {
  HarnessValidator,
  type HarnessValidationInput,
  type HarnessValidationIssue,
  type HarnessValidationReport
} from "./harness-validator";
import { extractHarnessStates } from "./harness-states";
import { isReplacedCandidate, replacedSideCandidate, type ReplacedCandidate } from "./replaced-components";

const STAGE = "generating_harnesses" as const;
/** Composed harness_notes cap (09 §5.11). */
export const HARNESS_NOTES_MAX_CHARS = 4_000;
/** The model's own notes are cut to this before composing (09 §5.8: "truncated to 2 000 chars on persist"). */
export const HARNESS_RESPONSE_NOTES_MAX_CHARS = 2_000;
/** Calls of one repair: the repair call plus one correction (09 §5.10 step 4). */
export const HARNESS_REPAIR_CALL_BUDGET = 2;
const VERDICT_NOTES_MAX_CHARS = 600;
const UNKNOWN_MESSAGE_MAX_CHARS = 200;
const TRUNCATED_SUFFIX = "… [truncated]";
const NOT_RENDERED_ERROR = "Not rendered: harness generation failed.";

/** Options of one generateAll call (16 §8.6.1). */
export interface HarnessGenerationOptions {
  /** Maximum number of states per harness; default ctx.library.stateAllowance. */
  stateAllowance: number;
  /** Prompt purpose; default `ctx.libraryJob ? "library" : "change"`. */
  purpose: "change" | "library";
  /** Sides to write per componentId; absent = every side the row needs (today). Only `replaced` rows have two. */
  sides?: ReadonlyMap<number, readonly WorktreeSide[]>;
}

/** Where generation outcomes are written (16 §8.6.1). */
export interface HarnessResultPersistence {
  /** Writes one row's generation outcome (harness columns, or the failure status). Throws on failure. */
  saveGenerated(componentId: number, values: Record<string, unknown>): Promise<void>;
}

/** Default persistence: one update of the run's visualization_components row (09 §5.11). */
export class QueryHandlerHarnessPersistence implements HarnessResultPersistence {
  constructor(
    private readonly visualizationId: number,
    private readonly queryHandler: QueryHandler = new QueryHandler()
  ) {}

  async saveGenerated(componentId: number, values: Record<string, unknown>): Promise<void> {
    const response = await this.queryHandler.update(
      values,
      { id: componentId, visualizationId: this.visualizationId },
      Table.VISUALIZATION_COMPONENTS
    );
    if (response.status !== 200) {
      throw new Error(`Saving harness results failed (${String(response.status)})`);
    }
  }
}

/** Writes nothing: scans keep results in memory and save them to the library themselves (16 §10.4). */
export class NoopHarnessPersistence implements HarnessResultPersistence {
  saveGenerated(): Promise<void> {
    return Promise.resolve();
  }
}

/** Injectable collaborators (tests); every field defaults to the real implementation. */
export interface HarnessGenerationDeps {
  queryHandler?: QueryHandler;
  /** Ports (15 §5.6.2): Angular passes AngularHarnessContextBuilder / AngularHarnessValidator. */
  contextBuilder?: Pick<HarnessContextBuilder, "build">;
  validator?: Pick<HarnessValidator, "validate">;
  /** System prompt, schema and prompt builders (15 §5.6.2); default REACT_HARNESS_PROMPTS. */
  prompts?: HarnessPromptSet;
  /** Default AiUsageRecorder of the visualization; scans pass a job recorder (16 §8.6.1). */
  usageRecorder?: Pick<AiUsageRecorder, "add">;
  /** Default QueryHandlerHarnessPersistence (the run's component rows). */
  persistence?: HarnessResultPersistence;
  /** Checked before every AI call (corrections and repairs included); false stops like cancellation (16 §10.5). */
  shouldStartCall?: () => Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // abortable; tests inject instant sleep
  now?: () => number;
}

/** A DB write of this stage failed: fatal for the stage (09 §5.9.3, §5.9.5). */
class HarnessPersistError extends Error {
  override readonly name = "HarnessPersistError";
}

type AiCallOutcome =
  | { kind: "data"; data: HarnessAiResponse }
  | { kind: "cancelled" }
  | { kind: "stopped" } // shouldStartCall refused the call (spending cap)
  | { kind: "fatal"; error: PipelineStepError }
  | { kind: "error"; error: AiProviderError }
  | { kind: "budget_exhausted" };

interface AiCallContext {
  mode: "generate" | "repair";
  componentId: number;
  displayName: string;
  signal: AbortSignal;
  budget: { calls: number; readonly max: number };
  /** Usage of every call made for this harness (16 §8.6.1). */
  usage: AiUsage;
}

type GenerationOutcome =
  | { kind: "ok"; result: HarnessGenerationResult }
  | { kind: "failure"; failure: HarnessGenerationFailure }
  | { kind: "cancelled" }
  | { kind: "stopped" }
  | { kind: "fatal"; error: PipelineStepError };

/** Outcome of one harness (one component side) before anything is persisted. */
type HarnessAttempt =
  | { kind: "ok"; harness: SideHarness; calls: number; warnings: number; usage: AiUsage }
  | { kind: "cannot_render"; response: HarnessAiResponse }
  | {
      kind: "failed";
      pkg: HarnessContextPackage | null;
      failureKind: HarnessGenerationFailure["kind"];
      aiReason: HarnessGenerationFailure["aiReason"];
      message: string;
      lastHarness: string | null;
      issues: readonly HarnessValidationIssue[];
    }
  | { kind: "cancelled" }
  | { kind: "stopped" }
  | { kind: "fatal"; error: PipelineStepError };

/** A finished (not cancelled, stopped or fatal) attempt of one side. */
type SettledAttempt = Exclude<HarnessAttempt, { kind: "cancelled" | "stopped" | "fatal" }>;

const SIDE_ORDER: readonly WorktreeSide[] = ["head", "base"];

/** Key of a context package: the component id, plus `:base` for the base harness of a `replaced` row (00 §17). */
function packageKey(componentId: number, side: WorktreeSide = "head"): string {
  return side === "base" ? `${String(componentId)}:base` : String(componentId);
}

/** Cuts `text` to `max` characters with a visible suffix. */
export function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

/** User-facing message for a per-component AI failure (09 §5.9.3 `userMessageFor`). */
export function userMessageFor(error: AiProviderError): string {
  switch (error.reason) {
    case "refusal": {
      const category = /category:\s*([^)]+)\)/.exec(error.message)?.[1]?.trim() ?? "no category given";
      return `AI declined to write a harness (${category}).`;
    }
    case "max_tokens":
      return "AI response exceeded the output limit.";
    case "invalid_output":
      return "AI returned output that did not match the harness format.";
    case "rate_limit":
      return "AI provider rate limit persisted after retries.";
    case "network":
      return "Could not reach the AI provider (or it timed out).";
    case "auth":
    case "config":
    case "aborted":
    case "unknown":
      return `AI provider error: ${redactSecrets(error.message).slice(0, UNKNOWN_MESSAGE_MAX_CHARS)}`;
  }
}

/** Composed harness_notes of a ready harness (09 §5.11 `composeNotes`). */
export function composeNotes(response: HarnessAiResponse, warnings: readonly HarnessValidationIssue[]): string {
  const parts = [capText(response.notes.trim(), HARNESS_RESPONSE_NOTES_MAX_CHARS)];
  if (response.mockedModules.length > 0) {
    parts.push(["Mocks:", ...response.mockedModules.map((mock) => `- ${mock.specifier} — ${mock.reason}`)].join("\n"));
  }
  if (warnings.length > 0) {
    parts.push(["Validator warnings:", ...warnings.map((warning) => `- ${warning.message}`)].join("\n"));
  }
  return capText(parts.filter((part) => part !== "").join("\n\n"), HARNESS_NOTES_MAX_CHARS);
}

function failedAttempt(
  pkg: HarnessContextPackage | null,
  failureKind: HarnessGenerationFailure["kind"],
  aiReason: HarnessGenerationFailure["aiReason"],
  message: string,
  lastHarness: string | null,
  issues: readonly HarnessValidationIssue[]
): HarnessAttempt {
  return { kind: "failed", pkg, failureKind, aiReason, message, lastHarness, issues };
}

/** Reads `signal.aborted` afresh (it changes while awaiting, which control-flow narrowing cannot see). */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

const INVALID_STATUS_REPORT: HarnessValidationReport = {
  ok: false,
  errors: [
    {
      code: "invalid_status",
      severity: "error",
      message:
        'status component_defect is only valid in repair requests; return status "ok" with a complete harness, or "cannot_render".'
    }
  ],
  warnings: [],
  states: null
};

/** Generates, validates and persists render harnesses; repairs them for sheet 10 (09 §5.9). */
export class HarnessGenerationService {
  private readonly packages = new Map<string, HarnessContextPackage>(); // reused by repairHarness (packageKey)
  private readonly repairsUsed = new Map<string, number>(); // packageKey → repairs (per side for replaced rows)
  private readonly log: Logger;
  private readonly queryHandler: QueryHandler;
  private readonly contextBuilder: Pick<HarnessContextBuilder, "build">;
  private readonly validator: Pick<HarnessValidator, "validate">;
  private readonly prompts: HarnessPromptSet;
  private readonly usageRecorder: Pick<AiUsageRecorder, "add">;
  private readonly persistence: HarnessResultPersistence;
  private readonly shouldStartCall: (() => Promise<boolean>) | null;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private stageUsage: AiUsage = ZERO_USAGE;
  /** Options of the running generateAll call (repairs use the defaults). */
  private options: HarnessGenerationOptions;

  constructor(
    private readonly ctx: PipelineContext,
    private readonly queries: ComponentSourceQueries, // analysis.sourceQueries (08 §5.1.1)
    deps: HarnessGenerationDeps = {}
  ) {
    const reader = new SafeFileReader(ctx.workspace);
    this.queryHandler = deps.queryHandler ?? new QueryHandler();
    this.contextBuilder = deps.contextBuilder ?? new HarnessContextBuilder(ctx, queries, reader);
    this.validator =
      deps.validator ??
      new HarnessValidator(queries, (side, repoRelativePath) => reader.exists(side, repoRelativePath));
    this.prompts = deps.prompts ?? REACT_HARNESS_PROMPTS;
    this.usageRecorder = deps.usageRecorder ?? new AiUsageRecorder(ctx.visualizationId, this.queryHandler);
    this.persistence = deps.persistence ?? new QueryHandlerHarnessPersistence(ctx.visualizationId, this.queryHandler);
    this.shouldStartCall = deps.shouldStartCall ?? null;
    this.options = this.defaultOptions();
    this.sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.now = deps.now ?? Date.now;
    this.log = createLogger("pipeline.harness", { visualizationId: ctx.visualizationId });
  }

  /**
   * Generates a validated harness for every candidate, in rank order: the first one alone, then up to the
   * provider's concurrency. Per-component failures are persisted and returned; cancellation returns
   * `cancelled: true` (stopReason "cancelled") without throwing; a refused AI call (`shouldStartCall`) stops
   * starting work and returns stopReason "spend_cap" while calls in flight finish (16 §10.5).
   *
   * @param options - 16 §8.6.1: sides to write per row, state allowance and prompt purpose.
   * @throws PipelineStepError (stage generating_harnesses) for auth/config AI errors and persistence failures.
   */
  async generateAll(
    candidates: readonly ComponentCandidate[],
    options: Partial<HarnessGenerationOptions> = {}
  ): Promise<HarnessGenerationBatchResult> {
    const ordered = [...candidates].sort((a, b) => a.rank - b.rank);
    this.stageUsage = ZERO_USAGE;
    this.options = { ...this.defaultOptions(), ...options };
    if (ordered.length === 0) {
      await this.ctx.console.info(STAGE, "No components to generate harnesses for.");
      return { results: [], failures: [], usage: ZERO_USAGE, cancelled: false };
    }
    const provider = this.ctx.ai.kind;
    const concurrency =
      provider === "claude_code" ? HARNESS_CONCURRENCY_CLAUDE_CODE : HARNESS_CONCURRENCY_ANTHROPIC_API;
    const { model, harnessEffort: effort } = this.ctx.aiSettings;
    await this.ctx.console.info(
      STAGE,
      `Generating render harnesses for ${count(ordered.length)} components (${provider}, model ${model}, effort ${effort}, concurrency ${concurrency}).`
    );
    this.log.info(
      { event: "harness.stage.started", count: ordered.length, provider, model, effort, concurrency },
      "Harness generation started"
    );

    const internal = new AbortController();
    const signal = AbortSignal.any([this.ctx.signal, internal.signal]); // Node ≥ 22.12
    const state: { fatal: PipelineStepError | null; spendCap: boolean } = { fatal: null, spendCap: false };
    const results: HarnessGenerationResult[] = [];
    const failures: HarnessGenerationFailure[] = [];
    const stop = (): boolean => state.fatal !== null || state.spendCap || signal.aborted;

    const processOne = async (candidate: ComponentCandidate): Promise<void> => {
      if (stop()) {
        return;
      }
      if (await this.ctx.isCancelled()) {
        internal.abort("cancelled");
        return;
      }
      let outcome: GenerationOutcome;
      try {
        outcome = await this.generateOne(candidate, signal);
      } catch (error: unknown) {
        outcome = await this.recoverUnexpected(candidate, error, signal);
      }
      switch (outcome.kind) {
        case "ok":
          results.push(outcome.result);
          return;
        case "failure":
          failures.push(outcome.failure);
          return;
        case "cancelled":
          internal.abort("cancelled");
          return;
        case "stopped":
          state.spendCap = true; // calls in flight finish; nothing new starts (16 E16)
          return;
        case "fatal":
          if (state.fatal === null) {
            state.fatal = outcome.error;
            await this.reportFatal(outcome.error);
          }
          internal.abort("fatal");
          return;
      }
    };

    const [first, ...rest] = ordered;
    if (first !== undefined) {
      await processOne(first);
    }
    await this.runPool(rest, concurrency, processOne, stop);
    if (state.fatal !== null) {
      throw state.fatal; // every in-flight call has settled; nothing else is persisted
    }

    const cancelled = !state.spendCap && (this.ctx.signal.aborted || (await this.ctx.isCancelled()));
    const rank = new Map(ordered.map((candidate) => [candidate.componentId, candidate.rank]));
    results.sort((a, b) => (rank.get(a.componentId) ?? 0) - (rank.get(b.componentId) ?? 0));
    const skipped = failures.filter((failure) => failure.kind === "cannot_render").length;
    const usage = this.stageUsage;
    await this.ctx.console.info(
      STAGE,
      `Harness generation finished: ${count(results.length)} ready, ${count(failures.length - skipped)} failed, ${count(skipped)} not renderable. AI usage this stage: ${count(usage.inputTokens)} input / ${count(usage.outputTokens)} output tokens over ${count(usage.calls)} calls.`
    );
    this.log.info(
      {
        event: "harness.stage.finished",
        ready: results.length,
        failed: failures.length - skipped,
        skipped,
        cancelled,
        usage
      },
      "Harness generation finished"
    );
    if (state.spendCap) {
      await this.ctx.console.warn(STAGE, "Stopped starting new AI calls: the spending cap was reached.");
      return { results, failures, usage, cancelled: false, stopReason: "spend_cap" };
    }
    return { results, failures, usage, cancelled, ...(cancelled ? { stopReason: "cancelled" as const } : {}) };
  }

  /**
   * Asks the AI to fix a harness whose render failed on every present side (09 §5.10). Never persists the
   * component and never throws: every failure is an `{ ok: false }` outcome. At most
   * HARNESS_MAX_REPAIRS_PER_COMPONENT repairs per component.
   */
  async repairHarness(
    componentId: number,
    previous: HarnessGenerationResult,
    renderError: HarnessRenderError
  ): Promise<HarnessRepairOutcome> {
    let outcome: HarnessRepairOutcome;
    try {
      outcome = await this.repair(componentId, previous, renderError);
    } catch (error: unknown) {
      this.log.warn({ event: "harness.repair.result", componentId, err: error }, "Harness repair failed unexpectedly");
      outcome = {
        ok: false,
        reason: "ai_error",
        message: `Harness repair failed: ${redactSecrets(getErrorMessage(error)).slice(0, UNKNOWN_MESSAGE_MAX_CHARS)}`
      };
    }
    this.log.info(
      { event: "harness.repair.result", componentId, outcome: outcome.ok ? "ok" : outcome.reason },
      "Harness repair finished"
    );
    return outcome;
  }

  // ---- generation ----

  private async runPool<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
    stop: () => boolean
  ): Promise<void> {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!stop()) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) {
          return;
        }
        await worker(item);
      }
    });
    await Promise.all(lanes);
  }

  private async generateOne(candidate: ComponentCandidate, signal: AbortSignal): Promise<GenerationOutcome> {
    if (isReplacedCandidate(candidate)) {
      return this.generateReplaced(candidate, signal);
    }
    const started = this.now();
    const attempt = await this.generateHarness(candidate, signal, packageKey(candidate.componentId));
    switch (attempt.kind) {
      case "cancelled":
      case "stopped":
      case "fatal":
        return attempt;
      case "cannot_render":
        return this.skip(candidate, attempt.response);
      case "failed":
        return this.fail(
          candidate,
          attempt.pkg,
          attempt.failureKind,
          attempt.aiReason,
          attempt.message,
          attempt.lastHarness,
          attempt.issues
        );
      case "ok":
        break;
    }
    const result: HarnessGenerationResult = {
      componentId: candidate.componentId,
      ...attempt.harness,
      usage: attempt.usage
    };
    await this.persist(candidate.componentId, {
      harnessSource: result.harnessSource,
      mockedModules: result.mockedModules,
      harnessNotes: result.notes
    });
    await this.ctx.console.info(
      STAGE,
      `Harness ready for ${candidate.displayName} (${candidate.filePath}): ${count(result.mockedModules.length)} mocks.`
    );
    this.log.info(
      {
        event: "harness.generated",
        componentId: candidate.componentId,
        mocks: result.mockedModules.length,
        calls: attempt.calls,
        durationMs: this.now() - started,
        warnings: attempt.warnings
      },
      "Harness generated"
    );
    return { kind: "ok", result };
  }

  /**
   * 00 §17: a `replaced` row gets two harnesses — head for A from head sources, base for R from base sources — each
   * generated, validated and corrected by that side's own rules. Both are persisted in one update (head in the
   * harness columns, base in the base_harness columns). A row renders only when both sides have a harness.
   *
   * 16 §8.6.1: with `options.sides` naming one side, only that side is generated and only its columns are written.
   * `["head"]` returns the head harness with `baseHarness: null`; `["base"]` returns `baseHarness` with empty
   * top-level placeholders. The worker fills the other side from the library before rendering.
   */
  private async generateReplaced(candidate: ReplacedCandidate, signal: AbortSignal): Promise<GenerationOutcome> {
    const started = this.now();
    const wanted = this.sidesToWrite(candidate.componentId);
    const sides: Partial<Record<WorktreeSide, SettledAttempt>> = {};
    for (const side of SIDE_ORDER) {
      if (!wanted.includes(side)) {
        continue;
      }
      const attempt = await this.generateHarness(
        replacedSideCandidate(candidate, side),
        signal,
        packageKey(candidate.componentId, side)
      );
      if (attempt.kind === "cancelled" || attempt.kind === "stopped" || attempt.kind === "fatal") {
        return attempt;
      }
      sides[side] = attempt;
    }
    const { head, base } = sides;
    const label = `${candidate.predecessor.displayName} → ${candidate.displayName}`;
    const allOk = (head === undefined || head.kind === "ok") && (base === undefined || base.kind === "ok");
    if (!allOk) {
      return this.failReplaced(candidate, sides);
    }
    const headHarness = head?.kind === "ok" ? head.harness : null;
    const baseHarness = base?.kind === "ok" ? base.harness : null;
    const usage = addUsage(
      head?.kind === "ok" ? head.usage : ZERO_USAGE,
      base?.kind === "ok" ? base.usage : ZERO_USAGE
    );
    const result: HarnessGenerationResult = {
      componentId: candidate.componentId,
      ...(headHarness ?? {
        harnessSource: "",
        mockedModules: [],
        notes: "",
        states: [],
        origin: "written" as const,
        libraryEntryId: null
      }),
      baseHarness,
      usage
    };
    await this.persist(candidate.componentId, {
      ...(headHarness !== null
        ? {
            harnessSource: headHarness.harnessSource,
            mockedModules: headHarness.mockedModules,
            harnessNotes: headHarness.notes
          }
        : {}),
      ...(baseHarness !== null
        ? {
            baseHarnessSource: baseHarness.harnessSource,
            baseMockedModules: baseHarness.mockedModules,
            baseHarnessNotes: baseHarness.notes
          }
        : {})
    });
    const before = baseHarness === null ? "saved harness" : `${count(baseHarness.mockedModules.length)} mocks`;
    const after = headHarness === null ? "saved harness" : count(headHarness.mockedModules.length);
    await this.ctx.console.info(STAGE, `Harnesses ready for ${label}: ${before} before, ${after} after.`);
    this.log.info(
      {
        event: "harness.generated",
        componentId: candidate.componentId,
        replaced: true,
        sides: wanted,
        mocks: (headHarness?.mockedModules.length ?? 0) + (baseHarness?.mockedModules.length ?? 0),
        calls: (head?.kind === "ok" ? head.calls : 0) + (base?.kind === "ok" ? base.calls : 0),
        durationMs: this.now() - started,
        warnings: (head?.kind === "ok" ? head.warnings : 0) + (base?.kind === "ok" ? base.warnings : 0)
      },
      "Harnesses generated for a replaced component"
    );
    return { kind: "ok", result };
  }

  /**
   * Persists a replaced row whose base or head harness could not be produced (00 §17); nothing is rendered. Only the
   * columns of the sides that were written in this call are touched (16 §8.6.1).
   */
  private async failReplaced(
    candidate: ReplacedCandidate,
    sides: Partial<Record<WorktreeSide, SettledAttempt>>
  ): Promise<GenerationOutcome> {
    const names: Record<WorktreeSide, string> = {
      base: candidate.predecessor.displayName,
      head: candidate.displayName
    };
    const present = SIDE_ORDER.filter((side) => sides[side] !== undefined);
    // the side that stops the row: a failed side first (head before base), else the side that cannot render
    const side: WorktreeSide =
      present.find((candidateSide) => sides[candidateSide]?.kind === "failed") ??
      present.find((candidateSide) => sides[candidateSide]?.kind === "cannot_render") ??
      "head";
    const failing = sides[side];
    const anyFailed = present.some((candidateSide) => sides[candidateSide]?.kind === "failed");
    const sideNotes = (attempt: SettledAttempt): string => {
      switch (attempt.kind) {
        case "ok":
          return attempt.harness.notes;
        case "cannot_render":
          return capText(
            `Not rendered: ${capText(attempt.response.notes.trim(), HARNESS_RESPONSE_NOTES_MAX_CHARS)}`,
            HARNESS_NOTES_MAX_CHARS
          );
        case "failed":
          return capText(
            [
              `Harness generation failed: ${attempt.message}`,
              ...attempt.issues.map((issue) => `- [${issue.code}] ${issue.message}`)
            ].join("\n"),
            HARNESS_NOTES_MAX_CHARS
          );
      }
    };
    const harnessOf = (attempt: SettledAttempt): SideHarness | null => {
      if (attempt.kind === "ok") {
        return attempt.harness;
      }
      if (attempt.kind === "failed" && attempt.lastHarness !== null && attempt.lastHarness.trim() !== "") {
        // The last (invalid) attempt is kept as a snapshot only; its states are read best effort (16 §7.7.1).
        const extraction = extractHarnessStates(attempt.lastHarness, this.ctx.repository.framework, {
          stateAllowance: this.options.stateAllowance,
          allowLegacy: true
        });
        return {
          harnessSource: attempt.lastHarness,
          mockedModules: [],
          notes: "",
          states: extraction.ok ? extraction.states : [],
          origin: "written",
          libraryEntryId: null
        };
      }
      return null;
    };
    const columns: Record<string, unknown> = {};
    if (sides.head !== undefined) {
      const harness = harnessOf(sides.head);
      columns.harnessSource = harness?.harnessSource ?? null;
      columns.mockedModules = harness?.mockedModules ?? [];
      columns.harnessNotes = sideNotes(sides.head);
    }
    if (sides.base !== undefined) {
      const harness = harnessOf(sides.base);
      columns.baseHarnessSource = harness?.harnessSource ?? null;
      columns.baseMockedModules = harness?.mockedModules ?? [];
      columns.baseHarnessNotes = sideNotes(sides.base);
    }
    const message =
      failing?.kind === "failed"
        ? failing.message
        : failing?.kind === "cannot_render"
          ? firstLine(capText(failing.response.notes.trim(), HARNESS_RESPONSE_NOTES_MAX_CHARS))
          : "";
    const sideMessage = `${side === "base" ? "before" : "after"} (${names[side]}): ${message}`;
    await this.persist(candidate.componentId, {
      ...columns,
      renderStatus: anyFailed ? ComponentRenderStatus.FAILED : ComponentRenderStatus.SKIPPED,
      baseError: anyFailed ? NOT_RENDERED_ERROR : null,
      headError: anyFailed ? NOT_RENDERED_ERROR : null
    });
    const kind: HarnessGenerationFailure["kind"] = failing?.kind === "failed" ? failing.failureKind : "cannot_render";
    const aiReason = failing?.kind === "failed" ? failing.aiReason : null;
    const label = `${candidate.predecessor.displayName} → ${candidate.displayName}`;
    if (anyFailed) {
      await this.ctx.console.warn(STAGE, `Harness generation failed for ${label}, ${sideMessage}`);
    } else {
      await this.ctx.console.info(STAGE, `${label} cannot be rendered in isolation, ${sideMessage}`);
    }
    this.log.warn(
      { event: "harness.failed", componentId: candidate.componentId, kind, aiReason, side, replaced: true },
      "Harness generation failed for a replaced component"
    );
    return {
      kind: "failure",
      failure: {
        componentId: candidate.componentId,
        kind,
        aiReason,
        message: capText(sideMessage, HARNESS_NOTES_MAX_CHARS)
      }
    };
  }

  /** 16 §8.6.1: the sides of a `replaced` row to generate in this call (default both). */
  private sidesToWrite(componentId: number): readonly WorktreeSide[] {
    const requested = this.options.sides?.get(componentId);
    return requested !== undefined && requested.length > 0 ? requested : SIDE_ORDER;
  }

  /** Defaults of HarnessGenerationOptions from the context (16 §8.6.1). */
  private defaultOptions(): HarnessGenerationOptions {
    return {
      stateAllowance: this.ctx.library.stateAllowance,
      purpose: this.ctx.libraryJob !== undefined ? "library" : "change"
    };
  }

  /** Package options of the running call (16 §8.6.2). */
  private contextOptions(): HarnessContextOptions {
    return { purpose: this.options.purpose, stateAllowance: this.options.stateAllowance };
  }

  /**
   * One harness: context package, AI call, static checks and at most one correction (09 §5.9.3). Persists nothing;
   * the package is kept under `key` for repair.
   */
  private async generateHarness(
    candidate: ComponentCandidate,
    signal: AbortSignal,
    key: string
  ): Promise<HarnessAttempt> {
    let pkg: HarnessContextPackage;
    try {
      pkg = await this.contextBuilder.build(candidate, this.contextOptions());
    } catch (error: unknown) {
      if (signal.aborted) {
        return { kind: "cancelled" };
      }
      const message = `Could not prepare the harness context: ${redactSecrets(getErrorMessage(error))}`;
      return failedAttempt(null, "context_error", null, message, null, []);
    }
    this.packages.set(key, pkg);

    const request = this.request(pkg, "harness", this.prompts.buildUser(pkg), signal);
    const call: AiCallContext = {
      mode: "generate",
      componentId: candidate.componentId,
      displayName: candidate.displayName,
      signal,
      budget: { calls: 0, max: HARNESS_MAX_CALLS_PER_COMPONENT },
      usage: ZERO_USAGE
    };
    let outcome = await this.callAi(request, call);
    let last: HarnessAiResponse | null = null;
    let report: HarnessValidationReport = INVALID_STATUS_REPORT;
    for (let corrected = false; ; corrected = true) {
      if (outcome.kind !== "data") {
        return this.mapCallFailure(pkg, outcome, last);
      }
      const response = outcome.data;
      last = response;
      if (response.status === "cannot_render") {
        return { kind: "cannot_render", response };
      }
      report =
        response.status === "component_defect"
          ? INVALID_STATUS_REPORT
          : await this.validator.validate(this.validationInput(pkg, response));
      if (report.ok) {
        break;
      }
      this.log.warn(
        {
          event: "harness.validation.failed",
          componentId: candidate.componentId,
          codes: report.errors.map((issue) => issue.code),
          warningCodes: report.warnings.map((issue) => issue.code)
        },
        "Harness failed static checks"
      );
      if (corrected || call.budget.calls >= call.budget.max) {
        break;
      }
      await this.ctx.console.warn(
        STAGE,
        `Harness for ${candidate.displayName} failed static checks (${count(report.errors.length)} issues); asking the AI to correct it.`
      );
      outcome = await this.callAi(
        { ...request, purpose: "harness_repair", prompt: this.prompts.buildCorrection(pkg, response, report.errors) },
        call
      );
    }
    if (!report.ok) {
      const codes = report.errors.slice(0, 3).map((issue) => issue.code);
      const message = `AI harness failed static checks: ${codes.join(", ")}`;
      return failedAttempt(pkg, "invalid_harness", null, message, last.harnessSource, report.errors);
    }
    return {
      kind: "ok",
      harness: {
        harnessSource: last.harnessSource,
        mockedModules: last.mockedModules.map(({ specifier, source }) => ({ specifier, source })),
        notes: composeNotes(last, report.warnings),
        states: report.states ?? [], // a valid report always carries its states (16 §7.7.3)
        origin: "written",
        libraryEntryId: null
      },
      calls: call.budget.calls,
      warnings: report.warnings.length,
      usage: call.usage
    };
  }

  private request(
    pkg: HarnessContextPackage,
    purpose: "harness" | "harness_repair",
    prompt: string,
    signal: AbortSignal
  ): AiStructuredRequest {
    return {
      purpose,
      system: this.prompts.system,
      prompt,
      jsonSchema: this.prompts.schema,
      effort: this.ctx.aiSettings.harnessEffort,
      workingDirectory: pkg.sourceSide === "base" ? this.ctx.workspace.baseDir : this.ctx.workspace.headDir,
      signal
    };
  }

  private validationInput(pkg: HarnessContextPackage, response: HarnessAiResponse): HarnessValidationInput {
    return {
      harnessSource: response.harnessSource,
      mockedModules: response.mockedModules.map(({ specifier, source }) => ({ specifier, source })),
      candidate: pkg.candidate,
      paths: pkg.paths,
      viteRootRel: pkg.viteRootRel,
      targetImportPath: pkg.targetImportPath,
      directImports: pkg.directImports,
      sidesPresent: pkg.sidesPresent,
      entryFilePath: this.ctx.repository.entryFilePath,
      targetImportStatement: pkg.targetImportStatement,
      stateAllowance: pkg.stateAllowance
    };
  }

  /**
   * One AI request with retries for retryable errors inside the component's call budget (09 §5.9.3 callAi).
   * Records the usage of every call, including usage attached to an AiProviderError.
   */
  private async callAi(request: AiStructuredRequest, call: AiCallContext): Promise<AiCallOutcome> {
    for (;;) {
      if (call.budget.calls >= call.budget.max) {
        return { kind: "budget_exhausted" };
      }
      if (this.shouldStartCall !== null && !(await this.shouldStartCall())) {
        return { kind: "stopped" };
      }
      call.budget.calls += 1;
      const attempt = call.budget.calls;
      const started = this.now();
      try {
        const result = await this.ctx.ai.generateStructured<HarnessAiResponse>(request);
        call.usage = addUsage(call.usage, result.usage);
        await this.recordUsage(result.usage);
        this.log.info(
          {
            event: "harness.ai.call",
            componentId: call.componentId,
            purpose: request.purpose,
            attempt,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cacheReadInputTokens: result.usage.cacheReadInputTokens ?? 0,
            durationMs: this.now() - started
          },
          "AI call completed"
        );
        return { kind: "data", data: result.data };
      } catch (error: unknown) {
        if (!(error instanceof AiProviderError)) {
          throw error; // persistence failure or a bug: handled by the caller
        }
        if (error.usage !== undefined) {
          call.usage = addUsage(call.usage, error.usage);
          await this.recordUsage(error.usage);
        }
        if (error.reason === "aborted" || call.signal.aborted) {
          return { kind: "cancelled" };
        }
        if ((error.reason === "auth" || error.reason === "config") && call.mode === "generate") {
          return {
            kind: "fatal",
            error: new PipelineStepError(STAGE, `AI provider error: ${redactSecrets(error.message)}`, {
              code: `ai_${error.reason}`,
              cause: error
            })
          };
        }
        if (error.retryable && call.budget.calls < call.budget.max) {
          this.log.warn(
            {
              event: "harness.ai.retry",
              componentId: call.componentId,
              reason: error.reason,
              attempt,
              delayMs: HARNESS_RETRY_DELAY_MS
            },
            "AI call failed; retrying"
          );
          if (call.mode === "generate") {
            await this.ctx.console.warn(
              STAGE,
              `AI call for ${call.displayName} failed (${error.reason}); retrying in ${count(HARNESS_RETRY_DELAY_MS / 1_000)} s.`
            );
          }
          try {
            await this.sleep(HARNESS_RETRY_DELAY_MS, call.signal);
          } catch (sleepError: unknown) {
            if (isAborted(call.signal)) {
              return { kind: "cancelled" };
            }
            throw sleepError;
          }
          continue;
        }
        return { kind: "error", error };
      }
    }
  }

  private async recordUsage(usage: AiUsage): Promise<void> {
    this.stageUsage = addUsage(this.stageUsage, usage);
    try {
      await this.usageRecorder.add(usage);
    } catch (error: unknown) {
      this.log.error({ event: "harness.stage.fatal", reason: "usage_write", err: error }, "Recording AI usage failed");
      throw new HarnessPersistError("Recording AI usage failed", { cause: error });
    }
  }

  private mapCallFailure(
    pkg: HarnessContextPackage,
    outcome: Exclude<AiCallOutcome, { kind: "data" }>,
    last: HarnessAiResponse | null
  ): HarnessAttempt {
    switch (outcome.kind) {
      case "cancelled":
        return { kind: "cancelled" };
      case "stopped":
        return { kind: "stopped" };
      case "fatal":
        return { kind: "fatal", error: outcome.error };
      case "error":
        return failedAttempt(
          pkg,
          "ai_error",
          outcome.error.reason,
          userMessageFor(outcome.error),
          last?.harnessSource ?? null,
          []
        );
      case "budget_exhausted":
        return failedAttempt(
          pkg,
          "ai_error",
          null,
          "The AI call budget for this component was used up.",
          last?.harnessSource ?? null,
          []
        );
    }
  }

  /** cannot_render: render_status skipped, notes "Not rendered: …" (09 §5.11). */
  private async skip(candidate: ComponentCandidate, response: HarnessAiResponse): Promise<GenerationOutcome> {
    const reason = capText(response.notes.trim(), HARNESS_RESPONSE_NOTES_MAX_CHARS);
    const notes = capText(`Not rendered: ${reason}`, HARNESS_NOTES_MAX_CHARS);
    await this.persist(candidate.componentId, {
      harnessSource: null,
      mockedModules: [],
      harnessNotes: notes,
      renderStatus: ComponentRenderStatus.SKIPPED,
      baseError: null,
      headError: null
    });
    await this.ctx.console.info(
      STAGE,
      `${candidate.displayName} cannot be rendered in isolation: ${firstLine(reason)}`
    );
    this.log.info({ event: "harness.cannot_render", componentId: candidate.componentId }, "Component cannot render");
    return {
      kind: "failure",
      failure: { componentId: candidate.componentId, kind: "cannot_render", aiReason: null, message: notes }
    };
  }

  /** ai_error / invalid_harness / context_error: render_status failed with side errors (09 §5.11). */
  private async fail(
    candidate: ComponentCandidate,
    pkg: HarnessContextPackage | null,
    kind: HarnessGenerationFailure["kind"],
    aiReason: HarnessGenerationFailure["aiReason"],
    message: string,
    lastHarness: string | null,
    issues: readonly HarnessValidationIssue[]
  ): Promise<GenerationOutcome> {
    const sides = pkg?.sidesPresent ?? (await this.presentSides(candidate));
    const issueLines = issues.map((issue) => `- [${issue.code}] ${issue.message}`);
    const notes = capText([`Harness generation failed: ${message}`, ...issueLines].join("\n"), HARNESS_NOTES_MAX_CHARS);
    await this.persist(candidate.componentId, {
      harnessSource: lastHarness !== null && lastHarness.trim() !== "" ? lastHarness : null,
      mockedModules: [],
      harnessNotes: notes,
      renderStatus: ComponentRenderStatus.FAILED,
      baseError: sides.base ? NOT_RENDERED_ERROR : null,
      headError: sides.head ? NOT_RENDERED_ERROR : null
    });
    await this.ctx.console.warn(STAGE, `Harness generation failed for ${candidate.displayName}: ${message}`);
    this.log.warn(
      { event: "harness.failed", componentId: candidate.componentId, kind, aiReason },
      "Harness generation failed for a component"
    );
    return { kind: "failure", failure: { componentId: candidate.componentId, kind, aiReason, message } };
  }

  private async presentSides(candidate: ComponentCandidate): Promise<{ base: boolean; head: boolean }> {
    try {
      const paths = await this.queries.componentPaths(candidate.filePath);
      return { base: paths.base !== null, head: paths.head !== null };
    } catch {
      // componentPaths never rejects (08 §5.1.1); fall back to the change kind if it does anyway.
      return { base: candidate.changeKind !== "added", head: candidate.changeKind !== "removed" };
    }
  }

  private async recoverUnexpected(
    candidate: ComponentCandidate,
    error: unknown,
    signal: AbortSignal
  ): Promise<GenerationOutcome> {
    if (error instanceof HarnessPersistError) {
      return {
        kind: "fatal",
        error: new PipelineStepError(STAGE, "Could not save harness results.", {
          code: "HARNESS_PERSIST_FAILED",
          cause: error.cause ?? error
        })
      };
    }
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    this.log.error(
      { event: "harness.failed", componentId: candidate.componentId, kind: "context_error", err: error },
      "Unexpected error while generating a harness"
    );
    const message = `Unexpected error: ${redactSecrets(getErrorMessage(error)).slice(0, UNKNOWN_MESSAGE_MAX_CHARS)}`;
    try {
      return await this.fail(
        candidate,
        this.packages.get(packageKey(candidate.componentId)) ?? null,
        "context_error",
        null,
        message,
        null,
        []
      );
    } catch (persistError: unknown) {
      if (persistError instanceof HarnessPersistError) {
        return this.recoverUnexpected(candidate, persistError, signal);
      }
      throw persistError;
    }
  }

  private async reportFatal(error: PipelineStepError): Promise<void> {
    this.log.error(
      { event: "harness.stage.fatal", reason: error.code, message: error.userMessage, err: error },
      "Harness generation stopped"
    );
    if (error.code !== null && error.code.startsWith("ai_")) {
      await this.ctx.console.error(STAGE, error.userMessage);
    }
  }

  /** One row's outcome through the persistence port; any failure is an infrastructure failure (09 §5.11). */
  private async persist(componentId: number, values: Record<string, unknown>): Promise<void> {
    try {
      await this.persistence.saveGenerated(componentId, values);
    } catch (error: unknown) {
      throw new HarnessPersistError("Saving harness results failed", { cause: error });
    }
  }

  // ---- repair (09 §5.10) ----

  private async repair(
    componentId: number,
    previous: HarnessGenerationResult,
    renderError: HarnessRenderError
  ): Promise<HarnessRepairOutcome> {
    if (this.ctx.signal.aborted || (await this.ctx.isCancelled())) {
      return { ok: false, reason: "cancelled", message: "Cancelled." };
    }
    // 00 §17: a replaced row repairs each side's own harness; renderError.targetSide names it
    const side: WorktreeSide = renderError.targetSide ?? "head";
    const key = packageKey(componentId, side);
    const used = this.repairsUsed.get(key) ?? 0;
    if (used >= HARNESS_MAX_REPAIRS_PER_COMPONENT) {
      return { ok: false, reason: "budget_exhausted", message: "Harness was already repaired once." };
    }
    this.repairsUsed.set(key, used + 1);
    this.log.info(
      { event: "harness.repair.started", componentId, sides: renderError.sides, kind: renderError.kind },
      "Harness repair started"
    );
    let pkg = this.packages.get(key);
    if (pkg === undefined) {
      const rebuilt = await this.rebuildPackage(componentId, side);
      if (!rebuilt.ok) {
        return { ok: false, reason: "ai_error", message: rebuilt.message };
      }
      pkg = rebuilt.pkg;
      this.packages.set(key, pkg);
    }

    const signal = this.ctx.signal;
    const request = this.request(pkg, "harness_repair", this.prompts.buildRepair(pkg, previous, renderError), signal);
    const call: AiCallContext = {
      mode: "repair",
      componentId,
      displayName: pkg.candidate.displayName,
      signal,
      budget: { calls: 0, max: HARNESS_REPAIR_CALL_BUDGET },
      usage: ZERO_USAGE
    };
    let outcome = await this.callAi(request, call);
    for (let corrected = false; ; corrected = true) {
      switch (outcome.kind) {
        case "cancelled":
          return { ok: false, reason: "cancelled", message: "Cancelled." };
        case "stopped":
          return { ok: false, reason: "cancelled", message: "Stopped: the spending cap was reached." };
        case "budget_exhausted":
          return { ok: false, reason: "budget_exhausted", message: "The AI call budget for this repair was used up." };
        case "fatal":
          return { ok: false, reason: "ai_error", message: outcome.error.userMessage };
        case "error":
          return { ok: false, reason: "ai_error", message: userMessageFor(outcome.error) };
        case "data":
          break;
      }
      const response = outcome.data;
      const notes = response.notes.trim();
      if (response.status === "component_defect") {
        return {
          ok: false,
          reason: "component_defect",
          message: notes,
          notesAppendix: `Repair check: the render failure looks like a defect in the component itself: ${notes.slice(0, VERDICT_NOTES_MAX_CHARS)}`
        };
      }
      if (response.status === "cannot_render") {
        return {
          ok: false,
          reason: "cannot_render",
          message: notes,
          notesAppendix: `Repair check: the AI considers this component not renderable in isolation: ${notes.slice(0, VERDICT_NOTES_MAX_CHARS)}`
        };
      }
      const report = await this.validator.validate(this.validationInput(pkg, response));
      if (report.ok) {
        const warningLines = report.warnings.map((warning) => `- ${warning.message}`);
        const repairedNotes = [
          `${previous.notes}\n\nRepaired after ${renderError.sides.join(" and ")} render failure (${renderError.kind}): ${capText(notes, HARNESS_RESPONSE_NOTES_MAX_CHARS)}`,
          ...(warningLines.length > 0 ? ["Validator warnings:", ...warningLines] : [])
        ].join("\n");
        return {
          ok: true,
          result: {
            componentId,
            harnessSource: response.harnessSource,
            mockedModules: response.mockedModules.map(({ specifier, source }) => ({ specifier, source })),
            notes: capText(repairedNotes, HARNESS_NOTES_MAX_CHARS),
            states: report.states ?? [], // a valid report always carries its states (16 §7.7.3)
            origin: "written",
            libraryEntryId: null,
            usage: call.usage // the repair calls of this outcome (16 §8.6.1)
          }
        };
      }
      this.log.warn(
        {
          event: "harness.validation.failed",
          componentId,
          codes: report.errors.map((issue) => issue.code),
          warningCodes: report.warnings.map((issue) => issue.code)
        },
        "Repaired harness failed static checks"
      );
      if (corrected || call.budget.calls >= call.budget.max) {
        const codes = report.errors.slice(0, 3).map((issue) => issue.code);
        return {
          ok: false,
          reason: "invalid_harness",
          message: `Repaired harness failed static checks: ${codes.join(", ")}`
        };
      }
      outcome = await this.callAi(
        { ...request, prompt: this.prompts.buildCorrection(pkg, response, report.errors) },
        call
      );
    }
  }

  /**
   * Rebuilds a context package from the component row when this instance did not generate it (09 §5.10 step 3). For
   * a replaced row, `side` picks R's (base) or A's (head) package (00 §17).
   */
  private async rebuildPackage(
    componentId: number,
    side: WorktreeSide
  ): Promise<{ ok: true; pkg: HarnessContextPackage } | { ok: false; message: string }> {
    const row = await this.queryHandler.validateAndSelect(
      VisualizationComponentModel,
      { id: componentId, visualizationId: this.ctx.visualizationId },
      Table.VISUALIZATION_COMPONENTS
    );
    if (row === null) {
      return { ok: false, message: "Component not found." };
    }
    const candidate: ComponentCandidate = {
      componentId: row.id,
      filePath: row.filePath,
      exportName: row.exportName,
      displayName: row.displayName,
      changeKind: row.changeKind,
      rank: row.rank,
      codeDiff: row.codeDiff,
      reason: row.changeReason ?? "",
      ...(row.changeKind === "replaced" && row.baseFilePath !== null
        ? {
            predecessor: {
              filePath: row.baseFilePath,
              exportName: row.baseExportName ?? "default",
              displayName: row.baseDisplayName ?? row.baseExportName ?? "default",
              evidence: row.successorEvidence ?? []
            }
          }
        : {})
    };
    try {
      const target = isReplacedCandidate(candidate) ? replacedSideCandidate(candidate, side) : candidate;
      return { ok: true, pkg: await this.contextBuilder.build(target, this.contextOptions()) };
    } catch (error: unknown) {
      return { ok: false, message: redactSecrets(getErrorMessage(error)) };
    }
  }
}
