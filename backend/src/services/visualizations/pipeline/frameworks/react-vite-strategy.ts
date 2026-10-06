/**
 * React + Vite stage factories (15 §5.3): exactly sheet 07's `defaultPipelineStepFactories()` (sheets 08–11).
 */
import { RepositoryFramework } from "../../../../enums";
import { defaultPipelineStepFactories, type PipelineStepFactories } from "../stage-registry";
import type { FrameworkStrategy } from "./framework-strategy";

/** Today's React stages, unchanged. */
export function reactViteStepFactories(): PipelineStepFactories {
  return defaultPipelineStepFactories();
}

export const reactViteStrategy: FrameworkStrategy = {
  framework: RepositoryFramework.REACT_VITE,
  stepFactories: reactViteStepFactories
};
