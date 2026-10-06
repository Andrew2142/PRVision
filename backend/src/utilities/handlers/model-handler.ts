/**
 * Converts generated model instances to and from plain objects for the persistence handlers.
 */
export class ModelHandler {
  /**
   * Extracts serializable values from a model instance, removes internal underscore prefixes, and excludes
   * fields that should not be persisted. Null, undefined and function values are dropped.
   *
   * @param model - The generated model instance or plain object to serialize.
   * @param excludedKeys - Property names that must be omitted from the resulting payload.
   * @returns A plain object containing database-safe values.
   */
  static toDatabaseValues(model: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    const record = model as Record<string, unknown>;
    const values: Record<string, unknown> = {};

    Object.getOwnPropertyNames(record).forEach((propertyName) => {
      if (excludedKeys.includes(propertyName)) {
        return;
      }

      const value = record[propertyName];
      if (value === undefined || value === null || typeof value === "function") {
        return;
      }

      const cleanKey = propertyName.startsWith("_") ? propertyName.slice(1) : propertyName;
      if (excludedKeys.includes(cleanKey)) {
        return;
      }

      values[cleanKey] = value;
    });

    return values;
  }

  /**
   * Returns a shallow copy of an object with undefined properties removed so partial updates do not
   * unintentionally overwrite existing database values.
   *
   * @param value - The object to sanitize before issuing an update operation.
   * @returns A partial copy of the original object without undefined fields.
   */
  static removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
    const cleaned: Partial<T> = {};

    Object.entries(value).forEach(([key, entry]) => {
      if (entry !== undefined) {
        cleaned[key as keyof T] = entry as T[keyof T];
      }
    });

    return cleaned;
  }

  /**
   * Creates a model and calls `set<Key>(value)` for each row property, including nulls (DB hydration).
   * Row keys without a matching setter are skipped.
   *
   * @param ModelClass - Generated model class.
   * @param row - Row keyed by camelCase property names.
   */
  static hydrate<T extends object>(ModelClass: new () => T, row: Record<string, unknown>): T {
    const model = new ModelClass();
    for (const [key, value] of Object.entries(row)) {
      const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      const setter = (model as unknown as Record<string, unknown>)[setterName];
      if (typeof setter === "function") {
        (setter as (input: unknown) => void).call(model, value);
      }
    }
    return model;
  }
}
