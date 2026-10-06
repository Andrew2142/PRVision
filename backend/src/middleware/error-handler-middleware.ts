import type { NextFunction, Request, Response } from "express";
import { ErrorReason } from "../enums";
import { ResponseHandler, createLogger } from "../utilities";

const log = createLogger("errors");
const responseHandler = new ResponseHandler();

interface HttpErrorLike {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

/** Narrows errors from body-parser / serve-static (`{ status|statusCode: number, type?: string }`). */
function asHttpError(err: unknown): { status: number; type: string | undefined } | null {
  if (typeof err !== "object" || err === null) {
    return null;
  }
  const candidate = err as HttpErrorLike;
  const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  if (typeof status !== "number") {
    return null;
  }
  return { status, type: typeof candidate.type === "string" ? candidate.type : undefined };
}

/** Terminal 404 for every unmatched route. */
export function notFoundHandler(_req: Request, res: Response): void {
  responseHandler.controllerResponse(
    responseHandler.createErrorResponse("Resource not found", 404, ErrorReason.NOT_FOUND),
    res
  );
}

/**
 * Terminal error handler. Body-parser errors → 400 validation_failed / 413 payload_too_large; static-file
 * 403/404 → 404 (never reveals what exists under the data dir); anything else → logged, 500 with a generic
 * message (no stack, no err.message).
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const httpError = asHttpError(err);
  if (httpError?.type === "entity.parse.failed") {
    responseHandler.controllerResponse(
      responseHandler.createErrorResponse("Malformed JSON body", 400, ErrorReason.VALIDATION_FAILED),
      res
    );
    return;
  }
  if (httpError?.type === "entity.too.large") {
    responseHandler.controllerResponse(
      responseHandler.createErrorResponse("Request body too large", 413, ErrorReason.PAYLOAD_TOO_LARGE),
      res
    );
    return;
  }
  if (httpError && (httpError.status === 404 || httpError.status === 403)) {
    // serve-static (fallthrough: false): missing file → 404; dotfile → 403. Both answer 404.
    responseHandler.controllerResponse(responseHandler.notFound(), res);
    return;
  }
  if (httpError?.status === 400) {
    // e.g. serve-static failing to decode a malformed path
    responseHandler.controllerResponse(
      responseHandler.createErrorResponse("Request rejected", 400, ErrorReason.VALIDATION_FAILED),
      res
    );
    return;
  }
  log.error(
    { event: "http.request.failed", err, requestId: req.requestId, method: req.method, path: req.path },
    "Unhandled request error"
  );
  responseHandler.controllerResponse(responseHandler.internalError(), res);
}
