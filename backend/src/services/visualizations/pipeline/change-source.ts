/**
 * Changed-file discovery and side-aware file reads for change analysis (08 §5.4–5.6, §8).
 *
 * Pure helpers exported here are also used by sheets 10 and 11: `classifySourcePath`, `buildUnifiedDiff`,
 * `truncateDiff`, `basePathFor`, `headPathFor` and `readConfinedText` (the single confinement helper of 08 §8).
 */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { structuredPatch } from "diff";
import { ANALYSIS_MAX_FILE_BYTES, ANALYSIS_SOURCE_ROOT } from "../../../config-consts";
import type { FileLanguage, PathClassification, Side } from "../../../types/change-analysis";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type PreparedWorkspace
} from "../../../types/visualization-pipeline";
import {
  GitCommandError,
  getErrorMessage,
  isPathInside,
  type GitClient,
  type GitNameStatusEntry
} from "../../../utilities";

/** One element of 00 §8 `ChangeAnalysisResult.changedFiles`, produced by normalizeEntries from 04's GitNameStatusEntry. */
export interface RawChange {
  path: string;
  status: "A" | "M" | "D" | "R";
  previousPath?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Path classification (08 §5.5)
// ---------------------------------------------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs", ".css", ".scss"]);
const TEST_SEGMENTS = new Set(["__tests__", "__mocks__", "__fixtures__", "test", "tests", "e2e", "cypress"]);
const TEST_STEMS = new Set(["setupTests", "setup-tests", "test-utils", "testUtils"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const STORY_FILE = /\.(stories|story)\.[cm]?[jt]sx?$/;
const GENERATED_FILE = /\.(generated|gen)\.[cm]?[jt]s$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const GENERATED_MARKER = /@generated|auto-?generated|do not edit/i;
const STYLE_EXTENSION = /\.(css|scss)$/;

function excluded(role: PathClassification["role"], inGraph: boolean, reason: string, language: FileLanguage | null) {
  return { analysable: false, inGraph, language, role, excludeReason: reason } satisfies PathClassification;
}

/**
 * Classifies a repo-relative POSIX path (08 §5.5 table, first match wins).
 *
 * @param repoPath - Repo-relative path, e.g. "src/components/Button.tsx".
 * @param opts - `sourceRoot` without slashes (default "src").
 */
export function classifySourcePath(
  repoPath: string,
  opts: { sourceRoot: string } = { sourceRoot: ANALYSIS_SOURCE_ROOT }
): PathClassification {
  const posix = repoPath.replace(/\\/g, "/");
  const segments = posix.split("/");
  const basename = segments[segments.length - 1] ?? "";
  const language: FileLanguage = STYLE_EXTENSION.test(basename) ? "style" : "script";
  if (!posix.startsWith(`${opts.sourceRoot}/`)) {
    return excluded("source", false, "outside src/", null);
  }
  if (segments.some((segment) => segment === "node_modules" || segment.startsWith("."))) {
    return excluded("source", false, "ignored directory", null);
  }
  if (DECLARATION_FILE.test(basename)) {
    return excluded("source", false, "declaration file", null);
  }
  if (basename.endsWith(".mdx")) {
    return excluded("story", false, "story file", null);
  }
  const ext = path.posix.extname(basename);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return excluded("source", false, "unsupported extension", null);
  }
  const stem = basename.slice(0, basename.length - ext.length);
  const directories = segments.slice(0, -1);
  if (TEST_FILE.test(basename) || directories.some((segment) => TEST_SEGMENTS.has(segment)) || TEST_STEMS.has(stem)) {
    return excluded("test", true, "test file", language);
  }
  if (STORY_FILE.test(basename)) {
    return excluded("story", true, "story file", language);
  }
  if (
    directories.some((segment) => segment === "generated" || segment === "__generated__") ||
    GENERATED_FILE.test(basename)
  ) {
    return excluded("generated", true, "generated file", language);
  }
  return { analysable: true, inGraph: true, language, role: "source", excludeReason: null };
}

/** Content-based generated check (08 §5.5): the first 512 bytes carry a generated marker. */
export function hasGeneratedMarker(text: string): boolean {
  return GENERATED_MARKER.test(text.slice(0, 512));
}

// ---------------------------------------------------------------------------------------------------------------
// Confined reads (08 §5.6, §8)
// ---------------------------------------------------------------------------------------------------------------

/** Outcome of one confined read. `unsafe` = symlink, escape or invalid path; `missing` = no such regular file. */
export type ConfinedRead =
  | { kind: "ok"; text: string; sizeBytes: number }
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "too_large"; sizeBytes: number }
  | { kind: "binary"; sizeBytes: number };

function isSafeRepoPath(repoPath: string): boolean {
  if (repoPath === "" || repoPath.includes("\0") || repoPath.startsWith("/") || repoPath.includes("\\")) {
    return false;
  }
  return !repoPath.split("/").some((segment) => segment === "..");
}

/**
 * Reads `<sideRoot>/<repoPath>` with the 08 §8 guards: lstat (symlinks refused), realpath inside `sideRoot`,
 * size limit, NUL byte in the first 8 KB = binary, UTF-8 decode with BOM stripped and CRLF → LF.
 */
export async function readConfined(
  sideRoot: string,
  repoPath: string,
  maxBytes: number = ANALYSIS_MAX_FILE_BYTES
): Promise<ConfinedRead> {
  if (!isSafeRepoPath(repoPath)) {
    return { kind: "unsafe" };
  }
  const absolute = path.join(sideRoot, repoPath);
  if (!isPathInside(sideRoot, absolute)) {
    return { kind: "unsafe" };
  }
  let stats;
  try {
    stats = await fs.lstat(absolute);
  } catch {
    return { kind: "missing" };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "unsafe" };
  }
  if (!stats.isFile()) {
    return { kind: "missing" };
  }
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(sideRoot), fs.realpath(absolute)]);
    if (!isPathInside(realRoot, realFile)) {
      return { kind: "unsafe" };
    }
  } catch {
    return { kind: "missing" };
  }
  if (stats.size > maxBytes) {
    return { kind: "too_large", sizeBytes: stats.size };
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absolute);
  } catch {
    return { kind: "missing" };
  }
  if (buffer.length > maxBytes) {
    return { kind: "too_large", sizeBytes: buffer.length };
  }
  if (buffer.subarray(0, 8192).includes(0)) {
    return { kind: "binary", sizeBytes: buffer.length };
  }
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return { kind: "ok", text: text.replace(/\r\n/g, "\n"), sizeBytes: buffer.length };
}

