/**
 * `AngularComponentIndex` (sheet 15 §5.5.2): per-side index of the Angular source root, built once per run and
 * cached. Maps every file under the source root to its decorated classes (components, directives, pipes,
 * NgModules, injectables), external templates and styles to their owning components, SCSS/CSS partials to the
 * style files that import them, and every component/directive/pipe to the components whose templates use it.
 *
 * Also exports the pure path classification for Angular change analysis (`classifyAngularPath`, §5.5.1).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import ts from "typescript";
import { ANGULAR_ANALYSIS_PARTIAL_MAX_DEPTH, ANGULAR_ANALYSIS_WORKSPACE_MAX_BYTES } from "../../../../config-consts";
import type { Side } from "../../../../types/change-analysis";
import {
  AngularWorkspaceReader,
  joinRepoPath,
  resolveGlobalStyles
} from "../../../repositories/angular-workspace-reader";
import { readConfined, readConfinedText, walkSourceFiles } from "../change-source";
import { scanStyleImports, truncateFiles } from "../import-graph";
import {
  AngularDecoratorReader,
  readAngularImportBindings,
  type AngularDecoratedClass,
  type AngularDecoratorKind
} from "./angular-decorator-reader";
import { AngularSelectorMatcher } from "./angular-selector-matcher";
import { AngularTemplateScanner, type AngularTemplateScan } from "./angular-template-scanner";

const posix = path.posix;

// ---------------------------------------------------------------------------------------------------------------
// Path classification (§5.5.1)
// ---------------------------------------------------------------------------------------------------------------

export type AngularPathKind = "ignored" | "global_style" | "global_config" | "script" | "template" | "style" | "asset";

/** What classification needs to know about the Angular workspace of one side. All paths repo-relative POSIX. */
export interface AngularWorkspaceLayout {
  appRoot: string; // "." = repository root
  projectName: string | null;
  sourceRoot: string; // posix.join(appRoot, project.sourceRoot ?? "src")
  indexHtml: string | null; // build target `index`
  globalStyles: string[]; // build target `styles` entries that are repo files
  /** Global style entries plus every partial reached from them through @import/@use/@forward. */
  globalStyleClosure: ReadonlySet<string>;
  /** angular.json, package.json, the tsconfig chain and exact PostCSS config files of the app root. */
  configFiles: ReadonlySet<string>;
}

const IGNORED_SEGMENTS = new Set(["node_modules", ".angular", "dist", ".prvision-harness"]);
const IGNORED_SCRIPT = /\.(spec|stories|mock)\.ts$|\.d\.ts$/;
const STYLE_FILE = /\.(css|scss|sass|less)$/;
const TAILWIND_CONFIG = /^tailwind\.config\.[cm]?[jt]s$/;

/** Joins `appRoot` and a relative path, keeping "." out of the result. */
export function joinAppPath(appRoot: string, relative: string): string {
  const joined = posix.normalize(posix.join(appRoot === "." ? "" : appRoot, relative));
  return joined.startsWith("./") ? joined.slice(2) : joined;
}

function isUnder(repoPath: string, root: string): boolean {
  return root === "." || root === "" ? true : repoPath.startsWith(`${root}/`);
}

/**
 * Classifies a changed repo-relative path for Angular analysis (§5.5.1, first matching rule wins).
 */
export function classifyAngularPath(repoPath: string, layout: AngularWorkspaceLayout): AngularPathKind {
  const segments = repoPath.split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return "ignored";
  }
  if (layout.globalStyleClosure.has(repoPath)) {
    return "global_style";
  }
  if (layout.configFiles.has(repoPath)) {
    return "global_config";
  }
  const appRootPrefix = layout.appRoot === "." ? "" : `${layout.appRoot}/`;
  if (repoPath.startsWith(appRootPrefix) && TAILWIND_CONFIG.test(repoPath.slice(appRootPrefix.length))) {
    return "global_config";
  }
  if (!isUnder(repoPath, layout.sourceRoot)) {
    return "ignored";
  }
  const basename = segments[segments.length - 1] ?? "";
  if (basename.endsWith(".ts")) {
    return IGNORED_SCRIPT.test(basename) ? "ignored" : "script";
  }
  if (basename.endsWith(".html")) {
    return repoPath === layout.indexHtml ? "ignored" : "template";
  }
  if (STYLE_FILE.test(basename)) {
    return "style";
  }
  if (basename.startsWith(".")) {
    return "ignored";
  }
  return "asset";
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace layout of one side (§5.5.1)
// ---------------------------------------------------------------------------------------------------------------

