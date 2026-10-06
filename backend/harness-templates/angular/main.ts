/*
 * PRVision Angular render harness entry (static template, sheet 15d).
 * Page URL: /index.html?c=<componentId>&quiet=<ms>&settleMax=<ms>&assetWait=<ms>
 * Signals:  window.__PRVISION_STATUS__ / __PRVISION_READY__ / __PRVISION_ERROR__ (protocol of sheet 10 §5.4.3)
 *           window.__PRVISION_UNSTABLE__ (true when ApplicationRef never became stable within settleMax)
 *           window.__PRVISION_SKIPPED_INPUTS__ (inputs the harness sets that this side does not declare)
 */
import {
  ApplicationRef, Component, ErrorHandler, Injectable, NgZone, ViewChild, ViewContainerRef, reflectComponentType,
  type EnvironmentProviders, type Provider,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { HttpBackend, provideHttpClient } from '@angular/common/http';
import { provideRouter, withDisabledInitialNavigation } from '@angular/router';
import { HARNESS_LOADERS } from './registry.generated';
import { FRAMEWORK_PROVIDERS, FRAMEWORK_WHEN_STABLE } from './framework.generated';
import { PrvisionHttpBackend, setPrvisionHttpFixtures } from './http-backend';
import type { PrvisionAngularHarness } from './harness-api';

type PrvisionPhase = 'booting' | 'importing' | 'mounting' | 'settling' | 'ready' | 'error';
interface PrvisionErrorReport { phase: 'import' | 'mount' | 'render'; message: string; stack: string | null; componentStack: string | null; }
declare global {
  interface Window {
    __PRVISION_STATUS__?: PrvisionPhase;
    __PRVISION_READY__?: boolean;
    __PRVISION_ERROR__?: PrvisionErrorReport | null;
    __PRVISION_UNSTABLE__?: boolean;
    __PRVISION_SKIPPED_INPUTS__?: string[];
  }
}

const params = new URLSearchParams(window.location.search);
const componentId = params.get('c') ?? '';
const quietMs = readPositiveInt(params.get('quiet'), 250);
const settleMaxMs = readPositiveInt(params.get('settleMax'), 5000);
const assetWaitMs = readPositiveInt(params.get('assetWait'), 3000);

function readPositiveInt(raw: string | null, fallback: number): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function setPhase(phase: PrvisionPhase): void { window.__PRVISION_STATUS__ = phase; }
function reportError(phase: PrvisionErrorReport['phase'], error: unknown): void {
  if (window.__PRVISION_READY__ === true || window.__PRVISION_ERROR__) return;   // first error wins
  const e = error instanceof Error ? error : new Error(String(error));
  window.__PRVISION_ERROR__ = { phase, message: e.message || String(error), stack: e.stack ?? null, componentStack: null };
  setPhase('error');
}
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const delay = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
async function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  await Promise.race([p.then(() => { settled = true; }, () => { settled = true; }), delay(ms)]);
  return settled;
}
function waitForDomQuiet(target: Node, quiet: number, max: number): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = window.setTimeout(finish, quiet);
    const hardTimer = window.setTimeout(finish, max);
    const observer = new MutationObserver(() => { window.clearTimeout(quietTimer); quietTimer = window.setTimeout(finish, quiet); });
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    function finish(): void { observer.disconnect(); window.clearTimeout(quietTimer); window.clearTimeout(hardTimer); resolve(); }
  });
}
function waitForImages(max: number): Promise<boolean> {
  const pending = Array.from(document.images).filter((i) => !i.complete);
  return settleWithin(Promise.all(pending.map((i) => new Promise<void>((r) => {
    i.addEventListener('load', () => r(), { once: true });
    i.addEventListener('error', () => r(), { once: true });
  }))), max);
}

@Injectable()
class PrvisionErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.error(error);
    reportError('render', error);
  }
}

@Component({
  selector: 'prvision-root',
  standalone: true,
  template: '<div data-prvision-host=""><ng-container #outlet></ng-container></div>',
})
class PrvisionRootComponent {
  @ViewChild('outlet', { read: ViewContainerRef, static: true }) outlet!: ViewContainerRef;
}

async function main(): Promise<void> {
  window.__PRVISION_READY__ = false;
  window.__PRVISION_ERROR__ = null;
  setPhase('booting');

  const load = HARNESS_LOADERS[componentId];
  if (!/^\d+$/.test(componentId) || load === undefined) {
    reportError('import', new Error(`No harness module found for component "${componentId}".`));
    return;
  }

  setPhase('importing');
  let harness: PrvisionAngularHarness;
  try {
    const mod = (await load()) as { default?: PrvisionAngularHarness };
    if (!mod.default || typeof mod.default.component !== 'function') {
      throw new Error('The harness module must `export default definePrvisionHarness({ component, ... })`.');
    }
    harness = mod.default;
    await harness.setup?.();
  } catch (error) {
    reportError('import', error);
    return;
  }

  setPhase('mounting');
  setPrvisionHttpFixtures(harness.http);
  const providers: Array<Provider | EnvironmentProviders> = [
    ...FRAMEWORK_PROVIDERS,                       // generated: zone/zoneless + noop animations
    provideRouter([], withDisabledInitialNavigation()),
    provideHttpClient(),
    { provide: HttpBackend, useClass: PrvisionHttpBackend },
    { provide: ErrorHandler, useClass: PrvisionErrorHandler },
    ...(harness.providers ?? []),
  ];

  let appRef: ApplicationRef;
  try {
    appRef = await bootstrapApplication(PrvisionRootComponent, { providers });
    const root = appRef.components[0];
    const wrapper = (root.location.nativeElement as HTMLElement).querySelector('[data-prvision-host]') as HTMLElement;
    Object.assign(wrapper.style, harness.hostStyle ?? {});
    // The continuation of `await bootstrapApplication` runs outside the Angular zone. Mount inside it (as the real
    // app does during bootstrap) so timers, HTTP and events started by the component count towards stability.
    appRef.injector.get(NgZone).run(() => {
      const ref = (root.instance as PrvisionRootComponent).outlet.createComponent(harness.component);
      const declared = new Set((reflectComponentType(harness.component)?.inputs ?? []).map((i) => i.templateName));
      const skipped: string[] = [];
      for (const [name, value] of Object.entries(harness.inputs ?? {})) {
        if (!declared.has(name)) { skipped.push(name); continue; }     // input absent on this side (base/head drift)
        ref.setInput(name, value);
      }
      window.__PRVISION_SKIPPED_INPUTS__ = skipped;
      if (skipped.length > 0) console.warn(`[prvision] inputs not declared on this side: ${skipped.join(', ')}`);
      ref.changeDetectorRef.detectChanges();
    });
  } catch (error) {
    reportError('mount', error);
    return;
  }
  if (window.__PRVISION_ERROR__) return;

  setPhase('settling');
  // FRAMEWORK_WHEN_STABLE: appRef.whenStable() on Angular >= 18, the isStable observable on 17 (generated).
  window.__PRVISION_UNSTABLE__ = !(await settleWithin(FRAMEWORK_WHEN_STABLE(appRef), settleMaxMs));
  await nextFrame();
  await nextFrame();
  await waitForDomQuiet(document.body, quietMs, settleMaxMs);
  await settleWithin(document.fonts.ready, assetWaitMs);
  await waitForImages(assetWaitMs);
  await nextFrame();
  await nextFrame();
  if (window.__PRVISION_ERROR__) return;
  window.__PRVISION_READY__ = true;
  setPhase('ready');
}

void main().catch((error: unknown) => reportError('mount', error));