/**
 * The 08 §8 confinement helper as a plain text read: `null` when the file is missing, unsafe (symlink or
 * escape), larger than `maxBytes` or binary.
 */
export async function readConfinedText(
  sideRoot: string,
  repoPath: string,
  maxBytes: number = ANALYSIS_MAX_FILE_BYTES
): Promise<string | null> {
  const result = await readConfined(sideRoot, repoPath, maxBytes);
  return result.kind === "ok" ? result.text : null;
}

/** True when `<sideRoot>/<repoPath>` is a regular file inside `sideRoot` (no symlink, realpath confined). */
export async function confinedFileExists(sideRoot: string, repoPath: string): Promise<boolean> {
  const result = await readConfined(sideRoot, repoPath, Number.MAX_SAFE_INTEGER);
  return result.kind === "ok" || result.kind === "binary";
}

// ---------------------------------------------------------------------------------------------------------------
// Directory walk (08 §5.10.1)
// ---------------------------------------------------------------------------------------------------------------

const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "__snapshots__", "coverage", "dist", "build"]);

/**
 * Lists every regular file under `<rootDir>/<sourceRoot>` as repo-relative POSIX paths, sorted by name per level.
 * Skips dot entries, node_modules/__snapshots__/coverage/dist/build and every symlink (never followed).
 */
export async function walkSourceFiles(rootDir: string, sourceRoot: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const visit = async (relativeDir: string): Promise<void> => {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(entry.name) || entry.isSymbolicLink()) {
        continue;
      }
      const child = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };
  await visit(sourceRoot);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (08 §5.6)
// ---------------------------------------------------------------------------------------------------------------

export const CODE_DIFF_TRUNCATION_MARKER = (shown: number, total: number): string =>
  `… [PRVision: diff truncated — showing ${String(shown)} of ${String(total)} lines]`;

/** Placeholder diff for a side that is too large or binary (08 §5.6). */
export function unavailableDiff(oldPath: string | null, newPath: string | null): string {
  return `diff --git a/${oldPath ?? newPath ?? ""} b/${newPath ?? oldPath ?? ""}\n(PRVision: file too large or binary — diff not shown)`;
}

