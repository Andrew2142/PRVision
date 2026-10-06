import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AI_CONNECTION_TEST_TIMEOUT_MS, GITHUB_TEST_TIMEOUT_MS } from "../../config-consts";
import type { AiTestResultView, GithubTestResultView, SettingsUpdateDTO, SettingsView } from "../../dtos";
import { ErrorReason } from "../../enums";
import type { AppSettingModel } from "../../models";
import {
  AiProviderError,
  AiProviderFactory,
  AnthropicStatusError,
  GitHubClient,
  buildConnectionTestRequest,
  createLogger,
  redactSecrets,
  type AiProvider,
  type ApiResponse,
  type ConnectionTestResponse,
  type GitHubTokenVerification
} from "../../utilities";
import { SettingsStore, type AppSettingsPatch, type ResolvedAiSettings } from "./settings-store";

/** User-facing messages of the settings endpoints (05 §5.8; sheet 13 shows them verbatim). */
export const SETTINGS_MESSAGES = {
  githubTokenMissing: "Add a GitHub token first.",
  githubTokenUnreadable:
    "The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again.",
  githubUnauthorized:
    "GitHub rejected the token. Create a new fine-grained token with read access to Contents, Pull requests and Metadata.",
  githubForbidden: "GitHub accepted the token but denied access. Check the token's repository access and permissions.",
  githubRateLimited: "GitHub rate limit reached. Try again in a few minutes.",
  githubNetwork: "Could not reach GitHub. Check your network connection.",
  githubTimeout: (seconds: number): string => `GitHub did not answer within ${seconds} s.`,
  githubUnknown: (status: number | null): string =>
    `GitHub returned an unexpected error (HTTP ${status === null ? "unknown" : status}).`,
  aiConfigRejected: (model: string, sdkMessage: string): string =>
    `The AI provider rejected the request for model "${model}": ${sdkMessage}`,
  aiKeyRejected: "Anthropic rejected the API key. Check that it is active and copied correctly.",
  aiModelForbidden: (model: string): string => `The API key is not allowed to use model "${model}".`,
  aiRateLimited: "The AI provider is rate limited or overloaded. Try again shortly.",
  aiTimeout: (seconds: number): string => `The AI provider did not answer within ${seconds} s.`,
  aiNetwork: "Could not reach the AI provider. Check your network connection.",
  aiCancelled: "The AI request was cancelled. Try again.",
  aiBadFormat: "The AI answered but not in the expected format. Try again.",
  aiUnknown: (detail: string): string => `The AI provider failed: ${detail}`,
  aiMismatch: "The AI answered but not with the expected check value. Try again."
} as const;

/** Provider messages returned to the client are scrubbed and capped (05 §5.8). */
const RETURNED_MESSAGE_MAX_CHARS = 300;

/** Injection points (tests replace them; production uses the defaults). */
export interface SettingsServiceDependencies {
  verifyGithubToken: typeof GitHubClient.verifyToken;
  createProvider: (settings: ResolvedAiSettings) => AiProvider;
  /** Monotonic clock for latency. */
  now: () => number;
  nonce: () => string;
  /** Timeout signal of a connection test (test seam; default AbortSignal.timeout). */
  timeoutSignal: (ms: number) => AbortSignal;
}

/** Production dependencies. */
export function defaultSettingsServiceDependencies(): SettingsServiceDependencies {
  return {
    verifyGithubToken: (token, options) => GitHubClient.verifyToken(token, options),
    createProvider: (settings) => AiProviderFactory.create(settings),
    now: () => performance.now(),
    nonce: () => `prv-${randomBytes(3).toString("hex")}`,
    timeoutSignal: (ms) => AbortSignal.timeout(ms)
  };
}

function safeMessage(message: string): string {
  return redactSecrets(message).slice(0, RETURNED_MESSAGE_MAX_CHARS);
}

/**
 * HTTP-facing settings logic: GET/PUT /api/settings and the two connection tests. Every public method returns
 * ApiResponse; expected failures return early, unexpected exceptions propagate to the controller's 500 path.
 */
export class SettingsService {
  private readonly log = createLogger("settings-service");
  private readonly deps: SettingsServiceDependencies;

  constructor(
    private readonly store: SettingsStore = new SettingsStore(),
    deps: Partial<SettingsServiceDependencies> = {}
  ) {
    this.deps = { ...defaultSettingsServiceDependencies(), ...deps };
  }

  /** Current settings view (the row is re-created with defaults if it was deleted). */
  async get(): Promise<ApiResponse<SettingsView>> {
    const row = await this.store.getOrCreate();
    return { status: 200, data: this.toView(row) };
  }

  /**
   * Partial update: omitted keeps, "" clears (a cleared token also clears github_login), a new token resets
   * github_login. An empty DTO writes nothing. Logs field names only.
   */
  async update(dto: SettingsUpdateDTO): Promise<ApiResponse<SettingsView>> {
    const { patch, changed } = this.buildPatch(dto);
    if (changed.length === 0) {
      return this.get();
    }
    const row = await this.store.patch(patch);
    this.log.info({ event: "settings.updated", fields: changed }, "Settings updated");
    return { status: 200, data: this.toView(row) };
  }

