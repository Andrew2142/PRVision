// pipeline/frameworks/framework-strategy.ts (15 §5.3, verbatim)
import type { RepositoryFramework } from "../../../../enums";
import type { PipelineStepFactories } from "../stage-registry";

/** One per supported framework. Image diff and summary are shared services; they read ctx.repository.framework themselves. */
export interface FrameworkStrategy {
  readonly framework: RepositoryFramework;
  stepFactories(): PipelineStepFactories;
}
