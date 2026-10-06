import { Type } from "class-transformer";
import { IsInt, Max, Min } from "class-validator";

/** `:id` path parameter: a positive 32-bit integer (the string "12" is converted by @Type). */
export class IdParamDTO {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  id!: number;
}
