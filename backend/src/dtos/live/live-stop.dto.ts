import { IsIn, IsOptional } from "class-validator";

/**
 * POST /api/visualizations/:id/live/stop (16 §14.6 LiveStopRequest). The body is optional: a missing or unreadable
 * body (for example `navigator.sendBeacon` with a `text/plain` blob, which express.json does not parse) means "left".
 */
export class LiveStopDTO {
  @IsOptional()
  @IsIn(["user", "left"])
  reason?: "user" | "left";
}
