/**
 * AiProvider backed by the Anthropic Messages API (`@anthropic-ai/sdk`). Verified against @anthropic-ai/sdk 0.131.0:
 *  - `client.beta.messages.stream(params, { signal })` + `finalMessage()`; its param type (BetaMessageStreamParams)
 *    is not re-exported through `Anthropic.Beta.Messages`, so it is taken from the method signature.
 *  - BetaMessageStreamParams includes `betas`, `fallbacks?: BetaFallbackParam[] | "default"`, `output_config`
 *    (`effort`, `format: { type: "json_schema", schema }`) and `thinking: { type: "adaptive" }` natively; no casts.
 *  - BetaMessage: `stop_details: BetaRefusalStopDetails | null` (category), `content` may contain
 *    `{ type: "fallback" }` blocks, `usage.iterations` entries of type "message" / "fallback_message".
 *  - Error classes: APIUserAbortError, APIConnectionError, APIConnectionTimeoutError (extends APIConnectionError),
 *    AuthenticationError, PermissionDeniedError, NotFoundError, BadRequestError, UnprocessableEntityError,
 *    RateLimitError, InternalServerError (status >= 500), all extending APIError.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_CALL_DEADLINE_MS,
  AI_MAX_IMAGE_BASE64_CHARS,
  AI_MAX_TOKENS_BY_PURPOSE,
  AI_REQUEST_TIMEOUT_MS,
  AI_SDK_MAX_RETRIES,
  AI_SERVER_SIDE_FALLBACK_BETA,
  AI_SERVER_SIDE_FALLBACK_ENABLED
} from "../../../config-consts";
import { createLogger, redactSecrets } from "../../loggers/logger";
import {
  AiProviderError,
  type AiProvider,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage
} from "./ai-provider";
import { JsonSchemaValidator } from "./json-schema-validator";

/** The SDK's BetaMessageStreamParams (see file header). */
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type FinalMessage = Anthropic.Beta.Messages.BetaMessage;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;

const SDK_MESSAGE_MAX_CHARS = 300;

/**
 * AiProviderError raised from an Anthropic HTTP status, carrying that status so callers can tell e.g. a rejected
 * key (401) from a model permission problem (403) without reading the message.
 */
export class AnthropicStatusError extends AiProviderError {
  constructor(
    message: string,
    reason: AiProviderError["reason"],
    retryable: boolean,
    readonly status: number
  ) {
    super(message, reason, retryable);
  }
}

/** Seam for tests: returns something with finalMessage(). */
export type AnthropicStreamFn = (
  params: StreamParams,
  options: { signal: AbortSignal }
) => { finalMessage(): Promise<FinalMessage> };

export interface AnthropicApiProviderOptions {
  apiKey: string;
  model: string;
  /** Default AI_SERVER_SIDE_FALLBACK_ENABLED. */
  serverSideFallback?: boolean;
  /** Tests inject a fake. */
  streamFn?: AnthropicStreamFn;
  /** Whole-call deadline incl. SDK retries; default AI_CALL_DEADLINE_MS (test seam). */
  callDeadlineMs?: number;
}

