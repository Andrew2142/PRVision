/**
 * Global style triggers (16 §8.5, D7): changed files that make a run re-check every saved harness of the
 * repository's library. Pure; the patterns are the shared `GLOBAL_STYLE_TRIGGER_PATTERNS` constants (§16.1).
 */
import path from "node:path";
import { GLOBAL_STYLE_TRIGGER_PATTERNS } from "../../../config-consts";
import type { ChangeAnalysisResult } from "../../../types/visualization-pipeline";

const posix = path.posix;

export type GlobalStyleTriggerReason =
  "global_stylesheet" | "tailwind_config" | "postcss_config" | "design_tokens" | "index_html" | "angular_workspace";

export interface GlobalStyleTrigger {
  path: string;
  reason: GlobalStyleTriggerReason;
}

export interface GlobalStyleTriggerInput {
  framework: "react_vite" | "angular";
  /** Repo-relative app root; "." = the repository root. */
  appRoot: string;
  viteConfigPath: string | null;
  /** 00 §14.3 specifier form: "/src/index.css" for repo files. */
  globalStylePaths: readonly string[];
  /** From ChangeAnalysisResult (§8.5.2), head paths. */
  globalStyleChanges: readonly string[];
  changedFiles: ChangeAnalysisResult["changedFiles"];
}

/** Console labels of the reasons (16 §8.5.4). */
export const GLOBAL_STYLE_TRIGGER_LABELS: Readonly<Record<GlobalStyleTriggerReason, string>> = {
  global_stylesheet: "global stylesheet",
  tailwind_config: "Tailwind config",
  postcss_config: "PostCSS config",
  design_tokens: "design tokens",
  index_html: "index.html",
  angular_workspace: "angular.json"
};

const TAILWIND_CONFIG = new RegExp(GLOBAL_STYLE_TRIGGER_PATTERNS.tailwindConfig);
const POSTCSS_CONFIG = GLOBAL_STYLE_TRIGGER_PATTERNS.postcssConfig.map((pattern) => new RegExp(pattern));
const TOKEN_BASENAMES = GLOBAL_STYLE_TRIGGER_PATTERNS.tokenBasenames.map((pattern) => new RegExp(pattern));
const TOKEN_FOLDERS: ReadonlySet<string> = new Set(GLOBAL_STYLE_TRIGGER_PATTERNS.tokenFolders);
/** Files below a tokens folder that count: stylesheets and JSON, never scripts (16 §8.5.1). */
const TOKEN_FOLDER_FILE = /\.(css|scss|sass|less|json)$/;

/** "." / "" → ""; otherwise the normalized repo-relative folder without a trailing slash. */
function normalizeFolder(folder: string): string {
  const normalized = posix.normalize(folder.replace(/\\/g, "/")).replace(/\/+$/, "");
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

function join(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** The app root, the repository root and every folder between them (16 §8.5.1 "app-level folder"). */
export function appLevelFolders(appRoot: string): string[] {
  const root = normalizeFolder(appRoot);
  const folders = [""];
  if (root === "") {
    return folders;
  }
  const segments = root.split("/");
  for (let index = 1; index <= segments.length; index++) {
    folders.push(segments.slice(0, index).join("/"));
  }
  return folders;
}

function isInside(repoPath: string, folder: string): boolean {
  return folder === "" || repoPath.startsWith(`${folder}/`);
}

/** The first matching reason of one changed path (table order of 16 §8.5.1), or null. */
export function triggerReasonOf(
  repoPath: string,
  input: Omit<GlobalStyleTriggerInput, "changedFiles">
): GlobalStyleTriggerReason | null {
  const file = repoPath.replace(/\\/g, "/");
  const appRoot = normalizeFolder(input.appRoot);
  const folder = normalizeFolder(posix.dirname(file));
  const basename = posix.basename(file);
  const appFolders = appLevelFolders(appRoot);

  if (input.globalStylePaths.includes(`/${file}`) || input.globalStyleChanges.includes(file)) {
    return "global_stylesheet";
  }
  if (appFolders.includes(folder) && TAILWIND_CONFIG.test(basename)) {
    return "tailwind_config";
  }
  if (appFolders.includes(folder) && POSTCSS_CONFIG.some((pattern) => pattern.test(basename))) {
    return "postcss_config";
  }
  if (isInside(file, appRoot)) {
    const relative = appRoot === "" ? file : file.slice(appRoot.length + 1);
    const folders = relative.split("/").slice(0, -1);
    if (
      TOKEN_BASENAMES.some((pattern) => pattern.test(basename)) ||
      (TOKEN_FOLDER_FILE.test(basename) && folders.some((segment) => TOKEN_FOLDERS.has(segment)))
    ) {
      return "design_tokens";
    }
  }
  if (input.framework === "react_vite") {
    const viteRoot = input.viteConfigPath === null ? appRoot : normalizeFolder(posix.dirname(input.viteConfigPath));
    if (file === join(viteRoot, "index.html")) {
      return "index_html";
    }
  } else {
    if (file === join(appRoot, "src/index.html") || file === join(appRoot, "index.html")) {
      return "index_html";
    }
    if (file === join(appRoot, "angular.json")) {
      return "angular_workspace";
    }
  }
  return null;
}

/**
 * Every changed path (A, M, D or R; both paths of a rename) that triggers the whole-library re-check (D7), one
 * trigger per path, sorted by path. [] = no re-check.
 */
export function detectGlobalStyleTriggers(input: GlobalStyleTriggerInput): GlobalStyleTrigger[] {
  const paths = new Set<string>();
  for (const change of input.changedFiles) {
    paths.add(change.path);
    if (change.status === "R" && change.previousPath !== undefined) {
      paths.add(change.previousPath);
    }
  }
  const triggers: GlobalStyleTrigger[] = [];
  for (const changed of paths) {
    const reason = triggerReasonOf(changed, input);
    if (reason !== null) {
      triggers.push({ path: changed, reason });
    }
  }
  return triggers.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
