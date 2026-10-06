import path from "node:path";
import ts from "typescript";
import { ANGULAR_SUPPORTED_BUILDERS, MAX_GLOBAL_STYLES } from "../../config-consts";
import { normalizeRepoRelativePath } from "../../utilities";

/** The build target of one angular.json project (`architect.build`, else `targets.build`). */
export interface AngularBuildTarget {
  builder: string | null;
  options: Record<string, unknown>;
  configurations: Record<string, Record<string, unknown>>;
}

/** One project of an angular.json workspace. */
export interface AngularWorkspaceProject {
  name: string;
  projectType: string | null;
  /** Project root relative to the workspace folder ("" for the workspace root). */
  root: string;
  buildTarget: AngularBuildTarget | null;
}

export type AngularWorkspaceParseResult =
  { ok: true; projects: AngularWorkspaceProject[] } | { ok: false; reason: string };

/** Whether PRVision can drive a project's build target (15 §5.4.3 step 3). */
export type AngularBuilderSupport = { supported: true } | { supported: false; reason: string };

/** Repo-relative paths PRVision derives from a build target (15 §5.4.4 step 3.4). */
export interface AngularBuildPaths {
  tsconfigPath: string | null;
  entryFilePath: string | null;
  globalStylePaths: string[];
}

const WEBPACK_BROWSER_BUILDER = "@angular-devkit/build-angular:browser";
const WORKSPACE_FILE_NAME = "angular.json";
const NODE_MODULES_PREFIX = "node_modules/";
/** TS diagnostic "The root value of a 'tsconfig.json' file must be an object." */
const TS_ROOT_NOT_OBJECT = 5092;

/**
 * Parses angular.json text (comments and trailing commas allowed, like the Angular CLI). Never throws.
 *
 * @param text - angular.json contents.
 */
export function parseAngularWorkspace(text: string): AngularWorkspaceParseResult {
  const parsed = ts.parseConfigFileTextToJson(WORKSPACE_FILE_NAME, text);
  if (parsed.error !== undefined) {
    // TS words this diagnostic for tsconfig.json; say it in angular.json terms.
    return parsed.error.code === TS_ROOT_NOT_OBJECT
      ? { ok: false, reason: "the file is not a JSON object" }
      : { ok: false, reason: ts.flattenDiagnosticMessageText(parsed.error.messageText, " ") };
  }
  const config: unknown = parsed.config;
  if (!isPlainObject(config)) {
    return { ok: false, reason: "the file is not a JSON object" };
  }
  const projects = config.projects;
  if (!isPlainObject(projects)) {
    return { ok: false, reason: 'no "projects" object' };
  }
  const result: AngularWorkspaceProject[] = [];
  for (const [name, value] of Object.entries(projects)) {
    if (!isPlainObject(value)) {
      continue;
    }
    result.push({
      name,
      projectType: typeof value.projectType === "string" ? value.projectType : null,
      root: typeof value.root === "string" ? value.root : "",
      buildTarget: readBuildTarget(value)
    });
  }
  return { ok: true, projects: result };
}

/** Projects with `projectType: "application"`, in file order. */
export function listApplicationProjects(projects: readonly AngularWorkspaceProject[]): AngularWorkspaceProject[] {
  return projects.filter((project) => project.projectType === "application");
}

/**
 * Builder support with the user-facing reason of 15 §5.4.3 step 3.
 *
 * @param target - The project's build target, or null when it has none.
 */
export function classifyBuilder(target: AngularBuildTarget | null): AngularBuilderSupport {
  const builder = target?.builder ?? null;
  if (builder !== null && (ANGULAR_SUPPORTED_BUILDERS as readonly string[]).includes(builder)) {
    return { supported: true };
  }
  if (builder === WEBPACK_BROWSER_BUILDER) {
    return {
      supported: false,
      reason:
        "Uses the webpack builder (@angular-devkit/build-angular:browser). PRVision needs the application builder (`ng update @angular/cli --name use-application-builder`)."
    };
  }
  if (target === null) {
    return { supported: false, reason: "The project has no build target, which PRVision needs." };
  }
  return {
    supported: false,
    reason: `Build target uses ${builder ?? "no builder"}, which PRVision does not support.`
  };
}

/** npm package that provides a builder: "@angular/build:application" → "@angular/build". */
export function builderPackageOf(builder: string): string {
  const colon = builder.indexOf(":");
  return colon === -1 ? builder : builder.slice(0, colon);
}

