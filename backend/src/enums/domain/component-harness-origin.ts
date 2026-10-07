import { enumValues, type ValueOf } from "../utility/value-of";

/** Where a run row's harness came from (16 §6.1, §6.7). */
export const ComponentHarnessOrigin = { LIBRARY: "library", WRITTEN: "written", REPAIRED: "repaired" } as const;
export type ComponentHarnessOrigin = ValueOf<typeof ComponentHarnessOrigin>;
export const COMPONENT_HARNESS_ORIGIN_VALUES = enumValues(ComponentHarnessOrigin);
