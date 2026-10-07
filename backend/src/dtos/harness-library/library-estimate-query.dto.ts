import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { STATE_ALLOWANCE_MAX, STATE_ALLOWANCE_MIN } from "../../config-consts";

/** GET /api/repositories/:id/library/estimate?stateAllowance=&kind= (16 §14.3). */
export class LibraryEstimateQueryDTO {
  /** Defaults to the repository's allowance. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(STATE_ALLOWANCE_MIN)
  @Max(STATE_ALLOWANCE_MAX)
  stateAllowance?: number;

  /** Defaults to "scan". */
  @IsOptional()
  @IsIn(["scan", "rescan"])
  kind?: "scan" | "rescan";
}
