import type { HarnessLibraryJobEventModel } from "../../models";
import { toIsoString } from "../../utilities";

/** One console event of a library job (16 §14.3). */
export interface LibraryJobEventView {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

/** Maps a job event row to its view. */
export function toLibraryJobEventView(model: HarnessLibraryJobEventModel): LibraryJobEventView {
  return { id: model.id, level: model.level, message: model.message, createdAt: toIsoString(model.createdAt) };
}
