/**
 * The live plugin of a Vite live host (16 §12.4, §12.5): a middleware placed first in the connect chain enforces the
 * Host guard (403, DNS rebinding) and GET/HEAD only (405), and sets the live headers (CSP with `frame-ancestors`
 * limited to the PRVision frontend, nosniff, no-referrer, no-store, CORP same-origin) on every response; HTML
 * responses get the live init script as the first child of `<head>`.
 *
 * PURE: runs inside the Vite host child (10 §5.2). Imports only node types, render-types and the pure live helpers.
 */
import type http from "node:http";
import type { VitePluginLike } from "../render-types";
import { injectLiveInitScript, liveInitScriptTag } from "./live-init-script";
import { LIVE_ALLOW_HEADER, decideLiveRequest, livePageHeaders, type LiveRequestDecision } from "./live-page-headers";

export const LIVE_PLUGIN_NAME = "prvision:live";

/** A connect-style middleware. */
export type LiveMiddleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (error?: unknown) => void
) => void;

/** The part of Vite's dev server the plugin uses (`server.middlewares` is a connect app). */
export interface LiveDevServerLike {
  middlewares: { use(fn: LiveMiddleware): unknown; stack?: unknown[] };
}

/** A rejected request (logged by the host as `live.request.rejected`). */
export interface LiveRejection {
  reason: "host" | "method";
  method: string;
  host: string | null;
  url: string;
}

export interface LivePluginOptions {
  /** FRONTEND_URL origin and its loopback twin (`liveFrontendOrigins`). */
  frontendOrigins: readonly string[];
  /** The init script tag; default `liveInitScriptTag()` (screenshot seed and start time). */
  initScriptTag?: string;
  /** Called for every rejected request. */
  onReject?: (rejection: LiveRejection) => void;
}

/** Vite's object form of `transformIndexHtml` (Vite ≥ 4). */
export interface LiveTransformIndexHtmlHook {
  order: "post";
  handler(html: string): string;
}

/** The plugin as Vite sees it (a structural superset of VitePluginLike). */
export interface LiveVitePlugin extends VitePluginLike {
  configureServer(server: LiveDevServerLike): void;
  transformIndexHtml: LiveTransformIndexHtmlHook;
}

/** Writes the headers into a `writeHead` headers object, replacing any case variant of the same name. */
function overrideHeaderObject(target: Record<string, unknown>, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    for (const key of Object.keys(target)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        Reflect.deleteProperty(target, key);
      }
    }
    target[name] = value;
  }
}

function isPlainHeaderObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sets the live headers now and again right before the head is written, so a later `setHeader` or a
 * `writeHead(status, headers)` of Vite or a user plugin cannot replace them.
 */
export function enforceLiveHeaders(res: http.ServerResponse, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  const original = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
  const wrapped = (...args: unknown[]): http.ServerResponse => {
    if (!res.headersSent) {
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }
      const headerArg = isPlainHeaderObject(args[1]) ? args[1] : isPlainHeaderObject(args[2]) ? args[2] : null;
      if (headerArg !== null) {
        overrideHeaderObject(headerArg, headers);
      }
    }
    return original(...args);
  };
  res.writeHead = wrapped;
}

/** Answers a rejected request (403 or 405, plain text, with the live headers). */
export function rejectLiveRequest(
  res: http.ServerResponse,
  decision: Exclude<LiveRequestDecision, { ok: true }>,
  headers: Readonly<Record<string, string>>
): void {
  res.statusCode = decision.status;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (decision.status === 405) {
    res.setHeader("Allow", LIVE_ALLOW_HEADER);
  }
  res.end(decision.message);
}

/**
 * The guard and header middleware (first in the chain).
 *
 * @param options - Frontend origins and the rejection callback.
 */
export function createLiveMiddleware(options: LivePluginOptions): LiveMiddleware {
  const headers = livePageHeaders(options.frontendOrigins);
  return (req, res, next) => {
    const decision = decideLiveRequest({
      method: req.method,
      host: req.headers.host,
      port: req.socket.localPort
    });
    if (!decision.ok) {
      options.onReject?.({
        reason: decision.reason,
        method: req.method ?? "",
        host: req.headers.host ?? null,
        url: (req.url ?? "").slice(0, 200)
      });
      rejectLiveRequest(res, decision, headers);
      return;
    }
    enforceLiveHeaders(res, headers);
    next();
  };
}

/** Moves the most recently added layer of a connect app to the front of its stack (no-op without a stack). */
function moveLastLayerFirst(middlewares: LiveDevServerLike["middlewares"]): void {
  const stack = middlewares.stack;
  if (!Array.isArray(stack) || stack.length < 2) {
    return;
  }
  const layer = stack.pop();
  if (layer !== undefined) {
    stack.unshift(layer);
  }
}

/**
 * Creates the `prvision:live` plugin (appended after the harness plugin by `buildViteInlineConfig` when the host is
 * started with `live`).
 */
export function createLivePlugin(options: LivePluginOptions): LiveVitePlugin {
  const tag = options.initScriptTag ?? liveInitScriptTag();
  const middleware = createLiveMiddleware(options);
  return {
    name: LIVE_PLUGIN_NAME,
    apply: "serve",
    configureServer(server: LiveDevServerLike): void {
      // Added directly (not as a post hook) and moved to the front, so user plugins' middlewares run after it.
      server.middlewares.use(middleware);
      moveLastLayerFirst(server.middlewares);
    },
    transformIndexHtml: {
      order: "post", // after Vite's own injections, so the script ends up as the first child of <head>
      handler: (html: string): string => injectLiveInitScript(html, tag)
    }
  };
}
