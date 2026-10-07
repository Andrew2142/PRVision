import type { AiEffort, ComponentChangeKind, VisualizationSourceType } from "../enums";
import type { HarnessStateSpec } from "./harness-library";

// 00 §14.7: PipelineStepError lives in pipeline-errors.ts and is re-exported from here.
export * from "./pipeline-errors";

/** One side of a visualization (00 §14.12: this file is its only home; sheets 04 and 08 import it). */
export type WorktreeSide = "base" | "head";

/** Produced by WorkspacePrepareService (07). */
export interface PreparedWorkspace {
  visualizationId: number;
  repositoryPath: string; // user's clone (read-only to PRVision)
  baseDir: string; // <dataDir>/worktrees/<id>/base
  headDir: string; // <dataDir>/worktrees/<id>/head
  baseSha: string; // merge-base for github_pr and local_branch (00 §14.7)
  headSha: string | null; // null for working_tree
  sourceType: (typeof VisualizationSourceType)[keyof typeof VisualizationSourceType];
  dependencyDrift: boolean; // package.json deps differ between sides
}

/** Produced by ChangeAnalysisService (08), one per component row. */
export interface ComponentCandidate {
  componentId: number; // visualization_components.id after insert
  filePath: string; // repo-relative, POSIX separators
  exportName: string; // "default" or the named export
  displayName: string;
  changeKind: (typeof ComponentChangeKind)[keyof typeof ComponentChangeKind];
  rank: number; // 0 = highest priority
  codeDiff: string | null; // unified diff of filePath (null for affected_parent)
  reason: string; // e.g. "imports changed hook src/hooks/useCart.ts"; stored in change_reason (00 §14.3)
  /**
   * 00 §17: only on `replaced` candidates. filePath/exportName/displayName above are the added head component (A);
   * this is the removed base component (R) it replaces, with the successor evidence. Absent or null otherwise.
   */
  predecessor?: ComponentPredecessor | null;
}

/** 00 §17: kinds of evidence that an added component replaces a removed one. */
export type SuccessorEvidenceKind = "call_site_swap" | "git_rename" | "name_similarity" | "content_similarity";

/** 00 §17: one piece of successor evidence (stored in `visualization_components.successor_evidence`). */
export interface SuccessorEvidence {
  kind: SuccessorEvidenceKind;
  detail: string;
}

/** 00 §17: the removed base component (R) of a `replaced` row. */
export interface ComponentPredecessor {
  filePath: string; // base-side path of R
  exportName: string;
  displayName: string;
  evidence: SuccessorEvidence[];
}

// ---- Sheet 08 §5.1.1 types (00 §14.12: this file is their home). WorktreeSide is declared above. ----

/** 00 §14.7: the only 08 → 09 hand-off. Every path is repo-relative POSIX; every method never rejects. */
export interface ComponentSourceQueries {
  /** Path of the component file on each side, rename-aware (section 5.14.7). null = the file does not exist on that side. */
  componentPaths(filePath: string): Promise<{ base: string | null; head: string | null }>;

  /** Props type declarations of the export (section 5.14.1). */
  resolveTypeSources(filePath: string, exportName: string, side: WorktreeSide): Promise<TypeSourceResult>;

  /** JSX usages of the export in other repo files, ordered source → story → test, diversified by file (section 5.14.2).
   *  `limit` is clamped to 1..CALL_SITE_MAX_LIMIT. */
  findCallSites(filePath: string, exportName: string, side: WorktreeSide, limit: number): Promise<CallSite[]>;

  /** Every top-level import / re-export / string-literal dynamic import of the file, in source order,
   *  including type-only imports (flagged). [] when the file does not exist on that side (section 5.14.3). */
  getDirectImports(filePath: string, side: WorktreeSide): Promise<DirectImport[]>;

  /** Runtime export names of a repo module ("default" included when present; type-only exports excluded),
   *  sorted, with `export *` re-exports followed up to 3 hops. null when the file is not a parseable script on that side. */
  getModuleExports(filePath: string, side: WorktreeSide): Promise<string[] | null>;

  /** Resolves `specifier` as if imported from `fromFilePath` on that side (tsconfig paths, Vite aliases, relative, root-relative).
   *  Returns a repo-relative path for repo files, "package:<name>" for an installed bare package
   *  (<root>/node_modules/<name>/package.json exists), or null (unresolvable, virtual, URL, or not installed). */
  resolveSpecifier(fromFilePath: string, specifier: string, side: WorktreeSide): Promise<string | null>;

