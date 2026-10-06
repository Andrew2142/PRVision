import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  ANGULAR_MAX_TESTED_MAJOR,
  ANGULAR_MIN_MAJOR,
  APP_DISCOVERY_MAX_CONFIGS,
  DETECTION_MAX_FILE_BYTES,
  FIXTURES_DIR_NAME,
  MAX_GLOBAL_STYLES,
  MIN_VITE_MAJOR
} from "../../config-consts";
import { PackageManager, RepositoryFramework } from "../../enums";
import {
  ArtifactStore,
  GitClient,
  GitCommandError,
  isPathInside,
  normalizeRepoRelativePath,
  parseGithubRemoteUrl
} from "../../utilities";
import {
  builderPackageOf,
  classifyBuilder,
  listApplicationProjects,
  parseAngularWorkspace,
  resolveBuildPaths,
  usesZoneJs,
  type AngularWorkspaceProject
} from "./angular-workspace-reader";

/** Everything detection learned about a registrable project (06 §5.4, 15 §5.4.4). */
export interface DetectedProject {
  /** realpath of the git toplevel (== registered localPath). */
  rootPath: string;
  /** package.json name, else folder basename; "<repo> · <project>" for Angular. */
  suggestedName: string;
  githubOwner: string | null;
  githubRepo: string | null;
  /** "upstream" | "origin" | null (not persisted). */
  githubRemoteName: string | null;
  defaultBranch: string;
  framework: RepositoryFramework;
  packageManager: PackageManager;
  /** Repo-relative POSIX folder of the app; "." = repository root (always "." for React). */
  appRoot: string;
  /** Project key in angular.json (Angular only). */
  angularProject: string | null;
  /** "development" when the build target has it, else null (Angular only). */
  angularBuildConfiguration: string | null;
  /** Repo-relative POSIX paths or null. */
  viteConfigPath: string | null;
  tsconfigPath: string | null;
  entryFilePath: string | null;
  /** Import specifiers (06 §5.1): "/src/index.css" for repo files, bare names for packages. */
  globalStylePaths: string[];
  /** Non-fatal findings. */
  warnings: string[];
}

export interface DetectionFailure {
  status: 400;
  errorReason: "validation_failed" | "not_git_repo" | "unsupported_framework" | "missing_node_modules";
  message: string;
}

export type DetectionResult = { ok: true; project: DetectedProject } | { ok: false; failure: DetectionFailure };

/** Which app of a repository to register (15 §5.4.4). */
export interface AppSelection {
  appRoot?: string;
  angularProject?: string;
}

/** One registrable (or listed but unsupported) app of a repository (15 §5.4.3). */
export interface AppCandidate {
  /** "." or repo-relative folder. */
  appRoot: string;
  framework: RepositoryFramework;
  angularProject: string | null;
  /** "<repo basename> · <project>" for Angular, package name for React. */
  suggestedName: string;
  supported: boolean;
  /** Why unsupported, user-facing. */
  reason: string | null;
}

export interface AppDiscovery {
  /** realpath of the git toplevel. */
  rootPath: string;
  /** App-root hint when a sub-folder was entered (15 §5.4.2). */
  hint: string | null;
  /** Sorted: hint match first, then supported, then appRoot, then project. */
  apps: AppCandidate[];
  /** Non-fatal findings (e.g. the config cap). */
  warnings: string[];
}

export type AppDiscoveryResult = { ok: true; discovery: AppDiscovery } | { ok: false; failure: DetectionFailure };

export interface ProjectDetectionDependencies {
  git: Pick<
    GitClient,
    "topLevel" | "revParse" | "remoteUrl" | "symbolicRefDefault" | "listBranches" | "currentBranch" | "lsFiles"
  >;
  /** new ArtifactStore().dataDir */
  dataDir: string;
}

/** Subset of package.json detection reads (anything else is treated as absent). */
export interface PackageJsonShape {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

/** Result of one confined repository file read. */
type FileRead = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "too_large" };

/** A candidate plus what detection needs to finish it (never leaves this module). */
interface DiscoveredApp extends AppCandidate {
  /** React at the root: the full 06 detection result, computed once during discovery. */
  react?: DetectionResult;
  /** Angular: the workspace project the candidate came from. */
  angular?: AngularWorkspaceProject;
}

type RootResolution = { ok: true; root: string; hint: string | null } | { ok: false; failure: DetectionFailure };

const VITE_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts"
] as const;
const TSCONFIG_FILES = ["tsconfig.app.json", "tsconfig.json"] as const;
const ENTRY_CONVENTIONS = [
  "src/main.tsx",
  "src/main.jsx",
  "src/index.tsx",
  "src/index.jsx",
  "src/main.ts",
  "src/main.js",
  "src/index.ts",
  "src/index.js"
] as const;
const WORKSPACE_MARKERS = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"] as const;
const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json", "bun.lockb", "bun.lock"];
const REQUIRED_PACKAGES = ["vite", "react", "react-dom"] as const;
const REMOTE_PREFERENCE = ["upstream", "origin"] as const;
const CONVENTIONAL_DEFAULT_BRANCHES = ["main", "master", "develop", "trunk"] as const;
const PACKAGE_NAME_MAX_LENGTH = 200;

/** Discovery pathspecs (15 §5.4.3 step 2). */
const APP_CONFIG_PATHSPECS = ["angular.json", ":(glob)**/angular.json", "vite.config.*", ":(glob)**/vite.config.*"];
const APP_CONFIG_MAX_SEGMENTS = 6;
const SELECTION_LIST_MAX = 10;
const ANGULAR_DEVELOPMENT_CONFIGURATION = "development";
const ANGULAR_ARCHITECT_PACKAGE = "@angular-devkit/architect";
const TAILWIND_CONFIG_FILES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts"
];
/** PostCSS configs the Angular application builder does not read (it only reads postcss.config.json / .postcssrc.json). */
const NON_JSON_POSTCSS_CONFIGS = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.ts",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.mjs",
  ".postcssrc.yaml",
  ".postcssrc.yml"
];

function defaultDetectionDependencies(): ProjectDetectionDependencies {
  return { git: new GitClient(), dataDir: new ArtifactStore().dataDir };
}

const failure = (errorReason: DetectionFailure["errorReason"], message: string): DetectionFailure => ({
  status: 400,
  errorReason,
  message
});

