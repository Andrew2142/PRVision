/**
 * Scripted AI for sheet 09 tests: sheet 14's ScriptedAiProvider (queue per purpose, records requests, validates
 * request schemas and scripted data like the real providers) plus harness-response builders and a probe that
 * measures how many calls are in flight at once.
 */
import type { HarnessAiResponse } from "../../../../backend/src/services/visualizations/pipeline/harness-prompts";
import { AiProviderError } from "../../../../backend/src/types/visualization-pipeline";
import type { AiStructuredRequest, AiUsage } from "../../../../backend/src/types/visualization-pipeline";
import type { ScriptStep } from "../../helpers/ai-provider-stub";

export { ScriptedAiProvider, type Script, type ScriptStep } from "../../helpers/ai-provider-stub";

/** A valid response shape with overrides. */
export function harnessResponse(overrides: Partial<HarnessAiResponse> = {}): HarnessAiResponse {
  return { status: "ok", harnessSource: "", mockedModules: [], notes: "Shows the default state.", ...overrides };
}

/** A `data` step returning `response` with optional usage. */
export function respond(response: HarnessAiResponse, usage?: Partial<AiUsage>): ScriptStep {
  return { kind: "data", data: response, ...(usage ? { usage } : {}) };
}

/** Tracks concurrent calls: wrap responses with `step()`; each call waits `delayMs` before answering. */
export class ConcurrencyProbe {
  inFlight = 0;
  maxInFlight = 0;
  readonly inFlightAtStart: number[] = [];

  step(response: HarnessAiResponse | ((request: AiStructuredRequest) => HarnessAiResponse), delayMs = 20): ScriptStep {
    return {
      kind: "fn",
      fn: async (request: AiStructuredRequest) => {
        this.inFlight += 1;
        this.inFlightAtStart.push(this.inFlight);
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return typeof response === "function" ? response(request) : response;
        } finally {
          this.inFlight -= 1;
        }
      }
    };
  }
}

/** Component name of a request (from the `component:` line of the <target> block). */
export function componentOf(request: AiStructuredRequest): string {
  return /^component: (.+)$/m.exec(request.prompt)?.[1] ?? "";
}

/**
 * One step answering by the component named in the prompt, so parallel calls get the right response whatever
 * order they arrive in. An AiProviderError value is thrown (with its usage) instead of returned.
 */
export function byComponent(responses: Record<string, HarnessAiResponse | AiProviderError>): ScriptStep {
  return {
    kind: "fn",
    fn: (request: AiStructuredRequest) => {
      const name = componentOf(request);
      const response = responses[name];
      if (response instanceof AiProviderError) {
        throw response;
      }
      if (response === undefined) {
        throw new Error(`byComponent: no response for ${name}`);
      }
      return response;
    }
  };
}
