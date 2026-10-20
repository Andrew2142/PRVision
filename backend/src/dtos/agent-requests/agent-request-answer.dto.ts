import { IsObject } from "class-validator";

/**
 * POST /api/agent-requests/:id/answer (17 §8). `response` is any JSON object; the service validates it against the
 * request's own JSON schema.
 */
export class AgentRequestAnswerDTO {
  @IsObject({ message: "response must be a JSON object" })
  response!: Record<string, unknown>;
}
