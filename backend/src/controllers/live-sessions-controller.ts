import type { Request, Response } from "express";
import { IdParamDTO, LiveHeartbeatDTO, LiveOpenDTO, LiveStopDTO } from "../dtos";
import { LiveSessionService } from "../services/live/live-session-service";
import { ResponseHandler, Validation, createLogger, type ApiResponse } from "../utilities";

type IdReadResult = { ok: true; id: number } | { ok: false; response: ApiResponse };

/**
 * HTTP transport of live mode (16 §12.6, §14.6): validates the run id and the bodies and delegates every rule to
 * LiveSessionService.
 */
export class LiveSessionsController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("live-sessions-controller");

  /** POST /api/visualizations/:id/live — 202 new session, 200 the run's active one. */
  async start(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      return this.responseHandler.controllerResponse(await new LiveSessionService().start(idResult.id), res);
    } catch (error: unknown) {
      return this.internalError(error, "start", res);
    }
  }

  /** GET /api/visualizations/:id/live — the active (else most recent) session. */
  async get(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      return this.responseHandler.controllerResponse(await new LiveSessionService().get(idResult.id), res);
    } catch (error: unknown) {
      return this.internalError(error, "get", res);
    }
  }

  /** POST /api/visualizations/:id/live/open { componentId, stateName } — 202. */
  async open(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        LiveOpenDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new LiveSessionService().open(idResult.id, {
        componentId: dto.componentId,
        stateName: dto.stateName
      });
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "open", res);
    }
  }

  /** POST /api/visualizations/:id/live/heartbeat { active } — 200 { status }; 404 when not running. */
  async heartbeat(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        LiveHeartbeatDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new LiveSessionService().heartbeat(idResult.id, { active: dto.active });
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "heartbeat", res);
    }
  }

  /**
   * POST /api/visualizations/:id/live/stop { reason? } — 200, idempotent. A missing or unparsed body (sendBeacon with
   * `text/plain`) is `{}`, i.e. reason "left".
   */
  async stop(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        LiveStopDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new LiveSessionService().stop(idResult.id, {
        ...(dto.reason !== undefined ? { reason: dto.reason } : {})
      });
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "stop", res);
    }
  }

  /** Validate the :id route param through IdParamDTO. */
  private async readId(req: Request): Promise<IdReadResult> {
    const [isValid, errorResponse, dto] = await this.validation.validate(
      this.validation.compileJsonData({ id: req.params.id }),
      IdParamDTO
    );
    if (!isValid) {
      return { ok: false, response: errorResponse };
    }
    return { ok: true, id: dto.id };
  }

  private internalError(error: unknown, action: string, res: Response): Response {
    this.log.error({ event: "live.controller.unhandled", err: error, action }, "Unhandled live controller error");
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
