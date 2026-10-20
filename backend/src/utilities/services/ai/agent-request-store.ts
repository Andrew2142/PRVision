/**
 * Persistence of agent AI requests (17 §7.1). The worker's AgentAiProvider writes and polls rows; the API's
 * AgentRequestsService claims, answers and fails them. Lives in utilities so the provider never imports services/**.
 * Direct Drizzle: atomic claims and conditional status writes need `update … where status in (…) returning`.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { AGENT_CLAIM_MAX } from "../../../config-consts";
import * as schema from "../../../database/schema";
import { AgentRequestStatus, OPEN_AGENT_REQUEST_STATUSES, type AgentRequestPurpose } from "../../../enums";
import type { AgentRequestImage } from "../../../types/agent-request";
import { DrizzleDb, type Database } from "../drizzle-db";

export type AgentAiRequestRecord = typeof schema.agentAiRequests.$inferSelect;

/** What the provider stores for one AI call. */
export interface NewAgentRequest {
  visualizationId: number;
  purpose: AgentRequestPurpose;
  systemPrompt: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
}

/** Rows the provider polls: everything but the prompt texts. */
export type AgentRequestState = Pick<
  AgentAiRequestRecord,
  "id" | "status" | "response" | "errorMessage" | "createdAt" | "claimedAt"
>;

const table = schema.agentAiRequests;

export class AgentRequestStore {
  constructor(private readonly db: Database = DrizzleDb.getInstance()) {}

  /** Inserts a `pending` row; returns its id. */
  async create(request: NewAgentRequest): Promise<number> {
    const [row] = await this.db.insert(table).values(request).returning({ id: table.id });
    if (row === undefined) {
      throw new Error("Agent request insert returned no row");
    }
    return row.id;
  }

  async setImages(id: number, images: AgentRequestImage[]): Promise<void> {
    await this.db.update(table).set({ images }).where(eq(table.id, id));
  }

  /** Poll read of one request; null when the row is gone (run deleted). */
  async readState(id: number): Promise<AgentRequestState | null> {
    const [row] = await this.db
      .select({
        id: table.id,
        status: table.status,
        response: table.response,
        errorMessage: table.errorMessage,
        createdAt: table.createdAt,
        claimedAt: table.claimedAt
      })
      .from(table)
      .where(eq(table.id, id));
    return row ?? null;
  }

  /** Full row, or null. */
  async get(id: number): Promise<AgentAiRequestRecord | null> {
    const [row] = await this.db.select().from(table).where(eq(table.id, id));
    return row ?? null;
  }

  /** Every request of a run, oldest first. */
  async listForVisualization(visualizationId: number): Promise<AgentAiRequestRecord[]> {
    return this.db.select().from(table).where(eq(table.visualizationId, visualizationId)).orderBy(asc(table.id));
  }

  /**
   * Moves up to AGENT_CLAIM_MAX pending requests of a run to `claimed` in one statement and returns them, oldest
   * first. Two concurrent claims never return the same row (the `status = pending` condition is re-checked per row).
   */
  async claimPending(visualizationId: number): Promise<AgentAiRequestRecord[]> {
    const pending = this.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.visualizationId, visualizationId), eq(table.status, AgentRequestStatus.PENDING)))
      .orderBy(asc(table.id))
      .limit(AGENT_CLAIM_MAX);
    const claimed = await this.db
      .update(table)
      .set({ status: AgentRequestStatus.CLAIMED, claimedAt: new Date() })
      .where(and(inArray(table.id, pending), eq(table.status, AgentRequestStatus.PENDING)))
      .returning();
    return claimed.sort((a, b) => a.id - b.id);
  }

  /** `pending|claimed → answered`. False when the request is no longer open. */
  async answer(id: number, response: Record<string, unknown>): Promise<boolean> {
    const rows = await this.db
      .update(table)
      .set({ status: AgentRequestStatus.ANSWERED, response, answeredAt: new Date(), errorMessage: null })
      .where(and(eq(table.id, id), inArray(table.status, OPEN_AGENT_REQUEST_STATUSES)))
      .returning({ id: table.id });
    return rows.length > 0;
  }

  /** `pending|claimed → failed`. False when the request is no longer open. */
  async fail(id: number, message: string): Promise<boolean> {
    return this.closeOpen(eq(table.id, id), AgentRequestStatus.FAILED, message).then((count) => count > 0);
  }

  /** `pending|claimed → cancelled` for one request. */
  async cancel(id: number, message: string): Promise<boolean> {
    return this.closeOpen(eq(table.id, id), AgentRequestStatus.CANCELLED, message).then((count) => count > 0);
  }

  /** Cancels every open request of a run; returns how many. */
  async cancelOpen(visualizationId: number, message: string): Promise<number> {
    return this.closeOpen(eq(table.visualizationId, visualizationId), AgentRequestStatus.CANCELLED, message);
  }

  /** Deletes every request of a run (visualizations are soft-deleted, so the FK cascade does not fire). */
  async deleteForVisualization(visualizationId: number): Promise<number> {
    const rows = await this.db
      .delete(table)
      .where(eq(table.visualizationId, visualizationId))
      .returning({ id: table.id });
    return rows.length;
  }

  private async closeOpen(
    target: ReturnType<typeof eq>,
    status: typeof AgentRequestStatus.FAILED | typeof AgentRequestStatus.CANCELLED,
    message: string
  ): Promise<number> {
    const rows = await this.db
      .update(table)
      .set({ status, errorMessage: message })
      .where(and(target, inArray(table.status, OPEN_AGENT_REQUEST_STATUSES)))
      .returning({ id: table.id });
    return rows.length;
  }
}