const fail = (errorReason: DetectionFailure["errorReason"], message: string): DetectionResult => ({
  ok: false,
  failure: failure(errorReason, message)
});

/**
 * Decides whether a local folder holds a registrable app and extracts what the render pipeline needs: Vite + React
 * at the repository root (06 §5.4) or an Angular application project anywhere in the repository (15 §5.4). Never
 * executes repository code: only bounded file reads (confined to the repository root) and read-only git commands.
 */
export class ProjectDetectionService {
  constructor(private readonly deps: ProjectDetectionDependencies = defaultDetectionDependencies()) {}

  /**
   * Lists the apps of the repository that contains `inputPath` (15 §5.4.3).
   *
   * @param inputPath - Absolute folder path (already "~"-expanded by the DTO); a sub-folder becomes the hint.
   */
  async discoverApps(inputPath: string): Promise<AppDiscoveryResult> {
    const resolved = await this.resolveRoot(inputPath);
    if (!resolved.ok) {
      return resolved;
    }
    const { apps, warnings } = await this.discoverAt(resolved.root, resolved.hint);
    if (apps.length === 0) {
      return {
        ok: false,
        failure: failure(
          "unsupported_framework",
          "No Angular workspace (angular.json) or Vite + React app was found in this repository."
        )
      };
    }
    return {
      ok: true,
      discovery: { rootPath: resolved.root, hint: resolved.hint, apps: apps.map(toPublicCandidate), warnings }
    };
  }

  /**
   * Detects one app; the first failure is returned. Without `selection`, the app is chosen from the hint or as
   * the only supported app (15 §5.4.4 step 1); a repository without any Angular workspace runs 06's React
   * detection unchanged.
   *
   * @param inputPath - Absolute folder path (already "~"-expanded by the DTO).
   * @param selection - The app to register (create with appRoot/angularProject, redetect with the stored row).
   */
  async detect(inputPath: string, selection?: AppSelection): Promise<DetectionResult> {
    const resolved = await this.resolveRoot(inputPath);
    if (!resolved.ok) {
      return resolved;
    }
    const { root, hint } = resolved;
    const { apps } = await this.discoverAt(root, hint);

    const chosen = selection === undefined ? chooseWithoutSelection(apps, hint) : chooseSelected(apps, selection);
    if ("failure" in chosen) {
      return { ok: false, failure: chosen.failure };
    }
    if (chosen.app === null) {
      // Nothing to choose from (or a React root selection that found no candidate): 06's detection reports why.
      return this.detectReactAt(root);
    }
    const app = chosen.app;
    if (app.framework === RepositoryFramework.REACT_VITE) {
      if (app.react !== undefined) {
        return app.react;
      }
      return fail("unsupported_framework", app.reason ?? "React apps in sub-folders are not supported yet.");
    }
    if (!app.supported || app.angular === undefined) {
      return fail("unsupported_framework", app.reason ?? "This Angular project is not supported.");
    }
    return this.detectAngularAt(root, app, app.angular);
  }

  /**
   * Steps 1–2 of 06 §5.4 with 15 §5.4.2: resolve the folder, refuse the data dir, find the git toplevel (a
   * sub-folder becomes the app-root hint) and require at least one commit.
   */
  private async resolveRoot(inputPath: string): Promise<RootResolution> {
    // Step 1 — resolve the folder.
    const resolved = path.resolve(inputPath);
    const folderStat = await statOrNull(resolved);
    if (!folderStat) {
      return { ok: false, failure: failure("validation_failed", `Folder does not exist: ${resolved}`) };
    }
    if (!folderStat.isDirectory()) {
      return { ok: false, failure: failure("validation_failed", `Not a folder: ${resolved}`) };
    }
    const rootCandidate = await fs.realpath(resolved);
    const realDataDir = await realpathOrSelf(this.deps.dataDir);
    const dataDirFailure = dataDirCheck(realDataDir, rootCandidate);
    if (dataDirFailure !== null) {
      return { ok: false, failure: dataDirFailure };
    }

    // Step 2 — git toplevel (a sub-folder registers its toplevel with an app-root hint) and at least one commit.
    let toplevel: string;
    try {
      toplevel = await this.deps.git.topLevel(rootCandidate);
    } catch (error: unknown) {
      if (isGitFailure(error)) {
        return { ok: false, failure: failure("not_git_repo", `Not a git repository: ${rootCandidate}`) };
      }
      throw error;
    }
    const realToplevel = await realpathOrSelf(toplevel);
    let hint: string | null = null;
    if (realToplevel !== rootCandidate) {
      if (!isPathInside(realToplevel, rootCandidate)) {
        return {
          ok: false,
          failure: failure(
            "not_git_repo",
            `This folder resolves to the git repository ${realToplevel}, which does not contain it. Register the repository root instead.`
          )
        };
      }
      const toplevelFailure = dataDirCheck(realDataDir, realToplevel);
      if (toplevelFailure !== null) {
        return { ok: false, failure: toplevelFailure };
      }
      hint = path.relative(realToplevel, rootCandidate).split(path.sep).join("/");
    }
    try {
      await this.deps.git.revParse(realToplevel, "HEAD");
    } catch (error: unknown) {
      if (!isGitFailure(error)) {
        throw error;
      }
      return error.code === "unknown_revision"
        ? { ok: false, failure: failure("not_git_repo", "The repository has no commits yet") }
        : { ok: false, failure: failure("not_git_repo", `Not a git repository: ${realToplevel}`) };
    }
    return { ok: true, root: realToplevel, hint };
  }

  /** 15 §5.4.3 steps 2–4: Angular application projects and Vite + React apps, sorted. */
  private async discoverAt(root: string, hint: string | null): Promise<{ apps: DiscoveredApp[]; warnings: string[] }> {
    const warnings: string[] = [];
    const configs = await this.listAppConfigs(root, warnings);
    const apps: DiscoveredApp[] = [];
    const repoName = path.basename(root);

    const reactDirs = new Set<string>();
    for (const configPath of configs) {
      const dir = posixDirname(configPath);
      if (path.posix.basename(configPath) === "angular.json") {
        apps.push(...(await discoverAngularWorkspace(root, configPath, dir, repoName)));
      } else {
        reactDirs.add(dir);
      }
    }
    // The root package counts even without a tracked vite.config (06 accepts Vite defaults).
    if (!reactDirs.has(".")) {
      reactDirs.add(".");
    }
    for (const dir of reactDirs) {
      const pkg = await readPackageJson(root, joinRel(dir, "package.json"));
      if (pkg === null || !declares(pkg, "react") || !declares(pkg, "vite")) {
        continue;
      }
      const react = await this.detectReactAt(root, dir);
      apps.push({
        appRoot: dir,
        framework: RepositoryFramework.REACT_VITE,
        angularProject: null,
        suggestedName: react.ok
          ? react.project.suggestedName
          : packageNameOr(pkg, dir === "." ? repoName : path.posix.basename(dir)),
        supported: react.ok,
        reason: react.ok ? null : react.failure.message,
        react
      });
    }
    apps.sort((a, b) => compareCandidates(a, b, hint));
    return { apps, warnings };
  }

