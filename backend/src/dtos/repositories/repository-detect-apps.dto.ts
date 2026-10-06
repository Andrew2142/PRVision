import { Transform } from "class-transformer";
import { IsString, MaxLength, Validate } from "class-validator";
import { IsAbsoluteLocalPathConstraint, expandHomePath } from "./repository-create.dto";

/** POST /api/repositories/detect-apps body (15 §5.4.5 RepositoryDetectAppsRequest). "~/" is expanded like create. */
export class RepositoryDetectAppsDTO {
  @Transform(({ value }: { value: unknown }) => expandHomePath(value))
  @IsString()
  @MaxLength(4096)
  @Validate(IsAbsoluteLocalPathConstraint)
  localPath!: string;
}
