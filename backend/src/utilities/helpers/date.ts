/**
 * Serializes a timestamp for a response view (03 §9.5): ISO-8601 in UTC.
 *
 * @throws RangeError when the date is invalid.
 */
export function toIsoString(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError("Invalid Date");
  }
  return value.toISOString();
}

/** Like toIsoString, but null/undefined (a nullable column) becomes null. */
export function toIsoStringOrNull(value: Date | null | undefined): string | null {
  return value ? toIsoString(value) : null;
}
