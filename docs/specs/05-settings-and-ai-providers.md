# 05 — Settings and AI Providers

Owner: build agent (wave 3)
Depends on: 00 (contracts), 03 (schema/models), 04 (core infrastructure). Consumes one narrow method from 06 (`GitHubClient.verifyToken`).
Consumed by: 06 (GitHub token read), 07 (provider construction, readiness check), 09 (harness generation), 11 (summary), 13 (settings screen).

---

## 1. Purpose

Deliver two things:

1. The **Settings feature end to end**: `GET/PUT /api/settings`, `POST /api/settings/test-github`, `POST /api/settings/test-ai`. A single `app_settings` row (`id = 1`) stores the GitHub token, the AI provider choice, the Anthropic API key, the model and the two effort levels. Secrets are encrypted at rest and are never returned, logged or echoed.
2. The **AI provider layer** in `backend/src/utilities/services/ai/`: one `AiProvider` interface (contract in 00 §8, extended by 00 §14.4) with two implementations, `AnthropicApiProvider` (`@anthropic-ai/sdk`) and `ClaudeCodeProvider` (`@anthropic-ai/claude-agent-sdk`), plus a factory that builds the configured provider from **already-resolved** settings (it never reads the DB), and a JSON-Schema validator (ajv, draft 2020-12) that every provider uses to validate structured output.

Every AI call in PRVision goes through `AiProvider.generateStructured<T>()`. No other file imports `@anthropic-ai/sdk` or `@anthropic-ai/claude-agent-sdk`.

Layering rule (04 §9.4: `utilities` never imports `services`): `utilities/services/ai/**` must not import `services/settings/**`, not even type-only. The settings types the factory needs (`SecretRead`, `ResolvedAiSettings`) are therefore declared in `utilities/services/ai/ai-provider.ts` and re-exported by `settings-store.ts`. Callers read settings through `SettingsStore` (the only non-HTTP settings reader, 00 §14.8) and pass the result to the factory.

## 2. Scope / Out of scope

In scope:

- `SettingsController`, `SettingsService`, `SettingsStore` (non-HTTP settings access used by other sheets), DTOs, routes.
- Encryption/decryption of `github_token_encrypted` and `anthropic_api_key_encrypted` with a versioned prefix.
- Singleton row creation (insert-if-missing) and atomic upsert on update.
- Connection tests for GitHub (delegated to `GitHubClient.verifyToken`, sheet 06) returning `GithubTestResultView { login }`, and AI (tiny `connection_test` structured call) returning `AiTestResultView { provider, model, latencyMs }` (00 §14.4).
- `ai-provider.ts`, `ai-provider-factory.ts`, `anthropic-api-provider.ts`, `claude-code-provider.ts`, `json-schema-validator.ts`, `ai-connection-test.ts`.
- Error mapping from SDK errors to `AiProviderError`.
- AI-related constants in `config-consts/ai.config.ts` (values listed in §5.10; sheet 02 creates the file, this sheet defines the AI keys).

Out of scope:

- The GitHub HTTP client itself (06). This sheet only calls `GitHubClient.verifyToken`.
- Prompts for harness generation (09) and summaries (11). This sheet owns only the connection-test prompt.
- Frontend settings screen (13). This sheet defines the exact messages and `error_reason` codes it shows.
- `Encryption` primitive (04). This sheet wraps it with a prefix and failure semantics.
- Writing `visualizations.ai_usage`. Providers only return usage (also on errors, via `AiProviderError.usage`); 09's `AiUsageRecorder` is the only writer of the column (00 §14.7).

## 3. Dependencies

