import type { Request, Response } from "express";
import {
  IdParamDTO,
  LibraryEstimateQueryDTO,
  LibraryEstimateRequestDTO,
  LibraryJobEventsQueryDTO,
  LibraryScanCreateDTO
} from "../dtos";
import { HarnessLibraryService } from "../services/harness-library/harness-library-service";
import { ResponseHandler, Validation, createLogger, type ApiResponse } from "../utilities";

type IdReadResult = { ok: true; id: number } | { ok: false; response: ApiResponse };

/**
 * HTTP transport of the harness library (16 §14): validates params, queries and bodies and delegates every rule to
 * HarnessLibraryService. Owned blocks: 16f (library and jobs), 16g (repair), 16k (export and import).
 */
export class HarnessLibraryController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("harness-library-controller");

  // ----- 16f block: library and jobs -----

  /** POST /api/repositories/library-estimate — estimate of a folder that is not registered yet. */
  async estimateFolder(req: Request, res: Response): Promise<Response> {
    try {
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        LibraryEstimateRequestDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new HarnessLibraryService().estimateFolder(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "estimateFolder", res);
    }
  }

  /** GET /api/repositories/:id/library — library summary of a repository. */
  async summary(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new HarnessLibraryService().summary(idResult.id);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "summary", res);
    }
  }

  /** GET /api/repositories/:id/library/estimate?stateAllowance=&kind= — scan or rescan estimate. */
  async estimate(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData({ ...req.query }),
        LibraryEstimateQueryDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new HarnessLibraryService().estimate(idResult.id, {
        ...(dto.stateAllowance !== undefined ? { stateAllowance: dto.stateAllowance } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {})
      });
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "estimate", res);
    }
  }

  /** POST /api/repositories/:id/library/scans — start a scan (also Continue scan) or a rescan. */
  async startScan(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body),
        LibraryScanCreateDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new HarnessLibraryService().startScan(idResult.id, {
        kind: dto.kind,
        spendCapUsd: dto.spendCapUsd ?? null,
        ...(dto.stateAllowance !== undefined ? { stateAllowance: dto.stateAllowance } : {})
      });
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "startScan", res);
    }
  }

  /** GET /api/library-jobs/:id — one scan, rescan or repair job. */
  async getJob(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new HarnessLibraryService().getJob(idResult.id);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "getJob", res);
    }
  }

  /** GET /api/library-jobs/:id/events?afterId=&limit= — the job's console, oldest first. */
  async jobEvents(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData({ ...req.query }),
        LibraryJobEventsQueryDTO
      );
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new HarnessLibraryService().jobEvents(idResult.id, {
        ...(dto.afterId !== undefined ? { afterId: dto.afterId } : {}),
        ...(dto.limit !== undefined ? { limit: dto.limit } : {})
      });
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "jobEvents", res);
    }
  }

  /** POST /api/library-jobs/:id/cancel — 200 cancelled, 202 cancel_requested, 409 already terminal. */
  async cancelJob(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) {
        return this.responseHandler.controllerResponse(idResult.response, res);
      }
      const serviceResponse = await new HarnessLibraryService().cancelJob(idResult.id);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "cancelJob", res);
    }
  }

  // ----- end 16f block -----

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
    this.log.error(
      { event: "harness_library.controller.unhandled", err: error, action },
      "Unhandled harness library controller error"
    );
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
