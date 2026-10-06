/**
 * Browser-side scripts (10 §5.11): the determinism init script and the in-page functions evaluated by the
 * browser session. They are plain JavaScript source strings (the backend has no DOM typings); each evaluation
 * result is validated by a type guard before use.
 */
import { isRecord } from "./render-types";

/** Seeded Math.random, zeroed transitions, hidden caret and Vite overlay (10 §5.11.3). */
export function buildDeterminismInitScript(seed: number): string {
  return `(() => {
  let state = ${String(seed >>> 0)};
  Math.random = function prvisionRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const css = "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}vite-error-overlay{display:none!important}";
  const install = () => {
    if (document.getElementById("prvision-determinism")) return;
    const style = document.createElement("style");
    style.id = "prvision-determinism";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.documentElement) install(); else document.addEventListener("DOMContentLoaded", install, { once: true });
})();`;
}

// ---------------------------------------------------------------------------------------------------------------
// readHarnessState
// ---------------------------------------------------------------------------------------------------------------

export interface HarnessErrorReport {
  phase: "import" | "mount" | "render";
  message: string;
  stack: string | null;
  componentStack: string | null;
}

export interface HarnessState {
  status: string | null;
  ready: boolean;
  error: HarnessErrorReport | null;
  /** Angular harness (15 §5.7.2): ApplicationRef never became stable within settleMax. React pages: false. */
  unstable: boolean;
  /** Angular harness: inputs the harness sets that this side does not declare. React pages: []. */
  skippedInputs: string[];
  /** Angular harness: HTTP requests without a fixture (at most 10, each ≤ 200 chars). React pages: []. */
  httpUnmatched: string[];
}

/** Bounds of the Angular harness lists read from the page (15 §5.7.4). */
export const HARNESS_HTTP_UNMATCHED_MAX = 10;
export const HARNESS_HTTP_UNMATCHED_MAX_CHARS = 200;
export const HARNESS_SKIPPED_INPUTS_MAX = 50;
export const HARNESS_SKIPPED_INPUT_MAX_CHARS = 100;

/** Expression reading the `window.__PRVISION_*__` globals set by the harness entry. */
export const READ_HARNESS_STATE_SCRIPT = `(() => {
  const error = window.__PRVISION_ERROR__;
  const strings = (value, max, maxChars) =>
    Array.isArray(value) ? value.slice(0, max).map((entry) => String(entry).slice(0, maxChars)) : [];
  return {
    status: typeof window.__PRVISION_STATUS__ === "string" ? window.__PRVISION_STATUS__ : null,
    ready: window.__PRVISION_READY__ === true,
    error: error && typeof error === "object"
      ? {
          phase: String(error.phase),
          message: String(error.message),
          stack: typeof error.stack === "string" ? error.stack : null,
          componentStack: typeof error.componentStack === "string" ? error.componentStack : null,
        }
      : null,
    unstable: window.__PRVISION_UNSTABLE__ === true,
    skippedInputs: strings(window.__PRVISION_SKIPPED_INPUTS__, ${String(HARNESS_SKIPPED_INPUTS_MAX)}, ${String(HARNESS_SKIPPED_INPUT_MAX_CHARS)}),
    httpUnmatched: strings(window.__PRVISION_HTTP_UNMATCHED__, ${String(HARNESS_HTTP_UNMATCHED_MAX)}, ${String(HARNESS_HTTP_UNMATCHED_MAX_CHARS)}),
  };
})()`;

function isHarnessErrorReport(value: unknown): value is HarnessErrorReport {
  return (
    isRecord(value) &&
    (value.phase === "import" || value.phase === "mount" || value.phase === "render") &&
    typeof value.message === "string" &&
    (typeof value.stack === "string" || value.stack === null) &&
    (typeof value.componentStack === "string" || value.componentStack === null)
  );
}

function boundedStrings(value: unknown, max: number, maxChars: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, max)
        .map((entry) => entry.slice(0, maxChars))
    : [];
}

/** Validates the result of READ_HARNESS_STATE_SCRIPT (unknown phases count as "mount"; absent lists are []). */
export function toHarnessState(value: unknown): HarnessState {
  if (!isRecord(value)) {
    return { status: null, ready: false, error: null, unstable: false, skippedInputs: [], httpUnmatched: [] };
  }
  let error: HarnessErrorReport | null = null;
  if (isHarnessErrorReport(value.error)) {
    error = value.error;
  } else if (isRecord(value.error) && typeof value.error.message === "string") {
    error = { phase: "mount", message: value.error.message, stack: null, componentStack: null };
  }
  return {
    status: typeof value.status === "string" ? value.status : null,
    ready: value.ready === true,
    error,
    unstable: value.unstable === true,
    skippedInputs: boundedStrings(value.skippedInputs, HARNESS_SKIPPED_INPUTS_MAX, HARNESS_SKIPPED_INPUT_MAX_CHARS),
    httpUnmatched: boundedStrings(value.httpUnmatched, HARNESS_HTTP_UNMATCHED_MAX, HARNESS_HTTP_UNMATCHED_MAX_CHARS)
  };
}

