import { enumValues, type ValueOf } from "../utility/value-of";

/** How the current revision of a harness library entry was written (16 §6.1). */
export const HarnessLibraryOrigin = { RUN: "run", SCAN: "scan", REPAIR: "repair", IMPORT: "import" } as const;
export type HarnessLibraryOrigin = ValueOf<typeof HarnessLibraryOrigin>;
export const HARNESS_LIBRARY_ORIGIN_VALUES = enumValues(HarnessLibraryOrigin);
