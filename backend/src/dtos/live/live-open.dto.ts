import { IsInt, IsString, MaxLength, MinLength, Max, Min } from "class-validator";
import { STATE_NAME_MAX_CHARS } from "../../config-consts";

/** POST /api/visualizations/:id/live/open (16 §14.6 LiveOpenRequest): the card and state tab to show live. */
export class LiveOpenDTO {
  /** A `visualization_components` row of the run (checked by the service). */
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  componentId!: number;

  /** One of the component's states (checked by the service), 1–40 characters. */
  @IsString()
  @MinLength(1)
  @MaxLength(STATE_NAME_MAX_CHARS)
  stateName!: string;
}
