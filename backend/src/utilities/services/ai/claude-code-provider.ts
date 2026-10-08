/**
 * AiProvider backed by the locally installed Claude Code CLI and the account it is signed in to (05 §5.12,
 * Revision 10). Each call runs `claude --print` once, headless, the way Paperclip's claude_local adapter does
 * (https://github.com/paperclipai/paperclip, MIT): the request goes in on stdin as one stream-json user message
 * and the run comes back as stream-json events on stdout.
 *
 * Lockdown, all through CLI flags (verified against Claude Code 2.1.280 `claude --help`):
 *  - `--tools ""`: no built-in tools. With `--json-schema` the CLI adds only its StructuredOutput tool.
 *  - `--safe-mode`: no CLAUDE.md, skills, plugins, hooks, MCP servers or custom agents from the user or the
 *    repository; `--strict-mcp-config` and `--disable-slash-commands` on top.
 *  - `--permission-mode dontAsk`: nothing prompts; anything not pre-approved is denied.
 *  - `--no-session-persistence`: nothing is written to the CLI's session history.
 *  - `--system-prompt-file`: PRVision's system prompt replaces Claude Code's default one.
 *  - The child env is CHILD_PROCESS_BASE_ENV plus the CLI's login variables only (AI_CLAUDE_CODE_PARENT_ENV), so
 *    the CLI authenticates with its own sign-in and never with an ANTHROPIC_* key from PRVision's environment.
 * Images travel as base64 image blocks in the stdin message, so no file tool is needed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AI_CLAUDE_CODE_COMMAND,
  AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES,
  AI_CLAUDE_CODE_MAX_OUTPUT_BYTES,
  AI_CLAUDE_CODE_MAX_SCHEMA_CHARS,
  AI_CLAUDE_CODE_MAX_TURNS,
  AI_CLAUDE_CODE_PARENT_ENV,
  AI_CLAUDE_CODE_TIMEOUT_MS,
  AI_CLAUDE_CODE_VERSION_CACHE_MS,
  AI_CLAUDE_CODE_VERSION_TIMEOUT_MS,
  CHILD_PROCESS_BASE_ENV
} from "../../../config-consts";
import { ProcessError, runProcess, type ProcessResult, type RunProcessOptions } from "../../helpers/process";
import { createLogger, redactSecrets } from "../../loggers/logger";
import {
  AiProviderError,
  ZERO_USAGE,
  addUsage,
  type AiProvider,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage
} from "./ai-provider";
import { extractFinalResult, extractJsonObject, parseStreamJson, type AgentFinalResult } from "./claude-code-result";
import { JsonSchemaValidator } from "./json-schema-validator";

/** Same shape as runProcess (test seam). */
export type ClaudeCodeRunFn = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions
) => Promise<ProcessResult>;

export interface ClaudeCodeProviderOptions {
  model: string;
  /** Default AI_CLAUDE_CODE_COMMAND. */
  command?: string;
  /** Tests inject a fake; default runProcess. */
  run?: ClaudeCodeRunFn;
  /** Whole-run deadline per CLI run; default AI_CLAUDE_CODE_TIMEOUT_MS (test seam). */
  timeoutMs?: number;
}

/** Outcome of the `claude --version` probe. */
export type ClaudeCodeCliStatus = { available: true; version: string } | { available: false; message: string };

export const NOT_INSTALLED_MESSAGE =
  "Claude Code is not installed or not on PATH. Install it, run `claude auth login` once, then retry.";
export const NOT_SIGNED_IN_MESSAGE =
  "Claude Code is not signed in or its login expired. Run `claude auth login` in a terminal, then retry.";
const CLI_MESSAGE_MAX_CHARS = 300;
const RETRY_PREVIOUS_OUTPUT_MAX_CHARS = 8_000;
/** `claude` exits 1 when the run ended in an error result; that result is still parsed. */
const CLI_EXIT_CODES = [0, 1] as const;

const log = createLogger("ai.claude_code");

/**
 * Builds the Claude Code child environment: the shared child allow-list plus the CLI's login variables.
 *
 * @param login - Login variables; default AI_CLAUDE_CODE_PARENT_ENV (never process.env, 00 §14.12).
 */
export function buildClaudeCodeEnv(
  login: Readonly<Record<string, string>> = AI_CLAUDE_CODE_PARENT_ENV
): Record<string, string> {
  return { ...CHILD_PROCESS_BASE_ENV, ...login };
}

/**
 * argv of one `claude --print` run. The prompt is not on argv; it goes in on stdin.
 *
 * @param input - Model, effort, system prompt file and the JSON schema.
 */
export function buildClaudeCodeArgs(input: {
  model: string;
  effort: AiStructuredRequest["effort"];
  systemPromptFile: string;
  jsonSchema: Record<string, unknown>;
}): string[] {
  return [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--max-turns",
    String(AI_CLAUDE_CODE_MAX_TURNS),
    "--tools",
    "",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--system-prompt-file",
    input.systemPromptFile,
    "--json-schema",
    JSON.stringify(input.jsonSchema)
  ];
}

