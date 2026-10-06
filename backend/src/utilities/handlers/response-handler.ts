import type { Response } from "express";
import { ErrorReason } from "../../enums";
import { createLogger } from "../loggers/logger";

const log = createLogger("http");

/**
 * What services return and controllers send (00 §14.2). `error` is a string, or a string array for
 * validation_failed (one message per constraint).
 */
export interface ApiResponse<T = unknown> {
  status: number;
  data?: T;
  error?: string | string[];
  error_reason?: ErrorReason;
}

/**
 * Writes the PRVision wire envelope (00 §14.2, guidelines §6): `{ status, data }` on success and
 * `{ status, error, error_reason }` on failure, with the HTTP status code equal to `status`.
 * Deliberate divergence from Uply-v2, whose ResponseHandler sends raw data.
 */
export class ResponseHandler {
  /**
   * Sends the envelope for a service result. An error status without an error message is a bug: it is
   * logged and sent as a generic 500 so the envelope invariants hold.
   *
   * @param result - Service or handler result.
   * @param response - Express response.
   */
  controllerResponse(result: ApiResponse, response: Response): Response {
    const { status, data, error, error_reason } = result;
    if (status >= 400 && error === undefined) {
      log.warn({ event: "http.response.malformed", status }, "Error response without an error message");
      return response
        .status(500)
        .json({ status: 500, error: "Internal server error", error_reason: ErrorReason.INTERNAL_ERROR });
    }
    if (error !== undefined) {
      const reason = error_reason ?? (status >= 500 ? ErrorReason.INTERNAL_ERROR : undefined);
      const body: Record<string, unknown> = { status, error };
      if (reason !== undefined) {
        body.error_reason = reason;
      }
      return response.status(status).json(body);
    }
    return response.status(status).json({ status, data: data ?? null });
  }

  /** `{ status, data }` (status defaults to 200). */
  successResponse<T>(data: T, status = 200): ApiResponse<T> {
    return { status, data };
  }

  /** `{ status, error, error_reason? }` (status defaults to 400). */
  createErrorResponse(message: string | string[], status = 400, errorReason?: ErrorReason): ApiResponse<never> {
    return errorReason === undefined
      ? { status, error: message }
      : { status, error: message, error_reason: errorReason };
  }

  /** 404 not_found. */
  notFound(message = "Resource not found"): ApiResponse<never> {
    return this.createErrorResponse(message, 404, ErrorReason.NOT_FOUND);
  }

  /** Generic 500 internal_error (never carries an error message from the failure). */
  internalError(): ApiResponse<never> {
    return this.createErrorResponse("Internal server error", 500, ErrorReason.INTERNAL_ERROR);
  }
}
