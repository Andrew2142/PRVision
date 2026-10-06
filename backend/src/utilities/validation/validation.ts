import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import { ErrorReason } from "../../enums";
import { ResponseHandler, type ApiResponse } from "../handlers/response-handler";

/**
 * Discriminated validation tuple: `[true, null, dto]` or `[false, errorResponse, null]`, so controllers need no
 * non-null assertions (01 §5.7.1).
 */
export type ValidationResult<T> = [true, null, T] | [false, ApiResponse<never>, null];

/**
 * Parses request payloads and validates them against class-validator DTOs before controller data is mapped into
 * the service layer. Adapted from Uply-v2.
 */
export class Validation {
  private readonly responseHandler = new ResponseHandler();

  /**
   * Validates a plain payload against the DTO class (whitelist, forbidNonWhitelisted, forbidUnknownValues).
   * Numeric query/path params rely on `@Type(() => Number)` in the DTO; there is no implicit conversion.
   *
   * @param sanitizedData - Normalized request payload (see compileJsonData).
   * @param DTOClass - DTO class with the validation rules.
   * @returns The validation tuple; failures are 400 validation_failed with one message per constraint.
   */
  async validate<T extends object>(
    sanitizedData: Record<string, unknown>,
    DTOClass: new () => T
  ): Promise<ValidationResult<T>> {
    try {
      const dtoInstance = plainToInstance(DTOClass, sanitizedData);
      const errors = await validate(dtoInstance, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        skipMissingProperties: false,
        skipNullProperties: false,
        skipUndefinedProperties: false
      });

      if (errors.length > 0) {
        const messages = this.formatValidationErrors(errors);
        return [false, this.responseHandler.createErrorResponse(messages, 400, ErrorReason.VALIDATION_FAILED), null];
      }

      return [true, null, dtoInstance];
    } catch {
      return [
        false,
        this.responseHandler.createErrorResponse(
          ["Request could not be validated"],
          400,
          ErrorReason.VALIDATION_FAILED
        ),
        null
      ];
    }
  }

  /**
   * Compiles request input into a plain object for DTO validation. Never throws: a string is parsed as JSON;
   * parse failures and non-objects (arrays, numbers, null) become `{}`.
   *
   * @param jsonData - `req.body`, `req.query`, `req.params` or a JSON string.
   */
  compileJsonData(jsonData: unknown): Record<string, unknown> {
    let value: unknown = jsonData;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return {};
      }
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>) };
    }
    return {};
  }

  /** Flattens class-validator errors (recursively, with property paths for nested errors). */
  private formatValidationErrors(errors: readonly ValidationError[], parentPath = ""): string[] {
    const messages: string[] = [];
    for (const error of errors) {
      const propertyPath = parentPath === "" ? error.property : `${parentPath}.${error.property}`;
      const prefix = parentPath === "" ? "" : `${propertyPath}: `;
      if (error.constraints) {
        messages.push(...Object.values(error.constraints).map((message) => `${prefix}${message}`));
      }
      if (error.children && error.children.length > 0) {
        messages.push(...this.formatValidationErrors(error.children, propertyPath));
      }
    }
    return messages;
  }
}
