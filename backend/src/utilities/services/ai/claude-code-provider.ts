/**
 * AiProvider backed by the locally installed Claude Code through `@anthropic-ai/claude-agent-sdk` (05 §5.12).
 *
 * Policy (00 D5): this uses the developer's own Claude Code sign-in and is for this personal prototype only.
 * Before any distribution it must require API-key auth or be removed.
 *
 * SDK option names verified against @anthropic-ai/claude-agent-sdk 0.3.288 (sdk.d.ts `Options`):
 *  - `cwd`, `model`, `maxTurns`, `effort` ("low" … "max"), `abortController`, `systemPrompt` (a string replaces
 *    Claude Code's default prompt), `persistSession`.
 *  - `tools: string[]` = the base set of available built-in tools; `allowedTools` = auto-approved;
 *    `disallowedTools` = removed from the model's context.
 *  - `permissionMode: "dontAsk"` = never prompts, denies anything not pre-approved (no edit auto-approval).
 *  - `canUseTool` = permission callback; `hooks.PreToolUse` runs before EVERY tool call, including pre-approved
 *    ones, so the path policy is enforced there too (a deny decision blocks the call).
 *  - `settingSources: []` = SDK isolation mode: no user/project/local settings, hooks or CLAUDE.md.
 *    `strictMcpConfig: true` + `mcpServers: {}` = no MCP servers from the repository; `skills: []` = none.
 *  - `env` REPLACES the child environment (documented: "not merged with process.env"), so no custom spawn is needed.
 *  - `verbatimPrompts: true` = no `@path` expansion or slash-command dispatch of prompt text (repo content is
 *    untrusted). Older CLIs ignore it.
 *  - `outputFormat` (native JSON schema) exists but is served by a CLI-internal "StructuredOutput" tool whose
 *    interaction with the `tools`/permission lockdown above is undocumented; the prompt-based JSON contract is used
 *    instead (build note 05).
 *  - Errors: the only exported error class is `AbortError`; spawn failures surface as Node errors with `code`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AI_CLAUDE_CODE_ENV_ALLOWLIST,
  AI_CLAUDE_CODE_ENV_DENYLIST,
  AI_CLAUDE_CODE_ENV_PREFIXES,
  AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES,
  AI_CLAUDE_CODE_IMAGE_TURN_MARGIN,
  AI_CLAUDE_CODE_MAX_TURNS,
  AI_CLAUDE_CODE_MAX_TURNS_NO_TOOLS,
  AI_CLAUDE_CODE_PARENT_ENV,
  AI_CLAUDE_CODE_TIMEOUT_MS
} from "../../../config-consts";
import { isPathInside, isRealPathInside } from "../../helpers/paths";
import { createLogger, redactSecrets } from "../../loggers/logger";
import {
  AiProviderError,
  ZERO_USAGE,
  addUsage,
  type AiEffortValue,
  type AiProvider,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage
} from "./ai-provider";
import { extractFinalResult, extractJsonObject, type AgentFinalResult } from "./claude-code-result";
import { JsonSchemaValidator } from "./json-schema-validator";
// Type-only: the ESM-only SDK is loaded at run time with a dynamic import() (importSdk).
import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

/** The part of the SDK module this provider uses. */
interface SdkModule {
  query: typeof sdkQuery;
}
type SdkOptions = NonNullable<Parameters<typeof sdkQuery>[0]["options"]>;
type SdkCanUseTool = NonNullable<SdkOptions["canUseTool"]>;
type SdkHookCallback = NonNullable<NonNullable<SdkOptions["hooks"]>["PreToolUse"]>[number]["hooks"][number];

/** The only tools Claude Code may use. */
export const CLAUDE_CODE_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;
export type ClaudeCodeTool = (typeof CLAUDE_CODE_ALLOWED_TOOLS)[number];
/** Removed from the model's context (defence in depth on top of `tools`). */
export const CLAUDE_CODE_DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "SlashCommand",
  "TodoWrite",
  "ExitPlanMode"
] as const;