const TSCONFIG_CHAIN_MAX = 5;

function readJsonc(fileName: string, text: string): Record<string, unknown> | null {
  const parsed = ts.parseConfigFileTextToJson(fileName, text);
  const config: unknown = parsed.config;
  return parsed.error === undefined && typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : null;
}

/** Repo-relative tsconfig files reached from `tsconfigPath` through relative `extends` (≤ 5 files). */
async function tsconfigChain(sideRoot: string, tsconfigPath: string | null): Promise<string[]> {
  const out: string[] = [];
  const queue = tsconfigPath === null ? [] : [tsconfigPath];
  while (queue.length > 0 && out.length < TSCONFIG_CHAIN_MAX) {
    const current = queue.shift();
    if (current === undefined || out.includes(current)) {
      continue;
    }
    out.push(current);
    const text = await readConfinedText(sideRoot, current);
    const config = text === null ? null : readJsonc(current, text);
    const extendsValue = config?.extends;
    const list = typeof extendsValue === "string" ? [extendsValue] : Array.isArray(extendsValue) ? extendsValue : [];
    for (const entry of list) {
      if (typeof entry === "string" && entry.startsWith(".")) {
        const target = joinRepoPath(posix.dirname(current), entry.endsWith(".json") ? entry : `${entry}.json`);
        if (target !== null) {
          queue.push(target);
        }
      }
    }
  }
  return out;
}

/**
 * Reads `<appRoot>/angular.json` of one side through 15a's `AngularWorkspaceReader` and derives the analysis layout:
 * source root, build index, global style entries and the global-config files. Null when angular.json is missing,
 * unreadable or has no matching application project.
 */
export async function readAngularWorkspaceLayout(
  sideRoot: string,
  repository: { appRoot: string; angularProject: string | null; tsconfigPath: string | null }
): Promise<AngularWorkspaceLayout | null> {
  const appRoot = repository.appRoot === "" ? "." : repository.appRoot;
  const angularJsonPath = joinAppPath(appRoot, "angular.json");
  const text = await readConfinedText(sideRoot, angularJsonPath, ANGULAR_ANALYSIS_WORKSPACE_MAX_BYTES);
  if (text === null) {
    return null;
  }
  const parsed = AngularWorkspaceReader.parse(text);
  if (!parsed.ok) {
    return null;
  }
  const applications = AngularWorkspaceReader.applicationProjects(parsed.projects);
  const project =
    applications.find((candidate) => candidate.name === repository.angularProject) ??
    (repository.angularProject === null ? applications[0] : undefined);
  if (project === undefined) {
    return null;
  }
  // 15a's reader does not expose `sourceRoot`; it is read here from the same JSONC text.
  const raw = readJsonc(angularJsonPath, text);
  const projects = raw?.projects;
  const rawProject =
    typeof projects === "object" && projects !== null ? (projects as Record<string, unknown>)[project.name] : undefined;
  const declaredSourceRoot =
    typeof rawProject === "object" && rawProject !== null
      ? (rawProject as Record<string, unknown>).sourceRoot
      : undefined;
  const sourceRoot =
    typeof declaredSourceRoot === "string" && declaredSourceRoot.trim() !== ""
      ? joinAppPath(appRoot, declaredSourceRoot)
      : joinAppPath(appRoot, posix.join(project.root, "src"));
  const options = project.buildTarget?.options ?? {};
  const indexOption = options.index;
  const indexInput =
    typeof indexOption === "string"
      ? indexOption
      : typeof indexOption === "object" &&
          indexOption !== null &&
          typeof (indexOption as Record<string, unknown>).input === "string"
        ? String((indexOption as Record<string, unknown>).input)
        : null;
  const globalStyles = resolveGlobalStyles(appRoot, options.styles).flatMap((specifier) =>
    specifier.startsWith("/") ? [specifier.slice(1)] : []
  );
  const tsconfigPath =
    repository.tsconfigPath ?? (typeof options.tsConfig === "string" ? joinRepoPath(appRoot, options.tsConfig) : null);
  const configFiles = new Set<string>([
    angularJsonPath,
    joinAppPath(appRoot, "package.json"),
    joinAppPath(appRoot, "postcss.config.json"),
    joinAppPath(appRoot, ".postcssrc.json"),
    ...(await tsconfigChain(sideRoot, tsconfigPath))
  ]);
  return {
    appRoot,
    projectName: project.name,
    sourceRoot,
    indexHtml: indexInput === null ? null : joinRepoPath(appRoot, indexInput),
    globalStyles,
    globalStyleClosure: new Set(globalStyles),
    configFiles
  };
}

