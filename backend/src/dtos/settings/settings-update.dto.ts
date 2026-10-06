import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";
// Enum types instead of 05's ai-provider.ts aliases: DTOs may not import utilities/services (01 §5.3.1).
import { AI_EFFORT_VALUES, AI_PROVIDER_KIND_VALUES, type AiEffort, type AiProviderKind } from "../../enums";

const AI_PROVIDER_VALUES = AI_PROVIDER_KIND_VALUES;

/** Trims surrounding whitespace but leaves whitespace-only strings intact so they fail @Matches. */
const trimNonBlank = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : value;

/** Only validate secrets when the key is present: `null` must reach @IsString and fail (05 §5.3.1). */
const isPresent = (_object: object, value: unknown): boolean => value !== undefined;

/**
 * PUT /api/settings (partial update, 00 §14.4). Secret fields: omitted → keep, "" → clear, non-empty → replace,
 * null or whitespace-only → 400 validation_failed. @IsOptional is deliberately not used on secrets because it
 * treats null as absent.
 */
export class SettingsUpdateDTO {
  /** "" clears; omitted keeps. Fine-grained PATs start with github_pat_, classic with ghp_. */
  @ValidateIf(isPresent)
  @Transform(trimNonBlank)
  @IsString({ message: 'githubToken must be a string (send "" to remove the token)' })
  @MaxLength(255)
  @Matches(/^$|^[A-Za-z0-9_]{20,255}$/, {
    message: "githubToken must be empty (to remove it) or a GitHub token made of letters, digits and underscores"
  })
  githubToken?: string;

  @IsOptional()
  @IsString()
  @IsIn(AI_PROVIDER_VALUES, { message: `aiProvider must be one of: ${AI_PROVIDER_VALUES.join(", ")}` })
  aiProvider?: AiProviderKind;

  /** "" clears; omitted keeps. */
  @ValidateIf(isPresent)
  @Transform(trimNonBlank)
  @IsString({ message: 'anthropicApiKey must be a string (send "" to remove the key)' })
  @MaxLength(512)
  @Matches(/^$|^sk-ant-[A-Za-z0-9_-]{16,505}$/, {
    message: "anthropicApiKey must be empty (to remove it) or an Anthropic API key starting with sk-ant-"
  })
  anthropicApiKey?: string;

  @IsOptional()
  @Transform(trimNonBlank)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9.-]*$/, { message: "aiModel must be a model id such as claude-opus-5-5" })
  aiModel?: string;

  @IsOptional()
  @IsString()
  @IsIn(AI_EFFORT_VALUES, { message: `aiHarnessEffort must be one of: ${AI_EFFORT_VALUES.join(", ")}` })
  aiHarnessEffort?: AiEffort;

  @IsOptional()
  @IsString()
  @IsIn(AI_EFFORT_VALUES, { message: `aiSummaryEffort must be one of: ${AI_EFFORT_VALUES.join(", ")}` })
  aiSummaryEffort?: AiEffort;
}