| Sheet | What is used |
|---|---|
| 00 | `AiProviderKind`, `AiEffort` enums; `app_settings` columns; `AiProvider`, `AiStructuredRequest`, `AiStructuredResult`, `AiUsage` (+ `cacheReadInputTokens?`), `AiProviderError` (+ `usage?`) (§8, §14.4); routes and `SettingsView` (§9); `SettingsUpdateRequest`, `GithubTestResultView`, `AiTestResultView` (§14.4); wire envelope and `error_reason` list (§14.2); child-process env rule (§14.5); `SettingsStore` as the only non-HTTP settings reader (§14.8). |
| 03 | `appSettings` Drizzle table in `database/schema.ts`, generated `AppSettingModel` (`models/app-setting-model.ts`, 03 §9.2), `Table.APP_SETTINGS`. The row is seeded by migration `0001_seed_app_settings.sql` (00 §14.3). |
| 04 | `QueryHandler`, `ResponseHandler`/`ApiResponse`, `ErrorReason`, `Validation` (discriminated tuple, returns `validation_failed`), `Encryption` (`encrypt(plain): string`, `decrypt(payload): string`, throws `EncryptionError` on tamper/wrong key/malformed), `createLogger` (pino, redaction, `redactSecrets`), `DrizzleDb.getInstance()`, `AI_CLAUDE_CODE_PARENT_ENV` (02 §6.7; the Claude Code child's env base, 00 §14.12), `LocalAuthMiddleware`, `routes/index.ts`, `runWithAuthContext` and `patchStaticMethod` test helpers. |
| 06 | `GitHubClient.verifyToken(token, { signal })` returning `GitHubTokenVerification` (06 §5.6.3). |

npm packages added to `backend/package.json` by this sheet:

| Package | Why |
|---|---|
| `@anthropic-ai/sdk` (latest) | Anthropic API provider. |
| `@anthropic-ai/claude-agent-sdk` (latest) | Claude Code provider. Loaded lazily with dynamic `import()`. |
| `ajv` (^8) | JSON Schema 2020-12 validation (`ajv/dist/2020`). |

Donor files read in Uply-v2 (copy the style, not the code verbatim):

- `backend/src/utilities/processors/encryption.ts` — AES-256-GCM `iv.tag.ciphertext` base64 payload.
- `backend/src/services/tenants/tenant-smtp-secret.ts` — prefix-tagged secret wrapping (`enc:` prefix, no double encryption). PRVision uses the same idea with a versioned prefix and a strict decrypt (no plaintext passthrough).
- `backend/src/controllers/tenants/my-tenant-controller.ts` — thin controller pattern (validate → service → `controllerResponse`, try/catch → 500).
- `backend/src/dtos/tenants/tenant-my-settings-update.dto.ts` — partial-update DTO decorators.
- `backend/src/utilities/validation/validation.ts` — `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`.
- `tests/backend/helpers/test-context.ts` — `runWithAuthContext`, `patchStaticMethod`.

## 4. File inventory

```text
backend/src/
  controllers/settings-controller.ts                 SettingsController: get, update, testGithub, testAi (thin)
  services/settings/settings-service.ts              SettingsService: HTTP-facing, returns ApiResponse
  services/settings/settings-store.ts                SettingsStore: singleton row access, secret encrypt/decrypt, the only non-HTTP settings reader (06/07)
  services/settings/index.ts                         barrel
  dtos/settings/settings-update.dto.ts               SettingsUpdateDTO (class-validator)
  dtos/settings/settings-view.dto.ts                 SettingsView interface (00 §9; 01 §5.5.1 view-DTO naming)
  dtos/settings/github-test-result-view.dto.ts       GithubTestResultView { login } (00 §14.4)
  dtos/settings/ai-test-result-view.dto.ts           AiTestResultView { provider, model, latencyMs } (00 §14.4)
  dtos/settings/index.ts                             barrel
  utilities/services/ai/ai-provider.ts               re-exports contract types; AiEffortValue/AiProviderKindValue aliases; SecretRead, ResolvedAiSettings; addUsage, ZERO_USAGE
  utilities/services/ai/ai-provider-factory.ts       AiProviderFactory: create(settings), readiness(settings) — pure, no DB access
  utilities/services/ai/anthropic-api-provider.ts    AnthropicApiProvider implements AiProvider
  utilities/services/ai/claude-code-provider.ts      ClaudeCodeProvider implements AiProvider
  utilities/services/ai/claude-code-result.ts        Adapter isolating Agent SDK message shapes (only file that reads SDK message fields)
  utilities/services/ai/json-schema-validator.ts     JsonSchemaValidator (ajv 2020, compile cache, strict, error formatting, API-compat check)
  utilities/services/ai/ai-connection-test.ts        CONNECTION_TEST_SYSTEM, CONNECTION_TEST_SCHEMA, buildConnectionTestRequest()
  utilities/services/ai/index.ts                     barrel
  config-consts/ai.config.ts                         AI constants (keys in §5.10; file created by 02)
  routes/index.ts                                    + 4 settings routes (file owned by 04)

tests/backend/
  settings/settings-update-dto.test.ts
  settings/settings-store.test.ts
  settings/settings-service.test.ts
  settings/settings-controller.test.ts
  ai/json-schema-validator.test.ts
  ai/anthropic-api-provider.test.ts
  ai/claude-code-provider.test.ts
  ai/claude-code-result.test.ts
  ai/ai-provider-factory.test.ts
  ai/ai-connection-test.test.ts
  helpers/fake-anthropic-stream.ts                   fake stream function returning canned BetaMessage objects
  helpers/fake-agent-query.ts                        fake Agent SDK query() async iterator
```

`backend/src/utilities/index.ts` barrel must export `./services/ai` so services import `AiProviderFactory` from `../../utilities`.

## 5. Detailed design

### 5.1 Type aliases (`ai-provider.ts`)

```ts
// backend/src/utilities/services/ai/ai-provider.ts
// Re-exports the cross-sheet AI contract (00 §8) so consumers import from one place.
export type {
  AiProvider,
  AiStructuredRequest,
  AiStructuredResult,
  AiUsage,
} from "../../../types/visualization-pipeline";
export { AiProviderError } from "../../../types/visualization-pipeline";

import type { AiEffort, AiProviderKind } from "../../../enums";

export type AiEffortValue = (typeof AiEffort)[keyof typeof AiEffort];
export type AiProviderKindValue = (typeof AiProviderKind)[keyof typeof AiProviderKind];
export type AiPurpose = import("../../../types/visualization-pipeline").AiStructuredRequest["purpose"];
export type AiProviderErrorReason = import("../../../types/visualization-pipeline").AiProviderError["reason"];

/** Result of decrypting a stored secret. Declared here (utilities) so the factory never imports services. */
export type SecretRead =
  | { state: "absent" }
  | { state: "present"; value: string }
  | { state: "unreadable" };                 // wrong key, tampered, or unknown format

/** Settings as read by SettingsStore.readAiSettings(). The key is decrypted only in memory. */
export interface ResolvedAiSettings {
  provider: AiProviderKindValue;
  model: string;
  harnessEffort: AiEffortValue;
  summaryEffort: AiEffortValue;
  anthropicApiKey: SecretRead;
}

/** Adds two usage records. Used by providers (retries) and by 09/11 accumulation. */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    calls: a.calls + b.calls,
    ...(a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) }
      : {}),
  };
}
export const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
```

`cacheReadInputTokens` and `AiProviderError.usage` are part of the contract (00 §14.4). Every `AiProviderError` thrown **after the API returned a message** (`refusal`, `max_tokens`, `invalid_output`, unexpected stop reason) carries `usage`, so 09/11 can record spent tokens through `AiUsageRecorder` (00 §14.7). Errors thrown before a response exists (network, auth, abort) carry no usage.

### 5.2 `app_settings` singleton and `SettingsStore`

`SettingsStore` is the only code that reads or writes `app_settings` (00 §14.8). It is not HTTP-facing: it returns models/values and throws only on infrastructure failure. `SettingsService` (HTTP) and other sheets use it. Sheets 06 and 07 call `readGithubToken()` and `readAiSettings()`; nothing else outside this sheet touches the table.

Defaults (from `ai.config.ts`, also used if sheet 03 defines column defaults — they must match):

| Column | Default |
|---|---|
| `ai_provider` | `AI_DEFAULT_PROVIDER = "anthropic_api"` |
| `ai_model` | `AI_DEFAULT_MODEL = "claude-opus-5-5"` |
| `ai_harness_effort` | `AI_DEFAULT_HARNESS_EFFORT = "high"` |
| `ai_summary_effort` | `AI_DEFAULT_SUMMARY_EFFORT = "medium"` |
| `github_token_encrypted`, `github_login`, `anthropic_api_key_encrypted` | `null` |

Secret storage format: `enc:v1:` + `Encryption.encrypt(plain)` (04 returns `base64(iv).base64(tag).base64(ciphertext)`, AES-256-GCM, key derived from `PRVISION_SECRET_KEY`). The prefix makes the format versionable and lets decrypt reject anything that was not produced by this code. Unlike the Uply donor, there is **no plaintext passthrough**: a value without the prefix is treated as unreadable.

```ts
// backend/src/services/settings/settings-store.ts
import { appSettings } from "../../database/schema";
import { AppSettingModel } from "../../models";
import { Table } from "../../enums";
import { DrizzleDb, Encryption, EncryptionError, QueryHandler, createLogger } from "../../utilities";
import {
  AI_DEFAULT_HARNESS_EFFORT, AI_DEFAULT_MODEL, AI_DEFAULT_PROVIDER, AI_DEFAULT_SUMMARY_EFFORT,
} from "../../config-consts";
import type {
  AiEffortValue, AiProviderKindValue, ResolvedAiSettings, SecretRead,
} from "../../utilities/services/ai/ai-provider";

export type { ResolvedAiSettings, SecretRead };   // re-exported for 06/07 convenience

export const SETTINGS_ROW_ID = 1;
export const SECRET_PREFIX = "enc:v1:";

/** Token plus the exact ciphertext it came from, so a later write can be made conditional on it. */
export interface GithubTokenSnapshot { secret: SecretRead; storedCiphertext: string | null; }

/** Columns SettingsService may patch. Secrets arrive already encrypted (or null to clear). */
export interface AppSettingsPatch {
  githubTokenEncrypted?: string | null;
  githubLogin?: string | null;
  aiProvider?: AiProviderKindValue;
  anthropicApiKeyEncrypted?: string | null;
  aiModel?: string;
  aiHarnessEffort?: AiEffortValue;
  aiSummaryEffort?: AiEffortValue;
}

export class SettingsStore {
  private static readonly log = createLogger("settings-store");

  constructor(
    private readonly queryHandler: QueryHandler = new QueryHandler(),
    private readonly db = DrizzleDb.getInstance(),
  ) {}

  /**
   * Returns the singleton row. The row is seeded by migration 0001 (00 §14.3), so the normal path is one
   * SELECT. Only when it is missing (manual delete) is it re-created with defaults; ON CONFLICT DO NOTHING
   * keeps concurrent first requests race-free.
   */
  async getOrCreate(): Promise<AppSettingModel> {
    const existing = await this.queryHandler.validateAndSelect(AppSettingModel, { id: SETTINGS_ROW_ID }, Table.APP_SETTINGS);
    if (existing) return existing;
    // Direct Drizzle: QueryHandler has no insert-on-conflict.
    await this.db.insert(appSettings).values(SettingsStore.defaultRow()).onConflictDoNothing({ target: appSettings.id });
    const row = await this.queryHandler.validateAndSelect(AppSettingModel, { id: SETTINGS_ROW_ID }, Table.APP_SETTINGS);
    if (!row) throw new Error("app_settings row missing after insert");
    return row;
  }

  /** Atomic upsert of the singleton row. Only keys present in `patch` are written. */
  async patch(patch: AppSettingsPatch): Promise<AppSettingModel> {
    const set = { ...SettingsStore.definedOnly(patch), updatedAt: new Date() };
    // Direct Drizzle: QueryHandler has no upsert. Single statement => no read-modify-write race.
    await this.db
      .insert(appSettings)
      .values({ ...SettingsStore.defaultRow(), ...set })
      .onConflictDoUpdate({ target: appSettings.id, set });
    return this.getOrCreate();
  }

  async readGithubToken(): Promise<SecretRead> {
    return (await this.readGithubTokenSnapshot()).secret;
  }

  /** Used by test-github: the ciphertext lets setGithubLoginIfTokenUnchanged detect a concurrent token change. */
  async readGithubTokenSnapshot(): Promise<GithubTokenSnapshot> {
    const row = await this.getOrCreate();
    return {
      secret: SettingsStore.readSecret(row.githubTokenEncrypted, "github_token"),
      storedCiphertext: row.githubTokenEncrypted ?? null,
    };
  }

  /**
   * Compare-and-set: writes github_login only if the stored token is still the one that was verified.
   * Returns false when the token was replaced or cleared meanwhile (the login is then not written).
   */
  async setGithubLoginIfTokenUnchanged(storedCiphertext: string, login: string): Promise<boolean> {
    const result = await this.queryHandler.update(
      { githubLogin: login },
      { id: SETTINGS_ROW_ID, githubTokenEncrypted: storedCiphertext },
      Table.APP_SETTINGS,
    );
    if (result.status === 200) return true;
    if (result.status === 404) return false;
    throw new Error(`app_settings github_login update failed (${result.status})`);
  }

  async readAiSettings(): Promise<ResolvedAiSettings> {
    const row = await this.getOrCreate();
    return {
      provider: row.aiProvider as AiProviderKindValue,       // CHECK constraint guarantees domain
      model: row.aiModel,
      harnessEffort: row.aiHarnessEffort as AiEffortValue,
      summaryEffort: row.aiSummaryEffort as AiEffortValue,
      anthropicApiKey: SettingsStore.readSecret(row.anthropicApiKeyEncrypted, "anthropic_api_key"),
    };
  }

  static encryptSecret(plain: string): string {
    return `${SECRET_PREFIX}${Encryption.encrypt(plain)}`;
  }

  /** Never throws. Never logs the value or the error object (it could carry ciphertext). */
  static readSecret(stored: string | null | undefined, name: string): SecretRead {
    if (stored === null || stored === undefined || stored === "") return { state: "absent" };
    if (!stored.startsWith(SECRET_PREFIX)) {
      SettingsStore.log.warn({ event: "settings.secret.unknown_format", secret: name }, "Stored secret has an unknown format");
      return { state: "unreadable" };
    }
    try {
      const value = Encryption.decrypt(stored.slice(SECRET_PREFIX.length));
      return value === "" ? { state: "absent" } : { state: "present", value };
    } catch (error) {
      // EncryptionError.reason is safe to log ("missing_key" | "malformed_payload" | "decrypt_failed").
      const reason = error instanceof EncryptionError ? error.reason : "unknown";
      SettingsStore.log.warn({ event: "settings.secret.decrypt_failed", secret: name, reason }, "Stored secret could not be decrypted");
      return { state: "unreadable" };
    }
  }

  private static defaultRow(): typeof appSettings.$inferInsert {
    return {
      id: SETTINGS_ROW_ID,
      aiProvider: AI_DEFAULT_PROVIDER,
      aiModel: AI_DEFAULT_MODEL,
      aiHarnessEffort: AI_DEFAULT_HARNESS_EFFORT,
      aiSummaryEffort: AI_DEFAULT_SUMMARY_EFFORT,
    };
  }

  private static definedOnly(patch: AppSettingsPatch): Partial<typeof appSettings.$inferInsert> {
    return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  }
}
```

Notes:

- `EncryptionError` is imported from `utilities` (04 §9.9). `definedOnly` returns `Partial<typeof appSettings.$inferInsert>`; no `any`, no `Record<string, unknown>` casts into Drizzle.
- The model getters (`githubTokenEncrypted`, `aiModel`, …) come from the generated `AppSettingModel` (sheet 03 §9.2: singular class name, file `app-setting-model.ts`). If the generator names differ, adapt here only.
- `readSecret` returning `{ state: "absent" }` for a decrypted empty string is defensive; `SettingsService` never stores encrypted empty strings (clear → `null`).
- `readAiSettings()` decrypts the API key in the same call that reads provider and model, so a single read gives a consistent snapshot. Callers must not read twice and combine (07 builds the provider and `PipelineContext.aiSettings` from one `ResolvedAiSettings`).

### 5.3 DTOs

#### 5.3.1 `settings-update.dto.ts` — exact decorators and secret semantics

Semantics per secret field (`githubToken`, `anthropicApiKey`):

| Request body | Meaning |
|---|---|
| key omitted (`undefined`) | keep the stored value unchanged |
| `""` | clear the stored value (column set to `null`); clearing `githubToken` also clears `github_login` |
| non-empty string | trim, validate format, encrypt, store; setting a new `githubToken` resets `github_login` to `null` (unknown until tested) |
| `null` | **400** `validation_failed` — explicit null is ambiguous and rejected |
| whitespace only | **400** `validation_failed` |

Non-secret fields are optional; omitted = keep. An empty body `{}` is valid and returns the current view (no write).

`@IsOptional()` is deliberately **not** used on secret fields because it treats `null` as "absent". `@ValidateIf((_, v) => v !== undefined)` makes `null` fail `@IsString()`.

```ts
// backend/src/dtos/settings/settings-update.dto.ts
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";
import { AiEffort, AiProviderKind } from "../../enums";
import type { AiEffortValue, AiProviderKindValue } from "../../utilities/services/ai/ai-provider";

const AI_PROVIDER_VALUES = Object.values(AiProviderKind);
const AI_EFFORT_VALUES = Object.values(AiEffort);

/** Trims surrounding whitespace but leaves whitespace-only strings intact so they fail @Matches. */
const trimNonBlank = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : value;

export class SettingsUpdateDTO {
  /** "" clears; omitted keeps. Fine-grained PATs start with github_pat_, classic with ghp_. */
  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @Transform(trimNonBlank)
  @IsString({ message: "githubToken must be a string (send \"\" to remove the token)" })
  @MaxLength(255)
  @Matches(/^$|^[A-Za-z0-9_]{20,255}$/, {
    message: "githubToken must be empty (to remove it) or a GitHub token made of letters, digits and underscores",
  })
  githubToken?: string;

  @IsOptional()
  @IsString()
  @IsIn(AI_PROVIDER_VALUES, { message: `aiProvider must be one of: ${AI_PROVIDER_VALUES.join(", ")}` })
  aiProvider?: AiProviderKindValue;

  /** "" clears; omitted keeps. */
  @ValidateIf((_object: object, value: unknown) => value !== undefined)
  @Transform(trimNonBlank)
  @IsString({ message: "anthropicApiKey must be a string (send \"\" to remove the key)" })
  @MaxLength(512)
  @Matches(/^$|^sk-ant-[A-Za-z0-9_-]{16,505}$/, {
    message: "anthropicApiKey must be empty (to remove it) or an Anthropic API key starting with sk-ant-",
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
  aiHarnessEffort?: AiEffortValue;

  @IsOptional()
  @IsString()
  @IsIn(AI_EFFORT_VALUES, { message: `aiSummaryEffort must be one of: ${AI_EFFORT_VALUES.join(", ")}` })
  aiSummaryEffort?: AiEffortValue;
}
```

`Validation.validate` uses `whitelist + forbidNonWhitelisted`, so sending view-only fields (`hasGithubToken`, `githubLogin`, …) returns 400. The frontend must send only the fields above (00 §14.4 `SettingsUpdateRequest`). `Validation` (04 §8.7) returns `error_reason: "validation_failed"` with `error` as a string array.

Decorator order matters: class-transformer runs every `@Transform` during `plainToInstance`, before any class-validator check, so `trimNonBlank` sees the raw value and `@ValidateIf` sees the transformed one. `null` stays `null` (not a string) and fails `@IsString`; `"   "` stays `"   "` and fails `@Matches`.

Model id regex rationale: Anthropic model ids are lowercase with digits, dots and dashes (`claude-opus-5-5`). The model value is not checked against a list; `test-ai` surfaces an unknown model as a `config` error.

#### 5.3.2 `settings-view.dto.ts`

```ts
export interface SettingsView {
  hasGithubToken: boolean;
  githubLogin: string | null;
  aiProvider: AiProviderKindValue;
  hasAnthropicApiKey: boolean;
  aiModel: string;
  aiHarnessEffort: AiEffortValue;
  aiSummaryEffort: AiEffortValue;
}
```

Mapping (in `SettingsService.toView`): `hasGithubToken = row.githubTokenEncrypted != null`, `hasAnthropicApiKey = row.anthropicApiKeyEncrypted != null`. "Has" reflects storage, not readability; unreadable secrets are surfaced by the test endpoints and by the provider factory.

#### 5.3.3 Test result views (00 §14.4)

```ts
// dtos/settings/github-test-result-view.dto.ts — POST /api/settings/test-github → 200
export interface GithubTestResultView { login: string; }

// dtos/settings/ai-test-result-view.dto.ts — POST /api/settings/test-ai → 200
export interface AiTestResultView {
  provider: AiProviderKindValue;
  model: string;        // model id that actually answered (AiStructuredResult.model; differs from settings after a server-side fallback)
  latencyMs: number;    // wall time of generateStructured, integer ms
}
```

The success sentence is composed by the frontend (13); the backend returns data only. Failures use the standard error envelope with `error_reason` (§5.8).

### 5.4 `SettingsController`

Thin, Uply pattern. No body for the two test routes (any body is ignored, not validated).

```ts
// backend/src/controllers/settings-controller.ts
import type { Request, Response } from "express";
import { SettingsUpdateDTO } from "../dtos";
import { SettingsService } from "../services";
import { createLogger, ResponseHandler, Validation } from "../utilities";

export class SettingsController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("settings-controller");

  async get(_req: Request, res: Response): Promise<Response> {
    try {
      const serviceResponse = await new SettingsService().get();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "get", res);
    }
  }

  async update(req: Request, res: Response): Promise<Response> {
    try {
      const sanitized = this.validation.compileJsonData(req.body);
      const [isValid, errorResponse, dto] = await this.validation.validate(sanitized, SettingsUpdateDTO);
      if (!isValid) return this.responseHandler.controllerResponse(errorResponse, res);
      const serviceResponse = await new SettingsService().update(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "update", res);
    }
  }

  async testGithub(_req: Request, res: Response): Promise<Response> {
    try {
      return this.responseHandler.controllerResponse(await new SettingsService().testGithub(), res);
    } catch (error) {
      return this.internalError(error, "testGithub", res);
    }
  }

  async testAi(_req: Request, res: Response): Promise<Response> {
    try {
      return this.responseHandler.controllerResponse(await new SettingsService().testAi(), res);
    } catch (error) {
      return this.internalError(error, "testAi", res);
    }
  }

  /**
   * Never echoes error.message: it could contain request data. Logs only `{ err }`, which 04's pino
   * serializer strips of request/response/headers and passes through redactSecrets.
   */
  private internalError(error: unknown, action: string, res: Response): Response {
    this.log.error({ event: "settings.controller.unhandled", err: error, action }, "Unhandled settings controller error");
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
```

Deliberate deviation from the DTOMapper step: `SettingsService.update` receives the validated `SettingsUpdateDTO` directly (as `AuthService.login(dto)` does in the guidelines §9 example). Reasons: (1) the DTO carries plaintext secrets while the model carries ciphertext columns with different names, so `DTOMapper.map` would silently drop them; (2) partial-update semantics depend on the difference between `undefined` (keep) and `""` (clear), which a generated model with schema defaults would erase (model defaults would overwrite stored values). The service converts the DTO to an `AppSettingsPatch` explicitly.

Routes (append to `routes/index.ts`, owned by 04):

```ts
app.get("/api/settings", requireLocal, settingsController.get.bind(settingsController));
app.put("/api/settings", requireLocal, settingsController.update.bind(settingsController));
app.post("/api/settings/test-github", requireLocal, settingsController.testGithub.bind(settingsController));
app.post("/api/settings/test-ai", requireLocal, settingsController.testAi.bind(settingsController));
```

`settingsController` is constructed in `app.ts` (`buildRouteDependencies`, 04 §5.1) and added to the `RouteDependencies` type; `requireLocal` is the `RouteDependencies` member of 04 §5.3.

### 5.5 `SettingsService`

```ts
// backend/src/services/settings/settings-service.ts
export interface SettingsServiceDependencies {
  verifyGithubToken: typeof GitHubClient.verifyToken;          // default GitHubClient.verifyToken
  createProvider: (settings: ResolvedAiSettings) => AiProvider; // default AiProviderFactory.create
  now: () => number;                                            // default performance.now (monotonic, for latency)
  nonce: () => string;                                          // default "prv-" + randomBytes(3).toString("hex")
}

export class SettingsService {
  private readonly log = createLogger("settings-service");
  private readonly deps: SettingsServiceDependencies;

  constructor(
    private readonly store: SettingsStore = new SettingsStore(),
    deps: Partial<SettingsServiceDependencies> = {},
  ) {
    this.deps = { ...defaultSettingsServiceDependencies(), ...deps };
  }

  async get(): Promise<ApiResponse>;
  async update(dto: SettingsUpdateDTO): Promise<ApiResponse>;
  async testGithub(): Promise<ApiResponse>;
  async testAi(): Promise<ApiResponse>;

  private toView(row: AppSettingModel): SettingsView;
  private buildPatch(dto: SettingsUpdateDTO): { patch: AppSettingsPatch; changed: string[] };
}
```

`AuthContext` is not needed (single local user); services still run inside `LocalAuthMiddleware`'s context. Every public method returns `ApiResponse`; expected failures return early; only unexpected exceptions propagate to the controller's 500 path (no service-level catch that swallows them).

#### 5.5.1 `get()`

1. `row = await store.getOrCreate()`.
2. Return `{ status: 200, data: toView(row) }`.

#### 5.5.2 `update(dto)`

1. `const { patch, changed } = buildPatch(dto)`:
   - `dto.githubToken === ""` → `patch.githubTokenEncrypted = null; patch.githubLogin = null; changed.push("githubToken(cleared)")`.
   - `dto.githubToken` non-empty → `patch.githubTokenEncrypted = SettingsStore.encryptSecret(dto.githubToken); patch.githubLogin = null; changed.push("githubToken(set)")`.
   - Same for `anthropicApiKey` → `anthropicApiKeyEncrypted` (no login column).
   - `aiProvider`, `aiModel`, `aiHarnessEffort`, `aiSummaryEffort`: copy when `!== undefined`; push field name.
2. If `changed.length === 0` → return `get()` (no write).
3. `row = await store.patch(patch)`.
4. Log `settings.updated` with `{ fields: changed }` (names only, never values).
5. Return `{ status: 200, data: toView(row) }`.

No cross-field rule is enforced: selecting `anthropic_api` without a key is allowed (the UI shows a warning from `hasAnthropicApiKey`; runs fail fast with `ai_not_configured`).

#### 5.5.3 `testGithub()`

1. `{ secret, storedCiphertext } = await store.readGithubTokenSnapshot()`.
2. `absent` → `400 { error: "Add a GitHub token first.", error_reason: "github_token_missing" }`.
3. `unreadable` → `400 { error: "The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again.", error_reason: "github_token_missing" }`.
4. `timeout = AbortSignal.timeout(GITHUB_TEST_TIMEOUT_MS)`; `result = await deps.verifyGithubToken(secret.value, { signal: timeout })` (`GITHUB_TEST_TIMEOUT_MS = 15_000` lives in `app.config.ts`; see §5.10). `verifyToken` never throws for HTTP/network/abort failures (06).
5. `result.ok` → `await store.setGithubLoginIfTokenUnchanged(storedCiphertext, result.login)`. If it returns `false` (the token was replaced or cleared during the 15 s check), log `settings.test_github.token_changed` and still return 200 with the login: the answer is true for the token that was tested, and the stale login is simply not persisted. Return `200 { status: 200, data: { login } satisfies GithubTestResultView }`.
6. `!result.ok` and `timeout.aborted` → the test's own timeout fired → `504 { error: "GitHub did not answer within {seconds} s.", error_reason: "internal_error" }` (00 §14.12; `seconds = GITHUB_TEST_TIMEOUT_MS / 1000`). Any other `!result.ok` → map per §5.8 table. Do not clear the stored token on failure. Log `settings.test_github.result` with `reason` and `status` only (`result.message` is never logged or returned verbatim for 401/403).

#### 5.5.4 `testAi()`

1. `settings = await store.readAiSettings()`.
2. `provider = deps.createProvider(settings)` inside try; `AiProviderError` with `reason === "config"` → `400 ai_not_configured` with the error's message.
3. For `claude_code`, `if (!(await ClaudeCodeProvider.isSdkAvailable()))` → `400 ai_not_configured` with the "could not be loaded" message (§5.8). Done here so the test fails fast instead of after the timeout.
4. `timeoutMs = settings.provider === "claude_code" ? AI_CLAUDE_CODE_CONNECTION_TEST_TIMEOUT_MS : AI_CONNECTION_TEST_TIMEOUT_MS`; `timeout = AbortSignal.timeout(timeoutMs)`; `nonce = deps.nonce()`; `request = buildConnectionTestRequest({ nonce, signal: timeout })`.
5. `started = deps.now()`; `result = await provider.generateStructured<ConnectionTestResponse>(request)`; `latencyMs = Math.round(deps.now() - started)`.
6. If `result.data.ok !== true || result.data.echo !== nonce` → `502 { error: "The AI answered but not with the expected check value. Try again.", error_reason: "internal_error" }` (log `ai.connection_test.mismatch`).
7. Success → `200` with `{ provider: settings.provider, model: result.model, latencyMs } satisfies AiTestResultView`.
8. Catch `AiProviderError`:
   - `reason === "aborted"` **and** `timeout.aborted` → the test's own timeout fired (the provider reports the caller signal as `aborted`, 05 §5.11.2 row 2) → `504` `internal_error` "The AI provider did not answer within {seconds} s." (`seconds = timeoutMs / 1000`; 00 §14.12).
   - otherwise map per §5.8.
   Any other error → rethrow (controller returns 500).

The test never touches `visualizations.ai_usage` (there is no visualization). It logs usage at info in `settings.test_ai.result`.

### 5.6 GitHub delegation (narrow interface required from sheet 06)

```ts
// in backend/src/utilities/services/github-client.ts (sheet 06 §5.6.3 — implemented there exactly like this)
export type GitHubTokenVerification =
  | { ok: true; login: string }
  | { ok: false; reason: "unauthorized" | "forbidden" | "rate_limited" | "network" | "unknown"; status: number | null; message: string };

export class GitHubClient {
  /** Calls GET /user with the token. Never throws for HTTP/network/abort failures; returns ok:false instead. */
  static verifyToken(token: string, options?: { signal?: AbortSignal }): Promise<GitHubTokenVerification>;
}
```

`message` from 06 is a sanitized sentence (must not contain the token). `SettingsService` does not show it to the user verbatim for `unauthorized`/`forbidden` (fixed messages in §5.8) but logs `reason` and `status`.

### 5.7 AI connection test (`ai-connection-test.ts`)

```ts
export interface ConnectionTestResponse { ok: boolean; echo: string; }

export const CONNECTION_TEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "echo"],
  properties: {
    ok: { type: "boolean", description: "Always true." },
    echo: { type: "string", description: "The check value from the prompt, copied exactly." },
  },
};

export const CONNECTION_TEST_SYSTEM =
  "You are the connectivity check for PRVision, a local developer tool. " +
  "Reply only with the JSON object described by the response schema. Do not add commentary.";

/** The caller owns the timeout signal so it can tell its own timeout apart from other aborts (§5.5.4 step 8). */
export function buildConnectionTestRequest(input: { nonce: string; signal: AbortSignal }): AiStructuredRequest {
  return {
    purpose: "connection_test",
    system: CONNECTION_TEST_SYSTEM,
    prompt: `Set "ok" to true and set "echo" to exactly this check value: ${input.nonce}`,
    jsonSchema: CONNECTION_TEST_SCHEMA,
    effort: "low",
    signal: input.signal,
  };
}
```

For the Claude Code provider, `workingDirectory` is omitted; the provider uses an empty private temp dir (§5.12.3).

### 5.8 HTTP status, `error_reason` and UX messages

The `error` string is the exact user-facing message (sheet 13 shows it in a snackbar/inline alert). `{model}`, `{seconds}`, `{category}`, `{status}`, `{sdkMessage}` are interpolated. Every `error_reason` below is from the complete list in 00 §14.2 and every error row carries one (04 §8.1); statuses follow 00 §14.12 / 01 §5.7.1. AI-side failures other than configuration and credentials have no dedicated code and use `internal_error` with a 502 (failing upstream) or 504 (the test's own timeout, 00 §14.12). Success bodies are data only (`GithubTestResultView` / `AiTestResultView`); the frontend writes the success sentence.

| Endpoint | Condition | HTTP | `error_reason` | Message |
|---|---|---|---|---|
| PUT | DTO invalid (incl. secret `null`, whitespace-only secret, unknown key) | 400 | `validation_failed` | class-validator messages (array) |
| PUT | success | 200 | — | `SettingsView` |
| GET / PUT / tests | unexpected exception | 500 | `internal_error` | Internal server error |
| test-github | no token | 400 | `github_token_missing` | Add a GitHub token first. |
| test-github | token unreadable | 400 | `github_token_missing` | The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again. |
| test-github | `unauthorized` (401) | 400 | `github_unauthorized` | GitHub rejected the token. Create a new fine-grained token with read access to Contents, Pull requests and Metadata. |
| test-github | `forbidden` (403) | 400 | `github_unauthorized` | GitHub accepted the token but denied access. Check the token's repository access and permissions. |
| test-github | `rate_limited` | 429 | `github_rate_limited` | GitHub rate limit reached. Try again in a few minutes. |
| test-github | test timeout (`GITHUB_TEST_TIMEOUT_MS` signal fired, §5.5.3 step 6) | 504 | `internal_error` | GitHub did not answer within {seconds} s. |
| test-github | `network` | 502 | `github_unavailable` | Could not reach GitHub. Check your network connection. |
| test-github | `unknown` | 502 | `github_unavailable` | GitHub returned an unexpected error (HTTP {status}). |
| test-github | ok | 200 | — | `{ login }` |
| test-ai | provider `anthropic_api`, key absent | 400 | `ai_not_configured` | Add an Anthropic API key, or switch the provider to Claude Code. |
| test-ai | key unreadable | 400 | `ai_not_configured` | The stored Anthropic API key can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the key again. |
| test-ai | Claude Agent SDK cannot be loaded | 400 | `ai_not_configured` | The Claude Code provider is unavailable: @anthropic-ai/claude-agent-sdk could not be loaded. Run npm install in backend/. |
| test-ai | `config` from API (400/404/422, e.g. unknown model) | 400 | `ai_not_configured` | The AI provider rejected the request for model "{model}": {sdkMessage} |
| test-ai | `auth`, Anthropic 401 | 400 | `ai_unauthorized` | Anthropic rejected the API key. Check that it is active and copied correctly. |
| test-ai | `auth`, Anthropic 403 | 400 | `ai_unauthorized` | The API key is not allowed to use model "{model}". |
| test-ai | `auth`, Claude Code | 400 | `ai_unauthorized` | Claude Code is not signed in or not authorized. Run `claude` in a terminal, sign in, then retry. |
| test-ai | `rate_limit` | 502 | `internal_error` | The AI provider is rate limited or overloaded. Try again shortly. |
| test-ai | test timeout (`aborted` with the test's own timeout signal fired, §5.5.4 step 8) | 504 | `internal_error` | The AI provider did not answer within {seconds} s. |
| test-ai | `network` (provider deadline or connection) | 502 | `internal_error` | Could not reach the AI provider. Check your network connection. |
| test-ai | `aborted` without the test timeout | 502 | `internal_error` | The AI request was cancelled. Try again. |
| test-ai | `refusal` | 502 | `internal_error` | {sdkMessage} Try again. (provider message is "The model declined the request (category: {category})."; no text parsing) |
| test-ai | `max_tokens` / `invalid_output` / `unknown` | 502 | `internal_error` | The AI answered but not in the expected format. Try again. |
| test-ai | nonce mismatch | 502 | `internal_error` | The AI answered but not with the expected check value. Try again. |
| test-ai | ok | 200 | — | `{ provider, model, latencyMs }` |

`{sdkMessage}` is `AiProviderError.message`, which providers build from the SDK error's `message` (never contains the key; SDK messages contain the API's error text and request id). It is passed through 04's `redactSecrets` and truncated to 300 chars before it is returned.

Status choice (00 §14.12): rejected or missing credentials and configuration are 400 (`github_unauthorized`, `ai_unauthorized`, `github_token_missing`, `ai_not_configured`); GitHub rate limiting is 429 `github_rate_limited`; an unreachable or failing GitHub is 502 `github_unavailable`; a failing AI provider is 502 `internal_error` (00 §14.2 has no AI rate-limit code, and 429 is reserved for `github_rate_limited`); a timed-out test is 504 `internal_error`. Never 401, so the frontend's HTTP interceptor (12) never confuses them with app-level auth.

### 5.9 `AiProviderFactory`

```ts
// backend/src/utilities/services/ai/ai-provider-factory.ts
// Imports only from ./ai-provider, ./anthropic-api-provider, ./claude-code-provider and config-consts.
// Never imports services/** (layering rule, §1).
export type AiReadiness =
  | { ready: true; provider: AiProviderKindValue; model: string }
  | { ready: false; reason: "ai_not_configured"; message: string };

export class AiProviderFactory {
  /**
   * Cheap check used by 07 at POST /api/visualizations (no network, no model call):
   * create(settings) in try/catch, plus ClaudeCodeProvider.isSdkAvailable() for claude_code.
   */
  static async readiness(settings: ResolvedAiSettings): Promise<AiReadiness>;

  /** Pure construction from resolved settings. Throws AiProviderError(reason "config"). */
  static create(settings: ResolvedAiSettings): AiProvider;
}
```

Callers read settings once with `new SettingsStore().readAiSettings()` and pass the same object to `readiness`/`create` and, in 07, to `PipelineContext.aiSettings` (model and efforts only; the key never enters the context).

`create(settings)` algorithm:

1. `settings.model.trim() === ""` → throw `AiProviderError("No AI model is configured. Set a model in Settings.", "config", false)`.
2. `switch (settings.provider)`:
   - `"anthropic_api"`:
     - `anthropicApiKey.state === "absent"` → throw config: "Add an Anthropic API key, or switch the provider to Claude Code."
     - `"unreadable"` → throw config: "The stored Anthropic API key can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the key again."
     - return `new AnthropicApiProvider({ apiKey, model })`.
   - `"claude_code"`: return `new ClaudeCodeProvider({ model })`. SDK availability is checked lazily on first call (dynamic import); a load failure is thrown as `AiProviderError(…, "config", false)` from `generateStructured`. `readiness(settings)` additionally attempts the dynamic import once (cached) so 07 can reject a run before queueing.
   - default (impossible due to CHECK constraint): throw config "Unknown AI provider".
3. Log `ai.provider.created` with `{ provider, model }`.

`readiness(settings)` = `create(settings)` in try/catch, mapping `AiProviderError(config)` to `{ ready: false, reason: "ai_not_configured", message }`; for `claude_code` also `await ClaudeCodeProvider.isSdkAvailable()` (false → the "could not be loaded" message). Any non-`AiProviderError` exception propagates.

07 calls `readiness(await store.readAiSettings())` in `VisualizationsService.create` (→ `400 ai_not_configured`) and, in the worker, `settings = await store.readAiSettings(); ai = AiProviderFactory.create(settings)` once per run. A `config` error in the worker fails the run before any git work (07 §5.9.6).

### 5.10 Constants (`config-consts/ai.config.ts`)

Sheet 02 holds the single consolidated list for `ai.config.ts` (00 §14.8); the values below are what 05 and 09 require, and 02's list must match them. No env vars are added (00 §4 list is complete).

```ts
export const AI_DEFAULT_PROVIDER = "anthropic_api" as const;
export const AI_DEFAULT_MODEL = "claude-opus-5-5";
export const AI_DEFAULT_HARNESS_EFFORT = "high" as const;
export const AI_DEFAULT_SUMMARY_EFFORT = "medium" as const;

export const AI_MAX_TOKENS_BY_PURPOSE = {
  harness: 64_000,
  harness_repair: 64_000,
  summary: 32_000,
  connection_test: 16_000,   // thinking cannot be disabled on claude-opus-5-5 and counts against max_tokens; only used tokens are billed
} as const;

export const AI_SDK_MAX_RETRIES = 2;                       // SDK retries 408/409/429/5xx + connection errors
export const AI_REQUEST_TIMEOUT_MS = 600_000;              // per SDK attempt
export const AI_CALL_DEADLINE_MS = 900_000;                // whole generateStructured call incl. retries
export const AI_SERVER_SIDE_FALLBACK_ENABLED = true;
export const AI_SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const AI_MAX_IMAGE_BASE64_CHARS = 6_900_000;        // ~5 MB decoded, API per-image limit

export const AI_CONNECTION_TEST_TIMEOUT_MS = 60_000;
export const AI_CLAUDE_CODE_CONNECTION_TEST_TIMEOUT_MS = 180_000;
export const AI_CLAUDE_CODE_TIMEOUT_MS = 900_000;
export const AI_CLAUDE_CODE_MAX_TURNS = 40;
export const AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES = 1;
export const AI_CLAUDE_CODE_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
] as const;                                                // plus any var starting with ANTHROPIC_ or CLAUDE_
export const AI_CLAUDE_CODE_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_"] as const;
/** Names that are dropped even if an allow rule matches (defence in depth; 00 §14.5). */
export const AI_CLAUDE_CODE_ENV_DENYLIST = ["PRVISION_SECRET_KEY", "DATABASE_URL", "REDIS_URL", "NODE_OPTIONS"] as const;

// Used by 09 (listed here so ai.config.ts is complete)
export const HARNESS_PROMPT_TOKEN_BUDGET = 48_000;
export const HARNESS_CONCURRENCY_ANTHROPIC_API = 2;
export const HARNESS_CONCURRENCY_CLAUDE_CODE = 1;
export const HARNESS_RETRY_DELAY_MS = 10_000;
export const HARNESS_MAX_CALLS_PER_COMPONENT = 3;
export const HARNESS_MAX_REPAIRS_PER_COMPONENT = 1;

// app.config.ts (02) gains:
export const GITHUB_TEST_TIMEOUT_MS = 15_000;
```

### 5.11 `AnthropicApiProvider`

Behaviour summary:

- One `Anthropic` client per provider instance: `new Anthropic({ apiKey, maxRetries: AI_SDK_MAX_RETRIES, timeout: AI_REQUEST_TIMEOUT_MS })`. The key is passed explicitly; the client must never fall back to ambient credentials (`ANTHROPIC_API_KEY`, `ant` profiles), so `apiKey` is required and non-empty by construction (factory step 2).
- Model: `this.options.model` from settings (default `claude-opus-5-5`, no date suffix).
- Always streams (`max_tokens` up to 64 000): `client.beta.messages.stream(params, { signal })` then `await stream.finalMessage()`. Never `messages.create` without streaming (long outputs would hit HTTP timeouts), never hand-rolled `.on()` promise wrappers.
- Always `thinking: { type: "adaptive" }` (thinking cannot be disabled on `claude-opus-5-5`; `budget_tokens` returns 400 — never send it).
- Always sets `output_config.effort` explicitly from the request (the model's default is `medium`; PRVision never relies on it).
- Structured output via `output_config.format = { type: "json_schema", schema }`. Never tools, never forced `tool_choice` (400 on this model), never assistant prefill (400), never the deprecated `output_format`.
- System prompt as one text block with `cache_control: { type: "ephemeral" }`, so repeated harness calls in one visualization (same system prompt, same schema, same effort) hit the prompt cache. Volatile content (component code, diffs, images) lives only in the user message, after the cached prefix.
- Images go before the text block in the user message.
- Server-side refusal fallback on by default: beta namespace with `betas: [AI_SERVER_SIDE_FALLBACK_BETA]` and `fallbacks: "default"`. **The implementer must verify against the current `@anthropic-ai/sdk` docs** that (a) `client.beta.messages.stream` exists and accepts `betas` and `fallbacks`, (b) the TypeScript param type includes `fallbacks: "default"` (if the installed SDK's types lag, upgrade the SDK; do not cast to `any` — a local `interface FallbackParams { fallbacks: "default" }` intersected with the param type is acceptable), and (c) the final message's `content` may contain `fallback` blocks (handled in `extractText`).
- `stop_reason` checked before reading content.
- JSON parsed and validated with `JsonSchemaValidator` (defence in depth: structured outputs guarantee syntax, ajv catches anything the API strips, e.g. if a schema keyword was unsupported).

#### 5.11.1 Skeleton

```ts
// backend/src/utilities/services/ai/anthropic-api-provider.ts
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_CALL_DEADLINE_MS, AI_MAX_IMAGE_BASE64_CHARS, AI_MAX_TOKENS_BY_PURPOSE, AI_REQUEST_TIMEOUT_MS,
  AI_SDK_MAX_RETRIES, AI_SERVER_SIDE_FALLBACK_BETA, AI_SERVER_SIDE_FALLBACK_ENABLED,
} from "../../../config-consts";
import { createLogger } from "../../loggers/logger";
import { AiProviderError, type AiProvider, type AiStructuredRequest, type AiStructuredResult, type AiUsage } from "./ai-provider";
import { JsonSchemaValidator } from "./json-schema-validator";

// VERIFY exact exported type names against the installed SDK's beta namespace.
// StreamParams = the param type accepted by client.beta.messages.stream(...), e.g. Anthropic.Beta.Messages.MessageStreamParams.
type StreamParams = Anthropic.Beta.Messages.MessageStreamParams;
type FinalMessage = Anthropic.Beta.Messages.BetaMessage;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;

/** Seam for tests: returns something with finalMessage(). */
export type AnthropicStreamFn = (
  params: StreamParams,
  options: { signal: AbortSignal },
) => { finalMessage(): Promise<FinalMessage> };

export interface AnthropicApiProviderOptions {
  apiKey: string;
  model: string;
  serverSideFallback?: boolean;      // default AI_SERVER_SIDE_FALLBACK_ENABLED
  streamFn?: AnthropicStreamFn;      // tests inject a fake
}

export class AnthropicApiProvider implements AiProvider {
  readonly kind = "anthropic_api" as const;
  private readonly streamFn: AnthropicStreamFn;
  private readonly fallbackEnabled: boolean;
  private readonly log = createLogger("ai.anthropic_api");

  constructor(private readonly options: AnthropicApiProviderOptions) {
    this.fallbackEnabled = options.serverSideFallback ?? AI_SERVER_SIDE_FALLBACK_ENABLED;
    if (options.streamFn) {
      this.streamFn = options.streamFn;
    } else {
      const client = new Anthropic({ apiKey: options.apiKey, maxRetries: AI_SDK_MAX_RETRIES, timeout: AI_REQUEST_TIMEOUT_MS });
      this.streamFn = (params, streamOptions) => client.beta.messages.stream(params, streamOptions);
    }
  }

  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    JsonSchemaValidator.assertStructuredOutputCompatible(request.jsonSchema);   // cached per schema
    this.assertImages(request);
    if (request.signal?.aborted) {
      throw new AiProviderError("AI request cancelled", "aborted", false);
    }

    const deadline = AbortSignal.timeout(AI_CALL_DEADLINE_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;   // Node >= 22.12 (00 §14.1)
    const startedAt = Date.now();

    let message: FinalMessage;
    try {
      message = await this.streamFn(this.buildParams(request), { signal }).finalMessage();
    } catch (error) {
      const mapped = this.mapError(error, request.signal, deadline);
      this.log.warn({ event: "ai.call.failed", purpose: request.purpose, reason: mapped.reason, retryable: mapped.retryable, durationMs: Date.now() - startedAt }, "AI call failed");
      throw mapped;
    }

    const usage = this.mapUsage(message);
    this.log.info({
      event: "ai.call.completed",
      purpose: request.purpose, model: message.model, stopReason: message.stop_reason,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      fallbackUsed: this.fallbackRan(message),
      durationMs: Date.now() - startedAt,
    }, "AI call completed");

    this.assertStopReason(message, usage);
    const text = this.extractText(message);
    const parsed = this.parseJson(text, usage);
    const validation = JsonSchemaValidator.validate<T>(request.jsonSchema, parsed);
    if (!validation.ok) {
      throw new AiProviderError(`AI output did not match the expected schema: ${validation.summary}`, "invalid_output", true, usage);
    }
    return { data: validation.value, usage, model: message.model };
  }

  private buildParams(request: AiStructuredRequest): StreamParams {
    const images = request.images ?? [];
    const content: ContentParam[] = images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 },
    }));
    const legend = images.map((image, index) => `Image ${index + 1}: ${image.label}`).join("\n");
    content.push({ type: "text", text: legend ? `${legend}\n\n${request.prompt}` : request.prompt });

    const base = {
      model: this.options.model,
      max_tokens: AI_MAX_TOKENS_BY_PURPOSE[request.purpose],
      thinking: { type: "adaptive" as const },
      output_config: {
        effort: request.effort,
        format: { type: "json_schema" as const, schema: request.jsonSchema },
      },
      system: [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content }],
    };
    return this.fallbackEnabled
      ? { ...base, betas: [AI_SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" }
      : base;
  }

  private assertStopReason(message: FinalMessage, usage: AiUsage): void {
    switch (message.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return;
      case "max_tokens":
        throw new AiProviderError("The AI response was cut off at the output token limit.", "max_tokens", false, usage);
      case "refusal": {
        // stop_details is populated only for refusals; guard before reading. A refusal here means the whole
        // server-side fallback chain declined (the fallback model can refuse too).
        const category = message.stop_details?.category ?? "unspecified";
        throw new AiProviderError(`The model declined the request (category: ${category}).`, "refusal", false, usage);
      }
      default:
        // tool_use / pause_turn cannot occur (no tools are sent); anything else is unexpected.
        throw new AiProviderError(`Unexpected stop reason: ${String(message.stop_reason)}`, "unknown", false, usage);
    }
  }

  /** Concatenates text blocks after the last fallback block (text before it came from a model that declined). */
  private extractText(message: FinalMessage): string {
    let start = 0;
    message.content.forEach((block, index) => {
      if (block.type === "fallback") start = index + 1;      // verify block type name against SDK
    });
    return message.content
      .slice(start)
      .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  private parseJson(text: string, usage: AiUsage): unknown {
    if (text.trim() === "") {
      throw new AiProviderError("The AI returned an empty response.", "invalid_output", true, usage);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AiProviderError("The AI returned text that is not valid JSON.", "invalid_output", true, usage);
    }
  }

  private mapUsage(message: FinalMessage): AiUsage {
    const u = message.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    return {
      inputTokens: u.input_tokens + cacheRead + cacheWrite,   // total input processed
      outputTokens: u.output_tokens,
      calls: 1,
      cacheReadInputTokens: cacheRead,
    };
  }

  private assertImages(request: AiStructuredRequest): void {
    for (const image of request.images ?? []) {
      if (image.base64.length > AI_MAX_IMAGE_BASE64_CHARS) {
        // Caller bug (11 must downscale); "unknown" + not retryable so 09 does not treat it as a fatal config error.
        throw new AiProviderError(`Image "${image.label}" is larger than the 5 MB API limit; downscale before sending.`, "unknown", false);
      }
    }
  }

  /**
   * Served-by signal for server-side fallback: true when usage.iterations contains an entry of type
   * "fallback_message" (covers sticky turns that carry no `fallback` content block). VERIFY the field and
   * entry type names against the installed SDK; if absent, fall back to `content.some(b => b.type === "fallback")`.
   */
  private fallbackRan(message: FinalMessage): boolean { /* … */ }

  private mapError(error: unknown, callerSignal: AbortSignal | undefined, deadline: AbortSignal): AiProviderError { /* §5.11.2 */ }
}
```

`combineSignals` is not needed: Node ≥ 22.12 (00 §14.1) has `AbortSignal.any`. `ClaudeCodeProvider` uses `AbortSignal.any` directly too.

`mapUsage` note: with server-side fallback, verify whether top-level `usage` already aggregates all iterations (`usage.iterations`). If it does not, sum `input_tokens`/`output_tokens`/cache fields across `usage.iterations`. Document the finding in a code comment and cover it with a test using a canned message that has two iterations.

#### 5.11.2 Error mapping (most specific first; never string-match)

Checked in this order inside `mapError`:

| # | Condition | `reason` | `retryable` | Message |
|---|---|---|---|---|
| 1 | `error instanceof AiProviderError` | (as is) | (as is) | (as is) |
| 2 | `callerSignal?.aborted` | `aborted` | false | AI request cancelled |
| 3 | `deadline.aborted` | `network` | true | AI request timed out after {AI_CALL_DEADLINE_MS/1000} s |
| 4 | `Anthropic.APIUserAbortError` | `aborted` | false | AI request aborted |
| 5 | `Anthropic.AuthenticationError` (401) | `auth` | false | Anthropic rejected the API key (401). |
| 6 | `Anthropic.PermissionDeniedError` (403) | `auth` | false | The API key is not allowed to use model "{model}" (403). |
| 7 | `Anthropic.RateLimitError` (429) | `rate_limit` | true | Anthropic rate limit reached (429). |
| 8 | `Anthropic.NotFoundError` (404) | `config` | false | Model "{model}" was not found (404). |
| 9 | `Anthropic.BadRequestError` (400) | `config` | false | Request rejected (400): {error.message} |
| 10 | `Anthropic.UnprocessableEntityError` (422) | `config` | false | Request rejected (422): {error.message} |
| 11 | `Anthropic.APIConnectionTimeoutError` | `network` | true | Connection to Anthropic timed out. |
| 12 | `Anthropic.APIConnectionError` | `network` | true | Could not connect to Anthropic. |
| 13 | `Anthropic.InternalServerError` with `status === 529` | `rate_limit` | true | Anthropic is overloaded (529). |
| 14 | `Anthropic.InternalServerError` | `unknown` | true | Anthropic server error ({status}). |
| 15 | `Anthropic.APIError` (any other status) | `unknown` | `status >= 500` | Anthropic API error ({status}). |
| 16 | anything else | `unknown` | false | Unexpected AI client error. |

Rows 4 and 11–12 must be checked before row 15 because `APIUserAbortError` and `APIConnectionError` extend `APIError`; row 11 before 12 because the timeout error extends the connection error. "retryable" means "a later attempt may succeed"; the SDK has already retried 408/409/429/5xx twice. Callers (09/11) decide whether to retry once more.

Messages include `error.message` only for 400/422 (the API's validation text is useful for model/parameter problems and does not contain the key). Truncate to 300 chars.

#### 5.11.3 Timeouts and cancellation

- Per-attempt timeout: SDK option `timeout: AI_REQUEST_TIMEOUT_MS`.
- Whole-call deadline: `AbortSignal.timeout(AI_CALL_DEADLINE_MS)` combined with `request.signal` via `AbortSignal.any`; passed to `stream(…, { signal })`. The SDK aborts the HTTP stream and `finalMessage()` rejects with `APIUserAbortError`; rows 2–3 disambiguate caller-cancel vs deadline.
- `request.signal` from 09/11 is `PipelineContext.signal`, aborted on user cancel, worker shutdown or the 45-minute run limit (00 §14.6). The provider reports all three as `aborted`; 07 classifies the run outcome from `signal.reason`.
- SDK retries (`maxRetries: 2`) also stop when the signal aborts. Worst-case wall time of one call is therefore `min(AI_CALL_DEADLINE_MS, 3 × AI_REQUEST_TIMEOUT_MS)` = 15 min.

### 5.12 `ClaudeCodeProvider`

Uses the locally installed Claude Code via `@anthropic-ai/claude-agent-sdk` (Claude Code as a library: `query({ prompt, options })` returns an async iterator of messages). This is a **separate product** from the Messages API: there is no `output_config`, no prompt-cache control, and option names must be confirmed by the implementer against https://code.claude.com/docs/en/agent-sdk before coding. The skeleton below names behaviours; the `VERIFY:` comments mark every SDK-specific name.

Policy (00 D5): Anthropic does not allow third-party products to route requests through users' Claude.ai subscription logins. This provider may use the developer's own Claude Code login for this personal prototype only. Before any distribution, the provider must require API-key auth (e.g. `ANTHROPIC_API_KEY` in the child environment) or be removed. The settings screen (13) shows this note next to the provider choice: "Claude Code uses your local Claude Code sign-in. Prototype use only."

#### 5.12.1 Behaviour

| Concern | Required behaviour |
|---|---|
| Loading | Lazy `await import("@anthropic-ai/claude-agent-sdk")` on first use, cached in a static promise. Failure → `AiProviderError("The Claude Code provider is unavailable: @anthropic-ai/claude-agent-sdk could not be loaded. Run npm install in backend/.", "config", false)`. `static isSdkAvailable(): Promise<boolean>` for readiness. If the backend compiles to CommonJS, the dynamic import must survive compilation (tsconfig `module: "NodeNext"`/`"Node16"` keeps `import()` native; confirm with sheet 02). |
| Working directory | `request.workingDirectory` (09 passes the head worktree). When absent (connection test, summary), create an empty private temp dir with `fs.mkdtemp(path.join(os.tmpdir(), "prvision-cc-"))` (mode 0700, unpredictable suffix) and remove it in `finally`. |
| Tools | Only `Read`, `Glob`, `Grep`. Everything else (Bash, Write, Edit, NotebookEdit, WebFetch, WebSearch, Task/subagents, MCP tools) disallowed. VERIFY: allowed-tools option + disallowed-tools option. |
| Permission handling | Non-interactive: no prompt may ever block. Use the SDK's permission callback (VERIFY name, e.g. a `canUseTool`-style hook) to **deny** any tool not in the allow-list and any `Read`/`Glob`/`Grep` whose path resolves (realpath) outside `cwd` or the image temp dir, or that matches `**/.env*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, `**/.git/**`, `**/node_modules/**`. Permission mode: the mode that does not prompt and does not auto-approve edits (VERIFY). |
| Settings isolation | Do not load user/project/local Claude Code settings, hooks, CLAUDE.md memory, slash commands or MCP servers from the target repository: a repo's `.claude/settings.json` can define hooks that run shell commands. VERIFY the option that controls setting sources and set it to none. |
| Environment | Pure helper `buildClaudeCodeEnv(base = AI_CLAUDE_CODE_PARENT_ENV): Record<string, string>` keeps only names in `AI_CLAUDE_CODE_ENV_ALLOWLIST` or starting with an `AI_CLAUDE_CODE_ENV_PREFIXES` entry, then deletes every `AI_CLAUDE_CODE_ENV_DENYLIST` name and every `PRVISION_*` name. It starts from `AI_CLAUDE_CODE_PARENT_ENV` (02 §6.7, 00 §14.12), never from `CHILD_PROCESS_BASE_ENV` (that strict allow-list deliberately excludes `ANTHROPIC_*`, `CLAUDE_*` and the CA-certificate variables Claude Code needs) and never from `process.env` (only config-consts may read it, 00 §14.12). The filter is re-applied to the base as defence in depth, so a test-supplied base is held to the same rules. Result: an allow-listed env without `PRVISION_SECRET_KEY`, `DATABASE_URL`, `REDIS_URL` (00 §14.5). The decrypted Anthropic key from settings is **not** injected. VERIFY the env option name; also VERIFY that passing `env` replaces rather than merges with the parent env — if the SDK merges, the provider must spawn through the SDK's documented custom-spawn hook (VERIFY) with this env. |
| Model | `options.model` = settings model. VERIFY option name. |
| Effort | If the SDK exposes an effort/thinking-depth option, pass `request.effort`; otherwise ignore and log once at debug `ai.claude_code.effort_unsupported`. Do not invent the name. |
| Turns | Cap at `AI_CLAUDE_CODE_MAX_TURNS` (VERIFY option). Hitting the cap → `invalid_output` (retryable). |
| System prompt | Pass `request.system` as the system prompt (replace or append to Claude Code's default — prefer the documented "custom system prompt" option; VERIFY). Then the JSON output contract (below) is appended to the user prompt, not the system prompt, so the system text stays identical across calls. |
| Structured output | If the installed SDK documents a native JSON-schema output option, use it. Otherwise prompt-based: append to the prompt: `Respond with ONLY a single JSON object that validates against this JSON Schema (draft 2020-12). No prose, no markdown fences.\n<json_schema>\n{schema}\n</json_schema>`. |
| Images | Write each image to `<imgDir>/<index>-<slug(label)>.png` (`imgDir` = `fs.mkdtemp(path.join(os.tmpdir(), "prvision-cc-img-"))`, dir 0700, files written with `{ mode: 0o600, flag: "wx" }`). Prepend to prompt: `Before answering, use the Read tool to view these images:\n1. {absPath} — {label}\n…`. Delete the dir in `finally`. The permission hook allows `Read` inside `imgDir`. |
| Result | Consume the iterator to completion; take the final result message (VERIFY type/subtype; current docs describe a terminal `result` message carrying the final text, an error flag and usage). All SDK message-shape knowledge lives in `claude-code-result.ts` (`extractFinalResult(messages)`), nothing else reads SDK fields. |
| JSON extraction | `extractJsonObject(text)`: strip one surrounding ```` ```json ```` / ```` ``` ```` fence if present; scan for the first `{`; walk with a brace counter that understands JSON strings and escapes; slice to the matching `}`; `JSON.parse`. No match or parse failure → invalid. |
| Validation | `JsonSchemaValidator.validate(request.jsonSchema, parsed)`. |
| One retry on invalid output | If extraction/validation fails: run one new `query` with the same system prompt and a prompt that contains the original prompt, the previous raw output (first 8 000 chars) and the formatted validation errors, ending with: `Your previous reply did not satisfy the required JSON Schema. Errors:\n{errors}\nReturn ONLY the corrected JSON object.` Second failure → `AiProviderError("Claude Code did not return valid JSON after a retry: {summary}", "invalid_output", true, usage)`. `AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES = 1`. |
| Timeout / abort | `AbortController` linked to `request.signal` and `AbortSignal.timeout(AI_CLAUDE_CODE_TIMEOUT_MS)`; pass it to the SDK (VERIFY option, e.g. an abort controller option) **and** call the iterator's `return()` on abort so the child process exits. Caller abort → `aborted`; deadline → `network`, retryable true, message "Claude Code did not finish within {s} s." |
| Usage | Map from the result message if present (input + cache read + cache creation → `inputTokens`, output → `outputTokens`, cache read → `cacheReadInputTokens`); otherwise zeros. `calls` = number of `query` invocations (1 or 2). Sum across the retry with `addUsage`. |
| Model reported | Model id from the SDK's init/system message if exposed (VERIFY), else the configured model. |
| Errors | Map from typed signals only: SDK error classes (if exported), result subtype, error flag. An auth/sign-in failure signalled by the SDK → `auth`. A failed spawn (Claude Code binary missing) → `config` ("Claude Code is not installed or not on PATH."). Anything else → `unknown` with the SDK's own message (truncated 300 chars) — free text is shown, not parsed. |
| Concurrency | The provider itself is stateless; 09 limits harness concurrency to 1 for this provider. |

#### 5.12.2 Skeleton

```ts
// backend/src/utilities/services/ai/claude-code-provider.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES, AI_CLAUDE_CODE_MAX_TURNS, AI_CLAUDE_CODE_TIMEOUT_MS } from "../../../config-consts";
import { createLogger } from "../../loggers/logger";
import { AiProviderError, ZERO_USAGE, addUsage, type AiProvider, type AiStructuredRequest, type AiStructuredResult, type AiUsage } from "./ai-provider";
import { extractFinalResult, type AgentFinalResult } from "./claude-code-result";
import { JsonSchemaValidator } from "./json-schema-validator";

/** Narrow structural type of the SDK's query(); replace `unknown` message type with the SDK's exported type once confirmed. */
export type AgentQueryFn = (args: { prompt: string; options: ClaudeCodeQueryOptions }) => AsyncIterable<unknown>;

/** Behavioural options. buildSdkOptions() translates these into the SDK's real option object (VERIFY names). */
export interface ClaudeCodeQueryOptions {
  cwd: string;
  model: string;
  systemPrompt: string;
  allowedTools: readonly ["Read", "Glob", "Grep"];
  readableRoots: string[];              // cwd + image dir; enforced by the permission callback
  maxTurns: number;
  env: Record<string, string>;
  abortController: AbortController;
  effort: AiStructuredRequest["effort"];
}

export class ClaudeCodeProvider implements AiProvider {
  readonly kind = "claude_code" as const;
  private static sdkPromise: Promise<AgentQueryFn> | null = null;
  private readonly log = createLogger("ai.claude_code");

  constructor(private readonly options: { model: string; queryFn?: AgentQueryFn }) {}

  static async isSdkAvailable(): Promise<boolean> { /* try loadSdk(); return true/false */ }

  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    if (request.signal?.aborted) throw new AiProviderError("AI request cancelled", "aborted", false);
    const queryFn = this.options.queryFn ?? (await ClaudeCodeProvider.loadSdk());
    const scratch = await this.prepareScratch(request);         // cwd fallback + image files
    let usage: AiUsage = ZERO_USAGE;
    try {
      let prompt = this.composePrompt(request, scratch.imagePaths);
      for (let attempt = 0; attempt <= AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES; attempt += 1) {
        const final = await this.runOnce(queryFn, prompt, request, scratch);
        usage = addUsage(usage, final.usage ?? { ...ZERO_USAGE, calls: 1 });
        this.throwIfFailed(final, usage);
        const outcome = this.parseAndValidate<T>(final.text, request.jsonSchema);
        if (outcome.ok) {
          return { data: outcome.value, usage, model: final.model ?? this.options.model };
        }
        this.log.warn({ event: "ai.claude_code.invalid_output", purpose: request.purpose, attempt, errors: outcome.errors.slice(0, 5) }, "Claude Code returned invalid output");
        prompt = this.composeRetryPrompt(request, scratch.imagePaths, final.text, outcome.errors);
      }
      throw new AiProviderError("Claude Code did not return valid JSON after a retry.", "invalid_output", true, usage);
    } finally {
      await scratch.cleanup();
    }
  }

  private async runOnce(queryFn: AgentQueryFn, prompt: string, request: AiStructuredRequest, scratch: Scratch): Promise<AgentFinalResult> {
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(AI_CLAUDE_CODE_TIMEOUT_MS);
    const combined = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    if (combined.aborted) controller.abort();
    const onAbort = (): void => controller.abort();
    combined.addEventListener("abort", onAbort, { once: true });
    const messages: unknown[] = [];
    const iterable = queryFn({ prompt, options: this.queryOptions(request, scratch, controller) });
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        messages.push(next.value);
      }
      return extractFinalResult(messages);
    } catch (error) {
      if (request.signal?.aborted) throw new AiProviderError("AI request cancelled", "aborted", false);
      if (deadline.aborted) throw new AiProviderError(`Claude Code did not finish within ${AI_CLAUDE_CODE_TIMEOUT_MS / 1000} s.`, "network", true);
      throw this.mapSdkError(error);
    } finally {
      combined.removeEventListener("abort", onAbort);
      await iterator.return?.();                                   // ensures the child process is stopped
    }
  }

  /* composePrompt, composeRetryPrompt, queryOptions, prepareScratch, parseAndValidate, throwIfFailed, mapSdkError, loadSdk … */
}
```

`claude-code-result.ts`:

```ts
export interface AgentFinalResult {
  text: string;                    // final assistant text ("" when missing)
  isError: boolean;
  errorKind: "auth" | "max_turns" | "spawn" | "other" | null;   // derived from typed fields only
  errorMessage: string | null;
  usage: AiUsage | null;
  model: string | null;
}
/** The only function that knows the Agent SDK message shapes. VERIFY all field names against the docs. */
export function extractFinalResult(messages: readonly unknown[]): AgentFinalResult;
export function extractJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string };
```

`extractFinalResult` uses type guards (`isRecord(x) && x["type"] === "result"` etc.), never casts to `any`. If no result message arrived → `{ isError: true, errorKind: "other", errorMessage: "Claude Code ended without a result." }`.

### 5.13 `JsonSchemaValidator`

```ts
// backend/src/utilities/services/ai/json-schema-validator.ts
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

export type SchemaValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[]; summary: string };

export class JsonSchemaValidator {
  private static readonly ajv = new Ajv2020({
    strict: true,            // unknown keywords, ambiguous types => compile error (catches schema bugs at first use)
    allErrors: true,         // report all problems so retry prompts can fix them in one go
    allowUnionTypes: true,   // permits type: ["string", "null"]
    validateFormats: false,  // PRVision schemas do not use "format"
  });
  private static readonly byIdentity = new WeakMap<object, ValidateFunction>();
  private static readonly byText = new Map<string, ValidateFunction>();   // dynamically built schemas, max 50 entries (FIFO evict)
  private static readonly compatChecked = new WeakSet<object>();

  static validate<T>(schema: Record<string, unknown>, data: unknown): SchemaValidation<T> {
    const validateFn = JsonSchemaValidator.compile(schema);
    if (validateFn(data)) return { ok: true, value: data as T };   // the only cast: ajv has just proven the shape
    const errors = JsonSchemaValidator.formatErrors(validateFn.errors ?? []);
    return { ok: false, errors, summary: errors.slice(0, 3).join("; ") };
  }

  static compile(schema: Record<string, unknown>): ValidateFunction { /* WeakMap, then text map, then ajv.compile */ }

  /** "/mockedModules/0/specifier: must be string" — max 10 lines, each ≤ 200 chars. */
  static formatErrors(errors: readonly ErrorObject[], max = 10): string[] {
    return errors.slice(0, max).map((e) => {
      const where = e.instancePath === "" ? "(root)" : e.instancePath;
      const extra =
        e.keyword === "additionalProperties" ? ` "${String((e.params as { additionalProperty?: unknown }).additionalProperty)}"` :
        e.keyword === "enum" ? ` (${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})` :
        e.keyword === "required" ? ` "${String((e.params as { missingProperty?: unknown }).missingProperty)}"` : "";
      return `${where}: ${e.message ?? e.keyword}${extra}`.slice(0, 200);
    });
  }

  /**
   * Throws Error (programming bug, not AiProviderError) when the schema uses keywords that
   * Anthropic structured outputs does not support, or when an object schema is not closed.
   * Rules (verify against the current structured-outputs docs):
   *  - every `type: "object"` has `additionalProperties: false` and `required` listing every key in `properties`
   *  - forbidden keywords anywhere: minLength, maxLength, pattern, minimum, maximum, exclusiveMinimum,
   *    exclusiveMaximum, multipleOf, minItems, maxItems, uniqueItems, contains, minProperties, maxProperties,
   *    patternProperties, propertyNames, if/then/else, $schema, $id
   *  - no recursive $ref
   * Optional fields are expressed as `type: ["string","null"]` and still listed in `required`.
   */
  static assertStructuredOutputCompatible(schema: Record<string, unknown>): void;
}
```

Every schema used with `generateStructured` (connection test, harness, summary) must pass `assertStructuredOutputCompatible`. Extra semantic constraints (lengths, uniqueness) are enforced in code by the consuming service (e.g. 09's harness validator), not in the schema.

## 6. Error handling and edge cases

| Case | Behaviour |
|---|---|
| First run, no `app_settings` row | Migration 0001 seeds it. If it was deleted manually, `getOrCreate` re-inserts defaults (`ON CONFLICT DO NOTHING`), so concurrent first requests are safe. |
| Two PUTs racing | Each is a single upsert statement; last write wins per column; no lost-update on untouched columns because only defined keys are in `set`. |
| Token replaced while test-github is running | `setGithubLoginIfTokenUnchanged` matches 0 rows; the login of the old token is not persisted; response still 200 for the tested token. |
| test-ai exceeds its own timeout | Provider throws `aborted`; service sees its timeout signal fired → 504 `internal_error`. |
| test-github exceeds its own timeout | `verifyToken` returns `ok: false` (`network`); service sees its timeout signal fired → 504 `internal_error`. |
| `PRVISION_SECRET_KEY` changed | `readSecret` returns `unreadable`; GET still shows `hasX: true`; tests and factory return messages telling the user to re-enter. Re-entering overwrites. Clearing (`""`) also works. |
| Stored secret without prefix (manual DB edit) | Treated as `unreadable`; never used as plaintext. |
| PUT with `githubToken: null` | 400 `validation_failed`. |
| PUT with unknown key | 400 `validation_failed` (forbidNonWhitelisted). |
| PUT with only `githubToken: ""` when no token stored | Writes `null` (idempotent), returns view. |
| test-github while token being replaced | Uses whatever is stored at read time; fine for single user. |
| test-github succeeds | Persists `github_login`; frontend reloads settings. |
| test-ai with `claude_code` and Claude Code not signed in | `auth` → 400 `ai_unauthorized` with sign-in instruction. |
| Model set to a model that rejects adaptive thinking / effort / structured outputs | API returns 400 → `config` → 400 `ai_not_configured` with the API message. PRVision targets `claude-opus-5-5` and current-generation models. |
| `stop_reason: "refusal"` even after server-side fallback | `refusal` error with category; not retryable. |
| Mid-stream refusal followed by fallback | `extractText` ignores text before the last `fallback` block. |
| `stop_reason: "max_tokens"` | `max_tokens` error, not retryable (caller may shrink context). |
| Response not JSON / schema mismatch | `invalid_output`, retryable; usage attached. |
| Caller aborts mid-stream | `aborted`; no further retries anywhere. |
| SDK retries exhausted on 429/529 | `rate_limit`, retryable true (caller may wait and retry once). |
| Image over 5 MB | rejected before sending (`unknown`, not retryable); 11 must downscale. |
| Schema uses unsupported keyword | `assertStructuredOutputCompatible` throws `Error` on first use (developer bug, surfaces in tests). |
| Agent SDK package missing | `config` "could not be loaded"; readiness false. |
| Claude Code tries a disallowed tool | Permission callback denies; agent continues; if it ends without a valid result → `invalid_output`. |
| Claude Code tries to read `.env` / outside cwd | Denied by callback; logged at warn `ai.claude_code.read_denied` with the relative path only. |

## 7. Logging / console events

pino events (structured fields only; no prompts, no outputs, no secrets):

| Event | Level | Fields |
|---|---|---|
| `settings.updated` | info | `fields` (names, e.g. `["aiModel","githubToken(set)"]`) |
| `settings.secret.decrypt_failed` | warn | `secret` (`github_token` / `anthropic_api_key`), `reason` (`EncryptionError.reason`) |
| `settings.secret.unknown_format` | warn | `secret` |
| `settings.test_github.result` | info | `ok`, `reason?`, `status?`, `login?` |
| `settings.test_github.token_changed` | info | — |
| `settings.controller.unhandled` | error | `action`, `err` (04 serializer) |
| `settings.test_ai.result` | info | `ok`, `provider`, `model`, `reason?`, `latencyMs`, `inputTokens?`, `outputTokens?` |
| `ai.provider.created` | info | `provider`, `model` |
| `ai.call.completed` | info | `purpose`, `model`, `stopReason`, `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `fallbackUsed`, `durationMs` |
| `ai.call.failed` | warn | `purpose`, `reason`, `retryable`, `status?`, `durationMs` |
| `ai.claude_code.invalid_output` | warn | `purpose`, `attempt`, `errors` (validator lines, max 5) |
| `ai.claude_code.read_denied` | warn | `tool`, `relativePath` |
| `ai.claude_code.effort_unsupported` | debug | — |

Pino redaction: 04's `REDACT_PATHS` (04 §9.10) covers `githubToken`, `anthropicApiKey`, `apiKey`, the `*Encrypted` columns, `authorization` headers and `headers["x-api-key"]` / `*.headers["x-api-key"]` (the Anthropic SDK's auth header). Independently of redaction, this sheet never logs request bodies, DTOs, SDK error objects or settings rows.

This sheet writes no `visualization_console_events` (settings are not part of a run). 09/11 write console events for AI calls inside a visualization.

## 8. Security notes

- Secrets encrypted at rest (AES-256-GCM via 04 `Encryption`, `enc:v1:` prefix). Plaintext only exists in memory inside `SettingsStore.readSecret` callers and the SDK client.
- GET never returns secrets or ciphertext; only `hasGithubToken` / `hasAnthropicApiKey`.
- Controllers never echo `error.message` on 500 for settings routes.
- DTO rejects `null` and whitespace-only secrets; unknown keys rejected.
- Logs never contain secrets, prompts, AI outputs or component source.
- The API key is passed only to `new Anthropic({ apiKey })`; it is never put in env vars of child processes, never placed in `PipelineContext`, never logged.
- Claude Code child: env built from `AI_CLAUDE_CODE_PARENT_ENV` (02 §6.7) through an allow-list (no `PRVISION_SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, 00 §14.5, §14.12), read-only tools, path-confined reads (realpath), sensitive-file deny list, no repo-defined settings/hooks/MCP loaded, temp files 0600 in 0700 dirs created with `mkdtemp` (unpredictable names, no symlink pre-creation possible), deleted in `finally`.
- Prompt-injection: repository content sent to the AI is untrusted. This layer cannot prevent injected instructions, but (a) Claude Code has no write/exec tools, (b) outputs are schema-validated, (c) 09 statically validates harness code (no network APIs) before anything runs.
- Policy (D5): Claude Code provider uses the developer's own login, prototype only; before distribution require API-key auth or remove the provider.
- Server binds `127.0.0.1` (04); settings endpoints have no extra auth by design (single local user).

## 9. Tests

All `node:test` + `assert/strict`, inside `runWithAuthContext`. No network: Anthropic and Agent SDK are faked via injected `streamFn` / `queryFn`; GitHub via injected `verifyGithubToken`; DB via a stubbed `SettingsStore` or patched `QueryHandler`/db (`patchStaticMethod`). `PRVISION_SECRET_KEY` set to a fixed test key in the test bootstrap (04).

`tests/backend/settings/settings-update-dto.test.ts`
- `accepts empty body`
- `accepts githubToken "" as clear`
- `rejects githubToken null`
- `rejects whitespace-only githubToken`
- `trims surrounding whitespace from a valid token`
- `rejects githubToken with illegal characters`
- `accepts anthropicApiKey starting with sk-ant-`
- `rejects anthropicApiKey without sk-ant- prefix`
- `rejects unknown aiProvider`
- `rejects unknown effort value`
- `rejects aiModel with uppercase or spaces`
- `rejects unknown property hasGithubToken`

`tests/backend/settings/settings-store.test.ts`
- `encryptSecret produces enc:v1: prefix and round-trips through readSecret`
- `readSecret returns absent for null and empty`
- `readSecret returns unreadable for value without prefix`
- `readSecret returns unreadable when decryption throws`
- `patch only writes defined keys`
- `getOrCreate selects without inserting when the seeded row exists`
- `getOrCreate inserts defaults when the row is missing`
- `setGithubLoginIfTokenUnchanged returns false and writes nothing when the ciphertext changed`
- `readAiSettings returns provider, model, efforts and the decrypted key from one row read`

`tests/backend/settings/settings-service.test.ts`
- `get returns SettingsView without secrets`
- `update with empty dto does not write`
- `update encrypts a new github token and resets githubLogin`
- `update with githubToken "" clears token and login`
- `update with anthropicApiKey "" clears the key`
- `update logs field names but never values` (capture logger)
- `testGithub returns 400 github_token_missing when absent`
- `testGithub returns 400 github_token_missing when unreadable`
- `testGithub persists login on success and returns { login: "octo" }`
- `testGithub does not persist login when the token changed during the check`
- `testGithub maps unauthorized to 400 github_unauthorized`
- `testGithub maps rate_limited to 429 github_rate_limited`
- `testGithub maps network to 502 github_unavailable`
- `testGithub maps its own timeout to 504 internal_error`
- `testAi returns 400 ai_not_configured when key absent`
- `testAi returns 400 ai_not_configured for claude_code when the SDK cannot be loaded`
- `testAi returns 200 { provider, model, latencyMs } when provider echoes nonce` (model = `result.model`)
- `testAi returns 502 internal_error when echo mismatches`
- `testAi maps auth to 400 ai_unauthorized`
- `testAi maps aborted with its own timeout fired to 504 internal_error`
- `testAi maps network to 502 internal_error`
- `testAi maps rate_limit to 502 internal_error`
- `testAi maps refusal to 502 internal_error with the provider message`
- `testAi error messages are redacted and capped at 300 chars`

`tests/backend/settings/settings-controller.test.ts`
- `update returns 400 validation_failed for invalid body without calling service`
- `get returns 500 { error: "Internal server error", error_reason: "internal_error" } when service throws, and logs the error`
- `testGithub and testAi delegate to the service and return its status unchanged`

`tests/backend/ai/json-schema-validator.test.ts`
- `validates a conforming object`
- `reports additionalProperties with property name`
- `reports missing required property`
- `caches compiled validator per schema object` (compile spy count = 1 for two validations)
- `strict mode rejects unknown keyword at compile`
- `assertStructuredOutputCompatible rejects minLength`
- `assertStructuredOutputCompatible rejects object without additionalProperties false`
- `assertStructuredOutputCompatible rejects property missing from required`
- `formatErrors caps at 10 lines`

`tests/backend/ai/anthropic-api-provider.test.ts` (fake `streamFn` records params)
- `builds params with model claude-opus-5-5, adaptive thinking, explicit effort and json_schema format`
- `never sends budget_tokens, tool_choice, tools, output_format, temperature or assistant prefill` (the last message is always `role: "user"`)
- `puts system prompt in a single cached block`
- `places image blocks before the text block with a legend`
- `adds betas ["server-side-fallback-2026-07-01"] and fallbacks "default" when fallback enabled`
- `omits betas and fallbacks when fallback disabled`
- `passes the caller signal combined with the deadline to stream()`
- `returns parsed data, model and usage including cache reads`
- `sums usage across iterations when a fallback ran` (per the §5.11.1 VERIFY finding)
- `throws max_tokens on stop_reason max_tokens`
- `throws refusal with stop_details category`
- `ignores text before the last fallback block`
- `throws invalid_output on non-JSON text`
- `throws invalid_output on schema mismatch with usage attached`
- `maps AuthenticationError to auth non-retryable`
- `maps PermissionDeniedError to auth`
- `maps RateLimitError to rate_limit retryable`
- `maps 529 InternalServerError to rate_limit`
- `maps BadRequestError to config with API message`
- `maps NotFoundError to config`
- `maps APIConnectionTimeoutError to network retryable`
- `maps caller abort to aborted`
- `maps deadline expiry to network retryable`
- `rejects oversize image before calling the API`

Constructing SDK error instances in tests: use the SDK's exported classes with their public constructors (VERIFY constructor arguments in the installed version); if impractical, build them via `Anthropic.APIError.generate(status, body, message, headers)` (VERIFY).

`tests/backend/ai/claude-code-provider.test.ts` (fake `queryFn`)
- `passes cwd from workingDirectory`
- `uses a temp cwd when workingDirectory is absent and removes it`
- `restricts tools to Read, Glob, Grep`
- `buildClaudeCodeEnv defaults its base to AI_CLAUDE_CODE_PARENT_ENV`
- `buildClaudeCodeEnv keeps PATH/HOME and ANTHROPIC_* and drops PRVISION_SECRET_KEY, DATABASE_URL, REDIS_URL, NODE_OPTIONS and unrelated vars`
- `does not load setting sources from the repository` (asserts the VERIFY'd option is set to none)
- `writes images to temp files, references them in the prompt, deletes them`
- `extracts JSON from fenced output`
- `retries once with validation errors when output is invalid`
- `fails with invalid_output after second invalid output and sums usage over two calls`
- `maps caller abort to aborted and closes the iterator`
- `maps deadline to network retryable`
- `permission callback denies read outside cwd`
- `permission callback denies .env files`
- `returns config error when the SDK cannot be loaded`

`tests/backend/ai/claude-code-result.test.ts`
- `extractJsonObject handles braces inside strings`
- `extractJsonObject handles escaped quotes`
- `extractJsonObject returns error when no object`
- `extractFinalResult reports missing result message as error`

`tests/backend/ai/ai-provider-factory.test.ts`
- `create returns AnthropicApiProvider when key present`
- `create throws config when key absent`
- `create throws config when key unreadable`
- `create returns ClaudeCodeProvider without a key`
- `create throws config for empty model`
- `readiness(settings) returns ai_not_configured message without touching the DB`
- `readiness for claude_code checks sdk availability`

`tests/backend/ai/ai-connection-test.test.ts`
- `connection test schema passes compatibility check`
- `request uses purpose connection_test, effort low and the caller's signal`
- `prompt contains the nonce`

`check:architecture` enforces this with 02's `utilities-services` rule (02 §6.9.4): no file under `utilities/**` imports from `services/**`.

## 10. Acceptance criteria

- [ ] `GET /api/settings` after `db:migrate` returns 200 `{ status: 200, data: SettingsView }` with defaults (`anthropic_api`, `claude-opus-5-5`, `high`, `medium`, `hasGithubToken:false`, `hasAnthropicApiKey:false`); after `delete from app_settings` the next GET re-creates row id 1.
- [ ] `PUT /api/settings` honours omitted = keep, `""` = clear, `null` = 400; unknown keys 400 with `error_reason: "validation_failed"` and `error` as a string array.
- [ ] DB inspection after setting a token shows `enc:v1:` ciphertext; a test captures `logTestStream` (04) across PUT, test-github and test-ai and asserts the token and key strings never appear.
- [ ] Changing `PRVISION_SECRET_KEY` and calling `test-ai` returns 400 `ai_not_configured` with the re-enter message.
- [ ] `POST /api/settings/test-github` with a valid token returns `200 { status: 200, data: { login } }` and persists `github_login`; an invalid token returns 400 `github_unauthorized`; a rate-limited response returns 429 `github_rate_limited`.
- [ ] `POST /api/settings/test-ai` with a valid key returns `200 { data: { provider, model, latencyMs } }` within 60 s; an invalid key returns 400 `ai_unauthorized`; a hung provider returns 504 `internal_error` after the test timeout.
- [ ] With provider `claude_code` and a signed-in local Claude Code, `test-ai` returns 200; Claude Code is invoked with only Read/Glob/Grep, without repo setting sources, and with an env that lacks `PRVISION_SECRET_KEY`, `DATABASE_URL` and `REDIS_URL`.
- [ ] `AnthropicApiProvider` request params (captured in tests) contain `model: "claude-opus-5-5"` (from settings), `thinking.type = "adaptive"`, explicit `output_config.effort`, `output_config.format.type = "json_schema"`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, a cached system block, a final `user` message, and no `budget_tokens`/`tool_choice`/`tools`/`output_format`/`temperature`.
- [ ] The call goes through `client.beta.messages.stream(...)` + `finalMessage()` (test seam `streamFn` default asserted by a unit test that spies on the client).
- [ ] Every SDK error class in §5.11.2 maps to the listed reason/retryable (tests, constructed from the SDK's exported classes).
- [ ] `stop_reason` is checked before content is read (tests for `refusal`, `max_tokens`, unknown); every error thrown after a response carries `usage`.
- [ ] No file outside `utilities/services/ai/` imports `@anthropic-ai/sdk` or `@anthropic-ai/claude-agent-sdk`, and no file under `utilities/**` imports `services/**` (`check:architecture`).
- [ ] All schemas used with providers pass `assertStructuredOutputCompatible`.
- [ ] Every `VERIFY` in §5.11–§5.12 is resolved in code comments that cite the SDK version checked.
- [ ] `npm run typecheck`, `lint`, and all tests in §9 pass; no `any`, explicit return types, no floating promises.

## 11. Contract changes requested

Resolved:

1. `AiUsage.cacheReadInputTokens?` — Resolved — 00 §14.4.
2. `AiProviderError.usage?` (4th constructor parameter) — Resolved — 00 §14.4.
3. Test endpoint views — Resolved — 00 §14.4 (`GithubTestResultView { login }`, `AiTestResultView { provider, model, latencyMs }`; the earlier `SettingsTestResultView` is withdrawn).
4. `SettingsStore` as the only non-HTTP settings reader (`readGithubToken()`, `readAiSettings()`) — Resolved — 00 §14.8.
5. `GitHubClient.verifyToken(token, { signal })` — Resolved — 00 §14.8 / implemented in 06 §5.6.3.
6. `ai.config.ts` keys and `GITHUB_TEST_TIMEOUT_MS` — Resolved — 00 §14.8 (sheet 02 holds the consolidated list; it must contain every key in §5.10, including `AI_CLAUDE_CODE_ENV_PREFIXES` and `AI_CLAUDE_CODE_ENV_DENYLIST`).
7. `Validation` returns `validation_failed` — Resolved — 00 §14.2 / 04 §8.7.
8. Secret `PUT` semantics (omitted keep, `""` clear, `null` 400) — Resolved — 00 §14.4.

Also resolved (Revision 2 final review):

9. **Module map (00 §7).** Resolved — 00 §14.12 (each sheet's file inventory is authoritative for its extra files). Add `utilities/services/ai/{claude-code-result.ts, ai-connection-test.ts, index.ts}` and `services/settings/settings-store.ts`; replace `dtos/settings/settings-test-result-view.dto.ts` with `github-test-result-view.dto.ts` and `ai-test-result-view.dto.ts`.
10. **Factory API change (affects 07 only).** Resolved — 07 §3 / item 15 adopt it. `AiProviderFactory` no longer reads settings: `readiness(settings)` and `create(settings)` take a `ResolvedAiSettings` from `SettingsStore.readAiSettings()`; `fromSettings()`/`loadAiSettings()` are removed (layering: utilities must not import services; and one read gives a consistent snapshot). `SecretRead`/`ResolvedAiSettings` move to `utilities/services/ai/ai-provider.ts`. Sheet 07 is updated accordingly.
11. **Logger redaction (04 §9.10).** Resolved — 04 §9.10 now includes them. Add `headers["x-api-key"]` and `*.headers["x-api-key"]` to `REDACT_PATHS`.
