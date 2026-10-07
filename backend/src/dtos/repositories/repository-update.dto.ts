import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { STATE_ALLOWANCE_MAX, STATE_ALLOWANCE_MIN } from "../../config-consts";

/**
 * PATCH /api/repositories/:id — user settings of a registered repository (16 §14.2). Both fields are optional; the
 * service answers 400 "Nothing to update." when neither is sent.
 */
export class RepositoryUpdateDTO {
  /** Screen size screenshots are taken at: desktop 1280×800, tablet 768×1024, mobile 390×844. */
  @IsOptional()
  @IsIn(["desktop", "tablet", "mobile"])
  renderViewport?: "desktop" | "tablet" | "mobile";

  /** Maximum number of states per harness (D4); a maximum, not a target. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(STATE_ALLOWANCE_MIN)
  @Max(STATE_ALLOWANCE_MAX)
  stateAllowance?: number;
}
