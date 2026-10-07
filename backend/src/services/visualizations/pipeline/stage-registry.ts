/**
 * Pipeline stage ports and their default factories (07 §5.9.2).
 *
 * The orchestrator calls sheets 08–11 only through the port types below, which mirror exactly the methods those
 * sheets publish (00 §14.7; 08 §5.1, 09 §5.9, 10 §5.13.1, 11 §5.1). Every sheet has landed, so the placeholder
 * stages are gone.
 *
 * SWAP POINTS (docs/build-notes/07.md lists them line by line): when sheet NN lands, it
 *   1. replaces its port type below with `Pick<RealService, "method">` (or re-exports its own type), and
 *   2. replaces its placeholder in `defaultPipelineStepFactories()` with the real constructor call.
 * Nothing else in sheet 07 changes.
 */
import type { ComponentSourceQueries, PipelineContext } from "../../../types/visualization-pipeline";
import { ChangeAnalysisService } from "./change-analysis-service";
import { HarnessGenerationService, type HarnessGenerationDeps } from "./harness-generation-service";
import { ImageDiffService } from "./image-diff-service";
import { LibraryResolutionService } from "./library-resolution-service";
import {
  RenderService,
  type ComponentRenderPersistence,
  type RenderArtifactStore,
  type RepairHarnessFn
} from "./render-service";
import { StructuralDiffService } from "./structural-diff-service";
import { SummaryService } from "./summary-service";

// ---------------------------------------------------------------------------------------------------------------
// Port types (exact method signatures of sheets 08–11)
// ---------------------------------------------------------------------------------------------------------------

/** Sheet 08 `ChangeAnalysisService` (08 §5.1). */
export type ChangeAnalysisStage = Pick<ChangeAnalysisService, "analyze">;

/** Sheet 09 `HarnessGenerationService` (09 §5.9). */
export type HarnessGenerationStage = Pick<HarnessGenerationService, "generateAll" | "repairHarness">;

/** Sheet 10 §5.13.1 `RenderComponentInput` and `RepairHarnessFn` (same signature as 09's repairHarness). */
export type { RenderComponentInput, RepairHarnessFn } from "./render-service";

/** Sheet 10 `RenderService` (10 §5.13.1). */
export type RenderStage = Pick<RenderService, "renderAll">;

/** Sheet 11 `ImageDiffService` (11 §5.2). */
export type ImageDiffStage = Pick<ImageDiffService, "diff">;

/** Sheet 11 §5.3 `StructuralDiffInput` / `StructuralDiffOutcome` and §5.4 `SummaryOutcome`. */
export type { StructuralDiffInput, StructuralDiffOutcome } from "./structural-diff-service";
export type { SummaryOutcome } from "./summary-service";

/** Sheet 11 `StructuralDiffService` (11 §5.3). */
export type StructuralDiffStage = Pick<StructuralDiffService, "compare">;

/** Sheet 11 `SummaryService` (11 §5.4). */
export type SummaryStage = Pick<SummaryService, "summarize">;

// --- 16d block (16 §8.7 step 1): library resolution at the end of analyzing ---

/** Sheet 16 `LibraryResolutionService` (16 §8.4). */
export type LibraryResolutionStage = Pick<LibraryResolutionService, "resolve">;
export type { LibraryResolutionResult } from "./library-resolution-service";
// --- end 16d block ---

// --- 16e block (16 §5.5, §10.4 step 7.4): render overrides for scans (in-memory persistence, scratch artifacts) ---

/** What `render(deps)` receives: 09's repair closure plus optional persistence and artifact store overrides. */
export interface RenderStageDeps {
  repairHarness: RepairHarnessFn;
  persistence?: ComponentRenderPersistence;
  artifactStore?: RenderArtifactStore;
}

/** Constructor overrides of a render service from RenderStageDeps (absent overrides keep the defaults). */
export function renderServiceOverrides(deps: RenderStageDeps): {
  repairHarness: RepairHarnessFn;
  createPersistence?: () => ComponentRenderPersistence;
  artifactStore?: RenderArtifactStore;
} {
  const persistence = deps.persistence;
  return {
    repairHarness: deps.repairHarness,
    ...(persistence !== undefined ? { createPersistence: () => persistence } : {}),
    ...(deps.artifactStore !== undefined ? { artifactStore: deps.artifactStore } : {})
  };
}
// --- end 16e block ---

// --- 16f block (16 §10.4 step 7.3): generation overrides for library jobs (no row writes, job usage, spend cap) ---

/** What library jobs pass to `harnessGeneration(ctx, queries, deps)`; runs pass nothing (09's defaults). */
export type HarnessGenerationStageDeps = Pick<
  HarnessGenerationDeps,
  "persistence" | "usageRecorder" | "shouldStartCall"
>;
// --- end 16f block ---

/** How the orchestrator obtains each stage (07 §5.9.2). Tests swap in fakes. */
export interface PipelineStepFactories {
  /** 08 — default `new ChangeAnalysisService()`; one instance per job. */
  changeAnalysis(): ChangeAnalysisStage;
  /** 16d — default `new LibraryResolutionService()` for both frameworks (16 §8.7 step 1). */
  libraryResolution(): LibraryResolutionStage;
  /**
   * 09 — default `new HarnessGenerationService(ctx, sourceQueries, deps)`; the same instance serves repairs for 10.
   * `deps` (16f) is passed by library jobs only.
   */
  harnessGeneration(
    ctx: PipelineContext,
    sourceQueries: ComponentSourceQueries,
    deps?: HarnessGenerationStageDeps
  ): HarnessGenerationStage;
  /** 10 — default `new RenderService({ repairHarness })` (10 §5.13.1; other deps use 10's defaults). */
  render(deps: RenderStageDeps): RenderStage;
  /** 11 — defaults `new ImageDiffService()`, `new StructuralDiffService()`, `new SummaryService()`. */
  imageDiff(): ImageDiffStage;
  structuralDiff(): StructuralDiffStage;
  summary(): SummaryStage;
}

/**
 * The orchestrator's default stages. Each line is one swap point (build note 07, "Swap points").
 */
export function defaultPipelineStepFactories(): PipelineStepFactories {
  return {
    changeAnalysis: () => new ChangeAnalysisService(),
    libraryResolution: () => new LibraryResolutionService(), // 16d block
    harnessGeneration: (ctx, sourceQueries, deps) => new HarnessGenerationService(ctx, sourceQueries, deps ?? {}), // 16f deps
    render: (deps) => new RenderService(renderServiceOverrides(deps)), // 16e block
    imageDiff: () => new ImageDiffService(),
    structuralDiff: () => new StructuralDiffService(),
    summary: () => new SummaryService()
  };
}
