/**
 * Wiring for HarnessGenerationService tests: temp worktrees with one component file per candidate, a fake
 * ComponentSourceQueries, a PipelineContext with a ScriptedAiProvider, and an InMemoryQueryHandler seeded with
 * the visualization and its component rows.
 */
import type { TestContext } from "node:test";
import { Table } from "../../../../backend/src/enums";
import {
  HarnessGenerationService,
  type HarnessGenerationDeps
} from "../../../../backend/src/services/visualizations/pipeline/harness-generation-service";
import type { HarnessAiResponse } from "../../../../backend/src/services/visualizations/pipeline/harness-prompts";
import type { ComponentCandidate } from "../../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../../backend/src/utilities";
import type { ScriptedAiProvider, Script } from "../../helpers/ai-provider-stub";
import type { ConsoleRecorder } from "../../helpers/console-recorder";
import { makeComponentRow, makeVisualizationRow } from "../../helpers/factories";
import { createPipelineContext, type PipelineContextHandle } from "../../helpers/pipeline-context";
import { InMemoryQueryHandler } from "../../helpers/query-handler-stub";
import { FakeSourceQueries } from "./fake-source-queries";
import { createTempWorktrees, type TempWorktrees } from "./temp-worktrees";

export const VISUALIZATION_ID = 1;

/** A named-export component candidate at src/components/<Name>/<Name>.tsx. */
export function componentCandidate(name: string, overrides: Partial<ComponentCandidate> = {}): ComponentCandidate {
  return {
    componentId: overrides.componentId ?? 1,
    filePath: `src/components/${name}/${name}.tsx`,
    exportName: name,
    displayName: name,
    changeKind: "modified",
    rank: 0,
    codeDiff: "@@ -1 +1 @@\n-old\n+new",
    reason: "Component code changed",
    ...overrides
  };
}

/** A harness that passes HarnessValidator for componentCandidate(name). */
export function validHarness(name: string): string {
  return [
    'import type { ReactElement } from "react";',
    `import { ${name} } from "../../src/components/${name}/${name}";`,
    "",
    "export default function PRVisionHarness(): ReactElement {",
    `  return <div style={{ padding: 24, width: 360 }}><${name} /></div>;`,
    "}"
  ].join("\n");
}

/** Same harness with a wrong default export name (fails default_export_wrong_name). */
export function invalidHarness(name: string): string {
  return validHarness(name).replace("function PRVisionHarness", "function Harness");
}

export function okResponse(name: string, overrides: Partial<HarnessAiResponse> = {}): HarnessAiResponse {
  return { status: "ok", harnessSource: validHarness(name), mockedModules: [], notes: `Shows ${name}.`, ...overrides };
}

export interface ServiceSetup {
  service: HarnessGenerationService;
  handle: PipelineContextHandle;
  ai: ScriptedAiProvider;
  console: ConsoleRecorder;
  db: InMemoryQueryHandler;
  queries: FakeSourceQueries;
  trees: TempWorktrees;
  sleeps: number[];
}

export interface ServiceSetupOptions {
  script?: Script;
  candidates: ComponentCandidate[];
  /** Which sides each candidate file exists on (default: base and head unless added/removed). */
  deps?: HarnessGenerationDeps;
}

/** Builds the service for `candidates`; every candidate file is written on the sides its change kind implies. */
export function setupService(t: TestContext, options: ServiceSetupOptions): ServiceSetup {
  const trees = createTempWorktrees(t);
  for (const candidate of options.candidates) {
    const source = `export function ${candidate.exportName}() { return <span>${candidate.displayName}</span>; }\n`;
    if (candidate.changeKind !== "added") {
      trees.write("base", candidate.filePath, source);
    }
    if (candidate.changeKind !== "removed") {
      trees.write("head", candidate.filePath, source);
    }
  }
  trees.write("both", "package.json", JSON.stringify({ dependencies: { react: "^19.0.0", clsx: "^2.1.0" } }));
  const queries = new FakeSourceQueries({ files: { base: trees.files.base, head: trees.files.head } });
  const handle = createPipelineContext({
    visualizationId: VISUALIZATION_ID,
    dataDir: trees.root,
    repositoryPath: trees.root,
    baseDir: trees.baseDir,
    headDir: trees.headDir,
    ...(options.script ? { script: options.script } : {})
  });
  const db = new InMemoryQueryHandler();
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: VISUALIZATION_ID, status: "generating_harnesses" })]);
  db.seed(
    Table.VISUALIZATION_COMPONENTS,
    options.candidates.map((candidate) =>
      makeComponentRow({
        id: candidate.componentId,
        visualizationId: VISUALIZATION_ID,
        filePath: candidate.filePath,
        exportName: candidate.exportName,
        displayName: candidate.displayName,
        changeKind: candidate.changeKind,
        rank: candidate.rank,
        codeDiff: candidate.codeDiff,
        changeReason: candidate.reason
      })
    )
  );
  const sleeps: number[] = [];
  const service = new HarnessGenerationService(handle.context, queries, {
    queryHandler: db as unknown as QueryHandler,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
    ...options.deps
  });
  return { service, handle, ai: handle.ai, console: handle.console, db, queries, trees, sleeps };
}
