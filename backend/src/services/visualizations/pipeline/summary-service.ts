/**
 * SummaryService (11 §5.4): the `summarizing` stage.
 *
 * Makes at most one structured AI call through `ctx.ai` that reads the evidence (pixel ratios, structural diffs,
 * code diffs, related module diffs and screenshots of the most-changed components) and persists the sanitized
 * Markdown summary plus a note and a risk per component in one transaction. With no visual change it writes a fixed
 * summary without AI. An AI failure never throws: `summary_markdown` stays null and a console warning is emitted.
 * Usage (including `AiProviderError.usage`) is recorded only through 09's AiUsageRecorder (00 §14.7).
 */
import type { Logger } from "pino";
import {
  DIFF_MAX_PNG_BYTES,
  SUMMARY_IMAGE_MAX_EDGE,
  SUMMARY_MAX_IMAGE_BYTES,
  SUMMARY_MAX_IMAGE_COMPONENTS,
  SUMMARY_MAX_TOTAL_IMAGE_BYTES,
  SUMMARY_PROMPT_MAX_CHARS,
  SUMMARY_RELATED_DIFFS_MAX_FILES
} from "../../../config-consts";
import { ComponentRenderStatus, ComponentRisk, ComponentVisualChange, Table } from "../../../enums";
import { VisualizationComponentModel, VisualizationModel } from "../../../models";
import {
  AiProviderError,
  PipelineStepError,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage,
  type ChangeAnalysisResult,
  type PipelineContext
} from "../../../types/visualization-pipeline";
import {
  ArtifactStore,
  DrizzleDb,
  QueryHandler,
  createLogger,
  getErrorMessage,
  redactSecrets,
  type ApiResponse,
  type Transaction
} from "../../../utilities";
import { AiUsageRecorder } from "./ai-usage-recorder";
import { buildUnifiedDiff, classifySourcePath, readConfinedText } from "./change-source";
import { PIXELMATCH_OPTIONS } from "./image-diff-service";
import {
  ImageDecodeError,
  cropPng,
  cropWindowAround,
  decodePng,
  encodePng,
  findDiffBoundingBox,
  readPngHeader,
  type PixelRect
} from "./png-utils";
import {
  DEFAULT_SUMMARY_PROMPT_LIMITS,
  SUMMARY_JSON_SCHEMA,
  buildFixedSummary,
  buildSummaryPrompt,
  sanitizeNote,
  sanitizeSummaryMarkdown,
  summarySystemPromptFor,
  type SummaryAiOutput,
  type SummaryComponentInput,
  type SummaryPromptInput,
  type SummaryPromptLimits
} from "./summary-prompts";

const STAGE = "summarizing" as const;
const PERSIST_MESSAGE = "Could not save the AI summary.";
const FAILURE_MESSAGE_MAX_CHARS = 200;

/** Collaborators; every field defaults to the real implementation. */
export interface SummaryDeps {
  artifactStore: ArtifactStore;
  /** Default DrizzleDb.transaction (04 §9.2). */
  runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createQueryHandler(tx?: Transaction): QueryHandler;
  /** Default 08's readConfinedText. */
  readSource(sideRoot: string, repoPath: string): Promise<string | null>;
  /** Default `new AiUsageRecorder(id)` (09), the only writer of visualizations.ai_usage. */
  createUsageRecorder(visualizationId: number): Pick<AiUsageRecorder, "add">;
}

/** What summarize() returns to 07. */
export interface SummaryOutcome {
  status: "generated" | "fixed" | "failed" | "cancelled";
  summaryMarkdown: string | null;
  usage: AiUsage | null;
  failureReason: string | null; // AiProviderError.reason, "unknown" or "empty_summary"
}

type Risk = (typeof ComponentRisk)[keyof typeof ComponentRisk];
type AiImage = NonNullable<AiStructuredRequest["images"]>[number];

/** Validated, sanitized AI output (11 §5.4.6). */
export interface ValidatedSummary {
  summaryMarkdown: string;
  notes: Map<number, { note: string | null; risk: Risk }>;
  dropped: number;
  missing: number;
}

