import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { MAX_PAGE_SIZE } from "../../config-consts";

/** `page` (1-based) and `pageSize` (max MAX_PAGE_SIZE) query parameters (00 §9). Feature list DTOs extend it. */
export class PaginationQueryDTO {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}
