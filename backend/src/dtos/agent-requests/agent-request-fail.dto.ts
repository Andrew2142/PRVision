import { Transform } from "class-transformer";
import { IsString, MaxLength, MinLength } from "class-validator";
import { AGENT_FAIL_MESSAGE_MAX_CHARS } from "../../config-consts";

/** POST /api/agent-requests/:id/fail (17 §8): why the agent could not answer. */
export class AgentRequestFailDTO {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: "message must not be empty" })
  @MaxLength(AGENT_FAIL_MESSAGE_MAX_CHARS)
  message!: string;
}
