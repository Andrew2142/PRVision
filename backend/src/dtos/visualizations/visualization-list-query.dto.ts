import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { VISUALIZATION_STATUS_VALUES, type VisualizationStatus } from "../../enums";
import { PaginationQueryDTO } from "../shared/pagination-query.dto";

/**
 * "queued, rendering,,queued" → ["queued", "rendering"]. A repeated key (?status=a&status=b), which Express
 * parses as a string array, is joined first so both forms behave the same. Anything else passes through to fail.
 */
export function parseStatusList(value: unknown): unknown {
  const joined =
    Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value.join(",") : value;
  if (typeof joined !== "string") {
    return joined;
  }
  return [
    ...new Set(
      joined
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
    )
  ];
}

/** GET /api/visualizations?repositoryId=&status=queued,rendering&page=&pageSize= (00 §14.4). */
export class VisualizationListQueryDTO extends PaginationQueryDTO {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  repositoryId?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => parseStatusList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VISUALIZATION_STATUS_VALUES.length)
  @IsIn(VISUALIZATION_STATUS_VALUES, { each: true })
  status?: VisualizationStatus[];
}
