import type { NextFunction, Request, Response } from "express";
import { APP_HOST, APP_PORT, FRONTEND_URL } from "../config-consts";
import { ErrorReason } from "../enums";
import { LOCAL_USER } from "../types";
import { AuthContext, ResponseHandler, createLogger } from "../utilities";

const log = createLogger("local-auth");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOST_NAMES = ["localhost", "127.0.0.1"] as const;

/** FRONTEND_URL's loopback twin: localhost <-> 127.0.0.1, same scheme and port; other hosts unchanged. */
function twinOrigin(url: URL): string {
  const twinHost = url.hostname === "localhost" ? "127.0.0.1" : url.hostname === "127.0.0.1" ? "localhost" : null;
  if (twinHost === null) {
    return url.origin;
  }
  const twin = new URL(url.origin);
  twin.hostname = twinHost;
  return twin.origin;
}

/**
 * Local-only request guard (00 D9, §14.5). Replaces Uply's session AuthMiddleware: there is no login; the
 * threats are other web pages in the user's browser (CSRF, DNS rebinding) and other machines (prevented by the
 * loopback bind).
 */
export class LocalAuthMiddleware {
  private readonly responseHandler = new ResponseHandler();
  private readonly allowedOrigins: ReadonlySet<string>;

  /**
   * @param options.frontendUrl - defaults to FRONTEND_URL.
   * @param options.apiPort - port the Host header must carry; defaults to APP_PORT. Tests that listen on port 0
   *   pass `"socket"` to compare against the port the request actually arrived on (req.socket.localPort).
   */
  constructor(private readonly options: { frontendUrl?: string; apiPort?: number | "socket" } = {}) {
    const frontend = new URL(options.frontendUrl ?? FRONTEND_URL);
    // FRONTEND_URL plus its loopback twin: the Angular dev server accepts both host names (02 §6.11.2), and the
    // browser sends whichever the user typed.
    this.allowedOrigins = new Set([frontend.origin, twinOrigin(frontend)]);
  }

  /** Origins CORS allows (FRONTEND_URL and its loopback twin). */
  allowedOriginList(): string[] {
    return [...this.allowedOrigins];
  }

  /**
   * App-level DNS-rebinding guard. The Host header must be exactly `localhost:<port>` or `127.0.0.1:<port>`
   * (`[::1]:<port>` too when APP_HOST is "::1"). A missing port, another port, any other name or a missing Host
   * header → 403 forbidden_origin.
   */
  guardHost(req: Request, res: Response, next: NextFunction): void {
    const expectedPort = this.options.apiPort === "socket" ? req.socket.localPort : (this.options.apiPort ?? APP_PORT);
    const host = (req.headers.host ?? "").toLowerCase();
    const names: string[] = [...LOOPBACK_HOST_NAMES, ...(APP_HOST === "::1" ? ["[::1]"] : [])];
    const allowed = expectedPort === undefined ? [] : names.map((name) => `${name}:${expectedPort}`);
    if (!allowed.includes(host)) {
      log.warn(
        { event: "http.host.rejected", host: req.headers.host ?? null, path: req.path },
        "Rejected request with non-loopback Host header"
      );
      this.responseHandler.controllerResponse(
        this.responseHandler.createErrorResponse("Forbidden host", 403, ErrorReason.FORBIDDEN_ORIGIN),
        res
      );
      return;
    }
    next();
  }

  /**
   * Route-level. For state-changing methods, rejects a present Origin that is not an allowed frontend origin
   * (00 §14.5), Origin "null", and Sec-Fetch-Site: cross-site. Then sets the local user on the request and in
   * AuthContext.
   */
  requireLocal(req: Request, res: Response, next: NextFunction): void {
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.get("origin");
      const fetchSite = req.get("sec-fetch-site");
      const originRejected = origin !== undefined && !this.allowedOrigins.has(origin); // includes "null"
      const siteRejected = fetchSite === "cross-site";
      if (originRejected || siteRejected) {
        log.warn(
          {
            event: "http.origin.rejected",
            origin: origin ?? null,
            fetchSite: fetchSite ?? null,
            method: req.method,
            path: req.path
          },
          "Rejected cross-origin state-changing request"
        );
        this.responseHandler.controllerResponse(
          this.responseHandler.createErrorResponse("Forbidden origin", 403, ErrorReason.FORBIDDEN_ORIGIN),
          res
        );
        return;
      }
    }
    req.localUser = LOCAL_USER;
    AuthContext.setUser(LOCAL_USER);
    next();
  }
}
