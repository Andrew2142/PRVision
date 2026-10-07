import { LIVE_HEARTBEAT_INTERVAL_MS, LIVE_IDLE_TIMEOUT_MS } from "../../config-consts";
import type { LiveSessionModel } from "../../models";
import { toIsoString, toIsoStringOrNull } from "../../utilities";

/** One live host of a session as the frontend sees it (16 §14.6; `lastUsedAt` stays internal). */
export interface LiveHostView {
  side: "base" | "head";
  groupKey: string;
  componentIds: number[];
  status: "starting" | "ready" | "failed" | "stopped";
  origin: string | null;
  harnessUrlPath: string | null;
  error: string | null;
}

/** GET/POST /api/visualizations/:id/live (16 §14.6). */
export interface LiveSessionView {
  id: number;
  visualizationId: number;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  stopReason: "user" | "left" | "idle" | "max_duration" | "shutdown" | "error" | null;
  errorMessage: string | null;
  hosts: LiveHostView[];
  idleTimeoutMs: number;
  heartbeatIntervalMs: number;
  createdAt: string;
  readyAt: string | null;
  stoppedAt: string | null;
}

/** POST /api/visualizations/:id/live/heartbeat → 200. */
export interface LiveHeartbeatResponse {
  status: LiveSessionView["status"];
}

/** POST /api/visualizations/:id/live/stop → 200 (idempotent). */
export interface LiveStopResponse {
  id: number | null;
  status: "stopping" | "stopped";
}

/** Maps a `live_sessions` row to the view. */
export function toLiveSessionView(session: LiveSessionModel): LiveSessionView {
  const hosts: unknown = session.hosts;
  return {
    id: session.id,
    visualizationId: session.visualizationId,
    status: session.status,
    stopReason: session.stopReason ?? null,
    errorMessage: session.errorMessage ?? null,
    hosts: (Array.isArray(hosts) ? (hosts as LiveSessionModel["hosts"]) : []).map((host) => ({
      side: host.side,
      groupKey: host.groupKey,
      componentIds: Array.isArray(host.componentIds) ? [...host.componentIds] : [],
      status: host.status,
      origin: host.origin ?? null,
      harnessUrlPath: host.harnessUrlPath ?? null,
      error: host.error ?? null
    })),
    idleTimeoutMs: LIVE_IDLE_TIMEOUT_MS,
    heartbeatIntervalMs: LIVE_HEARTBEAT_INTERVAL_MS,
    createdAt: toIsoString(session.createdAt),
    readyAt: toIsoStringOrNull(session.readyAt),
    stoppedAt: toIsoStringOrNull(session.stoppedAt)
  };
}
