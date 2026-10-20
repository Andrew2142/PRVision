import type { Request, Response } from "express";
import { AgentRequestAnswerDTO, AgentRequestFailDTO, IdParamDTO } from "../dtos";
import { AgentRequestsService } from "../services";
import { ResponseHandler, Validation, createLogger, type ApiResponse } from "../utilities";

type IdReadResult = { ok: true; id: number } | { ok: false; response: ApiResponse };

/** HTTP transport of agent requests (17 §8): validates ids and bodies, delegates to AgentRequestsService. */
export class AgentRequestsController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("agent-requests-controller");

  /** GET /api/visualizations/:id/agent-requests */
  async list(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      return this.responseHandler.controllerResponse(await new AgentRequestsService().list(idResult.id), res);
    } catch (error: unknown) {
      return this.internalError(error, "list", res);
    }
  }

  /** POST /api/visualizations/:id/agent-requests/claim */
  async claim(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      return this.responseHandler.controllerResponse(await new AgentRequestsService().claim(idResult.id), res);
    } catch (error: unknown) {
      return this.internalError(error, "claim", res);
    }
  }

  /** POST /api/agent-requests/:id/answer { response } */
  async answer(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        AgentRequestAnswerDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new AgentRequestsService().answer(idResult.id, dto.response);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "answer", res);
    }
  }

  /** POST /api/agent-requests/:id/fail { message } */
  async fail(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        AgentRequestFailDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new AgentRequestsService().fail(idResult.id, dto.message);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "fail", res);
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
    this.log.error({ event: "agent-requests.controller.unhandled", err: error, action }, "Unhandled controller error");
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
