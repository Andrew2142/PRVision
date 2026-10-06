/**
 * Fakes for sheet 05's SDK injection point (sheet 14 §5.4.9): AnthropicApiProviderOptions.streamFn
 * (AnthropicStreamFn).
 */
import Anthropic from "@anthropic-ai/sdk";

/*
 * Structural copy of sheet 05's seam type (05 §5.11.1). TypeScript is structural: passing these fakes to the real
 * provider type-checks them against the real declarations at the call site.
 */
/** The SDK's BetaMessageStreamParams (not re-exported through the Anthropic.Beta.Messages namespace). */
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type FinalMessage = Anthropic.Beta.Messages.BetaMessage;

/** = AnthropicStreamFn (05 §5.11.1). */
export type AnthropicStreamFn = (
  params: StreamParams,
  options: { signal: AbortSignal }
) => { finalMessage(): Promise<FinalMessage> };

export type FakeStreamResponse =
  Record<string, unknown> | Error | ((signal: AbortSignal) => Promise<Record<string, unknown>>);

/** Fake streamFn: each entry is a final message object or an Error thrown from finalMessage(). Records params and signal. */
export function fakeAnthropicStream(responses: FakeStreamResponse[]): {
  streamFn: AnthropicStreamFn;
  calls: Array<{ params: StreamParams; signal: AbortSignal }>;
} {
  const calls: Array<{ params: StreamParams; signal: AbortSignal }> = [];
  const streamFn: AnthropicStreamFn = (params, { signal }) => {
    calls.push({ params, signal });
    const next = responses.shift();
    return {
      finalMessage: async () => {
        if (!next) {
          throw new Error("fakeAnthropicStream: no scripted response");
        }
        if (next instanceof Error) {
          throw next;
        }
        if (typeof next === "function") {
          return (await next(signal)) as unknown as FinalMessage;
        }
        return next as unknown as FinalMessage;
      }
    };
  };
  return { streamFn, calls };
}

/** A final message whose last text block is the JSON (05 ignores text before the last fallback block). */
export function anthropicFinalMessage(json: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
    ...overrides
  };
}

/** Message that never resolves until the signal aborts (deadline / caller-abort tests). */
export const hangingMessage = (signal: AbortSignal): Promise<Record<string, unknown>> =>
  new Promise<Record<string, unknown>>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new Anthropic.APIUserAbortError());
      },
      { once: true }
    );
  });

const errorBody = (type: string, message: string): Record<string, unknown> => ({
  type: "error",
  error: { type, message }
});

/**
 * Real SDK error classes so instanceof mapping is exercised. Built with Anthropic.APIError.generate(status, body,
 * message, headers), which returns the status-specific subclass (AuthenticationError, RateLimitError, ...).
 */
export const anthropicErrors = {
  auth: (): Error =>
    Anthropic.APIError.generate(
      401,
      errorBody("authentication_error", "invalid x-api-key"),
      "invalid x-api-key",
      new Headers()
    ),
  permission: (): Error =>
    Anthropic.APIError.generate(403, errorBody("permission_error", "no access"), "no access", new Headers()),
  notFound: (): Error =>
    Anthropic.APIError.generate(
      404,
      errorBody("not_found_error", "model: claude-nope"),
      "model: claude-nope",
      new Headers()
    ),
  badRequest: (): Error =>
    Anthropic.APIError.generate(400, errorBody("invalid_request_error", "bad"), "bad", new Headers()),
  rateLimit: (): Error =>
    Anthropic.APIError.generate(
      429,
      errorBody("rate_limit_error", "slow down"),
      "slow down",
      new Headers({ "retry-after": "3" })
    ),
  overloaded: (): Error =>
    Anthropic.APIError.generate(529, errorBody("overloaded_error", "overloaded"), "overloaded", new Headers()),
  server: (): Error => Anthropic.APIError.generate(500, errorBody("api_error", "boom"), "boom", new Headers()),
  connection: (): Error => new Anthropic.APIConnectionError({ message: "fetch failed" }),
  timeout: (): Error => new Anthropic.APIConnectionTimeoutError({ message: "timed out" }),
  abort: (): Error => new Anthropic.APIUserAbortError()
};
