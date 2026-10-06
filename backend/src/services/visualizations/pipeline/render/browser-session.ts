/**
 * Playwright browser session (10 §5.11): one Chromium per job, a fresh context per (component, side, attempt),
 * deterministic environment, network blocking, waiting for the harness ready signal, painted-area capture
 * (portals included) and a two-identical-frames stability loop before the PNG is written.
 */
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request,
  type Response
} from "playwright";
import {
  BROWSER_CLOSE_TIMEOUT_MS,
  RENDER_ASSET_WAIT_MS,
  RENDER_CAPTURE_PADDING_PX,
  RENDER_CONSOLE_ERRORS_MAX,
  RENDER_CONSOLE_ERROR_MAX_CHARS,
  RENDER_FIXED_TIME_ISO,
  RENDER_MAX_CAPTURE_HEIGHT_PX,
  RENDER_MODULE_ERROR_GRACE_MS,
  RENDER_RANDOM_SEED,
  RENDER_SETTLE_MAX_MS,
  RENDER_SETTLE_QUIET_MS,
  RENDER_STABILITY_INTERVAL_MS,
  RENDER_STABILITY_MAX_ATTEMPTS,
  RENDER_VIEWPORT
} from "../../../../config-consts";
import { createLogger, getErrorMessage } from "../../../../utilities";
import { blockBrowserContextMediaPermissions, browserContextWithBlockedMedia } from "./browser-media-permissions";
import {
  buildDeterminismInitScript,
  COLLECT_TIMEOUT_DIAGNOSTICS_SCRIPT,
  DETECT_STYLESHEET_HEALTH_SCRIPT,
  measureCaptureScript,
  READ_HARNESS_STATE_SCRIPT,
  toCaptureMeasurement,
  toHarnessState,
  toStylesheetHealth,
  toTimeoutDiagnostics,
  type CaptureMeasurement,
  type ClipRect,
  type HarnessErrorReport,
  type HarnessState,
  type TimeoutDiagnostics
} from "./page-scripts";
import {
  extractViteErrorFromBody,
  formatRenderError,
  headlineFor,
  isOptimizeDepsChurn,
  timeoutHeadline
} from "./render-errors";
import type { PageRenderInput, PageRenderOutcome, RenderFailureKind } from "./render-types";

const log = createLogger("render");

export const CHROMIUM_LAUNCH_ARGS: readonly string[] = [
  "--font-render-hinting=none",
  "--disable-font-subpixel-positioning",
  "--disable-lcd-text",
  "--force-color-profile=srgb",
  "--hide-scrollbars",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--mute-audio"
];

const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
const HARNESS_POLL_INTERVAL_MS = 100;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const MAX_SERVER_ERRORS = 5;
const BLOCKED_SAMPLE_MAX = 5;
const EMPTY_HARNESS_ROOT_ID = "prvision-root";

/** Chromium could not be launched (fatal for the render stage). */
export class BrowserLaunchError extends Error {
  override readonly name = "BrowserLaunchError";

  constructor(
    readonly userMessage: string,
    readonly detail: string
  ) {
    super(userMessage);
  }
}

