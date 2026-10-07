/**
 * ImageDiffService (11 §5.2): the pixel half of the `diffing` stage.
 *
 * For every rendered component it classifies the render (11 §5.2.1), compares base and head pixel by pixel with
 * pixelmatch, writes `diff.png` through ArtifactStore and persists `visual_change`, `diff_image_path`,
 * `diff_pixel_ratio`, `image_width` and `image_height` (the final size write of 00 §14.12). Image problems are
 * per component; DB failures and cancellation throw PipelineStepError. `visualizations.changed_count` is written by
 * the orchestrator (07), never here.
 */
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { DIFF_MAX_PNG_BYTES, PIXELMATCH_THRESHOLD, UNCHANGED_RATIO_CUTOFF } from "../../../config-consts";
import { ComponentVisualChange, Table } from "../../../enums";
import { VisualizationComponentModel } from "../../../models";
import {
  PipelineStepError,
  type ComponentRenderResult,
  type ImageDiffResult,
  type PipelineContext,
  type RenderSideResult
} from "../../../types/visualization-pipeline";
import { ArtifactStore, QueryHandler, createLogger, getErrorMessage, type ApiResponse } from "../../../utilities";
import { ImageDecodeError, createTransparentPng, cropPng, decodePng, encodePng, readPngHeader } from "./png-utils";

const STAGE = "diffing" as const;

type PixelmatchOptions = NonNullable<Parameters<typeof pixelmatch>[5]>;

/** pixelmatch options (11 §5.2.2). Typed from the installed package, so an unknown key fails to compile. */
export const PIXELMATCH_OPTIONS: PixelmatchOptions = {
  threshold: PIXELMATCH_THRESHOLD,
  includeAA: false,
  alpha: 0.1,
  diffColor: [255, 0, 80],
  diffColorAlt: [0, 150, 255],
  aaColor: [255, 200, 0],
  diffMask: false
};

/** Colour of a counted head-only band pixel (same as a generic difference). */
const HEAD_ONLY_COLOR: readonly [number, number, number] = [255, 0, 80];
/** Colour of a counted base-only band pixel (the "dark on light" colour). */
const BASE_ONLY_COLOR: readonly [number, number, number] = [0, 150, 255];

/** Collaborators; every field defaults to the real implementation. */
export interface ImageDiffDeps {
  artifactStore: ArtifactStore;
  createQueryHandler(): QueryHandler;
}

/** How one render is handled (11 §5.2.1). */
export type RenderClassification =
  | { kind: "compare"; base: RenderSideResult & { imagePath: string }; head: RenderSideResult & { imagePath: string } }
  | { kind: "new"; head: RenderSideResult }
  | { kind: "deleted"; base: RenderSideResult }
  | { kind: "not_comparable"; reason: string };

/** Reason text of the "component missing on both sides" row (no structural diff either). */
export const MISSING_ON_BOTH_SIDES = "component missing on both sides";

/** Per-component image failure codes (11 §6). */
export type ImageErrorReason = "missing_screenshot" | "invalid_png" | "png_too_large" | "write_failed";

const IMAGE_ERROR_TEXT: Record<ImageErrorReason, string> = {
  missing_screenshot: "missing screenshot",
  invalid_png: "invalid PNG",
  png_too_large: "PNG too large",
  write_failed: "could not write diff image"
};

/** Result of computePixelDiff. `ratio` is unrounded. */
export interface PixelDiffOutput {
  diff: PNG;
  diffPixels: number;
  width: number;
  height: number;
  ratio: number;
}

type SideWithImage = RenderSideResult & { imagePath: string };

function hasImage(side: RenderSideResult): side is SideWithImage {
  return side.ok && side.imagePath !== null;
}

