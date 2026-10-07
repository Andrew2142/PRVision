import { enumValues, type ValueOf } from "../utility/value-of";

/**
 * Status of a harness library entry (16 §6.1). OFF_DEFAULT_BRANCH: a complete default-branch inventory no longer
 * contains the component (E26); the entry is kept and still reused.
 */
export const HarnessLibraryStatus = {
  READY: "ready",
  NEEDS_UPDATE: "needs_update",
  OFF_DEFAULT_BRANCH: "off_default_branch"
} as const;
export type HarnessLibraryStatus = ValueOf<typeof HarnessLibraryStatus>;
export const HARNESS_LIBRARY_STATUS_VALUES = enumValues(HarnessLibraryStatus);
