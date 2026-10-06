import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";
import { COMPONENT_LIMIT_MAX } from "../../config-consts";

/**
 * POST /api/visualizations/:id/continue: the user's choice for a run paused in awaiting_confirmation because analysis
 * found more components than the default limit. `componentLimit` is how many components to render.
 */
export class VisualizationContinueDTO {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMPONENT_LIMIT_MAX)
  componentLimit!: number;
}
