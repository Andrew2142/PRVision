/**
 * Angular workspace target reading and harness build options (15 §5.7.6). PURE: no I/O.
 *
 * The options of the in-memory `prvision-harness` project are cloned from the app project's build target (with
 * the configured configuration merged over its options), stripped of server/deployment options and pointed at the
 * harness entry, index, tsconfig and output folder. Module mocks become `fileReplacements` of repository files.
 */
import path from "node:path";
import { ANGULAR_SUPPORTED_BUILDERS, HARNESS_DIR_NAME } from "../../../../../config-consts";
import { parseAngularWorkspace } from "../../../../repositories/angular-workspace-reader";
import { isRecord, type UnknownRecord } from "../render-types";

/** The build target of one Angular project, as written in angular.json (supported builder). */
export interface AngularHarnessTarget {
  builder: string;
  options: UnknownRecord;
  configurations: Record<string, UnknownRecord>;
}

/** The parts of an angular.json project the render engine needs. */
export interface AngularProjectInfo {
  name: string;
  root: string;
  build: AngularHarnessTarget;
}

/** angular.json could not be used for a side (the message is user-facing). */
export class AngularWorkspaceError extends Error {
  override readonly name = "AngularWorkspaceError";
}

/** A `{ replace, with }` entry of the builder's `fileReplacements` option (workspace-relative paths). */
export interface AngularFileReplacement {
  replace: string;
  with: string;
}

export interface HarnessBuildOptionsInput {
  target: AngularHarnessTarget;
  /** Configuration merged over the target options; null = base options only. */
  configuration: string | null;
  /** `dist/<buildKey>` under the harness folder. */
  buildKey: string;
  /** Accepted mocks of this build, as file replacements (workspace-relative `replace`, harness-relative `with`). */
  mockReplacements: readonly AngularFileReplacement[];
  /** Absolute persistent cache dir (`<dataDir>/cache/angular/<repositoryId>`). */
  cacheDir: string;
}

export interface HarnessBuildOptions {
  builderName: string;
  options: UnknownRecord;
  projectExtensions: UnknownRecord;
}

/** Options that would build a server, deploy, localize or fail the build on budgets (15 §5.7.6 step 2). */
export const STRIPPED_BUILD_OPTIONS = [
  "server",
  "ssr",
  "prerender",
  "appShell",
  "serviceWorker",
  "budgets",
  "localize",
  "i18nMissingTranslation",
  "outputMode",
  "security",
  "statsJson",
  "subresourceIntegrity",
  "deployUrl",
  "webWorkerTsConfig"
] as const;

const BROWSER_ESBUILD = "@angular-devkit/build-angular:browser-esbuild";

/** True for the builders PRVision can drive (00 §15, 15 §2). */
export function isSupportedAngularBuilder(builder: string): boolean {
  return (ANGULAR_SUPPORTED_BUILDERS as readonly string[]).includes(builder);
}

function harnessPath(...segments: string[]): string {
  return path.posix.join(HARNESS_DIR_NAME, ...segments);
}

/**
 * Parses angular.json text (JSONC tolerated, through 15a's `parseAngularWorkspace`) and returns one project's
 * build target.
 *
 * @throws AngularWorkspaceError when the file cannot be parsed, the project or its build target is missing, or the
 *   builder is not supported.
 */
export function readAngularProject(angularJsonText: string, projectName: string): AngularProjectInfo {
  const parsed = parseAngularWorkspace(angularJsonText);
  if (!parsed.ok) {
    throw new AngularWorkspaceError(`angular.json could not be read: ${parsed.reason}`);
  }
  const project = parsed.projects.find((entry) => entry.name === projectName);
  if (project === undefined) {
    throw new AngularWorkspaceError(`Project ${projectName} not found in angular.json`);
  }
  const target = project.buildTarget;
  if (target === null || target.builder === null) {
    throw new AngularWorkspaceError(`Project ${projectName} has no build target in angular.json`);
  }
  if (!isSupportedAngularBuilder(target.builder)) {
    throw new AngularWorkspaceError(
      `The build target of ${projectName} uses ${target.builder}, which is not supported`
    );
  }
  return {
    name: projectName,
    root: project.root,
    build: { builder: target.builder, options: target.options, configurations: target.configurations }
  };
}

/** Target options with the configuration merged over them (15 §5.7.6 step 1); unknown configuration → base. */
export function mergedTargetOptions(target: AngularHarnessTarget, configuration: string | null): UnknownRecord {
  const overlay = configuration === null ? undefined : target.configurations[configuration];
  return { ...target.options, ...(overlay ?? {}) };
}