/** Context options for every render (10 §5.11.3): fixed viewport, scale 1, reduced motion, en-US, UTC. */
export function buildContextOptions(
  viewport: { width: number; height: number; mobile: boolean } = { ...RENDER_VIEWPORT, mobile: false }
): BrowserContextOptions {
  return browserContextWithBlockedMedia({
    viewport: { width: viewport.width, height: viewport.height },
    screen: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    reducedMotion: "reduce",
    colorScheme: "light",
    forcedColors: "none",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    acceptDownloads: false,
    javaScriptEnabled: true
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Network policy (10 §5.11.4)
// ---------------------------------------------------------------------------------------------------------------

export type RouteDecision =
  | { action: "continue" }
  | { action: "abort" }
  | { action: "fulfill"; status: 200; contentType: string; body: string | Buffer };

export const TRANSPARENT_PNG_1X1: Buffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/**
 * Decides what happens to a page request: same-origin, data: and blob: continue; off-origin requests never
 * leave the machine (deterministic stand-ins or abort).
 */
export function decideRoute(requestUrl: string, resourceType: string, viteOrigin: string): RouteDecision {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return { action: "abort" };
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
    return { action: "continue" };
  }
  if (parsed.origin === viteOrigin) {
    return { action: "continue" };
  }
  switch (resourceType) {
    case "image":
      return { action: "fulfill", status: 200, contentType: "image/png", body: TRANSPARENT_PNG_1X1 };
    case "stylesheet":
      return { action: "fulfill", status: 200, contentType: "text/css", body: "" };
    case "script":
      return { action: "fulfill", status: 200, contentType: "text/javascript", body: "" };
    case "document":
      return {
        action: "fulfill",
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>blocked by PRVision</title>"
      };
    case "font":
    case "media":
      return { action: "abort" };
    default:
      return { action: "fulfill", status: 200, contentType: "application/json", body: "{}" }; // fetch, xhr, eventsource, other
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/** Width and height from a PNG's IHDR chunk. */
export function readPngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Not a PNG image");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** True when two clip rectangles are identical. */
export function sameClip(a: ClipRect, b: ClipRect): boolean {
  return a.width === b.width && a.height === b.height; // x and y are always 0 (top-left anchored)
}

/** `${origin}${harnessUrlPath}?c=<id>&quiet=…&settleMax=…&assetWait=…` (10 §5.7.6). */
export function harnessUrl(origin: string, harnessUrlPath: string, componentId: number): string {
  return `${origin}${harnessUrlPath}?c=${String(componentId)}&quiet=${String(RENDER_SETTLE_QUIET_MS)}&settleMax=${String(
    RENDER_SETTLE_MAX_MS
  )}&assetWait=${String(RENDER_ASSET_WAIT_MS)}`;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isClosedError(error: unknown): boolean {
  return /Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|Target crashed|Page crashed/i.test(
    getErrorMessage(error)
  );
}

type HarnessSignal =
  | { kind: "ready"; state: HarnessState }
  | { kind: "error"; report: HarnessErrorReport }
  | { kind: "module_error" }
  | { kind: "infra"; reason: string }
  | { kind: "timeout"; diagnostics: TimeoutDiagnostics }
  | { kind: "cancelled" };

interface PageEvidence {
  /** Angular harness: requests without an HTTP fixture, from the last harness state read (15 §5.7.4). */
  httpUnmatched: string[];
  consoleErrors: string[];
  serverErrors: string[];
  firstModuleErrorAt: number | null;
  crashed: boolean;
  blockedRequests: number;
  blockedSamples: string[];
  bodyReads: Array<Promise<void>>;
}

/** One Chromium per job; contexts are created per render and always closed. */
export class BrowserSession {
  private connected = true;
  private readonly contexts = new Set<BrowserContext>();

  private constructor(private readonly browser: Browser) {
    browser.on("disconnected", () => {
      this.connected = false;
    });
  }

  /**
   * Launches headless Chromium with the determinism flags.
   *
   * @throws BrowserLaunchError with an install hint when Chromium is missing.
   */
  static async launch(): Promise<BrowserSession> {
    try {
      const browser = await chromium.launch({
        headless: true,
        args: [...CHROMIUM_LAUNCH_ARGS],
        timeout: BROWSER_LAUNCH_TIMEOUT_MS
      });
      return new BrowserSession(browser);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      const userMessage = /Executable doesn't exist|playwright install/i.test(message)
        ? "Chromium for Playwright is not installed. Run `npx playwright install chromium` in the PRVision folder."
        : `Chromium could not be started: ${message.split("\n")[0] ?? message}`;
      throw new BrowserLaunchError(userMessage, message);
    }
  }

  /** False after Chromium disconnected (crash or close). */
  isConnected(): boolean {
    return this.connected && this.browser.isConnected();
  }

  /** Closes every open render context (used on abort). Never throws. */
  async closeAllContexts(): Promise<void> {
    const open = [...this.contexts];
    this.contexts.clear();
    await Promise.all(
      open.map(async (context) => {
        try {
          await context.close();
        } catch {
          // Already closed.
        }
      })
    );
  }

  /** Closes the browser, bounded by BROWSER_CLOSE_TIMEOUT_MS. Never throws. */
  async close(): Promise<void> {
    await this.closeAllContexts();
    try {
      const closed = (async (): Promise<boolean> => {
        try {
          await this.browser.close();
        } catch {
          // Already closed or crashed.
        }
        return true;
      })();
      const finished = await Promise.race([closed, delay(BROWSER_CLOSE_TIMEOUT_MS, false, { ref: false })]);
      if (!finished) {
        log.warn({ event: "render.cleanup.failed", error: "browser close timed out" }, "Closing Chromium timed out");
      }
    } catch (error) {
      log.warn({ event: "render.cleanup.failed", err: error }, "Closing Chromium failed");
    }
    this.connected = false;
  }

  /**
   * Renders one component on one side and writes the PNG atomically to `input.outputPath`. Never throws.
   *
   * @param input - Host, component, budget, output path and signal.
   * @returns The outcome (ok with size and capture details, or a classified failure).
   */
  async renderComponent(input: PageRenderInput): Promise<PageRenderOutcome> {
    const startedAt = Date.now();
    const deadline = startedAt + input.timeoutMs;
    const seqAtStart = input.host.currentSeq();
    const evidence = newEvidence();
    const elapsed = (): number => Date.now() - startedAt;
    const remaining = (): number => Math.max(1, deadline - Date.now());

    const fail = (
      kind: RenderFailureKind,
      detail: string,
      extra: { stack?: string | null; componentStack?: string | null; infraRetryable?: boolean } = {}
    ): PageRenderOutcome => {
      const serverErrors = this.collectServerErrors(input, seqAtStart, evidence);
      return {
        ok: false,
        kind,
        error: formatRenderError({
          kind,
          headline: headlineFor(kind, detail),
          stack: extra.stack ?? null,
          componentStack: extra.componentStack ?? null,
          serverErrors,
          consoleErrors: evidence.consoleErrors,
          viteOrigin: input.host.origin,
          mockLabels: input.mockLabels ?? new Map<string, string>(),
          stripPaths: input.stripPaths ?? [],
          httpUnmatched: evidence.httpUnmatched
        }),
        consoleErrors: [...evidence.consoleErrors],
        durationMs: elapsed(),
        infraRetryable: extra.infraRetryable ?? false
      };
    };
    const cancelledOutcome = (): PageRenderOutcome => ({
      ok: false,
      kind: "cancelled",
      error: "[cancelled] Cancelled.",
      consoleErrors: [...evidence.consoleErrors],
      durationMs: elapsed(),
      infraRetryable: false
    });

    if (isAborted(input.signal)) {
      return cancelledOutcome();
    }
    if (!this.isConnected()) {
      return fail("browser", "Chromium is not connected.", { infraRetryable: true });
    }

    let context: BrowserContext | null = null;
    const onAbort = (): void => {
      const current = context;
      if (current !== null) {
        this.contexts.delete(current);
        current.close().catch(() => undefined);
      }
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      context = await this.browser.newContext(buildContextOptions(input.viewport));
      this.contexts.add(context);
      const page = await this.preparePage(context, input, evidence, remaining());

      try {
        await page.goto(harnessUrl(input.host.origin, input.host.harnessUrlPath, input.componentId), {
          waitUntil: "domcontentloaded",
          timeout: remaining()
        });
      } catch (error) {
        if (isAborted(input.signal)) {
          return cancelledOutcome();
        }
        if (evidence.crashed || isClosedError(error)) {
          return fail("browser", getErrorMessage(error).split("\n")[0] ?? "Target closed", { infraRetryable: true });
        }
        const hostDown = input.host.isAlive() ? "" : ` (Vite ${input.host.exitReason() ?? "exited"})`;
        return fail("navigation", `${getErrorMessage(error).split("\n")[0] ?? ""}${hostDown}`);
      }

      const signal = await this.waitForHarnessSignal(page, input, deadline, evidence);
      await Promise.all(evidence.bodyReads);
      switch (signal.kind) {
        case "cancelled":
          return cancelledOutcome();
        case "error": {
          const kind: RenderFailureKind = signal.report.phase === "import" ? "module_load" : "render_error";
          const churn =
            kind === "module_load" &&
            input.host.sawDepsReoptimizeSince(seqAtStart) &&
            isOptimizeDepsChurn(signal.report.message);
          return fail(kind, signal.report.message, {
            stack: signal.report.stack,
            componentStack: signal.report.componentStack,
            infraRetryable: churn
          });
        }
        case "module_error": {
          const first = evidence.serverErrors[0] ?? "A module of the harness page failed to load.";
          const churn =
            input.host.sawDepsReoptimizeSince(seqAtStart) &&
            evidence.serverErrors.some((error) => isOptimizeDepsChurn(error));
          return fail("module_load", first.split("\n")[0] ?? first, { infraRetryable: churn });
        }
        case "infra":
          if (!input.host.isAlive()) {
            return fail("navigation", `The Vite dev server stopped while rendering (${signal.reason}).`);
          }
          return fail("browser", signal.reason, { infraRetryable: true });
        case "timeout":
          return fail("timeout", timeoutHeadline(input.timeoutMs, signal.diagnostics));
        case "ready":
          break;
      }
      const harnessState = signal.state;

      // Capture.
      let captured: { buffer: Buffer; measurement: CaptureMeasurement; stable: boolean };
      try {
        captured = await this.captureStable(page, deadline, input.viewport ?? RENDER_VIEWPORT);
        await fs.writeFile(`${input.outputPath}.tmp`, captured.buffer);
        await fs.rename(`${input.outputPath}.tmp`, input.outputPath);
      } catch (error) {
        await fs.rm(`${input.outputPath}.tmp`, { force: true });
        if (isAborted(input.signal)) {
          return cancelledOutcome();
        }
        if (evidence.crashed || isClosedError(error)) {
          return fail("browser", getErrorMessage(error).split("\n")[0] ?? "Target closed", { infraRetryable: true });
        }
        return fail("screenshot", getErrorMessage(error).split("\n")[0] ?? "");
      }
      const size = readPngSize(captured.buffer);
      const stylesheetWarning = await this.stylesheetWarning(page, input);
      log.debug(
        {
          event: "render.page.completed",
          componentId: input.componentId,
          side: input.host.side,
          durationMs: elapsed(),
          mode: captured.measurement.mode,
          stable: captured.stable,
          blockedRequests: evidence.blockedRequests,
          blockedSamples: evidence.blockedSamples,
          width: size.width,
          height: size.height
        },
        "Page rendered"
      );
      return {
        ok: true,
        width: size.width,
        height: size.height,
        mode: captured.measurement.mode,
        stable: captured.stable,
        truncated: captured.measurement.truncated,
        consoleErrors: [...evidence.consoleErrors],
        durationMs: elapsed(),
        blockedRequests: evidence.blockedRequests,
        stylesheetWarning,
        unstable: harnessState.unstable,
        skippedInputs: harnessState.skippedInputs,
        httpUnmatched: harnessState.httpUnmatched
      };
    } catch (error) {
      if (isAborted(input.signal)) {
        return cancelledOutcome();
      }
      if (evidence.crashed || isClosedError(error)) {
        return fail("browser", getErrorMessage(error).split("\n")[0] ?? "Target closed", { infraRetryable: true });
      }
      return fail("navigation", getErrorMessage(error).split("\n")[0] ?? "");
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      const current = context;
      if (current !== null) {
        this.contexts.delete(current);
        try {
          await current.close();
        } catch {
          // Already closed (abort or crash).
        }
      }
    }
  }

  private async preparePage(
    context: BrowserContext,
    input: PageRenderInput,
    evidence: PageEvidence,
    timeoutMs: number
  ): Promise<Page> {
    const origin = input.host.origin;
    const viteHost = new URL(origin).host;
    await blockBrowserContextMediaPermissions(context);
    await context.addInitScript({ content: buildDeterminismInitScript(RENDER_RANDOM_SEED) });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const decision = decideRoute(request.url(), request.resourceType(), origin);
      try {
        if (decision.action === "continue") {
          await route.continue();
          return;
        }
        evidence.blockedRequests += 1;
        if (evidence.blockedSamples.length < BLOCKED_SAMPLE_MAX) {
          evidence.blockedSamples.push(stripQuery(request.url()));
        }
        if (decision.action === "abort") {
          await route.abort("blockedbyclient");
        } else {
          await route.fulfill({ status: decision.status, contentType: decision.contentType, body: decision.body });
        }
      } catch {
        // The context was closed while the request was in flight.
      }
    });
    await context.routeWebSocket(
      (url) => url.host !== viteHost,
      (ws) => {
        ws.close().catch(() => undefined);
      }
    );
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.clock.setFixedTime(new Date(RENDER_FIXED_TIME_ISO));

    page.on("console", (message) => {
      if (message.type() !== "error") {
        return;
      }
      const text = message.text();
      if (text.startsWith("[vite]") || /Download the React DevTools/.test(text)) {
        return;
      }
      if (!PRINTF_PLACEHOLDER.test(text)) {
        pushCapped(evidence.consoleErrors, text);
        return;
      }
      // React 19 logs `console.error("%o\n\n%s…", error, …)`; substitute the arguments so the text is readable.
      evidence.bodyReads.push(
        (async (): Promise<void> => {
          const values = await Promise.all(
            message
              .args()
              .slice(1)
              .map(async (arg) => {
                try {
                  return await arg.evaluate((value: unknown) =>
                    value instanceof Error ? value.message : typeof value === "string" ? value : String(value)
                  );
                } catch {
                  return "";
                }
              })
          );
          let index = 0;
          const formatted = text
            .replace(new RegExp(PRINTF_PLACEHOLDER.source, "g"), (placeholder) => {
              const value = values[index] ?? "";
              index += 1;
              return placeholder === "%c" ? "" : value;
            })
            .trim();
          if (formatted !== "" && !isPlaceholderOnly(formatted)) {
            pushCapped(evidence.consoleErrors, formatted);
          }
        })()
      );
    });
    page.on("pageerror", (error) => {
      pushCapped(evidence.consoleErrors, `pageerror: ${error.message}`);
    });
    page.on("response", (response: Response) => {
      this.onResponse(response, origin, evidence);
    });
    page.on("requestfailed", (request: Request) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(request.url()).origin === origin;
      } catch {
        sameOrigin = false;
      }
      if (sameOrigin) {
        const failure = request.failure()?.errorText ?? "request failed";
        const pathname = stripQuery(request.url()).slice(origin.length) || "/";
        evidence.serverErrors.push(`${pathname}: ${failure}`);
      }
    });
    page.on("crash", () => {
      evidence.crashed = true;
    });
    return page;
  }

  private onResponse(response: Response, origin: string, evidence: PageEvidence): void {
    const status = response.status();
    if (status < 400) {
      return;
    }
    let sameOrigin = false;
    try {
      sameOrigin = new URL(response.url()).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      return;
    }
    const resourceType = response.request().resourceType();
    // Component fetches to unknown same-origin paths get Vite's deterministic 404; only server errors on
    // fetch count as module failures (a 404 on a script or stylesheet does).
    const isModuleResource = resourceType === "script" || resourceType === "stylesheet";
    if (!isModuleResource && !(resourceType === "fetch" && status >= 500)) {
      return;
    }
    evidence.firstModuleErrorAt ??= Date.now();
    const pathname = stripQuery(response.url()).slice(origin.length) || "/";
    evidence.bodyReads.push(
      (async (): Promise<void> => {
        try {
          const body = await response.body();
          const parsed = extractViteErrorFromBody(body.subarray(0, ERROR_BODY_MAX_BYTES).toString("utf8"));
          evidence.serverErrors.push(parsed ?? `${pathname}: HTTP ${String(status)}`);
        } catch {
          evidence.serverErrors.push(`${pathname}: HTTP ${String(status)}`);
        }
      })()
    );
  }

  /**
   * Parsed Vite error responses plus Vite error logs of this render window, de-duplicated; bare transport
   * entries ("<path>: HTTP 500", "<path>: net::ERR_ABORTED") go last.
   */
  private collectServerErrors(input: PageRenderInput, seqAtStart: number, evidence: PageEvidence): string[] {
    const errors: string[] = [];
    const seen = (text: string): boolean =>
      errors.some((existing) => existing.includes(text) || text.includes(existing));
    const transport: string[] = [];
    for (const entry of evidence.serverErrors) {
      if (TRANSPORT_ERROR_PATTERN.test(entry)) {
        transport.push(entry);
      } else if (!seen(entry)) {
        errors.push(entry);
      }
    }
    for (const entry of input.host.logsSince(seqAtStart, "error")) {
      const message = compactServerLog(entry.message);
      if (message === "") {
        continue;
      }
      const firstLine = message.split("\n")[0] ?? message;
      const core = firstLine.replace(/^.*?(Internal server error|Pre-transform error):\s*/i, "");
      if (!errors.some((existing) => existing.includes(core)) && !seen(message)) {
        errors.push(message);
      }
    }
    for (const entry of transport) {
      if (!seen(entry)) {
        errors.push(entry);
      }
    }
    return errors.slice(0, MAX_SERVER_ERRORS);
  }

  private async waitForHarnessSignal(
    page: Page,
    input: PageRenderInput,
    deadline: number,
    evidence: PageEvidence
  ): Promise<HarnessSignal> {
    for (;;) {
      if (isAborted(input.signal)) {
        return { kind: "cancelled" };
      }
      let state: HarnessState = toHarnessState(null);
      try {
        state = toHarnessState(await page.evaluate(READ_HARNESS_STATE_SCRIPT));
        evidence.httpUnmatched = state.httpUnmatched;
      } catch (error) {
        if (isAborted(input.signal)) {
          return { kind: "cancelled" };
        }
        if (evidence.crashed || isClosedError(error)) {
          return { kind: "infra", reason: getErrorMessage(error).split("\n")[0] ?? "Target closed" };
        }
        // Execution context replaced during navigation: poll again.
      }
      if (state.error !== null) {
        return { kind: "error", report: state.error };
      }
      if (state.ready) {
        return { kind: "ready", state };
      }
      if (
        evidence.firstModuleErrorAt !== null &&
        Date.now() - evidence.firstModuleErrorAt > RENDER_MODULE_ERROR_GRACE_MS
      ) {
        return { kind: "module_error" };
      }
      if (evidence.crashed) {
        return { kind: "infra", reason: "The page crashed." };
      }
      if (!input.host.isAlive()) {
        return { kind: "infra", reason: input.host.exitReason() ?? "the Vite host exited" };
      }
      if (Date.now() >= deadline) {
        let diagnostics: TimeoutDiagnostics = { status: state.status, rootChildCount: 0, rootTextSample: "" };
        try {
          diagnostics = toTimeoutDiagnostics(await page.evaluate(COLLECT_TIMEOUT_DIAGNOSTICS_SCRIPT));
        } catch {
          // Keep the partial diagnostics.
        }
        return { kind: "timeout", diagnostics };
      }
      await delay(HARNESS_POLL_INTERVAL_MS);
    }
  }

  private async measure(
    page: Page,
    screen: { width: number; height: number; mobile?: boolean }
  ): Promise<CaptureMeasurement & { contentHeight: number }> {
    const raw: unknown = await page.evaluate(
      measureCaptureScript({
        padding: RENDER_CAPTURE_PADDING_PX,
        maxHeight: RENDER_MAX_CAPTURE_HEIGHT_PX,
        rootId: EMPTY_HARNESS_ROOT_ID
      })
    );
    const measurement = toCaptureMeasurement(raw);
    if (measurement === null) {
      throw new Error("The capture area could not be measured.");
    }
    // Phones and tablets show one screen at a time: capture exactly that screen, with fixed bars where the device
    // shows them.
    if (screen.mobile === true) {
      return {
        ...measurement,
        clip: { x: 0, y: 0, width: screen.width, height: screen.height },
        truncated: false,
        contentHeight: screen.height
      };
    }
    // Screenshots show the app as it appears: the full screen width and at least one screen tall. A full-screen
    // fixed layer never extends the page, so its capture is exactly the screen (captureStable grows the screen).
    return {
      ...measurement,
      clip: {
        ...measurement.clip,
        width: screen.width,
        height: measurement.mode === "viewport" ? screen.height : Math.max(measurement.clip.height, screen.height)
      },
      contentHeight: measurement.clip.height
    };
  }

  private async screenshot(
    page: Page,
    clip: ClipRect,
    deadline: number,
    screen: { width: number; height: number; mobile?: boolean }
  ): Promise<Buffer> {
    return page.screenshot({
      clip,
      fullPage: clip.height > screen.height,
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png",
      timeout: Math.max(1, deadline - Date.now())
    });
  }

  /** Two byte-identical consecutive frames, or the last frame after RENDER_STABILITY_MAX_ATTEMPTS. */
  private async captureStable(
    page: Page,
    deadline: number,
    screen: { width: number; height: number; mobile?: boolean }
  ): Promise<{ buffer: Buffer; measurement: CaptureMeasurement; stable: boolean }> {
    let measurement = await this.measure(page, screen);
    if (measurement.mode === "viewport" && measurement.contentHeight > screen.height) {
      // The full-screen layer scrolls inside itself: a taller page clip would only add blank page below it. Grow
      // the window once to the content height so the layer lays out all of its content, then capture the window.
      screen = { ...screen, height: Math.min(measurement.contentHeight, RENDER_MAX_CAPTURE_HEIGHT_PX) };
      await page.setViewportSize({ width: screen.width, height: screen.height });
      await delay(RENDER_STABILITY_INTERVAL_MS);
      measurement = await this.measure(page, screen);
    }
    let previous = null as Buffer | null;
    for (let attempt = 1; attempt <= RENDER_STABILITY_MAX_ATTEMPTS; attempt += 1) {
      const shot = await this.screenshot(page, measurement.clip, deadline, screen);
      if (previous !== null && previous.equals(shot)) {
        return { buffer: shot, measurement, stable: true };
      }
      previous = shot;
      await delay(RENDER_STABILITY_INTERVAL_MS);
      const next = await this.measure(page, screen);
      if (!sameClip(next.clip, measurement.clip)) {
        measurement = next;
        previous = null; // layout changed; restart the comparison
      }
    }
    previous ??= await this.screenshot(page, measurement.clip, deadline, screen);
    return { buffer: previous, measurement, stable: false };
  }

  private async stylesheetWarning(page: Page, input: PageRenderInput): Promise<string | null> {
    const check = input.checkStylesheets;
    if (check === null) {
      return null;
    }
    try {
      const health = toStylesheetHealth(await page.evaluate(DETECT_STYLESHEET_HEALTH_SCRIPT));
      if (check.tailwindMajor !== null && !health.hasUtilitySelector) {
        return `Tailwind is installed but no utility classes were generated on the ${input.host.side} side; check globalStylePaths and the Tailwind content configuration.`;
      }
      if (check.globalStylesExpected && health.ruleCount === 0) {
        return `No CSS rules were loaded on the ${input.host.side} side although global styles are configured; check globalStylePaths.`;
      }
      return null;
    } catch {
      return null;
    }
  }
}

const TRANSPORT_ERROR_PATTERN = /^\S*: (?:HTTP \d{3}|net::[A-Z_]+|request failed)$/;

/** Drops stack frames ("    at …") and the repeated "Error: <message>" line from a Vite error log. */
export function compactServerLog(message: string): string {
  const lines = message.trim().split("\n");
  const head = (lines[0] ?? "").replace(/^.*?(Internal server error|Pre-transform error):\s*/i, "").trim();
  return lines
    .filter((line, index) => {
      if (index === 0) {
        return true;
      }
      const trimmed = line.trim();
      return !/^at\s/.test(trimmed) && !(head !== "" && /^[A-Za-z]*Error:/.test(trimmed) && trimmed.endsWith(head));
    })
    .join("\n")
    .trimEnd();
}

const PRINTF_PLACEHOLDER = /%[osdifcOj]/;

/** True for console messages that are only printf placeholders (React 19 logs "%o\n\n%s\n\n%s"). */
function isPlaceholderOnly(text: string): boolean {
  return /^(?:\s*%[osdifcO]\s*)+$/.test(text);
}

/** Reads `signal.aborted` through a call so TypeScript does not narrow it across awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function newEvidence(): PageEvidence {
  return {
    httpUnmatched: [],
    consoleErrors: [],
    serverErrors: [],
    firstModuleErrorAt: null,
    crashed: false,
    blockedRequests: 0,
    blockedSamples: [],
    bodyReads: []
  };
}

function pushCapped(list: string[], text: string): void {
  if (list.length < RENDER_CONSOLE_ERRORS_MAX) {
    list.push(capText(text, RENDER_CONSOLE_ERROR_MAX_CHARS));
  }
}
