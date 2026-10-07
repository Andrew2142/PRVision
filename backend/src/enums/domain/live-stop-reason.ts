import { enumValues, type ValueOf } from "../utility/value-of";

/** Why a live session stopped (16 §6.1, §12). */
export const LiveStopReason = {
  USER: "user",
  LEFT: "left",
  IDLE: "idle",
  MAX_DURATION: "max_duration",
  SHUTDOWN: "shutdown",
  ERROR: "error"
} as const;
export type LiveStopReason = ValueOf<typeof LiveStopReason>;
export const LIVE_STOP_REASON_VALUES = enumValues(LiveStopReason);
