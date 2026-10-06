/** Union of the values of a const object. */
export type ValueOf<T> = T[keyof T];

/**
 * Returns the values of a string const-enum as a non-empty tuple. Drizzle's text `enum` option needs a
 * non-empty tuple type, and an empty enum is always a programming error.
 */
export function enumValues<T extends Record<string, string>>(enumObject: T): [ValueOf<T>, ...ValueOf<T>[]] {
  const values = Object.values(enumObject) as ValueOf<T>[];
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error("enumValues() called with an empty enum object");
  }
  return [first, ...rest];
}
