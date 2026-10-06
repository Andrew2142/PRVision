import { enumValues, type ValueOf } from "../utility/value-of";

export const ConsoleLevel = { INFO: "info", WARN: "warn", ERROR: "error" } as const;
export type ConsoleLevel = ValueOf<typeof ConsoleLevel>;
export const CONSOLE_LEVEL_VALUES = enumValues(ConsoleLevel);
