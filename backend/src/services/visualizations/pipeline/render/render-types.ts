/**
 * Internal types of the render engine (10 §4): structural Vite types, the Vite host IPC protocol, work items,
 * render groups, failure kinds and the page render contract.
 *
 * PURE: this module is loaded by the Vite host child process (10 §5.2). It imports only types and must never
 * import the logger, the database, the utilities barrel or the config-consts barrel.
 */
import type {
  ComponentCandidate,
  HarnessGenerationResult,
  MockedModule
} from "../../../../types/visualization-pipeline";

export type RenderSide = "base" | "head";

export type UnknownRecord = Record<string, unknown>;

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON text of a value, or null when it has none (undefined, functions) or cannot be serialized. */
export function jsonOrNull(value: unknown): string | null {
  try {
    const out: unknown = JSON.stringify(value);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

/** Message of an unknown thrown value (the child cannot import utilities' getErrorMessage). */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  return jsonOrNull(error) ?? Object.prototype.toString.call(error);
}

/** Stack of an unknown thrown value, or null. */
export function stackOf(error: unknown): string | null {
  return error instanceof Error && typeof error.stack === "string" ? error.stack : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Harness layout (10 §5.4.1)
// ---------------------------------------------------------------------------------------------------------------

export interface HarnessSideLayout {
  side: RenderSide;
  worktreeDir: string; // PreparedWorkspace.baseDir / headDir
  viteRoot: string; // absolute
  configFile: string | null; // absolute path of repository.viteConfigPath on this side if the file exists, else null
  harnessDir: string; // <viteRoot>/.prvision-harness
  componentsDir: string; // <harnessDir>/components
  cacheDir: string; // <harnessDir>/.vite-cache
  harnessUrlPath: string; // "/.prvision-harness/index.html" (POSIX, root-relative)
}

// ---------------------------------------------------------------------------------------------------------------
// Structural Vite types (10 §5.5.2). No `vite` dependency in the backend.
// ---------------------------------------------------------------------------------------------------------------

export interface ViteLoggerLike {
  info(message: string, options?: UnknownRecord): void;
  warn(message: string, options?: UnknownRecord): void;
  warnOnce(message: string, options?: UnknownRecord): void;
  error(message: string, options?: UnknownRecord): void;
  clearScreen(type: string): void;
  hasErrorLogged(error: unknown): boolean;
  hasWarned: boolean;
}

export interface ViteResolvedIdLike {
  id: string;
  external?: boolean | "absolute" | "relative";
}

export interface VitePluginContextLike {
  resolve(
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean; isEntry?: boolean; custom?: unknown; ssr?: boolean }
  ): Promise<ViteResolvedIdLike | null>;
}

export interface ViteResolveIdOptions {
  scan?: boolean;
  ssr?: boolean;
  isEntry?: boolean;
  custom?: unknown;
}

export interface ViteLoadResultLike {
  code: string;
  map: null;
}

export interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post";
  apply?: "serve" | "build" | ((...args: unknown[]) => boolean);
  resolveId?: (
    this: VitePluginContextLike,
    source: string,
    importer: string | undefined,
    options: ViteResolveIdOptions
  ) => Promise<string | ViteResolvedIdLike | null> | string | ViteResolvedIdLike | null;
  load?: (this: VitePluginContextLike, id: string) => Promise<ViteLoadResultLike | null> | ViteLoadResultLike | null;
}

export interface ViteDevServerLike {
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServerLike>;
  close(): Promise<void>;
  httpServer: { address(): string | { address: string; port: number } | null } | null;
  resolvedUrls?: { local: string[]; network: string[] } | null;
}

export interface ViteModuleLike {
  version?: string;
  createServer(config: UnknownRecord): Promise<ViteDevServerLike>;
  loadConfigFromFile(
    env: { command: "serve"; mode: string; isSsrBuild?: boolean; isPreview?: boolean; ssrBuild?: boolean },
    configFile?: string,
    configRoot?: string,
    logLevel?: string
  ): Promise<{ path: string; config: UnknownRecord; dependencies: string[] } | null>;
  mergeConfig(defaults: UnknownRecord, overrides: UnknownRecord, isRoot?: boolean): UnknownRecord;
  createLogger(level?: string, options?: UnknownRecord): ViteLoggerLike;
  loadEnv(mode: string, envDir: string, prefixes?: string | string[]): Record<string, string>;
  transformWithEsbuild?(code: string, filename: string, options?: UnknownRecord): Promise<{ code: string }>;
  transformWithOxc?(code: string, filename: string, options?: UnknownRecord): Promise<{ code: string }>;
  searchForWorkspaceRoot?(current: string): string;
}

export function isViteModuleLike(value: unknown): value is ViteModuleLike {
  return isRecord(value) && typeof value.createServer === "function" && typeof value.mergeConfig === "function";
}

