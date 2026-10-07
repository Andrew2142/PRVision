import type { VisualizationComponentModel, VisualizationComponentStateModel } from "../../models";
import type { HarnessStep } from "../../types";

type RenderStatus = "pending" | "rendered" | "partial" | "failed" | "skipped";
type VisualChange = "changed" | "unchanged" | "new" | "deleted";

/** One state of a run component (16 §14.5). Image URLs are "/artifacts/…" or null. */
export interface ComponentStateView {
  ordinal: number;
  name: string;
  onBase: boolean;
  onHead: boolean;
  steps: HarnessStep[];
  /** e.g. 'Click button "More actions"' (describeStep). */
  stepSummary: string[];
  renderStatus: RenderStatus;
  visualChange: VisualChange | null;
  baseImageUrl: string | null;
  headImageUrl: string | null;
  diffImageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  diffPixelRatio: number | null;
  baseError: string | null;
  headError: string | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

/**
 * Maps a state row to its view.
 *
 * @param state - The state row.
 * @param toPublicUrl - ArtifactStore.toPublicUrl.
 * @param describe - describeStep (the service passes it; dtos do not import services).
 */
export function toComponentStateView(
  state: VisualizationComponentStateModel,
  toPublicUrl: (relativePath: string | null) => string | null,
  describe: (step: HarnessStep) => string
): ComponentStateView {
  const steps: unknown = state.steps;
  const list = Array.isArray(steps) ? (steps as HarnessStep[]) : [];
  return {
    ordinal: state.ordinal,
    name: state.stateName,
    onBase: state.onBase,
    onHead: state.onHead,
    steps: list,
    stepSummary: list.map(describe),
    renderStatus: state.renderStatus,
    visualChange: state.visualChange ?? null,
    baseImageUrl: toPublicUrl(state.baseImagePath ?? null),
    headImageUrl: toPublicUrl(state.headImagePath ?? null),
    diffImageUrl: toPublicUrl(state.diffImagePath ?? null),
    imageWidth: state.imageWidth ?? null,
    imageHeight: state.imageHeight ?? null,
    diffPixelRatio: finiteOrNull(state.diffPixelRatio),
    baseError: state.baseError ?? null,
    headError: state.headError ?? null
  };
}

/**
 * The one Default state of a row without state rows (16 §7.9, §14.5): the row's own images, size, ratio, visual
 * change, render status and errors, with onBase/onHead from the change kind and no steps.
 */
export function synthesizedDefaultStateView(
  c: VisualizationComponentModel,
  toPublicUrl: (relativePath: string | null) => string | null
): ComponentStateView {
  return {
    ordinal: 0,
    name: "Default",
    onBase: c.changeKind !== "added",
    onHead: c.changeKind !== "removed",
    steps: [],
    stepSummary: [],
    renderStatus: c.renderStatus,
    visualChange: c.visualChange,
    baseImageUrl: toPublicUrl(c.baseImagePath),
    headImageUrl: toPublicUrl(c.headImagePath),
    diffImageUrl: toPublicUrl(c.diffImagePath),
    imageWidth: c.imageWidth,
    imageHeight: c.imageHeight,
    diffPixelRatio: finiteOrNull(c.diffPixelRatio),
    baseError: c.baseError,
    headError: c.headError
  };
}
