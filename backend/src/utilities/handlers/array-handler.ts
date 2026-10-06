/**
 * Provides small array normalization helpers used throughout the service and
 * controller layers.
 */
export class ArrayHandler {
  /**
   * Normalizes a value into an array so downstream code can safely iterate
   * without special-casing singular, null, or undefined inputs.
   *
   * @param value - The value to normalize into array form.
   * @returns An array containing the original value, the original array, or an empty array when the input is nullish.
   */
  static ensureArray<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) {
      return [];
    }

    return Array.isArray(value) ? value : [value];
  }

  /**
   * Returns the first array element when the input is an array, otherwise
   * undefined.
   *
   * @param value - The candidate array to read from.
   * @returns The first array item, or undefined when the array is empty.
   */
  static firstOrUndefined<T>(value: T[] | undefined | null): T | undefined {
    return Array.isArray(value) ? value[0] : undefined;
  }
}