  /** Changed files (from changedFiles, analysable only) reachable from filePath through forward
   *  import/reexport/dynamic/style edges of that side's graph, depth 1..maxDepth (≤ 3), nearest first, then path.
   *  Excludes filePath itself. At most 10 entries. */
  changedDependenciesOf(filePath: string, side: WorktreeSide, maxDepth: number): Promise<ChangedDependency[]>;
}

export interface TypeSourceResult {
  filePath: string;
  exportName: string;
  side: WorktreeSide;
  found: boolean; // false when the component could not be located (all other fields empty/null)
  propsTypeName: string | null; // "ButtonProps", null for inline/untyped
  parameterText: string | null; // first parameter as written, e.g. "{ label, variant = \"primary\" }: ButtonProps"
  sources: Array<{
    name: string; // declaration name, or "(inline)", "(propTypes)", "(defaultProps)"
    filePath: string; // repo-relative file where the text was found
    startLine: number; // 1-based, inclusive (line of node.getStart(sf))
    endLine: number; // 1-based, inclusive
    kind: "interface" | "type" | "enum" | "class" | "inline" | "propTypes" | "defaultProps";
    depth: 0 | 1;
    text: string; // exact source text of the declaration (node.getText(sf))
  }>;
  unresolved: string[]; // referenced type names not found in repo src (external or missing), sorted
  truncated: boolean; // TYPE_SOURCES_MAX_CHARS or TYPE_SOURCES_MAX_RELATED hit
}

export interface CallSite {
  filePath: string; // repo-relative importer (may equal the component's own file)
  role: "source" | "story" | "test";
  line: number; // 1-based line of the opening tag
  startLine: number; // snippet range, 1-based inclusive
  endLine: number;
  usedAs: string; // tag text as written, e.g. "Button" or "UI.Button"
  snippet: string; // header line + raw source lines startLine..endLine
}

export interface DirectImport {
  specifier: string; // exactly as written, e.g. "@/hooks/useAuth"
  line: number; // 1-based
  kind: "relative" | "alias" | "package" | "style" | "asset";
  resolvedPath: string | null; // repo-relative target for repo files; null for packages, assets, unresolved
  defaultImport: boolean; // import X from "…"  /  export { default } from "…"
  namespaceImport: boolean; // import * as X from "…"  /  export * from "…"  /  export * as NS from "…"
  namedImports: string[]; // imported (not local) runtime names, sorted; type-only specifiers excluded
  typeOnly: boolean; // `import type …` or every specifier is `type`
  sideEffectOnly: boolean; // import "…"
  reexport: boolean; // export … from "…"
  dynamic: boolean; // import("…") with a string literal (incl. React.lazy)
}

export interface ChangedDependency {
  path: string; // head path (base path when side = "base" and the file was deleted/renamed)
  status: "A" | "M" | "D" | "R";
  depth: number; // 1 = imported directly by filePath
  codeDiff: string; // 08's unified diff of that file, truncated at CODE_DIFF_MAX_LINES with the 08 marker
}

export interface ChangeAnalysisResult {
  candidates: ComponentCandidate[]; // rendered set, capped
  skipped: Array<Omit<ComponentCandidate, "componentId"> & { skipReason: string }>;
  changedFiles: Array<{ path: string; status: "A" | "M" | "D" | "R"; previousPath?: string }>;
  sourceQueries: ComponentSourceQueries; // 00 §14.7
  /** NEW (16 §6.12): changed stylesheets analysis classifies as global, head paths, sorted (§8.5.2). */
  globalStyleChanges: string[];
}

/** Produced by HarnessGenerationService (09). */
export interface MockedModule {
  specifier: string;
  source: string;
}
export interface HarnessGenerationResult {
  componentId: number;
  harnessSource: string; // TSX module, default export definePrvisionHarness({ wrapper?, states }) (16 §7.3)
  mockedModules: MockedModule[];
  notes: string;
  /**
   * 00 §17: `replaced` rows only. The harness of the removed base component (R), built from base sources; the
   * fields above are then the head harness of the added component (A). Absent or null for every other row.
   */
  baseHarness?: SideHarness | null;
  /** NEW (16 §6.12): states of the head harness (or the only harness), extracted by §7.7. Default first. */
  states: HarnessStateSpec[];
  /** NEW: where the head harness came from; `library` results were not generated in this run. */
  origin: "library" | "written";
  /** NEW: library entry the head harness came from or was saved to; null until saved. */
  libraryEntryId: number | null;
  /** NEW (16 §8.6.1): usage of every call made for this result (generation + correction, or repair calls). */
  usage?: AiUsage;
}

