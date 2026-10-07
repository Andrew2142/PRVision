import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** Most events one page returns (16 §14.3: limit default and max 500). */
export const LIBRARY_JOB_EVENTS_MAX_LIMIT = 500;

/** GET /api/library-jobs/:id/events?afterId=&limit= (afterId exclusive, oldest first). */
export class LibraryJobEventsQueryDTO {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  afterId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_JOB_EVENTS_MAX_LIMIT)
  limit?: number;
}
