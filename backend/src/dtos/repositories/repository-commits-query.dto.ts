import { Transform, Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, Validate } from "class-validator";
import { COMMIT_LIST_MAX_LIMIT, COMMIT_SEARCH_MAX_CHARS } from "../../config-consts";
import { FULL_COMMIT_SHA, GitBranchNameConstraint, toLowerSha } from "../visualizations/visualization-create.dto";

/**
 * GET /api/repositories/:id/commits?branch=&limit=&before=&q= (00 §16). `before` is exclusive: the page starts with
 * the commit after it in the branch's first-parent history. `q` searches instead of paging (`before` is ignored).
 */
export class RepositoryCommitsQueryDTO {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Validate(GitBranchNameConstraint)
  branch!: string;

  /** Default COMMIT_LIST_DEFAULT_LIMIT (50), max COMMIT_LIST_MAX_LIMIT (200). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMIT_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Transform(toLowerSha)
  @IsString()
  @Matches(FULL_COMMIT_SHA, { message: "before must be a full 40-character commit sha" })
  before?: string;

  /** Case-insensitive search over the commit message and author, or a commit SHA prefix. Blank means no search. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? (value.trim() === "" ? undefined : value.trim()) : value
  )
  @IsString()
  @MaxLength(COMMIT_SEARCH_MAX_CHARS)
  @Matches(/^[^\0\r\n]*$/, { message: "q must be a single line of text" })
  q?: string;
}
