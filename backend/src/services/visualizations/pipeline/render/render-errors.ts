/**
 * Render error model (10 §5.12): repairability, the formatted error text persisted in `base_error`/`head_error`
 * and passed to 09's `repairHarness`, Vite error-page parsing and mock-id rewriting.
 */
import { RENDER_ERROR_MAX_CHARS } from "../../../../config-consts";
import { redactSecrets } from "../../../../utilities";
import { isRecord, type RenderFailureKind } from "./render-types";

export type { RenderFailureKind } from "./render-types";

const REPAIRABLE: ReadonlySet<RenderFailureKind> = new Set<RenderFailureKind>([
  "module_load",
  "render_error",
  "timeout",
  "step_failed"
]);

/** True only for failures a better harness can fix: module_load, render_error, timeout, step_failed (16 §6.12). */
export function isRepairableFailure(kind: RenderFailureKind): boolean {
  return REPAIRABLE.has(kind);
}

/** True for messages caused by Vite re-optimizing dependencies mid-render (one infrastructure retry). */
export function isOptimizeDepsChurn(text: string): boolean {
  return /Outdated Optimize Dep|optimized dependencies changed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(
    text
  );
}

/** Headline prefix per failure kind (10 §5.12.3). */
export function headlineFor(kind: RenderFailureKind, detail: string): string {
  switch (kind) {
    case "module_load":
      return `Module load failed: ${detail}`;
    case "render_error":
      return `Render error: ${detail}`;
    case "navigation":
      return `Could not open the harness page: ${detail}`;
    case "browser":
      return `Browser error: ${detail}`;
    case "screenshot":
      return `Screenshot failed: ${detail}`;
    case "step_failed":
      return `Interaction step failed: ${detail}`;
    case "timeout":
    case "file_missing":
    case "budget_exceeded":
    case "vite_unavailable":
    case "cancelled":
      return detail;
  }
}

/** Fixed headline of a component that ran out of stage budget. */
export const BUDGET_EXCEEDED_HEADLINE = "The render stage exceeded its time budget before this component finished.";

/** "src/components/Foo.tsx does not exist on the base side." */
export function fileMissingHeadline(filePath: string, side: "base" | "head"): string {
  return `${filePath} does not exist on the ${side} side.`;
}

/** Timeout headline with the harness phase and root diagnostics. */
export function timeoutHeadline(
  timeoutMs: number,
  diagnostics: { status: string | null; rootChildCount: number; rootTextSample: string }
): string {
  return `Timed out after ${String(timeoutMs)} ms waiting for the component to render (harness phase: ${
    diagnostics.status ?? "unknown"
  }; root children: ${String(diagnostics.rootChildCount)}; root text: ${JSON.stringify(diagnostics.rootTextSample)}).`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces `/@id/__x00__prvision-mock:<hash>`, `__x00__prvision-mock:<hash>` and `\0prvision-mock:<hash>` with
 * `[mock of "<specifier>"]` (unknown hashes get `[mock <hash>]`).
 */
export function rewriteMockIds(text: string, mockLabels: ReadonlyMap<string, string>): string {
  return text.replace(/(?:\/@id\/__x00__|__x00__|\0)prvision-mock:([0-9a-f]{16})/g, (_match, hash: string) => {
    const label = mockLabels.get(hash);
    return label === undefined ? `[mock ${hash}]` : `[mock of "${label}"]`;
  });
}

/** Removes the Vite origin and absolute path prefixes (worktree dirs, the clone) from error text. */
export function normalizeErrorText(text: string, viteOrigin: string | null, stripPaths: readonly string[]): string {
  // Vite's per-server dependency hashes (`?v=1a2b3c4d`) differ between base and head; they carry no information.
  let result = text.replace(/\?v=[0-9a-f]{6,}/g, "");
  if (viteOrigin !== null && viteOrigin !== "") {
    result = result.replace(new RegExp(escapeRegExp(viteOrigin), "g"), "");
  }
  const prefixes = [...new Set(stripPaths.filter((prefix) => prefix.length > 1))].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
    result = result.replace(new RegExp(`(?:/@fs)?${escapeRegExp(withSlash)}`, "g"), "");
  }
  return result;
}

