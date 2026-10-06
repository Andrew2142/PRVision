import type { Request, Response } from "express";
import {
  IdParamDTO,
  RepositoryCommitsQueryDTO,
  RepositoryCreateDTO,
  RepositoryDetectAppsDTO,
  RepositoryUpdateDTO
} from "../dtos";
import { RepositoryModel } from "../models";
import { RepositoriesService } from "../services";
import { DTOMapper, ResponseHandler, Validation, createLogger, type ApiResponse } from "../utilities";

type IdReadResult = { ok: true; id: number } | { ok: false; response: ApiResponse };

/**
 * HTTP transport for registered repositories (06 §5.3).
 * Validates params/bodies and delegates every rule to RepositoriesService.
 */
export class RepositoriesController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("repositories-controller");

  /** GET /api/repositories — list registered repositories. */
  async list(_req: Request, res: Response): Promise<Response> {
    try {
      const serviceResponse = await new RepositoriesService().list();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "list", res);
    }
  }

  /** POST /api/repositories — register a local clone after detection. */
  async create(req: Request, res: Response): Promise<Response> {
    try {
      // Collect and validate data against DTO
      const sanitized = this.validation.compileJsonData(req.body);
      const [isValid, errorResponse, dto] = await this.validation.validate(sanitized, RepositoryCreateDTO);
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }

      // Map to model and create
      const model = DTOMapper.map(dto, RepositoryModel);
      const serviceResponse = await new RepositoriesService(model).create();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "create", res);
    }
  }

  /** POST /api/repositories/detect-apps — list the apps of the repository containing a folder (15 §5.4.5). */
  async detectApps(req: Request, res: Response): Promise<Response> {
    try {
      // Collect and validate data against DTO
      const sanitized = this.validation.compileJsonData(req.body);
      const [isValid, errorResponse, dto] = await this.validation.validate(sanitized, RepositoryDetectAppsDTO);
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }

      // Map to model and discover
      const model = DTOMapper.map(dto, RepositoryModel);
      const serviceResponse = await new RepositoriesService(model).detectApps();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "detectApps", res);
    }
  }

  /** GET /api/repositories/:id — one repository. */
  async get(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).get();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "get", res);
    }
  }

  /** POST /api/repositories/:id/redetect — re-run project detection on the stored path. */
  async redetect(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).redetect();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "redetect", res);
    }
  }

  /** PATCH /api/repositories/:id — user settings (screen size). */
  async update(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        RepositoryUpdateDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).updateSettings(
        dto.renderViewport
      );
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "update", res);
    }
  }

  /** DELETE /api/repositories/:id — soft delete the repository (its visualizations are hidden, not modified). */
  async remove(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).remove();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "remove", res);
    }
  }

  /** GET /api/repositories/:id/pull-requests — open PRs from GitHub. */
  async listPullRequests(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).listPullRequests();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "listPullRequests", res);
    }
  }

  /** GET /api/repositories/:id/branches — local branches + working tree dirty flag. */
  async listBranches(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).listBranches();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "listBranches", res);
    }
  }

  /** GET /api/repositories/:id/commits?branch=&limit=&before= — a branch's commits, newest first (00 §16). */
  async listCommits(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }

      // Collect and validate the query against DTO
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData({ ...req.query }),
        RepositoryCommitsQueryDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }

      // Query DTO, not a row: passed directly, as VisualizationsController.list does.
      const serviceResponse = await new RepositoriesService(this.modelWithId(idResult.id)).listCommits(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "listCommits", res);
    }
  }

  /** Validate the :id route param through IdParamDTO. */
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

  private modelWithId(id: number): RepositoryModel {
    const model = new RepositoryModel();
    model.setId(id);
    return model;
  }

  private internalError(error: unknown, action: string, res: Response): Response {
    this.log.error(
      { event: "repositories.controller.unhandled", err: error, action },
      "Unhandled repositories controller error"
    );
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
