import { enumValues, type ValueOf } from "../utility/value-of";

/** Kind of a harness library job (16 §6.1, E15). */
export const LibraryJobKind = { SCAN: "scan", RESCAN: "rescan", REPAIR: "repair" } as const;
export type LibraryJobKind = ValueOf<typeof LibraryJobKind>;
export const LIBRARY_JOB_KIND_VALUES = enumValues(LibraryJobKind);