/** Layout used when angular.json cannot be read on either side: `<appRoot>/src`, no globals. */
export function fallbackAngularWorkspaceLayout(appRoot: string): AngularWorkspaceLayout {
  const root = appRoot === "" ? "." : appRoot;
  return {
    appRoot: root,
    projectName: null,
    sourceRoot: joinAppPath(root, "src"),
    indexHtml: null,
    globalStyles: [],
    globalStyleClosure: new Set(),
    configFiles: new Set([joinAppPath(root, "angular.json"), joinAppPath(root, "package.json")])
  };
}

function majorOf(version: string): number | null {
  const match = /(\d+)/.exec(version);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

/**
 * Major version of `@angular/core` for the app (decides the `standalone` default, §5.5.2): the installed package
 * (`<side>/<appRoot>/node_modules`, `<side>/node_modules`, then the clone's), else the version declared in
 * `<appRoot>/package.json` or the root `package.json`. Null when unknown. Read-only.
 */
export async function detectAngularMajor(
  sideRoot: string,
  appRoot: string,
  clonePath: string | null
): Promise<number | null> {
  const installed = [
    path.join(sideRoot, appRoot, "node_modules", "@angular", "core", "package.json"),
    path.join(sideRoot, "node_modules", "@angular", "core", "package.json"),
    ...(clonePath === null
      ? []
      : [
          path.join(clonePath, appRoot, "node_modules", "@angular", "core", "package.json"),
          path.join(clonePath, "node_modules", "@angular", "core", "package.json")
        ])
  ];
  for (const file of installed) {
    try {
      const pkg: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      const version = typeof pkg === "object" && pkg !== null ? (pkg as Record<string, unknown>).version : undefined;
      if (typeof version === "string") {
        return majorOf(version);
      }
    } catch {
      // not installed there; try the next location
    }
  }
  for (const manifest of [joinAppPath(appRoot, "package.json"), "package.json"]) {
    const text = await readConfinedText(sideRoot, manifest);
    const pkg = text === null ? null : readJsonc(manifest, text);
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg?.[field];
      const declared =
        typeof deps === "object" && deps !== null ? (deps as Record<string, unknown>)["@angular/core"] : undefined;
      if (typeof declared === "string") {
        return majorOf(declared);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------------------------

/** `<repo-relative path>#<className>`. */
export function angularClassKey(filePath: string, className: string): string {
  return `${filePath}#${className}`;
}

export interface AngularIndexEntry {
  key: string;
  filePath: string;
  cls: AngularDecoratedClass;
  templatePath: string | null; // resolved external template (repo-relative)
  stylePaths: string[]; // resolved external styles (repo-relative)
  templateText: string | null; // external file text or inline literal text
  templateScan: AngularTemplateScan | null;
}

export interface AngularTemplateUsage {
  ownerKey: string; // component whose template uses the key
  line: number; // 1-based line inside the owner's template text
}

export interface AngularIndexBuildOptions {
  side: Side;
  rootDir: string;
  sourceRoot: string;
  appRoot?: string; // resolves root-relative resource URLs ("/src/app/x.html"); default: parent of sourceRoot
  maxFiles: number; // ANALYSIS_MAX_PARSED_FILES
  maxFileBytes: number; // ANALYSIS_MAX_FILE_BYTES
  priorityPaths: readonly string[]; // changed files kept when truncating
  angularMajor: number | null;
  signal: AbortSignal;
  now(): number;
  /** Resolves a TS import specifier to a repo-relative file (used for NgModule declarations); null = unknown. */
  resolveScript?: (specifier: string, fromRepoPath: string) => string | null;
  log?: Logger;
}

const YIELD_EVERY_FILES = 100;
const STYLE_EXTENSIONS = [".scss", ".sass", ".css", ".less"];

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function yieldToLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else if (!list.includes(value)) {
    list.push(value);
  }
}

/** Resolves a component-relative resource URL (`./x.html`, `x.scss`, `/src/app/x.html`) to a repo path. */
function resolveResource(fromFile: string, url: string, appRoot: string | null): string | null {
  if (url === "" || url.includes("\0") || /^[a-z]+:/i.test(url)) {
    return null;
  }
  const joined = url.startsWith("/")
    ? posix.normalize(posix.join(appRoot === null || appRoot === "." ? "" : appRoot, url.slice(1)))
    : posix.normalize(posix.join(posix.dirname(fromFile), url));
  return joined.startsWith("../") || joined === ".." || joined.startsWith("/") ? null : joined;
}

/** Candidate files for a Sass/CSS import specifier relative to the importing stylesheet. */
function styleCandidates(fromFile: string, specifier: string): string[] {
  if (specifier.startsWith("~") || /^[a-z]+:/i.test(specifier) || specifier.startsWith("//")) {
    return [];
  }
  const target = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (target.startsWith("../") || target.startsWith("/")) {
    return [];
  }
  const dir = posix.dirname(target);
  const base = posix.basename(target);
  const join = (name: string): string => (dir === "." ? name : `${dir}/${name}`);
  const out: string[] = [];
  if (STYLE_EXTENSIONS.some((ext) => base.endsWith(ext))) {
    out.push(target, join(`_${base}`));
    return out;
  }
  for (const ext of STYLE_EXTENSIONS) {
    out.push(join(`${base}${ext}`), join(`_${base}${ext}`));
  }
  for (const ext of STYLE_EXTENSIONS) {
    out.push(`${target}/index${ext}`, `${target}/_index${ext}`);
  }
  return out;
}

/** Per-side Angular index (§5.5.2). Build with `AngularComponentIndex.build`. */
export class AngularComponentIndex {
  private readonly entriesByKey = new Map<string, AngularIndexEntry>();
  private readonly entriesByFile = new Map<string, AngularIndexEntry[]>();
  private readonly templateOwners = new Map<string, string[]>();
  private readonly styleOwners = new Map<string, string[]>();
  private readonly styleImports = new Map<string, string[]>(); // stylesheet → partials it imports
  private readonly styleImporters = new Map<string, string[]>(); // partial → stylesheets importing it
  private readonly usages = new Map<string, AngularTemplateUsage[]>(); // used key → usages
  private readonly pipeUsages = new Map<string, string[]>(); // pipe name → component keys
  private readonly declaredInModule = new Map<string, string>(); // component key → NgModule key
  private readonly importBindings = new Map<string, Map<string, { specifier: string; imported: string }>>();
  private fileList: string[] = [];
  private fileSet = new Set<string>();
  private templateCount = 0;
  private truncatedValue = false;
  private totalFilesValue = 0;
  private durationMsValue = 0;

  private constructor(
    readonly side: Side,
    readonly sourceRoot: string
  ) {}

  get truncated(): boolean {
    return this.truncatedValue;
  }

  get totalFiles(): number {
    return this.totalFilesValue;
  }

  get stats(): { files: number; components: number; templates: number; durationMs: number } {
    return {
      files: this.fileList.length,
      components: this.components().length,
      templates: this.templateCount,
      durationMs: this.durationMsValue
    };
  }

  /**
   * Walks `<rootDir>/<sourceRoot>`, parses every script, scans every component template, indexes style partials and
   * selector usages. Files over `maxFileBytes` are skipped; over `maxFiles` files the index is partial (`truncated`).
   */
  static async build(options: AngularIndexBuildOptions): Promise<AngularComponentIndex> {
    const start = options.now();
    const index = new AngularComponentIndex(options.side, options.sourceRoot);
    const all = (await walkSourceFiles(options.rootDir, options.sourceRoot, options.signal)).filter((file) => {
      const base = posix.basename(file);
      return !file.split("/").some((segment) => IGNORED_SEGMENTS.has(segment)) && !base.endsWith(".d.ts");
    });
    const files = truncateFiles(all, options.priorityPaths, options.maxFiles);
    index.truncatedValue = files.length < all.length;
    index.totalFilesValue = all.length;
    index.fileList = files;
    index.fileSet = new Set(files);

    const reader = new AngularDecoratorReader({ angularMajor: options.angularMajor });
    const scanner = new AngularTemplateScanner();
    const texts = new Map<string, string | null>();
    const readText = async (repoPath: string): Promise<string | null> => {
      if (texts.has(repoPath)) {
        return texts.get(repoPath) ?? null;
      }
      const read = await readConfined(options.rootDir, repoPath, options.maxFileBytes);
      const text = read.kind === "ok" ? read.text : null;
      texts.set(repoPath, text);
      return text;
    };
    const appRoot = options.appRoot ?? (options.sourceRoot.includes("/") ? posix.dirname(options.sourceRoot) : ".");

    // 1–2. scripts
    let counter = 0;
    for (const file of files) {
      if (++counter % YIELD_EVERY_FILES === 0) {
        await yieldToLoop();
        options.signal.throwIfAborted();
      }
      if (!file.endsWith(".ts") || IGNORED_SCRIPT.test(posix.basename(file))) {
        continue;
      }
      const read = await readConfined(options.rootDir, file, options.maxFileBytes);
      if (read.kind !== "ok") {
        continue;
      }
      const sf = ts.createSourceFile(file, read.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const classes = reader.read(sf);
      if (classes.length === 0) {
        continue;
      }
      index.importBindings.set(file, readAngularImportBindings(sf));
      for (const cls of classes) {
        const templatePath = cls.templateUrl === null ? null : resolveResource(file, cls.templateUrl, appRoot);
        const stylePaths = cls.styleUrls.flatMap((url) => {
          const resolved = resolveResource(file, url, appRoot);
          return resolved === null ? [] : [resolved];
        });
        const entry: AngularIndexEntry = {
          key: angularClassKey(file, cls.className),
          filePath: file,
          cls,
          templatePath,
          stylePaths,
          templateText: cls.inlineTemplate?.text ?? null,
          templateScan: null
        };
        index.entriesByKey.set(entry.key, entry);
        pushTo(index.entriesByFile, file, entry);
        if (templatePath !== null) {
          pushTo(index.templateOwners, templatePath, entry.key);
        }
        for (const stylePath of stylePaths) {
          pushTo(index.styleOwners, stylePath, entry.key);
        }
      }
    }

    // 3. styles: partial index
    for (const file of files) {
      if (!STYLE_FILE.test(file)) {
        continue;
      }
      const text = await readText(file);
      if (text === null) {
        continue;
      }
      for (const raw of scanStyleImports(text)) {
        const target = styleCandidates(file, raw.specifier).find((candidate) => index.fileSet.has(candidate));
        if (target !== undefined && target !== file) {
          pushTo(index.styleImports, file, target);
          pushTo(index.styleImporters, target, file);
        }
      }
    }

    // 4. templates
    for (const entry of index.entriesByKey.values()) {
      if (entry.cls.kind !== "Component") {
        continue;
      }
      if (entry.templatePath !== null) {
        entry.templateText = await readText(entry.templatePath);
      }
      if (entry.templateText !== null) {
        entry.templateScan = scanner.scan(entry.templateText, entry.templatePath ?? entry.filePath);
        index.templateCount++;
        if (entry.templateScan.parseErrors.length > 0) {
          options.log?.debug(
            { event: "analysis.angular.template_parse_error", side: options.side, key: entry.key },
            "Template parsed with errors; scan is partial"
          );
        }
      }
      if (++counter % YIELD_EVERY_FILES === 0) {
        await yieldToLoop();
        options.signal.throwIfAborted();
      }
    }

    // 5. selector usage and pipes
    const matcher = new AngularSelectorMatcher(
      [...index.entriesByKey.values()].flatMap((entry) =>
        (entry.cls.kind === "Component" || entry.cls.kind === "Directive") && entry.cls.selector !== null
          ? [{ key: entry.key, selector: entry.cls.selector }]
          : []
      )
    );
    for (const entry of index.entriesByKey.values()) {
      const scan = entry.templateScan;
      if (scan === null) {
        continue;
      }
      for (const [usedKey, line] of matcher.matchUsages(scan)) {
        if (usedKey !== entry.key) {
          const list = index.usages.get(usedKey) ?? [];
          list.push({ ownerKey: entry.key, line });
          index.usages.set(usedKey, list);
        }
      }
      for (const pipe of scan.pipes) {
        pushTo(index.pipeUsages, pipe, entry.key);
      }
    }
    for (const list of index.usages.values()) {
      list.sort((a, b) => byString(a.ownerKey, b.ownerKey));
    }

    // 6. NgModule declarations
    for (const entry of index.entriesByKey.values()) {
      for (const name of entry.cls.ngModule?.declarations ?? []) {
        const declared = index.resolveClassReference(entry.filePath, name, options.resolveScript);
        if (declared !== null && !index.declaredInModule.has(declared)) {
          index.declaredInModule.set(declared, entry.key);
        }
      }
    }
    index.durationMsValue = options.now() - start;
    options.log?.info(
      { event: "analysis.angular.index", side: options.side, ...index.stats },
      "Angular component index built"
    );
    return index;
  }

  /** Every listed file under the source root (after truncation), sorted. */
  files(): readonly string[] {
    return this.fileList;
  }

  hasFile(repoPath: string): boolean {
    return this.fileSet.has(repoPath);
  }

  entry(key: string): AngularIndexEntry | undefined {
    return this.entriesByKey.get(key);
  }

  entriesInFile(repoPath: string): readonly AngularIndexEntry[] {
    return this.entriesByFile.get(repoPath) ?? [];
  }

  /** Every entry of one decorator kind, sorted by key. */
  entriesOfKind(kind: AngularDecoratorKind): AngularIndexEntry[] {
    return [...this.entriesByKey.values()]
      .filter((entry) => entry.cls.kind === kind)
      .sort((a, b) => byString(a.key, b.key));
  }

  components(): AngularIndexEntry[] {
    return this.entriesOfKind("Component");
  }

  /** The component of `filePath` exported as `exportName` (or with that class name). */
  findComponent(filePath: string, exportName: string): AngularIndexEntry | null {
    const entries = this.entriesInFile(filePath).filter((entry) => entry.cls.kind === "Component");
    return (
      entries.find((entry) => entry.cls.exportName === exportName) ??
      entries.find((entry) => entry.cls.className === exportName) ??
      null
    );
  }

  templateOwnersOf(repoPath: string): readonly string[] {
    return this.templateOwners.get(repoPath) ?? [];
  }

  styleOwnersOf(repoPath: string): readonly string[] {
    return this.styleOwners.get(repoPath) ?? [];
  }

  styleImportsOf(repoPath: string): readonly string[] {
    return this.styleImports.get(repoPath) ?? [];
  }

  /**
   * Components owning a style file that imports `partialPath`, directly or through other partials (depth ≤ 3).
   * `via` is the owned style file. Nearest first, then by key.
   */
  partialOwners(partialPath: string): Array<{ key: string; via: string; depth: number }> {
    const out: Array<{ key: string; via: string; depth: number }> = [];
    const seen = new Set<string>([partialPath]);
    let level = [partialPath];
    for (let depth = 1; depth <= ANGULAR_ANALYSIS_PARTIAL_MAX_DEPTH && level.length > 0; depth++) {
      const next: string[] = [];
      for (const current of level) {
        for (const importer of this.styleImporters.get(current) ?? []) {
          if (seen.has(importer)) {
            continue;
          }
          seen.add(importer);
          next.push(importer);
        }
      }
      next.sort(byString);
      for (const styleFile of next) {
        for (const key of [...this.styleOwnersOf(styleFile)].sort(byString)) {
          if (!out.some((owner) => owner.key === key)) {
            out.push({ key, via: styleFile, depth });
          }
        }
      }
      level = next;
    }
    return out;
  }

  /** Style files reachable from `entries` through @import/@use/@forward (entries included). */
  styleClosure(entries: readonly string[]): Set<string> {
    const out = new Set<string>(entries);
    const queue = [...entries];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      for (const target of this.styleImportsOf(current)) {
        if (!out.has(target)) {
          out.add(target);
          queue.push(target);
        }
      }
    }
    return out;
  }

  /** Components whose templates use the component/directive `key`, with the first line of use. */
  usagesOf(key: string): readonly AngularTemplateUsage[] {
    return this.usages.get(key) ?? [];
  }

  /** Number of components using `key` in their templates (representative ranking, §5.5.5). */
  usageCount(key: string): number {
    return this.usages.get(key)?.length ?? 0;
  }

  /** Components whose templates use the pipe `name`. */
  pipeUsersOf(name: string): readonly string[] {
    return this.pipeUsages.get(name) ?? [];
  }

  /** NgModule key declaring the component, or null. */
  declaringModuleOf(key: string): string | null {
    return this.declaredInModule.get(key) ?? null;
  }

  /** Import bindings of an indexed file that holds decorated classes. */
  importsOf(repoPath: string): ReadonlyMap<string, { specifier: string; imported: string }> {
    return this.importBindings.get(repoPath) ?? new Map();
  }

  /**
   * Class key an identifier refers to in `fromFile`: a same-file class, else the imported class (resolved with
   * `resolveScript`), else the unique indexed class of that name.
   */
  resolveClassReference(
    fromFile: string,
    identifier: string,
    resolveScript?: (specifier: string, fromRepoPath: string) => string | null
  ): string | null {
    const local = this.entriesInFile(fromFile).find((entry) => entry.cls.className === identifier);
    if (local !== undefined) {
      return local.key;
    }
    const binding = this.importsOf(fromFile).get(identifier);
    if (binding !== undefined && resolveScript !== undefined && binding.imported !== "*") {
      const target = resolveScript(binding.specifier, fromFile);
      if (target !== null) {
        const imported = binding.imported === "default" ? null : binding.imported;
        const match = this.entriesInFile(target).find((entry) =>
          imported === null
            ? entry.cls.exportName === "default"
            : entry.cls.exportName === imported || entry.cls.className === imported
        );
        if (match !== undefined) {
          return match.key;
        }
      }
    }
    const byName = [...this.entriesByKey.values()].filter(
      (entry) => entry.cls.className === (binding?.imported ?? identifier)
    );
    return byName.length === 1 ? (byName[0]?.key ?? null) : null;
  }
}
