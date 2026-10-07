import { enumValues, type ValueOf } from "../utility/value-of";

export const ComponentChangeKind = {
  MODIFIED: "modified",
  ADDED: "added",
  REMOVED: "removed",
  AFFECTED_PARENT: "affected_parent",
  /** 00 §17: a removed base component paired with the added head component that replaces it. */
  REPLACED: "replaced",
  /** 16 E11: a saved harness re-rendered because a global style changed; the run did not touch the component. */
  RECHECKED: "rechecked"
} as const;
export type ComponentChangeKind = ValueOf<typeof ComponentChangeKind>;
export const COMPONENT_CHANGE_KIND_VALUES = enumValues(ComponentChangeKind);
