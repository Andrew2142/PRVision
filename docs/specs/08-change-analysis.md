# 08 — Change Analysis

Owner: build agent (wave 4)
Status: ready to build
Depends on: 00 (contracts, esp. §14.3 and §14.7), 01 (standards), 03 (tables/models), 04 (`GitClient`, `QueryHandler`, `DrizzleDb`, `logger`, `PipelineStepError`), 07 (`PreparedWorkspace`, orchestrator calls `analyze`)
Consumed by: 09 (candidates + `ChangeAnalysisResult.sourceQueries: ComponentSourceQueries`), 10 (candidates, `changedFiles` for renamed components), 11 (candidates, `changedFiles`, `ComponentDetector` for structural diff)

---

## 1. Purpose

Given a prepared workspace (base and head worktrees on disk), decide **which React components the change touches**, persist one `visualization_components` row per component, and return a ranked, capped `ChangeAnalysisResult`.

The service answers four questions:

1. Which files changed? (git name-status, rename aware)
2. Which exported React components inside those files actually changed? (TypeScript AST, per-export comparison so formatting-only edits and edits to sibling exports do not count)
3. Which components are visually affected *indirectly* because they import a changed hook, util, context or stylesheet? (import graph, reverse BFS)
4. Which of these do we render, in what order? (ranking + `MAX_COMPONENTS` cap; the rest are stored as `skipped`)

It also builds a narrow, read-only query object, `ChangeAnalysisResult.sourceQueries: ComponentSourceQueries` (00 §14.7, defined once in section 5.1), that sheet 09 uses while writing harnesses: props type sources, real JSX call sites, direct imports, module exports, specifier resolution and changed dependencies, each for an explicit side. This object is the **only** hand-off from 08 to 09; no service instance is passed between stages.

Everything here is static analysis. Nothing in the target repo is executed — not the Vite config, not tsconfig plugins, not package scripts.

## 2. Scope / Out of scope

In scope:

- Changed-file discovery for all three source types (`github_pr`, `local_branch`, `working_tree`).
- Path filters (what counts as analysable source).
- React component detection with the TypeScript compiler API (syntactic only, no type checker).
- Per-export change detection via normalized "export closure" text.
- Module resolution: tsconfig `paths`/`baseUrl` (incl. project references), statically readable Vite `resolve.alias`, CSS/SCSS imports, CSS-module `composes`.
- Import graph over head `src/` (and lazily base `src/`), reverse edges.
- Affected-parent propagation (nearest exported importing components, depth ≤ 3, ≤ `MAX_PARENTS_PER_MODULE` per changed module).
- Ranking, capping, skip reasons.
- Per-file unified code diff (truncated at 400 lines).
- Inserting `visualization_components` rows in one transaction and returning their ids.
- The `ComponentSourceQueries` object for sheet 09 (section 5.14).
- Writing `visualization_components.change_reason` and `skip_reason` (00 §14.3).
- Limits, budgets and per-visualization caching.

Out of scope:

- Creating worktrees, resolving SHAs, computing the merge base (sheet 07).
- Writing harnesses, rendering, pixel or structural diff, summaries (09, 10, 11).
- Type-checker based analysis (no `ts.Program`, no `TypeChecker`). All resolution is syntactic + module resolution.
- Components produced by HOCs other than `memo`/`forwardRef` (`connect()`, `observer()`, `styled()`, `withRouter()`…) — not detected in the prototype (documented limitation, section 6).
- Changes outside `src/` (Tailwind config, `index.html`, `package.json`). They are reported in `changedFiles` and produce a console warning, never candidates.
- Angular / Next.js targets.

## 3. Dependencies

### 3.1 Sheets and contracts

| From | What | Used for |
|---|---|---|
| 00 §8, §14.7 | `PreparedWorkspace`, `ComponentCandidate`, `ChangeAnalysisResult` (incl. `sourceQueries`), `PipelineContext` | input/output types |
| 00 §5 | `ComponentChangeKind`, `ComponentRenderStatus`, `Table` | row values |
| 00 §6, §14.3 | `visualization_components` (incl. `change_reason`, `skip_reason`), `visualizations.component_count` | persistence |
| 03 | Drizzle schema, `VisualizationComponentModel` (optional; plain records are fine) | persistence |
| 04 | `GitClient` (§9.5), `QueryHandler` (§8.4), `DrizzleDb.transaction` (§9.2), `DeletionMode`, `createLogger` (§9.10), `PipelineStepError` (§10), `paths.ts` helpers (§9.7) | infra |
| 07 | calls `analyze(ctx)` during status `analyzing`; keeps the returned `ChangeAnalysisResult` (and therefore `sourceQueries`) in memory and the worktrees on disk until summarizing ends (00 §14.7); constructs 09 with `analysis.sourceQueries` | orchestration |

### 3.2 Neighbour APIs used (exactly as defined by sheet 04 and 00 §14.7/§14.8)

```ts
// backend/src/utilities/services/git-client.ts (04 §9.5)
/** One `--name-status -z` record, uninterpreted: git's own status letter (04 parseNameStatusZ). */
export interface GitNameStatusEntry {
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";
  score?: number;                 // R/C similarity
  path: string;                   // new path (R/C) or the only path, exactly as git printed it
  previousPath?: string;          // R/C only
}
export class GitClient {
  /** git diff --name-status -z (-M | --no-renames) --no-ext-diff --no-textconv --no-color --end-of-options <from> [<to>] -- [pathspecs…] */
  diffNameStatus(cwd: string, from: string, to: string | null,
    diffOptions?: { renames?: boolean; pathspecs?: string[] }, options?: GitCallOptions): Promise<GitNameStatusEntry[]>;
  /** git diff --no-index --name-status -z (-M | --no-renames) --no-ext-diff --no-textconv --no-color -- <left> <right>
   *  Exit code 1 ("differences found") is success. Paths come back prefixed with left/ and right/. Required by 00 §14.8. */
  diffNameStatusNoIndex(cwd: string, left: string, right: string,
    diffOptions?: { renames?: boolean }, options?: GitCallOptions): Promise<GitNameStatusEntry[]>;
}
// GitCallOptions = { signal?: AbortSignal; timeoutMs?: number }. Mapping git's letters to the 00 §8 changedFiles
// statuses (C→A, T/U→M, X dropped) is 08's job (04 §9.5; section 5.4 normalizeEntries).
// Failures throw GitCommandError (code: unknown_revision | timeout | aborted | command_failed | …).

// backend/src/types/pipeline-errors.ts (04 §10; 00 §14.7)
new PipelineStepError("analyzing", userMessage, { code, detail, cause });   // code = the ANALYSIS_* code from section 6

// backend/src/utilities/handlers/query-handler.ts (04 §8.4)
new QueryHandler(tx?: DbExecutor)
insert(rows, Table.X): Promise<ApiResponse<Record<string, unknown>[]>>   // data = inserted rows (returning)
update(values, conditions: Conditions, Table.X): Promise<ApiResponse<{ rowsAffected: number }>>   // 404 when 0 rows
delete(conditions, Table.X, DeletionMode.HARD): Promise<ApiResponse<{ rowsAffected: number }>>   // 404 when 0 rows (not an error here)

// backend/src/utilities/services/drizzle-db.ts (04 §9.2)
DrizzleDb.transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
```

### 3.3 npm packages

| Package | Version | Why |
|---|---|---|
| `typescript` | `~5.9` (runtime dependency, already in backend deps) | `createSourceFile`, `resolveModuleName`, `transpileModule`, `createPrinter`, config parsing |
| `diff` (jsdiff) | `^8` (ships its own types; no `@types/diff`) | `structuredPatch` for unified code diffs from file contents (both worktrees are on disk; one code path for all source types). Runtime dependency per 00 §14.1. 08 is the only sheet that imports `diff`; 09 and 11 get diffs through 08's exports. |

No other packages. No `glob`: directory walking is a small hand-written recursive `fs.readdir` (section 5.10.1).

### 3.4 Config constants

All constants live in `backend/src/config-consts/render.config.ts`; sheet 02 owns the consolidated list (00 §14.8) and must ship exactly these names and values. Import them from the `config-consts` barrel. Never redefine them locally.

```ts
export const MAX_COMPONENTS = 12;                    // rendered candidates per visualization (sheet 14 fixtures assume 12)
export const MAX_PARENTS_PER_MODULE = 2;             // affected parents per seed
export const ANALYSIS_SOURCE_ROOT = "src";
export const ANALYSIS_MAX_CHANGED_FILES = 1000;      // analysable changed files considered
export const ANALYSIS_MAX_PARSED_FILES = 3000;       // graph nodes per side
export const ANALYSIS_MAX_FILE_BYTES = 512 * 1024;   // larger files are not parsed
export const ANALYSIS_GRAPH_BUDGET_MS = 45_000;      // soft budget per graph build → partial graph
export const ANALYSIS_TIMEOUT_MS = 180_000;          // hard budget for analyze() → fatal
export const AFFECTED_PARENT_MAX_DEPTH = 3;          // reverse-BFS hops
export const CODE_DIFF_MAX_LINES = 400;
export const CALL_SITE_CONTEXT_LINES = 15;
export const CALL_SITE_MAX_LIMIT = 20;
export const TYPE_SOURCES_MAX_CHARS = 16_000;
export const TYPE_SOURCES_MAX_RELATED = 12;
export const CHANGED_FILES_MAX_ENTRIES = 5_000;      // cap of ChangeAnalysisResult.changedFiles
```

## 4. File inventory

| File | Responsibility |
|---|---|
| `backend/src/services/visualizations/pipeline/change-analysis-service.ts` | `ChangeAnalysisService`: orchestrates steps 1–10 and persistence, builds `AnalysisState` and the `sourceQueries` object. |
| `backend/src/services/visualizations/pipeline/component-source-queries.ts` | `AnalysisSourceQueries implements ComponentSourceQueries` (section 5.14): the read-only query object returned in `ChangeAnalysisResult.sourceQueries`; owns the per-visualization caches (texts, SourceFile LRU, lazily built base graph). |
| `backend/src/services/visualizations/pipeline/change-source.ts` | `ChangeSource`: name-status discovery for commit and working-tree modes, side-aware file reads with size/binary guards. Exported helpers (also used by 10 and 11): `classifySourcePath`, `buildUnifiedDiff`, `truncateDiff`, `basePathFor`, `headPathFor`, `readConfinedText(sideRoot, repoPath, maxBytes = ANALYSIS_MAX_FILE_BYTES): Promise<string \| null>` (the section 8 confinement helper: lstat, realpath inside `sideRoot`, size/NUL guards, BOM/CRLF normalisation; `null` when missing, unsafe, too large or binary). |
| `backend/src/services/visualizations/pipeline/component-detector.ts` | `ComponentDetector`: parse a file, collect imports/exports/re-exports, decide which exports are React components, compute export closures, normalize closure text, locate props types and JSX render roots (the latter reused by sheet 11). Stateless. Also exports the pure helpers `normalizeSource`, `cleanJsxText` (used by sheet 11) and `pascalFromFile`. |
| `backend/src/services/visualizations/pipeline/module-resolver.ts` | `ModuleResolver`: one per side. Loads tsconfig (incl. `references`), statically reads Vite `resolve.alias`, resolves script and style specifiers to repo-relative paths or "external". |
| `backend/src/services/visualizations/pipeline/import-graph.ts` | `ImportGraph`: builds module summaries and resolved edges for one side, forward/reverse adjacency, affected-parent BFS, export-alias walk for call sites, forward BFS from the entry file. |
| `backend/src/types/change-analysis.ts` | Internal types (`ModuleSummary`, `ExportInfo`, `RawImport`, `ImportEdge`, `FileChange`, `DraftCandidate`, …). Never imported by 09–11. The cross-sheet query types (`ComponentSourceQueries` and its result types, section 5.1) are added by this sheet to `backend/src/types/visualization-pipeline.ts` (00 §14.7 delegates their definition to 08). |
| `tests/backend/pipeline/change-analysis/helpers/worktree-fixture.ts` | Test helper: writes base/head trees from `{ [path]: content }` maps into a temp dir; stub `GitClient`; stub transaction/QueryHandler. |
| `tests/backend/pipeline/change-analysis/*.test.ts` | See section 9. |

All production files export from `backend/src/services/visualizations/pipeline/index.ts` (barrel owned by 07; add the new exports).

## 5. Detailed design

### 5.1 Public API

```ts
// backend/src/services/visualizations/pipeline/change-analysis-service.ts
import type { ChangeAnalysisResult, PipelineContext } from "../../../types/visualization-pipeline";
import type { Transaction } from "../../../utilities/services/drizzle-db";

export interface ChangeAnalysisDeps {
  gitClient: GitClient;
  /** Default DrizzleDb.transaction (04 §9.2). */
  runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createQueryHandler(tx?: Transaction): QueryHandler;
  detector: ComponentDetector;
  now(): number;
}

export class ChangeAnalysisService {
  private readonly deps: ChangeAnalysisDeps;

  constructor(deps: Partial<ChangeAnalysisDeps> = {}) {
    this.deps = {
      gitClient: deps.gitClient ?? new GitClient(),
      runInTransaction: deps.runInTransaction ?? ((fn) => DrizzleDb.transaction(fn)),
      createQueryHandler: deps.createQueryHandler ?? ((tx) => new QueryHandler(tx)),
      detector: deps.detector ?? new ComponentDetector(),
      now: deps.now ?? Date.now,
    };
  }

  /** Steps 1–10. Throws only PipelineStepError (stage "analyzing"). Stateless between calls. */
  async analyze(ctx: PipelineContext): Promise<ChangeAnalysisResult>;
}
```

The logger is created per call: `createLogger("change-analysis", { visualizationId: ctx.visualizationId })` (04 §9.10). The service keeps no state between calls; everything the queries need lives in the `AnalysisState` captured by the returned `sourceQueries` object.

Lifecycle (00 §14.7): 07 calls `analyze(ctx)` once per job and keeps the returned `ChangeAnalysisResult` until summarizing ends. 07 constructs `new HarnessGenerationService(ctx, analysis.sourceQueries)` (09). The `sourceQueries` object reads the worktrees lazily, so it is valid only while the worktrees exist; after 07's cleanup every query resolves to its empty result (see "not found" rules below) and logs `warn` once. Nothing is cached across visualizations. Dropping the `ChangeAnalysisResult` releases the graphs and caches.