  /** 15 §5.4.3 step 2: tracked angular.json / vite.config.* paths, filtered and capped. */
  private async listAppConfigs(root: string, warnings: string[]): Promise<string[]> {
    let tracked: string[];
    try {
      tracked = await this.deps.git.lsFiles(root, APP_CONFIG_PATHSPECS);
    } catch (error: unknown) {
      if (isGitFailure(error)) {
        return []; // GitClient already logged it; only the root React package is checked
      }
      throw error;
    }
    const configs = [...new Set(tracked)]
      .filter((file) => {
        const segments = file.split("/");
        const base = segments[segments.length - 1] ?? "";
        return (
          segments.length <= APP_CONFIG_MAX_SEGMENTS &&
          !segments.includes("node_modules") &&
          (base === "angular.json" || (VITE_CONFIG_FILES as readonly string[]).includes(base))
        );
      })
      .sort();
    if (configs.length > APP_DISCOVERY_MAX_CONFIGS) {
      warnings.push(
        `More than ${String(APP_DISCOVERY_MAX_CONFIGS)} app configs found; showing the first ${String(APP_DISCOVERY_MAX_CONFIGS)}.`
      );
      return configs.slice(0, APP_DISCOVERY_MAX_CONFIGS);
    }
    return configs;
  }

  /** Steps 3–14 of 06 §5.4 for the package at the repository root (React path, unchanged). */
  /**
   * 06 §5.4 steps 3–14 for a Vite + React app at `appRoot` ("." = repository root; a sub-folder is the app's own
   * package, e.g. a monorepo app). Returned paths are repo-relative; global styles are Vite URLs from the app root.
   */
  private async detectReactAt(root: string, appRoot = "."): Promise<DetectionResult> {
    const warnings: string[] = [];
    const inApp = (file: string): string => joinRel(appRoot, file);
    const where = appRoot === "." ? "the repository root" : appRoot;

    // Step 3 — package.json.
    const packageRead = await readRepoFile(root, inApp("package.json"));
    if (packageRead.kind === "missing") {
      return fail("unsupported_framework", `No package.json in ${where}`);
    }
    if (packageRead.kind === "too_large") {
      return fail("unsupported_framework", "package.json is larger than 1 MiB");
    }
    const pkg = parsePackageJson(packageRead.text);
    if (!pkg) {
      return fail("unsupported_framework", "package.json is not valid JSON");
    }
    const deps: Record<string, string> = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };

    // Step 4 — monorepo note (React only, 15 §11 item 10). A sub-folder app is its own package.
    const isWorkspaceRoot =
      appRoot === "." && (pkg.workspaces !== undefined || (await anyFileExists(root, WORKSPACE_MARKERS)));
    if (isWorkspaceRoot) {
      if (!Object.hasOwn(deps, "react") || !Object.hasOwn(deps, "vite")) {
        return fail(
          "unsupported_framework",
          "This looks like a monorepo root (workspaces). The prototype supports a single Vite + React package at the repository root."
        );
      }
      warnings.push("Workspace root detected; rendering uses the root package and the hoisted node_modules.");
    }

    // Step 5 — framework checks (Next.js first, for a precise message).
    if (Object.hasOwn(deps, "next")) {
      return fail(
        "unsupported_framework",
        "Next.js projects are not supported yet (PRVision renders Vite + React projects)"
      );
    }
    if (!Object.hasOwn(deps, "react") || !Object.hasOwn(deps, "react-dom")) {
      return fail("unsupported_framework", `React and react-dom must be dependencies of ${inApp("package.json")}`);
    }
    if (!Object.hasOwn(deps, "vite")) {
      return fail("unsupported_framework", "Vite was not found in package.json (dependencies or devDependencies)");
    }
    if (Object.hasOwn(deps, "@angular/core")) {
      warnings.push("Angular packages found; only React components are analysed");
    }

    // Step 6 — package manager (before node_modules, so messages name the right install command).
    const pm = detectPackageManager(pkg, await existingLockfiles(root, appRoot));
    warnings.push(...pm.warnings);
    const packageManager = pm.packageManager;

    // Step 7 — node_modules.
    const nodeModulesDir = path.join(root, appRoot, "node_modules");
    const nodeModulesStat = await statOrNull(nodeModulesDir);
    const hasNodeModules = nodeModulesStat?.isDirectory() === true;
    if (!hasNodeModules && (await anyFileExists(root, [".pnp.cjs", ".pnp.js"]))) {
      return fail(
        "missing_node_modules",
        "Yarn Plug'n'Play is not supported. Set `nodeLinker: node-modules` in .yarnrc.yml and run yarn install."
      );
    }
    if (!hasNodeModules) {
      return fail(
        "missing_node_modules",
        `node_modules not found. Run \`${packageManager} install\` in ${path.join(root, appRoot)} first.`
      );
    }
    const installedVersions: Partial<Record<(typeof REQUIRED_PACKAGES)[number], string | null>> = {};
    for (const packageName of REQUIRED_PACKAGES) {
      const installed = await readInstalledPackageVersion(nodeModulesDir, packageName);
      if (installed === undefined) {
        return fail(
          "missing_node_modules",
          `${packageName} is declared but not installed. Run \`${packageManager} install\`.`
        );
      }
      installedVersions[packageName] = installed;
    }
    const viteVersion = installedVersions.vite ?? null;
    const viteMajor = majorVersion(viteVersion);
    if (viteVersion !== null && viteMajor !== null && viteMajor < MIN_VITE_MAJOR) {
      return fail(
        "unsupported_framework",
        `Vite ${viteVersion} is not supported (need ${String(MIN_VITE_MAJOR)} or newer)`
      );
    }
    const reactMajor = majorVersion(installedVersions.react ?? null);
    if (reactMajor !== null && reactMajor < 18) {
      warnings.push("React <18 detected; the harness uses createRoot and may fail");
    }

