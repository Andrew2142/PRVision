import type { RequestHandler } from "express";
import { ErrorReason } from "../enums";
import { ResponseHandler, createLogger } from "../utilities";

const log = createLogger("artifacts");
const responseHandler = new ResponseHandler();

/** /artifacts/<vizId>/<componentId>/<base|head|diff>.png: the only servable shape (00 §4). */
export const ARTIFACT_PUBLIC_PATH_PATTERN = /^\/[1-9]\d{0,9}\/[1-9]\d{0,9}\/(base|head|diff)\.png$/;

/**
 * Allow-list and traversal guard in front of express.static for /artifacts. Any percent-encoding, "..",
 * backslash, NUL or extra segment is rejected before the filesystem is touched.
 */
export function createArtifactPathGuard(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      responseHandler.controllerResponse(responseHandler.notFound(), res);
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      responseHandler.controllerResponse(
        responseHandler.createErrorResponse("Request rejected", 400, ErrorReason.VALIDATION_FAILED),
        res
      );
      return;
    }
    if (decoded !== req.path || !ARTIFACT_PUBLIC_PATH_PATTERN.test(decoded)) {
      log.warn({ event: "artifacts.path.rejected", path: req.path }, "Rejected artifact path");
      responseHandler.controllerResponse(responseHandler.notFound(), res);
      return;
    }
    next();
  };
}
