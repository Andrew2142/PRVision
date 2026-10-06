import type { VisualizationConsoleEventModel } from "../../models";
import { toIsoString } from "../../utilities";

/** One event of GET /api/visualizations/:id/console (00 §9). `stage` is a VisualizationStatus name. */
export interface ConsoleEventView {
  id: number;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  createdAt: string;
}

/** Maps a console event row to its view. */
export function toConsoleEventView(e: VisualizationConsoleEventModel): ConsoleEventView {
  return { id: e.id, level: e.level, stage: e.stage, message: e.message, createdAt: toIsoString(e.createdAt) };
}