    // Step 8 — Vite config (Vite's DEFAULT_CONFIG_FILES order; never evaluated).
    const viteConfigPath = await firstExisting(root, VITE_CONFIG_FILES.map(inApp));
    if (viteConfigPath === null) {
      warnings.push("No vite.config found; the render engine will use Vite defaults");
    }

    // Step 9 — tsconfig.
    const tsconfigPath = await firstExisting(root, TSCONFIG_FILES.map(inApp));

    // Step 10 — entry file from index.html, else convention.
    const entryFilePath = await this.findEntryFile(root, warnings, appRoot);

    // Step 11 — global styles from the entry file, as Vite URLs from the app root (the Vite root).
    const appPrefix = appRoot === "." ? null : `/${appRoot}/`;
    const globalStylePaths = (
      entryFilePath === null ? [] : await this.findGlobalStyles(root, entryFilePath, warnings)
    ).map((specifier) =>
      appPrefix !== null && specifier.startsWith(appPrefix) ? `/${specifier.slice(appPrefix.length)}` : specifier
    );

    // Steps 12–13 — GitHub remote and default branch.
    const remote = await this.resolveRemoteAndBranch(root, warnings);
    if (!remote.ok) {
      return remote;
    }

    // Step 14 — name.
    const suggestedName = packageNameOr(pkg, appRoot === "." ? path.basename(root) : path.posix.basename(appRoot));

