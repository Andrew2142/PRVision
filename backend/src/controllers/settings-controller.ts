import type { Request, Response } from "express";
import { SettingsUpdateDTO } from "../dtos";
import { SettingsService } from "../services";
import { ResponseHandler, Validation, createLogger } from "../utilities";

/**
 * GET/PUT /api/settings and the two connection tests (05 §5.4). Thin: validate → service → ResponseHandler.
 * The service receives the validated DTO directly (no DTOMapper): the DTO carries plaintext secrets under other
 * names than the ciphertext columns, and partial-update semantics need undefined vs "" (05 §5.4).
 */
export class SettingsController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("settings-controller");

  /** GET /api/settings → SettingsView. */
  async get(_req: Request, res: Response): Promise<Response> {
    try {
      const serviceResponse = await new SettingsService().get();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "get", res);
    }
  }

  /** PUT /api/settings → SettingsView (partial update). */
  async update(req: Request, res: Response): Promise<Response> {
    try {
      // Collect and validate data against DTO
      const sanitized = this.validation.compileJsonData(req.body);
      const [isValid, errorResponse, dto] = await this.validation.validate(sanitized, SettingsUpdateDTO);
      if (!isValid) {
        return this.responseHandler.controllerResponse(errorResponse, res);
      }
      const serviceResponse = await new SettingsService().update(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error: unknown) {
      return this.internalError(error, "update", res);
    }
  }

  /** POST /api/settings/test-github → GithubTestResultView. Any body is ignored. */
  async testGithub(_req: Request, res: Response): Promise<Response> {
    try {
      return this.responseHandler.controllerResponse(await new SettingsService().testGithub(), res);
    } catch (error: unknown) {
      return this.internalError(error, "testGithub", res);
    }
  }

  /** POST /api/settings/test-ai → AiTestResultView. Any body is ignored. */
  async testAi(_req: Request, res: Response): Promise<Response> {
    try {
      return this.responseHandler.controllerResponse(await new SettingsService().testAi(), res);
    } catch (error: unknown) {
      return this.internalError(error, "testAi", res);
    }
  }

  /**
   * Never echoes error.message: it could contain request data. Logs only `{ err }`, which the logger's err
   * serializer strips of request/response/headers and passes through redactSecrets.
   */
  private internalError(error: unknown, action: string, res: Response): Response {
    this.log.error(
      { event: "settings.controller.unhandled", err: error, action },
      "Unhandled settings controller error"
    );
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