/** Classifies one render per the 11 §5.2.1 table. */
export function classifyRender(render: ComponentRenderResult): RenderClassification {
  const { base, head } = render;
  if (base === null && head === null) {
    return { kind: "not_comparable", reason: MISSING_ON_BOTH_SIDES };
  }
  if (base === null) {
    return head !== null && hasImage(head)
      ? { kind: "new", head }
      : { kind: "not_comparable", reason: "head render failed" };
  }
  if (head === null) {
    return hasImage(base) ? { kind: "deleted", base } : { kind: "not_comparable", reason: "base render failed" };
  }
  if (hasImage(base) && hasImage(head)) {
    return { kind: "compare", base, head };
  }
  if (!hasImage(base) && !hasImage(head)) {
    return { kind: "not_comparable", reason: "both renders failed" };
  }
  return { kind: "not_comparable", reason: hasImage(base) ? "head render failed" : "base render failed" };
}

/** Rounds a ratio to the 6 decimals of `numeric(8,6)`. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 1e6) / 1e6;
}

/**
 * Pixel diff of two decoded screenshots (11 §5.2.2): pixelmatch on the common w0 × h0 rectangle, explicit
 * accounting of the size-difference band (a real, non-transparent pixel on one side only is counted and painted),
 * ratio over the W × H canvas.
 */
export function computePixelDiff(base: PNG, head: PNG): PixelDiffOutput {
  const width = Math.max(base.width, head.width);
  const height = Math.max(base.height, head.height);
  const w0 = Math.min(base.width, head.width);
  const h0 = Math.min(base.height, head.height);

  if (base.width === width && base.height === height && head.width === width && head.height === height) {
    const out = createTransparentPng(width, height);
    const diffPixels = pixelmatch(base.data, head.data, out.data, width, height, PIXELMATCH_OPTIONS);
    return { diff: out, diffPixels, width, height, ratio: diffPixels / (width * height) };
  }

  const inner = createTransparentPng(w0, h0);
  const innerPixels = pixelmatch(
    cropPng(base, 0, 0, w0, h0).data,
    cropPng(head, 0, 0, w0, h0).data,
    inner.data,
    w0,
    h0,
    PIXELMATCH_OPTIONS
  );
  const out = createTransparentPng(width, height);
  PNG.bitblt(inner, out, 0, 0, w0, h0, 0, 0);

  let bandPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = y < h0 ? w0 : 0; x < width; x += 1) {
      const inBase = x < base.width && y < base.height;
      const inHead = x < head.width && y < head.height;
      if (inBase === inHead) {
        continue; // outside both images: padding on both sides
      }
      const source = inBase ? base : head;
      if ((source.data[(y * source.width + x) * 4 + 3] ?? 0) === 0) {
        continue; // transparent vs padding is identical
      }
      const [r, g, b] = inHead ? HEAD_ONLY_COLOR : BASE_ONLY_COLOR;
      out.data.set([r, g, b, 255], (y * width + x) * 4);
      bandPixels += 1;
    }
  }
  const diffPixels = innerPixels + bandPixels;
  return { diff: out, diffPixels, width, height, ratio: diffPixels / (width * height) };
}

/** Maps a per-component failure to its 11 §6 code. */
function classifyImageError(error: unknown, phase: "read" | "write"): ImageErrorReason {
  if (error instanceof ImageDecodeError) {
    return error.reason;
  }
  return phase === "write" ? "write_failed" : "missing_screenshot";
}

type CompareOutcome =
  | { ok: true; values: Record<string, unknown>; result: ImageDiffResult; changed: boolean; ratio: number }
  | { ok: false; reason: ImageErrorReason; error: unknown };

/** Pixel-diffs every rendered component and persists the outcome (11 §5.2.3). */
export class ImageDiffService {
  private readonly deps: ImageDiffDeps;

  constructor(deps: Partial<ImageDiffDeps> = {}) {
    this.deps = {
      artifactStore: deps.artifactStore ?? new ArtifactStore(),
      createQueryHandler: deps.createQueryHandler ?? ((): QueryHandler => new QueryHandler())
    };
  }

