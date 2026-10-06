import { enumValues, type ValueOf } from "../utility/value-of";

export const ComponentRisk = { NONE: "none", CHECK: "check", LIKELY_REGRESSION: "likely_regression" } as const;
export type ComponentRisk = ValueOf<typeof ComponentRisk>;
export const COMPONENT_RISK_VALUES = enumValues(ComponentRisk);