/**
 * tsconfig, entry and global styles of a build target as repository paths (15 §5.4.4 step 3.4). Angular resolves
 * option paths against the workspace folder `appRoot`. Styles become import specifiers (00 §14.3):
 * `node_modules/x/y.css` → `x/y.css`, others `/<appRoot>/<entry>`; `inject: false` entries are skipped. Paths that
 * leave the repository are dropped.
 *
 * @param appRoot - Repo-relative workspace folder ("." = repository root).
 * @param options - The build target's base options.
 */
export function resolveBuildPaths(appRoot: string, options: Record<string, unknown>): AngularBuildPaths {
  const tsConfig = typeof options.tsConfig === "string" ? options.tsConfig : null;
  const browser = typeof options.browser === "string" ? options.browser : null;
  const main = typeof options.main === "string" ? options.main : null;
  const entry = browser ?? main;
  return {
    tsconfigPath: tsConfig === null ? null : joinRepoPath(appRoot, tsConfig),
    entryFilePath: entry === null ? null : joinRepoPath(appRoot, entry),
    globalStylePaths: resolveGlobalStyles(appRoot, options.styles)
  };
}

/**
 * Global style specifiers from a build target's `styles` option (strings or `{ input, inject }` objects).
 *
 * @param appRoot - Repo-relative workspace folder.
 * @param styles - The raw `styles` option.
 */
export function resolveGlobalStyles(appRoot: string, styles: unknown): string[] {
  if (!Array.isArray(styles)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of styles as unknown[]) {
    const input = styleInput(entry);
    if (input === null) {
      continue;
    }
    const posix = input.replace(/\\/g, "/").replace(/^\.\//, "");
    if (posix.startsWith(NODE_MODULES_PREFIX)) {
      const bare = posix.slice(NODE_MODULES_PREFIX.length);
      if (bare !== "" && !bare.split("/").includes("..")) {
        results.push(bare);
      }
    } else {
      const repoPath = joinRepoPath(appRoot, posix);
      if (repoPath !== null) {
        results.push(`/${repoPath}`);
      }
    }
    if (results.length >= MAX_GLOBAL_STYLES) {
      break;
    }
  }
  return [...new Set(results)];
}

/** Whether `zone.js` is among the build target's polyfills (string or array). */
export function usesZoneJs(options: Record<string, unknown>): boolean {
  const polyfills = options.polyfills;
  const list = typeof polyfills === "string" ? [polyfills] : Array.isArray(polyfills) ? (polyfills as unknown[]) : [];
  return list.some((entry) => typeof entry === "string" && /^zone\.js(\/|$)/.test(entry));
}

/**
 * Joins a workspace-relative path onto the app root as a normalized repo-relative POSIX path, or null when the
 * result is empty or leaves the repository.
 */
export function joinRepoPath(appRoot: string, relative: string): string | null {
  const joined = path.posix.normalize(path.posix.join(appRoot, relative.replace(/\\/g, "/")));
  try {
    return normalizeRepoRelativePath(joined);
  } catch {
    return null;
  }
}

/** Object view of the functions above (15 §4.1 names this module `AngularWorkspaceReader`). */
export const AngularWorkspaceReader = {
  parse: parseAngularWorkspace,
  applicationProjects: listApplicationProjects,
  classifyBuilder,
  builderPackageOf,
  resolveBuildPaths,
  usesZoneJs
} as const;

function readBuildTarget(project: Record<string, unknown>): AngularBuildTarget | null {
  const targets = isPlainObject(project.architect)
    ? project.architect
    : isPlainObject(project.targets)
      ? project.targets
      : null;
  const build = targets?.build;
  if (!isPlainObject(build)) {
    return null;
  }
  const configurations: Record<string, Record<string, unknown>> = {};
  if (isPlainObject(build.configurations)) {
    for (const [name, value] of Object.entries(build.configurations)) {
      if (isPlainObject(value)) {
        configurations[name] = value;
      }
    }
  }
  return {
    builder: typeof build.builder === "string" ? build.builder : null,
    options: isPlainObject(build.options) ? build.options : {},
    configurations
  };
}

function styleInput(entry: unknown): string | null {
  if (typeof entry === "string") {
    return entry.trim() === "" ? null : entry.trim();
  }
  if (isPlainObject(entry) && typeof entry.input === "string" && entry.inject !== false) {
    return entry.input.trim() === "" ? null : entry.input.trim();
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
