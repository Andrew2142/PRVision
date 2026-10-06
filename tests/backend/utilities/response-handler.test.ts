import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { ResponseHandler } from "../../../backend/src/utilities/handlers/response-handler";

function fakeResponse(): { res: Response; sent: { status: number | null; body: unknown } } {
  const sent: { status: number | null; body: unknown } = { status: null, body: undefined };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    }
  } as unknown as Response;
  return { res, sent };
}

const handler = new ResponseHandler();

test("ResponseHandler.controllerResponse wraps success responses as { status, data }", () => {
  const { res, sent } = fakeResponse();
  handler.controllerResponse(handler.successResponse({ id: 3 }, 202), res);
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.body, { status: 202, data: { id: 3 } });
});

test("ResponseHandler.controllerResponse sends undefined data as null", () => {
  const { res, sent } = fakeResponse();
  handler.controllerResponse({ status: 200 }, res);
  assert.deepEqual(sent.body, { status: 200, data: null });
});

test("ResponseHandler.controllerResponse sends errors as { status, error, error_reason } and omits error_reason when absent", () => {
  const withReason = fakeResponse();
  handler.controllerResponse(handler.notFound("Repository not found"), withReason.res);
  assert.equal(withReason.sent.status, 404);
  assert.deepEqual(withReason.sent.body, { status: 404, error: "Repository not found", error_reason: "not_found" });

  const withoutReason = fakeResponse();
  handler.controllerResponse(handler.createErrorResponse("Bad thing", 400), withoutReason.res);
  assert.deepEqual(withoutReason.sent.body, { status: 400, error: "Bad thing" });
});

test("ResponseHandler.controllerResponse preserves validation message arrays", () => {
  const { res, sent } = fakeResponse();
  handler.controllerResponse(
    handler.createErrorResponse(["a must be a number", "b is required"], 400, "validation_failed"),
    res
  );
  assert.deepEqual(sent.body, {
    status: 400,
    error: ["a must be a number", "b is required"],
    error_reason: "validation_failed"
  });
});

test("ResponseHandler.controllerResponse gives a 500 without error_reason the internal_error reason", () => {
  const { res, sent } = fakeResponse();
  handler.controllerResponse({ status: 500, error: "Internal server error" }, res);
  assert.deepEqual(sent.body, { status: 500, error: "Internal server error", error_reason: "internal_error" });
});

test("ResponseHandler.controllerResponse turns status >= 400 without error into a 500 envelope", () => {
  const { res, sent } = fakeResponse();
  handler.controllerResponse({ status: 404 }, res);
  assert.equal(sent.status, 500);
  assert.deepEqual(sent.body, { status: 500, error: "Internal server error", error_reason: "internal_error" });
});