  /** Verifies the stored GitHub token with GET /user and persists the login when the token is unchanged. */
  async testGithub(): Promise<ApiResponse<GithubTestResultView>> {
    const { secret, storedCiphertext } = await this.store.readGithubTokenSnapshot();
    if (secret.state === "absent") {
      return this.githubResult(400, SETTINGS_MESSAGES.githubTokenMissing, ErrorReason.GITHUB_TOKEN_MISSING, {
        ok: false,
        reason: "absent"
      });
    }
    if (secret.state === "unreadable" || storedCiphertext === null) {
      return this.githubResult(400, SETTINGS_MESSAGES.githubTokenUnreadable, ErrorReason.GITHUB_TOKEN_MISSING, {
        ok: false,
        reason: "unreadable"
      });
    }

    const timeout = this.deps.timeoutSignal(GITHUB_TEST_TIMEOUT_MS);
    const result = await this.deps.verifyGithubToken(secret.value, { signal: timeout });
    if (result.ok) {
      const persisted = await this.store.setGithubLoginIfTokenUnchanged(storedCiphertext, result.login);
      if (!persisted) {
        this.log.info({ event: "settings.test_github.token_changed" }, "GitHub token changed during the test");
      }
      this.log.info(
        { event: "settings.test_github.result", ok: true, login: result.login },
        "GitHub token test finished"
      );
      return { status: 200, data: { login: result.login } satisfies GithubTestResultView };
    }

    this.log.info(
      { event: "settings.test_github.result", ok: false, reason: result.reason, status: result.status },
      "GitHub token test finished"
    );
    if (timeout.aborted) {
      return {
        status: 504,
        error: SETTINGS_MESSAGES.githubTimeout(GITHUB_TEST_TIMEOUT_MS / 1000),
        error_reason: ErrorReason.INTERNAL_ERROR
      };
    }
    return this.mapGithubFailure(result);
  }

  /** Sends a tiny connection_test request through the configured provider and checks the echoed nonce. */
  async testAi(): Promise<ApiResponse<AiTestResultView>> {
    const settings = await this.store.readAiSettings();

    let provider: AiProvider;
    try {
      provider = this.deps.createProvider(settings);
    } catch (error: unknown) {
      if (error instanceof AiProviderError && error.reason === "config") {
        return this.aiFailure(settings, 400, error.message, ErrorReason.AI_NOT_CONFIGURED, "config", 0);
      }
      throw error;
    }

    const timeoutMs = AI_CONNECTION_TEST_TIMEOUT_MS;
    const timeout = this.deps.timeoutSignal(timeoutMs);
    const nonce = this.deps.nonce();
    const request = buildConnectionTestRequest({ nonce, signal: timeout });

    const started = this.deps.now();
    try {
      const result = await provider.generateStructured<ConnectionTestResponse>(request);
      const latencyMs = Math.round(this.deps.now() - started);
      if (!result.data.ok || result.data.echo !== nonce) {
        this.log.warn({ event: "ai.connection_test.mismatch", provider: settings.provider }, "AI check value mismatch");
        return this.aiFailure(
          settings,
          502,
          SETTINGS_MESSAGES.aiMismatch,
          ErrorReason.INTERNAL_ERROR,
          "mismatch",
          latencyMs
        );
      }
      this.log.info(
        {
          event: "settings.test_ai.result",
          ok: true,
          provider: settings.provider,
          model: result.model,
          latencyMs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens
        },
        "AI connection test finished"
      );
      return {
        status: 200,
        data: { provider: settings.provider, model: result.model, latencyMs } satisfies AiTestResultView
      };
    } catch (error: unknown) {
      if (!(error instanceof AiProviderError)) {
        throw error;
      }
      const latencyMs = Math.round(this.deps.now() - started);
      if (error.reason === "aborted" && timeout.aborted) {
        return this.aiFailure(
          settings,
          504,
          SETTINGS_MESSAGES.aiTimeout(timeoutMs / 1000),
          ErrorReason.INTERNAL_ERROR,
          "timeout",
          latencyMs
        );
      }
      const [status, message, reason] = this.mapAiFailure(settings, error);
      return this.aiFailure(settings, status, message, reason, error.reason, latencyMs);
    }
  }

  private toView(row: AppSettingModel): SettingsView {
    return {
      // The generated model leaves null columns undefined at run time, hence `?? null`.
      hasGithubToken: (row.githubTokenEncrypted ?? null) !== null,
      githubLogin: row.githubLogin ?? null,
      aiProvider: row.aiProvider,
      hasAnthropicApiKey: (row.anthropicApiKeyEncrypted ?? null) !== null,
      aiModel: row.aiModel,
      aiHarnessEffort: row.aiHarnessEffort,
      aiSummaryEffort: row.aiSummaryEffort
    };
  }