    return {
      ok: true,
      project: {
        rootPath: root,
        suggestedName,
        ...remote.value,
        framework: RepositoryFramework.REACT_VITE,
        packageManager,
        appRoot,
        angularProject: null,
        angularBuildConfiguration: null,
        viteConfigPath,
        tsconfigPath,
        entryFilePath,
        globalStylePaths,
        warnings
      }
    };
  }

  /** 15 §5.4.4 step 3: an Angular application project inside the workspace folder `app.appRoot`. */
  private async detectAngularAt(
    root: string,
    app: DiscoveredApp,
    project: AngularWorkspaceProject
  ): Promise<DetectionResult> {
    const warnings: string[] = [];
    const appRoot = app.appRoot;
    const target = project.buildTarget;
    const builder = target?.builder ?? null;
    if (target === null || builder === null) {
      return fail("unsupported_framework", app.reason ?? "The project has no build target, which PRVision needs.");
    }

    // 3.1 — @angular/core declared by the app's package.json or the root one.
    const appPkg = await readPackageJson(root, joinRel(appRoot, "package.json"));
    const rootPkg = appRoot === "." ? appPkg : await readPackageJson(root, "package.json");
    if (
      !(appPkg !== null && declares(appPkg, "@angular/core")) &&
      !(rootPkg !== null && declares(rootPkg, "@angular/core"))
    ) {
      return fail("unsupported_framework", `@angular/core is not a dependency of ${joinRel(appRoot, "package.json")}`);
    }

    // 3.7 (first, so install messages name the right command) — package manager from the app folder, then the root.
    const appLockfiles = await existingLockfiles(root, appRoot);
    const pm = detectPackageManager(
      appPkg ?? rootPkg ?? {},
      appLockfiles.length > 0 || appRoot === "." ? appLockfiles : await existingLockfiles(root, ".")
    );
    warnings.push(...pm.warnings);
    const packageManager = pm.packageManager;

    // 3.2 — node_modules with @angular/core (the app's own, else the hoisted root one).
    let nodeModules: string | null = null;
    let coreVersion: string | null = null;
    for (const relDir of [...new Set([joinRel(appRoot, "node_modules"), "node_modules"])]) {
      const dir = path.join(root, relDir);
      const version = await readInstalledPackageVersion(dir, "@angular/core");
      if (version !== undefined) {
        nodeModules = dir;
        coreVersion = version;
        break;
      }
    }
    if (nodeModules === null) {
      return fail(
        "missing_node_modules",
        `node_modules not found for ${appRoot}. Run \`${packageManager} install\` in ${appRoot} first.`
      );
    }
    const coreMajor = majorVersion(coreVersion);
    if (coreVersion !== null && coreMajor !== null && coreMajor < ANGULAR_MIN_MAJOR) {
      return fail(
        "unsupported_framework",
        `Angular ${coreVersion} is not supported (need ${String(ANGULAR_MIN_MAJOR)} or newer)`
      );
    }
    if (coreVersion !== null && coreMajor !== null && coreMajor > ANGULAR_MAX_TESTED_MAJOR) {
      warnings.push(
        `Angular ${coreVersion} is newer than the tested range (${String(ANGULAR_MIN_MAJOR)}–${String(ANGULAR_MAX_TESTED_MAJOR)})`
      );
    }

    // 3.3 — the builder package and Architect.
    const builderPackage = builderPackageOf(builder);
    if ((await readInstalledPackageVersion(nodeModules, builderPackage)) === undefined) {
      return fail(
        "missing_node_modules",
        `${builderPackage} is not installed. Run \`${packageManager} install\` in ${appRoot}.`
      );
    }
    const nestedNodeModules = path.join(nodeModules, builderPackage, "node_modules");
    if (
      (await readInstalledPackageVersion(nodeModules, ANGULAR_ARCHITECT_PACKAGE)) === undefined &&
      (await readInstalledPackageVersion(nestedNodeModules, ANGULAR_ARCHITECT_PACKAGE)) === undefined
    ) {
      return fail(
        "missing_node_modules",
        `${ANGULAR_ARCHITECT_PACKAGE} is not installed. Run \`${packageManager} install\` in ${appRoot}.`
      );
    }

    // 3.4 — paths from the build target.
    const paths = resolveBuildPaths(appRoot, target.options);

    // 3.5 — build configuration.
    let angularBuildConfiguration: string | null = null;
    if (Object.hasOwn(target.configurations, ANGULAR_DEVELOPMENT_CONFIGURATION)) {
      angularBuildConfiguration = ANGULAR_DEVELOPMENT_CONFIGURATION;
    } else {
      warnings.push(
        "No development configuration; building with the target's base options (optimisation may be on and builds slower)."
      );
    }

    // 3.6 — informational warnings.
    if (!usesZoneJs(target.options)) {
      warnings.push("Zoneless app");
    }
    if (
      (await firstExisting(
        root,
        TAILWIND_CONFIG_FILES.map((file) => joinRel(appRoot, file))
      )) !== null
    ) {
      const tailwindMajor = majorVersion((await readInstalledPackageVersion(nodeModules, "tailwindcss")) ?? null);
      if (tailwindMajor !== null) {
        warnings.push(`Tailwind ${String(tailwindMajor)} detected`);
      }
    }
    if (
      (await firstExisting(
        root,
        NON_JSON_POSTCSS_CONFIGS.map((file) => joinRel(appRoot, file))
      )) !== null
    ) {
      warnings.push(
        "The Angular builder ignores postcss.config.js; it uses its built-in Tailwind integration or postcss.config.json."
      );
    }

    const remote = await this.resolveRemoteAndBranch(root, warnings);
    if (!remote.ok) {
      return remote;
    }

    return {
      ok: true,
      project: {
        rootPath: root,
        suggestedName: app.suggestedName,
        ...remote.value,
        framework: RepositoryFramework.ANGULAR,
        packageManager,
        appRoot,
        angularProject: project.name,
        angularBuildConfiguration,
        viteConfigPath: null,
        tsconfigPath: paths.tsconfigPath,
        entryFilePath: paths.entryFilePath,
        globalStylePaths: paths.globalStylePaths,
        warnings
      }
    };
  }

  /** Steps 12–13 of 06 §5.4: GitHub remote (upstream before origin) and the default branch (local only). */
  private async resolveRemoteAndBranch(
    root: string,
    warnings: string[]
  ): Promise<
    | {
        ok: true;
        value: Pick<DetectedProject, "githubOwner" | "githubRepo" | "githubRemoteName" | "defaultBranch">;
      }
    | { ok: false; failure: DetectionFailure }
  > {
    let github: { owner: string; repo: string; remoteName: string } | null = null;
    const existingRemotes: string[] = [];
    for (const remoteName of REMOTE_PREFERENCE) {
      const url = await this.remoteUrlOrNull(root, remoteName);
      if (url === null) {
        continue;
      }
      existingRemotes.push(remoteName);
      const parsed = parseGithubRemoteUrl(url);
      if (parsed) {
        github = { ...parsed, remoteName };
        break;
      }
      warnings.push(`Remote ${remoteName} is not on github.com; pull request features are disabled`);
    }

    const defaultBranch = await this.resolveDefaultBranch(root, github?.remoteName ?? null, existingRemotes, warnings);
    if (defaultBranch === null) {
      return {
        ok: false,
        failure: failure("not_git_repo", "Could not determine a default branch (no local branches)")
      };
    }
    return {
      ok: true,
      value: {
        githubOwner: github?.owner ?? null,
        githubRepo: github?.repo ?? null,
        githubRemoteName: github?.remoteName ?? null,
        defaultBranch
      }
    };
  }

  /** Step 10: index.html module script, then conventional entry files. */
  private async findEntryFile(root: string, warnings: string[], appRoot = "."): Promise<string | null> {
    const htmlPath = joinRel(appRoot, "index.html");
    const html = await readRepoFile(root, htmlPath);
    if (html.kind === "ok") {
      const src = findModuleScriptSrc(html.text);
      // "/src/main.tsx" is a Vite URL from the app root (the Vite root), not from the repository root.
      const resolved = src === null ? null : resolveScriptSrc(src.startsWith("/") ? `.${src}` : src, htmlPath);
      if (resolved !== null && (await repoFileExists(root, resolved))) {
        return resolved;
      }
    }
    const conventional = await firstExisting(
      root,
      ENTRY_CONVENTIONS.map((file) => joinRel(appRoot, file))
    );
    if (conventional !== null) {
      warnings.push(`Entry file inferred from convention (${conventional})`);
      return conventional;
    }
    warnings.push("No entry file found; global styles were not detected");
    return null;
  }

  /**
   * Step 11. extractGlobalStyleImports takes a synchronous fileExists; answers are resolved asynchronously and
   * the parse repeated until every path it asked about is known (normally two passes).
   */
  private async findGlobalStyles(root: string, entryFilePath: string, warnings: string[]): Promise<string[]> {
    const entry = await readRepoFile(root, entryFilePath);
    if (entry.kind === "too_large") {
      warnings.push(`Entry file ${entryFilePath} is larger than 1 MiB; global styles were not detected`);
      return [];
    }
    if (entry.kind === "missing") {
      return [];
    }
    const known = new Map<string, boolean>();
    for (;;) {
      const pending = new Set<string>();
      const styles = extractGlobalStyleImports(entry.text, entryFilePath, (repoRelativePath) => {
        const answer = known.get(repoRelativePath);
        if (answer === undefined) {
          pending.add(repoRelativePath);
          return true;
        }
        return answer;
      });
      if (pending.size === 0) {
        return styles;
      }
      for (const candidate of pending) {
        known.set(candidate, await repoFileExists(root, candidate));
      }
    }
  }

  private async remoteUrlOrNull(root: string, remoteName: string): Promise<string | null> {
    try {
      return await this.deps.git.remoteUrl(root, remoteName);
    } catch (error: unknown) {
      if (isGitFailure(error) && error.code !== "git_not_found") {
        return null; // GitClient already logged the failure; an unreadable remote means no PR support
      }
      throw error;
    }
  }

  /** Step 13: symbolic ref, conventional names, current branch, first branch. */
  private async resolveDefaultBranch(
    root: string,
    githubRemoteName: string | null,
    existingRemotes: readonly string[],
    warnings: string[]
  ): Promise<string | null> {
    const remoteForHead = githubRemoteName ?? "origin";
    const symbolic = await this.deps.git.symbolicRefDefault(root, remoteForHead);
    if (symbolic !== null) {
      return symbolic;
    }
    if (existingRemotes.length > 0) {
      const remote = githubRemoteName ?? existingRemotes[0] ?? "origin";
      warnings.push(
        `${remote}/HEAD is not set; run \`git remote set-head ${remote} --auto\` for an accurate default branch`
      );
    }
    const branches = await this.deps.git.listBranches(root);
    const conventional = CONVENTIONAL_DEFAULT_BRANCHES.find((name) => branches.includes(name));
    if (conventional !== undefined) {
      return conventional;
    }
    const current = await this.deps.git.currentBranch(root);
    if (current !== null) {
      return current;
    }
    return branches[0] ?? null;
  }
}

// ----- app discovery and selection (15 §5.4.3, §5.4.4 step 1) -----

