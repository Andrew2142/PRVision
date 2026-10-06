/** @jsxRuntime automatic */
/*
 * PRVision render harness entry (static template, sheet 10).
 * Copied verbatim to <viteRoot>/.prvision-harness/entry.tsx before every render run.
 *
 * Page URL:  /.prvision-harness/index.html?c=<componentId>&quiet=<ms>&settleMax=<ms>&assetWait=<ms>
 * Signals:   window.__PRVISION_STATUS__  booting | importing | mounting | settling | ready | error
 *            window.__PRVISION_READY__   true once mounted and visually settled
 *            window.__PRVISION_ERROR__   { phase, message, stack, componentStack } on failure (first error wins)
 *
 * This file must not import application code except through ./globals and ./components/*.
 */
import { Suspense, useEffect, type ComponentType, type ReactElement } from "react";
import { mount } from "virtual:prvision-mount";
import { PrvisionErrorBoundary } from "./error-boundary";

type PrvisionPhase = "booting" | "importing" | "mounting" | "settling" | "ready" | "error";

interface PrvisionErrorReport {
  phase: "import" | "mount" | "render";
  message: string;
  stack: string | null;
  componentStack: string | null;
}

declare global {
  interface Window {
    __PRVISION_STATUS__?: PrvisionPhase;
    __PRVISION_READY__?: boolean;
    __PRVISION_ERROR__?: PrvisionErrorReport | null;
  }
}

// Lazy map of every generated harness module; only the requested one is fetched.
const harnessModules = import.meta.glob<{ default?: unknown }>("./components/*.tsx");

const params = new URLSearchParams(window.location.search);
const componentId = params.get("c") ?? "";
const quietMs = readPositiveInt(params.get("quiet"), 250);
const settleMaxMs = readPositiveInt(params.get("settleMax"), 5000);
const assetWaitMs = readPositiveInt(params.get("assetWait"), 3000);

function readPositiveInt(raw: string | null, fallback: number): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function setPhase(phase: PrvisionPhase): void {
  window.__PRVISION_STATUS__ = phase;
}

function reportError(phase: PrvisionErrorReport["phase"], error: unknown, componentStack: string | null = null): void {
  if (window.__PRVISION_READY__ === true || window.__PRVISION_ERROR__) {
    return; // first error wins; errors after ready are console noise, not render failures
  }
  const normalized = error instanceof Error ? error : new Error(String(error));
  window.__PRVISION_ERROR__ = {
    phase,
    message: normalized.message || String(error),
    stack: normalized.stack ?? null,
    componentStack,
  };
  setPhase("error");
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([promise.then(() => undefined, () => undefined), delay(ms)]);
}

/** Resolves after `quiet` ms without DOM mutations under `target`, or after `max` ms. */
function waitForDomQuiet(target: Node, quiet: number, max: number): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = window.setTimeout(finish, quiet);
    const hardTimer = window.setTimeout(finish, max);
    const observer = new MutationObserver(() => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(finish, quiet);
    });
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    function finish(): void {
      observer.disconnect();
      window.clearTimeout(quietTimer);
      window.clearTimeout(hardTimer);
      resolve();
    }
  });
}

function waitForImages(max: number): Promise<void> {
  const pending = Array.from(document.images).filter((image) => !image.complete);
  const loaded = Promise.all(
    pending.map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  return settleWithin(loaded, max);
}

/** Commits together with the harness (same Suspense boundary), so its effect marks "harness committed". */
function ReadyProbe(props: { onCommit: () => void }): null {
  const { onCommit } = props;
  useEffect(() => {
    onCommit();
  }, [onCommit]);
  return null;
}

function isRenderableComponent(value: unknown): value is ComponentType {
  return typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
}

async function main(): Promise<void> {
  window.__PRVISION_READY__ = false;
  window.__PRVISION_ERROR__ = null;
  setPhase("booting");

  const container = document.getElementById("prvision-root");
  if (container === null) {
    reportError("mount", new Error("#prvision-root is missing from the harness index.html."));
    return;
  }

  const moduleKey = `./components/${componentId}.tsx`;
  const loadHarness = harnessModules[moduleKey];
  if (!/^\d+$/.test(componentId) || loadHarness === undefined) {
    reportError("import", new Error(`No harness module found for component "${componentId}" (expected ${moduleKey}).`));
    return;
  }

  setPhase("importing");
  let Harness: ComponentType;
  try {
    // Global styles first (dynamic so a failing stylesheet is reported, not a silent entry failure).
    await import("./globals");
    const harnessModule = await loadHarness();
    if (!isRenderableComponent(harnessModule.default)) {
      throw new Error("The harness module has no default export. It must `export default function PRVisionHarness()`.");
    }
    Harness = harnessModule.default;
  } catch (error) {
    reportError("import", error);
    return;
  }

  setPhase("mounting");
  let markCommitted: () => void = () => undefined;
  const committed = new Promise<void>((resolve) => {
    markCommitted = resolve;
  });
  const tree: ReactElement = (
    <PrvisionErrorBoundary onError={(error, componentStack) => reportError("render", error, componentStack)}>
      <Suspense fallback={null}>
        <Harness />
        <ReadyProbe onCommit={markCommitted} />
      </Suspense>
    </PrvisionErrorBoundary>
  );

  try {
    mount(container, tree);
  } catch (error) {
    reportError("mount", error);
    return;
  }

  await committed; // never resolves if the boundary caught an error; the backend sees __PRVISION_ERROR__ instead
  if (window.__PRVISION_ERROR__) return;

  setPhase("settling");
  await nextFrame();
  await nextFrame();
  await waitForDomQuiet(document.body, quietMs, settleMaxMs);
  await settleWithin(document.fonts.ready, assetWaitMs);
  await waitForImages(assetWaitMs);
  await nextFrame();
  await nextFrame();
  if (window.__PRVISION_ERROR__) return;

  window.__PRVISION_READY__ = true;
  setPhase("ready");
}

void main().catch((error: unknown) => {
  reportError("mount", error);
});