  /** DTO → patch with explicit secret semantics (DTOMapper would drop plaintext secrets, 05 §5.4). */
  private buildPatch(dto: SettingsUpdateDTO): { patch: AppSettingsPatch; changed: string[] } {
    const patch: AppSettingsPatch = {};
    const changed: string[] = [];
    if (dto.githubToken === "") {
      patch.githubTokenEncrypted = null;
      patch.githubLogin = null;
      changed.push("githubToken(cleared)");
    } else if (dto.githubToken !== undefined) {
      patch.githubTokenEncrypted = SettingsStore.encryptSecret(dto.githubToken);
      patch.githubLogin = null;
      changed.push("githubToken(set)");
    }
    if (dto.anthropicApiKey === "") {
      patch.anthropicApiKeyEncrypted = null;
      changed.push("anthropicApiKey(cleared)");
    } else if (dto.anthropicApiKey !== undefined) {
      patch.anthropicApiKeyEncrypted = SettingsStore.encryptSecret(dto.anthropicApiKey);
      changed.push("anthropicApiKey(set)");
    }
    if (dto.aiProvider !== undefined) {
      patch.aiProvider = dto.aiProvider;
      changed.push("aiProvider");
    }
    if (dto.aiModel !== undefined) {
      patch.aiModel = dto.aiModel;
      changed.push("aiModel");
    }
    if (dto.aiHarnessEffort !== undefined) {
      patch.aiHarnessEffort = dto.aiHarnessEffort;
      changed.push("aiHarnessEffort");
    }
    if (dto.aiSummaryEffort !== undefined) {
      patch.aiSummaryEffort = dto.aiSummaryEffort;
      changed.push("aiSummaryEffort");
    }
    return { patch, changed };
  }

  private githubResult(
    status: number,
    error: string,
    errorReason: ErrorReason,
    logFields: { ok: false; reason: string }
  ): ApiResponse<never> {
    this.log.info({ event: "settings.test_github.result", ...logFields }, "GitHub token test finished");
    return { status, error, error_reason: errorReason };
  }

  /** 05 §5.8 rows for verifyToken failures (result.message is never returned for 401/403). */
  private mapGithubFailure(result: Extract<GitHubTokenVerification, { ok: false }>): ApiResponse<never> {
    switch (result.reason) {
      case "unauthorized":
        return {
          status: 400,
          error: SETTINGS_MESSAGES.githubUnauthorized,
          error_reason: ErrorReason.GITHUB_UNAUTHORIZED
        };
      case "forbidden":
        return { status: 400, error: SETTINGS_MESSAGES.githubForbidden, error_reason: ErrorReason.GITHUB_UNAUTHORIZED };
      case "rate_limited":
        return {
          status: 429,
          error: SETTINGS_MESSAGES.githubRateLimited,
          error_reason: ErrorReason.GITHUB_RATE_LIMITED
        };
      case "network":
        return { status: 502, error: SETTINGS_MESSAGES.githubNetwork, error_reason: ErrorReason.GITHUB_UNAVAILABLE };
      case "unknown":
        return {
          status: 502,
          error: SETTINGS_MESSAGES.githubUnknown(result.status),
          error_reason: ErrorReason.GITHUB_UNAVAILABLE
        };
    }
  }

  /** 05 §5.8 rows for AiProviderError raised by generateStructured. */
  private mapAiFailure(settings: ResolvedAiSettings, error: AiProviderError): [number, string, ErrorReason] {
    switch (error.reason) {
      case "config":
        return [
          400,
          SETTINGS_MESSAGES.aiConfigRejected(settings.model, safeMessage(error.message)),
          ErrorReason.AI_NOT_CONFIGURED
        ];
      case "auth":
        return error instanceof AnthropicStatusError && error.status === 403
          ? [400, SETTINGS_MESSAGES.aiModelForbidden(settings.model), ErrorReason.AI_UNAUTHORIZED]
          : [400, SETTINGS_MESSAGES.aiKeyRejected, ErrorReason.AI_UNAUTHORIZED];
      case "rate_limit":
        return [502, SETTINGS_MESSAGES.aiRateLimited, ErrorReason.INTERNAL_ERROR];
      case "network":
        return [502, SETTINGS_MESSAGES.aiNetwork, ErrorReason.INTERNAL_ERROR];
      case "aborted":
        return [502, SETTINGS_MESSAGES.aiCancelled, ErrorReason.INTERNAL_ERROR];
      case "refusal":
        return [502, `${error.message} Try again.`, ErrorReason.INTERNAL_ERROR];
      case "max_tokens":
      case "invalid_output":
        return [502, SETTINGS_MESSAGES.aiBadFormat, ErrorReason.INTERNAL_ERROR];
      case "unknown":
        return [502, SETTINGS_MESSAGES.aiUnknown(safeMessage(error.message)), ErrorReason.INTERNAL_ERROR];
    }
  }

  private aiFailure(
    settings: ResolvedAiSettings,
    status: number,
    message: string,
    errorReason: ErrorReason,
    logReason: string,
    latencyMs: number
  ): ApiResponse<never> {
    this.log.info(
      {
        event: "settings.test_ai.result",
        ok: false,
        provider: settings.provider,
        model: settings.model,
        reason: logReason,
        latencyMs
      },
      "AI connection test finished"
    );
    return { status, error: safeMessage(message), error_reason: errorReason };
  }
}