/** Normalized workspace-relative POSIX path (no leading "./"). */
export function normalizeWorkspacePath(value: string): string {
  return path.posix.normalize(value.split("\\").join("/")).replace(/^\.\//, "");
}

function readReplacement(entry: unknown): AngularFileReplacement | null {
  if (!isRecord(entry)) {
    return null;
  }
  const replace = typeof entry.replace === "string" ? entry.replace : typeof entry.src === "string" ? entry.src : null;
  const withPath =
    typeof entry.with === "string" ? entry.with : typeof entry.replaceWith === "string" ? entry.replaceWith : null;
  return replace !== null && withPath !== null ? { replace, with: withPath } : null;
}

/**
 * Builds the options of the in-memory harness project (15 §5.7.6).
 *
 * @param input - Target, configuration, build key, mock replacements and cache dir.
 * @returns Builder name, options and the project extensions (cache settings).
 */
export function buildHarnessBuildOptions(input: HarnessBuildOptionsInput): HarnessBuildOptions {
  const { target } = input;
  const stripped: ReadonlySet<string> = new Set(STRIPPED_BUILD_OPTIONS);
  const options: UnknownRecord = Object.fromEntries(
    Object.entries(mergedTargetOptions(target, input.configuration)).filter(([key]) => !stripped.has(key))
  );
  const isBrowserEsbuild = target.builder === BROWSER_ESBUILD;
  const outputBase = harnessPath("dist", input.buildKey);
  if (isBrowserEsbuild) {
    delete options.browser;
    options.main = harnessPath("main.ts");
    options.outputPath = outputBase;
  } else {
    delete options.main;
    options.browser = harnessPath("main.ts");
    options.outputPath = { base: outputBase, browser: "" };
  }
  Object.assign(options, {
    index: harnessPath("index.html"),
    tsConfig: harnessPath("tsconfig.json"),
    baseHref: "/",
    outputHashing: "none",
    optimization: false,
    extractLicenses: false,
    namedChunks: true,
    sourceMap: { scripts: true, styles: false, vendor: false, hidden: false },
    progress: false,
    deleteOutputPath: true,
    watch: false,
    aot: true,
    crossOrigin: "none"
  });
  const mockTargets = new Set(input.mockReplacements.map((mock) => normalizeWorkspacePath(mock.replace)));
  const configured: unknown[] = Array.isArray(options.fileReplacements) ? (options.fileReplacements as unknown[]) : [];
  const kept = configured.filter((entry) => {
    const replacement = readReplacement(entry);
    return replacement === null || !mockTargets.has(normalizeWorkspacePath(replacement.replace));
  });
  const replacements = [...kept, ...input.mockReplacements.map((mock) => ({ replace: mock.replace, with: mock.with }))];
  if (replacements.length > 0 || "fileReplacements" in options) {
    options.fileReplacements = replacements;
  }
  return {
    builderName: target.builder,
    options,
    projectExtensions: {
      projectType: "application",
      cli: { cache: { enabled: true, environment: "all", path: input.cacheDir } }
    }
  };
}

/** The `index` option of a target as a workspace-relative path (string or `{ input }`), or null. */
export function indexInputOf(options: UnknownRecord): string | null {
  const index = options.index;
  if (typeof index === "string") {
    return index;
  }
  return isRecord(index) && typeof index.input === "string" ? index.input : null;
}

/** The `polyfills` option as a list. */
export function polyfillsOf(options: UnknownRecord): string[] {
  const polyfills = options.polyfills;
  if (typeof polyfills === "string") {
    return [polyfills];
  }
  return Array.isArray(polyfills) ? polyfills.filter((entry): entry is string => typeof entry === "string") : [];
}

/** True when the polyfills load zone.js (`zone.js` or `zone.js/...`). */
export function usesZone(options: UnknownRecord): boolean {
  return polyfillsOf(options).some((entry) => entry === "zone.js" || entry.startsWith("zone.js/"));
}

/** Workspace-relative global style and polyfill files of a target (side-wide error attribution). */
export function globalInputFiles(options: UnknownRecord): string[] {
  const files: string[] = [];
  const styles: unknown = options.styles;
  for (const entry of Array.isArray(styles) ? styles : []) {
    const input =
      typeof entry === "string" ? entry : isRecord(entry) && typeof entry.input === "string" ? entry.input : null;
    if (input !== null) {
      files.push(normalizeWorkspacePath(input));
    }
  }
  for (const entry of polyfillsOf(options)) {
    // Repository files only ("src/polyfills.ts"); bare package entries such as "zone.js" are not files here.
    if (/\.[cm]?[jt]s$/.test(entry) && (entry.startsWith(".") || entry.includes("/"))) {
      files.push(normalizeWorkspacePath(entry));
    }
  }
  return files;
}
