import { Transform, Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, Validate } from "class-validator";
import { STATE_ALLOWANCE_MAX, STATE_ALLOWANCE_MIN } from "../../config-consts";
import {
  expandHomePath,
  IsAbsoluteLocalPathConstraint,
  IsRepoRelativeAppRootConstraint
} from "./repository-create.dto";

/**
 * POST /api/repositories/library-estimate (16 §14.3 LibraryEstimateRequest): the scan estimate of a folder that is
 * not registered yet (Add repository dialog). The folder rules are those of POST /api/repositories.
 */
export class LibraryEstimateRequestDTO {
  @Transform(({ value }: { value: unknown }) => expandHomePath(value))
  @IsString()
  @MaxLength(4096)
  @Validate(IsAbsoluteLocalPathConstraint)
  localPath!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  @Validate(IsRepoRelativeAppRootConstraint)
  appRoot?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9@._/-]+$/, { message: "angularProject may only contain letters, digits and @ . _ / -" })
  angularProject?: string;

  @Type(() => Number)
  @IsInt()
  @Min(STATE_ALLOWANCE_MIN)
  @Max(STATE_ALLOWANCE_MAX)
  stateAllowance!: number;
}
