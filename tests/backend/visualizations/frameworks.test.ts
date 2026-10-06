import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositoryFramework, Table } from "../../../backend/src/enums";
import { AngularChangeAnalysisService } from "../../../backend/src/services/visualizations/pipeline/angular/angular-change-analysis-service";
import { AngularStructuralDiffService } from "../../../backend/src/services/visualizations/pipeline/angular/angular-structural-diff-service";
import { ChangeAnalysisService } from "../../../backend/src/services/visualizations/pipeline/change-analysis-service";
import {
  angularStepFactories,
  angularStrategy,
  reactViteStepFactories,
  reactViteStrategy,
  stepFactoriesFor
} from "../../../backend/src/services/visualizations/pipeline/frameworks";
import { HarnessGenerationService } from "../../../backend/src/services/visualizations/pipeline/harness-generation-service";
import { ImageDiffService } from "../../../backend/src/services/visualizations/pipeline/image-diff-service";
import { AngularRenderService } from "../../../backend/src/services/visualizations/pipeline/render/angular/angular-render-service";
import { RenderService } from "../../../backend/src/services/visualizations/pipeline/render-service";
import {
  defaultPipelineStepFactories,
  type PipelineStepFactories
} from "../../../backend/src/services/visualizations/pipeline/stage-registry";
import { StructuralDiffService } from "../../../backend/src/services/visualizations/pipeline/structural-diff-service";
import { SummaryService } from "../../../backend/src/services/visualizations/pipeline/summary-service";
import { VisualizationWorkerService } from "../../../backend/src/services/visualizations/pipeline/visualization-worker-service";
import { VisualizationConsoleService } from "../../../backend/src/services/visualizations/visualization-console-service";
import {
  PipelineStepError,
  type AiProvider,
  type ComponentSourceQueries,
  type PreparedWorkspace
} from "../../../backend/src/types/visualization-pipeline";
import type { QueryHandler, ResolvedAiSettings } from "../../../backend/src/utilities";
import { makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { makeJob } from "../helpers/fake-queue";
import { createPipelineContext } from "../helpers/pipeline-context";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { FakeQueueStatics, fakeSteps } from "./helpers/fakes";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const SETTINGS: ResolvedAiSettings = {
  provider: "claude_code",
  model: "claude-opus-5-5",
  harnessEffort: "high",
  summaryEffort: "medium",
  anthropicApiKey: { state: "absent" }
};
const PROVIDER: AiProvider = { kind: "claude_code", generateStructured: () => Promise.reject(new Error("not used")) };
const REPAIR = { repairHarness: () => Promise.reject(new Error("not used")) };

function constructors(steps: PipelineStepFactories): string[] {
  const ctx = createPipelineContext({ dataDir: "/tmp/prvision-frameworks", repositoryPath: "/tmp/repo" }).context;
  const angularQueries = { framework: "angular" } as unknown as ComponentSourceQueries;
  return [
    steps.changeAnalysis().constructor.name,
    steps.harnessGeneration(ctx, angularQueries).constructor.name,
    steps.render(REPAIR).constructor.name,
    steps.imageDiff().constructor.name,
    steps.structuralDiff().constructor.name,
    steps.summary().constructor.name
  ];
}

test("stepFactoriesFor returns the React factories (same constructors as defaultPipelineStepFactories) for react_vite", () => {
  const steps = stepFactoriesFor(RepositoryFramework.REACT_VITE);
  assert.ok(steps.changeAnalysis() instanceof ChangeAnalysisService);
  assert.ok(steps.render(REPAIR) instanceof RenderService);
  assert.ok(steps.structuralDiff() instanceof StructuralDiffService);
  assert.ok(steps.imageDiff() instanceof ImageDiffService);
  assert.ok(steps.summary() instanceof SummaryService);
  assert.deepEqual(constructors(steps), constructors(defaultPipelineStepFactories()));
  assert.deepEqual(constructors(reactViteStepFactories()), constructors(defaultPipelineStepFactories()));
  assert.equal(reactViteStrategy.framework, "react_vite");
});

test("stepFactoriesFor returns the Angular factories for angular", () => {
  const steps = stepFactoriesFor(RepositoryFramework.ANGULAR);
  assert.ok(steps.changeAnalysis() instanceof AngularChangeAnalysisService);
  assert.ok(steps.render(REPAIR) instanceof AngularRenderService);
  assert.ok(steps.imageDiff() instanceof ImageDiffService);
  assert.ok(steps.structuralDiff() instanceof AngularStructuralDiffService);
  assert.ok(steps.summary() instanceof SummaryService);
  assert.deepEqual(constructors(steps), constructors(angularStepFactories()));
  assert.equal(angularStrategy.framework, "angular");
});

test("angular harnessGeneration is 09's HarnessGenerationService and rejects non-Angular source queries", () => {
  const ctx = createPipelineContext({ dataDir: "/tmp/prvision-frameworks", repositoryPath: "/tmp/repo" }).context;
  const steps = stepFactoriesFor(RepositoryFramework.ANGULAR);
  const angularQueries = { framework: "angular" } as unknown as ComponentSourceQueries;
  assert.ok(steps.harnessGeneration(ctx, angularQueries) instanceof HarnessGenerationService);
  assert.throws(
    () => steps.harnessGeneration(ctx, {} as ComponentSourceQueries),
    (error: unknown) => error instanceof PipelineStepError && error.stage === "generating_harnesses"
  );
});

function workspaceFor(id: number): PreparedWorkspace {
  return {
    visualizationId: id,
    repositoryPath: "/tmp/repo",
    baseDir: `/data/worktrees/${String(id)}/base`,
    headDir: `/data/worktrees/${String(id)}/head`,
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    sourceType: "local_branch",
    dependencyDrift: false
  };
}

function workerFor(framework: "react_vite" | "angular", options: { overrideSteps: boolean }) {
  const store = new InMemoryQueryHandler();
  store.now = () => NOW;
  store.seed(Table.REPOSITORIES, [
    makeRepositoryRow(
      framework === "angular"
        ? {
            id: 1,
            localPath: "/tmp/repo",
            framework: "angular",
            appRoot: "src/app-one",
            angularProject: "app-one",
            angularBuildConfiguration: "development",
            viteConfigPath: null
          }
        : { id: 1, localPath: "/tmp/repo" }
    )
  ]);
  store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "queued" })]);
  const { steps, calls } = fakeSteps({});
  const requested: string[] = [];
  const worker = new VisualizationWorkerService({
    queryHandler: store as unknown as QueryHandler,
    workspace: {
      prepare: (input) => Promise.resolve(workspaceFor(input.visualizationId)),
      cleanup: () => Promise.resolve()
    },
    readAiSettings: () => Promise.resolve(SETTINGS),
    createProvider: () => PROVIDER,
    ...(options.overrideSteps ? { steps } : {}),
    stepsFor: (requestedFramework) => {
      requested.push(requestedFramework);
      return steps;
    },
    queue: new FakeQueueStatics(),
    consoleFactory: (id) => new VisualizationConsoleService(id, store),
    now: () => NOW,
    limits: { maxRuntimeMs: 60_000, stepAbortGraceMs: 200 }
  });
  return { worker, calls, requested };
}

test("VisualizationWorkerService.run asks stepsFor once with the repository framework when no steps override is set", async () => {
  for (const framework of ["react_vite", "angular"] as const) {
    const { worker, calls, requested } = workerFor(framework, { overrideSteps: false });
    assert.equal(await worker.run(makeJob(1).job), "completed");
    assert.deepEqual(requested, [framework]);
    assert.equal(calls.analyzeCtx?.repository.framework, framework);
    if (framework === "angular") {
      assert.equal(calls.analyzeCtx.repository.appRoot, "src/app-one");
      assert.equal(calls.analyzeCtx.repository.angularProject, "app-one");
    }
  }
});

test("VisualizationWorkerService.run uses deps.steps for every framework when it is set (stepsFor is not called)", async () => {
  const { worker, calls, requested } = workerFor("angular", { overrideSteps: true });
  assert.equal(await worker.run(makeJob(1).job), "completed");
  assert.deepEqual(requested, []);
  assert.ok(calls.order.includes("analyze"));
});