/**
 * Structured-output calls through the Claude Code CLI: no tools, no user or repository customisations, the CLI's
 * own sign-in, native JSON schema output re-validated with ajv, and one corrective retry.
 */
export class ClaudeCodeProvider implements AiProvider {
  readonly kind = "claude_code" as const;
  private static versionCache: { status: ClaudeCodeCliStatus; at: number } | null = null;

  constructor(private readonly options: ClaudeCodeProviderOptions) {}

  /**
   * Runs `claude --version` (successful results are cached for AI_CLAUDE_CODE_VERSION_CACHE_MS). Used by
   * readiness checks; says nothing about the sign-in, which only a real call (the connection test) can prove.
   */
  static async checkCli(
    run: ClaudeCodeRunFn = runProcess,
    command: string = AI_CLAUDE_CODE_COMMAND
  ): Promise<ClaudeCodeCliStatus> {
    const cached = ClaudeCodeProvider.versionCache;
    if (cached !== null && Date.now() - cached.at < AI_CLAUDE_CODE_VERSION_CACHE_MS) {
      return cached.status;
    }
    try {
      const result = await run(command, ["--version"], {
        cwd: os.tmpdir(),
        env: buildClaudeCodeEnv(),
        timeoutMs: AI_CLAUDE_CODE_VERSION_TIMEOUT_MS,
        logLabel: "claude --version"
      });
      const status: ClaudeCodeCliStatus = { available: true, version: result.stdout.trim().split(/\s+/)[0] ?? "" };
      ClaudeCodeProvider.versionCache = { status, at: Date.now() };
      return status;
    } catch (error: unknown) {
      log.warn({ event: "ai.claude_code.cli_unavailable", err: error }, "Claude Code CLI is not available");
      return { available: false, message: NOT_INSTALLED_MESSAGE };
    }
  }

  /** Test hook: forget the cached version probe. */
  static resetCliCheckForTesting(): void {
    ClaudeCodeProvider.versionCache = null;
  }

