/**
 * Maps validated DTO objects into generated model instances by calling `set<Prop>` setters, falling back to
 * direct assignment only for own properties of the model. Adapted from Uply-v2 without `any`.
 */
export class DTOMapper {
  /**
   * Creates a model instance from a DTO object. Null and undefined DTO values are skipped.
   *
   * @param dto - The validated DTO object.
   * @param modelClass - The generated model class to instantiate and populate.
   * @returns The populated model instance.
   * @throws Error when the provided DTO is not an object.
   */
  static map<M extends object>(dto: object, modelClass: new () => M): M {
    // Runtime guard for untyped callers; `unknown` keeps the check meaningful to the type checker.
    const candidate: unknown = dto;
    if (!candidate || typeof candidate !== "object") {
      throw new Error("DTO must be a valid object");
    }

    const model = new modelClass();
    const modelRecord = model as unknown as Record<string, unknown>;
    const dtoRecord = dto as Record<string, unknown>;
    const modelProps = Object.getOwnPropertyNames(model);

    for (const prop of Object.getOwnPropertyNames(dtoRecord)) {
      const value = dtoRecord[prop];
      if (value === undefined || value === null) {
        continue;
      }

      const setter = modelRecord[`set${prop.charAt(0).toUpperCase()}${prop.slice(1)}`];
      if (typeof setter === "function") {
        (setter as (input: unknown) => void).call(model, value);
        continue;
      }

      if (modelProps.includes(prop)) {
        modelRecord[prop] = value;
      }
    }

    return model;
  }
}
