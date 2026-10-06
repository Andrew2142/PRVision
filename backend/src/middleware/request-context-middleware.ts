import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createLogger } from "../utilities";

const log = createLogger("http");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * First middleware: assigns the request id (a valid incoming X-Request-Id is echoed), sets the X-Request-Id
 * response header and writes the access log line when the response finishes (never the query string or body).
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get("x-request-id");
  const requestId = incoming !== undefined && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId; // AuthContext.middleware (after express.json) copies it into the ALS store
  res.setHeader("X-Request-Id", requestId);
  const startedAt = process.hrtime.bigint();
  const method = req.method;
  const path = req.originalUrl.split("?")[0] ?? req.originalUrl; // never log query strings
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // requestId is passed explicitly: "finish" may fire outside the AsyncLocalStorage context.
    const fields = {
      event: "http.request.completed",
      requestId,
      method,
      path,
      status: res.statusCode,
      durationMs: Math.round(durationMs)
    };
    if (res.statusCode >= 500) {
      log.error(fields, "http request");
    } else if (res.statusCode >= 400) {
      log.warn(fields, "http request");
    } else if (method === "GET" || method === "HEAD") {
      log.debug(fields, "http request"); // polling noise
    } else {
      log.info(fields, "http request");
    }
  });
  next();
}