  /**
   * One structured call: up to 1 + AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES CLI runs. Errors after a run returned
   * carry the accumulated usage.
   */
  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    if (request.signal?.aborted) {
      throw new AiProviderError("AI request cancelled", "aborted", false);
    }
    if (JSON.stringify(request.jsonSchema).length > AI_CLAUDE_CODE_MAX_SCHEMA_CHARS) {
      throw new AiProviderError("The JSON schema is too large for the Claude Code CLI.", "config", false);
    }
    const scratch = await mkdtemp(path.join(os.tmpdir(), "prvision-cc-")); // 0700, unpredictable suffix
    let usage: AiUsage = ZERO_USAGE;
    try {
      const systemPromptFile = path.join(scratch, "system-prompt.md");
      await writeFile(systemPromptFile, request.system, { mode: 0o600, flag: "wx" });
      const args = buildClaudeCodeArgs({
        model: this.options.model,
        effort: request.effort,
        systemPromptFile,
        jsonSchema: request.jsonSchema
      });
      const cwd = request.workingDirectory ?? scratch;
      let prompt = request.prompt;
      let lastSummary = "";
      for (let attempt = 0; attempt <= AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES; attempt += 1) {
        const final = await this.runOnce(args, cwd, ClaudeCodeProvider.stdinMessage(request, prompt), request.signal);
        usage = addUsage(usage, final.usage ?? { ...ZERO_USAGE, calls: 1 });
        this.throwIfFailed(final, usage);
        const parsed = ClaudeCodeProvider.parseFinal(final);
        const validation = parsed.ok ? JsonSchemaValidator.validate<T>(request.jsonSchema, parsed.value) : parsed;
        if (validation.ok) {
          return { data: validation.value, usage, model: final.model ?? this.options.model };
        }
        lastSummary = validation.errors.slice(0, 3).join("; ");
        log.warn(
          {
            event: "ai.claude_code.invalid_output",
            purpose: request.purpose,
            attempt,
            errors: validation.errors.slice(0, 5)
          },
          "Claude Code returned invalid output"
        );
        prompt = ClaudeCodeProvider.retryPrompt(request.prompt, parsed.raw, validation.errors);
      }
      throw new AiProviderError(
        `Claude Code did not return valid JSON after a retry: ${lastSummary}`.slice(0, CLI_MESSAGE_MAX_CHARS),
        "invalid_output",
        true,
        usage
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async runOnce(
    args: readonly string[],
    cwd: string,
    stdin: string,
    signal: AbortSignal | undefined
  ): Promise<AgentFinalResult> {
    const timeoutMs = this.options.timeoutMs ?? AI_CLAUDE_CODE_TIMEOUT_MS;
    const run = this.options.run ?? runProcess;
    let result: ProcessResult;
    try {
      result = await run(this.options.command ?? AI_CLAUDE_CODE_COMMAND, args, {
        cwd,
        env: buildClaudeCodeEnv(),
        timeoutMs,
        maxBufferBytes: AI_CLAUDE_CODE_MAX_OUTPUT_BYTES,
        input: stdin,
        allowedExitCodes: CLI_EXIT_CODES,
        ...(signal === undefined ? {} : { signal }),
        logLabel: "claude --print"
      });
    } catch (error: unknown) {
      throw ClaudeCodeProvider.mapProcessError(error, timeoutMs);
    }
    const final = extractFinalResult(parseStreamJson(result.stdout));
    if (final.isError && final.usage === null) {
      // No result event: the CLI failed before the run started (bad flag, unknown model, crash). stderr says why.
      const stderr = result.stderr.trim().split("\n")[0] ?? "";
      if (stderr !== "") {
        return { ...final, errorMessage: stderr };
      }
    }
    return final;
  }

  /** One stream-json user message: images first, then their legend and the prompt (as the API provider does). */
  private static stdinMessage(request: AiStructuredRequest, prompt: string): string {
    const images = request.images ?? [];
    const content: unknown[] = images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 }
    }));
    const legend = images.map((image, index) => `Image ${index + 1}: ${image.label}`).join("\n");
    content.push({ type: "text", text: legend ? `${legend}\n\n${prompt}` : prompt });
    return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
  }

  private static retryPrompt(prompt: string, previousOutput: string, errors: readonly string[]): string {
    return [
      prompt,
      `Your previous reply:\n<previous_reply>\n${previousOutput.slice(0, RETRY_PREVIOUS_OUTPUT_MAX_CHARS)}\n</previous_reply>`,
      `Your previous reply did not satisfy the required JSON Schema. Errors:\n${errors.join("\n")}\nReturn the corrected object.`
    ].join("\n\n");
  }

  /** Native structured output when present, else the first JSON object of the final text. */
  private static parseFinal(
    final: AgentFinalResult
  ): { ok: true; value: unknown; raw: string } | { ok: false; errors: string[]; raw: string } {
    if (final.structuredOutput.present) {
      const value = final.structuredOutput.value;
      return { ok: true, value, raw: JSON.stringify(value) };
    }
    const extracted = extractJsonObject(final.text);
    return extracted.ok
      ? { ok: true, value: extracted.value, raw: final.text }
      : { ok: false, errors: [extracted.error], raw: final.text };
  }

  private throwIfFailed(final: AgentFinalResult, usage: AiUsage): void {
    if (!final.isError) {
      return;
    }
    const detail = redactSecrets(final.errorMessage ?? "unknown error").slice(0, CLI_MESSAGE_MAX_CHARS);
    switch (final.errorKind) {
      case "auth":
        throw new AiProviderError(NOT_SIGNED_IN_MESSAGE, "auth", false, usage);
      case "max_turns":
        throw new AiProviderError(
          "Claude Code reached its turn limit without a final answer.",
          "invalid_output",
          true,
          usage
        );
      case "invalid_output":
        throw new AiProviderError(
          "Claude Code could not produce output matching the schema.",
          "invalid_output",
          true,
          usage
        );
      case "rate_limit":
        throw new AiProviderError(`Claude Code is rate limited or out of usage: ${detail}`, "rate_limit", true, usage);
      case "config":
        throw new AiProviderError(
          `Claude Code rejected the request for model "${this.options.model}": ${detail}`,
          "config",
          false,
          usage
        );
      case "spawn":
        throw new AiProviderError(NOT_INSTALLED_MESSAGE, "config", false, usage);
      case "other":
      case null:
        throw new AiProviderError(detail, "unknown", false, usage);
    }
  }

  /** runProcess failures: missing binary → config; timeout → network (retryable); abort → aborted. */
  private static mapProcessError(error: unknown, timeoutMs: number): AiProviderError {
    if (!(error instanceof ProcessError)) {
      const message = error instanceof Error ? error.message : String(error);
      return new AiProviderError(redactSecrets(message).slice(0, CLI_MESSAGE_MAX_CHARS), "unknown", false);
    }
    switch (error.kind) {
      case "spawn_failed":
        return new AiProviderError(NOT_INSTALLED_MESSAGE, "config", false);
      case "timeout":
        return new AiProviderError(
          `Claude Code did not finish within ${Math.round(timeoutMs / 1000)} s.`,
          "network",
          true
        );
      case "aborted":
        return new AiProviderError("AI request cancelled", "aborted", false);
      case "max_buffer":
        return new AiProviderError("Claude Code produced more output than PRVision accepts.", "unknown", false);
      case "non_zero_exit": {
        const stderr = redactSecrets(error.stderr.trim().split("\n")[0] ?? "").slice(0, CLI_MESSAGE_MAX_CHARS);
        return new AiProviderError(
          `Claude Code exited with code ${String(error.exitCode)}${stderr === "" ? "" : `: ${stderr}`}`,
          "unknown",
          false
        );
      }
    }
  }
}
