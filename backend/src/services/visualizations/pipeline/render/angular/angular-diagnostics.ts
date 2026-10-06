/**
 * Angular build errors (15 §5.7.8): parsing of the esbuild-formatted messages the application builder logs,
 * attribution of each error to harness items, the exclusion/bisect build loop per (render group, side), and the
 * error text persisted for a failed side (also the text given to 09's repair).
 *
 * The parser, attribution and formatting are pure; `runExclusionLoop` only awaits the injected build function.
 */
import path from "node:path";
import { HARNESS_DIR_NAME } from "../../../../../config-consts";
import { redactSecrets } from "../../../../../utilities";
import { headlineFor, normalizeErrorText, truncateRenderError } from "../render-errors";
import type { RenderFailureKind } from "../render-types";

export interface AngularDiagnostic {
  severity: "error" | "warning";
  /** Leading `NG\d+` or `TS\d+` of the message, else null. */
  code: string | null;
  /** Message text up to the first blank line, `[plugin …]` stripped. */
  message: string;
  /** Workspace-relative POSIX path of the first location, or null. */
  file: string | null;
  line: number | null;
  column: number | null;
  /** Source frame lines after the location (at most 6). */
  frame: string[];
}

const MARKER = /^(?:✘|X|×) \[ERROR\] (.*)$|^(?:▲|!|⚠) \[WARNING\] (.*)$/;
const LOCATION = /^\s{2,}(\S.*?):(\d+):(\d+):\s*$/;
const PLUGIN_SUFFIX = /\s*\[plugin [^\]]+\]\s*$/;
const CODE_PREFIX = /^(NG\d+|TS\d+)\b/;
const FRAME_LINES_MAX = 6;
/** Diagnostics listed in one error text (15 §5.7.8: at most 10). */
export const ANGULAR_DIAGNOSTICS_MAX = 10;

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

/**
 * Parses esbuild-formatted builder messages (`✘ [ERROR] …` / `▲ [WARNING] …`, also `X [ERROR]` for non-UTF
 * terminals). Each log entry may hold several messages.
 *
 * @param logs - Builder log messages of one build, in order.
 * @returns The diagnostics in log order.
 */
export function parseAngularBuildMessages(logs: readonly string[]): AngularDiagnostic[] {
  const lines = logs.join("\n").split(/\r?\n/);
  const diagnostics: AngularDiagnostic[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = MARKER.exec(lines[index] ?? "");
    if (match === null) {
      index += 1;
      continue;
    }
    const severity: AngularDiagnostic["severity"] = match[1] !== undefined ? "error" : "warning";
    const messageLines = [(match[1] ?? match[2] ?? "").trimEnd()];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() !== "" && !MARKER.test(lines[index] ?? "")) {
      messageLines.push((lines[index] ?? "").trimEnd());
      index += 1;
    }
    let file: string | null = null;
    let line: number | null = null;
    let column: number | null = null;
    const frame: string[] = [];
    // Location: the first location line before the next marker.
    while (index < lines.length && !MARKER.test(lines[index] ?? "")) {
      const location = LOCATION.exec(lines[index] ?? "");
      index += 1;
      if (location === null) {
        continue;
      }
      file = toPosix(location[1] ?? "").replace(/^\.\//, "");
      line = Number(location[2]);
      column = Number(location[3]);
      while (
        index < lines.length &&
        (lines[index] ?? "").trim() !== "" &&
        !MARKER.test(lines[index] ?? "") &&
        frame.length < FRAME_LINES_MAX
      ) {
        frame.push((lines[index] ?? "").trimEnd());
        index += 1;
      }
      break;
    }
    const message = messageLines.join("\n").replace(PLUGIN_SUFFIX, "").trim();
    diagnostics.push({ severity, code: CODE_PREFIX.exec(message)?.[1] ?? null, message, file, line, column, frame });
  }
  return diagnostics;
}

/**
 * Error diagnostics of a failed build. When the builder failed without any parseable error (schema validation,
 * an exception inside the builder), the error-level log text becomes one location-less (side-wide) diagnostic.
 */
export function errorDiagnosticsOfFailedBuild(
  logs: ReadonlyArray<{ level: string; message: string }>
): AngularDiagnostic[] {
  const errors = parseAngularBuildMessages(logs.map((entry) => entry.message)).filter(
    (diagnostic) => diagnostic.severity === "error"
  );
  if (errors.length > 0) {
    return errors;
  }
  const text = logs
    .filter((entry) => entry.level === "error")
    .map((entry) => entry.message.trim())
    .filter((message) => message !== "")
    .join("\n");
  return [
    {
      severity: "error",
      code: null,
      message: text === "" ? "The Angular build failed without an error message." : text,
      file: null,
      line: null,
      column: null,
      frame: []
    }
  ];
}