export const SDK_UNAVAILABLE_MESSAGE =
  "The Claude Code provider is unavailable: @anthropic-ai/claude-agent-sdk could not be loaded. Run npm install in backend/.";
const NOT_INSTALLED_MESSAGE = "Claude Code is not installed or not on PATH.";
const SDK_MESSAGE_MAX_CHARS = 300;
const RETRY_PREVIOUS_OUTPUT_MAX_CHARS = 8_000;
const SPAWN_ERROR_CODES = new Set(["ENOENT", "EACCES", "ENOTDIR"]);

/** Narrow structural type of the SDK's query(): behavioural options in, SDK messages (unknown) out. */
export type AgentQueryFn = (args: { prompt: string; options: ClaudeCodeQueryOptions }) => AsyncIterable<unknown>;

/** Behavioural options. buildSdkOptions() translates these into the SDK's option object. */
export interface ClaudeCodeQueryOptions {
  cwd: string;
  model: string;
  systemPrompt: string;
  /** Empty for text-only calls; ["Read"] when images must be read from disk. */
  allowedTools: readonly ClaudeCodeTool[];
  /** cwd + image dir; enforced by the permission callback and the PreToolUse hook. */
  readableRoots: string[];
  maxTurns: number;
  env: Record<string, string>;
  abortController: AbortController;
  effort: AiEffortValue;
}

export interface ClaudeCodeProviderOptions {
  model: string;
  /** Tests inject a fake; default is the SDK's query() loaded lazily. */
  queryFn?: AgentQueryFn;
  /** Whole-run deadline per query; default AI_CLAUDE_CODE_TIMEOUT_MS (test seam). */
  timeoutMs?: number;
}

/** Decision of the tool policy. */
export type ToolUseDecision = { allow: true } | { allow: false; reason: string; relativePath: string | null };

interface Scratch {
  cwd: string;
  readableRoots: string[];
  imagePaths: Array<{ path: string; label: string }>;
  cleanup(): Promise<void>;
}

const log = createLogger("ai.claude_code");

/**
 * Builds the Claude Code child environment: names in AI_CLAUDE_CODE_ENV_ALLOWLIST or starting with an
 * AI_CLAUDE_CODE_ENV_PREFIXES entry, minus AI_CLAUDE_CODE_ENV_DENYLIST and every PRVISION_* name. The filter is
 * re-applied to the base (defence in depth), so a test-supplied base is held to the same rules. The decrypted
 * Anthropic key from settings is never injected.
 *
 * @param base - Parent variables; default AI_CLAUDE_CODE_PARENT_ENV (never process.env, 00 §14.12).
 */
export function buildClaudeCodeEnv(
  base: Readonly<Record<string, string>> = AI_CLAUDE_CODE_PARENT_ENV
): Record<string, string> {
  const allow = new Set<string>(AI_CLAUDE_CODE_ENV_ALLOWLIST);
  const deny = new Set<string>(AI_CLAUDE_CODE_ENV_DENYLIST);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    const allowed = allow.has(name) || AI_CLAUDE_CODE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (allowed && !deny.has(name) && !name.startsWith("PRVISION_")) {
      env[name] = value;
    }
  }
  return env;
}

/** True for paths Claude Code must never read, whatever the root (05 §5.12.1 deny list). */
function isSensitivePath(relativePosixPath: string): boolean {
  const segments = relativePosixPath.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === ".git" || segment === "node_modules")) {
    return true;
  }
  const base = segments[segments.length - 1] ?? "";
  return base.startsWith(".env") || base.endsWith(".pem") || base.endsWith(".key") || base.startsWith("id_rsa");
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function slug(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned === "" ? "image" : cleaned;
}

