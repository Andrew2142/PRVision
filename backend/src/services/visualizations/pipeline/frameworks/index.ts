// pipeline/frameworks/index.ts (15 §5.3): the only place the pipeline branches on framework.
import { RepositoryFramework } from "../../../../enums";
import type { PipelineStepFactories } from "../stage-registry";
import { angularStrategy } from "./angular-strategy";
import { reactViteStrategy } from "./react-vite-strategy";

export * from "./framework-strategy";
export * from "./angular-strategy";
export * from "./react-vite-strategy";

/** Stage factories of a repository's framework (exhaustive). */
export function stepFactoriesFor(framework: RepositoryFramework): PipelineStepFactories {
  switch (framework) {
    case RepositoryFramework.REACT_VITE:
      return reactViteStrategy.stepFactories();
    case RepositoryFramework.ANGULAR:
      return angularStrategy.stepFactories();
  }
}
