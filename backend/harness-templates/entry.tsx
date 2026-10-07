/** @jsxRuntime automatic */
/*
 * PRVision render harness entry (static template, sheets 10 and 16b).
 * Copied verbatim to <viteRoot>/.prvision-harness/entry.tsx before every render run.
 *
 * Page URL:  /.prvision-harness/index.html?c=<componentId>&s=<state>&quiet=<ms>&settleMax=<ms>&assetWait=<ms>
 *            (s absent = Default; live mode adds live=1&parent=<frontend origin>)
 * Signals:   window.__PRVISION_STATUS__  booting | importing | mounting | settling | ready | error
 *            window.__PRVISION_READY__   true once mounted and visually settled
 *            window.__PRVISION_ERROR__   { phase, message, stack, componentStack } on failure (first error wins)
 *            window.__PRVISION_STATE__   { name, names, steps } of the selected state (16 §7.6)
 *            window.__PRVISION_SETTLE__  () => Promise<void>: the settling sequence, reused after scripted steps
 *
 * This file must not import application code except through ./globals and ./components/*.
 */
import { Fragment, Suspense, useEffect, type ComponentType, type ReactElement, type ReactNode } from "react";
import { mount } from "virtual:prvision-mount";
import { PrvisionErrorBoundary } from "./error-boundary";
import { installStepBridge, runStepsInPage, type Step } from "./prvision-steps";
import type { PrvisionReactHarnessModule } from "./harness-api";

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
    __PRVISION_STATE__?: { name: string; names: string[]; steps: Step[] };
    __PRVISION_SETTLE__?: () => Promise<void>;
  }
}

// Lazy map of every generated harness module; only the requested one is fetched.
const harnessModules = import.meta.glob<{ default?: unknown }>("./components/*.tsx");

const params = new URLSearchParams(window.location.search);
const componentId = params.get("c") ?? "";
const quietMs = readPositiveInt(params.get("quiet"), 250);
const settleMaxMs = readPositiveInt(params.get("settleMax"), 5000);
const assetWaitMs = readPositiveInt(params.get("assetWait"), 3000);
const stateName = params.get("s") ?? "Default";
const live = params.get("live") === "1";
const parentOrigin = params.get("parent");
const LIVE_STEP_TIMEOUT_MS = 3000;
const LIVE_ACTIVITY_INTERVAL_MS = 5000;

function readPositiveInt(raw: string | null, fallback: number): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function setPhase(phase: PrvisionPhase): void {
  window.__PRVISION_STATUS__ = phase;
}

function reportError(phase: PrvisionErrorReport["phase"], error: unknown, componentStack: string | null = null): void {
  if (window.__PRVISION_READY__ === true) {
    postLiveError(error); // live mode tells the frontend; never a render failure
    return;
  }
  if (window.__PRVISION_ERROR__) {
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

function isHarnessModule(value: unknown): value is PrvisionReactHarnessModule {
  return typeof value === "object" && value !== null && (value as { __prvisionHarness?: unknown }).__prvisionHarness === 1
    && Array.isArray((value as { states?: unknown }).states);
}

/** The existing settling sequence: two frames, DOM quiet, fonts, images, two frames. */
async function settle(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await waitForDomQuiet(document.body, quietMs, settleMaxMs);
  await settleWithin(document.fonts.ready, assetWaitMs);
  await waitForImages(assetWaitMs);
  await nextFrame();
  await nextFrame();
}

/** The parent frontend origin for live messages, or null when it is not a valid http(s) origin. */
function liveParentOrigin(): string | null {
  if (!live || parentOrigin === null) return null;
  try {
    const url = new URL(parentOrigin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === parentOrigin ? url.origin : null;
  } catch {
    return null;
  }
}

function postToParent(message: Record<string, unknown>): void {
  const origin = liveParentOrigin();
  if (origin === null || window.parent === window) return;
  window.parent.postMessage({ source: "prvision-live", ...message }, origin);
}

let liveErrorPosted = false;
function postLiveError(error: unknown): void {
  if (!live || liveErrorPosted) return;
  liveErrorPosted = true;
  postToParent({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

/** Live mode: tell the frontend the reviewer is using this side (at most once every 5 s). */
function installLiveActivity(): void {
  let lastPost = 0;
  const onActivity = (): void => {
    const now = Date.now();
    if (now - lastPost < LIVE_ACTIVITY_INTERVAL_MS) return;
    lastPost = now;
    postToParent({ type: "activity" });
  };
  for (const type of ["pointerdown", "keydown", "wheel", "input"]) {
    window.addEventListener(type, onActivity, { capture: true, passive: true });
  }
  window.addEventListener("error", (event) => {
    postLiveError(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    postLiveError(event.reason);
  });
}

async function main(): Promise<void> {
  window.__PRVISION_READY__ = false;
  window.__PRVISION_ERROR__ = null;
  setPhase("booting");
  installStepBridge();
  window.__PRVISION_SETTLE__ = settle;
  if (live) installLiveActivity();

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
  let Wrapper: ComponentType<{ children: ReactNode }> = Fragment;
  let StateView: ComponentType;
  let names: string[];
  let steps: Step[] = [];
  try {
    // Global styles first (dynamic so a failing stylesheet is reported, not a silent entry failure).
    await import("./globals");
    const harnessModule = await loadHarness();
    if (isHarnessModule(harnessModule.default)) {
      const states = harnessModule.default.states;
      names = states.map((s) => s.name);
      const state = states.find((s) => s.name === stateName);
      if (state === undefined) throw new Error(`State "${stateName}" not found in this harness. States: ${names.join(", ")}.`);
      StateView = state.render as ComponentType;
      steps = (state.steps ?? []) as Step[];
      if (harnessModule.default.wrapper) Wrapper = harnessModule.default.wrapper;
    } else if (isRenderableComponent(harnessModule.default)) {   // legacy single-state harness (16 §7.3)
      names = ["Default"];
      if (stateName !== "Default") throw new Error(`State "${stateName}" not found in this harness. States: Default.`);
      StateView = harnessModule.default;
    } else {
      throw new Error("The harness module must `export default definePrvisionHarness({ states: [...] })`.");
    }
    window.__PRVISION_STATE__ = { name: stateName, names, steps };
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
        <Wrapper>
          <StateView />
        </Wrapper>
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
  await settle();
  if (window.__PRVISION_ERROR__) return;

  window.__PRVISION_READY__ = true;
  setPhase("ready");

  if (live) {
    const report = await runStepsInPage(steps, settle, { timeoutMs: LIVE_STEP_TIMEOUT_MS });
    postToParent({ type: "state", state: stateName, replayed: report.replayed, skipped: report.skipped });
  }
}

void main().catch((error: unknown) => {
  reportError("mount", error);
});
