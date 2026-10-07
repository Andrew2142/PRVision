import { enumValues, type ValueOf } from "../utility/value-of";

/** Status of a live session (16 §6.1, §12). */
export const LiveSessionStatus = {
  STARTING: "starting",
  READY: "ready",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed"
} as const;
export type LiveSessionStatus = ValueOf<typeof LiveSessionStatus>;
export const LIVE_SESSION_STATUS_VALUES = enumValues(LiveSessionStatus);

/** Statuses of a session that still owns (or is releasing) hosts; at most one such session per run. */
export const ACTIVE_LIVE_SESSION_STATUSES = [
  "starting",
  "ready",
  "stopping"
] as const satisfies readonly LiveSessionStatus[];
export type ActiveLiveSessionStatus = (typeof ACTIVE_LIVE_SESSION_STATUSES)[number];