/** Candidates of one angular.json: application projects, or one unsupported row when the file is unreadable. */
async function discoverAngularWorkspace(
  root: string,
  configPath: string,
  appRoot: string,
  repoName: string
): Promise<DiscoveredApp[]> {
  const unreadable = (reason: string): DiscoveredApp[] => [
    {
      appRoot,
      framework: RepositoryFramework.ANGULAR,
      angularProject: null,
      suggestedName: truncateName(`${repoName} · ${appRoot === "." ? "angular" : path.posix.basename(appRoot)}`),
      supported: false,
      reason: `angular.json could not be read: ${reason}`
    }
  ];
  const read = await readRepoFile(root, configPath);
  if (read.kind === "missing") {
    return unreadable("the file is missing or leaves the repository");
  }
  if (read.kind === "too_large") {
    return unreadable("it is larger than 1 MiB");
  }
  const parsed = parseAngularWorkspace(read.text);
  if (!parsed.ok) {
    return unreadable(parsed.reason);
  }
  return listApplicationProjects(parsed.projects).map((project) => {
    const support = classifyBuilder(project.buildTarget);
    return {
      appRoot,
      framework: RepositoryFramework.ANGULAR,
      angularProject: project.name,
      suggestedName: truncateName(`${repoName} · ${project.name}`),
      supported: support.supported,
      reason: support.supported ? null : support.reason,
      angular: project
    };
  });
}

type Choice = { app: DiscoveredApp | null } | { failure: DetectionFailure };

/** 15 §5.4.4 step 1 without a selection: the hint's only supported app, else the only supported app. */
function chooseWithoutSelection(apps: readonly DiscoveredApp[], hint: string | null): Choice {
  const supported = apps.filter((app) => app.supported);
  if (hint !== null) {
    const hinted = apps.filter((app) => app.appRoot === hint);
    const hintedSupported = hinted.filter((app) => app.supported);
    if (hintedSupported.length === 1) {
      return { app: hintedSupported[0] ?? null };
    }
    if (hintedSupported.length === 0 && hinted.length === 1) {
      return { app: hinted[0] ?? null }; // the folder the user pasted is unsupported: say why
    }
  }
  if (supported.length === 1) {
    return { app: supported[0] ?? null };
  }
  if (apps.length <= 1) {
    return { app: apps[0] ?? null }; // one unsupported app (its own failure) or none (06's React failure)
  }
  if (!apps.some((app) => app.framework === RepositoryFramework.ANGULAR) && supported.length === 0) {
    return { app: apps.find((app) => app.appRoot === ".") ?? null };
  }
  const listed = (supported.length > 0 ? supported : apps).slice(0, SELECTION_LIST_MAX).map(describeApp);
  return {
    failure: failure(
      "validation_failed",
      `This repository contains ${String(supported.length > 0 ? supported.length : apps.length)} apps. Choose one: ${listed.join(", ")}`
    )
  };
}

/** 15 §5.4.4 step 1 with a selection. A React root selection without a candidate falls through to 06's detection. */
function chooseSelected(apps: readonly DiscoveredApp[], selection: AppSelection): Choice {
  const rawRoot = selection.appRoot ?? ".";
  let appRoot: string;
  try {
    appRoot = rawRoot === "" || rawRoot === "." ? "." : normalizeRepoRelativePath(rawRoot);
  } catch {
    return { failure: failure("validation_failed", `No app found at ${rawRoot}`) };
  }
  const project = selection.angularProject;
  const atRoot = apps.filter((app) => app.appRoot === appRoot);
  // Without a project: a root that holds React and Angular means the React app (React rows store no project).
  const reactAtRoot = atRoot.filter((app) => app.framework === RepositoryFramework.REACT_VITE);
  const matches =
    project !== undefined
      ? atRoot.filter((app) => app.angularProject === project)
      : atRoot.length > 1 && reactAtRoot.length === 1
        ? reactAtRoot
        : atRoot;
  if (matches.length === 1) {
    return { app: matches[0] ?? null };
  }
  if (matches.length === 0 && appRoot === "." && project === undefined) {
    return { app: null };
  }
  if (
    matches.length === 0 &&
    project !== undefined &&
    atRoot.some((app) => app.framework === RepositoryFramework.ANGULAR)
  ) {
    return {
      failure: failure(
        "unsupported_framework",
        `Project ${project} no longer exists in ${joinRel(appRoot, "angular.json")}`
      )
    };
  }
  const suffix = project === undefined ? "" : ` (project ${project})`;
  return {
    failure: failure(
      "validation_failed",
      matches.length === 0
        ? `No app found at ${appRoot}${suffix}`
        : `${appRoot} contains ${String(matches.length)} apps. Choose one: ${matches.slice(0, SELECTION_LIST_MAX).map(describeApp).join(", ")}`
    )
  };
}

function describeApp(app: AppCandidate): string {
  return app.angularProject === null ? app.appRoot : `${app.appRoot} · ${app.angularProject}`;
}

function compareCandidates(a: AppCandidate, b: AppCandidate, hint: string | null): number {
  const hinted = (app: AppCandidate): number => (hint !== null && app.appRoot === hint ? 0 : 1);
  return (
    hinted(a) - hinted(b) ||
    Number(b.supported) - Number(a.supported) ||
    a.appRoot.localeCompare(b.appRoot) ||
    (a.angularProject ?? "").localeCompare(b.angularProject ?? "")
  );
}

function toPublicCandidate(app: DiscoveredApp): AppCandidate {
  return {
    appRoot: app.appRoot,
    framework: app.framework,
    angularProject: app.angularProject,
    suggestedName: app.suggestedName,
    supported: app.supported,
    reason: app.reason
  };
}

/** Refusals of 06 §5.4 steps 1.4/1.5 for one folder (15 §5.4.2 runs them for the input and its toplevel). */
function dataDirCheck(realDataDir: string, folder: string): DetectionFailure | null {
  if (isPathInside(realDataDir, folder) && !isFixtureRepoPath(realDataDir, folder)) {
    return failure("validation_failed", "Folders inside the PRVision data directory cannot be registered");
  }
  if (isPathInside(folder, realDataDir)) {
    return failure(
      "validation_failed",
      `This folder contains the PRVision data directory (${realDataDir}). Register the project folder itself, or set PRVISION_DATA_DIR outside it.`
    );
  }
  return null;
}

