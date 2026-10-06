import { Transform } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface
} from "class-validator";
import { VisualizationSourceType } from "../../enums";

/** Longest ref name accepted (git allows more; PRVision stores head_ref/base_ref as text up to this). */
const MAX_BRANCH_NAME_LENGTH = 255;

/**
 * `git check-ref-format --branch` rules ∩ 04's SAFE_REF charset. Pure; also used by 07's prepare step to
 * check the base branch name GitHub returns for a PR.
 */
export function isValidGitBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BRANCH_NAME_LENGTH) {
    return false;
  }
  if (!/^[A-Za-z0-9._/+-]+$/.test(value)) {
    return false; // no space, ~ ^ : ? * [ \ @ or control chars
  }
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) {
    return false;
  }
  if (value.includes("..") || value.includes("//") || value === "HEAD") {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A full commit sha as git prints it (00 §16: 40 lower-case hex characters). */
export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Trims and lower-cases a string (git prints shas in lower case); anything else passes through to fail. */
export const toLowerSha = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

/** class-validator constraint around isValidGitBranchName. */
@ValidatorConstraint({ name: "gitBranchName", async: false })
export class GitBranchNameConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidGitBranchName(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} is not a supported git branch name (letters, digits, . _ / + - only; no "..", no leading "-")`;
  }
}

/** Cross-field rules per source type (ValidateIf alone cannot forbid fields). Exported for tests. */
export function sourceFieldErrors(dto: Partial<VisualizationCreateDTO>): string[] {
  const errors: string[] = [];
  const present = (value: unknown): boolean => value !== undefined;
  switch (dto.sourceType) {
    case VisualizationSourceType.GITHUB_PR:
      if (present(dto.headRef)) {
        errors.push("headRef is only allowed when sourceType is local_branch or commit_range");
      }
      break;
    case VisualizationSourceType.LOCAL_BRANCH:
      if (present(dto.prNumber)) {
        errors.push("prNumber is only allowed when sourceType is github_pr");
      }
      if (present(dto.baseRef) && dto.baseRef === dto.headRef) {
        errors.push("baseRef and headRef must be different");
      }
      break;
    case VisualizationSourceType.WORKING_TREE:
      if (present(dto.prNumber) || present(dto.headRef) || present(dto.baseRef)) {
        errors.push("prNumber, headRef and baseRef cannot be set when sourceType is working_tree");
      }
      break;
    case VisualizationSourceType.COMMIT_RANGE:
      if (present(dto.prNumber) || present(dto.baseRef)) {
        errors.push("prNumber and baseRef cannot be set when sourceType is commit_range");
      }
      if (!present(dto.baseSha) || !present(dto.headSha)) {
        errors.push("baseSha and headSha are required when sourceType is commit_range");
      } else if (dto.baseSha === dto.headSha) {
        errors.push("baseSha and headSha must be different commits");
      }
      break;
    default:
      break; // @IsIn reports an invalid sourceType
  }
  if (dto.sourceType !== VisualizationSourceType.COMMIT_RANGE && (present(dto.baseSha) || present(dto.headSha))) {
    errors.push("baseSha and headSha are only allowed when sourceType is commit_range");
  }
  return errors;
}

/** class-validator constraint around sourceFieldErrors (attached to sourceType). */
@ValidatorConstraint({ name: "visualizationSourceFields", async: false })
export class VisualizationSourceFieldsConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return sourceFieldErrors(args.object).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    return sourceFieldErrors(args.object)[0] ?? "Invalid source fields";
  }
}

const trim = ({ value }: { value: unknown }): unknown => (typeof value === "string" ? value.trim() : value);

/**
 * POST /api/visualizations body (00 §14.4 VisualizationCreateRequest). No `title`: it is always derived
 * server-side. Body numbers are not coerced ("12" for repositoryId is a 400).
 */
export class VisualizationCreateDTO {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  repositoryId!: number;

  @IsIn(Object.values(VisualizationSourceType))
  @Validate(VisualizationSourceFieldsConstraint)
  sourceType!: VisualizationSourceType;

  @ValidateIf(
    (o: VisualizationCreateDTO) => o.sourceType === VisualizationSourceType.GITHUB_PR || o.prNumber !== undefined
  )
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  prNumber?: number;

  /** Branch to compare (local_branch) or the branch the two commits are on (commit_range). */
  @ValidateIf(
    (o: VisualizationCreateDTO) =>
      o.sourceType === VisualizationSourceType.LOCAL_BRANCH ||
      o.sourceType === VisualizationSourceType.COMMIT_RANGE ||
      o.headRef !== undefined
  )
  @Transform(trim)
  @IsString()
  @Validate(GitBranchNameConstraint)
  headRef?: string;

  /** Not @IsOptional: that would let `null` through. Validated whenever present. */
  @ValidateIf((o: VisualizationCreateDTO) => o.baseRef !== undefined)
  @Transform(trim)
  @IsString()
  @Validate(GitBranchNameConstraint)
  baseRef?: string;

  /** commit_range only: the older ("from") commit, a full 40-hex sha. */
  @ValidateIf(
    (o: VisualizationCreateDTO) => o.sourceType === VisualizationSourceType.COMMIT_RANGE || o.baseSha !== undefined
  )
  @Transform(toLowerSha)
  @IsString()
  @Matches(FULL_COMMIT_SHA, { message: "baseSha must be a full 40-character commit sha" })
  baseSha?: string;

  /** commit_range only: the newer ("to") commit, a full 40-hex sha. */
  @ValidateIf(
    (o: VisualizationCreateDTO) => o.sourceType === VisualizationSourceType.COMMIT_RANGE || o.headSha !== undefined
  )
  @Transform(toLowerSha)
  @IsString()
  @Matches(FULL_COMMIT_SHA, { message: "headSha must be a full 40-character commit sha" })
  headSha?: string;

  /** Screen size for this run; omitted = the repository's screen size. */
  @ValidateIf((o: VisualizationCreateDTO) => o.renderViewport !== undefined)
  @IsIn(["desktop", "tablet", "mobile"])
  renderViewport?: "desktop" | "tablet" | "mobile";
}
