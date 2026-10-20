/**
 * Agent request API rules (17 §8): list and claim the AI requests of an agent run, answer them (validated against
 * the request's own JSON schema) or give up on them. The worker side is AgentAiProvider; both share
 * AgentRequestStore.
 */
import { AGENT_ANSWER_MAX_ERRORS } from "../../config-consts";
import {
  toAgentRequestSummaryView,
  toAgentRequestView,
  type AgentRequestSummaryView,
  type AgentRequestUpdateResponse,
  type AgentRequestView
} from "../../dtos";
import { AgentRequestStatus, ErrorReason, OPEN_AGENT_REQUEST_STATUSES, Table } from "../../enums";
import { VisualizationModel } from "../../models";
import {
  AgentRequestStore,
  JsonSchemaValidator,
  QueryHandler,
  createLogger,
  type AgentAiRequestRecord,
  type ApiResponse
} from "../../utilities";

/** Collaborators; tests pass fakes. */
export interface AgentRequestsServiceDependencies {
  store: Pick<AgentRequestStore, "get" | "listForVisualization" | "claimPending" | "answer" | "fail">;
  /** True when the visualization exists and is not deleted. */
  visualizationExists(id: number): Promise<boolean>;
}

const VISUALIZATION_NOT_FOUND: ApiResponse<never> = {
  status: 404,
  error: "Visualization not found",
  error_reason: ErrorReason.NOT_FOUND
};
const REQUEST_NOT_FOUND: ApiResponse<never> = {
  status: 404,
  error: "Agent request not found",
  error_reason: ErrorReason.NOT_FOUND
};

function isOpen(status: AgentAiRequestRecord["status"]): boolean {
  return (OPEN_AGENT_REQUEST_STATUSES as readonly string[]).includes(status);
}

function notOpen(id: number, status: string): ApiResponse<never> {
  return { status: 409, error: `Request ${id} is ${status}`, error_reason: ErrorReason.CONFLICT };
}

export class AgentRequestsService {
  private readonly deps: AgentRequestsServiceDependencies;
  private readonly log = createLogger("agent-requests-service");

  constructor(deps: Partial<AgentRequestsServiceDependencies> = {}) {
    this.deps = {
      store: deps.store ?? new AgentRequestStore(),
      visualizationExists:
        deps.visualizationExists ??
        (async (id) =>
          (await new QueryHandler().validateAndSelect(VisualizationModel, { id }, Table.VISUALIZATIONS)) !== null)
    };
  }

  /** GET /api/visualizations/:id/agent-requests — every request of the run, oldest first. */
  async list(visualizationId: number): Promise<ApiResponse<AgentRequestSummaryView[]>> {
    if (!(await this.deps.visualizationExists(visualizationId))) {
      return VISUALIZATION_NOT_FOUND;
    }
    const rows = await this.deps.store.listForVisualization(visualizationId);
    return { status: 200, data: rows.map(toAgentRequestSummaryView) };
  }

  /** POST /api/visualizations/:id/agent-requests/claim — hands out the run's pending requests (may be empty). */
  async claim(visualizationId: number): Promise<ApiResponse<AgentRequestView[]>> {
    if (!(await this.deps.visualizationExists(visualizationId))) {
      return VISUALIZATION_NOT_FOUND;
    }
    const rows = await this.deps.store.claimPending(visualizationId);
    if (rows.length > 0) {
      this.log.info(
        { event: "agent.requests.claimed", visualizationId, requestIds: rows.map((row) => row.id) },
        "Agent requests claimed"
      );
    }
    return { status: 200, data: rows.map(toAgentRequestView) };
  }

  /** POST /api/agent-requests/:id/answer — 400 with the schema errors so the agent can fix and resubmit. */
  async answer(id: number, response: Record<string, unknown>): Promise<ApiResponse<AgentRequestUpdateResponse>> {
    const row = await this.deps.store.get(id);
    if (row === null) {
      return REQUEST_NOT_FOUND;
    }
    if (!isOpen(row.status)) {
      return notOpen(id, row.status);
    }
    const validation = JsonSchemaValidator.validate(row.jsonSchema, response);
    if (!validation.ok) {
      return {
        status: 400,
        error: validation.errors.slice(0, AGENT_ANSWER_MAX_ERRORS),
        error_reason: ErrorReason.VALIDATION_FAILED
      };
    }
    if (!(await this.deps.store.answer(id, response))) {
      return this.closedMeanwhile(id);
    }
    this.log.info({ event: "agent.request.answered", requestId: id, visualizationId: row.visualizationId }, "Answered");
    return { status: 200, data: { id, status: AgentRequestStatus.ANSWERED } };
  }

  /** POST /api/agent-requests/:id/fail — the agent gives up; the pipeline treats it as a refusal. */
  async fail(id: number, message: string): Promise<ApiResponse<AgentRequestUpdateResponse>> {
    const row = await this.deps.store.get(id);
    if (row === null) {
      return REQUEST_NOT_FOUND;
    }
    if (!isOpen(row.status)) {
      return notOpen(id, row.status);
    }
    if (!(await this.deps.store.fail(id, message))) {
      return this.closedMeanwhile(id);
    }
    this.log.info({ event: "agent.request.failed", requestId: id, visualizationId: row.visualizationId }, "Failed");
    return { status: 200, data: { id, status: AgentRequestStatus.FAILED } };
  }

  /** The conditional write found the request closed between the read and the write (cancel or timeout). */
  private async closedMeanwhile(id: number): Promise<ApiResponse<never>> {
    const current = await this.deps.store.get(id);
    return current === null ? REQUEST_NOT_FOUND : notOpen(id, current.status);
  }
}
