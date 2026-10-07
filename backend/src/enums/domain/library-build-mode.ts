import { enumValues, type ValueOf } from "../utility/value-of";

/** How a repository's harness library is built (16 §6.1, D3): grow as you go, or scan the whole app. */
export const LibraryBuildMode = { GROW: "grow", SCAN: "scan" } as const;
export type LibraryBuildMode = ValueOf<typeof LibraryBuildMode>;
export const LIBRARY_BUILD_MODE_VALUES = enumValues(LibraryBuildMode);
