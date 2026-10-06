import { enumValues, type ValueOf } from "../utility/value-of";

export const RepositoryFramework = { REACT_VITE: "react_vite", ANGULAR: "angular" } as const;
export type RepositoryFramework = ValueOf<typeof RepositoryFramework>;
export const REPOSITORY_FRAMEWORK_VALUES = enumValues(RepositoryFramework);
