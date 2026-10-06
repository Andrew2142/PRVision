import type { ValueOf } from "./value-of";
export const DeletionMode = { SOFT: "soft", HARD: "hard" } as const;
export type DeletionMode = ValueOf<typeof DeletionMode>;