const RISK_ORDER: Record<Risk, number> = { none: 0, check: 1, likely_regression: 2 };

/** Risk floor of 11 §5.4.6: head failed while base rendered on a component that existed on base → at least "check". */
export function applyRiskFloor(row: VisualizationComponentModel, risk: Risk): Risk {
  const floor = row.headError !== null && row.baseError === null && row.changeKind !== "added";
  return floor && RISK_ORDER[risk] < RISK_ORDER.check ? ComponentRisk.CHECK : risk;
}

/** Semantic validation of the model output: unknown ids dropped, first duplicate wins, missing ids counted. */
export function validateAiOutput(
  data: SummaryAiOutput,
  detailed: readonly VisualizationComponentModel[]
): ValidatedSummary {
  const rows = new Map(detailed.map((row) => [row.id, row]));
  const notes = new Map<number, { note: string | null; risk: Risk }>();
  let dropped = 0;
  for (const item of data.components) {
    const row = rows.get(item.componentId);
    if (row === undefined) {
      dropped += 1;
      continue;
    }
    if (notes.has(item.componentId)) {
      continue;
    }
    notes.set(item.componentId, { note: sanitizeNote(item.note), risk: applyRiskFloor(row, item.risk) });
  }
  const missing = detailed.filter((row) => !notes.has(row.id)).length;
  return { summaryMarkdown: sanitizeSummaryMarkdown(data.summaryMarkdown), notes, dropped, missing };
}

/** Prompt shrinking steps of 11 §5.4.5, applied in order until the prompt fits. */
const SHRINK_STEPS: ReadonlyArray<(limits: SummaryPromptLimits) => SummaryPromptLimits> = [
  (limits) => ({ ...limits, relatedDiffMaxLines: 40 }),
  (limits) => ({ ...limits, codeDiffMaxLines: 150 }),
  (limits) => ({ ...limits, structuralMaxLines: 20 }),
  (limits) => ({ ...limits, codeDiffMaxLines: 60 }),
  (limits) => ({ ...limits, includeRelatedDiffs: false }),
  (limits) => ({ ...limits, unchangedCountOnly: true })
];

/** Builds the prompt and shrinks it (11 §5.4.5). `fits` is false when even the last step is over budget. */
export function buildBudgetedPrompt(input: SummaryPromptInput): { prompt: string; fits: boolean; steps: number } {
  let limits = input.limits ?? DEFAULT_SUMMARY_PROMPT_LIMITS;
  let prompt = buildSummaryPrompt({ ...input, limits });
  let steps = 0;
  for (const step of SHRINK_STEPS) {
    if (prompt.length <= SUMMARY_PROMPT_MAX_CHARS) {
      break;
    }
    limits = step(limits);
    prompt = buildSummaryPrompt({ ...input, limits });
    steps += 1;
  }
  return { prompt, fits: prompt.length <= SUMMARY_PROMPT_MAX_CHARS, steps };
}

type SideKind = "head" | "base";
type UnitResult = { ok: true; images: AiImage[]; bytes: number; note: string } | { ok: false; note: string };

class ScreenshotUnavailable extends Error {
  override readonly name = "ScreenshotUnavailable";
}

/** Writes the AI summary for one visualization (11 §5.4). */
export class SummaryService {
  private readonly deps: SummaryDeps;

  constructor(deps: Partial<SummaryDeps> = {}) {
    this.deps = {
      artifactStore: deps.artifactStore ?? new ArtifactStore(),
      runInTransaction: deps.runInTransaction ?? ((fn) => DrizzleDb.transaction(fn)),
      createQueryHandler: deps.createQueryHandler ?? ((tx) => new QueryHandler(tx)),
      readSource: deps.readSource ?? ((sideRoot, repoPath) => readConfinedText(sideRoot, repoPath)),
      createUsageRecorder: deps.createUsageRecorder ?? ((id) => new AiUsageRecorder(id))
    };
  }