  /**
   * Compares base and head screenshots of every render, sequentially and in componentId order.
   *
   * @returns One ImageDiffResult per compared pair (changed or unchanged); none for new/deleted/not compared.
   * @throws PipelineStepError IMAGE_DIFF_CANCELLED / IMAGE_DIFF_PERSIST_FAILED / IMAGE_DIFF_LOAD_FAILED.
   */
  async diff(ctx: PipelineContext, renders: ComponentRenderResult[]): Promise<ImageDiffResult[]> {
    const log = createLogger("image-diff", { visualizationId: ctx.visualizationId });
    const startedAt = Date.now();
    const queryHandler = this.deps.createQueryHandler();
    const names = await this.loadDisplayNames(ctx, queryHandler);
    const counts = { changed: 0, unchanged: 0, new: 0, deleted: 0, notCompared: 0 };
    const results: ImageDiffResult[] = [];

    await ctx.console.info(STAGE, `Comparing screenshots for ${String(renders.length)} components.`);
    const ordered = [...renders].sort((a, b) => a.componentId - b.componentId);
    for (const [index, render] of ordered.entries()) {
      if (index > 0) {
        await yieldToEventLoop(); // keeps BullMQ lock renewal and cancellation responsive (11 §5.2.3)
      }
      if (ctx.signal.aborted || (await ctx.isCancelled())) {
        throw new PipelineStepError(STAGE, "Cancelled.", { code: "IMAGE_DIFF_CANCELLED" });
      }
      const componentStartedAt = Date.now();
      const componentId = render.componentId;
      const classification = classifyRender(render);
      let ratio: number | null = null;
      switch (classification.kind) {
        case "new":
          await this.persist(ctx, queryHandler, componentId, {
            visualChange: ComponentVisualChange.NEW,
            imageWidth: classification.head.width,
            imageHeight: classification.head.height,
            diffImagePath: null,
            diffPixelRatio: null
          });
          counts.new += 1;
          break;
        case "deleted":
          await this.persist(ctx, queryHandler, componentId, {
            visualChange: ComponentVisualChange.DELETED,
            imageWidth: classification.base.width,
            imageHeight: classification.base.height,
            diffImagePath: null,
            diffPixelRatio: null
          });
          counts.deleted += 1;
          break;
        case "not_comparable":
          if (classification.reason === MISSING_ON_BOTH_SIDES) {
            log.warn(
              { event: "image_diff.component.missing", componentId },
              "Component missing on both sides; nothing to compare"
            );
          }
          await this.persist(ctx, queryHandler, componentId, {
            visualChange: null,
            diffImagePath: null,
            diffPixelRatio: null
          });
          counts.notCompared += 1;
          break;
        case "compare": {
          const outcome = await this.compareOne(ctx, componentId, classification.base, classification.head);
          if (outcome.ok) {
            await this.persist(ctx, queryHandler, componentId, outcome.values);
            results.push(outcome.result);
            ratio = outcome.ratio;
            if (outcome.changed) {
              counts.changed += 1;
            } else {
              counts.unchanged += 1;
            }
          } else {
            log.warn(
              { event: "image_diff.component.failed", componentId, reason: outcome.reason, err: outcome.error },
              "Could not compare screenshots"
            );
            const name = names.get(componentId) ?? `component #${String(componentId)}`;
            await ctx.console.warn(
              STAGE,
              `Could not compare screenshots for ${name}: ${IMAGE_ERROR_TEXT[outcome.reason]}.`
            );
            await this.persist(ctx, queryHandler, componentId, {
              visualChange: null,
              diffImagePath: null,
              diffPixelRatio: null
            });
            counts.notCompared += 1;
          }
          break;
        }
      }
      log.debug(
        {
          event: "image_diff.component.completed",
          componentId,
          kind: classification.kind,
          ratio,
          durationMs: Date.now() - componentStartedAt
        },
        "Component compared"
      );
    }

    await ctx.console.info(
      STAGE,
      `${String(counts.changed)} changed, ${String(counts.unchanged)} unchanged, ${String(counts.new)} new, ` +
        `${String(counts.deleted)} removed, ${String(counts.notCompared)} not compared.`
    );
    log.info(
      { event: "image_diff.stage.completed", ...counts, durationMs: Date.now() - startedAt },
      "Image diff completed"
    );
    return results;
  }

