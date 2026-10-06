import type { Request, Response } from "express";
import {
  IdParamDTO,
  VisualizationConsoleQueryDTO,
  VisualizationContinueDTO,
  VisualizationCreateDTO,
  VisualizationListQueryDTO
} from "../dtos";
import { VisualizationModel } from "../models";
import { VisualizationsService } from "../services";
import { createLogger, ResponseHandler, Validation, type ApiResponse } from "../utilities";

type IdReadResult = { ok: true; id: number } | { ok: false; response: ApiResponse };

/** HTTP transport for visualizations (00 §9). Business rules live in VisualizationsService. */
export class VisualizationsController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("visualizations-controller");

  /** POST /api/visualizations — validate, create the queued row, enqueue; 202. */
  async create(req: Request, res: Response): Promise<Response> {
    try {
      // Collect and validate data against DTO
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        VisualizationCreateDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }

      // Deliberate deviation from DTOMapper: the DTO is a command (headRef/baseRef are resolved into
      // base_ref/head_ref/title by the service, and baseRef is ignored for github_pr), not a row, so the
      // validated DTO is passed directly, as 05's SettingsService.update(dto) does.
      const serviceResponse = await new VisualizationsService().create(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "create", res);
    }
  }

  /** GET /api/visualizations — paged list. */
  async list(req: Request, res: Response): Promise<Response> {
    try {
      // Collect and validate the query against DTO
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData({ ...req.query }),
        VisualizationListQueryDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }

      const serviceResponse = await new VisualizationsService().list(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "list", res);
    }
  }

  /** GET /api/visualizations/:id — detail with components. */
  async get(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).get();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "get", res);
    }
  }

  /** GET /api/visualizations/:id/console?afterId&limit — incremental console events. */
  async console(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }

      // Collect and validate the query against DTO
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData({ ...req.query }),
        VisualizationConsoleQueryDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).console(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "console", res);
    }
  }

  /** POST /api/visualizations/:id/continue — 202 { id, componentLimit, jobId }; 409 conflict when not waiting. */
  async continueRun(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        VisualizationContinueDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).continueRun(
        dto.componentLimit
      );
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "continue", res);
    }
  }

  /** POST /api/visualizations/:id/cancel — 200 cancelled, 202 cancel_requested, 409 already_terminal. */
  async cancel(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).cancel();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "cancel", res);
    }
  }

  /** DELETE /api/visualizations/:id — 200 { id }; 409 conflict while non-terminal. */
  async remove(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).remove();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "remove", res);
    }
  }

  private async readId(req: Request): Promise<IdReadResult> {
    const [isValid, errorResponse, dto] = await this.validation.validate(
      this.validation.compileJsonData(req.params),
      IdParamDTO
    );
    if (!isValid) {
      return { ok: false, response: errorResponse };
    }
    return { ok: true, id: dto.id };
  }

  private modelWithId(id: number): VisualizationModel {
    const model = new VisualizationModel();
    model.setId(id);
    return model;
  }

  private internalError(error: unknown, action: string, res: Response): Response {
    this.log.error(
      { event: "visualizations.controller.unhandled", err: error, action },
      "Unhandled visualizations controller error"
    );
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
