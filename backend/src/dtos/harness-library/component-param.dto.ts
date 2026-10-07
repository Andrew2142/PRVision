import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";

/**
 * `:id` and `:componentId` path parameters of the repair route (16 §14): the run and one of its
 * `visualization_components` rows, both positive 32-bit integers (strings are converted by @Type).
 */
export class ComponentParamDTO {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  id!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  componentId!: number;
}