  /**
   * Summarizes the visualization. Never throws for AI failures.
   *
   * @throws PipelineStepError SUMMARY_PERSIST_FAILED / SUMMARY_LOAD_FAILED for DB failures.
   */
  async summarize(ctx: PipelineContext, analysis: ChangeAnalysisResult): Promise<SummaryOutcome> {
    const vid = ctx.visualizationId;
    const log = createLogger("summary", { visualizationId: vid });
    const startedAt = Date.now();

    // 1. load
    const { visualization, rows } = await this.load(vid);

    // 2. partition
    const skipped = rows.filter((row) => row.renderStatus === ComponentRenderStatus.SKIPPED);
    const detailed = rows.filter(
      (row) =>
        row.renderStatus !== ComponentRenderStatus.SKIPPED && row.visualChange !== ComponentVisualChange.UNCHANGED
    );
    const unchanged = rows.filter(
      (row) =>
        row.renderStatus !== ComponentRenderStatus.SKIPPED && row.visualChange === ComponentVisualChange.UNCHANGED
    );

    // 3. fixed path
    if (detailed.length === 0) {
      const summaryMarkdown = buildFixedSummary({ rows, analysis, framework: ctx.repository.framework });
      await this.persist(vid, summaryMarkdown, [], unchanged, new Map());
      await ctx.console.info(STAGE, "No visual changes found; summary written without AI.");
      log.info({ event: "summary.fixed", components: rows.length }, "Fixed summary written");
      return { status: "fixed", summaryMarkdown, usage: null, failureReason: null };
    }

    // 4. cancelled
    if (ctx.signal.aborted || (await ctx.isCancelled())) {
      return { status: "cancelled", summaryMarkdown: null, usage: null, failureReason: null };
    }

    // 5. input (images, related diffs)
    const { images, notes: imageNotes } = await this.prepareImages(detailed, log);
    const relatedDiffs = await this.relatedDiffs(ctx, analysis, rows, detailed, log);
    const reasons = new Map(analysis.candidates.map((candidate) => [candidate.componentId, candidate.reason]));
    const components: SummaryComponentInput[] = detailed.map((row) => ({
      componentId: row.id,
      displayName: row.displayName,
      filePath: row.filePath,
      exportName: row.exportName,
      changeKind: row.changeKind,
      reason: reasons.get(row.id) ?? row.changeReason,
      visualChange: row.visualChange === ComponentVisualChange.UNCHANGED ? null : row.visualChange,
      diffPixelRatio: row.diffPixelRatio,
      width: row.imageWidth,
      height: row.imageHeight,
      baseError: row.baseError,
      headError: row.headError,
      renderStatus: row.renderStatus,
      structuralDiff: row.structuralDiff,
      codeDiff: row.codeDiff,
      imageNote: imageNotes.get(row.id) ?? "not attached",
      // 00 §17: tell the model a replaced row compares two different components
      ...(row.changeKind === "replaced" && row.baseDisplayName !== null && row.baseFilePath !== null
        ? {
            replaces: {
              displayName: row.baseDisplayName,
              filePath: row.baseFilePath,
              exportName: row.baseExportName ?? "default",
              evidence: (row.successorEvidence ?? []).map((item) => `${item.kind.replace(/_/g, " ")}: ${item.detail}`)
            }
          }
        : {})
    }));
    const count = (value: string | null): number => detailed.filter((row) => row.visualChange === value).length;

    // 6. prompt with budget shrinking
    const { prompt, fits, steps } = buildBudgetedPrompt({
      visualization: {
        title: visualization.title,
        sourceType: visualization.sourceType,
        prNumber: visualization.prNumber,
        baseRef: visualization.baseRef,
        headRef: visualization.headRef,
        baseSha: visualization.baseSha,
        headSha: visualization.headSha
      },
      changedFiles: analysis.changedFiles,
      overview: {
        rendered: rows.length - skipped.length,
        changed: count(ComponentVisualChange.CHANGED),
        new: count(ComponentVisualChange.NEW),
        deleted: count(ComponentVisualChange.DELETED),
        notCompared: count(null),
        unchanged: unchanged.length
      },
      skipped: { count: skipped.length, displayNames: skipped.map((row) => row.displayName) },
      components,
      relatedDiffs,
      unchanged: unchanged.map((row) => ({
        componentId: row.id,
        displayName: row.displayName,
        filePath: row.filePath
      })),
      framework: ctx.repository.framework
    });
    if (!fits) {
      log.warn({ event: "summary.prompt.over_budget", promptChars: prompt.length }, "Summary prompt over budget");
    }
    log.debug(
      { event: "summary.prompt.built", promptChars: prompt.length, shrinkSteps: steps, images: images.length },
      "Summary prompt built"
    );

    // 7. one AI call; usage recorded immediately
    await ctx.console.info(
      STAGE,
      `Writing the AI summary for ${String(detailed.length)} components (${String(images.length)} screenshots attached).`
    );
    const recorder = this.deps.createUsageRecorder(vid);
    let result: AiStructuredResult<SummaryAiOutput>;
    try {
      result = await ctx.ai.generateStructured<SummaryAiOutput>({
        purpose: "summary",
        system: summarySystemPromptFor(ctx.repository.framework),
        prompt,
        images,
        jsonSchema: SUMMARY_JSON_SCHEMA,
        effort: ctx.aiSettings.summaryEffort,
        signal: ctx.signal
      });
    } catch (error: unknown) {
      const usage = error instanceof AiProviderError ? (error.usage ?? null) : null;
      if (usage !== null) {
        await this.recordUsage(recorder, usage);
      }
      if (isAborted(ctx.signal)) {
        return { status: "cancelled", summaryMarkdown: null, usage, failureReason: null };
      }
      const reason = error instanceof AiProviderError ? error.reason : "unknown";
      log.warn(
        {
          event: "summary.ai.failed",
          reason,
          retryable: error instanceof AiProviderError ? error.retryable : false
        },
        "AI summary failed"
      );
      return this.fail(ctx, unchanged, reason, getErrorMessage(error), usage);
    }
    await this.recordUsage(recorder, result.usage);

    // 8. validate and sanitize
    const validated = validateAiOutput(result.data, detailed);
    if (validated.summaryMarkdown === "") {
      log.warn({ event: "summary.ai.failed", reason: "empty_summary", retryable: false }, "AI summary failed");
      return this.fail(ctx, unchanged, "empty_summary", "The AI returned an empty summary", result.usage);
    }
    if (validated.dropped > 0 || validated.missing > 0) {
      await ctx.console.warn(
        STAGE,
        `AI summary skipped ${String(validated.dropped)} unknown component entries and missed ${String(validated.missing)} components.`
      );
    }

    // 9. persist
    await this.persist(vid, validated.summaryMarkdown, detailed, unchanged, validated.notes);
    await ctx.console.info(
      STAGE,
      `AI summary written (${String(result.usage.inputTokens)} input / ${String(result.usage.outputTokens)} output tokens).`
    );
    log.info(
      {
        event: "summary.generated",
        components: detailed.length,
        images: images.length,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        durationMs: Date.now() - startedAt
      },
      "AI summary written"
    );
    return {
      status: "generated",
      summaryMarkdown: validated.summaryMarkdown,
      usage: result.usage,
      failureReason: null
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Load and persist
  // -------------------------------------------------------------------------------------------------------------

  private async load(vid: number): Promise<{ visualization: VisualizationModel; rows: VisualizationComponentModel[] }> {
    const queryHandler = this.deps.createQueryHandler();
    try {
      const visualization = await queryHandler.validateAndSelect(VisualizationModel, { id: vid }, Table.VISUALIZATIONS);
      if (visualization === null) {
        throw new Error(`Visualization ${String(vid)} not found`);
      }
      const rows = await queryHandler.selectMany(
        VisualizationComponentModel,
        { visualizationId: vid },
        Table.VISUALIZATION_COMPONENTS,
        { orderBy: [{ column: "rank", direction: "asc" }] }
      );
      return { visualization, rows };
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, "Could not load the visualization for the summary.", {
        code: "SUMMARY_LOAD_FAILED",
        detail: `Summary load failed: ${getErrorMessage(error)}`,
        cause: error
      });
    }
  }

  /** One transaction: summary_markdown, notes/risks of detailed rows, risk "none" for unchanged rows (11 §5.4.9). */
  private async persist(
    vid: number,
    summaryMarkdown: string | null,
    detailed: readonly VisualizationComponentModel[],
    unchanged: readonly VisualizationComponentModel[],
    notes: ValidatedSummary["notes"]
  ): Promise<void> {
    const ensureOk = (response: ApiResponse<{ rowsAffected: number }>, what: string): void => {
      if (response.status !== 200) {
        throw new Error(`${what} update failed (${String(response.status)})`);
      }
    };
    try {
      await this.deps.runInTransaction(async (tx) => {
        const qh = this.deps.createQueryHandler(tx);
        ensureOk(await qh.update({ summaryMarkdown }, { id: vid }, Table.VISUALIZATIONS), "Visualization");
        for (const row of detailed) {
          const entry = notes.get(row.id);
          ensureOk(
            await qh.update(
              { aiNote: entry?.note ?? null, risk: entry?.risk ?? null },
              { id: row.id, visualizationId: vid },
              Table.VISUALIZATION_COMPONENTS
            ),
            "Component"
          );
        }
        for (const row of unchanged) {
          ensureOk(
            await qh.update(
              { aiNote: null, risk: ComponentRisk.NONE },
              { id: row.id, visualizationId: vid },
              Table.VISUALIZATION_COMPONENTS
            ),
            "Component"
          );
        }
      });
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, PERSIST_MESSAGE, { code: "SUMMARY_PERSIST_FAILED", cause: error });
    }
  }

