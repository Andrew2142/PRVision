/**
 * Source queries of library jobs (16 §10.4 step 6, §11.4 step 2): 08's analysis state (React) or 15b's (Angular)
 * with no analysed rows and no changed files, over the job's worktrees. Scans pass one worktree for both sides.
 * Resolvers, graphs and component indexes are built lazily by the query objects.
 */
import { ANALYSIS_SOURCE_ROOT } from "../../config-consts";
import { RepositoryFramework } from "../../enums";
import type { ComponentSourceQueries, PipelineContext } from "../../types/visualization-pipeline";
import { createLogger } from "../../utilities";
import {
  detectAngularMajor,
  fallbackAngularWorkspaceLayout,
  readAngularWorkspaceLayout
} from "../visualizations/pipeline/angular/angular-component-index";
import {
  AngularSourceQueries,
  createAngularAnalysisState
} from "../visualizations/pipeline/angular/angular-source-queries";
import { ComponentDetector } from "../visualizations/pipeline/component-detector";
import { AnalysisSourceQueries, createAnalysisState } from "../visualizations/pipeline/component-source-queries";

/** The React source root of an app (08's rule: `<appRoot>/src`, `src` at the repository root). */
export function reactSourceRoot(appRoot: string): string {
  return appRoot === "." || appRoot === "" ? ANALYSIS_SOURCE_ROOT : `${appRoot}/${ANALYSIS_SOURCE_ROOT}`;
}

/**
 * Builds the ComponentSourceQueries of a library job context.
 *
 * @param ctx - The job's context (workspace and repository are read; nothing is written).
 */
export async function createWorkspaceSourceQueries(
  ctx: Pick<PipelineContext, "workspace" | "repository" | "libraryJob">
): Promise<ComponentSourceQueries> {
  const log = createLogger("library-source-queries", { libraryJobId: ctx.libraryJob?.libraryJobId ?? null });
  const detector = new ComponentDetector();
  const { workspace, repository } = ctx;
  if (repository.framework === RepositoryFramework.ANGULAR) {
    const layoutInput = {
      appRoot: repository.appRoot,
      angularProject: repository.angularProject,
      tsconfigPath: repository.tsconfigPath
    };
    const layout =
      (await readAngularWorkspaceLayout(workspace.headDir, layoutInput)) ??
      (await readAngularWorkspaceLayout(workspace.baseDir, layoutInput)) ??
      fallbackAngularWorkspaceLayout(repository.appRoot);
    const angularMajor = await detectAngularMajor(workspace.headDir, layout.appRoot, repository.localPath);
    return new AngularSourceQueries(
      createAngularAnalysisState({
        workspace,
        repository,
        layout,
        changes: new Map(),
        changedFiles: [],
        rows: [],
        detector,
        angularMajor,
        headResolver: null,
        headGraph: null,
        headIndex: null,
        baseIndex: null,
        log
      })
    );
  }
  return new AnalysisSourceQueries(
    createAnalysisState({
      workspace,
      repository,
      changes: new Map(),
      changedFiles: [],
      rows: [],
      detector,
      headResolver: null,
      headGraph: null,
      log,
      sourceRoot: reactSourceRoot(repository.appRoot)
    })
  );
}