#### 5.1.1 `ComponentSourceQueries` — the only 08 → 09 hand-off (authoritative definition)

Added to `backend/src/types/visualization-pipeline.ts` next to `ChangeAnalysisResult`, which gains `sourceQueries: ComponentSourceQueries` (00 §14.7). Every path is repo-relative POSIX. Every method takes an explicit `side`. Every method is async (the base graph and resolver are built lazily) and **never rejects**: unknown files, missing exports, unreadable or oversized files and a failed base-graph build all yield the empty result documented per method, with one `warn` log per (method, side, reason).

```ts
export type WorktreeSide = "base" | "head";

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
  found: boolean;                        // false when the component could not be located (all other fields empty/null)
  propsTypeName: string | null;          // "ButtonProps", null for inline/untyped
  parameterText: string | null;          // first parameter as written, e.g. "{ label, variant = \"primary\" }: ButtonProps"
  sources: Array<{
    name: string;                        // declaration name, or "(inline)", "(propTypes)", "(defaultProps)"
    filePath: string;                    // repo-relative file where the text was found
    startLine: number;                   // 1-based, inclusive (line of node.getStart(sf))
    endLine: number;                     // 1-based, inclusive
    kind: "interface" | "type" | "enum" | "class" | "inline" | "propTypes" | "defaultProps";
    depth: 0 | 1;
    text: string;                        // exact source text of the declaration (node.getText(sf))
  }>;
  unresolved: string[];                  // referenced type names not found in repo src (external or missing), sorted
  truncated: boolean;                    // TYPE_SOURCES_MAX_CHARS or TYPE_SOURCES_MAX_RELATED hit
}

export interface CallSite {
  filePath: string;                      // repo-relative importer (may equal the component's own file)
  role: "source" | "story" | "test";
  line: number;                          // 1-based line of the opening tag
  startLine: number;                     // snippet range, 1-based inclusive
  endLine: number;
  usedAs: string;                        // tag text as written, e.g. "Button" or "UI.Button"
  snippet: string;                       // header line + raw source lines startLine..endLine
}

export interface DirectImport {
  specifier: string;                     // exactly as written, e.g. "@/hooks/useAuth"
  line: number;                          // 1-based
  kind: "relative" | "alias" | "package" | "style" | "asset";
  resolvedPath: string | null;           // repo-relative target for repo files; null for packages, assets, unresolved
  defaultImport: boolean;                // import X from "…"  /  export { default } from "…"
  namespaceImport: boolean;              // import * as X from "…"  /  export * from "…"  /  export * as NS from "…"
  namedImports: string[];                // imported (not local) runtime names, sorted; type-only specifiers excluded
  typeOnly: boolean;                     // `import type …` or every specifier is `type`
  sideEffectOnly: boolean;               // import "…"
  reexport: boolean;                     // export … from "…"
  dynamic: boolean;                      // import("…") with a string literal (incl. React.lazy)
}

export interface ChangedDependency {
  path: string;                          // head path (base path when side = "base" and the file was deleted/renamed)
  status: "A" | "M" | "D" | "R";
  depth: number;                         // 1 = imported directly by filePath
  codeDiff: string;                      // 08's unified diff of that file, truncated at CODE_DIFF_MAX_LINES with the 08 marker
}
```

`kind` classification for `DirectImport` (first match): style regex `/\.(css|scss|sass|less|styl)(\?.*)?$/` → `style`; asset regex `/\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|json)(\?.*)?$/` or any `?raw`/`?url`/`?react`/`?worker` query → `asset`; starts with `.` or `/` → `relative`; resolves (5.9.3) to an internal file → `alias`; otherwise → `package`.

Sheet 09 depends only on this interface. Tests in 09 use an in-memory fake that implements it.

### 5.2 Internal types (`backend/src/types/change-analysis.ts`)

```ts
export type Side = "base" | "head";
export type FileRole = "source" | "test" | "story" | "generated";
export type FileLanguage = "script" | "style";
export type ChangeKind = "modified" | "added" | "removed" | "affected_parent";

export interface PathClassification {
  analysable: boolean;            // eligible to produce candidates/seeds
  inGraph: boolean;               // eligible as an import-graph node
  language: FileLanguage | null;
  role: FileRole;
  excludeReason: string | null;   // "outside src/", "declaration file", "test file", …
}

export interface ImportBinding { imported: string; local: string }   // imported: "default" | name | "*"

export interface RawImport {
  specifier: string;
  kind: "import" | "side_effect" | "reexport" | "dynamic" | "style";
  bindings: ImportBinding[];      // reexport: { imported, local: exportedName }
  star: boolean;                  // namespace import, `export *`, side-effect, dynamic → "all names"
  line: number;                   // 1-based
}

export interface ExportInfo {
  exportName: string;             // "default" or the exported name
  localName: string | null;       // top-level binding that holds the value, null for anonymous default
  isComponent: boolean;
  shape: "function" | "arrow" | "class" | null;
  wrappers: Array<"memo" | "forwardRef">;   // outermost first
  displayName: string;
  declStart: number;              // node.getStart() of the declaring statement
  declEnd: number;
  closureNames: string[];         // top-level names (incl. import locals) reachable from this export
  typeOnly: boolean;              // exported interface/type alias (ignored for change seeding)
}

export interface ModuleSummary {
  path: string;                   // repo-relative POSIX
  side: Side;
  language: FileLanguage;
  role: FileRole;
  sizeBytes: number;
  parsed: boolean;                // false: too large / binary / unreadable
  syntaxErrors: number;
  imports: RawImport[];
  exports: ExportInfo[];          // script only
}

export interface ImportEdge {
  from: string;                   // importer
  to: string;                     // imported module (repo-relative, in graph)
  kind: RawImport["kind"];
  bindings: ImportBinding[];
  star: boolean;
  specifier: string;
  line: number;
}

export interface FileChange {
  status: "A" | "M" | "D" | "R";
  path: string;                   // head path (A/M/R) or base path (D)
  previousPath: string | null;    // R only
  basePath: string | null;        // previousPath ?? path for M/R/D; null for A
  headPath: string | null;        // path for A/M/R; null for D
  language: FileLanguage;
  baseText: string | null;
  headText: string | null;
  codeDiff: string;               // already truncated
  changedLines: number;           // +/- lines in the full (untruncated) diff
  tooLarge: boolean;
}

export interface Seed {
  path: string;                   // changed module (head path)
  names: Set<string> | "*";       // changed export names, "*" = whole module (stylesheets, side effects)
  reasonLabel: string;            // "hook src/hooks/useCart.ts", "stylesheet src/styles/tokens.scss"
  global: boolean;                // true for repository.globalStylePaths
  changedLines: number;
}

export interface DraftCandidate {
  filePath: string;
  exportName: string;
  displayName: string;
  changeKind: ChangeKind;
  codeDiff: string | null;
  reason: string;
  diffSize: number;               // ranking tie-break
  depth: number;                  // 0 for direct, BFS depth for affected_parent
  forcedSkipReason: string | null;
}
```

### 5.3 Algorithm overview

```text
analyze(ctx)
 ├─ 0. guard: worktrees exist; start hard timeout (ANALYSIS_TIMEOUT_MS)
 ├─ 1. ChangeSource.listChanges()                         → RawChange[] (all paths)
 ├─ 2. classifySourcePath() per path                      → analysable FileChange skeletons
 ├─ 3. read base/head text, buildUnifiedDiff, truncate    → FileChange[]
 ├─ 4. ComponentDetector on changed script files (both sides)
 ├─ 5. per-export closure comparison                      → direct candidates (modified/added/removed) + seeds
 ├─ 6. ModuleResolver(head)                               (tsconfig + vite alias)
 ├─ 7. ImportGraph.build(head)                            (budgeted, ≤ ANALYSIS_MAX_PARSED_FILES)
 ├─ 8. style ownership + affected-parent BFS per seed     → affected_parent / style-owned modified
 ├─ 9. merge, dedupe, rank, cap                           → ordered DraftCandidate[] + skipped
 ├─ 10. persist rows in one transaction                   → componentIds
 └─ return ChangeAnalysisResult with sourceQueries = new AnalysisSourceQueries(state)  (5.14)
```

Cancellation is checked (`ctx.signal.aborted || await ctx.isCancelled()`) after steps 1, 5, 7 and immediately before 10. Graph build additionally checks `ctx.signal.aborted` every 100 files.

### 5.4 Step 1 — changed-file discovery (`ChangeSource`)

```ts
/** One element of 00 §8 `ChangeAnalysisResult.changedFiles`, produced by normalizeEntries from 04's GitNameStatusEntry. */
export interface RawChange { path: string; status: "A" | "M" | "D" | "R"; previousPath?: string; }

export class ChangeSource {
  constructor(private readonly git: GitClient, private readonly workspace: PreparedWorkspace, private readonly signal: AbortSignal) {}

  async listChanges(): Promise<RawChange[]> {
    const entries = this.workspace.sourceType === "working_tree" || this.workspace.headSha === null
      ? await this.listWorkingTreeChanges()
      : await this.git.diffNameStatus(this.workspace.headDir, this.workspace.baseSha, this.workspace.headSha, { renames: true }, { signal: this.signal });
    return normalizeEntries(entries);
  }
}
```

Commit modes (`github_pr`, `local_branch`, `headSha !== null`):

- Command (inside `GitClient`, 04 §9.5): `git -C <headDir> diff --name-status -z -M --no-ext-diff --no-textconv --no-color <baseSha> <headSha> --`. `<headDir>` is a worktree sharing the clone's object store, so both SHAs are available. No pathspec: we want *all* changed paths in `changedFiles`; filtering happens in step 2.
- 08 diffs exactly `baseSha..headSha`. 07 sets `baseSha` to the merge base (00 §14.7), so this is the PR's own change.
- `GitCommandError` with code `aborted` → `ANALYSIS_CANCELLED`; any other code → `ANALYSIS_GIT_DIFF_FAILED` (section 6).

Working tree (`working_tree`, `headSha === null`): compare the two worktrees on disk.

- Let `worktreesDir = path.dirname(workspace.baseDir)`. Assert `path.dirname(workspace.headDir) === worktreesDir` and the basenames are `base` and `head` (00 §4). If not, pass absolute paths and strip absolute prefixes instead (same algorithm, longer prefix).
- If both `base/src` and `head/src` exist: `gitClient.diffNameStatusNoIndex(worktreesDir, "base/src", "head/src", { renames: true }, { signal })`, i.e. `git -C <worktreesDir> diff --no-index --name-status -z -M --no-ext-diff --no-textconv --no-color -- base/src head/src`. (`git diff <baseSha>` inside the head worktree is not used: the untracked files 07 copies into the head worktree would be missing from its output.)
  Verified output shape (git 2.43):

  ```text
  R100  base/src/c/A.tsx  head/src/c/B.tsx
  M     base/src/m.ts            ← M/D carry the *left* path
  A     head/src/new.ts          ← A carries the right path
  D     base/src/old.ts
  ```

  Strip the leading `base/` or `head/` from every path. Exit code 1 means "differences" and is not an error.
- If only one side has `src/`: walk that side (section 5.10.1 walker) and emit every file as `A` (head only) or `D` (base only).
- If neither has `src/`: return `[]` for the working-tree comparison (changedFiles empty; console info).
- `--no-index` only compares `src/`, so working-tree `changedFiles` only lists `src/` paths. That is acceptable (documented edge case).

