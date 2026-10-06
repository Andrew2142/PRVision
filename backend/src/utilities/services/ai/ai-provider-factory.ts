// Imports only ./ai-provider, the two providers and the logger. Never imports services/** (layering rule, 05 §1):
// callers read settings with SettingsStore.readAiSettings() and pass the result in.
import { createLogger } from "../../loggers/logger";
import { AiProviderError, type AiProvider, type AiProviderKindValue, type ResolvedAiSettings } from "./ai-provider";
import { AnthropicApiProvider } from "./anthropic-api-provider";
import { ClaudeCodeProvider, SDK_UNAVAILABLE_MESSAGE } from "./claude-code-provider";

/** Outcome of AiProviderFactory.readiness. */
export type AiReadiness =
  | { ready: true; provider: AiProviderKindValue; model: string }
  | { ready: false; reason: "ai_not_configured"; message: string };

export const AI_MESSAGE_NO_MODEL = "No AI model is configured. Set a model in Settings.";
export const AI_MESSAGE_KEY_ABSENT = "Add an Anthropic API key, or switch the provider to Claude Code.";
export const AI_MESSAGE_KEY_UNREADABLE =
  "The stored Anthropic API key can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the key again.";

const log = createLogger("ai.provider_factory");

/** Builds the configured AiProvider from already-resolved settings. Pure: never reads the database. */
export class AiProviderFactory {
  /**
   * Cheap check used by 07 at POST /api/visualizations (no network, no model call): create(settings) in
   * try/catch, plus ClaudeCodeProvider.isSdkAvailable() for claude_code. Non-AiProviderError exceptions propagate.
   */
  static async readiness(settings: ResolvedAiSettings): Promise<AiReadiness> {
    try {
      AiProviderFactory.create(settings);
    } catch (error: unknown) {
      if (error instanceof AiProviderError && error.reason === "config") {
        return { ready: false, reason: "ai_not_configured", message: error.message };
      }
      throw error;
    }
    if (settings.provider === "claude_code" && !(await ClaudeCodeProvider.isSdkAvailable())) {
      return { ready: false, reason: "ai_not_configured", message: SDK_UNAVAILABLE_MESSAGE };
    }
    return { ready: true, provider: settings.provider, model: settings.model };
  }

  /**
   * Pure construction from resolved settings.
   *
   * @throws AiProviderError(reason "config") when the model is empty or the API key is absent/unreadable.
   */
  static create(settings: ResolvedAiSettings): AiProvider {
    const model = settings.model.trim();
    if (model === "") {
      throw new AiProviderError(AI_MESSAGE_NO_MODEL, "config", false);
    }
    let provider: AiProvider;
    switch (settings.provider) {
      case "anthropic_api": {
        const key = settings.anthropicApiKey;
        if (key.state === "absent") {
          throw new AiProviderError(AI_MESSAGE_KEY_ABSENT, "config", false);
        }
        if (key.state === "unreadable") {
          throw new AiProviderError(AI_MESSAGE_KEY_UNREADABLE, "config", false);
        }
        provider = new AnthropicApiProvider({ apiKey: key.value, model });
        break;
      }
      case "claude_code":
        // SDK availability is checked lazily on first call (dynamic import); readiness() checks it up front.
        provider = new ClaudeCodeProvider({ model });
        break;
      default:
        // Impossible by the CHECK constraint; kept for rows edited by hand.
        throw new AiProviderError("Unknown AI provider", "config", false);
    }
    log.info({ event: "ai.provider.created", provider: settings.provider, model }, "AI provider created");
    return provider;
  }
}