// ---------------------------------------------------------------------------------------------------------------
// Vite host IPC protocol (10 §5.6.1)
// ---------------------------------------------------------------------------------------------------------------

export interface MockEntryInput {
  componentId: number;
  componentFile: string; // absolute path of the component file on this side
  specifier: string; // MockedModule.specifier (already validated)
  source: string; // MockedModule.source
}

export interface ViteHostStartOptions {
  side: RenderSide;
  groupKey: string;
  worktreeDir: string;
  viteRoot: string;
  harnessDir: string;
  cacheDir: string;
  configFile: string | null; // null → auto-detect vite.config.{ts,mts,cts,js,mjs,cjs} in viteRoot
  optimizeEntries: string[]; // root-relative POSIX paths: entry.tsx, globals.ts, every components/<id>.tsx on this side
  warmupFiles: string[]; // root-relative POSIX paths: entry.tsx + this group's component files
  referencedEnvKeys: string[]; // union over both sides
  mocks: MockEntryInput[]; // this group's accepted mocks on this side
}

export type ViteHostRequest = { type: "start"; options: ViteHostStartOptions } | { type: "shutdown" };

export type ViteHostStartFailureKind =
  | "vite_not_found"
  | "vite_unsupported"
  | "vite_load_failed"
  | "react_missing"
  | "react_unsupported"
  | "config_error"
  | "listen_error"
  | "unknown";

export type ViteHostLogLevel = "info" | "warn" | "error";

export type ViteHostEvent =
  | {
      type: "ready";
      origin: string; // e.g. "http://127.0.0.1:53817"
      viteVersion: string;
      reactDomVersion: string;
      tailwindMajor: 3 | 4 | null;
      configFile: string | null;
      warnings: string[]; // sanitization notes, untested-version notes, rejected mocks
    }
  | { type: "start_failed"; kind: ViteHostStartFailureKind; message: string; detail: string | null }
  | { type: "log"; level: ViteHostLogLevel; message: string; at: number }
  | { type: "closed" };

/** Failures that will repeat for every group on the same side; the side is marked broken for the rest of the run. */
export const STICKY_START_FAILURES: ReadonlySet<ViteHostStartFailureKind> = new Set<ViteHostStartFailureKind>([
  "vite_not_found",
  "vite_unsupported",
  "vite_load_failed",
  "react_missing",
  "react_unsupported",
  "config_error"
]);

const START_FAILURE_KINDS: ReadonlySet<string> = new Set<string>([...STICKY_START_FAILURES, "listen_error", "unknown"]);

/** Validates `type` and the required fields of a message received from the Vite host child. */
export function isViteHostEvent(value: unknown): value is ViteHostEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  switch (value.type) {
    case "ready":
      return (
        typeof value.origin === "string" &&
        typeof value.viteVersion === "string" &&
        typeof value.reactDomVersion === "string" &&
        (value.tailwindMajor === 3 || value.tailwindMajor === 4 || value.tailwindMajor === null) &&
        (typeof value.configFile === "string" || value.configFile === null) &&
        Array.isArray(value.warnings) &&
        value.warnings.every((warning) => typeof warning === "string")
      );
    case "start_failed":
      return (
        typeof value.kind === "string" &&
        START_FAILURE_KINDS.has(value.kind) &&
        typeof value.message === "string" &&
        (typeof value.detail === "string" || value.detail === null)
      );
    case "log":
      return (
        (value.level === "info" || value.level === "warn" || value.level === "error") &&
        typeof value.message === "string" &&
        typeof value.at === "number"
      );
    case "closed":
      return true;
    default:
      return false;
  }
}

/** Validates a message received by the Vite host child from the parent. */
export function isViteHostRequest(value: unknown): value is ViteHostRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "shutdown") {
    return true;
  }
  return value.type === "start" && isRecord(value.options) && typeof value.options.viteRoot === "string";
}

// ---------------------------------------------------------------------------------------------------------------
// Vite host handle (10 §5.6.2; declared here so the browser session can depend on it without a cycle)
// ---------------------------------------------------------------------------------------------------------------

export interface ViteLogEntry {
  seq: number;
  level: ViteHostLogLevel;
  message: string;
  at: number;
}

export interface ViteHostHandle {
  readonly side: RenderSide;
  readonly groupKey: string;
  readonly origin: string;
  readonly viteVersion: string;
  readonly reactDomVersion: string;
  readonly tailwindMajor: 3 | 4 | null;
  readonly harnessUrlPath: string;
  /** Warnings from the `ready` event (sanitization notes, dev-plugin removal, Tailwind checks). */
  readonly warnings: readonly string[];
  isAlive(): boolean;
  exitReason(): string | null; // "exited with code 1 (signal null)" etc.
  currentSeq(): number;
  logsSince(seq: number, level?: "warn" | "error"): ViteLogEntry[];
  sawDepsReoptimizeSince(seq: number): boolean; // "optimized dependencies changed" / "new dependencies optimized"
  stop(): Promise<void>; // idempotent; never throws
}