// ---------------------------------------------------------------------------------------------------------------
// measureCapture (10 §5.11.7)
// ---------------------------------------------------------------------------------------------------------------

export interface CaptureArgs {
  padding: number;
  maxHeight: number;
  rootId: string;
}

export interface ClipRect {
  x: 0;
  y: 0;
  width: number;
  height: number;
}

export interface CaptureMeasurement {
  mode: "content" | "viewport" | "empty";
  clip: ClipRect;
  truncated: boolean;
  hasPortalContent: boolean;
}

const MEASURE_CAPTURE_FUNCTION = `(args) => {
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT", "VITE-ERROR-OVERLAY"]);
  const REPLACED = new Set(["IMG", "CANVAS", "VIDEO", "IFRAME", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "PROGRESS", "METER", "OBJECT", "EMBED", "HR"]);
  const MAX_NODES = 20000;
  const root = document.getElementById(args.rootId);
  const scopes = [];
  if (root) scopes.push(root);
  for (const child of Array.from(document.body ? document.body.children : [])) {
    if (child === root || SKIP_TAGS.has(child.tagName) || child.id === "prvision-determinism") continue;
    scopes.push(child);
  }
  const parseAlpha = (a) => (a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a));
  const alpha = (color) => {
    if (!color || color === "transparent") return 0;
    const slash = /\\/\\s*([0-9.]+%?)\\s*\\)\\s*$/.exec(color);
    if (slash) return parseAlpha(slash[1]);
    const match = /rgba?\\(([^)]*)\\)/.exec(color);
    if (!match) return 1;
    const parts = match[1].split(/[,\\s]+/).filter(Boolean);
    return parts.length < 4 ? 1 : parseAlpha(parts[3]);
  };
  const bordersPaint = (style) => {
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const width = parseFloat(style["border" + side + "Width"]) || 0;
      const kind = style["border" + side + "Style"];
      if (width > 0 && kind !== "none" && kind !== "hidden" && alpha(style["border" + side + "Color"]) > 0) return true;
    }
    return false;
  };
  const boxPaints = (style) =>
    alpha(style.backgroundColor) > 0 ||
    (style.backgroundImage && style.backgroundImage !== "none") ||
    bordersPaint(style);
  const pseudoPaints = (element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    const content = style.content;
    if (!content || content === "none" || content === "normal") return false;
    return boxPaints(style);
  };
  const paints = (element, style) => {
    if (REPLACED.has(element.tagName) || element instanceof SVGSVGElement) return true;
    if (boxPaints(style)) return true;
    if (style.boxShadow && style.boxShadow !== "none") return true;
    if (style.outlineStyle && style.outlineStyle !== "none" && (parseFloat(style.outlineWidth) || 0) > 0) return true;
    return pseudoPaints(element, "::before") || pseudoPaints(element, "::after");
  };
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const viewportArea = window.innerWidth * window.innerHeight;
  let maxRight = 0;
  let maxBottom = 0;
  let found = false;
  let hasPortalContent = false;
  let forceViewport = false;
  let visited = 0;
  const addRect = (rect, inPortal) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const right = rect.right + scrollX;
    const bottom = rect.bottom + scrollY;
    if (right <= 0 || bottom <= 0) return;
    found = true;
    if (inPortal) hasPortalContent = true;
    if (right > maxRight) maxRight = right;
    if (bottom > maxBottom) maxBottom = bottom;
  };
  for (let index = 0; index < scopes.length && visited < MAX_NODES; index += 1) {
    const scope = scopes[index];
    const inPortal = scope !== root;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (getComputedStyle(node).display === "none") return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.currentNode;
    const visit = (current) => {
      visited += 1;
      if (current.nodeType === Node.TEXT_NODE) {
        if (!current.textContent || current.textContent.trim() === "") return;
        const parent = current.parentElement;
        if (parent && getComputedStyle(parent).visibility === "hidden") return;
        const range = document.createRange();
        range.selectNodeContents(current);
        for (const rect of Array.from(range.getClientRects())) addRect(rect, inPortal);
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) return;
      if (current === root) return;
      const style = getComputedStyle(current);
      if (style.visibility === "hidden" || parseFloat(style.opacity) <= 0) return;
      if (!paints(current, style)) return;
      const rect = current.getBoundingClientRect();
      addRect(rect, inPortal);
      if (style.position === "fixed" && rect.width * rect.height >= 0.25 * viewportArea) forceViewport = true;
    };
    if (scope.nodeType === Node.ELEMENT_NODE && getComputedStyle(scope).display === "none") continue;
    visit(node);
    while (visited < MAX_NODES && (node = walker.nextNode())) visit(node);
  }
  const docWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  let mode;
  let width;
  let height;
  if (forceViewport) {
    mode = "viewport";
    width = window.innerWidth;
    height = Math.max(window.innerHeight, Math.ceil(maxBottom + args.padding));
  } else if (!found) {
    mode = "empty";
    width = Math.min(window.innerWidth, 320);
    height = 64;
  } else {
    mode = "content";
    width = Math.min(docWidth, Math.ceil(maxRight + args.padding));
    height = Math.min(docHeight, Math.ceil(maxBottom + args.padding));
  }
  let truncated = false;
  if (height > args.maxHeight) {
    height = args.maxHeight;
    truncated = true;
  }
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  return { mode, clip: { x: 0, y: 0, width, height }, truncated, hasPortalContent };
}`;