/** Warnings of a build, one line each (for the console, at most `limit`). */
export function warningLines(logs: ReadonlyArray<{ message: string }>, limit: number): string[] {
  return parseAngularBuildMessages(logs.map((entry) => entry.message))
    .filter((diagnostic) => diagnostic.severity === "warning")
    .slice(0, limit)
    .map((diagnostic) => {
      const first = diagnostic.message.split("\n")[0] ?? "";
      return diagnostic.file === null ? first : `${first} (${diagnostic.file})`;
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------------------------------------------

export type DiagnosticAttribution =
  { kind: "items"; componentIds: number[] } | { kind: "side_wide" } | { kind: "unattributed"; file: string };

export interface AttributionContext {
  /** Component ids in the build. */
  itemIds: ReadonlySet<number>;
  /** Mock hash → component ids (of this build) whose accepted mocks have that hash. */
  mockOwners: ReadonlyMap<string, readonly number[]>;
  /** Workspace-relative files whose errors break every harness: global styles, polyfills, tsconfig chain, angular.json. */
  sideWideFiles: ReadonlySet<string>;
}

const COMPONENT_FILE = new RegExp(`^${HARNESS_DIR_NAME.replace(".", "\\.")}/components/(\\d+)\\.ts$`);
const MOCK_FILE = new RegExp(`^${HARNESS_DIR_NAME.replace(".", "\\.")}/mocks/([0-9a-f]+)\\.ts$`);

/** Where an error diagnostic belongs (15 §5.7.8 attribution table). */
export function attributeDiagnostic(diagnostic: AngularDiagnostic, context: AttributionContext): DiagnosticAttribution {
  if (diagnostic.file === null) {
    return { kind: "side_wide" };
  }
  const file = path.posix.normalize(diagnostic.file);
  const component = COMPONENT_FILE.exec(file);
  if (component !== null) {
    const id = Number(component[1]);
    return context.itemIds.has(id) ? { kind: "items", componentIds: [id] } : { kind: "side_wide" };
  }
  const mock = MOCK_FILE.exec(file);
  if (mock !== null) {
    const owners = (context.mockOwners.get(mock[1] ?? "") ?? []).filter((id) => context.itemIds.has(id));
    return owners.length > 0 ? { kind: "items", componentIds: [...owners] } : { kind: "side_wide" };
  }
  if (file === HARNESS_DIR_NAME || file.startsWith(`${HARNESS_DIR_NAME}/`)) {
    return { kind: "side_wide" };
  }
  if (context.sideWideFiles.has(file)) {
    return { kind: "side_wide" };
  }
  return { kind: "unattributed", file };
}

/** Extensions of a component's own template and stylesheets (Angular's `<name>.component.<ext>` convention). */
const COMPONENT_COMPANION = /\.(?:ts|html|css|scss|sass|less)$/;

/**
 * Whether a workspace-relative file belongs to the component whose TypeScript file is `targetFile`: the file itself,
 * or a template or stylesheet beside it with the same stem (`order-list.component.html` for
 * `order-list.component.ts`). An error in such a file breaks every build that contains that component.
 */
export function componentOwnsFile(targetFile: string, file: string): boolean {
  const target = path.posix.normalize(targetFile);
  const candidate = path.posix.normalize(file);
  if (candidate === target) {
    return true;
  }
  return (
    COMPONENT_COMPANION.test(candidate) &&
    target.endsWith(".ts") &&
    candidate.replace(COMPONENT_COMPANION, "") === target.slice(0, -".ts".length)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------------------------------------------

/** One diagnostic as listed in the `Angular build:` section. */
export function formatDiagnostic(diagnostic: AngularDiagnostic): string {
  const [first = "", ...rest] = diagnostic.message.split("\n");
  const lines = [`- ${first}`, ...rest.map((line) => `  ${line}`)];
  if (diagnostic.file !== null) {
    lines.push(`  ${diagnostic.file}:${String(diagnostic.line ?? 0)}:${String(diagnostic.column ?? 0)}`);
    for (const frameLine of diagnostic.frame) {
      lines.push(`    ${frameLine.trim()}`);
    }
  }
  return lines.join("\n");
}

/**
 * Persisted error text of a side that failed in the build (10 §5.12.3 extended): `[kind] headline`, then the
 * `Angular build:` section (at most 10 diagnostics). Worktree paths are stripped, secrets redacted, capped.
 */
export function formatAngularBuildError(
  kind: RenderFailureKind,
  headline: string,
  diagnostics: readonly AngularDiagnostic[],
  stripPaths: readonly string[]
): string {
  const lines = [`[${kind}] ${headlineFor(kind, headline)}`];
  if (diagnostics.length > 0) {
    lines.push("Angular build:");
    for (const diagnostic of diagnostics.slice(0, ANGULAR_DIAGNOSTICS_MAX)) {
      lines.push(formatDiagnostic(diagnostic));
    }
    if (diagnostics.length > ANGULAR_DIAGNOSTICS_MAX) {
      lines.push(`- … ${String(diagnostics.length - ANGULAR_DIAGNOSTICS_MAX)} more`);
    }
  }
  return truncateRenderError(redactSecrets(normalizeErrorText(lines.join("\n"), null, stripPaths)));
}

/** First line of the first diagnostic (console text). */
export function firstDiagnosticLine(diagnostics: readonly AngularDiagnostic[]): string {
  const first = diagnostics[0];
  if (first === undefined) {
    return "unknown error";
  }
  const line = first.message.split("\n")[0] ?? "";
  return first.file === null ? line : `${line} (${first.file}:${String(first.line ?? 0)})`;
}

// ---------------------------------------------------------------------------------------------------------------
// Exclusion and bisect loop
// ---------------------------------------------------------------------------------------------------------------

/** What one build attempt of a subset of items returned (the render service maps AngularBuildOutcome to this). */
export type ExclusionBuildResult =
  | { status: "success"; outputDir: string }
  | { status: "failed"; diagnostics: AngularDiagnostic[] }
  | { status: "unavailable"; message: string }
  | { status: "timeout"; message: string }
  | { status: "cancelled" };

/** A per-item failure decided by the loop. */
export interface ExclusionItemFailure {
  kind: RenderFailureKind;
  headline: string;
  diagnostics: AngularDiagnostic[];
}

export interface ExclusionLoopResult {
  /** Successful builds: the items each output contains. */
  builds: Array<{ componentIds: number[]; outputDir: string; buildNo: number }>;
  failures: Map<number, ExclusionItemFailure>;
  buildsUsed: number;
  cancelled: boolean;
  /** Set when a side-wide error stopped the loop (console error, once). */
  sideWide: { headline: string; diagnostics: AngularDiagnostic[] } | null;
  /** Items excluded by attribution, by ownership of the failing repository file, or by bisect, for console/logs. */
  exclusions: Array<{ buildNo: number; componentIds: number[]; reason: "attributed" | "owner" | "bisect" }>;
}

export interface ExclusionLoopOptions {
  side: "base" | "head";
  /** Item ids in rank order. */
  componentIds: readonly number[];
  budget: number;
  /** Mock hash → owning component ids (all items of the group on this side). */
  mockOwners: ReadonlyMap<string, readonly number[]>;
  sideWideFiles: ReadonlySet<string>;
  /**
   * Workspace-relative TypeScript file of each item's target component on this side. An unattributed error in a
   * file a target owns (`componentOwnsFile`) fails that item without a build of its own, and the rest is rebuilt
   * once, instead of bisecting. Items without an entry are only isolated by bisect.
   */
  targetFiles?: ReadonlyMap<number, string>;
  build: (componentIds: number[], buildNo: number) => Promise<ExclusionBuildResult>;
}

function groupBy<T>(items: readonly T[], key: (item: T) => number[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const item of items) {
    for (const id of key(item)) {
      const list = out.get(id) ?? [];
      list.push(item);
      out.set(id, list);
    }
  }
  return out;
}

/**
 * Builds the items of one (group, side) and isolates harness compile errors (15 §5.7.8): attributed errors exclude
 * their items and rebuild the rest; unattributed errors bisect; side-wide errors fail everything; at most
 * `budget` builds. Every item ends up either in exactly one successful build or in `failures`.
 */
export async function runExclusionLoop(options: ExclusionLoopOptions): Promise<ExclusionLoopResult> {
  const result: ExclusionLoopResult = {
    builds: [],
    failures: new Map(),
    buildsUsed: 0,
    cancelled: false,
    sideWide: null,
    exclusions: []
  };
  const queue: number[][] = options.componentIds.length > 0 ? [[...options.componentIds]] : [];
  let lastDiagnostics: AngularDiagnostic[] = [];
  const failAll = (sets: readonly number[][], failure: ExclusionItemFailure): void => {
    for (const set of sets) {
      for (const id of set) {
        result.failures.set(id, failure);
      }
    }
  };
  while (queue.length > 0) {
    if (result.buildsUsed >= options.budget) {
      failAll(queue, {
        kind: "module_load",
        headline: `Angular build error (the ${String(options.budget)}-build limit for isolating errors was reached):`,
        diagnostics: lastDiagnostics
      });
      break;
    }
    const set = queue.shift() ?? [];
    result.buildsUsed += 1;
    const buildNo = result.buildsUsed;
    const outcome = await options.build(set, buildNo);
    if (outcome.status === "success") {
      result.builds.push({ componentIds: set, outputDir: outcome.outputDir, buildNo });
      continue;
    }
    if (outcome.status === "cancelled") {
      result.cancelled = true;
      break;
    }
    if (outcome.status === "unavailable" || outcome.status === "timeout") {
      failAll([set, ...queue], {
        kind: outcome.status === "timeout" ? "timeout" : "vite_unavailable",
        headline: outcome.message,
        diagnostics: []
      });
      break;
    }
    const diagnostics = outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    lastDiagnostics = diagnostics;
    const context: AttributionContext = {
      itemIds: new Set(set),
      mockOwners: options.mockOwners,
      sideWideFiles: options.sideWideFiles
    };
    const attributed = diagnostics.map((diagnostic) => ({
      diagnostic,
      attribution: attributeDiagnostic(diagnostic, context)
    }));
    if (attributed.length === 0 || attributed.some((entry) => entry.attribution.kind === "side_wide")) {
      const headline = `The Angular build failed on the ${options.side} side:`;
      result.sideWide = { headline, diagnostics };
      failAll([set, ...queue], { kind: "vite_unavailable", headline, diagnostics });
      break;
    }
    const byItem = groupBy(
      attributed.filter((entry) => entry.attribution.kind === "items"),
      (entry) => (entry.attribution.kind === "items" ? entry.attribution.componentIds : [])
    );
    if (byItem.size > 0) {
      const excluded = set.filter((id) => byItem.has(id));
      for (const id of excluded) {
        result.failures.set(id, {
          kind: "module_load",
          headline: "Angular build error in the harness:",
          diagnostics: (byItem.get(id) ?? []).map((entry) => entry.diagnostic)
        });
      }
      result.exclusions.push({ buildNo, componentIds: excluded, reason: "attributed" });
      const rest = set.filter((id) => !byItem.has(id));
      if (rest.length > 0) {
        queue.unshift(rest);
      }
      continue;
    }
    // Only unattributed errors (a repository file breaks the build for some item).
    const owned = ownedFailures(set, attributed, options.targetFiles);
    if (set.length > 1 && owned.size > 0) {
      // The error is in a target's own file, so every build containing that target fails the same way: fail it
      // now and rebuild the rest once (bisecting would spend the budget on innocent items).
      for (const [id, entries] of owned) {
        const files = [...new Set(entries.map((entry) => entry.file))];
        result.failures.set(id, {
          kind: "module_load",
          headline: `Angular build error in ${files.join(", ")}:`,
          diagnostics: entries.map((entry) => entry.diagnostic)
        });
      }
      result.exclusions.push({ buildNo, componentIds: [...owned.keys()], reason: "owner" });
      const rest = set.filter((id) => !owned.has(id));
      if (rest.length > 0) {
        queue.unshift(rest);
      }
      continue;
    }
    if (set.length === 1) {
      const files = [
        ...new Set(attributed.map((entry) => (entry.attribution.kind === "unattributed" ? entry.attribution.file : "")))
      ].filter((file) => file !== "");
      result.failures.set(set[0] ?? 0, {
        kind: "module_load",
        headline: `Angular build error in ${files.join(", ")}:`,
        diagnostics
      });
      continue;
    }
    const half = Math.ceil(set.length / 2);
    result.exclusions.push({ buildNo, componentIds: [...set], reason: "bisect" });
    queue.unshift(set.slice(0, half), set.slice(half));
  }
  return result;
}

/** Items of `set` whose target owns the file of an unattributed error, with those errors (rank order kept). */
function ownedFailures(
  set: readonly number[],
  attributed: ReadonlyArray<{ diagnostic: AngularDiagnostic; attribution: DiagnosticAttribution }>,
  targetFiles: ReadonlyMap<number, string> | undefined
): Map<number, Array<{ diagnostic: AngularDiagnostic; file: string }>> {
  const owned = new Map<number, Array<{ diagnostic: AngularDiagnostic; file: string }>>();
  if (targetFiles === undefined) {
    return owned;
  }
  for (const id of set) {
    const target = targetFiles.get(id);
    if (target === undefined) {
      continue;
    }
    for (const { diagnostic, attribution } of attributed) {
      if (attribution.kind === "unattributed" && componentOwnsFile(target, attribution.file)) {
        const list = owned.get(id) ?? [];
        list.push({ diagnostic, file: attribution.file });
        owned.set(id, list);
      }
    }
  }
  return owned;
}