/**
 * Structured-output calls through Claude Code: read-only tools confined to the working directory, no repository
 * settings, allow-listed env, prompt-based JSON contract validated with ajv and one corrective retry.
 */
export class ClaudeCodeProvider implements AiProvider {
  readonly kind = "claude_code" as const;
  private static sdkPromise: Promise<AgentQueryFn> | null = null;

  /** Loads the SDK module (test seam: patch to simulate a missing package). */
  static importSdk: () => Promise<SdkModule> = () => import("@anthropic-ai/claude-agent-sdk");

  constructor(private readonly options: ClaudeCodeProviderOptions) {}

  /** True when the Agent SDK can be loaded (cached). Used by readiness checks. */
  static async isSdkAvailable(): Promise<boolean> {
    try {
      await ClaudeCodeProvider.loadSdk();
      return true;
    } catch {
      return false; // the reason is fixed: SDK_UNAVAILABLE_MESSAGE
    }
  }

  /** Test hook: forget the cached SDK load result. */
  static resetSdkForTesting(): void {
    ClaudeCodeProvider.sdkPromise = null;
  }

  /** Lazily imports the SDK once; a failure is AiProviderError("config"). */
  static async loadSdk(): Promise<AgentQueryFn> {
    ClaudeCodeProvider.sdkPromise ??= ClaudeCodeProvider.importQueryFn();
    return ClaudeCodeProvider.sdkPromise;
  }

