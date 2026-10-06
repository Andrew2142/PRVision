/**
 * Change analysis, harness, rendering and diff configuration (consumed by sheets 07–11).
 * PURE: imports only node:path and reads no environment, because sheet 10's Vite child process imports this
 * file directly.
 */
import path from "node:path";

// ---- Change analysis (08) ----

/** Max components rendered per visualization; the rest are inserted as skipped. */
export const MAX_COMPONENTS = 12;
/** Highest per-run component limit a user can confirm when a run finds more than MAX_COMPONENTS. */
export const COMPONENT_LIMIT_MAX = 100;

/** Max `affected_parent` candidates contributed by one changed module. */
export const MAX_PARENTS_PER_MODULE = 2;

/** Only files under this repo folder are analysed. */
export const ANALYSIS_SOURCE_ROOT = "src";

/** Analysable changed files considered. */
export const ANALYSIS_MAX_CHANGED_FILES = 1_000;

/** Import-graph nodes per side. */
export const ANALYSIS_MAX_PARSED_FILES = 3_000;

/** Larger source files are not parsed. */
export const ANALYSIS_MAX_FILE_BYTES = 512 * 1024;

/** Soft budget per graph build; exceeding it yields a partial graph. */
export const ANALYSIS_GRAPH_BUDGET_MS = 45_000;

/** Hard budget for ChangeAnalysisService.analyze(); exceeding it is fatal. */
export const ANALYSIS_TIMEOUT_MS = 180_000;

/** Reverse-BFS hops when looking for affected parents. */
export const AFFECTED_PARENT_MAX_DEPTH = 3;

/** Per-component unified diff stored in `code_diff`; longer diffs are truncated with a marker line. */
export const CODE_DIFF_MAX_LINES = 400;

/** Lines of context around a call site given to the harness prompt. */
export const CALL_SITE_CONTEXT_LINES = 15;

/** Upper bound for `findCallSites(limit)`. */
export const CALL_SITE_MAX_LIMIT = 20;

/** Max characters / related declarations returned by `resolveTypeSources`. */
export const TYPE_SOURCES_MAX_CHARS = 16_000;
export const TYPE_SOURCES_MAX_RELATED = 12;

/** Cap of ChangeAnalysisResult.changedFiles entries. */
export const CHANGED_FILES_MAX_ENTRIES = 5_000;

// ---- Harness (07, 09, 10) ----

/** Folder created in the Vite root of each worktree for harness files (00 §4). */
export const HARNESS_DIR_NAME = ".prvision-harness";

/**
 * Absolute path of backend/harness-templates (00 §14.8). Identical from src/config-consts (ts-node) and
 * dist/config-consts (compiled): both sit two levels below the backend package root.
 */
export const HARNESS_TEMPLATES_DIR = path.resolve(__dirname, "../../harness-templates");

// ---- Render engine (10) ----

/** Browser viewport for every screenshot (base and head must match). */
export const RENDER_VIEWPORT = { width: 1280, height: 800 } as const;

/** Screen sizes a repository can render at (repositories.render_viewport). Screenshots use the full width. */
export const RENDER_VIEWPORTS = {
  desktop: { width: 1280, height: 800, mobile: false },
  tablet: { width: 768, height: 1024, mobile: true },
  mobile: { width: 390, height: 844, mobile: true }
} as const;
export type RenderViewportName = keyof typeof RENDER_VIEWPORTS;
export const RENDER_VIEWPORT_NAMES = ["desktop", "tablet", "mobile"] as const satisfies readonly RenderViewportName[];

/** Navigation + ready timeout for one component page. */
export const RENDER_TIMEOUT_MS = 30_000;

/** Time allowed for a worktree's Vite host to become ready. */
export const VITE_START_TIMEOUT_MS = 60_000;

/** Upper bound for the whole rendering stage. */
export const RENDER_STAGE_TIMEOUT_MS = 15 * 60_000;

/** Extra time granted to the first component of a side (cold Vite transform cache). */
export const RENDER_COLD_START_ALLOWANCE_MS = 30_000;

/** Graceful stop of a Vite host before it is killed. */
export const VITE_STOP_TIMEOUT_MS = 5_000;

/** Graceful browser close before it is killed. */
export const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

/** Settling: quiet period, overall cap, asset wait, module-error grace. */
export const RENDER_SETTLE_QUIET_MS = 250;
export const RENDER_SETTLE_MAX_MS = 5_000;
export const RENDER_ASSET_WAIT_MS = 3_000;
export const RENDER_MODULE_ERROR_GRACE_MS = 2_000;

/** Layout stability probe: interval and attempts. */
export const RENDER_STABILITY_INTERVAL_MS = 150;
export const RENDER_STABILITY_MAX_ATTEMPTS = 5;

