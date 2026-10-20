# 17 — Agent Provider: Headless Runs Driven by a Claude Code Session

Owner: build agent (wave 9), tasks 17a–17c (section 0)
Status: implementation-ready. User decision (2026-10-20): a Claude Code chat says "use prvision", PRVision runs headless, and **the chat itself** writes the harnesses and the summary, then hands the user a link to the run.
Depends on: 00 (all revisions, especially §8, §9, §14, §20, §22), 01, 03, 04, 05, 07, 09, 11, 16

Today every AI call of a run goes to the provider in Settings: the Anthropic API key, or the Claude Code CLI run as a child process. This sheet adds a third provider, **`agent`**, chosen per run. An agent run does no AI work of its own. Each `generateStructured` call becomes a stored **agent request**; the Claude Code session that started the run claims the requests through the API, answers them (one subagent per request), and the pipeline continues with the answers exactly as if a model had returned them. Validation, repair, rendering, diffing and the library are unchanged.

The driver is the `prvision` Claude Code skill (`tools/claude-skill/prvision`, installed with `npm run skill:install`).

Contract changes are listed in section 16. The lead applies them to 00 as **Revision 11** (00 §23) before dispatch.

---

## 0. Task split for build agents

| Task | Title | Owns (files) | Codes against | Blocks |
|---|---|---|---|---|
| **17a** | Backend: schema, provider, API, pipeline | §5.1 | §6–§9 | 17b, 17c |
| **17b** | Skill driver | §5.2 | §8, §10 | — |
| **17c** | Frontend label | §5.3 | §11 | — |

17a lands first. 17b and 17c may run in parallel after it. After each task `npm run verify` passes.

## 1. Purpose and motivation

