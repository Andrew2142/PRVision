/**
 * Loads the target repository's own Vite (10 §5.5.2): locate `node_modules/vite` from the Vite root, check the
 * version, import its ESM entry and validate the API surface PRVision uses.
 *
 * PURE: loaded by the Vite host child process; imports only node built-ins, render types, `esm-import` and
 * `render.config.ts` (directly, never through the config-consts barrel).
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SUPPORTED_VITE_MAJOR_MAX, SUPPORTED_VITE_MAJOR_MIN } from "../../../../config-consts/render.config";
import { esmImport } from "./esm-import";
import { describeError, isRecord, isViteModuleLike, type ViteModuleLike } from "./render-types";

export type ViteLoadFailureKind = "vite_not_found" | "vite_unsupported" | "vite_load_failed";

/** A failure to locate, version-check or import the repository's Vite. */
export class ViteLoadError extends Error {
  override readonly name = "ViteLoadError";

  constructor(
    message: string,
    readonly kind: ViteLoadFailureKind,
    readonly detail: string | null = null
  ) {
    super(message);
  }
}

export interface LoadedVite {
  module: ViteModuleLike;
  version: string;
  major: number;
  minor: number;
  packageDir: string; // realpath of node_modules/vite
  entryPath: string; // file that was imported
  /** "Vite 8.0.0 is newer than the tested range (4–7)" for an untested newer major, else null. */
  warning: string | null;
}

const REQUIRED_FUNCTIONS = ["createServer", "loadConfigFromFile", "mergeConfig", "createLogger", "loadEnv"] as const;

/**
 * Resolves a package `exports` entry with the given conditions (first matching condition wins, recursively).
 *
 * @param entry - A string, an array of fallbacks, or a conditions object.
 * @param conditions - Condition names in priority order.
 * @returns The relative target, or null.
 */
export function resolveExportTarget(entry: unknown, conditions: readonly string[]): string | null {
  if (typeof entry === "string") {
    return entry;
  }
  if (Array.isArray(entry)) {
    for (const candidate of entry) {
      const resolved = resolveExportTarget(candidate, conditions);
      if (resolved !== null) {
        return resolved;
      }
    }
    return null;
  }
  if (isRecord(entry)) {
    for (const condition of conditions) {
      if (condition in entry) {
        const resolved = resolveExportTarget(entry[condition], conditions);
        if (resolved !== null) {
          return resolved;
        }
      }
    }
  }
  return null;
}

/** `pkg.exports` may be a string, a conditions object, or a subpath map with ".". */
function rootExportEntry(exportsField: unknown): unknown {
  if (isRecord(exportsField) && "." in exportsField) {
    return exportsField["."];
  }
  if (isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith("."))) {
    return undefined; // subpath map without "."
  }
  return exportsField;
}

/** Picks the ESM entry of the Vite package (never the deprecated CJS build of Vite 4–6). */
export function pickViteEntry(pkg: Record<string, unknown>): string {
  const rootEntry = rootExportEntry(pkg.exports);
  const fromExports =
    rootEntry === undefined ? null : resolveExportTarget(rootEntry, ["import", "module-sync", "default"]);
  if (fromExports !== null) {
    return fromExports;
  }
  if (typeof pkg.module === "string") {
    return pkg.module;
  }
  if (typeof pkg.main === "string") {
    return pkg.main;
  }
  return "index.js";
}

async function locateVitePackageJson(viteRoot: string): Promise<string> {
  const requireFromRoot = createRequire(path.join(viteRoot, "package.json"));
  try {
    return requireFromRoot.resolve("vite/package.json");
  } catch {
    // Fall back to the main entry and walk up to the package root.
  }
  let resolvedMain: string;
  try {
    resolvedMain = requireFromRoot.resolve("vite");
  } catch {
    throw new ViteLoadError(
      `Vite is not installed for this repository (looked from ${viteRoot}). Install dependencies in your clone; PRVision reuses its node_modules.`,
      "vite_not_found"
    );
  }
  let dir = path.dirname(resolvedMain);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (isRecord(parsed) && parsed.name === "vite") {
        return candidate;
      }
    } catch {
      // Keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new ViteLoadError(
        `Vite is not installed for this repository (looked from ${viteRoot}). Install dependencies in your clone; PRVision reuses its node_modules.`,
        "vite_not_found"
      );
    }
    dir = parent;
  }
}

/**
 * Locates, version-checks and imports the repository's Vite.
 *
 * @param viteRoot - Absolute Vite root of the worktree (its `node_modules` is a symlink to the user's clone).
 * @returns The loaded module and its version data.
 * @throws ViteLoadError (`vite_not_found` | `vite_unsupported` | `vite_load_failed`).
 */
export async function loadTargetVite(viteRoot: string): Promise<LoadedVite> {
  const packageJsonPath = await locateVitePackageJson(viteRoot);
  const packageDir = await fs.realpath(path.dirname(packageJsonPath));
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("package.json is not an object");
    }
    pkg = parsed;
  } catch (error) {
    throw new ViteLoadError(
      `Vite's package.json could not be read: ${describeError(error)}`,
      "vite_load_failed",
      describeError(error)
    );
  }
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  const match = /^(\d+)\.(\d+)/.exec(version);
  const major = match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const minor = match?.[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  if (major < SUPPORTED_VITE_MAJOR_MIN) {
    throw new ViteLoadError(
      `Vite ${version} is not supported. PRVision supports Vite ${String(SUPPORTED_VITE_MAJOR_MIN)} to ${String(SUPPORTED_VITE_MAJOR_MAX)}.`,
      "vite_unsupported"
    );
  }
  const warning =
    major > SUPPORTED_VITE_MAJOR_MAX
      ? `Vite ${version} is newer than the tested range (${String(SUPPORTED_VITE_MAJOR_MIN)}–${String(SUPPORTED_VITE_MAJOR_MAX)})`
      : null;

  const entryPath = path.resolve(packageDir, pickViteEntry(pkg));
  let namespace: unknown;
  try {
    namespace = await esmImport(pathToFileURL(entryPath).href);
  } catch (error) {
    const engines = isRecord(pkg.engines) && typeof pkg.engines.node === "string" ? pkg.engines.node : "unknown";
    throw new ViteLoadError(
      `Vite ${version} could not be loaded with Node ${process.version} (requires ${engines}): ${describeError(error)}`,
      "vite_load_failed",
      describeError(error)
    );
  }
  const candidate = isViteModuleLike(namespace)
    ? namespace
    : isRecord(namespace) && isViteModuleLike(namespace.default)
      ? namespace.default
      : null;
  if (candidate === null) {
    throw new ViteLoadError("The installed Vite does not export createServer", "vite_unsupported");
  }
  const surface = candidate as unknown as Record<string, unknown>;
  const missing: string[] = REQUIRED_FUNCTIONS.filter((name) => typeof surface[name] !== "function");
  if (typeof surface.transformWithEsbuild !== "function" && typeof surface.transformWithOxc !== "function") {
    missing.push("transformWithEsbuild");
  }
  if (missing.length > 0) {
    throw new ViteLoadError(`The installed Vite does not export ${missing.join(", ")}`, "vite_unsupported");
  }
  return { module: candidate, version, major, minor, packageDir, entryPath, warning };
}
