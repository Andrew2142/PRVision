/**
 * createPipelineContext() for pipeline step tests (sheet 14 §5.4.14): a PipelineContext (00 §8) wired to a
 * ScriptedAiProvider and a ConsoleRecorder, with cancel()/shutdown() that abort with the string reasons of
 * 00 §14.6.
 */
import path from "node:path";
import type { PipelineContext, PreparedWorkspace } from "../../../backend/src/types/visualization-pipeline";
import { ScriptedAiProvider, type Script } from "./ai-provider-stub";
import { ConsoleRecorder } from "./console-recorder";

export interface PipelineContextHandle {
  context: PipelineContext;
  ai: ScriptedAiProvider;
  console: ConsoleRecorder;
  abort: AbortController;
  cancel(): void; // isCancelled() → true and ctx.signal aborts with reason "cancelled"
  shutdown(): void; // ctx.signal aborts with reason "shutdown" (00 §14.6)
}

export interface CreatePipelineContextOptions {
  visualizationId?: number;
  dataDir: string;
  repositoryPath: string;
  baseDir?: string;
  headDir?: string;
  workspace?: Partial<PreparedWorkspace>;
  script?: Script;
  repository?: Partial<PipelineContext["repository"]>;
  /** 16 §6.12: defaults to { stateAllowance: 1, buildMode: "grow" } so existing tests keep their meaning. */
  library?: Partial<PipelineContext["library"]>;
}

/** Builds a PipelineContext for one visualization; worktree dirs default to <dataDir>/worktrees/<id>/{base,head}. */
export function createPipelineContext(options: CreatePipelineContextOptions): PipelineContextHandle {
  const visualizationId = options.visualizationId ?? 1;
  const ai = new ScriptedAiProvider(options.script ?? {});
  const recorder = new ConsoleRecorder();
  const abort = new AbortController();
  let cancelled = false;
  const context: PipelineContext = {
    visualizationId,
    workspace: {
      visualizationId,
      repositoryPath: options.repositoryPath,
      baseDir: options.baseDir ?? path.join(options.dataDir, "worktrees", String(visualizationId), "base"),
      headDir: options.headDir ?? path.join(options.dataDir, "worktrees", String(visualizationId), "head"),
      baseSha: "0".repeat(40),
      headSha: "1".repeat(40),
      sourceType: "local_branch",
      dependencyDrift: false,
      ...options.workspace
    },
    repository: {
      id: 1,
      localPath: options.repositoryPath,
      framework: "react_vite",
      appRoot: ".",
      angularProject: null,
      angularBuildConfiguration: null,
      viteConfigPath: "vite.config.ts",
      tsconfigPath: "tsconfig.json",
      entryFilePath: "src/main.tsx",
      globalStylePaths: ["/src/index.css"],
      ...options.repository
    },
    ai,
    aiSettings: { model: "claude-opus-5-5", harnessEffort: "high", summaryEffort: "medium" },
    console: recorder,
    isCancelled: () => Promise.resolve(cancelled),
    signal: abort.signal,
    library: { stateAllowance: 1, buildMode: "grow", ...options.library }
  };
  return {
    context,
    ai,
    console: recorder,
    abort,
    cancel: () => {
      cancelled = true;
      abort.abort("cancelled");
    },
    shutdown: () => {
      abort.abort("shutdown");
    }
  };
}