/** One side's harness of a `replaced` row (00 §17). */
export interface SideHarness {
  harnessSource: string;
  mockedModules: MockedModule[];
  notes: string;
  states: HarnessStateSpec[]; // NEW (16 §6.12)
  origin: "library" | "written"; // NEW
  libraryEntryId: number | null; // NEW
}

// ---- Sheet 09 §5.1 types (00 §14.12: this file is their home). Added by sheet 07 in wave 3 because the
// orchestrator's repair adapter needs them before sheet 09 lands; copied verbatim from 09 §5.1. ----

/** Built by sheet 10 (10 §5.13.6) from the failing side results of the attempt that triggered repair. */
export interface HarnessRenderError {
  sides: Array<"base" | "head">; // every present side; all of them failed (repair trigger, 00 §14.7)
  kind: "module_load" | "render_error" | "timeout" | "step_failed"; // 10's RenderFailureKind of the primary side (only repairable kinds; step_failed: 16 §6.12)
  message: string; // 10's formatRenderError output for the primary side (10 §5.12.3), ≤ RENDER_ERROR_MAX_CHARS
  otherSideMessage: string | null; // formatted error of the other present side, ≤ 1 000 chars; null when only one side
  /** 00 §17: `replaced` rows only — the side whose own harness is repaired (`sides` is then `[targetSide]`). */
  targetSide?: "base" | "head";
  /** NEW (16 §6.12): the failing state (§9.6); absent = Default. */
  stateName?: string;
}

export interface HarnessGenerationFailure {
  componentId: number;
  kind: "ai_error" | "invalid_harness" | "cannot_render" | "context_error";
  aiReason: AiProviderError["reason"] | null;
  message: string; // user-facing, also stored in harness_notes
}

export interface HarnessGenerationBatchResult {
  results: HarnessGenerationResult[]; // validated harnesses, ordered by candidate rank
  failures: HarnessGenerationFailure[];
  usage: AiUsage; // usage spent in this stage only
  cancelled: boolean; // true when the loop stopped because of cancellation
  /** NEW (16 §6.12): set when the loop stopped early (§10.5). */
  stopReason?: "cancelled" | "spend_cap";
}

/** Returned by repairHarness. Never persisted by 09 (00 §14.7). */
export type HarnessRepairOutcome =
  | { ok: true; result: HarnessGenerationResult } // validated; result.notes already contains the "Repaired after …" line
  | { ok: false; reason: "component_defect" | "cannot_render"; message: string; notesAppendix: string } // 10 appends notesAppendix
  | { ok: false; reason: "invalid_harness" | "ai_error" | "cancelled" | "budget_exhausted"; message: string };

/** Produced by RenderService (10). */
export interface RenderSideResult {
  side: "base" | "head";
  ok: boolean;
  imagePath: string | null; // relative to dataDir: artifacts/<v>/<c>/<side>.png (00 §14.3)
  width: number | null;
  height: number | null;
  error: string | null;
  consoleErrors: string[];
  durationMs: number;
  failureKind: RenderFailureKindValue | null; // NEW (16 §6.12): 10's RenderFailureKind (incl. "step_failed"); null when ok
}
/** NEW (16 §6.12): 10's RenderFailureKind as a contract type (a type-level test asserts both are equal). */
export type RenderFailureKindValue =
  | "vite_unavailable"
  | "navigation"
  | "module_load"
  | "render_error"
  | "timeout"
  | "step_failed"
  | "browser"
  | "screenshot"
  | "file_missing"
  | "budget_exceeded"
  | "cancelled";

/** NEW (16 §9): one state's render on both sides. ordinal 0 = Default. */
export interface StateRenderResult {
  ordinal: number;
  stateName: string;
  base: RenderSideResult | null; // null when the state does not exist on that side or the side is absent
  head: RenderSideResult | null;
}
/** ComponentRenderResult (10); `base`/`head` stay and mirror state 0 (Default) (16 §6.12). */
export interface ComponentRenderResult {
  componentId: number;
  base: RenderSideResult | null; // null when the component does not exist on that side
  head: RenderSideResult | null;
  states: StateRenderResult[]; // NEW, ordinal order; [] only for rows that never reached rendering
}

