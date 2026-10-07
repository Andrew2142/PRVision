/**
 * Live page security values (16 §12.5, 00 §14.5, §21 item 12): the Content-Security-Policy and the other headers
 * every live host response carries, the frontend origins that may frame a live page, and the Host and method guard
 * shared by the Vite live plugin and the Angular static host.
 *
 * PURE: imported by the Vite host child (10 §5.2). Node built-ins and nothing else; never the logger, the database,
 * the utilities barrel or the config-consts barrel.
 */

/** Methods a live host answers; everything else is 405. */
export const LIVE_ALLOWED_METHODS: readonly string[] = ["GET", "HEAD"];

/** `Allow` header of a 405 answer. */
export const LIVE_ALLOW_HEADER = "GET, HEAD";

/** Body of the 403 answer to a request whose Host is not the live host itself. */
export const LIVE_FORBIDDEN_HOST_MESSAGE = "Forbidden host";

/** Body of the 405 answer to a method other than GET and HEAD. */
export const LIVE_METHOD_NOT_ALLOWED_MESSAGE = "Method not allowed";

/** Loopback host names a live page may be addressed by (DNS-rebinding guard). */
const LIVE_HOST_NAMES = ["127.0.0.1", "localhost"] as const;

/** The loopback twin of an origin (localhost ↔ 127.0.0.1, same scheme and port); other hosts unchanged. */
function twinOf(url: URL): string {
  const twinHost = url.hostname === "localhost" ? "127.0.0.1" : url.hostname === "127.0.0.1" ? "localhost" : null;
  if (twinHost === null) {
    return url.origin;
  }
  const twin = new URL(url.origin);
  twin.hostname = twinHost;
  return twin.origin;
}

/**
 * The origins allowed to frame live pages: FRONTEND_URL's origin and its loopback twin, in that order (the same
 * pair the API's Origin guard accepts, 00 §14.12).
 *
 * @param frontendUrl - FRONTEND_URL (an absolute http(s) URL).
 * @throws TypeError when `frontendUrl` is not an absolute URL.
 */
export function liveFrontendOrigins(frontendUrl: string): string[] {
  const url = new URL(frontendUrl);
  return [...new Set([url.origin, twinOf(url)])];
}

/** Keeps only absolute http(s) origins (no path, no wildcard), so a header value can never be widened. */
function sanitizedOrigins(frontendOrigins: readonly string[]): string[] {
  const out: string[] = [];
  for (const candidate of frontendOrigins) {
    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === candidate &&
        !out.includes(candidate)
      ) {
        out.push(candidate);
      }
    } catch {
      // Not an origin: left out.
    }
  }
  return out;
}

/**
 * The Content-Security-Policy of a live page (16 §12.5): same-origin code and requests only (off-origin requests are
 * blocked like the screenshot sandbox, E20), and only the PRVision frontend may frame the page.
 *
 * @param frontendOrigins - From `liveFrontendOrigins` (FRONTEND_URL origin and its twin).
 */
export function buildLiveCsp(frontendOrigins: readonly string[]): string {
  const ancestors = sanitizedOrigins(frontendOrigins);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' data: blob:",
    "worker-src 'none'",
    `frame-ancestors ${ancestors.length > 0 ? ancestors.join(" ") : "'none'"}`,
    "base-uri 'self'",
    "form-action 'none'"
  ].join("; ");
}

/** Headers set on every live host response (16 §12.5). */
export function livePageHeaders(frontendOrigins: readonly string[]): Record<string, string> {
  return {
    "Content-Security-Policy": buildLiveCsp(frontendOrigins),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin"
  };
}

/**
 * True when the Host header is exactly `127.0.0.1:<port>` or `localhost:<port>` of the listening port (16 §12.5).
 * A missing header, another port or any other name is refused.
 *
 * @param host - The request's Host header.
 * @param port - The port the request arrived on (`req.socket.localPort`).
 */
export function isAllowedLiveHost(host: string | undefined, port: number | undefined): boolean {
  if (host === undefined || port === undefined || !Number.isInteger(port) || port <= 0) {
    return false;
  }
  const normalized = host.trim().toLowerCase();
  return LIVE_HOST_NAMES.some((name) => normalized === `${name}:${String(port)}`);
}

/** Outcome of the live guard for one request. */
export type LiveRequestDecision =
  | { ok: true }
  | { ok: false; status: 403; reason: "host"; message: string }
  | { ok: false; status: 405; reason: "method"; message: string };

/**
 * The Host guard (403) then the method guard (405) of a live host (16 §12.5).
 *
 * @param input.method - Request method.
 * @param input.host - Host header.
 * @param input.port - Listening port the request arrived on.
 */
export function decideLiveRequest(input: {
  method: string | undefined;
  host: string | undefined;
  port: number | undefined;
}): LiveRequestDecision {
  if (!isAllowedLiveHost(input.host, input.port)) {
    return { ok: false, status: 403, reason: "host", message: LIVE_FORBIDDEN_HOST_MESSAGE };
  }
  if (!LIVE_ALLOWED_METHODS.includes((input.method ?? "").toUpperCase())) {
    return { ok: false, status: 405, reason: "method", message: LIVE_METHOD_NOT_ALLOWED_MESSAGE };
  }
  return { ok: true };
}