/**
 * Structured-output calls through the Anthropic API: always streamed, adaptive thinking, explicit effort,
 * `output_config.format` json_schema, cached system block, server-side refusal fallback (05 §5.11).
 */
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
      // The key is passed explicitly: the client never falls back to ambient credentials.
      const client = new Anthropic({
        apiKey: options.apiKey,
        maxRetries: AI_SDK_MAX_RETRIES,
        timeout: AI_REQUEST_TIMEOUT_MS
      });
      this.streamFn = (params, streamOptions) => client.beta.messages.stream(params, streamOptions);
    }
  }

  /**
   * One structured call. Throws AiProviderError; every error raised after the API returned a message carries
   * `usage` (00 §14.4).
   */
  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    JsonSchemaValidator.assertStructuredOutputCompatible(request.jsonSchema); // cached per schema
    this.assertImages(request);
    if (request.signal?.aborted) {
      throw new AiProviderError("AI request cancelled", "aborted", false);
    }

    const deadline = AbortSignal.timeout(this.options.callDeadlineMs ?? AI_CALL_DEADLINE_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const startedAt = Date.now();

    let message: FinalMessage;
    try {
      message = await this.streamFn(this.buildParams(request), { signal }).finalMessage();
    } catch (error: unknown) {
      const mapped = this.mapError(error, request.signal, deadline);
      this.log.warn(
        {
          event: "ai.call.failed",
          purpose: request.purpose,
          reason: mapped.reason,
          retryable: mapped.retryable,
          ...(error instanceof Anthropic.APIError && error.status !== undefined ? { status: error.status } : {}),
          durationMs: Date.now() - startedAt
        },
        "AI call failed"
      );
      throw mapped;
    }

    const usage = this.mapUsage(message);
    this.log.info(
      {
        event: "ai.call.completed",
        purpose: request.purpose,
        model: message.model,
        stopReason: message.stop_reason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        fallbackUsed: this.fallbackRan(message),
        durationMs: Date.now() - startedAt
      },
      "AI call completed"
    );

    this.assertStopReason(message, usage);
    const text = this.extractText(message);
    const parsed = this.parseJson(text, usage);
    const validation = JsonSchemaValidator.validate<T>(request.jsonSchema, parsed);
    if (!validation.ok) {
      throw new AiProviderError(
        `AI output did not match the expected schema: ${validation.summary}`,
        "invalid_output",
        true,
        usage
      );
    }
    return { data: validation.value, usage, model: message.model };
  }

  private buildParams(request: AiStructuredRequest): StreamParams {
    const images = request.images ?? [];
    const content: ContentParam[] = images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 }
    }));
    const legend = images.map((image, index) => `Image ${index + 1}: ${image.label}`).join("\n");
    content.push({ type: "text", text: legend ? `${legend}\n\n${request.prompt}` : request.prompt });

    const base: StreamParams = {
      model: this.options.model,
      max_tokens: AI_MAX_TOKENS_BY_PURPOSE[request.purpose],
      thinking: { type: "adaptive" }, // cannot be disabled on claude-opus-5-5; budget_tokens is a 400
      output_config: {
        effort: request.effort, // always explicit (the model default is medium)
        format: { type: "json_schema", schema: request.jsonSchema }
      },
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }]
    };
    return this.fallbackEnabled ? { ...base, betas: [AI_SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" } : base;
  }

  private assertStopReason(message: FinalMessage, usage: AiUsage): void {
    switch (message.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return;
      case "max_tokens":
        throw new AiProviderError("The AI response was cut off at the output token limit.", "max_tokens", false, usage);
      case "refusal": {
        // stop_details is populated only for refusals. A refusal here means the whole server-side fallback chain
        // declined (the fallback model can refuse too).
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
      if (block.type === "fallback") {
        start = index + 1;
      }
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

  /**
   * Total input processed (uncached + cache read + cache write) and output. With server-side fallback the
   * top-level `usage` covers only the attempt that produced the returned message; `usage.iterations` is the
   * per-attempt record (declined hop "message" + serving "fallback_message"). So when iterations are present the
   * message/fallback_message entries are summed; otherwise the top-level fields are used. Compaction entries are
   * not model attempts and are not counted (no compaction is requested).
   */
  private mapUsage(message: FinalMessage): AiUsage {
    const top = message.usage;
    const attempts = (top.iterations ?? []).filter(
      (entry) => entry.type === "message" || entry.type === "fallback_message"
    );
    const parts =
      attempts.length > 0
        ? attempts.map((entry) => ({
            input: entry.input_tokens,
            output: entry.output_tokens,
            cacheRead: entry.cache_read_input_tokens,
            cacheWrite: entry.cache_creation_input_tokens
          }))
        : [
            {
              input: top.input_tokens,
              output: top.output_tokens,
              cacheRead: top.cache_read_input_tokens ?? 0,
              cacheWrite: top.cache_creation_input_tokens ?? 0
            }
          ];
    const sum = (pick: (part: (typeof parts)[number]) => number): number =>
      parts.reduce((total, part) => total + pick(part), 0);
    const cacheRead = sum((part) => part.cacheRead);
    return {
      inputTokens: sum((part) => part.input) + cacheRead + sum((part) => part.cacheWrite),
      outputTokens: sum((part) => part.output),
      calls: 1,
      cacheReadInputTokens: cacheRead
    };
  }

  private assertImages(request: AiStructuredRequest): void {
    for (const image of request.images ?? []) {
      if (image.base64.length > AI_MAX_IMAGE_BASE64_CHARS) {
        // Caller bug (11 must downscale); "unknown" + not retryable so 09 does not treat it as a config error.
        throw new AiProviderError(
          `Image "${image.label}" is larger than the 5 MB API limit; downscale before sending.`,
          "unknown",
          false
        );
      }
    }
  }

  /**
   * Served-by signal for server-side fallback: a "fallback_message" entry in usage.iterations (covers sticky turns
   * that carry no fallback content block), or a fallback block in content.
   */
  private fallbackRan(message: FinalMessage): boolean {
    return (
      (message.usage.iterations ?? []).some((entry) => entry.type === "fallback_message") ||
      message.content.some((block) => block.type === "fallback")
    );
  }

  /** 05 §5.11.2, most specific first; never string-matches. */
  private mapError(error: unknown, callerSignal: AbortSignal | undefined, deadline: AbortSignal): AiProviderError {
    const model = this.options.model;
    if (error instanceof AiProviderError) {
      return error;
    }
    if (callerSignal?.aborted) {
      return new AiProviderError("AI request cancelled", "aborted", false);
    }
    if (deadline.aborted) {
      const seconds = Math.round((this.options.callDeadlineMs ?? AI_CALL_DEADLINE_MS) / 1000);
      return new AiProviderError(`AI request timed out after ${seconds} s`, "network", true);
    }
    if (error instanceof Anthropic.APIUserAbortError) {
      return new AiProviderError("AI request aborted", "aborted", false);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return new AnthropicStatusError("Anthropic rejected the API key (401).", "auth", false, 401);
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return new AnthropicStatusError(`The API key is not allowed to use model "${model}" (403).`, "auth", false, 403);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new AnthropicStatusError("Anthropic rate limit reached (429).", "rate_limit", true, 429);
    }
    if (error instanceof Anthropic.NotFoundError) {
      return new AnthropicStatusError(`Model "${model}" was not found (404).`, "config", false, 404);
    }
    if (error instanceof Anthropic.BadRequestError) {
      return new AnthropicStatusError(`Request rejected (400): ${sdkMessage(error)}`, "config", false, 400);
    }
    if (error instanceof Anthropic.UnprocessableEntityError) {
      return new AnthropicStatusError(`Request rejected (422): ${sdkMessage(error)}`, "config", false, 422);
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new AiProviderError("Connection to Anthropic timed out.", "network", true);
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new AiProviderError("Could not connect to Anthropic.", "network", true);
    }
    if (error instanceof Anthropic.InternalServerError) {
      return error.status === 529
        ? new AnthropicStatusError("Anthropic is overloaded (529).", "rate_limit", true, 529)
        : new AnthropicStatusError(`Anthropic server error (${error.status}).`, "unknown", true, error.status);
    }
    if (error instanceof Anthropic.APIError) {
      const status: unknown = error.status;
      return new AiProviderError(
        `Anthropic API error (${String(status)}).`,
        "unknown",
        typeof status === "number" && status >= 500
      );
    }
    return new AiProviderError("Unexpected AI client error.", "unknown", false);
  }
}

/** The API's validation text (never contains the key), scrubbed and capped. */
function sdkMessage(error: Error): string {
  return redactSecrets(error.message).slice(0, SDK_MESSAGE_MAX_CHARS);
}