/** NEW (16 §9.5): per-state diff result. */
export interface StateDiffResult {
  ordinal: number;
  stateName: string;
  visualChange: "changed" | "unchanged" | "new" | "deleted" | null;
  diffImagePath: string | null;
  diffPixelRatio: number | null;
  width: number | null;
  height: number | null;
}
/** Produced by ImageDiffService (11). */
export interface ImageDiffResult {
  componentId: number;
  diffImagePath: string; // relative to dataDir
  diffPixelRatio: number; // 0..1
  width: number;
  height: number;
  states: StateDiffResult[]; // NEW (16 §6.12)
}

/** Produced by StructuralDiffService (11). Stored in visualization_components.structural_diff. */
export type StructuralChange =
  | { kind: "element_added"; path: string; tag: string }
  | { kind: "element_removed"; path: string; tag: string }
  | {
      kind: "attribute_changed";
      path: string;
      tag: string;
      attribute: string;
      before: string | null;
      after: string | null;
      tokensAdded?: string[]; // 00 §14.4 (className only)
      tokensRemoved?: string[]; // 00 §14.4 (className only)
    }
  | { kind: "text_changed"; path: string; before: string; after: string };

/** AI provider contract (05). Consumed by 09 and 11. */
export interface AiStructuredRequest {
  purpose: "harness" | "harness_repair" | "summary" | "connection_test";
  system: string;
  prompt: string;
  images?: Array<{ mediaType: "image/png"; base64: string; label: string }>;
  jsonSchema: Record<string, unknown>; // JSON Schema draft 2020-12, additionalProperties:false
  effort: (typeof AiEffort)[keyof typeof AiEffort];
  workingDirectory?: string; // worktree the request is about (informational; not sent to the API)
  signal?: AbortSignal;
}
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  cacheReadInputTokens?: number; // 00 §14.4
  cacheWriteInputTokens?: number; // 16 §6.13: already included in inputTokens, like cacheReadInputTokens
}
export interface AiStructuredResult<T> {
  data: T;
  usage: AiUsage;
  model: string;
}
export interface AiProvider {
  readonly kind: "anthropic_api";
  generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>>;
}

/** Raised by providers; pipeline maps it to component/visualization failures. */
export class AiProviderError extends Error {
  override readonly name = "AiProviderError";

  constructor(
    message: string,
    readonly reason:
      | "auth"
      | "config"
      | "rate_limit"
      | "refusal"
      | "max_tokens"
      | "invalid_output"
      | "network"
      | "aborted"
      | "unknown",
    readonly retryable: boolean,
    readonly usage?: AiUsage // 00 §14.4: tokens spent on a failed call
  ) {
    super(message);
  }
}

/** Pipeline context passed through the orchestrator (07). */
export interface PipelineContext {
  visualizationId: number;
  workspace: PreparedWorkspace;
  repository: {
    id: number;
    localPath: string;
    /** 15 §5.2.1 */
    framework: "react_vite" | "angular";
    /** Repo-relative POSIX folder of the app; "." = repository root. */
    appRoot: string;
    /** Project name in angular.json (angular only). */
    angularProject: string | null;
    /** Build configuration, e.g. "development"; null = the build target's base options only. */
    angularBuildConfiguration: string | null;
    viteConfigPath: string | null;
    /** angular: the build target's tsConfig, repo-relative. */
    tsconfigPath: string | null;
    /** angular: the build target's browser/main, repo-relative. */
    entryFilePath: string | null;
    /** angular: informational (the builder injects them). */
    globalStylePaths: string[];
    /** Screen size screenshots are taken at; absent = desktop. */
    renderViewport?: "desktop" | "tablet" | "mobile";
  };
  /** Components to render this run (the user's confirmed limit); absent = MAX_COMPONENTS. */
  componentLimit?: number;
  ai: AiProvider;
  aiSettings: {
    model: string;
    harnessEffort: AiStructuredRequest["effort"];
    summaryEffort: AiStructuredRequest["effort"];
  };
  console: {
    info(stage: string, message: string): Promise<void>;
    warn(stage: string, message: string): Promise<void>;
    error(stage: string, message: string): Promise<void>;
  };
  isCancelled(): Promise<boolean>;
  /** Aborts on cancel, shutdown or overall timeout; `signal.reason` is "cancelled" | "shutdown" | a TimeoutError (00 §14.6). */
  signal: AbortSignal;
  /** NEW (16 §6.12): library settings of the repository for this run (snapshot at job start). */
  library: { stateAllowance: number; buildMode: "grow" | "scan" };
  /** NEW: set for library jobs (scan, repair); absent for visualization runs. visualizationId is then 0 for scans. */
  libraryJob?: { kind: "scan" | "rescan" | "repair"; libraryJobId: number };
}
