/** Values a condition may compare against. */
export type ScalarValue = string | number | boolean | Date;

/** Operator conditions beyond equality (04 §8.3). */
export type WhereOperator =
  | { readonly op: "ne" | "gt" | "gte" | "lt" | "lte"; readonly value: ScalarValue }
  | { readonly op: "in" | "notIn"; readonly values: readonly (string | number)[] }
  | { readonly op: "isNull" | "isNotNull" };

/** Key = camelCase model property. undefined → ignored; null → IS NULL; scalar → =; WhereOperator → operator. */
export type Conditions = Record<string, ScalarValue | WhereOperator | null | undefined>;

/** Builders for WhereOperator values, e.g. `{ id: Where.gt(afterId) }`. */
export const Where = {
  ne: (value: ScalarValue): WhereOperator => ({ op: "ne", value }),
  gt: (value: ScalarValue): WhereOperator => ({ op: "gt", value }),
  gte: (value: ScalarValue): WhereOperator => ({ op: "gte", value }),
  lt: (value: ScalarValue): WhereOperator => ({ op: "lt", value }),
  lte: (value: ScalarValue): WhereOperator => ({ op: "lte", value }),
  in: (values: readonly (string | number)[]): WhereOperator => ({ op: "in", values }),
  notIn: (values: readonly (string | number)[]): WhereOperator => ({ op: "notIn", values }),
  isNull: (): WhereOperator => ({ op: "isNull" }),
  isNotNull: (): WhereOperator => ({ op: "isNotNull" })
} as const;

/** True for a value built by `Where.*` (not a Date, not null). */
export function isWhereOperator(value: unknown): value is WhereOperator {
  return typeof value === "object" && value !== null && !(value instanceof Date) && "op" in value;
}

export interface OrderBySpec {
  column: string;
  direction: "asc" | "desc";
}

/** Options of QueryHandler.selectMany. */
export interface SelectManyOptions {
  /** Default: no limit (Uply's silent default of 10 is removed). */
  limit?: number;
  /** Default 0. */
  offset?: number;
  /** Default: [{ column: "id", direction: "asc" }]. */
  orderBy?: readonly OrderBySpec[];
  /** Case-insensitive contains (ILIKE, %/_ escaped). */
  search?: Record<string, string>;
}