function posixDirname(repoPath: string): string {
  const dir = path.posix.dirname(repoPath);
  return dir === "" ? "." : dir;
}

/** `<dir>/<file>` as a repo-relative path ("." joins to the file itself). */
function joinRel(dir: string, file: string): string {
  return dir === "." ? file : `${dir}/${file}`;
}

function declares(pkg: PackageJsonShape, name: string): boolean {
  return (
    Object.hasOwn(pkg.dependencies ?? {}, name) ||
    Object.hasOwn(pkg.devDependencies ?? {}, name) ||
    Object.hasOwn(pkg.peerDependencies ?? {}, name)
  );
}

function packageNameOr(pkg: PackageJsonShape, fallback: string): string {
  return typeof pkg.name === "string" && pkg.name.trim().length > 0 && pkg.name.length <= PACKAGE_NAME_MAX_LENGTH
    ? pkg.name
    : fallback;
}

function truncateName(name: string): string {
  return name.length <= PACKAGE_NAME_MAX_LENGTH ? name : name.slice(0, PACKAGE_NAME_MAX_LENGTH);
}

async function readPackageJson(root: string, repoRelativePath: string): Promise<PackageJsonShape | null> {
  const read = await readRepoFile(root, repoRelativePath);
  return read.kind === "ok" ? parsePackageJson(read.text) : null;
}

/** Lockfile names that exist in `dir` (repo-relative folder). */
async function existingLockfiles(root: string, dir: string): Promise<string[]> {
  const existing: string[] = [];
  for (const lockfile of LOCKFILES) {
    if (await repoFileExists(root, joinRel(dir, lockfile))) {
      existing.push(lockfile);
    }
  }
  return existing;
}

// ----- pure helpers (exported for tests and later sheets) -----

/**
 * The `src` of the first `<script type="module" src="…">` in an HTML document (comments ignored, attribute order
 * and quoting free), or null. Absolute URLs (`https:`, `//cdn`) are skipped.
 *
 * @param html - index.html contents.
 */
