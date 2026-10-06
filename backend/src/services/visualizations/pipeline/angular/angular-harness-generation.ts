/**
 * Factory of the Angular generating_harnesses stage (15 §5.3, §5.6.2): 09's HarnessGenerationService with the
 * Angular context builder, validator and prompts. Concurrency, correction, repair, persistence and AI usage
 * recording are 09's, unchanged.
 */
import { isAngularSourceQueries } from "../../../../types/angular-analysis";
import {
  PipelineStepError,
  type ComponentSourceQueries,
  type PipelineContext
} from "../../../../types/visualization-pipeline";
import { SafeFileReader } from "../harness-context-builder";
import { HarnessGenerationService, type HarnessGenerationDeps } from "../harness-generation-service";
import { AngularHarnessContextBuilder } from "./angular-harness-context-builder";
import { ANGULAR_HARNESS_PROMPTS } from "./angular-harness-prompts";
import { AngularHarnessValidator } from "./angular-harness-validator";

/** Collaborators a caller (tests) may still override; the Angular ports are always the Angular ones. */
export type AngularHarnessGenerationDeps = Omit<HarnessGenerationDeps, "contextBuilder" | "validator" | "prompts">;

/**
 * The harness stage of an Angular visualization.
 *
 * @throws PipelineStepError (generating_harnesses, code ANGULAR_QUERIES_MISSING) when the analysis stage did not
 *   hand over Angular source queries.
 */
export function createAngularHarnessGeneration(
  ctx: PipelineContext,
  queries: ComponentSourceQueries,
  deps: AngularHarnessGenerationDeps = {}
): HarnessGenerationService {
  if (!isAngularSourceQueries(queries)) {
    throw new PipelineStepError(
      "generating_harnesses",
      "Internal error: Angular analysis did not provide Angular source queries.",
      { code: "ANGULAR_QUERIES_MISSING" }
    );
  }
  const reader = new SafeFileReader(ctx.workspace);
  return new HarnessGenerationService(ctx, queries, {
    ...deps,
    contextBuilder: new AngularHarnessContextBuilder(ctx, queries, reader),
    validator: new AngularHarnessValidator(queries, (side, repoRelativePath) => reader.exists(side, repoRelativePath)),
    prompts: ANGULAR_HARNESS_PROMPTS
  });
}
