import type { Request, Response } from "express";
import { HealthService } from "../services";
import { ResponseHandler, createLogger } from "../utilities";

const log = createLogger("health");

/** GET /api/health. */
export class HealthController {
  private readonly responseHandler = new ResponseHandler();

  /** Returns the HealthView envelope (always HTTP 200 unless the service itself crashes). */
  async get(_req: Request, res: Response): Promise<Response> {
    try {
      const serviceResponse = await new HealthService().check();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      log.error({ event: "http.request.failed", err: error }, "HealthController.get failed");
      return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
    }
  }
}
