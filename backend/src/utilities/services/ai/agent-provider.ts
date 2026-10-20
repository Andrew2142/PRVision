/**
 * Agent provider (17 §7.2). Makes no model call: every generateStructured call becomes an agent_ai_requests row
 * that the Claude Code session driving the run claims and answers through the API (the prvision skill). The
 * provider polls the row until it is answered, failed, cancelled or timed out. Prompts and responses are never
 * logged (01 §5.8).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENT_REQUEST_ANSWER_TIMEOUT_MS,
  AGENT_REQUEST_CLAIM_TIMEOUT_MS,
  AGENT_REQUEST_POLL_MS,
  AGENT_REQUESTS_DIR_NAME,
  AI_AGENT_MODEL_LABEL,
  DATA_DIR
} from "../../../config-consts";
import { AgentRequestStatus } from "../../../enums";
import type { AgentRequestImage } from "../../../types/agent-request";
import { createLogger } from "../../loggers/logger";
import {
  AiProviderError,
  type AiProvider,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage
} from "./ai-provider";
import { AgentRequestStore } from "./agent-request-store";
import { JsonSchemaValidator } from "./json-schema-validator";

/** Usage of one answered agent call: the session's tokens are not visible to PRVision (17 §7.3). */
export const AGENT_CALL_USAGE: AiUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, calls: 1 });

/** The persistence the provider needs (AgentRequestStore implements it; tests pass fakes). */
export type AgentProviderStore = Pick<AgentRequestStore, "create" | "setImages" | "readState" | "cancel">;

export interface AgentAiProviderOptions {
  visualizationId: number;
  store?: AgentProviderStore;
  /** Default `<dataDir>/agent-requests/<visualizationId>`. */
  imageDir?: string;
  now?: () => number;
  /** Waits `ms`; rejects (or resolves early) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
  claimTimeoutMs?: number;
  answerTimeoutMs?: number;
}

/** `<dataDir>/agent-requests/<visualizationId>` (17 E5); also used by VisualizationsService.remove. */
export function agentRequestImageDir(visualizationId: number): string {
  return path.join(DATA_DIR, AGENT_REQUESTS_DIR_NAME, String(visualizationId));
}

const log = createLogger("ai.agent_provider");

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch {
    // Aborted: the poll loop checks the signal next.
  }
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return `${value} minute${value === 1 ? "" : "s"}`;
}

export class AgentAiProvider implements AiProvider {
  readonly kind = "agent" as const;
  private readonly store: AgentProviderStore;
  private readonly imageDir: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly pollMs: number;
  private readonly claimTimeoutMs: number;
  private readonly answerTimeoutMs: number;

  constructor(private readonly options: AgentAiProviderOptions) {
    this.store = options.store ?? new AgentRequestStore();
    this.imageDir = options.imageDir ?? agentRequestImageDir(options.visualizationId);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.pollMs = options.pollMs ?? AGENT_REQUEST_POLL_MS;
    this.claimTimeoutMs = options.claimTimeoutMs ?? AGENT_REQUEST_CLAIM_TIMEOUT_MS;
    this.answerTimeoutMs = options.answerTimeoutMs ?? AGENT_REQUEST_ANSWER_TIMEOUT_MS;
  }

  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    if (request.purpose === "connection_test") {
      throw new AiProviderError(
        "The agent provider runs only inside a visualization started by the prvision skill.",
        "config",
        false
      );
    }
    const { signal } = request;
    if (signal?.aborted) {
      throw new AiProviderError("Cancelled", "aborted", false);
    }
    const visualizationId = this.options.visualizationId;
    const requestId = await this.store.create({
      visualizationId,
      purpose: request.purpose,
      systemPrompt: request.system,
      prompt: request.prompt,
      jsonSchema: request.jsonSchema
    });
    const logFields = { visualizationId, requestId, purpose: request.purpose };
    log.info({ event: "ai.agent.request.created", ...logFields }, "Agent request created");
    if (request.images !== undefined && request.images.length > 0) {
      await this.store.setImages(requestId, await this.writeImages(requestId, request.images));
    }
    return this.awaitAnswer<T>(requestId, request.jsonSchema, logFields, signal);
  }

  private async writeImages(
    requestId: number,
    images: NonNullable<AiStructuredRequest["images"]>
  ): Promise<AgentRequestImage[]> {
    await mkdir(this.imageDir, { recursive: true });
    const written: AgentRequestImage[] = [];
    for (const [index, image] of images.entries()) {
      const filePath = path.join(this.imageDir, `${requestId}-${index + 1}.png`);
      await writeFile(filePath, Buffer.from(image.base64, "base64"));
      written.push({ label: image.label, path: filePath });
    }
    return written;
  }

  private async awaitAnswer<T>(
    requestId: number,
    jsonSchema: Record<string, unknown>,
    logFields: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<AiStructuredResult<T>> {
    for (;;) {
      if (signal?.aborted) {
        await this.store.cancel(requestId, "Run cancelled");
        throw new AiProviderError("Cancelled", "aborted", false);
      }
      const state = await this.store.readState(requestId);
      if (state === null || state.status === AgentRequestStatus.CANCELLED) {
        throw new AiProviderError("The agent request was cancelled.", "aborted", false);
      }
      if (state.status === AgentRequestStatus.ANSWERED) {
        const validation = JsonSchemaValidator.validate<T>(jsonSchema, state.response);
        if (!validation.ok) {
          throw new AiProviderError("The agent's answer no longer matches the schema.", "invalid_output", false);
        }
        log.info({ event: "ai.agent.request.answered", ...logFields }, "Agent request answered");
        return { data: validation.value, usage: AGENT_CALL_USAGE, model: AI_AGENT_MODEL_LABEL };
      }
      if (state.status === AgentRequestStatus.FAILED) {
        log.warn({ event: "ai.agent.request.failed", ...logFields }, "Agent gave up on a request");
        throw new AiProviderError(
          `The agent could not answer: ${state.errorMessage ?? "no reason given"}`,
          "refusal",
          false
        );
      }
      const now = this.now();
      if (state.status === AgentRequestStatus.PENDING && now - state.createdAt.getTime() > this.claimTimeoutMs) {
        await this.store.cancel(requestId, "Not claimed in time");
        log.warn({ event: "ai.agent.request.timed_out", stage: "claim", ...logFields }, "Agent request not claimed");
        throw new AiProviderError(
          `No Claude Code session picked up the request within ${minutes(this.claimTimeoutMs)}. Start the run with the prvision skill and keep it running.`,
          "config",
          false
        );
      }
      if (
        state.status === AgentRequestStatus.CLAIMED &&
        state.claimedAt !== null &&
        now - state.claimedAt.getTime() > this.answerTimeoutMs
      ) {
        await this.store.cancel(requestId, "Not answered in time");
        log.warn({ event: "ai.agent.request.timed_out", stage: "answer", ...logFields }, "Agent request unanswered");
        throw new AiProviderError(
          `The Claude Code session did not answer within ${minutes(this.answerTimeoutMs)}.`,
          "network",
          false
        );
      }
      await this.sleep(this.pollMs, signal);
    }
  }
}