/** Unified diff with git-style headers built from file contents (both sides are on disk). */
export function buildUnifiedDiff(input: {
  oldPath: string | null;
  newPath: string | null;
  oldText: string | null;
  newText: string | null;
}): { diff: string; changedLines: number } {
  const oldText = input.oldText ?? "";
  const newText = input.newText ?? "";
  const patch = structuredPatch(input.oldPath ?? "/dev/null", input.newPath ?? "/dev/null", oldText, newText, "", "", {
    context: 3
  });
  const header: string[] = [
    `diff --git a/${input.oldPath ?? input.newPath ?? ""} b/${input.newPath ?? input.oldPath ?? ""}`
  ];
  if (input.oldPath === null) {
    header.push("new file mode 100644");
  }
  if (input.newPath === null) {
    header.push("deleted file mode 100644");
  }
  if (input.oldPath !== null && input.newPath !== null && input.oldPath !== input.newPath) {
    header.push(`rename from ${input.oldPath}`, `rename to ${input.newPath}`);
  }
  header.push(
    input.oldPath !== null ? `--- a/${input.oldPath}` : "--- /dev/null",
    input.newPath !== null ? `+++ b/${input.newPath}` : "+++ /dev/null"
  );
  let changedLines = 0;
  const body: string[] = [];
  for (const hunk of patch.hunks) {
    body.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`
    );
    for (const line of hunk.lines) {
      body.push(line);
      if (line.startsWith("+") || line.startsWith("-")) {
        changedLines++;
      }
    }
  }
  return { diff: [...header, ...body].join("\n"), changedLines };
}

/** Keeps the first `maxLines` lines and appends the 08 truncation marker. */
export function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) {
    return diff;
  }
  return [...lines.slice(0, maxLines), CODE_DIFF_TRUNCATION_MARKER(maxLines, lines.length)].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Side paths (08 §5.14.7; used by 10 and 11)
// ---------------------------------------------------------------------------------------------------------------

/** Base-side path of a candidate: null for "added"; previousPath of the changedFiles entry with status "R" and path === filePath; else filePath. */
export function basePathFor(
  filePath: string,
  changeKind: ComponentCandidate["changeKind"],
  changedFiles: ChangeAnalysisResult["changedFiles"]
): string | null {
  if (changeKind === "added") {
    return null;
  }
  const rename = changedFiles.find((file) => file.status === "R" && file.path === filePath);
  return rename?.previousPath ?? filePath;
}

/** Head-side path: null for "removed"; else filePath. */
export function headPathFor(filePath: string, changeKind: ComponentCandidate["changeKind"]): string | null {
  return changeKind === "removed" ? null : filePath;
}

// ---------------------------------------------------------------------------------------------------------------
// Name-status normalization (08 §5.4)
// ---------------------------------------------------------------------------------------------------------------

function stripPrefix(value: string, prefixes: readonly string[]): string {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return value;
}

/**
 * Maps git's letters to the 00 §8 statuses: A→A, M/T/U→M, D→D, R→R (with previousPath), C→A (new path), X dropped.
 * Converts paths to POSIX, strips `stripPrefixes` (working tree: "base/", "head/"), dedupes by path (first wins)
 * and sorts by path (plain `<`).
 */
export function normalizeEntries(
  entries: readonly GitNameStatusEntry[],
  stripPrefixes: readonly string[] = []
): RawChange[] {
  const byPath = new Map<string, RawChange>();
  for (const entry of entries) {
    const entryPath = stripPrefix(entry.path.replace(/\\/g, "/"), stripPrefixes);
    let change: RawChange | null;
    switch (entry.status) {
      case "A":
      case "C":
        change = { path: entryPath, status: "A" };
        break;
      case "M":
      case "T":
      case "U":
        change = { path: entryPath, status: "M" };
        break;
      case "D":
        change = { path: entryPath, status: "D" };
        break;
      case "R":
        change =
          entry.previousPath === undefined
            ? { path: entryPath, status: "M" }
            : {
                path: entryPath,
                status: "R",
                previousPath: stripPrefix(entry.previousPath.replace(/\\/g, "/"), stripPrefixes)
              };
        break;
      case "X":
        change = null;
        break;
    }
    if (change !== null && !byPath.has(change.path)) {
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------
// ChangeSource
// ---------------------------------------------------------------------------------------------------------------

/** Side-aware read result used by the service (08 §5.6). */
export interface SideText {
  text: string | null;
  tooLarge: boolean;
  binary: boolean;
  unsafe: boolean;
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function commonAncestor(a: string, b: string): string {
  const left = path.resolve(a).split(path.sep);
  const right = path.resolve(b).split(path.sep);
  const shared: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      break;
    }
    shared.push(left[index] ?? "");
  }
  return shared.join(path.sep) || path.sep;
}

function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

/** Changed-file discovery for commit and working-tree modes (08 §5.4) and side-aware reads (08 §5.6). */
export class ChangeSource {
  /** git's similarity (percent) of every reported rename, by `<previousPath>\0<path>` (00 §17 `git_rename`). */
  private readonly renameScores = new Map<string, number>();

  constructor(
    private readonly git: Pick<GitClient, "diffNameStatus" | "diffNameStatusNoIndex">,
    private readonly workspace: PreparedWorkspace,
    private readonly signal: AbortSignal,
    private readonly sourceRoot: string = ANALYSIS_SOURCE_ROOT
  ) {}

  /**
   * All changed paths of the visualization, normalized (08 §5.4).
   *
   * @throws PipelineStepError ANALYSIS_CANCELLED when git was aborted, ANALYSIS_GIT_DIFF_FAILED otherwise.
   */
  async listChanges(): Promise<RawChange[]> {
    try {
      if (this.workspace.sourceType === "working_tree" || this.workspace.headSha === null) {
        return await this.listWorkingTreeChanges();
      }
      const entries = await this.git.diffNameStatus(
        this.workspace.headDir,
        this.workspace.baseSha,
        this.workspace.headSha,
        { renames: true },
        { signal: this.signal }
      );
      this.rememberRenames(entries, []);
      return normalizeEntries(entries);
    } catch (error: unknown) {
      if (error instanceof PipelineStepError) {
        throw error;
      }
      if (this.signal.aborted || (error instanceof GitCommandError && error.code === "aborted")) {
        throw new PipelineStepError("analyzing", "Cancelled.", {
          code: "ANALYSIS_CANCELLED",
          detail: "ANALYSIS_CANCELLED: git diff was aborted",
          cause: error
        });
      }
      throw new PipelineStepError("analyzing", "Could not list the changed files (git diff failed).", {
        code: "ANALYSIS_GIT_DIFF_FAILED",
        detail: `ANALYSIS_GIT_DIFF_FAILED: ${getErrorMessage(error)}`,
        cause: error
      });
    }
  }

  /** git's similarity in percent for the rename `previousPath` → `path` of the last listChanges(), or null. */
  renameSimilarity(previousPath: string, renamedPath: string): number | null {
    return this.renameScores.get(`${previousPath}\u0000${renamedPath}`) ?? null;
  }

  private rememberRenames(entries: readonly GitNameStatusEntry[], stripPrefixes: readonly string[]): void {
    for (const entry of entries) {
      if (entry.status === "R" && entry.previousPath !== undefined && entry.score !== undefined) {
        const from = stripPrefix(entry.previousPath.replace(/\\/g, "/"), stripPrefixes);
        const to = stripPrefix(entry.path.replace(/\\/g, "/"), stripPrefixes);
        this.renameScores.set(`${from}\u0000${to}`, entry.score);
      }
    }
  }

  /** Reads one side of a changed file with the 08 §5.6 guards. */
  async readText(side: Side, repoPath: string): Promise<SideText> {
    const root = side === "base" ? this.workspace.baseDir : this.workspace.headDir;
    const result = await readConfined(root, repoPath);
    return {
      text: result.kind === "ok" ? result.text : null,
      tooLarge: result.kind === "too_large",
      binary: result.kind === "binary",
      unsafe: result.kind === "unsafe"
    };
  }

  private async listWorkingTreeChanges(): Promise<RawChange[]> {
    const { baseDir, headDir } = this.workspace;
    const [baseHasSrc, headHasSrc] = await Promise.all([
      directoryExists(path.join(baseDir, this.sourceRoot)),
      directoryExists(path.join(headDir, this.sourceRoot))
    ]);
    if (baseHasSrc && headHasSrc) {
      const worktreesDir = path.dirname(baseDir);
      const standardLayout =
        path.dirname(headDir) === worktreesDir &&
        path.basename(baseDir) === "base" &&
        path.basename(headDir) === "head";
      const cwd = standardLayout ? worktreesDir : commonAncestor(baseDir, headDir);
      const leftPrefix = `${toPosixRelative(cwd, baseDir)}/`;
      const rightPrefix = `${toPosixRelative(cwd, headDir)}/`;
      const entries = await this.git.diffNameStatusNoIndex(
        cwd,
        `${leftPrefix}${this.sourceRoot}`,
        `${rightPrefix}${this.sourceRoot}`,
        { renames: true },
        { signal: this.signal }
      );
      this.rememberRenames(entries, [leftPrefix, rightPrefix]);
      return normalizeEntries(entries, [leftPrefix, rightPrefix]);
    }
    if (headHasSrc) {
      const files = await walkSourceFiles(headDir, this.sourceRoot, this.signal);
      return normalizeEntries(files.map((file) => ({ status: "A" as const, path: file })));
    }
    if (baseHasSrc) {
      const files = await walkSourceFiles(baseDir, this.sourceRoot, this.signal);
      return normalizeEntries(files.map((file) => ({ status: "D" as const, path: file })));
    }
    return [];
  }
}