export function findModuleScriptSrc(html: string): string | null {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const tagPattern = /<script\b([^>]*)>/gi;
  for (const tag of withoutComments.matchAll(tagPattern)) {
    const attributes = parseAttributes(tag[1] ?? "");
    const type = attributes.get("type");
    const src = attributes.get("src");
    if (type?.toLowerCase() !== "module" || src === undefined) {
      continue;
    }
    const trimmed = src.trim();
    if (trimmed === "" || /^[a-z]+:/i.test(trimmed) || trimmed.startsWith("//")) {
      continue;
    }
    return trimmed;
  }
  return null;
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of raw.matchAll(attributePattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name === "" || attributes.has(name)) {
      continue;
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/**
 * Resolves an index.html script src to a repo-relative path: query/hash stripped, "/x" from the root, "x" from
 * the directory of index.html. Null when it would leave the root.
 */
function resolveScriptSrc(src: string, htmlRepoPath: string): string | null {
  const bare = src.replace(/[?#].*$/, "");
  if (bare === "") {
    return null;
  }
  const joined = bare.startsWith("/")
    ? path.posix.normalize(bare.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(htmlRepoPath), bare));
  try {
    return normalizeRepoRelativePath(joined);
  } catch {
    return null; // escapes the root (../) or is empty
  }
}

const STYLE_EXT = /\.(css|scss|sass|less)$/i;
const CSS_MODULE = /\.module\.(css|scss|sass|less)$/i;

/**
 * Top-level side-effect style imports of the entry file (`import "./index.css";`), as import specifiers:
 * "/src/index.css" for repo files (must exist and stay inside the root), bare names for package stylesheets.
 * CSS modules, `?inline`/`?url` imports, named imports and dynamic imports are ignored. Tolerates syntax errors.
 *
 * @param sourceText - Entry file contents.
 * @param entryRepoPath - Repo-relative entry path, e.g. "src/main.tsx".
 * @param fileExists - Whether a repo-relative path exists inside the root.
 */
export function extractGlobalStyleImports(
  sourceText: string,
  entryRepoPath: string,
  fileExists: (repoRelativePath: string) => boolean
): string[] {
  const kind = /\.(tsx|jsx)$/i.test(entryRepoPath)
    ? ts.ScriptKind.TSX
    : /\.ts$/i.test(entryRepoPath)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const source = ts.createSourceFile(entryRepoPath, sourceText, ts.ScriptTarget.Latest, false, kind);
  const results: string[] = [];

  for (const statement of source.statements) {
    // Only top-level side-effect imports: `import "./index.css";`
    if (!ts.isImportDeclaration(statement) || statement.importClause !== undefined) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const raw = statement.moduleSpecifier.text;
    if (raw.includes("?")) {
      continue; // ?inline, ?url, ?raw are not global side effects
    }
    if (!STYLE_EXT.test(raw) && !isBarePackageStyle(raw)) {
      continue;
    }
    if (CSS_MODULE.test(raw)) {
      continue; // CSS modules are scoped, not global
    }

    if (raw.startsWith("./") || raw.startsWith("../")) {
      const repoRel = path.posix.normalize(path.posix.join(path.posix.dirname(entryRepoPath), raw));
      if (repoRel.startsWith("../") || !fileExists(repoRel)) {
        continue; // outside root or missing
      }
      results.push(`/${repoRel}`);
    } else if (raw.startsWith("/")) {
      const repoRel = path.posix.normalize(raw.slice(1));
      if (repoRel.startsWith("../") || !fileExists(repoRel)) {
        continue;
      }
      results.push(`/${repoRel}`);
    } else {
      results.push(raw); // bare package specifier, resolved by Vite at render time
    }
    if (results.length >= MAX_GLOBAL_STYLES) {
      break;
    }
  }
  return [...new Set(results)];
}

/** "@fontsource/inter" style imports have no extension but are CSS-only packages. */
function isBarePackageStyle(specifier: string): boolean {
  return /^@fontsource(-variable)?\//.test(specifier);
}

/**
 * Package manager from the corepack `packageManager` field, else lockfiles (pnpm > yarn > npm), else npm.
 * Bun lockfiles fall back to npm with a warning (PRVision never runs installs).
 *
 * @param pkg - Parsed package.json.
 * @param existingFiles - Root file names that exist (lockfiles are looked up here).
 */
export function detectPackageManager(
  pkg: Pick<PackageJsonShape, "packageManager">,
  existingFiles: readonly string[]
): { packageManager: PackageManager; warnings: string[] } {
  const has = (name: string): boolean => existingFiles.includes(name);
  const warnings: string[] = [];
  const lockfileCount = LOCKFILES.filter((name) => has(name)).length;

  let packageManager: PackageManager | null = null;
  const field = typeof pkg.packageManager === "string" ? pkg.packageManager.trim() : "";
  if (field.startsWith("pnpm@")) {
    packageManager = PackageManager.PNPM;
  } else if (field.startsWith("yarn@")) {
    packageManager = PackageManager.YARN;
  } else if (field.startsWith("npm@")) {
    packageManager = PackageManager.NPM;
  }

  if (packageManager === null) {
    if (has("pnpm-lock.yaml")) {
      packageManager = PackageManager.PNPM;
    } else if (has("yarn.lock")) {
      packageManager = PackageManager.YARN;
    } else if (has("package-lock.json") || has("npm-shrinkwrap.json")) {
      packageManager = PackageManager.NPM;
    } else {
      packageManager = PackageManager.NPM;
      if (has("bun.lockb") || has("bun.lock")) {
        warnings.push("Bun lockfile found; Bun is not supported, falling back to npm semantics");
      }
    }
  }
  if (lockfileCount > 1) {
    warnings.push(`Multiple lockfiles found; using ${packageManager}`);
  }
  return { packageManager, warnings };
}

// ----- file access (every read confined to the realpath of the root) -----

/**
 * The single repository file reader (06 §5.4): repo-relative path normalized, realpath must stay inside the root
 * (a symlink escaping it is treated as missing), regular files only, capped at DETECTION_MAX_FILE_BYTES.
 */
async function readRepoFile(root: string, repoRelativePath: string): Promise<FileRead> {
  const real = await confinedRealpath(root, repoRelativePath);
  if (real === null) {
    return { kind: "missing" };
  }
  return readCappedFile(real);
}

/** True when the repo-relative path is a regular file whose realpath stays inside the root. */
async function repoFileExists(root: string, repoRelativePath: string): Promise<boolean> {
  const real = await confinedRealpath(root, repoRelativePath);
  if (real === null) {
    return false;
  }
  return (await statOrNull(real))?.isFile() === true;
}

async function confinedRealpath(root: string, repoRelativePath: string): Promise<string | null> {
  let rel: string;
  try {
    rel = normalizeRepoRelativePath(repoRelativePath);
  } catch {
    return null;
  }
  let real: string;
  try {
    real = await fs.realpath(path.join(root, rel));
  } catch {
    return null;
  }
  return isPathInside(root, real) ? real : null;
}

async function readCappedFile(realPath: string): Promise<FileRead> {
  const st = await statOrNull(realPath);
  if (!st?.isFile()) {
    return { kind: "missing" };
  }
  if (st.size > DETECTION_MAX_FILE_BYTES) {
    return { kind: "too_large" };
  }
  try {
    return { kind: "ok", text: await fs.readFile(realPath, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Installed `version` of <nodeModulesDir>/<pkg>/package.json. This read may resolve outside the root (pnpm, a
 * symlinked node_modules), so it is size-capped and regular-file-checked but not confined. Only `version` is used.
 *
 * @returns undefined when the package is not installed; null when installed without a readable version.
 */
async function readInstalledPackageVersion(
  nodeModulesDir: string,
  packageName: string
): Promise<string | null | undefined> {
  let real: string;
  try {
    real = await fs.realpath(path.join(nodeModulesDir, packageName, "package.json"));
  } catch {
    return undefined;
  }
  const read = await readCappedFile(real);
  if (read.kind !== "ok") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (isPlainObject(parsed) && typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {
    // An unparseable manifest still means the package folder exists; the version check is skipped.
  }
  return null;
}

async function firstExisting(root: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await repoFileExists(root, candidate)) {
      return candidate;
    }
  }
  return null;
}

async function anyFileExists(root: string, candidates: readonly string[]): Promise<boolean> {
  return (await firstExisting(root, candidates)) !== null;
}

async function statOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The fixture repository lives at <dataDir>/fixtures/<name> (00 §4) and must be registrable (06 §10, 14 QA-05),
 * so the fixtures subtree is exempt from the "inside the data dir" refusal (build note 06, deviation 1).
 */
function isFixtureRepoPath(realDataDir: string, candidate: string): boolean {
  const fixturesRoot = path.join(realDataDir, FIXTURES_DIR_NAME);
  return candidate !== fixturesRoot && isPathInside(fixturesRoot, candidate);
}

function isGitFailure(error: unknown): error is GitCommandError {
  return error instanceof GitCommandError && error.code !== "git_not_found";
}

function majorVersion(version: string | null): number | null {
  const match = version === null ? null : /^\D*(\d+)/.exec(version);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** JSON.parse + narrowing to PackageJsonShape; null for invalid JSON or a non-object. */
function parsePackageJson(text: string): PackageJsonShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const shape: PackageJsonShape = {};
  if (typeof parsed.name === "string") {
    shape.name = parsed.name;
  }
  if (typeof parsed.packageManager === "string") {
    shape.packageManager = parsed.packageManager;
  }
  if (isStringRecord(parsed.dependencies)) {
    shape.dependencies = parsed.dependencies;
  }
  if (isStringRecord(parsed.devDependencies)) {
    shape.devDependencies = parsed.devDependencies;
  }
  if (isStringRecord(parsed.peerDependencies)) {
    shape.peerDependencies = parsed.peerDependencies;
  }
  const workspaces = parsed.workspaces;
  if (Array.isArray(workspaces) && workspaces.every((entry) => typeof entry === "string")) {
    shape.workspaces = workspaces;
  } else if (isPlainObject(workspaces)) {
    const packages = workspaces.packages;
    shape.workspaces =
      Array.isArray(packages) && packages.every((entry) => typeof entry === "string") ? { packages } : {};
  }
  return shape;
}

/** Mobile-first apps (Capacitor or Ionic in the app's package.json) default to the mobile screen size. */
export async function suggestRenderViewport(root: string, appRoot: string): Promise<"desktop" | "mobile"> {
  const pkg = await readPackageJson(root, joinRel(appRoot, "package.json"));
  if (pkg === null) {
    return "desktop";
  }
  const names = Object.keys({ ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies });
  return names.some((name) => name === "@capacitor/core" || name.startsWith("@ionic/")) ? "mobile" : "desktop";
}
