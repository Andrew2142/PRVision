import path from "node:path";
import { Transform } from "class-transformer";
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface
} from "class-validator";
import { expandHome } from "../../utilities/helpers/paths";

/** Trims, then expands a leading "~" or "~/" (00 §14.4). Non-strings pass through to fail @IsString. */
export function expandHomePath(value: unknown): unknown {
  return typeof value === "string" ? expandHome(value.trim()) : value;
}

/** Absolute local folder path: no NUL, not a URL (file://, https://). */
@ValidatorConstraint({ name: "isAbsoluteLocalPath", async: false })
export class IsAbsoluteLocalPathConstraint implements ValidatorConstraintInterface {
  /** True for a non-empty absolute path that is not a URL and has no NUL byte. */
  validate(value: unknown): boolean {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0") &&
      path.isAbsolute(value) &&
      !/^[a-z]+:\/\//i.test(value)
    );
  }

  /** Message shown for a rejected localPath. */
  defaultMessage(): string {
    return "localPath must be an absolute folder path (for example /home/me/projects/my-app)";
  }
}

/** Repo-relative app folder (15 §5.4.5): no NUL, no leading "/" or drive letter, no ".." segment. "." = root. */
@ValidatorConstraint({ name: "isRepoRelativeAppRoot", async: false })
export class IsRepoRelativeAppRootConstraint implements ValidatorConstraintInterface {
  /** True for "." or a relative POSIX/Windows-style path without NUL and without a ".." segment. */
  validate(value: unknown): boolean {
    if (typeof value !== "string" || value.includes("\0")) {
      return false;
    }
    const posix = value.replace(/\\/g, "/");
    return !posix.startsWith("/") && !/^[A-Za-z]:\//.test(posix) && !posix.split("/").includes("..");
  }

  /** Message shown for a rejected appRoot. */
  defaultMessage(): string {
    return 'appRoot must be a folder inside the repository (for example "src/tenant-frontend", or "." for the root)';
  }
}

/**
 * POST /api/repositories body (00 §14.4 RepositoryCreateRequest, 15 §5.4.5). Shape only: whether the folder is a supported
 * project is decided by ProjectDetectionService.
 */
export class RepositoryCreateDTO {
  @Transform(({ value }: { value: unknown }) => expandHomePath(value))
  @IsString()
  @MaxLength(4096)
  @Validate(IsAbsoluteLocalPathConstraint)
  localPath!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  // eslint-disable-next-line no-control-regex -- the pattern exists to reject control characters (06 §5.2)
  @Matches(/^[^\x00-\x1f\x7f]+$/, { message: "name must not contain control characters" })
  name?: string;

  /** App folder inside the repository (15 §5.4.5); omitted = choose automatically. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(300)
  @Validate(IsRepoRelativeAppRootConstraint)
  appRoot?: string;

  /** Project key in angular.json (15 §5.4.5). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9@._/-]+$/, { message: "angularProject may only contain letters, digits and @ . _ / -" })
  angularProject?: string;

  /** Screen size for screenshots; omitted = guessed (mobile for Capacitor/Ionic apps, else desktop). */
  @IsOptional()
  @IsIn(["desktop", "tablet", "mobile"])
  renderViewport?: "desktop" | "tablet" | "mobile";
}
