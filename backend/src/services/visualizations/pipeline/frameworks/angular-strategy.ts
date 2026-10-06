/**
 * Angular stage factories (15 §5.3): 15b's analysis, 09's harness generation with 15c's Angular context builder,
 * validator and prompts, 15d's render engine, 11's image diff, 15e's template structural diff and 11's summary
 * (which words itself for Angular from ctx.repository.framework).
 */
import { RepositoryFramework } from "../../../../enums";
import { AngularChangeAnalysisService } from "../angular/angular-change-analysis-service";
import { createAngularHarnessGeneration } from "../angular/angular-harness-generation";
import { AngularStructuralDiffService } from "../angular/angular-structural-diff-service";
import { ImageDiffService } from "../image-diff-service";
import { AngularRenderService } from "../render/angular/angular-render-service";
import type { PipelineStepFactories } from "../stage-registry";
import { SummaryService } from "../summary-service";
import type { FrameworkStrategy } from "./framework-strategy";

/** The Angular stages; every one implements the same port types as the React stages (00 §15 item 8). */
export function angularStepFactories(): PipelineStepFactories {
  return {
    changeAnalysis: () => new AngularChangeAnalysisService(),
    harnessGeneration: (ctx, sourceQueries) => createAngularHarnessGeneration(ctx, sourceQueries),
    render: (deps) => new AngularRenderService({ repairHarness: deps.repairHarness }),
    imageDiff: () => new ImageDiffService(),
    structuralDiff: () => new AngularStructuralDiffService(),
    summary: () => new SummaryService()
  };
}

export const angularStrategy: FrameworkStrategy = {
  framework: RepositoryFramework.ANGULAR,
  stepFactories: angularStepFactories
};