  /** Translates behavioural options into the SDK's Options (see file header for each name). */
  static buildSdkOptions(options: ClaudeCodeQueryOptions): SdkOptions {
    const canUseTool: SdkCanUseTool = async (toolName, input) => {
      const decision = await ClaudeCodeProvider.evaluateToolUse(toolName, input, options.readableRoots);
      return decision.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: decision.reason };
    };
    const preToolUse: SdkHookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== "PreToolUse") {
        return {};
      }
      const input =
        typeof hookInput.tool_input === "object" && hookInput.tool_input !== null ? hookInput.tool_input : {};
      const decision = await ClaudeCodeProvider.evaluateToolUse(
        hookInput.tool_name,
        input as Record<string, unknown>,
        options.readableRoots
      );
      return decision.allow
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.reason
            }
          };
    };
    return {
      cwd: options.cwd,
      model: options.model,
      systemPrompt: options.systemPrompt,
      tools: [...options.allowedTools],
      allowedTools: [...options.allowedTools],
      disallowedTools: [
        ...CLAUDE_CODE_DISALLOWED_TOOLS,
        ...CLAUDE_CODE_ALLOWED_TOOLS.filter((tool) => !options.allowedTools.includes(tool))
      ],
      permissionMode: "dontAsk",
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      skills: [],
      maxTurns: options.maxTurns,
      effort: options.effort,
      env: options.env,
      abortController: options.abortController,
      persistSession: false,
      verbatimPrompts: true
    };
  }

  /**
   * Tool policy: only Read/Glob/Grep; their paths must resolve (realpath) inside a readable root and must not hit
   * the sensitive-file deny list; Glob/Grep patterns may not be absolute or contain "..". Denials are logged with
   * the root-relative path only.
   */
  static async evaluateToolUse(
    toolName: string,
    input: Record<string, unknown>,
    readableRoots: readonly string[]
  ): Promise<ToolUseDecision> {
    if (!(CLAUDE_CODE_ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
      return ClaudeCodeProvider.deny(toolName, `Tool ${toolName} is not allowed`, null);
    }
    const root = readableRoots[0];
    if (root === undefined) {
      return ClaudeCodeProvider.deny(toolName, "No readable directory is configured", null);
    }
    const target = toolName === "Read" ? stringInput(input, "file_path") : stringInput(input, "path");
    if (toolName === "Read" && target === null) {
      return ClaudeCodeProvider.deny(toolName, "Read needs a file_path", null);
    }
    const resolved = path.resolve(root, target ?? ".");
    const containing = await ClaudeCodeProvider.findReadableRoot(resolved, readableRoots);
    const relativePath = path
      .relative(containing ?? root, resolved)
      .split(path.sep)
      .join("/");
    if (containing === null) {
      return ClaudeCodeProvider.deny(toolName, "Path is outside the readable directories", relativePath);
    }
    if (isSensitivePath(relativePath)) {
      return ClaudeCodeProvider.deny(toolName, "Path is on the sensitive-file deny list", relativePath);
    }
    for (const key of ["pattern", "glob"] as const) {
      const pattern = toolName === "Read" ? null : stringInput(input, key);
      if (pattern === null || (toolName === "Grep" && key === "pattern")) {
        continue; // Grep's `pattern` is a content regex, not a path
      }
      const posixPattern = pattern.replace(/\\/g, "/");
      if (path.posix.isAbsolute(posixPattern) || posixPattern.split("/").includes("..")) {
        return ClaudeCodeProvider.deny(toolName, "Patterns must stay inside the directory", relativePath);
      }
      if (isSensitivePath(posixPattern)) {
        return ClaudeCodeProvider.deny(toolName, "Pattern targets the sensitive-file deny list", relativePath);
      }
    }
    return { allow: true };
  }

  /**
   * One structured call: up to 1 + AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES query() runs. Errors after a run
   * returned carry the accumulated usage.
   */
  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    if (request.signal?.aborted) {
      throw new AiProviderError("AI request cancelled", "aborted", false);
    }
    const queryFn = this.options.queryFn ?? (await ClaudeCodeProvider.loadSdk());
    const scratch = await this.prepareScratch(request);
    let usage: AiUsage = ZERO_USAGE;
    try {
      let prompt = this.composePrompt(request, scratch.imagePaths);
      let lastSummary = "";
      for (let attempt = 0; attempt <= AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES; attempt += 1) {
        const final = await this.runOnce(queryFn, prompt, request, scratch);
        usage = addUsage(usage, final.usage ?? { ...ZERO_USAGE, calls: 1 });
        this.throwIfFailed(final, usage);
        const parsed = this.parseFinal(final);
        const validation = parsed.ok ? JsonSchemaValidator.validate<T>(request.jsonSchema, parsed.value) : parsed;
        if (validation.ok) {
          return { data: validation.value, usage, model: final.model ?? this.options.model };
        }
        const outcome = { errors: validation.errors, raw: parsed.raw };
        lastSummary = outcome.errors.slice(0, 3).join("; ");
        log.warn(
          {
            event: "ai.claude_code.invalid_output",
            purpose: request.purpose,
            attempt,
            errors: outcome.errors.slice(0, 5)
          },
          "Claude Code returned invalid output"
        );
        prompt = this.composeRetryPrompt(request, scratch.imagePaths, outcome.raw, outcome.errors);
      }
      throw new AiProviderError(
        `Claude Code did not return valid JSON after a retry: ${lastSummary}`.slice(0, SDK_MESSAGE_MAX_CHARS),
        "invalid_output",
        true,
        usage
      );
    } finally {
      await scratch.cleanup();
    }
  }

  private async runOnce(
    queryFn: AgentQueryFn,
    prompt: string,
    request: AiStructuredRequest,
    scratch: Scratch
  ): Promise<AgentFinalResult> {
    const timeoutMs = this.options.timeoutMs ?? AI_CLAUDE_CODE_TIMEOUT_MS;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const onAbort = (): void => {
      controller.abort();
    };
    if (combined.aborted) {
      controller.abort();
    }
    combined.addEventListener("abort", onAbort, { once: true });
    const messages: unknown[] = [];
    let iterator: AsyncIterator<unknown> | null = null;
    try {
      iterator = queryFn({ prompt, options: this.queryOptions(request, scratch, controller) })[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        messages.push(next.value);
      }
      if (request.signal?.aborted) {
        throw new AiProviderError("AI request cancelled", "aborted", false);
      }
      if (deadline.aborted) {
        throw this.deadlineError(timeoutMs);
      }
      return extractFinalResult(messages);
    } catch (error: unknown) {
      if (error instanceof AiProviderError) {
        throw error;
      }
      if (request.signal?.aborted) {
        throw new AiProviderError("AI request cancelled", "aborted", false);
      }
      if (deadline.aborted) {
        throw this.deadlineError(timeoutMs);
      }
      // The SDK throws after yielding an error result (e.g. an expired login). The collected messages carry the
      // typed failure (assistant `error`, result subtype), so classify from them instead of the thrown text.
      const partial = extractFinalResult(messages);
      if (partial.isError && partial.errorKind !== "other") {
        return partial;
      }
      throw ClaudeCodeProvider.mapSdkError(error);
    } finally {
      combined.removeEventListener("abort", onAbort);
      await iterator?.return?.(); // ensures the child process is stopped
    }
  }

  private deadlineError(timeoutMs: number): AiProviderError {
    return new AiProviderError(`Claude Code did not finish within ${Math.round(timeoutMs / 1000)} s.`, "network", true);
  }

  private queryOptions(
    request: AiStructuredRequest,
    scratch: Scratch,
    controller: AbortController
  ): ClaudeCodeQueryOptions {
    return {
      cwd: scratch.cwd,
      model: this.options.model,
      systemPrompt: request.system,
      ...ClaudeCodeProvider.toolBudget(scratch.imagePaths.length),
      readableRoots: scratch.readableRoots,
      env: buildClaudeCodeEnv(),
      abortController: controller,
      effort: request.effort
    };
  }

  /**
   * Text-only calls get no tools: the prompt already carries the source the model needs, and browsing the
   * repository multiplied token use by ~10x. Calls with images may only Read (the image files), one turn each.
   */
  static toolBudget(imageCount: number): { allowedTools: readonly ClaudeCodeTool[]; maxTurns: number } {
    if (imageCount === 0) {
      return { allowedTools: [], maxTurns: AI_CLAUDE_CODE_MAX_TURNS_NO_TOOLS };
    }
    return {
      allowedTools: ["Read"],
      maxTurns: Math.min(AI_CLAUDE_CODE_MAX_TURNS, imageCount + AI_CLAUDE_CODE_IMAGE_TURN_MARGIN)
    };
  }

  /** Images (if any) first, then the caller's prompt, then the JSON output contract. */
  private composePrompt(request: AiStructuredRequest, images: Scratch["imagePaths"]): string {
    const parts: string[] = [];
    if (images.length > 0) {
      const list = images.map((image, index) => `${index + 1}. ${image.path} — ${image.label}`).join("\n");
      parts.push(`Before answering, use the Read tool to view these images:\n${list}`);
    }
    parts.push(request.prompt);
    parts.push(
      "Respond with ONLY a single JSON object that validates against this JSON Schema (draft 2020-12). " +
        `No prose, no markdown fences.\n<json_schema>\n${JSON.stringify(request.jsonSchema, null, 2)}\n</json_schema>`
    );
    return parts.join("\n\n");
  }

  private composeRetryPrompt(
    request: AiStructuredRequest,
    images: Scratch["imagePaths"],
    previousOutput: string,
    errors: readonly string[]
  ): string {
    return [
      this.composePrompt(request, images),
      `Your previous reply:\n<previous_reply>\n${previousOutput.slice(0, RETRY_PREVIOUS_OUTPUT_MAX_CHARS)}\n</previous_reply>`,
      `Your previous reply did not satisfy the required JSON Schema. Errors:\n${errors.join("\n")}\nReturn ONLY the corrected JSON object.`
    ].join("\n\n");
  }

  /** Native structured output when present, else the first JSON object of the final text. */
  private parseFinal(
    final: AgentFinalResult
  ): { ok: true; value: unknown; raw: string } | { ok: false; errors: string[]; raw: string } {
    let parsed: unknown;
    let raw: string;
    if (final.structuredOutput.present) {
      parsed = final.structuredOutput.value;
      raw = JSON.stringify(parsed);
    } else {
      raw = final.text;
      const extracted = extractJsonObject(final.text);
      if (!extracted.ok) {
        return { ok: false, errors: [extracted.error], raw };
      }
      parsed = extracted.value;
    }
    return { ok: true, value: parsed, raw };
  }

  private throwIfFailed(final: AgentFinalResult, usage: AiUsage): void {
    if (!final.isError) {
      return;
    }
    const detail = redactSecrets(final.errorMessage ?? "unknown error").slice(0, SDK_MESSAGE_MAX_CHARS);
    switch (final.errorKind) {
      case "auth":
        throw new AiProviderError("Claude Code is not signed in or not authorized.", "auth", false, usage);
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
        throw new AiProviderError("Claude Code is rate limited or overloaded.", "rate_limit", true, usage);
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

  /** Builds cwd (the worktree, or a private temp dir) and writes images to a private temp dir. */
  private async prepareScratch(request: AiStructuredRequest): Promise<Scratch> {
    const created: string[] = [];
    const cleanup = async (): Promise<void> => {
      await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    };
    try {
      let cwd = request.workingDirectory;
      if (cwd === undefined) {
        cwd = await mkdtemp(path.join(os.tmpdir(), "prvision-cc-")); // 0700, unpredictable suffix
        created.push(cwd);
      }
      const readableRoots = [cwd];
      const imagePaths: Scratch["imagePaths"] = [];
      const images = request.images ?? [];
      if (images.length > 0) {
        const imageDir = await mkdtemp(path.join(os.tmpdir(), "prvision-cc-img-"));
        created.push(imageDir);
        readableRoots.push(imageDir);
        for (const [index, image] of images.entries()) {
          const filePath = path.join(imageDir, `${index + 1}-${slug(image.label)}.png`);
          await writeFile(filePath, Buffer.from(image.base64, "base64"), { mode: 0o600, flag: "wx" });
          imagePaths.push({ path: filePath, label: image.label });
        }
      }
      return { cwd, readableRoots, imagePaths, cleanup };
    } catch (error: unknown) {
      await cleanup();
      throw error;
    }
  }

  private static async importQueryFn(): Promise<AgentQueryFn> {
    let sdk: SdkModule;
    try {
      sdk = await ClaudeCodeProvider.importSdk();
    } catch (error: unknown) {
      log.warn({ event: "ai.claude_code.sdk_unavailable", err: error }, "Claude Agent SDK could not be loaded");
      throw new AiProviderError(SDK_UNAVAILABLE_MESSAGE, "config", false);
    }
    return ({ prompt, options }) => sdk.query({ prompt, options: ClaudeCodeProvider.buildSdkOptions(options) });
  }

  /** Typed signals only: Node spawn error codes → config; anything else → unknown with the SDK's own message. */
  private static mapSdkError(error: unknown): AiProviderError {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && SPAWN_ERROR_CODES.has(code)) {
      return new AiProviderError(NOT_INSTALLED_MESSAGE, "config", false);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new AiProviderError(redactSecrets(message).slice(0, SDK_MESSAGE_MAX_CHARS), "unknown", false);
  }

  private static async findReadableRoot(candidate: string, roots: readonly string[]): Promise<string | null> {
    for (const root of roots) {
      if (isPathInside(root, candidate) && (await isRealPathInside(root, candidate))) {
        return root;
      }
    }
    return null;
  }

  private static deny(tool: string, reason: string, relativePath: string | null): ToolUseDecision {
    log.warn({ event: "ai.claude_code.read_denied", tool, relativePath }, "Claude Code tool use denied");
    return { allow: false, reason, relativePath };
  }
}
