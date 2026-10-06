/**
 * Internal types of sheet 08 (change analysis, 08 §5.2). Never imported by sheets 09–11: the cross-sheet query
 * types (`ComponentSourceQueries` and its results) live in `visualization-pipeline.ts`.
 */
import type { ComponentPredecessor, WorktreeSide } from "./visualization-pipeline";

export type Side = WorktreeSide;
export type FileRole = "source" | "test" | "story" | "generated";
export type FileLanguage = "script" | "style";
export type ChangeKind = "modified" | "added" | "removed" | "affected_parent" | "replaced";

export interface PathClassification {
  analysable: boolean; // eligible to produce candidates/seeds
  inGraph: boolean; // eligible as an import-graph node
  language: FileLanguage | null;
  role: FileRole;
  excludeReason: string | null; // "outside src/", "declaration file", "test file", …
}

export interface ImportBinding {
  imported: string; // "default" | name | "*"
  local: string;
}

export interface RawImport {
  specifier: string;
  kind: "import" | "side_effect" | "reexport" | "dynamic" | "style";
  bindings: ImportBinding[]; // reexport: { imported, local: exportedName }
  star: boolean; // namespace import, `export *`, side-effect, dynamic → "all names"
  line: number; // 1-based
}

export interface ExportInfo {
  exportName: string; // "default" or the exported name
  localName: string | null; // top-level binding that holds the value, null for anonymous default
  isComponent: boolean;
  shape: "function" | "arrow" | "class" | null;
  wrappers: Array<"memo" | "forwardRef">; // outermost first
  displayName: string;
  declStart: number; // node.getStart() of the declaring statement
  declEnd: number;
  closureNames: string[]; // top-level names (incl. import locals) reachable from this export
  typeOnly: boolean; // exported interface/type alias (ignored for change seeding)
}

export interface ModuleSummary {
  path: string; // repo-relative POSIX
  side: Side;
  language: FileLanguage;
  role: FileRole;
  sizeBytes: number;
  parsed: boolean; // false: too large / binary / unreadable
  syntaxErrors: number;
  imports: RawImport[];
  exports: ExportInfo[]; // script only
}

export interface ImportEdge {
  from: string; // importer
  to: string; // imported module (repo-relative, in graph)
  kind: RawImport["kind"];
  bindings: ImportBinding[];
  star: boolean;
  specifier: string;
  line: number;
}

export interface FileChange {
  status: "A" | "M" | "D" | "R";
  path: string; // head path (A/M/R) or base path (D)
  previousPath: string | null; // R only
  basePath: string | null; // previousPath ?? path for M/R/D; null for A
  headPath: string | null; // path for A/M/R; null for D
  language: FileLanguage;
  baseText: string | null;
  headText: string | null;
  codeDiff: string; // already truncated
  changedLines: number; // +/- lines in the full (untruncated) diff
  tooLarge: boolean;
}

export interface Seed {
  path: string; // changed module (head path)
  names: Set<string> | "*"; // changed export names, "*" = whole module (stylesheets, side effects)
  reasonLabel: string; // "hook src/hooks/useCart.ts", "stylesheet src/styles/tokens.scss"
  global: boolean; // true for repository.globalStylePaths
  changedLines: number;
}

export interface DraftCandidate {
  filePath: string;
  exportName: string;
  displayName: string;
  changeKind: ChangeKind;
  codeDiff: string | null;
  reason: string;
  diffSize: number; // ranking tie-break
  depth: number; // 0 for direct, BFS depth for affected_parent
  forcedSkipReason: string | null;
  /** 00 §17: set only on `replaced` drafts (the removed base component and the successor evidence). */
  predecessor?: ComponentPredecessor | null;
}