  private async recordUsage(recorder: Pick<AiUsageRecorder, "add">, usage: AiUsage): Promise<void> {
    try {
      await recorder.add(usage);
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, PERSIST_MESSAGE, { code: "SUMMARY_PERSIST_FAILED", cause: error });
    }
  }

  /** Failure path (11 §5.4.8): console warn, summary null, unchanged rows risk none; never throws for AI reasons. */
  private async fail(
    ctx: PipelineContext,
    unchanged: readonly VisualizationComponentModel[],
    reason: string,
    message: string,
    usage: AiUsage | null
  ): Promise<SummaryOutcome> {
    const shortMessage = redactSecrets(message).replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_MAX_CHARS);
    await ctx.console.warn(
      STAGE,
      `AI summary failed (${reason}): ${shortMessage}. The visualization will complete without a summary.`
    );
    await this.persist(ctx.visualizationId, null, [], unchanged, new Map());
    return { status: "failed", summaryMarkdown: null, usage, failureReason: reason };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Images (11 §5.4.3)
  // -------------------------------------------------------------------------------------------------------------

  private async prepareImages(
    detailed: readonly VisualizationComponentModel[],
    log: Logger
  ): Promise<{ images: AiImage[]; notes: Map<number, string> }> {
    const byRatio = detailed
      .filter((row) => row.visualChange === ComponentVisualChange.CHANGED)
      .sort((a, b) => (b.diffPixelRatio ?? 0) - (a.diffPixelRatio ?? 0) || a.rank - b.rank)
      .slice(0, SUMMARY_MAX_IMAGE_COMPONENTS);
    const fill = [
      ...detailed.filter((row) => row.visualChange === ComponentVisualChange.NEW),
      ...detailed.filter((row) => row.visualChange === ComponentVisualChange.DELETED)
    ].slice(0, SUMMARY_MAX_IMAGE_COMPONENTS - byRatio.length);
    const selected = [...byRatio, ...fill];
    const selectedIds = new Set(selected.map((row) => row.id));

    const notes = new Map<number, string>();
    for (const row of detailed) {
      if (!selectedIds.has(row.id)) {
        notes.set(
          row.id,
          row.visualChange === null
            ? "not attached (the screenshots were not compared)"
            : `not attached (only the ${String(SUMMARY_MAX_IMAGE_COMPONENTS)} most-changed components get screenshots)`
        );
      }
    }

    const images: AiImage[] = [];
    let totalBytes = 0;
    for (const row of selected) {
      const unit = await this.buildUnit(row, log);
      if (!unit.ok) {
        notes.set(row.id, unit.note);
        continue;
      }
      if (totalBytes + unit.bytes > SUMMARY_MAX_TOTAL_IMAGE_BYTES) {
        notes.set(row.id, "not attached: image budget reached");
        continue;
      }
      totalBytes += unit.bytes;
      images.push(...unit.images);
      notes.set(row.id, unit.note);
    }
    return { images, notes };
  }

  /** The images of one component (head then base for a pair), cropped with one shared window when large. */
  private async buildUnit(row: VisualizationComponentModel, log: Logger): Promise<UnitResult> {
    const sides: SideKind[] =
      row.visualChange === ComponentVisualChange.CHANGED
        ? ["head", "base"]
        : row.visualChange === ComponentVisualChange.NEW
          ? ["head"]
          : ["base"];
    const label = (side: SideKind): string =>
      `#${String(row.id)} ${row.displayName} — ${side === "head" ? "after (head)" : "before (base)"}`;

    let buffers: Array<{ side: SideKind; buffer: Buffer; width: number; height: number }>;
    try {
      buffers = await Promise.all(
        sides.map(async (side) => {
          const buffer = await this.readScreenshot(side === "head" ? row.headImagePath : row.baseImagePath);
          const { width, height } = readPngHeader(buffer);
          return { side, buffer, width, height };
        })
      );
    } catch (error: unknown) {
      if (error instanceof ImageDecodeError && error.reason === "png_too_large") {
        return { ok: false, note: "not attached: image too large" };
      }
      log.warn(
        { event: "summary.screenshot.unavailable", componentId: row.id, err: error },
        "Screenshot unavailable for the summary"
      );
      return { ok: false, note: "not attached: screenshot unavailable" };
    }

    const canvasWidth = Math.max(...buffers.map((entry) => entry.width));
    const canvasHeight = Math.max(...buffers.map((entry) => entry.height));
    const needsCrop = canvasWidth > SUMMARY_IMAGE_MAX_EDGE || canvasHeight > SUMMARY_IMAGE_MAX_EDGE;
    let encoded = buffers.map((entry) => ({ side: entry.side, buffer: entry.buffer }));
    let cropNote = "";
    if (needsCrop) {
      const bbox = row.visualChange === ComponentVisualChange.CHANGED ? await this.diffBoundingBox(row, log) : null;
      const window = cropWindowAround(bbox, canvasWidth, canvasHeight, SUMMARY_IMAGE_MAX_EDGE);
      try {
        encoded = buffers.map((entry) => {
          const png = decodePng(entry.buffer);
          const rect = intersectOrWindow(window, bbox, png.width, png.height);
          return { side: entry.side, buffer: encodePng(cropPng(png, rect.x, rect.y, rect.w, rect.h)) };
        });
      } catch (error: unknown) {
        log.warn(
          { event: "summary.screenshot.unavailable", componentId: row.id, err: error },
          "Screenshot unavailable for the summary"
        );
        return { ok: false, note: "not attached: screenshot unavailable" };
      }
      const area = `x=${String(window.x)} y=${String(window.y)} ${String(window.w)}×${String(window.h)} of ${String(canvasWidth)}×${String(canvasHeight)}`;
      cropNote =
        sides.length > 1 ? `; both cropped to ${area} around the changed area` : `; cropped to ${area} (top-left)`;
    }

    if (encoded.some((entry) => entry.buffer.length > SUMMARY_MAX_IMAGE_BYTES)) {
      return { ok: false, note: "not attached: image too large" };
    }
    const images = encoded.map((entry) => ({
      mediaType: "image/png" as const,
      base64: entry.buffer.toString("base64"),
      label: label(entry.side)
    }));
    const quotedLabels = images.map((image) => `"${image.label}"`).join(" and ");
    return {
      ok: true,
      images,
      bytes: encoded.reduce((sum, entry) => sum + entry.buffer.length, 0),
      note: `attached: ${quotedLabels}${cropNote}`
    };
  }

  private async readScreenshot(relativePath: string | null): Promise<Buffer> {
    if (relativePath === null) {
      throw new ScreenshotUnavailable("No screenshot path");
    }
    const buffer = await this.deps.artifactStore.read(relativePath);
    if (buffer.length > DIFF_MAX_PNG_BYTES) {
      throw new ImageDecodeError("png_too_large", "PNG file exceeds DIFF_MAX_PNG_BYTES");
    }
    return buffer;
  }

  /** Bounding box of the diff pixels in diff.png, or null when it is missing or unreadable. */
  private async diffBoundingBox(row: VisualizationComponentModel, log: Logger): Promise<PixelRect | null> {
    if (row.diffImagePath === null) {
      return null;
    }
    try {
      const buffer = await this.readScreenshot(row.diffImagePath);
      readPngHeader(buffer);
      const colors: Array<readonly [number, number, number]> = [];
      if (PIXELMATCH_OPTIONS.diffColor) {
        colors.push(PIXELMATCH_OPTIONS.diffColor);
      }
      if (PIXELMATCH_OPTIONS.diffColorAlt) {
        colors.push(PIXELMATCH_OPTIONS.diffColorAlt);
      }
      return findDiffBoundingBox(decodePng(buffer), colors);
    } catch (error: unknown) {
      log.debug({ event: "summary.diff_image.unavailable", componentId: row.id, err: error }, "Diff image unavailable");
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Related module diffs (11 §5.4.4)
  // -------------------------------------------------------------------------------------------------------------

  private async relatedDiffs(
    ctx: PipelineContext,
    analysis: ChangeAnalysisResult,
    rows: readonly VisualizationComponentModel[],
    detailed: readonly VisualizationComponentModel[],
    log: Logger
  ): Promise<Array<{ path: string; diff: string }>> {
    const componentPaths = new Set(rows.map((row) => row.filePath));
    const reasons = new Map(analysis.candidates.map((candidate) => [candidate.componentId, candidate.reason]));
    const parentReasons = detailed
      .filter((row) => row.changeKind === "affected_parent")
      .map((row) => reasons.get(row.id) ?? row.changeReason ?? "");
    const eligible = analysis.changedFiles.filter(
      (file) => file.status !== "D" && !componentPaths.has(file.path) && classifySourcePath(file.path).analysable
    );
    const mentioned = (path: string): boolean => parentReasons.some((reason) => reason.includes(path));
    const ordered = [
      ...eligible.filter((file) => mentioned(file.path)),
      ...eligible
        .filter((file) => !mentioned(file.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    ].slice(0, SUMMARY_RELATED_DIFFS_MAX_FILES);

    const out: Array<{ path: string; diff: string }> = [];
    for (const file of ordered) {
      const oldPath = file.status === "A" ? null : (file.previousPath ?? file.path);
      try {
        const newText = await this.deps.readSource(ctx.workspace.headDir, file.path);
        const oldText = oldPath === null ? null : await this.deps.readSource(ctx.workspace.baseDir, oldPath);
        if (newText === null || (oldPath !== null && oldText === null)) {
          log.debug({ event: "summary.related_diff.skipped", path: file.path }, "Related module unreadable");
          continue;
        }
        out.push({
          path: file.path,
          diff: buildUnifiedDiff({ oldPath, newPath: file.path, oldText, newText }).diff
        });
      } catch (error: unknown) {
        log.debug({ event: "summary.related_diff.skipped", path: file.path, err: error }, "Related module unreadable");
      }
    }
    return out;
  }
}

/** Reads `signal.aborted` afresh (it changes while awaiting; a plain property read would be narrowed). */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** window ∩ the image; when they do not overlap, the image's own window around bbox. */
function intersectOrWindow(window: PixelRect, bbox: PixelRect | null, width: number, height: number): PixelRect {
  const x = Math.min(window.x, width);
  const y = Math.min(window.y, height);
  const w = Math.min(window.x + window.w, width) - x;
  const h = Math.min(window.y + window.h, height) - y;
  if (w > 0 && h > 0) {
    return { x, y, w, h };
  }
  return cropWindowAround(bbox, width, height, SUMMARY_IMAGE_MAX_EDGE);
}
