import { enumValues, type ValueOf } from "../utility/value-of";

export const PackageManager = { NPM: "npm", PNPM: "pnpm", YARN: "yarn" } as const;
export type PackageManager = ValueOf<typeof PackageManager>;
export const PACKAGE_MANAGER_VALUES = enumValues(PackageManager);