/** Parses Vite's 500 error page. Vite 4: `new ErrorOverlay({json})`; Vite 5–7: `const error = {json}`. */
export function extractViteErrorFromBody(body: string): string | null {
  const match = /(?:const error = |new ErrorOverlay\()(\{.*\})/.exec(body);
  if (match?.[1] !== undefined) {
    const parsed = parseLeadingJsonObject(match[1]);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      const plugin = typeof parsed.plugin === "string" ? `[plugin:${parsed.plugin}] ` : "";
      const loc = isRecord(parsed.loc) ? parsed.loc : null;
      const file = loc && typeof loc.file === "string" ? loc.file : typeof parsed.id === "string" ? parsed.id : null;
      const position =
        loc && typeof loc.line === "number"
          ? `:${String(loc.line)}:${String(typeof loc.column === "number" ? loc.column : 0)}`
          : "";
      const frame = typeof parsed.frame === "string" ? `\n${parsed.frame.trimEnd()}` : "";
      return `${plugin}${parsed.message}${file ? `\n  File: ${file}${position}` : ""}${frame}`;
    }
  }
  const text = body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

/** JSON.parse of the longest prefix ending in "}" that parses (the greedy match may include trailing code). */
function parseLeadingJsonObject(text: string): unknown {
  let end = text.length;
  while (end > 0) {
    const candidate = text.slice(0, end);
    try {
      return JSON.parse(candidate);
    } catch {
      end = candidate.lastIndexOf("}", candidate.length - 2) + 1;
    }
  }
  return null;
}

export interface FormatRenderErrorInput {
  kind: RenderFailureKind;
  headline: string; // e.g. report.message or the timeout sentence
  stack: string | null;
  componentStack: string | null;
  serverErrors: string[]; // parsed Vite error responses + error logs in the render window
  consoleErrors: string[];
  viteOrigin: string | null;
  mockLabels: ReadonlyMap<string, string>; // hash → specifier for this item
  /** Absolute prefixes (worktree dirs, the clone) stripped so paths are repo-relative. */
  stripPaths?: readonly string[];
  /** Angular harness: requests without an HTTP fixture (15 §5.7.4); section omitted when empty (React). */
  httpUnmatched?: readonly string[];
}

const TRUNCATION_SUFFIX = "… (truncated)";
const MAX_SECTION_LINES = 12;
const MAX_SERVER_ERRORS = 5;
const MAX_CONSOLE_ERRORS = 5;

function firstLines(text: string, count: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(0, count);
}

/** Truncates to `max` characters with a trailing "… (truncated)". */
export function truncateRenderError(text: string, max: number = RENDER_ERROR_MAX_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`;
}

/**
 * Formats a render failure (10 §5.12.3). Sections are omitted when empty; the text is normalized (origin and
 * absolute paths removed, mock ids readable, secrets redacted) and truncated to RENDER_ERROR_MAX_CHARS.
 *
 * @param input - Failure kind, headline and collected evidence.
 * @returns The formatted error (also the `HarnessRenderError.message` passed to repair).
 */
export function formatRenderError(input: FormatRenderErrorInput): string {
  const lines: string[] = [`[${input.kind}] ${input.headline}`];
  const serverErrors = [...new Set(input.serverErrors.map((error) => error.trim()).filter((error) => error !== ""))];
  if (serverErrors.length > 0) {
    lines.push("Vite:");
    for (const error of serverErrors.slice(0, MAX_SERVER_ERRORS)) {
      const [first = "", ...rest] = error.split("\n");
      lines.push(`- ${first}`);
      for (const line of rest) {
        lines.push(line.startsWith("  ") ? line : `  ${line}`);
      }
    }
  }
  if (input.stack !== null && input.stack.trim() !== "") {
    lines.push("Stack:");
    for (const line of firstLines(input.stack, MAX_SECTION_LINES)) {
      lines.push(`  ${line.trim()}`);
    }
  }
  if (input.componentStack !== null && input.componentStack.trim() !== "") {
    lines.push("Component stack:");
    for (const line of firstLines(input.componentStack, MAX_SECTION_LINES)) {
      lines.push(`  ${line.trim()}`);
    }
  }
  const consoleErrors = input.consoleErrors.filter((error) => error.trim() !== "");
  if (consoleErrors.length > 0) {
    lines.push("Console errors:");
    for (const error of consoleErrors.slice(0, MAX_CONSOLE_ERRORS)) {
      lines.push(`- ${error.split("\n")[0] ?? ""}`);
    }
  }
  const httpUnmatched = (input.httpUnmatched ?? []).filter((entry) => entry.trim() !== "");
  if (httpUnmatched.length > 0) {
    lines.push("HTTP without fixture:");
    for (const entry of httpUnmatched) {
      lines.push(`- ${entry}`);
    }
  }
  const normalized = normalizeErrorText(
    rewriteMockIds(lines.join("\n"), input.mockLabels),
    input.viteOrigin,
    input.stripPaths ?? []
  );
  return truncateRenderError(redactSecrets(normalized));
}

/** First line of a formatted error without its "[kind] " prefix (console event text). */
export function errorSummaryLine(formatted: string): string {
  const first = formatted.split("\n")[0] ?? "";
  return first.replace(/^\[[a-z_]+\]\s*/, "");
}