// ---------------------------------------------------------------------------------------------------------------
// Failure kinds (10 §5.12.1)
// ---------------------------------------------------------------------------------------------------------------

export type RenderFailureKind =
  | "vite_unavailable" // host could not start for this side (load, config, listen, timeout, exit)
  | "navigation" // harness page could not be opened
  | "module_load" // a module in the harness graph failed to resolve/transform/evaluate
  | "render_error" // React render/mount threw (error boundary or mount)
  | "timeout" // never became ready within the budget
  | "step_failed" // a state's scripted step could not run (16 §7.2; repairable; produced from 16b on)
  | "browser" // Chromium crashed or disconnected
  | "screenshot" // capture or PNG write failed
  | "file_missing" // component file absent on this side although the change kind implies it exists
  | "budget_exceeded" // render stage time budget ran out
  | "cancelled"; // visualization cancelled (never persisted)

// ---------------------------------------------------------------------------------------------------------------
// Work items and groups (10 §5.13.2, §5.3)
// ---------------------------------------------------------------------------------------------------------------

export interface RenderWorkItem {
  candidate: ComponentCandidate;
  harness: HarnessGenerationResult;
  paths: { base: string | null; head: string | null }; // repo-relative component path per side
  acceptedMocks: MockedModule[];
  fingerprint: string;
  sides: { base: boolean; head: boolean };
  primarySide: RenderSide; // head when head exists, else base
  repairsUsed: number;
  mockLabels: Map<string, string>; // hash → specifier, per side computed with that side's component path
  /** Planned per-side failures (file missing on disk, base-side rename rewrite failed): no page is opened. */
  plannedFailures: { base: PlannedSideFailure | null; head: PlannedSideFailure | null };
  /** 00 §17, replaced rows: accepted mocks of the base harness (`acceptedMocks` then holds the head harness's). */
  baseAcceptedMocks?: MockedModule[];
  /** 00 §17, replaced rows: repairs used per side (each side repairs its own harness). */
  sideRepairsUsed?: Partial<Record<RenderSide, number>>;
}

export interface PlannedSideFailure {
  kind: RenderFailureKind;
  error: string;
}

export interface RenderGroup {
  key: string;
  items: RenderWorkItem[];
}

// ---------------------------------------------------------------------------------------------------------------
// Page render contract (10 §5.11.1)
// ---------------------------------------------------------------------------------------------------------------

export type CaptureMode = "content" | "viewport" | "empty";

export interface PageRenderInput {
  host: Pick<
    ViteHostHandle,
    | "origin"
    | "harnessUrlPath"
    | "currentSeq"
    | "logsSince"
    | "sawDepsReoptimizeSince"
    | "isAlive"
    | "exitReason"
    | "side"
  >;
  componentId: number;
  /** 16 §6.12: the harness state to render (render services pass "Default"; the page uses it from 16b on). */
  stateName: string;
  timeoutMs: number; // budget for this attempt (goto → PNG written)
  outputPath: string; // absolute temp path; written atomically
  signal: AbortSignal; // ctx.signal
  checkStylesheets: { globalStylesExpected: boolean; tailwindMajor: 3 | 4 | null } | null; // first render per host only
  /** The repository's screen size; default desktop (RENDER_VIEWPORT). */
  viewport?: { width: number; height: number; mobile: boolean };
  /** hash → specifier of the mocks active in this page, for readable error messages (10 §5.12.3). */
  mockLabels?: ReadonlyMap<string, string>;
  /** Absolute path prefixes stripped from error text (worktree dirs, the clone), so messages are repo-relative. */
  stripPaths?: readonly string[];
}

export type PageRenderOutcome =
  | {
      ok: true;
      width: number;
      height: number;
      mode: CaptureMode;
      stable: boolean;
      truncated: boolean;
      consoleErrors: string[];
      durationMs: number;
      blockedRequests: number;
      stylesheetWarning: string | null;
      /** Angular harness (15 §5.7.2, 00 §15 item 8): never became stable within settleMax. Absent/false for React. */
      unstable?: boolean;
      /** Angular harness: inputs not declared on this side, skipped. Absent/[] for React. */
      skippedInputs?: string[];
      /** Angular harness: HTTP requests without a fixture (≤ 10). Absent/[] for React. */
      httpUnmatched?: string[];
    }
  | {
      ok: false;
      kind: RenderFailureKind;
      error: string; // formatted (5.12.3), already truncated
      consoleErrors: string[];
      durationMs: number;
      infraRetryable: boolean; // dep re-optimization churn or page crash (5.11.10)
    };
