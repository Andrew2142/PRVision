import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { CONSOLE_PAGE_LIMIT_MAX } from "../../config-consts";

/**
 * GET /api/visualizations/:id/console?afterId=&limit= → ConsoleEventView[], oldest first, `afterId` exclusive,
 * `limit` default and max CONSOLE_PAGE_LIMIT_MAX (00 §14.4).
 */
export class VisualizationConsoleQueryDTO {
  /** Default 0 → from the beginning; exclusive. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  afterId?: number;

  /** Default and max CONSOLE_PAGE_LIMIT_MAX (500). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONSOLE_PAGE_LIMIT_MAX)
  limit?: number;
}