/** Padding around the captured root and the max capture height. */
export const RENDER_CAPTURE_PADDING_PX = 16;
export const RENDER_MAX_CAPTURE_HEIGHT_PX = 4_000;

/** Frozen clock and Math.random seed, identical for both sides. */
export const RENDER_FIXED_TIME_ISO = "2025-01-15T10:30:00.000Z";
export const RENDER_RANDOM_SEED = 1_337;

/** Retries of a render that failed for an infrastructure reason (crashed page, lost Vite host). */
export const RENDER_INFRA_RETRIES = 1;

/** Caps of persisted render errors and captured console errors. */
export const RENDER_ERROR_MAX_CHARS = 4_000;
export const RENDER_CONSOLE_ERRORS_MAX = 20;
export const RENDER_CONSOLE_ERROR_MAX_CHARS = 500;

/** Vite host child: heap limit (MB) and log ring buffer (entries). */
export const VITE_HOST_MAX_OLD_SPACE_MB = 2_048;
export const VITE_HOST_LOG_BUFFER_SIZE = 500;

/** Vite majors the render engine supports. */
export const SUPPORTED_VITE_MAJOR_MIN = 4;
export const SUPPORTED_VITE_MAJOR_MAX = 7;

// ---- Image and structural diff (11) ----

/** pixelmatch `threshold` (0..1, lower = stricter). */
export const PIXELMATCH_THRESHOLD = 0.1;

/** Diff pixel ratio below which a component counts as visually `unchanged`. */
export const UNCHANGED_RATIO_CUTOFF = 0.0005;

/** Images larger than this are not decoded (10 never captures wider than RENDER_VIEWPORT.width or taller than RENDER_MAX_CAPTURE_HEIGHT_PX). */
export const DIFF_MAX_WIDTH = 2_048;
export const DIFF_MAX_HEIGHT = 4_096;
export const DIFF_MAX_PNG_BYTES = 32 * 1024 * 1024;

/** Structural diff limits. */
export const STRUCTURAL_DIFF_MAX_CHANGES = 200;
export const STRUCTURAL_DIFF_MAX_DEPTH = 40;
export const STRUCTURAL_DIFF_MAX_NODES = 5_000;
export const STRUCTURAL_VALUE_MAX_CHARS = 300;

// ---- Angular (15 §5.7.12). 15a created the constants it uses; 15d appends the rest of the block here ----

/** Angular application builders PRVision can drive through Architect. */
export const ANGULAR_SUPPORTED_BUILDERS = [
  "@angular/build:application",
  "@angular-devkit/build-angular:application",
  "@angular-devkit/build-angular:browser-esbuild"
] as const;
export const ANGULAR_MIN_MAJOR = 17;
export const ANGULAR_MAX_TESTED_MAJOR = 21;
export const ANGULAR_CACHE_DIR_NAME = "cache/angular"; // <dataDir>/cache/angular/<repositoryId>

// ---- Angular render engine (15d, 15 §5.7.12) ----

/** Child boot plus loading the repository's Architect. */
export const ANGULAR_HOST_START_TIMEOUT_MS = 30_000;
/** One harness build (30 Acme components took 27 s). */
export const ANGULAR_BUILD_TIMEOUT_MS = 240_000;
/** Graceful stop of an Angular host child before its process group is killed. */
export const ANGULAR_HOST_STOP_TIMEOUT_MS = 5_000;
/** Builds per (render group, side): the first build plus exclusion and bisect rebuilds (15 §5.7.8). */
export const ANGULAR_MAX_BUILDS_PER_GROUP_SIDE = 4;
/** Heap cap of the Angular host child (a full Acme build peaked at 3.9 GB RSS). */
export const ANGULAR_HOST_MAX_OLD_SPACE_MB = 4_096;
/** Interface the in-process static host binds to. */
export const ANGULAR_STATIC_HOST = "127.0.0.1";
/** Angular harness templates (main.ts, harness-api.ts, http-backend.ts). */
export const ANGULAR_HARNESS_TEMPLATES_DIR = path.join(HARNESS_TEMPLATES_DIR, "angular");

// ---- Angular change analysis (15b, 15 §5.5) ----

/** Largest angular.json the analysis reads (15 §6). */
export const ANGULAR_ANALYSIS_WORKSPACE_MAX_BYTES = 1024 * 1024;
/** SCSS/CSS partial chains followed from a changed partial to the owning components (15 §5.5.2 step 3). */
export const ANGULAR_ANALYSIS_PARTIAL_MAX_DEPTH = 3;
/** `getInjectableOutline` line cap (15 §5.2.2). */
export const ANGULAR_ANALYSIS_OUTLINE_MAX_LINES = 120;
/** `findSpecSetups` snippet line cap (15 §5.5.6). */
export const ANGULAR_ANALYSIS_SPEC_SNIPPET_MAX_LINES = 80;
