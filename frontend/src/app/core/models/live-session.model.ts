// Live mode HTTP shapes (sheet 16 §14.6). The page protocol messages (§7.6.1 step 6) are typed here too.
import { type LiveSessionStatus } from './domain-enums.model';

/** 16 §6.1 `LiveStopReason`. */
export type LiveStopReason = 'user' | 'left' | 'idle' | 'max_duration' | 'shutdown' | 'error';

export type LiveSide = 'base' | 'head';

export type LiveHostStatus = 'starting' | 'ready' | 'failed' | 'stopped';

/** One build server of the session: one per (side, render group), started when a card of its group opens (16 E19). */
export interface LiveHostView {
  side: LiveSide;
  groupKey: string;
  componentIds: number[];
  status: LiveHostStatus;
  /** `http://127.0.0.1:<port>` once ready. */
  origin: string | null;
  /** `/.prvision-harness/index.html` (React) or `/index.html` (Angular). */
  harnessUrlPath: string | null;
  error: string | null;
}

/** POST/GET /api/visualizations/:id/live, POST …/live/open. */
export interface LiveSessionView {
  id: number;
  visualizationId: number;
  status: LiveSessionStatus;
  stopReason: LiveStopReason | null;
  errorMessage: string | null;
  hosts: LiveHostView[];
  /** LIVE_IDLE_TIMEOUT_MS (10 min). */
  idleTimeoutMs: number;
  /** LIVE_HEARTBEAT_INTERVAL_MS (30 s). */
  heartbeatIntervalMs: number;
  createdAt: string;
  readyAt: string | null;
  stoppedAt: string | null;
}

/** POST …/live/open. `stateName` is 1–40 characters and one of the component's states. */
export interface LiveOpenRequest {
  componentId: number;
  stateName: string;
}

/** POST …/live/heartbeat. */
export interface LiveHeartbeatRequest {
  active: boolean;
}

/** POST …/live/stop. The body is optional; a missing or unreadable body means `left` (beacon). */
export interface LiveStopRequest {
  reason?: 'user' | 'left';
}

export interface LiveHeartbeatResponse {
  status: LiveSessionStatus;
}

/** `id: null, status: "stopped"` when no session was active (idempotent). */
export interface LiveStopResponse {
  id: number | null;
  status: 'stopping' | 'stopped';
}

/** A step the live page could not replay (16 §7.5 `runStepsInPage`). */
export interface LiveSkippedStep {
  index: number;
  action: string;
  reason: string;
}

/** Messages a live page posts to the frontend (16 §7.6.1 step 6); always `source: "prvision-live"`. */
export type LivePageMessage =
  | { type: 'state'; state: string; replayed: number; skipped: LiveSkippedStep[] }
  | { type: 'error'; message: string }
  | { type: 'activity' };
