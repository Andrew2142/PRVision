/**
 * ScriptedAiProvider (sheet 14 §5.4.8): implements the sheet 00 AiProvider contract for every consumer (09, 11,
 * settings connection test, orchestrator). Scripts are per `purpose`; an exhausted script throws loudly.
 * Like the real providers it checks every request schema with JsonSchemaValidator.assertStructuredOutputCompatible
 * and validates scripted data against request.jsonSchema (05 §5.1, §5.13).
 */
import { AiProviderError } from "../../../backend/src/types/visualization-pipeline";
import type {
  AiProvider,
  AiStructuredRequest,
  AiStructuredResult,
  AiUsage
} from "../../../backend/src/types/visualization-pipeline";

type Purpose = AiStructuredRequest["purpose"];
type Reason = AiProviderError["reason"];

export type ScriptStep =
  | {
      kind: "data";
      data: unknown;
      usage?: Partial<AiUsage>;
      model?: string;
      delayMs?: number;
      skipSchemaValidation?: boolean;
    }
  | { kind: "error"; reason: Reason; message?: string; retryable?: boolean; usage?: AiUsage } // AiProviderError.usage (00 §14.4)
  | { kind: "refusal"; usage?: AiUsage }
  | { kind: "invalid_output"; raw?: string; usage?: AiUsage }
  | { kind: "hang" } // resolves only via request.signal abort
  | { kind: "fn"; fn: (request: AiStructuredRequest, callIndex: number) => unknown };

export type Script = Partial<Record<Purpose, ScriptStep[]>>;

const DEFAULT_RETRYABLE: Record<Reason, boolean> = {
  auth: false,
  config: false,
  rate_limit: true,
  refusal: false,
  max_tokens: false,
  invalid_output: true,
  network: true,
  aborted: false,
  unknown: false
};

const DEFAULT_USAGE: AiUsage = { inputTokens: 100, outputTokens: 50, calls: 1 };

/**
 * Structural view of sheet 05's JsonSchemaValidator (05 §5.13). The module is created by sheet 05 (wave 3), after
 * this helper (wave 2), so it is loaded on first use instead of statically imported: this file type-checks and
 * imports cleanly before sheet 05 lands, and needs no edit afterwards (14 build notes, deviation 3).
 */
interface JsonSchemaValidatorApi {
  validate(
    schema: Record<string, unknown>,
    data: unknown
  ): { ok: true; value: unknown } | { ok: false; errors: string[]; summary: string };
  assertStructuredOutputCompatible(schema: Record<string, unknown>): void;
}

/** Spec path of sheet 05's validator, relative to this file (00 §7). */
export const JSON_SCHEMA_VALIDATOR_MODULE = "../../../backend/src/utilities/services/ai/json-schema-validator";

let validatorInstance: JsonSchemaValidatorApi | null = null;

function jsonSchemaValidator(): JsonSchemaValidatorApi {
  if (validatorInstance === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- sheet 05's module may not exist yet (wave 3); a lazy require keeps this helper importable until then
    const loaded = require(JSON_SCHEMA_VALIDATOR_MODULE) as { JsonSchemaValidator: JsonSchemaValidatorApi };
    validatorInstance = loaded.JsonSchemaValidator;
  }
  return validatorInstance;
}

/** Scripted AiProvider: returns or throws exactly what the script says, per purpose, in order. */
export class ScriptedAiProvider implements AiProvider {
  readonly requests: AiStructuredRequest[] = [];
  private readonly cursors = new Map<Purpose, number>();

  constructor(
    private readonly script: Script,
    readonly kind: AiProvider["kind"] = "anthropic_api",
    private readonly model = "claude-opus-5-5"
  ) {}

  /** Records the request, checks its schema like the real providers, then plays the next scripted step. */
  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    this.requests.push(request);
    jsonSchemaValidator().assertStructuredOutputCompatible(request.jsonSchema); // same check as the real providers (05)
    if (request.signal?.aborted) {
      throw new AiProviderError("aborted", "aborted", false);
    }

    const index = this.cursors.get(request.purpose) ?? 0;
    this.cursors.set(request.purpose, index + 1);
    const step = this.script[request.purpose]?.[index];
    if (!step) {
      throw new Error(`ScriptedAiProvider: no scripted step for purpose "${request.purpose}" call #${index + 1}`);
    }

    switch (step.kind) {
      case "data": {
        if (step.delayMs) {
          await abortableDelay(step.delayMs, request.signal);
        }
        const usage: AiUsage = { ...DEFAULT_USAGE, ...step.usage };
        const data = step.skipSchemaValidation ? (step.data as T) : (validated(request, step.data, usage) as T);
        return { data, usage, model: step.model ?? this.model };
      }
      case "fn": {
        const usage: AiUsage = { ...DEFAULT_USAGE };
        return { data: validated(request, await step.fn(request, index), usage) as T, usage, model: this.model };
      }
      case "error":
        throw new AiProviderError(
          step.message ?? `scripted ${step.reason}`,
          step.reason,
          step.retryable ?? DEFAULT_RETRYABLE[step.reason],
          step.usage
        );
      case "refusal":
        throw new AiProviderError("The model declined to respond", "refusal", false, step.usage ?? DEFAULT_USAGE);
      case "invalid_output":
        throw new AiProviderError(
          `Model output failed schema validation: ${step.raw ?? "<garbage>"}`,
          "invalid_output",
          true,
          step.usage ?? DEFAULT_USAGE
        );
      case "hang":
        await abortableDelay(Number.POSITIVE_INFINITY, request.signal);
        throw new AiProviderError("aborted", "aborted", false);
    }
  }

  /** Requests made for one purpose, in call order. */
  callsFor(purpose: Purpose): AiStructuredRequest[] {
    return this.requests.filter((request) => request.purpose === purpose);
  }

  /** Fails the test if any scripted step was not consumed. */
  assertExhausted(): void {
    for (const [purpose, steps] of Object.entries(this.script) as Array<[Purpose, ScriptStep[]]>) {
      const used = this.cursors.get(purpose) ?? 0;
      if (used < steps.length) {
        throw new Error(`ScriptedAiProvider: ${steps.length - used} unused step(s) for "${purpose}"`);
      }
    }
  }
}

/** Mirrors the providers: schema mismatch after a "response" is invalid_output with usage attached (05 §5.1). */
function validated(request: AiStructuredRequest, data: unknown, usage: AiUsage): unknown {
  const result = jsonSchemaValidator().validate(request.jsonSchema, data);
  if (result.ok) {
    return result.value;
  }
  throw new AiProviderError(`Model output failed schema validation: ${result.summary}`, "invalid_output", true, usage);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : undefined;
    signal?.addEventListener(
      "abort",
      () => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(new AiProviderError("aborted", "aborted", false));
      },
      { once: true }
    );
  });
}