04's `parseNameStatusZ` returns git's status letters uninterpreted (04 §9.5). `normalizeEntries(entries: GitNameStatusEntry[]): RawChange[]` maps them: `A`→`A`, `M`/`T`/`U`→`M`, `D`→`D`, `R`→`R` with `previousPath`, `C`→`A` (the copy's new path; `previousPath` dropped), `X` dropped. It also converts paths to POSIX separators, strips the `base/`/`head/` prefixes (working tree), deduplicates by `path` (first wins) and sorts by `path` (plain `<`). `changedFiles` in the result is this list, capped at `CHANGED_FILES_MAX_ENTRIES` (log `warn` if capped).

### 5.5 Step 2 — path classification

```ts
export function classifySourcePath(repoPath: string, opts: { sourceRoot: string }): PathClassification;
```

Rules, evaluated in order on the repo-relative POSIX path. First match decides `excludeReason`; `inGraph`/`analysable` follow from the table.

| # | Rule | role | inGraph | analysable | excludeReason |
|---|---|---|---|---|---|
| 1 | not under `<sourceRoot>/` (default `src/`) | source | no | no | `outside src/` |
| 2 | any segment is `node_modules` or starts with `.` | source | no | no | `ignored directory` |
| 3 | ends with `.d.ts`, `.d.mts`, `.d.cts` | source | no | no | `declaration file` |
| 4 | extension not in `.tsx .jsx .ts .js .mjs .css .scss` | source | no | no | `unsupported extension` |
| 5 | basename matches `/\.(test|spec)\.[cm]?[jt]sx?$/`, or a segment is `__tests__`, `__mocks__`, `__fixtures__`, `test`, `tests`, `e2e`, `cypress`, or basename stem is `setupTests`, `setup-tests`, `test-utils`, `testUtils` | test | yes | no | `test file` |
| 6 | basename matches `/\.(stories|story)\.[cm]?[jt]sx?$/` or `.mdx` | story | yes (`.mdx` no) | no | `story file` |
| 7 | a segment is `generated` or `__generated__`, or basename matches `/\.(generated|gen)\.[cm]?[jt]s$/` | generated | yes | no | `generated file` |
| 8 | otherwise | source | yes | yes | null |

`language`: `style` for `.css`/`.scss` (this includes `.module.css`/`.module.scss`), `script` otherwise.

Content-based generated check (applied in step 3 and during graph build, after reading): if the first 512 bytes match `/@generated|auto-?generated|do not edit/i`, set `role = "generated"`, `analysable = false`.

Analysable changed files beyond `ANALYSIS_MAX_CHANGED_FILES` (sorted by path) are dropped from analysis with one console warning.

Non-src changes worth a warning: if any changed path matches `/^(tailwind|postcss|vite)\.config\.[cm]?[jt]s$/`, `index.html`, or `package.json`, emit console `warn` (section 7). They still never produce candidates.

### 5.6 Step 3 — file contents and code diffs

For each analysable `RawChange`:

- `basePath = status === "A" ? null : (previousPath ?? path)`; `headPath = status === "D" ? null : path`.
- Read `baseText` from `<baseDir>/<basePath>` and `headText` from `<headDir>/<headPath>` with `ChangeSource.readText(side, repoPath)`:
  - `fs.lstat`; refuse symlinks (return `null` + `warn` log) and files outside the side root after `realpath` (section 8).
  - Size > `ANALYSIS_MAX_FILE_BYTES` → `tooLarge = true`, text `null`.
  - Contains a NUL byte in the first 8 KB → treat as binary, text `null`.
  - Decode UTF-8, strip a leading BOM, normalize `\r\n` → `\n`.
- `buildUnifiedDiff({ oldPath: basePath, newPath: headPath, oldText, newText })`:

```ts
import { structuredPatch } from "diff";

export function buildUnifiedDiff(input: { oldPath: string | null; newPath: string | null; oldText: string | null; newText: string | null }): { diff: string; changedLines: number } {
  const oldText = input.oldText ?? "";
  const newText = input.newText ?? "";
  const patch = structuredPatch(input.oldPath ?? "/dev/null", input.newPath ?? "/dev/null", oldText, newText, "", "", { context: 3 });
  const header: string[] = [`diff --git a/${input.oldPath ?? input.newPath} b/${input.newPath ?? input.oldPath}`];
  if (input.oldPath === null) header.push("new file mode 100644");
  if (input.newPath === null) header.push("deleted file mode 100644");
  if (input.oldPath && input.newPath && input.oldPath !== input.newPath) header.push(`rename from ${input.oldPath}`, `rename to ${input.newPath}`);
  header.push(input.oldPath ? `--- a/${input.oldPath}` : "--- /dev/null", input.newPath ? `+++ b/${input.newPath}` : "+++ /dev/null");
  let changedLines = 0;
  const body: string[] = [];
  for (const hunk of patch.hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      body.push(line);
      if (line.startsWith("+") || line.startsWith("-")) changedLines++;
    }
  }
  return { diff: [...header, ...body].join("\n"), changedLines };
}
```

- If one side is `tooLarge`/binary: `codeDiff = "diff --git …\n(PRVision: file too large or binary — diff not shown)"`, `changedLines = 0`.
- `truncateDiff(diff, CODE_DIFF_MAX_LINES)`:

```ts
export const CODE_DIFF_TRUNCATION_MARKER = (shown: number, total: number): string =>
  `… [PRVision: diff truncated — showing ${shown} of ${total} lines]`;

export function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return [...lines.slice(0, maxLines), CODE_DIFF_TRUNCATION_MARKER(maxLines, lines.length)].join("\n");
}
```

The truncated diff is what is persisted in `visualization_components.code_diff` and returned in `ComponentCandidate.codeDiff`. `changedLines` is computed on the full diff.

### 5.7 Step 4 — React component detection (`ComponentDetector`)

The detector is stateless and synchronous. All AST work is syntactic: `ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, setParentNodes, scriptKind)` — never `ts.createProgram`, `ts.createLanguageService` or a `TypeChecker` (a program would resolve and parse the whole dependency graph including `node_modules` typings, which costs seconds and hundreds of MB). `parse(repoPath, text, { parents })` takes `parents: true` for changed files and query-time parses (call sites need `node.parent`) and `parents: false` for import-graph summaries (about 15 % faster, less memory). Code that runs on parent-less trees must always pass the `SourceFile` to `getText(sf)`/`getStart(sf)` and must not read `node.parent`.

```ts
export class ComponentDetector {
  parse(repoPath: string, text: string, options?: { parents?: boolean }): ts.SourceFile;   // scriptKind from extension; parents default true
  summarize(sf: ts.SourceFile, meta: { path: string; side: Side; role: FileRole; sizeBytes: number }): ModuleSummary;
  findExport(sf: ts.SourceFile, exportName: string): ResolvedExport | null;
  closureText(sf: ts.SourceFile, exportName: string): string | null;    // raw closure (5.8)
  normalizedClosure(sf: ts.SourceFile, exportName: string): string | null;
  residualText(sf: ts.SourceFile): string;                               // normalized non-closure statements
  findPropsTypeNode(resolved: ResolvedExport): PropsTypeLocation;        // 5.14
  findRenderRoots(resolved: ResolvedExport): ts.Expression[];            // JSX return expressions (sheet 11)
}

export interface ResolvedExport {
  sf: ts.SourceFile;
  info: ExportInfo;
  statement: ts.Statement;                                   // declaring statement
  componentNode: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration | null;
  wrapperCalls: ts.CallExpression[];                          // memo/forwardRef calls, outermost first
  variableDeclaration: ts.VariableDeclaration | null;         // for `const X: FC<P> = …`
}
```

Script kind by extension: `.tsx → TSX`, `.ts → TS`, `.jsx → JSX`, `.js/.mjs → JSX` (lenient: some Vite projects put JSX in `.js`).

#### 5.7.1 React bindings per file

Collected from top-level `ImportDeclaration`s whose specifier is `react` (also `react/jsx-runtime` for `jsx`/`jsxs`):

```ts
interface ReactBindings {
  namespaces: Set<string>;          // default and namespace imports of "react"; always includes "React" (UMD/global tolerance)
  memo: Set<string>;                // local names of named import `memo`
  forwardRef: Set<string>;
  component: Set<string>;           // `Component`, `PureComponent` local names
  createElement: Set<string>;       // `createElement`, and `jsx`/`jsxs` from react/jsx-runtime
}
```

#### 5.7.2 Exact AST predicates

```ts
const PASCAL_CASE = /^[A-Z][A-Za-z0-9_$]*$/;

/** Strip wrappers that do not change the value. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
      || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
    e = e.expression;
  }
  return e;
}

/** True when an expression evaluates to JSX (or React.createElement) on at least one branch. */
function isJsxLike(expr: ts.Expression | undefined, react: ReactBindings): boolean {
  if (!expr) return false;
  const e = unwrap(expr);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return true;
  if (ts.isConditionalExpression(e)) return isJsxLike(e.whenTrue, react) || isJsxLike(e.whenFalse, react);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return isJsxLike(e.right, react);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return isJsxLike(e.left, react) || isJsxLike(e.right, react);
    }
    return false;
  }
  if (ts.isCallExpression(e)) return isCreateElementCall(e, react);
  return false;
}

function isCreateElementCall(call: ts.CallExpression, react: ReactBindings): boolean {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return react.createElement.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && react.namespaces.has(callee.expression.text) && callee.name.text === "createElement";
}

/** A function "returns JSX" if any return statement of its own body (not nested functions/classes) is JSX-like. */
function returnsJsx(fn: ts.FunctionLikeDeclaration, react: ReactBindings): boolean {
  const body = fn.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return isJsxLike(body, react);       // concise arrow body
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;   // do not descend
    if (ts.isReturnStatement(node) && isJsxLike(node.expression, react)) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/** "memo" | "forwardRef" | null for memo(x), React.memo(x), forwardRef(fn), React.forwardRef(fn). */
function wrapperKind(call: ts.CallExpression, react: ReactBindings): "memo" | "forwardRef" | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    if (react.memo.has(callee.text)) return "memo";
    if (react.forwardRef.has(callee.text)) return "forwardRef";
    return null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && react.namespaces.has(callee.expression.text)) {
    if (callee.name.text === "memo") return "memo";
    if (callee.name.text === "forwardRef") return "forwardRef";
  }
  return null;
}

/** extends Component | PureComponent | React.Component | React.PureComponent, and has a JSX-returning render. */
function isReactClassComponent(cls: ts.ClassLikeDeclaration, react: ReactBindings): boolean {
  const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  if (!heritage) return false;
  const base = unwrap(heritage);
  const extendsReact =
    (ts.isIdentifier(base) && react.component.has(base.text)) ||
    (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression) && react.namespaces.has(base.expression.text)
      && (base.name.text === "Component" || base.name.text === "PureComponent"));
  if (!extendsReact) return false;
  return cls.members.some((m) => {
    if (ts.isMethodDeclaration(m) && memberName(m) === "render") return returnsJsx(m, react);
    if (ts.isPropertyDeclaration(m) && memberName(m) === "render" && m.initializer) {
      const init = unwrap(m.initializer);
      return (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && returnsJsx(init, react);
    }
    return false;
  });
}
```

`resolveComponentValue(expr, depth)` turns the value of an export into a component node:

```text
resolveComponentValue(expr, wrappers = [], depth = 0):
  if depth > 4: return null
  e = unwrap(expr)
  if ArrowFunction | FunctionExpression:   return returnsJsx(e) ? { node: e, shape: arrow|function, wrappers } : null
  if ClassExpression:                     return isReactClassComponent(e) ? { node: e, shape: "class", wrappers } : null
  if CallExpression and wrapperKind(e) = k and e.arguments[0]:
                                          return resolveComponentValue(e.arguments[0], [...wrappers, k], depth+1)
  if Identifier: look up the top-level declaration of e.text in this file:
      FunctionDeclaration  → returnsJsx ? { node, shape: "function", wrappers } : null
      ClassDeclaration     → isReactClassComponent ? { node, "class", wrappers } : null
      VariableDeclaration with initializer → resolveComponentValue(initializer, wrappers, depth+1)
      import binding / anything else → null   (cross-file identity is handled by re-export logic, not here)
  otherwise: null
```

#### 5.7.3 Export collection

Walk `sf.statements` in order. `hasExport(node)` = `ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ExportKeyword)`; `hasDefault` likewise with `DefaultKeyword`.

| Statement form | Export name | localName | Value for component check |
|---|---|---|---|
| `export function Foo() {}` | `Foo` | `Foo` | the declaration |
| `export default function Foo() {}` | `default` | `Foo` | the declaration |
| `export default function () {}` | `default` | `null` | the declaration |
| `export class Foo extends React.Component {}` | `Foo` | `Foo` | the class |
| `export default class extends Component {}` | `default` | `null` | the class |
| `export const Foo = () => …` / `= function () …` / `= memo(…)` / `= forwardRef(…)` / `= React.memo(React.forwardRef(…))` | `Foo` | `Foo` | initializer via `resolveComponentValue` |
| `export const { a, b } = obj` | `a`, `b` | same | none (never components) |
| `export default Foo;` | `default` | `Foo` | `resolveComponentValue(Identifier Foo)` |
| `export default memo(Foo)` / `export default forwardRef(…)` / `export default () => <div/>` | `default` | identifier inside wrapper or `null` | `resolveComponentValue(expr)` |
| `export { Foo, Bar as Baz }` (no `from`) | `Foo`, `Baz` | `Foo`, `Bar` | the local binding |
| `export { Foo as default }` (no `from`) | `default` | `Foo` | the local binding |
| `import X from "./X"; export { X }` / `export { X as default }` | treated as **re-export** of `("./X", "default")` | — | — (component lives in `./X`) |
| `export { A, default as B } from "./m"` | re-export entries `A←A`, `B←default` | — | — |
| `export * from "./m"` | re-export star | — | — |
| `export * as UI from "./m"` | re-export namespace `UI` | — | — |
| `export interface P {}` / `export type P = …` / `export type { … }` | `P` | `P` | none; `typeOnly = true` |
| `export enum E {}` | `E` | `E` | none |
| `export =` / `module.exports =` | ignored (CommonJS not supported) | | |

Re-exports become `RawImport` entries with `kind: "reexport"` (bindings `{ imported, local: exportedName }`; `star: true` for `export *`). They are not `ExportInfo`s of the barrel.

#### 5.7.4 Component decision

An `ExportInfo` has `isComponent = true` iff all hold:

1. Not `typeOnly`.
2. `resolveComponentValue` (or the class/function declaration check) returned a node.
3. Name rule:
   - named export: `exportName` matches `PASCAL_CASE`;
   - default export with a local name: `localName` matches `PASCAL_CASE`;
   - anonymous default export: allowed.

`displayName`, first match wins:

1. A top-level `X.displayName = "<string literal>"` where `X` is the local name → that string.
2. Named export → `exportName`.
3. Default export with local name → `localName`.
4. Anonymous default → `pascalFromFile(path)`: take the basename, strip extension and a trailing `.module`; if the stem is `index`, use the parent directory name; split on `[-_.\s]+`, capitalize each part, join. If the result does not start with a letter, use `"Component"`. `src/components/user-card/index.tsx` → `UserCard`.

Hooks (`useX`), lowercase helpers, constants, contexts (`createContext(...)` is not JSX), and arrays/objects never pass rule 2 or 3.

#### 5.7.5 Detection examples (all must be unit tests)

| Source | Result |
|---|---|
| `export function Button() { return <button/> }` | `Button` component, shape function |
| `export const Card = ({ title }: Props) => (<div>{title}</div>)` | `Card` component, shape arrow |
| `export const List = memo(function List() { return items.length ? <ul/> : null })` | `List`, wrappers `[memo]` |
| `export const Input = React.forwardRef<HTMLInputElement, P>((p, ref) => <input ref={ref}/>)` | `Input`, wrappers `[forwardRef]` |
| `const Inner = (p) => <i/>; export default React.memo(Inner)` | `default`, local `Inner`, display `Inner`, wrappers `[memo]` |
| `export default function () { return <main/> }` in `src/pages/settings-page.tsx` | `default`, display `SettingsPage` |
| `function Modal() { return <div/> } export { Modal as default }` | `default`, local `Modal` |
| `export class Legacy extends React.Component { render() { return <div/> } }` | `Legacy`, shape class |
| `export const useCart = () => { … }` | not a component (lowercase) |
| `export function Empty() { return null }` | not a component (no JSX return) |
| `export function Render() { const f = () => <b/>; return f }` | not a component (JSX only in nested fn) |
| `export const ThemeContext = createContext(null)` | not a component |
| `export * from "./Button"` in `index.ts` | no exports; one `reexport` import edge, `star: true` |
| `export const Box = styled.div\`…\`` | not a component (unsupported HOC) |
| `export default connect(map)(Panel)` | not a component (unsupported HOC; logged at debug) |

### 5.8 Step 5 — export closures, normalization and per-export change detection

#### 5.8.1 Export closure

Purpose: a component's rendering depends on its own declaration **and** the file-local things it uses (helpers, local sub-components, constants, imports, CSS imports, `X.defaultProps = …`). Comparing only the export's own text misses those; comparing the whole file over-reports when a sibling export changes.

Definitions on one `SourceFile`:

- `topLevel: Map<string, ts.Statement[]>` — every top-level declared name → declaring statements: function/class/enum/variable declarations (including destructured names), interface/type aliases, and import bindings (default, named, namespace locals).
- `refs(node)` — the set of `Identifier.text` of every `Identifier` in the subtree (conservative: shadowing and property names may over-include; that is acceptable).
- `exprStatements` — top-level `ExpressionStatement`s.

Closure of export `E` with declaring statement `S`:

```text
names = {}; stmts = {S}; work = [S]
while work not empty:
  s = work.pop()
  for n in refs(s) ∩ keys(topLevel):
    if n ∉ names: names.add(n); for d in topLevel[n] if d ∉ stmts and d is not ImportDeclaration: stmts.add(d); work.push(d)
for es in exprStatements:                         # displayName/defaultProps/propTypes/side-effect calls
  if refs(es) ∩ (names ∪ {localName(E)}) ≠ ∅ and es ∉ stmts: stmts.add(es); work.push(es) (repeat loop once more)
closureNames = names
```

Closure text (raw), in this order, joined by `\n`:

1. Canonical import lines for referenced import bindings only, sorted by local name:
   `import { <imported> as <local> } from "<specifier>";` (`imported` is `default` or `*` as written: `import * as <local> from "<spec>";`).
2. Every side-effect import of the file (`import "./x.css";`), sorted by specifier — they apply to every export.
3. The original text (`stmt.getText(sf)`) of each statement in `stmts`, in source order.

Canonical import lines make the closure insensitive to unrelated changes in the same import declaration (adding `c` to `import { a, b } from "x"` does not mark exports that only use `a` as changed).

#### 5.8.2 Normalization

```ts
normalizedClosure(sf, exportName): string | null {
  const raw = this.closureText(sf, exportName);
  if (raw === null) return null;
  return normalizeSource(raw, sf.fileName);
}

export function normalizeSource(raw: string, fileName: string): string {
  const ext = /\.(tsx|jsx|js|mjs)$/.test(fileName) ? "tsx" : "ts";   // JS parsed as TSX is a superset for our needs
  let js: string;
  try {
    // 1. erase types and comments; keep JSX as-is
    js = ts.transpileModule(raw, {
      fileName: `closure.${ext}`,
      reportDiagnostics: false,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve,
        removeComments: true, verbatimModuleSyntax: false, isolatedModules: true, sourceMap: false,
      },
    }).outputText;
  } catch {
    return raw.replace(/\s+/g, " ").trim();                               // fallback: whitespace-collapsed raw text
  }
  // 2. re-parse and re-print canonically
  const parsed = ts.createSourceFile("closure.jsx", js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const result = ts.transform(parsed, [canonicalLiteralsTransformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const printed = printer.printFile(result.transformed[0] as ts.SourceFile);
  result.dispose();
  return printed.trim();
}
```

`canonicalLiteralsTransformer` (visit every node, `ts.visitEachChild`):

- `StringLiteral` → `factory.createStringLiteral(node.text)` (synthesized → printed with double quotes; `'a'` and `"a"` become equal).
- `NoSubstitutionTemplateLiteral` → `factory.createNoSubstitutionTemplateLiteral(node.text)`.
- `JsxText` → `factory.createJsxText(cleanJsxText(node.text), false)`; return `undefined` (drop the node) when the result is empty. `cleanJsxText` mirrors React's JSX whitespace rule, so whitespace that renders is kept and whitespace that does not is ignored:

  ```ts
  function cleanJsxText(text: string): string {
    if (!text.includes("\n")) return text.replace(/[ \t]+/g, " ");          // same-line spaces render: keep (collapsed)
    const lines = text.split(/\r?\n/);
    const kept: string[] = [];
    lines.forEach((line, i) => {
      let part = line.replace(/\t/g, " ");
      if (i !== 0) part = part.replace(/^ +/, "");
      if (i !== lines.length - 1) part = part.replace(/ +$/, "");
      if (part) kept.push(part.replace(/ +/g, " "));
    });
    return kept.join(" ");
  }
  ```
- `ParenthesizedExpression` whose inner expression is a `JsxElement`/`JsxSelfClosingElement`/`JsxFragment` → the inner node (Prettier adds/removes these parens). Other parentheses are kept (removing them could merge semantically different code).
- `NumericLiteral` → `factory.createNumericLiteral(Number(node.text.replace(/_/g, "")))` (`1_000` == `1000`).

Cost control: `ts.transpileModule` builds a one-file program per call (a few ms). Comparisons therefore first compare the **raw** closure texts; only when they differ are both sides normalized. Normalized strings are memoized per `(side, path, exportName)` inside one `analyze` call. This keeps 1 000 changed files well inside `ANALYSIS_TIMEOUT_MS`.

This pipeline was verified against TypeScript 5.9: a Prettier-reflowed `memo(forwardRef(...))` export with quote changes and a comment normalizes equal to the original; removing a rendered space (`{p.icon} hi` → `{p.icon}hi`) does not; rewriting the props type from a type alias to an interface with an extra optional field normalizes equal (types are erased).

Effects of normalization:

| Edit | Normalized equal? |
|---|---|
| Prettier reflow, indentation, trailing commas, semicolons | yes |
| Quote style `'` ↔ `"` | yes |
| Comments, JSDoc | yes |
| Type annotation / interface-only edits | yes (types erased) |
| JSX text whitespace reflow | yes |
| Renaming a local variable | no (intentionally conservative) |
| Any literal, className, JSX structure or logic change | no |

Type-only changes therefore never produce `modified` candidates. This is intended: they cannot change pixels.

#### 5.8.3 Per-file classification

For every analysable script `FileChange` (not `tooLarge`):

```text
baseSF = basePath ? parse(baseText) : null;  headSF = headPath ? parse(headText) : null
baseExports = baseSF ? summarize(baseSF).exports keyed by exportName : {}
headExports = headSF ? summarize(headSF).exports keyed by exportName : {}
changedNonComponent = {}   # export names for the seed

for name in sorted(keys(baseExports) ∪ keys(headExports)):
  b = baseExports[name]; h = headExports[name]
  if h?.typeOnly or b?.typeOnly: continue
  if h?.isComponent:
    if b?.isComponent:
      if normalizedClosure(baseSF, name) != normalizedClosure(headSF, name):
        emit modified(h, reason "Component code changed")
    else:
      emit added(h, reason = status == "A" ? "New file" : (b ? "Export became a component" : "New component export"))
  else if b?.isComponent:
      emit removed(b at basePath, reason = status == "D" ? "File deleted" : (h ? "Export is no longer a component" : "Component export removed"))
  else:   # non-component on both / one side
    if b and h and normalizedClosure(baseSF, name) != normalizedClosure(headSF, name): changedNonComponent.add(name)
    if b and not h: changedNonComponent.add(name)        # removed util: importers will be broken/modified anyway, cheap to include
    # added non-component exports (h and not b) cannot affect existing importers → ignored

if status in (M, R):
  if residualText(baseSF) != residualText(headSF): changedNonComponent = "*"     # top-level side effects changed
  if reExportMap(baseSF) != reExportMap(headSF): add changed re-exported names to changedNonComponent
  if changedNonComponent non-empty: seeds.push(Seed{ path: headPath, names: changedNonComponent, … })
```

Notes:

- `status = "A"`: every head component → `added`; no seed.
- `status = "D"`: every base component → `removed` with `filePath = basePath`; no seed.
- `status = "R"`: compared like `M` using `previousPath` for base; `removed` rows use the base path, `modified`/`added` rows use the head path.
- `residualText(sf)`: all top-level statements that are in no export closure, excluding `ImportDeclaration`s and type-only declarations, normalized with `normalizeSource`.
- `reExportMap(sf)`: `Map<exportedName, "<specifier>#<importedName>">` from `reexport` entries (star entries keyed `*:<specifier>`). Names whose value differs or exists on one side only are added to the seed.
- Seed `reasonLabel`: `hook <path>` if every changed name starts with `use`; `context <path>` if any changed name ends with `Context` or `Provider`; otherwise `module <path>`.

Syntax errors: if `headSF` has parse diagnostics, still classify what was parsed and emit one console warning per file (section 7). Read diagnostics defensively:

```ts
function syntaxErrorCount(sf: ts.SourceFile): number {
  // parseDiagnostics is internal but stable; guard the access.
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return Array.isArray(diags) ? diags.length : 0;
}
```

Changed style files (`language = "style"`, status `M` or `R`) → `Seed{ names: "*", reasonLabel: "stylesheet <path>", global: repository.globalStylePaths.includes(`/${path}`) }`. Added (`A`) and deleted (`D`) stylesheets produce no seed (importers of a new or deleted stylesheet changed themselves).

### 5.9 Step 6 — module resolution (`ModuleResolver`)

One instance per side, created lazily, reading only from that side's worktree.

```ts
export type Resolution =
  | { kind: "internal"; path: string }      // repo-relative, inside sourceRoot, not node_modules
  | { kind: "external" }                    // node_modules, outside the worktree, bare package, virtual module
  | { kind: "unresolved"; reason: string };

export class ModuleResolver {
  static async create(input: {
    side: Side; rootDir: string; tsconfigPath: string | null; viteConfigPath: string | null;
    sourceRoot: string; warn(message: string): void;
  }): Promise<ModuleResolver>;
  resolveScript(specifier: string, fromRepoPath: string): Resolution;
  resolveStyle(specifier: string, fromRepoPath: string): Resolution;
  readonly aliases: readonly AliasEntry[];
}

export interface AliasEntry { find: string; replacement: string /* absolute path inside rootDir */ }
```

#### 5.9.1 tsconfig

1. If `tsconfigPath` is null → `compilerOptions = {}`.
2. Else `ts.readConfigFile(abs, ts.sys.readFile)`; then `ts.parseJsonConfigFileContent(config, host, dirname(abs))` with a **restricted host** whose `readDirectory` returns `[]` (prevents scanning the worktree and the symlinked `node_modules`; we do not need `fileNames`), `fileExists`/`readFile` limited to paths inside `rootDir`, plus read-only access to `*.json` files under `<rootDir>/node_modules/` (after `realpath`, which lands in the user's clone) so package-based `extends` such as `"@tsconfig/vite-react/tsconfig.json"` resolve. `extends` chains are followed by TS. A parse diagnostic (e.g. missing `extends` target) does not discard the file's own `compilerOptions`; report it with the warning in step 5 and keep the options TS returned.
3. Vite templates: the root `tsconfig.json` often has `"files": []` and `references`. If the parsed options have neither `paths` nor `baseUrl` and the raw config has `references`, load each referenced config (a directory reference means `<dir>/tsconfig.json`) in order and take the first whose options have `paths`/`baseUrl` or whose raw `include` contains an entry starting with `src`. Merge its `compilerOptions` over the root's.
4. Override: `allowJs: true`, `jsx: Preserve`, `resolveJsonModule: true`, `allowImportingTsExtensions: true`, `noEmit: true`. If `moduleResolution` is not `Bundler`, `Node16` or `NodeNext`, set `moduleResolution: Bundler` and `module: ESNext`.
5. Errors reading/parsing → console `warn` (`tsconfig could not be read; path aliases from it are ignored`) and continue with defaults.

#### 5.9.2 Vite `resolve.alias` (static read, never executed)

1. If `viteConfigPath` is null, try `vite.config.ts`, `.mts`, `.js`, `.mjs` in `rootDir`; none → no aliases.
2. Parse with `ts.createSourceFile`. Find the config object:
   - `export default defineConfig(<arg>)` / `export default <arg>` / `export default config` where `const config = <arg>` / `module.exports = <arg>`.
   - `<arg>` is an object literal, or an arrow/function whose concise body is an object literal or whose body has a `return <object literal>` (first top-level return).
3. Inside it: property `resolve` (object literal) → property `alias`.
4. Alias forms:
   - Object literal: each `PropertyAssignment` with a string/identifier key → `{ find: key, replacement: evalPath(value) }`.
   - Array literal: each object literal with `find` (string literal only; regex `find` → unsupported) and `replacement`.
   - Spread, computed keys, function calls other than below → unsupported entry.
5. `evalPath(node)` static evaluator; `configDir = dirname(viteConfigAbs)`:

| Expression | Value |
|---|---|
| string literal / no-substitution template | the string |
| template expression whose spans are evaluable | concatenation |
| `__dirname` | `configDir` |
| `process.cwd()` | `rootDir` |
| `path.resolve(a, b, …)` / `resolve(…)` (imported from `path` or `node:path`) | `path.resolve` of evaluated args |
| `path.join(…)` / `join(…)` | `path.join` of evaluated args |
| `fileURLToPath(new URL(x, import.meta.url))` | `path.resolve(configDir, x)` |
| `new URL(x, import.meta.url).pathname` | `path.resolve(configDir, x)` |
| identifier bound by a top-level `const id = <evaluable>` (one level) | evaluated value |
| anything else | unsupported |

6. Normalize replacement: if absolute and inside `rootDir` → keep; if it starts with `/` and `path.join(rootDir, value)` exists → that (Vite root-relative); if relative (`./src`) → `path.resolve(configDir, value)`; if it is a bare package name → mark external alias (`replacement = ""`, resolution returns external). Replacement outside `rootDir` → unsupported (security, section 8).
7. Each unsupported entry → one console `warn`: `Vite alias "<find>" could not be read statically; imports using it are ignored`.
8. Also honour Vite's root-relative imports: specifier starting with `/` that is not an existing absolute path → `path.join(rootDir, specifier)`.

#### 5.9.3 Resolution algorithm

```text
resolveScript(spec, from):
  if spec starts with "virtual:" or "\0" or contains "?" → external (strip "?raw" etc. → external)
  if spec has an asset extension (DirectImport asset regex, 5.1.1) → external   (images, fonts, json: never graph nodes)
  target = applyAlias(spec)               # first alias where spec == find or spec.startsWith(find + "/"); declaration order
  if alias was external → external
  if target is root-relative ("/src/…") → absolute inside rootDir
  r = ts.resolveModuleName(target, abs(from), compilerOptions, host, moduleResolutionCache)
  if r.resolvedModule:
     p = r.resolvedModule.resolvedFileName
     if r.resolvedModule.isExternalLibraryImport or p contains "/node_modules/" or p outside rootDir → external
     if p ends with .d.ts → external
     return internal(relative(rootDir, p))
  if isStyleSpecifier(target) → resolveStyle(spec, from)
  if spec is bare (not "." / "/" / alias) → external
  return unresolved("cannot resolve")
```

`applyTsconfigPaths(spec)`: TypeScript does not resolve `.css`/`.scss` specifiers through `paths`, so style imports such as `@/styles/tokens.scss` need this helper. For each `paths` key in declaration order: exact key → its first target; key with one `*` (`prefix*suffix`) whose prefix and suffix match → first target with `*` replaced by the matched middle. Targets are resolved against `baseUrl` (or the tsconfig directory when `baseUrl` is absent, TS ≥ 4.1 semantics). Result must stay inside `rootDir`.

`ts.resolveModuleName` uses a host restricted to `rootDir` (same as 5.9.1) and one `ts.createModuleResolutionCache(rootDir, s => s, compilerOptions)` per side. TypeScript's own `paths`/`baseUrl` handling covers tsconfig aliases and `vite-tsconfig-paths` setups.

```text
resolveStyle(spec, from):     # .css/.scss imports in scripts, @use/@import/@forward in SCSS, composes in CSS modules
  if spec starts with "http:", "https:", "data:" → external
  if Vite alias applies → target = alias target
  elif spec is non-relative and matches a tsconfig `paths` pattern → target = first mapped path   (applyTsconfigPaths below)
  if no target and (spec starts with "~" or is bare) → external   (node_modules styles)
  base = target ?? path.resolve(dirname(abs(from)), spec)
  candidates (first existing file wins):
     base
     base + ".scss", base + ".css"
     dirname(base)/_basename(base) + ".scss"           # SCSS partial
     base/_index.scss, base/index.scss, base/index.css
  found inside rootDir/sourceRoot → internal; else unresolved
```

### 5.10 Step 7 — import graph (`ImportGraph`)

```ts
export interface ImportGraphBuildOptions {
  side: Side;
  rootDir: string;
  sourceRoot: string;
  resolver: ModuleResolver;
  detector: ComponentDetector;
  priorityPaths: string[];          // changed files (head paths) — used to prioritise when truncating
  maxFiles: number;                 // ANALYSIS_MAX_PARSED_FILES
  budgetMs: number;                 // ANALYSIS_GRAPH_BUDGET_MS
  signal: AbortSignal;
  now(): number;
}

export class ImportGraph {
  static async build(options: ImportGraphBuildOptions): Promise<ImportGraph>;

  readonly side: Side;
  readonly truncated: boolean;                // file cap hit
  readonly budgetExceeded: boolean;           // soft budget hit (graph partial)
  readonly stats: { files: number; parsed: number; edges: number; unresolved: number; durationMs: number };

  has(path: string): boolean;
  module(path: string): ModuleSummary | undefined;
  importsOf(path: string): readonly ImportEdge[];       // forward edges
  importersOf(path: string): readonly ImportEdge[];     // reverse edges, sorted by from
  exportedComponents(path: string): readonly ExportInfo[];

  findAffectedParents(seed: Seed, opts: { maxDepth: number; maxParents: number; isAlreadyCovered(path: string, exportName: string): boolean }): AffectedParent[];
  componentsFromEntry(entryPath: string, opts: { maxDepth: number; limit: number }): Array<{ path: string; exportInfo: ExportInfo; depth: number }>;
  exportAliases(path: string, exportName: string, maxHops: number): Array<{ path: string; exportName: string }>;
}

export interface AffectedParent {
  path: string;
  exportInfo: ExportInfo;
  depth: number;                    // 1 = direct importer
  via: string[];                    // intermediate module paths, nearest first
  directStyleOwner: boolean;        // depth 1, seed is a stylesheet, co-located or CSS module (5.11.2)
}
```

#### 5.10.1 File enumeration

```text
walk(<rootDir>/<sourceRoot>):
  readdir withFileTypes, sorted by name
  skip entries: name starts with ".", name in {node_modules, __snapshots__, coverage, dist, build}
  skip symlinks (Dirent.isSymbolicLink()) — never follow
  keep files where classifySourcePath(rel).inGraph
```

If the number of kept files exceeds `maxFiles`:

- Always keep `priorityPaths` that exist.
- Score every other file by the length of the common directory prefix with the nearest priority path (more shared segments first), then path ascending; keep the top `maxFiles − priority.length`.
- Set `truncated = true`; the service emits a console warning (section 7).

#### 5.10.2 Per-file summary and edges

For each kept file (sorted by path):

1. `fs.stat` size; > `ANALYSIS_MAX_FILE_BYTES` → `ModuleSummary{ parsed: false }`, no edges.
2. Read text (same guards as 5.6). Content generated marker → role `generated`.
3. Script: `detector.summarize(detector.parse(path, text, { parents: false }), meta)`; the `SourceFile` is **not** retained (memory). Style: regex scan:
   - `/@(?:use|forward|import)\s+(?:url\(\s*)?["']([^"']+)["']/g` (skip matches on lines starting with `//`),
   - CSS modules: `/composes\s*:[^;]*?\bfrom\s+["']([^"']+)["']/g`.
   Each match → `RawImport{ kind: "style", star: true, bindings: [] }`.
4. Script imports produce `RawImport`s:
   - `import X, { a as b } from "m"` → `kind: "import"`, bindings `[{default→X}, {a→b}]`; `import * as NS from "m"` → binding `{*→NS}`, `star: true`.
   - `import type …` / all-`type` specifiers → skipped (no runtime edge). Individual `type` specifiers are dropped from bindings.
   - `import "m"` → `side_effect`, `star: true`.
   - If the specifier is a style file (`/\.(css|scss)(\?.*)?$/`) → `kind: "style"` (bindings kept: `import styles from "./x.module.css"` → `{default→styles}`), resolved with `resolveStyle`.
   - `import("m")` / `React.lazy(() => import("m"))` with a string-literal argument → `dynamic`, `star: true`.
   - `export … from "m"` → `reexport` (5.7.3).
   - `require("m")` → ignored (CJS out of scope).
5. Resolve each `RawImport` (`resolveScript`/`resolveStyle`). `internal` targets that are graph nodes become `ImportEdge`s. Unresolved relative/aliased specifiers increment `stats.unresolved` and log at `debug`.
6. Every 100 files: `await new Promise(setImmediate)` (keeps the BullMQ lock renewal and cancellation responsive), check `signal.aborted` (throw the abort reason; the service converts it, section 6) and the budget: if `now() − start > budgetMs` → stop, `budgetExceeded = true`, keep what was built.

Adjacency: `forward: Map<string, ImportEdge[]>`, `reverse: Map<string, ImportEdge[]>`; reverse lists sorted by `from`, then `line`.

Memory target: ≤ 150 MB for 3 000 files. Only `ModuleSummary` objects are retained. A small LRU (`max 200`) of `SourceFile`s per side lives in `AnalysisState` for the query API, re-parsing from the text cache on miss.

#### 5.10.3 Name matching through edges

```ts
/** Does this edge consume any of `names` from its target? */
function edgeUsesNames(edge: ImportEdge, names: Set<string> | "*"): boolean {
  if (names === "*") return true;
  if (edge.kind === "reexport" && edge.star) return [...names].some((n) => n !== "default");   // export * skips default
  if (edge.star) return true;               // namespace/side-effect/dynamic/style
  return edge.bindings.some((b) => names.has(b.imported));
}

/** Local names in the importer that hold the consumed values. */
function localBindingsFor(edge: ImportEdge, names: Set<string> | "*"): string[] | "*" {
  if (edge.kind === "side_effect" || edge.kind === "dynamic") return "*";
  if (edge.kind === "style" && edge.bindings.length === 0) return "*";     // plain `import "./x.css"`
  return edge.bindings.filter((b) => names === "*" || b.imported === "*" || names.has(b.imported)).map((b) => b.local);
}

/** Names that the importer re-exposes after consuming `names` (for non-component intermediates). */
function namesExposedBy(importer: ModuleSummary, edge: ImportEdge, names: Set<string> | "*"): Set<string> | "*" | null {
  if (importer.language === "style") return "*";                           // SCSS partial chain
  if (edge.kind === "reexport") {
    if (edge.star) return names === "*" ? "*" : new Set([...names].filter((n) => n !== "default"));
    const out = edge.bindings.filter((b) => names === "*" || names.has(b.imported)).map((b) => b.local);
    return out.length ? new Set(out) : null;
  }
  const locals = localBindingsFor(edge, names);
  if (locals === "*") return "*";
  const exposed = importer.exports.filter((e) => !e.typeOnly && e.closureNames.some((n) => locals.includes(n))).map((e) => e.exportName);
  return exposed.length ? new Set(exposed) : null;
}

/** Exported components of `importer` that use the consumed bindings. */
function affectedComponents(importer: ModuleSummary, edge: ImportEdge, names: Set<string> | "*"): ExportInfo[] {
  const comps = importer.exports.filter((e) => e.isComponent);
  const locals = localBindingsFor(edge, names);
  if (locals === "*") return comps;
  return comps.filter((c) => c.closureNames.some((n) => locals.includes(n)));
}
```

### 5.11 Step 8 — seeds and affected-parent propagation

#### 5.11.1 Reverse BFS (`ImportGraph.findAffectedParents`)

```text
findAffectedParents(seed, { maxDepth = AFFECTED_PARENT_MAX_DEPTH, maxParents = MAX_PARENTS_PER_MODULE, isAlreadyCovered }):
  found = []; counted = 0
  seedIsStyle = seed.path matches /\.(css|scss)$/
  visited = { seed.path }
  queue = [ { path: seed.path, depth: 0, names: seed.names, via: [] } ]
  while queue not empty and counted < maxParents:
    cur = queue.shift()
    if cur.depth >= maxDepth: continue
    for edge in importersOf(cur.path):                    # sorted by importer path
      imp = module(edge.from)
      if imp is undefined or edge.from in visited: continue
      if not edgeUsesNames(edge, cur.names): continue
      visited.add(edge.from)
      if imp.role in (test, story): continue               # never parents, never intermediates
      comps = affectedComponents(imp, edge, cur.names)      # sorted: "default" first, then exportName
      if comps non-empty:                                   # nearest component-bearing importer: stop this path
        for c in comps:
          styleOwner = seedIsStyle and cur.depth == 0 and isCoLocatedStyle(seed.path, edge.from)
          if not styleOwner and counted >= maxParents: break
          found.push({ path: edge.from, exportInfo: c, depth: cur.depth + 1, via: cur.via, directStyleOwner: styleOwner })
          if not styleOwner and not isAlreadyCovered(edge.from, c.exportName): counted += 1
          if styleOwner: (does not count toward maxParents)
        continue
      next = namesExposedBy(imp, edge, cur.names)
      if next is not null: queue.push({ path: edge.from, depth: cur.depth + 1, names: next, via: [...cur.via, edge.from] })
  return found
```

Rules captured above:

- **Nearest**: once an importer yields components, the walk does not continue past it on that path.
- **Only exported components** can be parents (`ExportInfo.isComponent` is computed for exports only). A non-exported local component that uses the binding makes the exported component that renders it affected, because the local one is in that export's closure.
- **Depth**: 1 = direct importer; at most `AFFECTED_PARENT_MAX_DEPTH = 3` hops; barrels count as hops.
- **Cap**: at most `MAX_PARENTS_PER_MODULE = 2` per seed. Parents that are already direct candidates (`isAlreadyCovered`) are recorded but do not consume the cap (they already show the effect).
- Tests and stories never propagate.

#### 5.11.2 Stylesheet ownership

`isCoLocatedStyle(stylePath, importerPath)` is true when the stylesheet is a CSS module (`/\.module\.(css|scss)$/`) **or** its stem equals the importer's stem in the same directory (`Button.scss` ↔ `Button.tsx`).

A component found at depth 1 from a stylesheet seed with `directStyleOwner = true` becomes a **`modified`** candidate, not `affected_parent`:

- reason `Uses changed stylesheet <stylePath>`;
- `codeDiff` = the stylesheet's diff; if the component file itself also changed and is already a direct candidate, the stylesheet diff is appended to that candidate's `codeDiff` (separated by a blank line, re-truncated to `CODE_DIFF_MAX_LINES`);
- `diffSize` = stylesheet `changedLines` (+ own lines if both).

Rationale: a CSS-only PR ("tweak button padding") is a modification of `Button` and must rank and summarize like one.

#### 5.11.3 Global stylesheets

For a seed with `global = true` (`/` + path ∈ `ctx.repository.globalStylePaths`, since entries are import specifiers per 00 §14.3) or a stylesheet whose only importers are non-component modules (e.g. `src/main.tsx`):

- Run the normal BFS first. If it found nothing and `ctx.repository.entryFilePath` is set, call `componentsFromEntry(entryFilePath, { maxDepth: 3, limit: MAX_PARENTS_PER_MODULE })`: forward BFS over `import`/`reexport`/`dynamic` edges from the entry file, collecting exported components in BFS order (path ascending within a level). The entry file itself (`main.tsx`) is usually not a component; `App` usually is.
- These become `affected_parent` with reason `Global stylesheet <path> changed; representative component`.

#### 5.11.4 Seed processing order and reasons

Seeds are processed sorted by `path`. For each parent:

- `reason = "Imports changed <reasonLabel>"` when `depth = 1`;
- `reason = "Imports changed <reasonLabel> via <via joined by ' → '>"` when `depth > 1`;
- reasons longer than 300 characters are cut with `…`.

If the same component is reached from several seeds, the first reason wins and `" (+N more changed modules)"` is appended once at the end.

If the head graph is `truncated` or `budgetExceeded`, propagation still runs on the partial graph; the console warning tells the user parents may be missing.

### 5.12 Step 9 — merge, dedupe, rank, cap

1. Collect drafts: direct (`modified`/`added`/`removed`), style-owned (`modified`), propagated (`affected_parent`).
2. Dedupe by key `filePath + "\u0000" + exportName`. Precedence when the same key appears twice: `modified` > `added` > `removed` > `affected_parent`. Keep the higher kind's reason and codeDiff (style-owned merge described in 5.11.2).
3. `codeDiff`: the file's truncated diff for `modified`/`added`/`removed`; `null` for `affected_parent` (contract).
4. `diffSize`: the file's `changedLines` (style-owned: see 5.11.2); for `affected_parent`, the seed's `changedLines`.
5. Sort (stable, total order):

| Key | Order |
|---|---|
| group: `modified`=0, `added`=1, `removed`=2, `affected_parent`=3 | asc |
| `affected_parent` only: `depth` | asc |
| `diffSize` | desc |
| `filePath` | asc (plain `<` on strings, not locale) |
| `exportName` | asc, with `"default"` first |

6. `rank` = index in the sorted list (0-based, over all rows, rendered and skipped).
7. Cap: the first `MAX_COMPONENTS` drafts without `forcedSkipReason` → candidates (`render_status = "pending"`). All others → skipped (`render_status = "skipped"`), with:
   - `skipReason = "over_limit: ranked <rank+1> of <total>; PRVision renders at most <MAX_COMPONENTS> components per visualization"`;
   - or the `forcedSkipReason` (currently only `file_too_large: …` when a candidate's own file exceeded the parse limit — reserved; such files normally produce no draft at all).

Skip reason format is `<code>: <human text>`. Codes: `over_limit`, `file_too_large`.

### 5.13 Step 10 — persistence

One transaction through `DrizzleDb.transaction` (04 §9.2); every statement inside goes through `new QueryHandler(tx)`. No `drizzle-orm` import is needed in this sheet, so no `// Direct Drizzle:` comment applies.

```ts
private async persist(visualizationId: number, ordered: DraftCandidate[], renderedCount: number, skipReasons: Map<string, string>): Promise<Map<string, number>> {
  try {
    return await this.deps.runInTransaction(async (tx) => {
      const qh = this.deps.createQueryHandler(tx);
      // Idempotent re-run: a retried job must not duplicate rows. 404 (= no previous rows) is fine.
      const deleted = await qh.delete({ visualizationId }, Table.VISUALIZATION_COMPONENTS, DeletionMode.HARD);
      if (deleted.status !== 200 && deleted.status !== 404) throw new Error(`delete failed (${deleted.status})`);
      if (ordered.length > 0) {
        const rows = ordered.map((draft, index) => QueryHandler.normalizeData({
          visualizationId,
          filePath: draft.filePath,
          exportName: draft.exportName,
          displayName: draft.displayName,
          changeKind: draft.changeKind,
          renderStatus: index < renderedCount ? ComponentRenderStatus.PENDING : ComponentRenderStatus.SKIPPED,
          rank: index,
          codeDiff: draft.codeDiff,
          mockedModules: [],
          changeReason: draft.reason,                                                    // 00 §14.3
          skipReason: index < renderedCount ? null : (skipReasons.get(keyOf(draft)) ?? null),   // 00 §14.3
        }));
        const inserted = await qh.insert(rows, Table.VISUALIZATION_COMPONENTS);
        if (inserted.status !== 200 || !Array.isArray(inserted.data)) throw new Error(`insert failed (${inserted.status})`);
        const counted = await qh.update({ componentCount: ordered.length }, { id: visualizationId }, Table.VISUALIZATIONS);
        if (counted.status !== 200) throw new Error(`component_count update failed (${counted.status})`);
        return mapIdsByKey(inserted.data);
      }
      const counted = await qh.update({ componentCount: 0 }, { id: visualizationId }, Table.VISUALIZATIONS);
      if (counted.status !== 200) throw new Error(`component_count update failed (${counted.status})`);
      return new Map();
    });
  } catch (error) {
    throw new PipelineStepError("analyzing", "Could not save the list of components.", {
      code: "ANALYSIS_PERSIST_FAILED", detail: `ANALYSIS_PERSIST_FAILED: ${getErrorMessage(error)}`, cause: error,
    });
  }
}
```

- Throwing inside the callback rolls the transaction back (04 §9.2).
- `QueryHandler` methods that return rows throw `QueryHandlerError` on DB errors; methods returning `ApiResponse` never throw — hence the explicit status checks.
- Ids are mapped by `filePath\u0000exportName` (unique per visualization after dedupe, backed by the unique index of 00 §14.3), never by array position. `mapIdsByKey` reads `id`, `filePath`, `exportName` from each returned row with runtime type checks (no casts).
- `visualizations.component_count` = all inserted rows (rendered + skipped), 00 §14.3. `changed_count` is not touched by 08 (07 writes the aggregate, 11 writes `visual_change`).
- `change_reason` is written for every row; `skip_reason` for skipped rows only (`<code>: <text>`, section 5.12). 08 never writes `harness_notes`.

The returned `ChangeAnalysisResult`:

```ts
{
  candidates: rendered.map((d) => ({ componentId: idOf(d), filePath, exportName, displayName, changeKind, rank, codeDiff, reason })),
  skipped:    skippedDrafts.map((d) => ({ filePath, exportName, displayName, changeKind, rank, codeDiff, reason, skipReason })),
  changedFiles,                                   // step 1, all paths
  sourceQueries: new AnalysisSourceQueries(state),  // 5.14
}
```

(`idOf` throws `PipelineStepError` `ANALYSIS_PERSIST_FAILED` when the key is missing from the map — impossible after a successful insert, but never use a non-null assertion.)

### 5.14 `AnalysisSourceQueries` — the `ComponentSourceQueries` implementation (`component-source-queries.ts`)

`AnalysisState` (built by `analyze`, captured only by the query object):

```ts
interface AnalysisState {
  workspace: PreparedWorkspace;
  repository: PipelineContext["repository"];
  changes: ReadonlyMap<string, FileChange>;      // analysable FileChanges by head path (base path for D); diffs already truncated
  changedFiles: ChangeAnalysisResult["changedFiles"];
  detector: ComponentDetector;
  sides: Record<Side, { rootDir: string; resolver: Promise<ModuleResolver> | null; graph: Promise<ImportGraph> | null }>;
  texts: LruCache<string, string | null>;        // key `${side}:${path}`; max 500 (changed files pinned outside the LRU)
  sourceFiles: LruCache<string, ts.SourceFile>;  // key `${side}:${path}`, max 200; parsed with parents: true
  log: Logger;
}
// LruCache = ~20-line Map-based class private to component-source-queries.ts (no dependency).

export class AnalysisSourceQueries implements ComponentSourceQueries {
  constructor(private readonly state: AnalysisState) {}
  // methods of 00 §14.7 / section 5.1.1
}
```

- The head resolver and head graph are the ones built in steps 6–7. The base resolver and base graph are built lazily on the first base query, with the same budget and file cap and a fresh `AbortSignal.timeout(ANALYSIS_GRAPH_BUDGET_MS)` (the analyze signal is gone by then). A failed base build is remembered: every later base query returns its empty result without retrying, with one `warn`.
- Every method wraps its body in `try/catch`; any error (including a missing worktree after 07's cleanup) → empty result (`found: false`, `[]`, `null`) + `warn` log `source_queries.failed` with `{ method, side, path, error }` (message only). Methods never reject.
- Concurrent calls are safe (09 runs up to 2 components in parallel): lazy builds are memoized as promises, caches are plain maps mutated synchronously.

#### 5.14.1 `resolveTypeSources(filePath, exportName, side)`

```text
1. sf = sourceFile(side, filePath); r = detector.findExport(sf, exportName); if !r?.componentNode → { found: false, … empty }
2. loc = detector.findPropsTypeNode(r), checking in order:
   a. forwardRef wrapper call with typeArguments → typeArguments[1]
   b. memo wrapper call with typeArguments → typeArguments[0]
   c. variable type annotation FC<P> | React.FC<P> | FunctionComponent<P> | React.FunctionComponent<P> | VFC<P> → typeArguments[0]
   d. class heritage Component<P, S> / PureComponent<P> → typeArguments[0]
   e. first parameter's type annotation (for forwardRef inner function: first parameter)
   f. none
   parameterText = first parameter's getText() (inner function for wrappers), or null
3. Unwrap known wrappers once: Readonly<X>, PropsWithChildren<X>, React.PropsWithChildren<X> → X
4. depth 0:
   - TypeReference Name / NS.Name → lookupType(Name, sf) (below) → source kind interface|type|enum|class
   - TypeLiteral / IntersectionType / UnionType / other → source { name: "(inline)", kind: "inline", text: node.getText() }
   - none (JS): add top-level `X.propTypes = …` and `X.defaultProps = …` statements as kinds propTypes/defaultProps
   also always add `X.defaultProps = …` when present (TS too)
5. depth 1: collect TypeReference names (and interface `extends` heritage names) inside every depth-0 node;
   skip names that are type parameters of the enclosing declaration; for each (sorted, deduped, ≤ TYPE_SOURCES_MAX_RELATED): lookupType
6. Accumulate sources in order until total text > TYPE_SOURCES_MAX_CHARS → stop, truncated = true
   (each source records startLine/endLine from getStart(sf)/getEnd() of its declaration)
7. Names not found → unresolved[]
```

`lookupType(name, sf)`:

1. Top-level interface/type alias/enum/class named `name` in `sf` → found (same file).
2. Import binding `name` in `sf` → resolve its module via the side's resolver; if internal, open that module and look for an **exported** declaration named by the binding's `imported` name; follow `reexport` edges up to 3 hops (`export { X } from`, `export * from`).
3. External/unresolved → not found (React types, DOM types, library types are deliberately excluded).

#### 5.14.2 `findCallSites(filePath, exportName, side, limit)`

```text
1. limit = clamp(limit, 1, CALL_SITE_MAX_LIMIT); graph = graphFor(side)
2. aliases = graph.exportAliases(filePath, exportName, 3)
     start {(filePath, exportName)}; BFS over reverse `reexport` edges:
       star edge: (barrel, sameName) unless name == "default"
       named edge: (barrel, b.local) for bindings with b.imported == name
3. usages = []
   for (modPath, name) in aliases:
     for edge in graph.importersOf(modPath) where edge.kind in (import):
       for b in edge.bindings:
         if b.imported == name → tags(edge.from) += b.local
         if b.imported == "*"  → tags(edge.from) += `${b.local}.${name}`
   also: in filePath itself, the export's localName (component used inside its own module)
4. for each (importerPath, tagSet):
     sf = sourceFile(side, importerPath); walk all nodes:
       JsxOpeningElement | JsxSelfClosingElement with tagName.getText(sf) ∈ tagSet
       line = startLine(node); elementEnd = endLine(JsxOpeningElement ? node.parent : node)
       usages.push({ filePath: importerPath, role, line, elementEnd, usedAs })
5. order: role (source, story, test), filePath asc, line asc
   pick round-robin: first pass at most 2 per file, then fill remaining by the same order; stop at limit
6. snippet per usage:
     startLine = max(1, line − CALL_SITE_CONTEXT_LINES)
     endLine   = min(totalLines, elementEnd + CALL_SITE_CONTEXT_LINES)
     if elementEnd − line > 40: endLine = min(totalLines, line + 40) and append "// … element continues to line <elementEnd>"
     snippet = `// ${filePath} lines ${startLine}–${endLine} (usage at line ${line})\n` + raw lines
```

Stories and tests are graph nodes precisely so that their usages (often the best prop examples) can be returned, ranked after real app usages.

#### 5.14.3 `getDirectImports(filePath, side)`

```text
1. sf = sourceFile(side, filePath); missing/unparseable → []
2. for each top-level ImportDeclaration, ExportDeclaration with moduleSpecifier, and every string-literal import("m")
   anywhere in the file (incl. React.lazy), in source order:
     specifier = moduleSpecifier.text; line = 1-based line of the statement
     typeOnly = importClause.isTypeOnly || (every named element isTypeOnly and no default/namespace)   // export type … from likewise
     defaultImport = importClause.name present  ||  export { default [as x] } from
     namespaceImport = NamespaceImport  ||  export * from  ||  export * as NS from
     namedImports = sorted names of non-type elements: (propertyName ?? name).text, excluding "default"
     sideEffectOnly = ImportDeclaration without importClause; reexport = ExportDeclaration; dynamic = import() call
     kind / resolvedPath: classification of 5.1.1 using resolveScript/resolveStyle (5.9.3) from filePath on that side
3. one DirectImport per statement (two statements with the same specifier yield two entries; consumers merge by specifier)
```

#### 5.14.4 `getModuleExports(filePath, side)`

```text
1. not a script file or unparseable on that side → null
2. names = exportName of every non-typeOnly ExportInfo of the module summary
         + named re-export names (bindings' local = exported name) except type-only re-exports
3. for each `export * from m` (not `export * as NS`, which adds NS to names): resolve m on that side; internal → add
   getModuleExports(m) minus "default", recursively up to 3 hops (visited set); unresolved/external → ignore
4. return sorted unique names
```

#### 5.14.5 `resolveSpecifier(fromFilePath, specifier, side)`

```text
1. resolver = resolverFor(side)
2. r = resolveScript(specifier, fromFilePath); if r is unresolved and isStyleSpecifier → r = resolveStyle(…)
3. internal → r.path
4. external and specifier is bare (packageNameOf(specifier) !== null, i.e. not "@/…" or "~/…"):
     exists(<rootDir>/node_modules/<packageName>/package.json) (fs.stat through the symlink, never read) → "package:<packageName>"
5. otherwise → null      (virtual:, URLs, relative misses, alias misses, packages that are not installed)
```

`packageNameOf` is imported from `services/visualizations/pipeline/mock-rules.ts` (pure module fully specified in 10 §5.8.2; whichever of 08/09/10 is built first creates it verbatim): `"@scope/name/sub"` → `"@scope/name"`; `"name/sub"` → `"name"`; specifiers starting with `.`, `/`, `@/`, `~/`, `#`, or containing `:` → `null`.

#### 5.14.6 `changedDependenciesOf(filePath, side, maxDepth)`

```text
1. depth = clamp(maxDepth, 1, 3); graph = graphFor(side)
2. forward BFS from filePath over importsOf() edges of kind import | reexport | dynamic | style | side_effect,
   visiting each module once, levels in path order
3. a visited module m (≠ filePath) is reported when changes has an entry whose head path (side head) or base path (side base) is m
4. result: { path: m, status, depth, codeDiff: change.codeDiff } ordered by depth asc, then path; at most 10
```

#### 5.14.7 `componentPaths(filePath)` and `basePathFor`

`change-source.ts` exports the pure helper used here and by sheets 10 and 11:

```ts
/** Base-side path of a candidate: null for "added"; previousPath of the changedFiles entry with status "R" and path === filePath; else filePath. */
export function basePathFor(filePath: string, changeKind: ComponentCandidate["changeKind"], changedFiles: ChangeAnalysisResult["changedFiles"]): string | null;
/** Head-side path: null for "removed"; else filePath. */
export function headPathFor(filePath: string, changeKind: ComponentCandidate["changeKind"]): string | null;
```

`componentPaths(filePath)` looks the candidate up by `filePath` (head path, or base path for removed rows), applies both helpers, then checks existence of each path on its side (`fs.stat` through the confinement helper); a missing file yields `null` for that side. A `filePath` that is not a candidate is treated as `modified` (existence decides).

### 5.15 Performance limits, budgets and caching

| Limit | Value | Behaviour when hit |
|---|---|---|
| Changed analysable files | 1 000 | rest ignored, console warn |
| Graph files per side | 3 000 | prioritised truncation (5.10.1), console warn |
| File size | 512 KB | not parsed; changed file → console warn, no candidates from it |
| Graph build soft budget | 45 s | partial graph, console warn |
| `analyze()` hard timeout | 180 s | `PipelineStepError` `ANALYSIS_TIMEOUT` |
| Affected-parent depth | 3 | BFS stops |
| Parents per seed | 2 | BFS stops |
| Code diff lines | 400 | truncated with marker |
| Type sources | 16 000 chars / 12 related decls | `truncated: true` |
| Call sites | 20 max per query, ±15 lines | clamp |
| SourceFile LRU | 200 per state | re-parse on miss |

Hard timeout: `analyze` wraps its body in `withTimeout(ANALYSIS_TIMEOUT_MS)`, which combines `ctx.signal` with `AbortSignal.timeout(...)` (`AbortSignal.any`) and passes the combined signal to the graph build. The timeout signal applies to `analyze` only; lazy query-time builds use their own budget (5.14).

Caching (per `analyze` call / per `AnalysisState`, never across visualizations): file texts (changed files always; others LRU 500), `ModuleSummary` inside each `ImportGraph`, one `ModuleResolver` and its `ModuleResolutionCache` per side, SourceFile LRU. Nothing is written to disk.

Expected timings on a 1 500-file `src/` (reference only): discovery < 1 s, direct detection < 0.5 s, head graph 2–5 s.

### 5.16 Worked examples

All examples use tsconfig `paths: { "@/*": ["src/*"] }` and `MAX_COMPONENTS = 12`, `MAX_PARENTS_PER_MODULE = 2`.

#### Example A — one export changes, its sibling does not

`src/components/Button.tsx` (status `M`):

```tsx
// base
import { memo, forwardRef } from "react";
import styles from "./Button.module.css";
export interface ButtonProps { label: string; variant?: "primary" | "ghost" }
const cx = (...c: Array<string | false>) => c.filter(Boolean).join(" ");
export function Button({ label, variant = "primary" }: ButtonProps) {
  return <button className={cx(styles.btn, variant === "ghost" && styles.ghost)}>{label}</button>;
}
export const IconButton = memo(forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => <button ref={ref}>{p.icon}</button>));
export const useButtonSize = (): number => 32;

// head — only Button's JSX text changed, and IconButton was reformatted by Prettier
export function Button({ label, variant = "primary" }: ButtonProps) {
  return <button className={cx(styles.btn, variant === "ghost" && styles.ghost)}>{label.toUpperCase()}</button>;
}
export const IconButton = memo(
  forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => (
    <button ref={ref}>{p.icon}</button>
  )),
);
```

Expected: one draft — `{ filePath: "src/components/Button.tsx", exportName: "Button", displayName: "Button", changeKind: "modified", reason: "Component code changed" }`. `IconButton` normalizes equal → not a candidate. `useButtonSize` is not a component and did not change → no seed.

#### Example B — a hook changes; parents found directly and through a barrel

```text
src/hooks/useCart.ts          M   export function useCart() {…changed…}; export const CART_LIMIT = 10;
src/hooks/index.ts                export * from "./useCart"; export * from "./useAuth";
src/components/CartBadge.tsx      import { useCart } from "@/hooks/useCart"; export function CartBadge() {…useCart()…}
src/components/CartLimitNote.tsx  import { CART_LIMIT } from "@/hooks/useCart"; export const CartLimitNote = () => <p>{CART_LIMIT}</p>;
src/pages/CheckoutPage.tsx        import { useCart } from "../hooks"; export default function CheckoutPage() {…useCart()…}
src/pages/AdminPage.tsx           import { useAuth } from "../hooks"; export default function AdminPage() {…}
src/components/CartBadge.test.tsx import { CartBadge } from "./CartBadge";
```

Seed: `{ path: "src/hooks/useCart.ts", names: {useCart}, reasonLabel: "hook src/hooks/useCart.ts" }`.

BFS:

| Depth | Importer | Edge names | Outcome |
|---|---|---|---|
| 1 | `src/components/CartBadge.tsx` | `{useCart}` | component `CartBadge` uses it → **found** (1/2) |
| 1 | `src/components/CartLimitNote.tsx` | `{CART_LIMIT}` | names do not intersect → ignored |
| 1 | `src/hooks/index.ts` | `export *` | non-component → enqueue with `{useCart}` |
| 2 | `src/pages/AdminPage.tsx` | `{useAuth}` | ignored |
| 2 | `src/pages/CheckoutPage.tsx` | `{useCart}` | `default` uses it → **found** (2/2) |

`CartBadge.test.tsx` is a test (never a parent). Expected drafts:

```json
[
  { "filePath": "src/components/CartBadge.tsx", "exportName": "CartBadge", "changeKind": "affected_parent", "codeDiff": null,
    "reason": "Imports changed hook src/hooks/useCart.ts" },
  { "filePath": "src/pages/CheckoutPage.tsx", "exportName": "default", "displayName": "CheckoutPage", "changeKind": "affected_parent", "codeDiff": null,
    "reason": "Imports changed hook src/hooks/useCart.ts via src/hooks/index.ts" }
]
```

#### Example C — formatting-only change

`src/components/Card.tsx` changes `'card'` → `"card"`, wraps a long JSX line and edits a comment. Every export normalizes equal and the residual is equal → no drafts, no seeds. Result: `candidates: []`, `skipped: []`, `changedFiles: [{ path: "src/components/Card.tsx", status: "M" }]`; console info `No React components are affected by this change.`

#### Example D — CSS-module-only change

`src/components/Card.module.css` (`M`): `.card { padding: 12px }` → `padding: 16px`. `Card.tsx` imports `styles from "./Card.module.css"` and is unchanged. `src/pages/Home.tsx` renders `<Card/>`.

Seed `{ path: "src/components/Card.module.css", names: "*" }`. BFS depth 1: `Card.tsx` (style edge, binding `default→styles`, `Card` closure contains `styles`), CSS module → `directStyleOwner`. Expected draft: `{ filePath: "src/components/Card.tsx", exportName: "Card", changeKind: "modified", reason: "Uses changed stylesheet src/components/Card.module.css", codeDiff: <diff of Card.module.css> }`. `Home` is not added (nearest rule: the walk stops at `Card.tsx`).

#### Example E — deleted file and renamed file

```text
D  src/components/Banner.tsx            (base: export default function Banner() { return <aside/> })
R92 src/components/Old.tsx → src/components/Notice.tsx   (export function Notice() — JSX changed)
```

Expected drafts: `{ filePath: "src/components/Banner.tsx", exportName: "default", displayName: "Banner", changeKind: "removed", reason: "File deleted", codeDiff: <full deletion diff> }` and `{ filePath: "src/components/Notice.tsx", exportName: "Notice", changeKind: "modified", reason: "Component code changed", codeDiff: <diff with rename from/to header> }`.

#### Example F — ranking and cap

Drafts: 9 `modified` (diff sizes 40, 40, 12, …), 2 `added`, 1 `removed`, 3 `affected_parent` (depths 1, 1, 2). Total 15. Sorted: modified (by diffSize desc, then path) → ranks 0–8; added → 9–10; removed → 11; affected_parent → 12–14. Rendered: ranks 0–11 (`pending`). Skipped: ranks 12–14 with `skipReason: "over_limit: ranked 13 of 15; PRVision renders at most 12 components per visualization"` etc. Console warn: `3 components were skipped (limit 12).`

## 6. Error handling and edge cases

Fatal: `new PipelineStepError("analyzing", userMessage, { code, detail: "<CODE>: <technical message>", cause })` (04 §10):

| Code | When | `userMessage` |
|---|---|---|
| `ANALYSIS_WORKTREE_MISSING` | `baseDir` or `headDir` missing | `The prepared workspace is missing. Start the visualization again.` |
| `ANALYSIS_GIT_DIFF_FAILED` | `GitClient` throws (bad SHA, git error other than no-index exit 1) | `Could not list the changed files (git diff failed).` |
| `ANALYSIS_TIMEOUT` | hard timeout | `Change analysis took too long and was stopped.` |
| `ANALYSIS_CANCELLED` | `ctx.signal` aborted or `isCancelled()` true at a checkpoint | `Cancelled.` (07 maps to status `cancelled`) |
| `ANALYSIS_PERSIST_FAILED` | transaction fails | `Could not save the list of components.` |

Every other failure is non-fatal and degrades results:

| Situation | Behaviour |
|---|---|
| No changes at all / no analysable changes | persist nothing (old rows deleted), `component_count = 0`, empty candidates, console info. 07 continues; 11 writes the fixed summary. |
| tsconfig unreadable / invalid JSON / missing `extends` target | defaults, console warn |
| Vite alias entry not statically readable | that alias ignored, console warn per alias |
| Vite config absent or unparsable | no aliases, `debug` log only (absence is normal) |
| Specifier unresolved | no edge, `debug` log, counted in stats |
| Head file has syntax errors | classify what parsed, console warn |
| File > 512 KB or binary | not parsed, console warn for changed files only |
| Symlink inside `src/` | skipped, `debug` log |
| One side lacks `src/` (working tree) | other side's files listed as A/D |
| Rename with exports unchanged | no candidate (pure rename doesn't change pixels); importers whose import path text changed are `modified` (known over-report; pixel diff will mark them `unchanged`) |
| Component moved between files | `removed` (old path) + `added` (new path) |
| File both changes a component and a hook it exports | component `modified`, hook names seed; parents found unless they are the component itself |
| Same component reached as direct and as parent | dedupe keeps `modified` |
| Circular imports | `visited` set prevents loops |
| Barrel `export * as UI from` | edge exists for propagation; call sites through `UI.X` via that barrel are not resolved (documented) |
| HOCs other than memo/forwardRef, `styled`, CommonJS | not components / not edges (documented limitations) |
| Test helpers importing changed modules | never parents (role filter) |
| Changes only outside `src/` | no candidates; warn if Tailwind/PostCSS/Vite config, `index.html` or `package.json` changed |
| `PreparedWorkspace.dependencyDrift = true` | nothing special here (07 already warned) |
| Graph build aborted by cancellation | converted to `ANALYSIS_CANCELLED` |
| Base graph build fails during a query | query returns empty result, `warn` log |

Abort conversion: wrap the step sequence in `try/catch`; if `ctx.signal.aborted`, throw `ANALYSIS_CANCELLED`; if the timeout signal fired, throw `ANALYSIS_TIMEOUT`; rethrow existing `PipelineStepError`s unchanged; wrap anything else as `ANALYSIS_UNEXPECTED` with `userMessage: "Change analysis failed unexpectedly."` (logged at `error` with stack). 07 distinguishes cancellation by `ctx.signal.reason` / `isCancelled()`, not by the code; the code is for logs and tests.

## 7. Logging / console events

pino: `logger.child({ module: "change-analysis", visualizationId })`. `debug` per file decision, unresolved specifier and alias evaluation; `info` once per step with counts and `durationMs`; `warn`/`error` for degraded/fatal paths. Never log file contents or diffs (they can contain secrets); log paths and counts only.

Console events (`ctx.console.*`, stage `"analyzing"`), exact templates (≤ 500 chars, paths truncated with `…` beyond that):

| Level | When | Message |
|---|---|---|
| info | start | `Looking for changed files between <base7> and <head7 \| "working tree">` |
| info | after step 2 | `<n> changed files, <m> of them React/TS/CSS sources under src/` |
| warn | non-src config changed | `<path> changed. PRVision does not analyse it; components may look different for reasons not shown here.` |
| warn | > 1 000 analysable | `Only the first 1000 changed source files were analysed.` |
| warn | per changed file too large / binary | `Skipped <path>: larger than 512 KB.` / `Skipped <path>: binary file.` |
| warn | per changed file with syntax errors | `<path> has syntax errors on the head side; its components may fail to render.` |
| info | after step 5 | `Found <d> directly changed components (<mod> modified, <add> added, <rem> removed).` |
| warn | tsconfig | `Could not read <tsconfigPath>; import aliases from it are ignored.` |
| warn | alias | `Vite alias "<find>" could not be read statically; imports using it are ignored.` |
| info | after graph | `Import graph: <files> modules, <edges> imports (<sec> s).` |
| warn | truncated | `src/ has <total> files; the import graph covers the <max> closest to the change, so some parent components may be missing.` |
| warn | budget | `Import graph stopped after <sec> s; some parent components may be missing.` |
| info | per seed with parents | `<reasonLabel> changed: also rendering <names joined ", ">.` |
| info | per seed without parents | `<reasonLabel> changed but no exported component imports it.` |
| warn | cap | `<k> components were skipped (limit <MAX_COMPONENTS>).` |
| info | none | `No React components are affected by this change.` |
| info | end | `Selected <n> components to render.` |

Fatal paths do not emit a console event themselves; 07 records `userMessage`.

## 8. Security notes

- **Never execute target-repo code.** The Vite config is parsed, not imported; tsconfig is parsed with a restricted host; no `require`, `import()`, `eval`, `new Function` of repo content.
- **Path confinement.** Every read goes through one helper that resolves `path.join(sideRoot, repoPath)`, runs `fs.realpath`, and rejects results outside `sideRoot` (prevents `../` and symlink escapes). Directory walking never follows symlinks. Alias replacements outside the worktree are rejected. The symlinked `node_modules` is never read except by `ts.resolveModuleName` probing for existence, and results inside it are classed external and never opened.
- **No shell.** Git runs through `GitClient` (04 `runProcess`: `spawn` with an argument array, no shell); paths are never interpolated into a shell string. Pathspecs are passed after `--`.
- **Resource limits** (file size, file count, time budget, LRU sizes) bound memory and CPU on hostile or huge repos. Regexes used on file contents are linear (no nested quantifiers).
- **Untrusted content.** File contents, diffs and identifiers come from a possibly untrusted PR. They are stored in the local DB and later sent to the AI provider by 09/11; this sheet does not interpret them as instructions and never logs them.
- Read-only: the user's clone is never written; git commands used are read-only (`diff`).

## 9. Tests

`node:test` + `node:assert/strict`. Location `tests/backend/pipeline/change-analysis/`. Fixture files are written to `fs.mkdtemp(os.tmpdir())` by `helpers/worktree-fixture.ts`:

```ts
export async function makeWorktrees(files: { base: Record<string, string>; head: Record<string, string> }): Promise<{ root: string; baseDir: string; headDir: string; cleanup(): Promise<void> }>;
export function stubGitClient(entries: GitNameStatusEntry[] | GitCommandError): GitClient;   // returns entries for both diff methods
export function stubPersistence(): { runInTransaction: ChangeAnalysisDeps["runInTransaction"]; createQueryHandler: ChangeAnalysisDeps["createQueryHandler"]; inserted: Record<string, unknown>[][]; deleted: unknown[]; updates: unknown[] };
export function makeContext(workspace: Partial<PreparedWorkspace>, repo?: Partial<PipelineContext["repository"]>): PipelineContext & { consoleEvents: Array<{ level: string; message: string }> };
```

`stubPersistence().insert` echoes rows with incrementing ids (100, 101, …) **in reverse order** to prove id mapping is by key, not position.

| File | Named cases |
|---|---|
| `component-detector.test.ts` | `detects exported function declaration returning JSX`; `detects arrow function with concise JSX body`; `detects conditional and logical JSX returns`; `detects memo-wrapped function expression`; `detects React.forwardRef with generics`; `detects memo(forwardRef()) nesting and records wrappers outermost first`; `resolves export default identifier to local declaration`; `resolves export { X as default }`; `names anonymous default export from file name`; `uses parent folder name for index files`; `honours static displayName assignment`; `detects class extending React.Component with render`; `detects class extending imported PureComponent`; `rejects lowercase names and hooks`; `rejects functions returning only null`; `rejects JSX returned only from nested functions`; `rejects createContext and styled components`; `records export * and named re-exports as reexport imports`; `treats import-then-export as re-export`; `ignores type-only exports for component detection`; `parses JSX in .js files` |
| `export-closure.test.ts` | `closure includes referenced local helpers transitively`; `closure includes local sub-components used in JSX`; `closure includes defaultProps and displayName statements`; `closure includes side-effect imports for every export`; `canonical import lines ignore unrelated specifiers`; `normalization ignores formatting, quotes, comments and trailing commas`; `normalization ignores type-only edits`; `normalization detects literal, className and JSX changes`; `equal raw closures skip transpileModule`; `sibling export change does not mark export as modified` (Example A); `residual side-effect change yields wildcard seed`; `falls back to whitespace-collapsed text when transpile throws` |
| `change-source.test.ts` | `normalizes POSIX paths, dedupes and sorts entries`; `maps C to A, T and U to M, keeps R previousPath and drops X`; `strips base/ and head/ prefixes from no-index output`; `maps GitCommandError aborted to ANALYSIS_CANCELLED and others to ANALYSIS_GIT_DIFF_FAILED`; `uses no-index for working_tree and diffNameStatus for commit modes`; `lists all files as added when base lacks src`; `classifySourcePath table` (one assertion per row of 5.5); `detects generated marker in file header`; `buildUnifiedDiff produces new/deleted/rename headers`; `buildUnifiedDiff counts changed lines`; `truncateDiff keeps 400 lines and appends marker`; `readText rejects symlinks and paths escaping the worktree`; `readText flags files over size limit and binary files` |
| `module-resolver.test.ts` | `resolves tsconfig paths alias`; `follows tsconfig references to tsconfig.app.json`; `reads vite object alias with path.resolve(__dirname)`; `reads vite array alias with find/replacement`; `reads fileURLToPath(new URL()) alias`; `reads defineConfig arrow returning object`; `warns and skips regex find and non-static replacement`; `rejects alias replacement outside the worktree`; `resolves Vite root-relative /src imports`; `classifies node_modules and bare packages as external`; `resolves scss partials and index files`; `resolves css module composes`; `resolves scss import through tsconfig paths`; `reads tsconfig extends from a node_modules package`; `classifies asset imports as external` |
| `import-graph.test.ts` | `builds forward and reverse edges with bindings`; `skips type-only imports`; `marks tests and stories by role but includes them as nodes`; `does not follow symlinked directories`; `truncates to maxFiles keeping changed files and nearest directories`; `stops at soft budget and flags budgetExceeded`; `findAffectedParents finds direct importer using the binding`; `findAffectedParents ignores importers of other names`; `findAffectedParents walks through export-star barrel`; `findAffectedParents maps names through named re-export`; `findAffectedParents stops at nearest component importer`; `findAffectedParents respects depth limit 3`; `findAffectedParents caps at MAX_PARENTS_PER_MODULE`; `already-covered parents do not consume the cap`; `ignores test and story importers`; `handles circular imports`; `walks SCSS partial chain to component`; `componentsFromEntry returns App for global stylesheet`; `exportAliases follows barrels for call sites`; `graph build parses without parent nodes` |
| `change-analysis-service.test.ts` | `Example A: only changed export becomes modified`; `Example B: hook change yields two affected parents with reasons`; `Example C: formatting-only change yields no candidates and info event`; `Example D: CSS module change marks owning component modified with stylesheet diff`; `Example E: deleted file yields removed default export; rename yields modified with rename header`; `Example F: ranking order and over_limit skip reasons`; `added file yields added components`; `dedupe keeps modified over affected_parent`; `codeDiff is null for affected_parent`; `persists rows in one transaction, deletes previous rows, updates component_count`; `maps component ids by key not insert order`; `writes change_reason for every row and skip_reason for skipped rows only`; `never writes harness_notes`; `throws ANALYSIS_GIT_DIFF_FAILED when git fails`; `throws ANALYSIS_WORKTREE_MISSING`; `throws ANALYSIS_CANCELLED when cancelled before persist and writes nothing`; `throws ANALYSIS_PERSIST_FAILED when insert fails`; `warns about tailwind.config change outside src`; `no analysable changes persists nothing and returns empty result` |
| `component-source-queries.test.ts` | `analyze returns sourceQueries implementing every ComponentSourceQueries method`; `queries never reject and return empty results after worktrees are removed`; `failed lazy base graph build is not retried`; `resolveTypeSources returns interface from same file`; `resolveTypeSources follows imported props type through barrel`; `resolveTypeSources reads forwardRef second type argument`; `resolveTypeSources reads FC<P> annotation`; `resolveTypeSources returns inline type literal`; `resolveTypeSources includes depth-1 referenced types only`; `resolveTypeSources lists external types as unresolved`; `resolveTypeSources returns propTypes and defaultProps for JS components`; `resolveTypeSources truncates at char budget`; `findCallSites returns JSX usages with ±15 lines`; `findCallSites resolves aliased and namespace imports`; `findCallSites follows barrels`; `findCallSites orders source before story before test and diversifies files`; `findCallSites clamps limit`; `findCallSites uses base graph for removed components`; `getDirectImports lists default, named, namespace, type-only, side-effect, re-export and dynamic imports with kinds`; `getDirectImports resolves alias and relative targets per side`; `getModuleExports includes default, named re-exports and export-star targets up to 3 hops`; `getModuleExports returns null for stylesheets and missing files`; `resolveSpecifier returns repo path, package:<name> for installed packages, null otherwise`; `changedDependenciesOf returns nearest changed imports with their diffs`; `resolveTypeSources reports start and end lines`; `componentPaths returns the previous path on base for renamed components and null for absent sides`; `basePathFor and headPathFor follow change kind and renames` |

Run with the backend test script (`npm test --prefix backend`: `node --test … -r ts-node/register/transpile-only`, sheet 02 / 00 §14.10). Tests must not need Postgres, Redis or git (git is stubbed; one optional test `change-source.git.test.ts` runs real `git diff --no-index` and is skipped when `git` is not on PATH).

## 10. Acceptance criteria

- [ ] All files in section 4 exist; no `any`; explicit return types; `strict` + `noUncheckedIndexedAccess` compile clean; lint clean.
- [ ] `ChangeAnalysisService.analyze` returns `ChangeAnalysisResult` exactly as in 00 §8 + §14.7 (including `sourceQueries`) and throws only `PipelineStepError` (stage `analyzing`, 04 §10 constructor).
- [ ] Commit modes call `GitClient.diffNameStatus(headDir, baseSha, headSha, { renames: true }, { signal })`; working tree calls `GitClient.diffNameStatusNoIndex(worktreesDir, "base/src", "head/src", { renames: true }, { signal })`; `normalizeEntries` maps git's letters to `A | M | D | R` (04 §9.5 leaves the mapping to 08).
- [ ] No `ts.createProgram`, `ts.createLanguageService` or `TypeChecker` anywhere in sheet 08 code (grep check).
- [ ] Path filter table (5.5) is implemented exactly and covered by a table-driven test.
- [ ] Every row of the detection table (5.7.5) is a passing test.
- [ ] Formatting-only, comment-only and type-only edits produce no `modified` candidates; sibling-export edits do not mark unchanged exports.
- [ ] tsconfig `paths` (incl. `references`) and statically readable Vite aliases resolve; unreadable aliases produce one console warning each; the Vite config is never executed.
- [ ] Affected parents: nearest exported components only, depth ≤ 3, ≤ 2 per seed, binding-aware, through barrels; tests/stories never parents.
- [ ] CSS-module/co-located stylesheet changes produce `modified` for the owning component with the stylesheet diff.
- [ ] Ranking order and `MAX_COMPONENTS` cap match 5.12; skipped rows carry `over_limit` reasons.
- [ ] Rows are written in one `DrizzleDb.transaction` (previous rows deleted first); ids are mapped by key; `component_count` is updated; `change_reason` is set on every row and `skip_reason` on skipped rows; `harness_notes` is never written.
- [ ] `codeDiff` is truncated at 400 lines with the exact marker; `affected_parent.codeDiff` is `null`.
- [ ] Every `ComponentSourceQueries` method behaves as in 5.1.1 / 5.14, takes an explicit side, never rejects, and is covered by tests.
- [ ] Limits in 5.15 are enforced; a 3 000-file synthetic tree (generated in a test, ~20 lines each) builds its graph in < 15 s on a dev laptop (`import-graph.test.ts` perf case; the timing is reported with `t.diagnostic`, and the case fails only above the 15 s budget).
- [ ] Console events use the templates in section 7; no file contents are logged.
- [ ] All tests in section 9 pass without Postgres/Redis.

## 11. Contract changes requested

Resolved:

1. New files (`import-graph.ts`, `component-detector.ts`, `module-resolver.ts`, `change-source.ts`, `component-source-queries.ts`, `types/change-analysis.ts`) — Resolved — 00 §14.12 (each sheet's file inventory is authoritative; section 4 lists them).
2. 08 → 09 hand-off — Resolved — 00 §14.7 (`ChangeAnalysisResult.sourceQueries: ComponentSourceQueries`, final interface in 5.1.1).
3. `GitClient.diffNameStatus` / `diffNameStatusNoIndex` — Resolved — 00 §14.8 (signatures in 3.2 follow 04 §9.5).
4. `PreparedWorkspace.baseSha` is the merge base — Resolved — 00 §14.7.
5. Config constants — Resolved — 00 §14.8 (sheet 02 owns the consolidated list; names and values in 3.4).
6. `diff@^8` — Resolved — 00 §14.1.
7. `change_reason` / `skip_reason` columns and view fields — Resolved — 00 §14.3 / §14.4.
8. Unique `(visualization_id, file_path, export_name)` — Resolved — 00 §14.3.
9. `component_count` semantics — Resolved — 00 §14.3 (`changed_count` is aggregated by 07; 11 writes `visual_change`).

10. **00 §8 type file** — Resolved — 00 §14.12: the types of 5.1.1 (`WorktreeSide`, `ComponentSourceQueries`, `TypeSourceResult`, `CallSite`, `DirectImport`, `ChangedDependency`) and `ChangeAnalysisResult.sourceQueries` live in `backend/src/types/visualization-pipeline.ts`; 02 ships a placeholder `ComponentSourceQueries` that this sheet replaces verbatim with 5.1.1.
11. **`CHANGED_FILES_MAX_ENTRIES = 5_000`** — Resolved — present in 02 §6.7 (`render.config.ts`).

Open: none.
