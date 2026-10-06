import { enumValues, type ValueOf } from "../utility/value-of";

export const ComponentVisualChange = {
  CHANGED: "changed",
  UNCHANGED: "unchanged",
  NEW: "new",
  DELETED: "deleted"
} as const;
export type ComponentVisualChange = ValueOf<typeof ComponentVisualChange>;
export const COMPONENT_VISUAL_CHANGE_VALUES = enumValues(ComponentVisualChange);
