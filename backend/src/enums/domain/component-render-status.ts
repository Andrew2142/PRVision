import { enumValues, type ValueOf } from "../utility/value-of";

export const ComponentRenderStatus = {
  PENDING: "pending",
  RENDERED: "rendered",
  PARTIAL: "partial",
  FAILED: "failed",
  SKIPPED: "skipped"
} as const;
export type ComponentRenderStatus = ValueOf<typeof ComponentRenderStatus>;
export const COMPONENT_RENDER_STATUS_VALUES = enumValues(ComponentRenderStatus);
