import { enumValues, type ValueOf } from "../utility/value-of";

export const AiEffort = { LOW: "low", MEDIUM: "medium", HIGH: "high", XHIGH: "xhigh", MAX: "max" } as const;
export type AiEffort = ValueOf<typeof AiEffort>;
export const AI_EFFORT_VALUES = enumValues(AiEffort);
