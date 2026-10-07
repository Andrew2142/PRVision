import { IsBoolean } from "class-validator";

/** POST /api/visualizations/:id/live/heartbeat (16 §14.6 LiveHeartbeatRequest). */
export class LiveHeartbeatDTO {
  /** True when the reviewer used the run page or a live side during the last interval (§15.6). */
  @IsBoolean()
  active!: boolean;
}