/** Expression measuring the painted area for `args` (10 §5.11.7). */
export function measureCaptureScript(args: CaptureArgs): string {
  return `(${MEASURE_CAPTURE_FUNCTION})(${JSON.stringify(args)})`;
}

/** Validates a CaptureMeasurement returned by the page. */
export function toCaptureMeasurement(value: unknown): CaptureMeasurement | null {
  if (!isRecord(value) || !isRecord(value.clip)) {
    return null;
  }
  const { mode, truncated, hasPortalContent } = value;
  const { width, height } = value.clip;
  if (
    (mode !== "content" && mode !== "viewport" && mode !== "empty") ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  return {
    mode,
    clip: { x: 0, y: 0, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) },
    truncated: truncated === true,
    hasPortalContent: hasPortalContent === true
  };
}

// ---------------------------------------------------------------------------------------------------------------
// collectTimeoutDiagnostics, detectStylesheetHealth
// ---------------------------------------------------------------------------------------------------------------

export interface TimeoutDiagnostics {
  status: string | null;
  rootChildCount: number;
  rootTextSample: string;
}

/** Expression returning the harness phase and what `#prvision-root` contains. */
export const COLLECT_TIMEOUT_DIAGNOSTICS_SCRIPT = `(() => {
  const root = document.getElementById("prvision-root");
  return {
    status: typeof window.__PRVISION_STATUS__ === "string" ? window.__PRVISION_STATUS__ : null,
    rootChildCount: root ? root.childElementCount : 0,
    rootTextSample: root ? (root.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200) : "",
  };
})()`;

/** Validates TimeoutDiagnostics. */
export function toTimeoutDiagnostics(value: unknown): TimeoutDiagnostics {
  if (!isRecord(value)) {
    return { status: null, rootChildCount: 0, rootTextSample: "" };
  }
  return {
    status: typeof value.status === "string" ? value.status : null,
    rootChildCount: typeof value.rootChildCount === "number" ? value.rootChildCount : 0,
    rootTextSample: typeof value.rootTextSample === "string" ? value.rootTextSample : ""
  };
}

export interface StylesheetHealth {
  ruleCount: number;
  hasUtilitySelector: boolean;
}

/** Expression counting CSS rules (recursing into grouping rules, cap 20 000) and looking for a utility selector. */
export const DETECT_STYLESHEET_HEALTH_SCRIPT = `(() => {
  const UTILITY = /^\\.(?:[a-z0-9-]+\\\\?:)*(?:flex|grid|block|hidden|p[trblxy]?-|m[trblxy]?-|text-|bg-|w-|h-)/;
  const MAX_RULES = 20000;
  let ruleCount = 0;
  let hasUtilitySelector = false;
  const walk = (rules) => {
    for (const rule of Array.from(rules)) {
      if (ruleCount >= MAX_RULES) return;
      ruleCount += 1;
      if (!hasUtilitySelector && typeof rule.selectorText === "string") {
        for (const selector of rule.selectorText.split(",")) {
          if (UTILITY.test(selector.trim())) { hasUtilitySelector = true; break; }
        }
      }
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode && sheet.ownerNode.id === "prvision-determinism") continue;
    if (sheet.ownerNode && sheet.ownerNode.id === "prvision-base-style") continue;
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (rules) walk(rules);
  }
  return { ruleCount, hasUtilitySelector };
})()`;

/** Validates StylesheetHealth. */
export function toStylesheetHealth(value: unknown): StylesheetHealth {
  if (!isRecord(value)) {
    return { ruleCount: 0, hasUtilitySelector: false };
  }
  return {
    ruleCount: typeof value.ruleCount === "number" ? value.ruleCount : 0,
    hasUtilitySelector: value.hasUtilitySelector === true
  };
}