  /** Reads, guards, decodes and diffs one pair, then writes diff.png. Never throws. */
  private async compareOne(
    ctx: PipelineContext,
    componentId: number,
    base: SideWithImage,
    head: SideWithImage
  ): Promise<CompareOutcome> {
    let output: PixelDiffOutput;
    try {
      const baseBuffer = await this.readGuarded(base.imagePath);
      const headBuffer = await this.readGuarded(head.imagePath);
      readPngHeader(baseBuffer);
      readPngHeader(headBuffer);
      output = computePixelDiff(decodePng(baseBuffer), decodePng(headBuffer));
    } catch (error: unknown) {
      return { ok: false, reason: classifyImageError(error, "read"), error };
    }
    const diffPath = this.deps.artifactStore.componentImagePath(ctx.visualizationId, componentId, "diff");
    try {
      await this.deps.artifactStore.write(diffPath, encodePng(output.diff));
    } catch (error: unknown) {
      return { ok: false, reason: classifyImageError(error, "write"), error };
    }
    const rounded = roundRatio(output.ratio);
    const changed = output.ratio > UNCHANGED_RATIO_CUTOFF;
    return {
      ok: true,
      changed,
      ratio: rounded,
      values: {
        visualChange: changed ? ComponentVisualChange.CHANGED : ComponentVisualChange.UNCHANGED,
        diffImagePath: diffPath,
        diffPixelRatio: rounded,
        imageWidth: output.width,
        imageHeight: output.height
      },
      result: {
        componentId,
        diffImagePath: diffPath,
        diffPixelRatio: rounded,
        width: output.width,
        height: output.height,
        states: [] // 16a compile shim (16 §6.12): 16e diffs every state
      }
    };
  }

  /** ArtifactStore.read with the DIFF_MAX_PNG_BYTES cap (png_too_large; nothing is decoded). */
  private async readGuarded(relativePath: string): Promise<Buffer> {
    const buffer = await this.deps.artifactStore.read(relativePath);
    if (buffer.length > DIFF_MAX_PNG_BYTES) {
      throw new ImageDecodeError("png_too_large", "PNG file exceeds DIFF_MAX_PNG_BYTES");
    }
    return buffer;
  }

  private async loadDisplayNames(ctx: PipelineContext, queryHandler: QueryHandler): Promise<Map<number, string>> {
    try {
      const rows = await queryHandler.selectMany(
        VisualizationComponentModel,
        { visualizationId: ctx.visualizationId },
        Table.VISUALIZATION_COMPONENTS
      );
      return new Map(rows.map((row) => [row.id, row.displayName]));
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, "Could not load the components to compare.", {
        code: "IMAGE_DIFF_LOAD_FAILED",
        detail: `Component load failed: ${getErrorMessage(error)}`,
        cause: error
      });
    }
  }

  private async persist(
    ctx: PipelineContext,
    queryHandler: QueryHandler,
    componentId: number,
    values: Record<string, unknown>
  ): Promise<void> {
    let response: ApiResponse<{ rowsAffected: number }>;
    try {
      response = await queryHandler.update(
        values,
        { id: componentId, visualizationId: ctx.visualizationId },
        Table.VISUALIZATION_COMPONENTS
      );
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, "Could not save the image comparison results.", {
        code: "IMAGE_DIFF_PERSIST_FAILED",
        cause: error
      });
    }
    if (response.status !== 200) {
      throw new PipelineStepError(STAGE, "Could not save the image comparison results.", {
        code: "IMAGE_DIFF_PERSIST_FAILED",
        detail: `Component ${String(componentId)} update failed (${String(response.status)})`
      });
    }
  }
}
