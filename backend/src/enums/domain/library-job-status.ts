import { enumValues, type ValueOf } from "../utility/value-of";

/** Status of a harness library job (16 §6.1, §10.2). */
export const LibraryJobStatus = {
  QUEUED: "queued",
  PREPARING: "preparing",
  RUNNING: "running",
  COMPLETED: "completed",
  CAP_REACHED: "cap_reached",
  FAILED: "failed",
  CANCELLED: "cancelled"
} as const;
export type LibraryJobStatus = ValueOf<typeof LibraryJobStatus>;
export const LIBRARY_JOB_STATUS_VALUES = enumValues(LibraryJobStatus);

/** Statuses in which a library job is queued or being processed. */
export const ACTIVE_LIBRARY_JOB_STATUSES = [
  "queued",
  "preparing",
  "running"
] as const satisfies readonly LibraryJobStatus[];
export type ActiveLibraryJobStatus = (typeof ACTIVE_LIBRARY_JOB_STATUSES)[number];

/** Statuses after which a library job never changes again. */
export const TERMINAL_LIBRARY_JOB_STATUSES = [
  "completed",
  "cap_reached",
  "failed",
  "cancelled"
] as const satisfies readonly LibraryJobStatus[];
export type TerminalLibraryJobStatus = (typeof TERMINAL_LIBRARY_JOB_STATUSES)[number];