- The user reviews UI work that a Claude Code session just did. Running PRVision should be one sentence in that chat ("use prvision"), and the answer should be a link.
- The session already knows the change: it wrote the code. Spending a second model (API key or a CLI child with a separate login) to rediscover it costs money and setup, and the CLI login inside Docker is fragile (it is not the desktop app's login).
- Harness writing parallelises well: the session hands each request to a subagent, so four harnesses are written at once, and the main chat sees only file paths, never the 20K-token prompts.

## 2. Scope / Out of scope

In scope:

- `AiProviderKind.AGENT` (`agent`), selectable **per run only** (`POST /api/visualizations` `aiProvider: "agent"`). Settings never store it.
- Table `agent_ai_requests`, the `AgentAiProvider` (worker side), the agent-request API (API side).
- Visualization runs: harness, harness repair and summary calls.
- The skill driver: claim, hand-off files, answer, fail, wait, report.
- Frontend: provider label "Claude Code session".

Out of scope:

- Library scans (16f) and UI-started repairs (16g) of an agent run use the Settings provider, as today. An agent run's in-pipeline repairs (`harness_repair` inside the run) do go through the agent.
- Live mode, export/import: no AI, unchanged.
- No UI to answer requests by hand; no Settings option.
- Token accounting: the session's usage is not visible to PRVision. Agent runs record `calls` only (§7.3).

## 3. Dependencies

- 00 §8 `AiProvider`, `AiStructuredRequest`, `AiProviderError`; §9 route table; §14.4 views; §14.5 local security.
- 05: `AiProviderFactory`, `JsonSchemaValidator` (ajv), provider error reasons.
- 07: `VisualizationsService.create`, worker orchestration (`visualization-worker-service.ts` step 4), `remove`.
- 09: harness concurrency by provider (`harness-generation-service.ts`), `auth`/`config` errors are fatal for the run, retryable errors retry.
- 11: summary call with PNG images.
- 16: `VISUALIZATION_MAX_RUNTIME_MS` (90 min) bounds an agent run too.

## 4. Engineering decisions taken by this sheet

- **E1 — per run, not a setting.** A run started from the UI must never wait for an agent that does not exist, so `agent` is accepted only on the create request. `PUT /api/settings` keeps rejecting it (`SELECTABLE_AI_PROVIDER_KINDS`).
- **E2 — Postgres, not Redis or files.** The worker writes requests and the API answers them; both already share Postgres. A row gives an atomic claim (`update … where status = 'pending' returning`), survives restarts, and is deleted with the run (§9.3).
- **E3 — the API validates answers.** `POST /api/agent-requests/:id/answer` validates the response against the request's JSON schema with `JsonSchemaValidator` and returns 400 with the errors, so the subagent fixes and resubmits instead of failing the component. The provider validates again before returning (defence in depth; a row edited by hand cannot reach the pipeline).
- **E4 — no agent, fail fast.** A request nobody claims within `AGENT_REQUEST_CLAIM_TIMEOUT_MS` raises `AiProviderError("config")`, which 09 treats as fatal for the run. A claimed request not answered within `AGENT_REQUEST_ANSWER_TIMEOUT_MS` raises `network` (not retryable): that component fails, the run goes on.
- **E5 — images as files.** Summary PNGs arrive base64 in `AiStructuredRequest.images`. The provider writes them to `<dataDir>/agent-requests/<visualizationId>/` and stores absolute paths. The data dir is the same path on the host and in Docker (compose mounts `$HOME`), so the session reads them directly.
- **E6 — model label.** Agent runs store `ai_model = "agent"` (`AI_AGENT_MODEL_LABEL`). Cost estimates price an unknown model at the fallback, but usage tokens are 0, so the cost is 0.
- **E7 — the skill exits to hand off.** The driver cannot call the session's tools, so it exits with code 3 when requests are claimed, printing one folder per request. The session spawns subagents and restarts the driver with `wait`. This keeps every step a normal background command.
- **E8 — file references in answers.** Long code inside JSON strings is error-prone to escape. The driver replaces any string value that is exactly `@file:<path>` with that file's contents before posting. The API never sees the convention.

## 5. File inventory

### 5.1 17a — backend

| File | Change |
|---|---|
| `backend/src/enums/domain/ai-provider-kind.ts` | `AGENT: "agent"`; `SELECTABLE_AI_PROVIDER_KINDS = ["anthropic_api", "claude_code"]` |
| `backend/src/enums/domain/agent-request-status.ts` (new) | §6.1 |
| `backend/src/enums/domain/index.ts`, `enums/utility/table.ts` | export; `Table.AGENT_AI_REQUESTS` |
| `backend/src/database/schema.ts`, `database/table-registry.ts` | §6.2 |
| `backend/src/database/migrations/0010_*.sql` + `meta/*` | generated by `npm run db:generate` |
| `backend/src/models/**` | regenerated by `npm run generate:models` |
| `backend/src/config-consts/ai.config.ts` | §12 |
| `backend/src/dtos/settings/settings-update.dto.ts` | `IsIn(SELECTABLE_AI_PROVIDER_KINDS)` |
| `backend/src/dtos/visualizations/visualization-create.dto.ts` | `aiProvider?: "agent"` |
| `backend/src/dtos/agent-requests/{agent-request-answer.dto.ts, agent-request-fail.dto.ts, agent-request-view.dto.ts}` (new), `dtos/index.ts` | §8 |
| `backend/src/utilities/services/ai/agent-request-store.ts` (new) | §7.1 |
| `backend/src/utilities/services/ai/agent-provider.ts` (new) | §7.2 |
| `backend/src/utilities/services/ai/index.ts` | export both |
| `backend/src/services/agent-requests/agent-requests-service.ts` (new), `services/index.ts` | §8 |
| `backend/src/controllers/agent-requests-controller.ts` (new), `controllers/index.ts` | §8 |
| `backend/src/routes/index.ts`, `backend/src/app.ts` | routes block "17: agent requests", controller wiring |
| `backend/src/services/visualizations/visualizations-service.ts` | create (§9.1), remove (§9.3) |
| `backend/src/services/visualizations/pipeline/visualization-worker-service.ts` | §9.2 |
| `backend/src/services/visualizations/pipeline/harness-generation-service.ts` | concurrency for `agent` |
| `tests/backend/**` | §14 |

### 5.2 17b — skill

| File | Change |
|---|---|
| `tools/claude-skill/prvision/prvision-run.mjs` | §10 |
| `tools/claude-skill/prvision/SKILL.md` | §10.4 |

### 5.3 17c — frontend

| File | Change |
|---|---|
| `frontend/src/app/core/utils/labels.util.ts` | `providerLabel("agent")` → `"Claude Code session"` |
| its spec | one case |

## 6. Data model (17a)

### 6.1 Enum

```ts
export const AgentRequestStatus = {
  PENDING: "pending",     // written by the provider, waiting for a claim
  CLAIMED: "claimed",     // handed to an agent
  ANSWERED: "answered",   // response stored and valid
  FAILED: "failed",       // the agent gave up (message in error_message)
  CANCELLED: "cancelled"  // run cancelled, timed out or finished first
} as const;
export const OPEN_AGENT_REQUEST_STATUSES = ["pending", "claimed"] as const;
```

`AgentRequestPurpose` is the `AiStructuredRequest["purpose"]` set minus `connection_test`: `harness`, `harness_repair`, `summary`.

### 6.2 `agent_ai_requests` (new, hard rows, no soft delete)

| Column | Type | Notes |
|---|---|---|
| `id` | serial pk | |
| `visualization_id` | integer not null | fk `visualizations.id` **on delete cascade** |
| `purpose` | text not null | CHECK in `AgentRequestPurpose` |
| `status` | text not null default `pending` | CHECK in `AgentRequestStatus` |
| `system_prompt` | text not null | `AiStructuredRequest.system` |
| `prompt` | text not null | |
| `json_schema` | jsonb not null | `$type<Record<string, unknown>>()` |
| `images` | jsonb not null default `[]` | `$type<AgentRequestImage[]>()`: `{ label: string; path: string }` |
| `response` | jsonb null | `$type<Record<string, unknown>>()`; set only with `answered` |
| `error_message` | text null | set with `failed` / `cancelled` |
| `claimed_at`, `answered_at` | timestamptz null | |
| `created_at`, `updated_at` | timestamptz | standard |

Index `agent_ai_requests_visualization_id_status_id_idx` on `(visualization_id, status, id)` (claim and list queries). CHECKs: `answered_at` not null iff `status = 'answered'`; `response` not null iff `status = 'answered'`.

`visualizations.ai_provider` and `app_settings.ai_provider` CHECKs are regenerated from the enum and gain `agent` (same migration). Settings are still protected by the DTO (E1).

## 7. Provider (17a)

### 7.1 `AgentRequestStore` (`utilities/services/ai/agent-request-store.ts`)

Thin persistence over `QueryHandler` / direct Drizzle (utilities may use the database, 01 §5.6.3):

- `create(visualizationId, request): Promise<number>` inserts a `pending` row (images `[]`).
- `setImages(id, images)`.
- `read(id): Promise<{ status, response, errorMessage, createdAt, claimedAt } | null>`.
- `cancel(id, message)`: `pending|claimed → cancelled` (no-op otherwise).
- `cancelOpen(visualizationId, message)`: every open row of the run → `cancelled`; returns the count.
- `deleteForVisualization(visualizationId)`: hard-deletes the run's rows (§9.3).
- API side: `get`, `listForVisualization`, `claimPending`, `answer`, `fail` (§8).

### 7.2 `AgentAiProvider` (`utilities/services/ai/agent-provider.ts`)

`kind = "agent"`. Constructor `{ visualizationId, store?, imageDir?, now?, sleep?, pollMs?, claimTimeoutMs?, answerTimeoutMs? }` (defaults from §12; injectable for tests).

`generateStructured<T>(request)`:

1. `purpose = connection_test` → `AiProviderError("The agent provider runs only inside a visualization started by the prvision skill.", "config", false)`.
2. `signal` already aborted → `AiProviderError("Cancelled", "aborted", false)`.
3. Insert the row. If `images` is non-empty: write each to `<imageDir>/<requestId>-<n>.png` (`n` from 1; `imageDir` = `<dataDir>/agent-requests/<visualizationId>`, created on demand), then `setImages`.
4. Poll every `pollMs` (sleep honours `signal`):
   - `answered` → `JsonSchemaValidator.validate<T>(request.jsonSchema, response)`; invalid → `AiProviderError("The agent's answer no longer matches the schema.", "invalid_output", false)`; valid → `{ data, usage: { inputTokens: 0, outputTokens: 0, calls: 1 }, model: AI_AGENT_MODEL_LABEL }`.
   - `failed` → `AiProviderError("The agent could not answer: <error_message>", "refusal", false)`.
   - `cancelled` or row gone → `AiProviderError("The agent request was cancelled.", "aborted", false)`.
   - `pending` and `now − created_at > claimTimeoutMs` → `cancel(id, …)`, then `AiProviderError("No Claude Code session picked up the request within N minutes. Start the run with the prvision skill and keep it running.", "config", false)`.
   - `claimed` and `now − claimed_at > answerTimeoutMs` → `cancel`, then `AiProviderError("The Claude Code session did not answer within N minutes.", "network", false)`.
   - `signal.aborted` → `cancel(id, "Run cancelled")`, then `aborted`.

The provider never logs prompts or responses (01 §5.8); it logs `ai.agent.request.created|answered|failed|timed_out` with `visualizationId`, `requestId`, `purpose`.

### 7.3 Usage

Every answered call adds `{ 0, 0, calls: 1 }` through the existing recorders. The run's AI usage line reads "N calls".

## 8. API (17a)

All routes carry `requireLocal`. Envelopes per 00 §9.

| Method | Path | Controller | DTO | Response |
|---|---|---|---|---|
| GET | `/api/visualizations/:id/agent-requests` | `AgentRequestsController.list` | id param | 200 `AgentRequestSummaryView[]`, oldest first |
| POST | `/api/visualizations/:id/agent-requests/claim` | `AgentRequestsController.claim` | id param | 200 `AgentRequestView[]` |
| POST | `/api/agent-requests/:id/answer` | `AgentRequestsController.answer` | id param + `AgentRequestAnswerDTO` | 200 `{ id, status: "answered" }` |
| POST | `/api/agent-requests/:id/fail` | `AgentRequestsController.fail` | id param + `AgentRequestFailDTO` | 200 `{ id, status: "failed" }` |

```ts
interface AgentRequestSummaryView {
  id: number; visualizationId: number; purpose: "harness" | "harness_repair" | "summary";
  status: "pending" | "claimed" | "answered" | "failed" | "cancelled";
  createdAt: string; claimedAt: string | null; answeredAt: string | null;
}
interface AgentRequestView extends AgentRequestSummaryView {
  system: string; prompt: string; jsonSchema: Record<string, unknown>;
  images: Array<{ label: string; path: string }>;
}
interface AgentRequestAnswerRequest { response: Record<string, unknown>; }   // any JSON object
interface AgentRequestFailRequest { message: string; }                        // 1..2000 chars, trimmed
```

Rules:

- `list` / `claim`: 404 `not_found` when the visualization does not exist (soft-delete aware).
- `claim` moves up to `AGENT_CLAIM_MAX` (20) `pending` rows of the run to `claimed` (`claimed_at = now()`) in one statement, oldest first, and returns them. An empty array is normal. Two concurrent claims never return the same row.
- `answer`: 404 unknown id; 409 `conflict` unless `pending` or `claimed` (message names the status, e.g. "Request 12 is cancelled"); 400 `validation_failed` with `error` = the first 20 ajv messages when the response does not match `json_schema`; otherwise `answered`, `answered_at = now()`. The status check and write are one conditional `update … where status in ('pending','claimed')`; 0 rows → 409.
- `fail`: same 404/409; sets `failed` and `error_message`.
- The JSON body limit stays `JSON_BODY_LIMIT` (1 MB); a harness answer is far below it.

## 9. Pipeline changes (17a)

### 9.1 Create

`VisualizationCreateDTO.aiProvider?: "agent"` (`IsOptional`, `IsIn(["agent"])`). With `agent`: skip `aiReadiness()` (no key or CLI needed), insert `ai_provider = "agent"`, `ai_model = AI_AGENT_MODEL_LABEL`. Without it: unchanged. `continue` keeps the row's provider.

### 9.2 Worker

Step 4 of `visualization-worker-service.ts`:

```ts
const stored = await this.deps.readAiSettings();
const settings = visualization.aiProvider === AiProviderKind.AGENT
  ? { ...stored, provider: AiProviderKind.AGENT, model: AI_AGENT_MODEL_LABEL }
  : stored;
const ai = settings.provider === AiProviderKind.AGENT
  ? this.deps.createAgentProvider(visualizationId)
  : this.deps.createProvider(settings);
```

`createAgentProvider` is a new dependency (default `new AgentAiProvider({ visualizationId })`). The `advance(… PREPARING …)` patch writes `settings.provider` / `settings.model`, so an agent run stays `agent`. The preparing console gains one info line for agent runs: "AI work is done by the Claude Code session that started this run."

In the run's `finally`, for agent runs: `cancelOpen(visualizationId, "The run ended")` (best effort, logged on failure).

`harness-generation-service.ts`: concurrency `agent` → `HARNESS_CONCURRENCY_AGENT` (4). The first-call-alone rule stays (harmless).

### 9.3 Remove

`VisualizationsService.remove` deletes the run's `agent_ai_requests` rows (visualizations are soft-deleted, so the FK cascade does not fire, and the prompts hold source code) and `<dataDir>/agent-requests/<visualizationId>/`, best effort like the snapshot folder.

## 10. Skill driver (17b)

### 10.1 Commands

```
prvision-run.mjs [run] [--path <dir>] [--source auto|working|branch] [--base <ref>] [--limit <n>] [--ai agent|settings] [--no-open]
prvision-run.mjs wait <visualizationId> [--no-open]
prvision-run.mjs continue <visualizationId> --limit <n> [--no-open]
prvision-run.mjs answer <requestId> <answer.json>
prvision-run.mjs fail <requestId> <message>
```

- `--ai` defaults to `agent`. `settings` uses PRVision's configured provider (the previous behaviour, without switching any setting).
- `run`: as before (start Docker if needed, find or register the repository, choose the source), creates the run with `aiProvider: "agent"` unless `--ai settings`, prints the run URL, opens it unless `--no-open`, then enters the loop.
- `wait` and `continue` enter the same loop. The browser is opened only by `run`, and by `continue` unless `--no-open`.

### 10.2 Loop

Every 3 s:

1. `GET /api/visualizations/:id`. Terminal → report (§10.5) and exit 0 (completed) or 1. `awaiting_confirmation` → print the paused report and exit 2.
2. `POST …/agent-requests/claim`. When it returns requests: write each to `<os.tmpdir()>/prvision-agent/<visualizationId>/<requestId>/`, print the hand-off block (§10.3) and exit 3.
3. Otherwise print status changes only and continue. Overall deadline 90 minutes (exit 1).

### 10.3 Hand-off files

Per request folder:

- `task.md`: what PRVision needs (purpose, component if known from the prompt), the rules below, then `## System instructions` (the request's system text), `## Request` (the prompt), `## Images` (absolute paths, if any), and the exact answer command.
- `schema.json`: the JSON schema.

Rules written into `task.md`:

1. The answer is one JSON object that matches `schema.json`. Write it to `answer.json` in this folder.
2. A string value that is exactly `@file:<path>` is replaced by that file's contents (path relative to this folder or absolute). Put harness sources and mock modules in their own files this way.
3. Submit with `node ~/.claude/skills/prvision/prvision-run.mjs answer <id> <folder>/answer.json`. On validation errors fix `answer.json` and submit again. If the request cannot be answered, run `… fail <id> "<reason>"`.
4. Do not edit the user's repository. Reading it is allowed and encouraged.

Exit-3 output:

```
[prvision] 3 AI request(s) for run 57 need answers:
  #101 harness   /tmp/prvision-agent/57/101
  #102 harness   /tmp/prvision-agent/57/102
  #103 harness   /tmp/prvision-agent/57/103
Answer each (one subagent per folder: read task.md), then run: node ~/.claude/skills/prvision/prvision-run.mjs wait 57
```

### 10.4 `SKILL.md`

Triggers: "use prvision", "run prvision", "show me the changes in prvision", "visualize my changes". Flow for the session:

1. Run `prvision-run.mjs` in the background. Tell the user the run URL as soon as it is printed.
   While the run prepares, ask which model answers the requests (AskUserQuestion: same as this chat, Opus, Sonnet, Haiku) unless the user named one; every subagent of the run is spawned with that model.
2. On exit 3: spawn one background subagent per folder with the prompt in §10.4.1, then run `wait <id>` in the background straight away (more requests appear while subagents work).
3. Repeat until exit 0, 1 or 2. Exit 2: ask the user how many components to render, then `continue`.
4. On exit 0: send the link, then two or three lines on what changed and anything that looks wrong (read the `diff` PNGs of risky or failed components).

#### 10.4.1 Subagent prompt (verbatim template)

```
You are answering one AI request for PRVision, a tool that renders UI components before and after a change.
Read <folder>/task.md and do exactly what it says. Your answer is a JSON object matching <folder>/schema.json.
Put long code in separate files and reference them with "@file:<name>" string values.
Submit with: node ~/.claude/skills/prvision/prvision-run.mjs answer <id> <folder>/answer.json
If it prints validation errors, fix answer.json and submit again until it is accepted.
You may read files in <repository path> for context. Do not modify them.
Reply with one line: "accepted #<id>" or "failed #<id>: <reason>".
```

### 10.5 Report

Unchanged from the first skill version (summary, components by risk with base/head/diff paths, unchanged components collapsed), plus `AI: Claude Code session, N calls` for agent runs.

## 11. Frontend (17c)

`providerLabel("agent")` returns `"Claude Code session"`. Nothing else: the provider is shown on the run summary line, and console events already explain waiting.

## 12. Configuration constants (`ai.config.ts`)

| Constant | Value |
|---|---|
| `AI_AGENT_MODEL_LABEL` | `"agent"` |
| `HARNESS_CONCURRENCY_AGENT` | `4` |
| `AGENT_REQUEST_POLL_MS` | `1_000` |
| `AGENT_REQUEST_CLAIM_TIMEOUT_MS` | `600_000` (10 min) |
| `AGENT_REQUEST_ANSWER_TIMEOUT_MS` | `1_800_000` (30 min) |
| `AGENT_CLAIM_MAX` | `20` |
| `AGENT_FAIL_MESSAGE_MAX_CHARS` | `2_000` |

`app.config.ts`: `AGENT_REQUESTS_DIR_NAME = "agent-requests"`.

## 13. Errors, edge cases, security

- The session is closed mid-run: requests stay `claimed` until the answer timeout; those components fail; the summary request is never claimed → config error → run `failed` with the message of §7.2. Re-running the skill starts a new run.
- Two sessions `wait` on the same run: the atomic claim gives each request to one of them.
- A late answer after cancel → 409; the driver prints it and the subagent stops.
- Prompts contain the user's source code. They stay on the machine: in Postgres, under the data dir, and in the OS temp folder written by the driver (mode `0700` folder). Nothing is sent anywhere by PRVision.
- The API binds `127.0.0.1` with the Host and Origin guards (00 §14.5); a browser page cannot answer requests (state-changing requests with a foreign `Origin` are rejected).
- A crafted answer is only data: it passes the same harness validator and render sandbox as model output.

## 14. Tests

Backend unit tests (no database; fakes for the store):

- `tests/backend/utilities/agent-provider.test.ts`: answered → data, usage `calls: 1`, model label; invalid stored answer → `invalid_output`; failed → `refusal` with the message; cancelled → `aborted`; claim timeout → `config` and the row cancelled; answer timeout → `network`, not retryable; abort while waiting → `aborted` and row cancelled; images written as `<id>-<n>.png` and paths stored; `connection_test` → `config`.
- `tests/backend/services/agent-requests-service.test.ts`: claim returns rows and an empty array; list order; answer valid → answered; schema mismatch → 400 with messages; answer on cancelled → 409; unknown id → 404; fail sets message; visualization missing → 404.
- `tests/backend/services/visualizations-service.test.ts`: create with `aiProvider: "agent"` skips readiness and stores `agent`/`agent`; without it readiness still runs.
- `tests/backend/dtos/*`: create DTO rejects `aiProvider: "claude_code"`; settings DTO rejects `agent`; answer DTO requires an object; fail DTO trims and caps.
- Worker test: an `agent` row builds the agent provider (fake) and writes `ai_provider = agent` on preparing; open requests are cancelled in `finally`.
- Harness generation: concurrency for `agent` is `HARNESS_CONCURRENCY_AGENT`.

Frontend: `labels.util.spec.ts` case for `agent`.

Manual: `npm run skill:install`; in a project with a UI change, say "use prvision"; the session gets a link, subagents answer, the run completes with images and a summary; cancel a run from the UI while requests are open → the driver exits 1 and late answers get 409.

## 15. Acceptance criteria

- [ ] Every file in §5 exists with the stated responsibility; migration, schema and models committed together; `drizzle:drift` and `models:drift` clean.
- [ ] `PUT /api/settings` rejects `agent`; `POST /api/visualizations` accepts `aiProvider: "agent"` with no key and no CLI.
- [ ] An agent run with no session fails within `AGENT_REQUEST_CLAIM_TIMEOUT_MS` of its first AI call, with the §7.2 message.
- [ ] Answers are validated by the API (400 with messages) and again by the provider.
- [ ] The skill completes a run end to end on the fixture repository and prints the link.
- [ ] `npm run verify` passes.

## 16. Contract changes requested (applied to 00 as Revision 11, §23)

1. **00 §5:** `AiProviderKind` gains `AGENT: "agent"`; new `SELECTABLE_AI_PROVIDER_KINDS` (`anthropic_api`, `claude_code`); new enum `AgentRequestStatus`; `Table.AGENT_AI_REQUESTS`.
2. **00 §6 / §14.3:** migration `0010` adds table `agent_ai_requests` (§6.2) and regenerates the `ai_provider` CHECKs of `app_settings` and `visualizations` with `agent`.
3. **00 §4:** new data-dir path `<dataDir>/agent-requests/<visualizationId>/` (summary images of agent requests; deleted with the run).
4. **00 §8:** `AiProvider.kind` is `"anthropic_api" | "claude_code" | "agent"`.
5. **00 §9 / §14.4:** routes and shapes of §8. `VisualizationCreateRequest` gains `aiProvider?: "agent"`. `SettingsUpdateRequest.aiProvider` stays `"anthropic_api" | "claude_code"`.
6. **00 §14.8:** `ai.config.ts` constants of §12; `app.config.ts` `AGENT_REQUESTS_DIR_NAME`.
