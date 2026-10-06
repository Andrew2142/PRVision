# 14 — Testing, Fixtures and QA

Owner: build agent (two passes)
Build waves: **wave 2** delivers the shared test helpers (section 5.4), the test preload, `tests/fixtures/`, the frontend test helpers (`frontend/src/testing/`) and `tools/create-fixture-repo.mjs`. **Wave 6** delivers the integration suite (section 5.8), audits every sheet's own test list against the catalogue (sections 5.6 and 5.9), consolidates per-area helpers onto the shared ones, fills gaps, and runs the manual QA checklist (section 5.11).
Status: implementation-ready. Conforms to `00-overview-and-contracts.md` (Revision 2, section 14 — in particular §14.10 and §14.12) and to sheet 01 §5.15 (testing standards).

How this sheet relates to the other sheets' test sections: sheets 03–13 each contain their own "Tests" section with file names and named cases. **Those lists are authoritative for their own files**; this sheet does not restate them. Sections 5.6 and 5.9 list, per sheet, the files that sheet owns and the **additional cross-cutting cases** this sheet requires (fixture cross-checks, user-clone safety, secret-leak checks, exhaustive matrices). Where two sheets disagree, tests follow 00 §14 first and then the sheet that owns the behaviour; disagreements still open are recorded in section 11.

---

## 1. Purpose

Give PRVision one coherent, local-only quality system:

1. A **test pyramid** where fast, deterministic `node:test` service tests are the primary safety net, integration tests that touch Chromium, Vite and real AI are opt-in behind environment flags, and a written manual E2E checklist covers what automation cannot.
2. A **shared helper kit** so every sheet writes tests the same way (Uply-v2 patching style, in-memory `QueryHandler`, temp git repos, generated PNGs, scripted AI, console recorder).
3. A **complete test catalogue** for sheets 03–13 that a wave-6 agent can audit mechanically.
4. A **deterministic fixture repository** (`<dataDir>/fixtures/sample-react-app`) that exercises every pipeline path: style change, added component, markup change, hook change propagating to a parent, CSS module change, render failure, zero visual change and dependency drift.
5. Clear policies for determinism, flakiness, cleanup and performance budgets.

## 2. Scope / Out of scope

In scope:

- The test scripts this sheet adds to root and backend `package.json` (sheet 02 owns the files and already ships `test`, `test:backend`, `test:frontend`, backend `test:watch`/`test:it` and the frontend `test`/`test:watch` pair; sheet 12 owns the frontend scripts afterwards) and the backend test preload `tests/backend/helpers/setup.ts` (replaces 02's placeholder, 02 §6.10.5).
- Shared helpers in `tests/backend/helpers/` other than the three sheet 04 owns (`test-context.ts`, `git-fixtures.ts`, `http.ts`); two small additions to `test-context.ts` (section 5.4.3).
- `tests/backend/test-support/**` (self-tests of the helpers) and `tests/backend/tools/**` (fixture script test).
- `tests/backend/integration/{render,pipeline,ai}/**` (gated integration suite) and `tests/backend/integration/helpers/**`.
- `tests/fixtures/harnesses/**`, `tests/fixtures/ai/**` and `tests/fixtures/README.md` (static fixture data: harness responses for the sample app, AI response samples). `tests/fixtures/harness/` (singular: 09's Example A/B sources) belongs to sheet 09.
- `tools/create-fixture-repo.mjs` and `tools/fixture-repo/sample-app-files.mjs` with the complete sample app source.
- Frontend test helpers: `frontend/src/testing/**`. (The headless browser comes from 02's `frontend/scripts/karma-chrome.mjs`, which points `CHROME_BIN` at Playwright's Chromium; this sheet adds no Karma config.)
- The cross-cutting test catalogue for sheets 03–13 (additions on top of each sheet's own list).
- Manual E2E QA checklist, determinism/flakiness policy, cleanup policy, performance budgets.

Out of scope:

- Any CI pipeline (PRVision is CI-less by decision; all commands are local).
- Automated browser E2E of the Angular UI (Playwright against the UI). The UI is covered by Karma unit tests plus the manual checklist. A scripted UI E2E is post-prototype.
- Load testing, multi-user scenarios, Windows.
- Re-specifying test cases that other sheets already list.
- Visual regression of PRVision's own UI.

## 3. Dependencies

Sheets: 00 (contracts), 01 (§5.15 testing standards, Node and module-system decisions), 02 (package.json ownership, ESLint/Prettier scope must include `tests/**`), 03–13 (behaviour under test and their own test lists), 04 (owner of `test-context.ts`, `git-fixtures.ts`, `http.ts`, `QueryHandler` API used by the in-memory stub).

Contracts used from sheet 00: section 4 (paths, ports, env, fixture path), 5 (enums), 6 (tables), 7 (module map), 8 (`PreparedWorkspace`, `ComponentCandidate`, `ChangeAnalysisResult`, `HarnessGenerationResult`, `RenderSideResult`, `ComponentRenderResult`, `ImageDiffResult`, `StructuralChange`, `AiStructuredRequest`, `AiProvider`, `AiProviderError`, `PipelineContext`), 9 (routes, view shapes), 10 (queue names, job id, cancel key), 11 (stage order), 12 (frontend routes and polling intervals), and **section 14, which overrides all of them**: 14.2 (wire envelope, complete `error_reason` list), 14.3 (`failed_stage`, `change_reason`, `skip_reason`; relative image paths; `visual_change = null`; `component_count`/`changed_count` semantics), 14.4 (API shapes and status codes), 14.6 (queue processor `{ visualizationId, jobId, signal }`, string `signal.reason`), 14.7 (pipeline signatures), 14.8 (`ArtifactStore`, `GitClient`, `SettingsStore`), 14.10 (testing contracts, fixture branches, Tailwind v4 colours), 14.12 (HTTP status per reason, positional `PipelineStepError`, test-only env vars, config evaluated once at import).

Contracts used from other sheets:

- 04: `QueryHandler` method list and `Conditions`/`Where`/`SelectManyOptions` (04 §8.3–8.5), `QueryHandlerError`, `ModelHandler.hydrate`, `AuthContext.runAsLocalUser` and `LOCAL_USER` (04 §7.1–7.2), `ArtifactStore` with the 00 §14.8 names (`componentDir`, `ensureComponentDir`, `componentImagePath`, `read`, `write`, `removeVisualization`, `toPublicUrl`, `resolveSafe`; constructor `new ArtifactStore(dataDir)`), `QueueService`, `VisualizationJob` and `jobAbortReason` (04 §9.4), `PipelineStepError(stage, userMessage, { cause?, detail?, code? })` (04 §10), `logTestStream` (04 §9.10), `collectConfigValidationErrors(overrides)` (04 §6.2), `Encryption.setKeyForTesting` (04 §9.9), test helpers `test-context.ts`, `git-fixtures.ts`, `http.ts` (04 §14.1).
- 03: `getTableSchema`, `tableHasColumn(tableSchema, property)`, `supportsSoftDelete(table)` (03 §7.2) and the column defaults in `schema.ts`.
- 05: `SettingsStore` (`readGithubToken()`, `readAiSettings()`), `AiProviderFactory.readiness(settings)` / `create(settings)` (pure), `JsonSchemaValidator`, `AnthropicStreamFn` / `AgentQueryFn` injection points, the `verifyGithubToken` dependency of `SettingsService`.
- 06: `GitHubRestPort`, `GitHubClient.verifyToken(token, { signal })` (never throws) and `GitHubClient.gitAuthHeaders(token)`.
- 07: `VisualizationWorkerService` dependencies and `PipelineStepFactories` (07 §5.9.2–5.9.3), the state machine.
- 08: `ComponentSourceQueries` (08 §5.1.1), test helpers `makeWorktrees`/`stubGitClient`/`stubPersistence`/`makeContext`, propagation and ranking rules (seeds from changed non-component exports and stylesheets only, nearest component importer, depth ≤ 3, `MAX_PARENTS_PER_MODULE = 2`, rank order 08 §5.12, `MAX_COMPONENTS = 12`), reason texts (08 §5.11.4).
- 09: `HarnessAiResponse`, `HarnessValidator(queries, fileExists).validate(input)` and its issue codes, harness directory `.prvision-harness/components/`, `targetImportPath`, `new HarnessGenerationService(ctx, sourceQueries)`, `repairHarness(componentId, previous, renderError)` returning `HarnessRepairOutcome` without persisting, `AiUsageRecorder` (only writer of `ai_usage`).
- 10: `new RenderService({ repairHarness }).renderAll(ctx, inputs)` and `buildRenderInputs(candidates, harnesses, changedFiles)` (10 §5.13.1), the repair rule (00 §14.7: one-side failure of a two-sided component is `partial`, never repaired), its render stubs.
- 11: `ImageDiffService.diff(ctx, renders)`, `StructuralDiffService.compare(ctx, { renders, diffs, analysis })`, `SummaryService.summarize(ctx, analysis)`, fixed summary texts (11 §5.4.7).

Tooling (dev only). Sheet 02 already ships `ts-node`, `pngjs`, `@types/pngjs` and Playwright; this sheet adds only `c8`:

| Package | Where | Version | Why |
|---|---|---|---|
| `ts-node` | backend devDeps (02) | `^10.9.2` | `-r ts-node/register/transpile-only` (sheet 01 §5.15) |
| `pngjs` | backend deps (02; sheet 11 needs it) | `^7.0.0` | PNG fixtures |
| `@types/pngjs` | backend devDeps (02) | `^6.0.5` | types |
| `c8` | backend devDeps (**added by this sheet**) | `^10.1.3` | `npm run test:coverage` |
| Playwright Chromium | already required by sheet 10 | — | integration render tests; Karma browser via 02's `karma-chrome.mjs` |
| Karma + Jasmine | frontend devDeps (02/12) | as Uply | frontend unit tests |

Runtime requirements: Node `>=22.12` (sheet 01: `require(esm)` for ESM-only deps and `node --test` glob support; `.nvmrc` 24), git `>=2.31` (sheet 04), Docker only for sheet 03's `migrations.integration.test.ts`.

## 4. File inventory

Every file this sheet creates, with responsibility. Paths are relative to the PRVision root.

```text
tools/
  create-fixture-repo.mjs                    CLI: creates/repairs/resets <dataDir>/fixtures/sample-react-app (5.10)
  fixture-repo/sample-app-files.mjs          pure data: FIXTURE_VERSION, MAIN_FILES, BRANCHES, WORKING_TREE_EXTRAS (importable by tests)
  fixture-repo/sample-app-files.d.mts        type declarations for the above

backend/.c8rc.json                           coverage config (informational floor)

tests/backend/helpers/                       (04 owns test-context.ts, git-fixtures.ts, http.ts)
  setup.ts                                   preloaded by the test scripts (replaces 02's placeholder): env defaults, isolated data dir, stale-temp sweep, network guard
  network-guard.ts                           blocks non-loopback fetch/http(s) in unit tests
  query-handler-stub.ts                      InMemoryQueryHandler implementing 04's QueryHandler API + installQueryHandlerStub
  temp-dir.ts                                makeTempDir / useTempDataDir (a temp dir for constructor injection) with t.after cleanup
  temp-git-repo.ts                           shared real-git sandbox: branches, dirty trees, bare origin, PR refs, snapshots
  png-fixtures.ts                            shared PNG builders (PNG objects, as sheet 11 expects) + encode/read/write/pixelAt/noise
  ai-provider-stub.ts                        ScriptedAiProvider (scripted data, errors, refusal, invalid output, hang)
  ai-sdk-fakes.ts                            fake AnthropicStreamFn and AgentQueryFn (sheet 05 injection points)
  console-recorder.ts                        ConsoleRecorder (PipelineContext.console) + recordLogger()
  fake-redis.ts                              in-memory Redis subset (get/set EX/del/exists/ttl)
  fake-queue.ts                              FakeQueue recording BullMQ add/getJob/remove + makeJob() (04 VisualizationJob with string abort reasons)
  fake-github-port.ts                        fake GitHubRestPort (sheet 06) + raw PR payload builders + HTTP error builder
  pipeline-context.ts                        createPipelineContext() for pipeline step tests
  factories.ts                               row/model builders for settings, repositories, visualizations, components

tests/backend/test-support/                  self-tests of the helpers (section 9)
tests/backend/tools/create-fixture-repo.test.ts

tests/backend/integration/helpers/
  it-flags.ts                                itSkip("render" | "ai") gating
  fixture.ts                                 requireFixtureRepo(), cloneFixture(t)
  it-pipeline.ts                             runPipelineInProcess(): real git/analysis/render/diff + in-memory QueryHandler + scripted AI
tests/backend/integration/render/*.test.ts   section 5.8
tests/backend/integration/pipeline/*.test.ts section 5.8
tests/backend/integration/ai/*.test.ts       section 5.8

tests/backend/pipeline/change-analysis/fixture-branches.test.ts   cross-check of 08 against the fixture (5.6.6)
tests/backend/harness/fixture-harnesses.test.ts                   09 validator accepts every tests/fixtures harness (5.6.7)
tests/backend/visualizations/user-clone-safety.integration.test.ts  real-git safety for all three sources (5.6.5)

tests/fixtures/
  harnesses/sample-react-app/*.json          known-good HarnessAiResponse objects for fixture components (scripted AI)
  ai/*.json                                  sample AI outputs (valid, invalid, edge cases)
  README.md                                  what lives here; never put real secrets here

frontend/src/testing/
  api-service.mock.ts                        jasmine-spy ApiService mock (Uply pattern)
  view-builders.ts                           builders for every 00 §9 + §14.4 view shape

frontend/src/app/app.routes.spec.ts          route-table spec (5.9 additions); the other 5.9 additions go into 12/13's spec files
```

Per-area helpers that other sheets declared (05's `tests/backend/helpers/{fake-anthropic-stream,fake-agent-query}.ts`, `tests/backend/visualizations/helpers/{fakes,temp-git-repo}.ts` (07), `tests/backend/repositories/helpers/detection-fixture.ts` (06), `tests/backend/pipeline/change-analysis/helpers/worktree-fixture.ts` (08), `tests/backend/pipeline/diff-summary/helpers/png-fixtures.ts` (11), 09's `tests/backend/harness/helpers/{fake-ai-provider,fake-source-queries,temp-worktrees}.ts`, 10's `tests/backend/render/helpers/{render-stubs,fake-vite-package}.ts`) stay owned by those sheets. In wave 6 they are reduced to thin wrappers or re-exports of the shared helpers where the behaviour overlaps (one implementation of temp git repos, PNG builders, console recording, scripted AI and in-memory `QueryHandler`); their exported names do not change, so their tests are untouched.

---

## 5. Detailed design

### 5.1 Test strategy and pyramid

```text
                 ┌───────────────────────────────┐
  L3  manual     │ E2E QA checklist (5.11)       │  after waves 5/6 and big merges, ~60 min
                 ├───────────────────────────────┤
  L2  gated      │ integration (5.8)             │  PRVISION_IT_RENDER=1 (default in test:it;
                 │ real Vite + Chromium, real    │    PRVISION_INTEGRATION=1 also enables it)
                 │ git, optional real AI / DB    │  PRVISION_IT_AI=1 (opt-in, costs tokens)
                 │                               │  PRVISION_TEST_DATABASE_URL (sheet 03 DB tests)
                 ├───────────────────────────────┤
  L1  unit       │ node:test service tests       │  npm test (backend + frontend) — the primary safety net
                 │ (5.6) + Karma specs (5.9)     │  < 60 s backend, < 90 s frontend
                 ├───────────────────────────────┤
  L0  static     │ tsc strict, ESLint, Prettier, │  sheet 02 (`npm run verify`)
                 │ architecture + drift checks   │
                 └───────────────────────────────┘
```

Rules for choosing a layer:

| Behaviour | Layer | Why |
|---|---|---|
| Validation, mapping, state transitions, error mapping, ranking, diff maths, schema validation | L1 with stubs | pure logic, must be exhaustive |
| Anything that shells out to git | L1 with a real temp repo in `os.tmpdir()` (04's `git-client.test.ts`, 07's `workspace-prepare.integration.test.ts`, 08's optional `change-source.git.test.ts`, this sheet's files; each skips when `git --version` fails) | real git is fast (≈20–60 ms per repo) and far more faithful than a stub |
| Code that talks to Postgres | L1 via `InMemoryQueryHandler` / patched `QueryHandler`; real Postgres only in sheet 03's `migrations.integration.test.ts` (`PRVISION_TEST_DATABASE_URL`) | Uply style; DB never needed for `npm test` |
| Code that talks to Redis/BullMQ | L1 via `FakeRedis` / `FakeQueue` / patched `QueueService` statics (04) | no Redis in unit tests |
| GitHub | L1 via fake `GitHubRestPort` (06) or an injected `verifyGithubToken` (05); L3 manual for a real PR | no network in unit tests, no GitHub IT |
| AI providers | L1 via injected `streamFn` / `queryFn` fakes (05) and `ScriptedAiProvider` for consumers; L2 `PRVISION_IT_AI=1` | AI is slow, costly, non-deterministic |
| Vite + Chromium rendering | L1 orchestration with sheet 10's `render-stubs.ts`; L2 (10's `tests/backend/integration/render-engine.integration.test.ts` and 5.8) for real pixels | real rendering takes seconds |
| Angular services, interceptors, polling, component logic | L1 Karma | |
| Full UI flows, real PRs, worker crashes | L3 manual | |

Pyramid targets (approximate counts at the end of wave 6): L1 backend ≥ 450 test cases (the sheets' own lists already exceed 400), L1 frontend ≥ 250 specs, L2 ≈ 16 tests, L3 = 20 scenarios.

### 5.2 Commands

All commands run from the PRVision root unless stated. Nothing requires CI. Root `npm test` is sheet 02's: backend suite, then the frontend suite.

| Command | What it runs | Needs |
|---|---|---|
| `npm test` | `npm run test:backend && npm run test:frontend` (02 §6.3) | Node 22.12+, git, Chrome or Playwright Chromium |
| `npm run test:backend` (= `npm test --prefix backend`) | backend suite: every `tests/backend/**/*.test.ts`; integration files self-skip unless their flag is set | Node 22.12+, git |
| `npm run test:frontend` (= `npm test --prefix frontend`) | Karma single headless run through 02's `scripts/karma-chrome.mjs --watch=false` | Chrome or Playwright Chromium |
| `npm run test:it` | `tests/backend/integration/**` plus every `*.integration.test.ts` (07 real-git, 14 user-clone safety, 03 DB when its URL is set), with `PRVISION_IT_RENDER=1` unless set to `0` | fixture created (`npm run fixture:create`), Playwright Chromium |
| `PRVISION_IT_AI=1 npm run test:it` | also the real-AI tests | credentials in env (5.8) |
| `PRVISION_IT_RENDER=0 PRVISION_IT_AI=1 npm run test:it` | only the AI tests | |
| `PRVISION_TEST_DATABASE_URL=postgres://prvision:prvision@127.0.0.1:5433/prvision_test npm run test:backend` | also sheet 03's real-Postgres tests | `docker compose up -d postgres`, a `*_test` database |
| `npm run test:coverage` | backend unit suite under c8 → `coverage/backend/index.html` | |
| `npm test --prefix backend -- --test-name-pattern="WorkspacePrepare"` | subset by test name (node:test flag) | |
| `npm run test:watch --prefix backend` / `npm run test:watch --prefix frontend` | watch modes (02) | |
| `npm run fixture:create` / `fixture:recreate` / `fixture:reset` | section 5.10 | git, npm |

Script values. Sheet 02 owns root and backend `package.json` and already defines `test`, `test:backend`, `test:frontend`, `fixture:create` (root) and `test`, `test:watch`, `test:it` (backend, 02 §6.9.1). This sheet adds only the entries marked **new**; the others are restated so the whole test surface is visible in one place.

Root `package.json` (02 §6.3):

```json
{
  "scripts": {
    "test": "npm run test:backend && npm run test:frontend",
    "test:backend": "npm run test --prefix backend",
    "test:frontend": "npm run test --prefix frontend",
    "test:it": "npm run test:it --prefix backend",
    "test:coverage": "npm run test:coverage --prefix backend",
    "fixture:create": "node tools/create-fixture-repo.mjs",
    "fixture:recreate": "node tools/create-fixture-repo.mjs --force",
    "fixture:reset": "node tools/create-fixture-repo.mjs --reset"
  }
}
```

New: `test:it`, `test:coverage`, `fixture:recreate`, `fixture:reset`.

`backend/package.json` (02 §6.9.1; sheet 01 §5.15 command with the preload and force-exit):

```json
{
  "scripts": {
    "test": "node --test --test-reporter=spec --test-concurrency=1 --test-force-exit -r ts-node/register/transpile-only -r ../tests/backend/helpers/setup.ts \"../tests/backend/**/*.test.ts\"",
    "test:watch": "node --test --watch --test-concurrency=1 -r ts-node/register/transpile-only -r ../tests/backend/helpers/setup.ts \"../tests/backend/**/*.test.ts\"",
    "test:it": "PRVISION_IT_RENDER=${PRVISION_IT_RENDER:-1} node --test --test-reporter=spec --test-concurrency=1 --test-force-exit --test-timeout=900000 -r ts-node/register/transpile-only -r ../tests/backend/helpers/setup.ts \"../tests/backend/integration/**/*.test.ts\" \"../tests/backend/**/*.integration.test.ts\"",
    "test:coverage": "c8 npm test"
  }
}
```

New: `test:coverage` (plus the `c8` devDependency and `backend/.c8rc.json`, 5.2.1). `test:it` is exactly 02's value: the only render gates are `PRVISION_IT_RENDER` and the umbrella `PRVISION_INTEGRATION` (00 §14.10); `PRVISION_RENDER_IT` does not exist and nothing sets or reads it.

Notes:

- `--test-concurrency=1` is mandatory: tests patch prototypes (`QueryHandler.prototype`, static members) the Uply way, so files must not run in parallel.
- `-r ../tests/backend/helpers/setup.ts` is resolved against the backend directory (npm runs scripts there) and is compiled by ts-node, which is registered first. Child test processes inherit the `-r` flags.
- `--test-force-exit` ends the run even if a test leaks a handle; such leaks are still bugs (fakes expose open counts to find them).
- npm runs scripts with `sh`, so `${PRVISION_IT_RENDER:-1}` works on Linux and macOS (D12).
- If sheet 02 adds `tsconfig-paths` aliases, add `-r tsconfig-paths/register` after ts-node in all four backend scripts.
- Type checking of tests needs nothing from this sheet: `npm run typecheck` uses `backend/tsconfig.eslint.json`, whose `include` already covers `../tests/backend/**/*.ts` (01 §5.2.1). There is no `tsconfig.test.json`. Files this sheet adds outside `tests/backend` (`tools/**/*.mjs`) are plain ESM JavaScript and are covered by `sample-app-files.d.mts` where tests import them.

`frontend/package.json` (02 §6.11.1, owned by 12 afterwards): `"test": "node scripts/karma-chrome.mjs --watch=false"` is the single headless run (00 §14.10) and `"test:watch": "node scripts/karma-chrome.mjs"` keeps watch mode. Extra Karma flags pass through the wrapper, so frontend coverage is `npm test --prefix frontend -- --code-coverage` (no separate script needed).

#### 5.2.1 `backend/.c8rc.json`

```json
{
  "all": true,
  "include": ["src/**/*.ts"],
  "exclude": ["src/database/migrations/**", "src/models/**", "src/**/*.d.ts", "src/app.ts", "src/worker.ts"],
  "reporter": ["text-summary", "html"],
  "reports-dir": "../coverage/backend",
  "check-coverage": true,
  "lines": 75,
  "functions": 75,
  "branches": 65
}
```

The global floor is deliberately modest; the per-area targets in 5.3 are review targets checked during the wave-6 audit by reading the HTML report. `coverage/` is gitignored (02 §6.16).

#### 5.2.2 Karma browser

Nothing to add. Sheet 02's `frontend/scripts/karma-chrome.mjs` (02 §6.11.4) points `CHROME_BIN` at the Chromium that `npm run setup` installed through Playwright when `CHROME_BIN` is unset, falls back to a system Chrome otherwise, and runs `ng test --browsers=ChromeHeadless`. This sheet does not create `frontend/karma.conf.js` (12 never rewrites 02's workspace files). Karma's Jasmine adapter already runs specs in random order by default; keep that default. Running Karma as root or in a container is out of scope (D12: developer laptops); a developer who needs it sets `CHROME_BIN` to a wrapper script that adds `--no-sandbox`.

### 5.3 Coverage expectations per area

Line coverage targets (c8 / karma-coverage), plus the non-negotiable behaviours that must have a named test regardless of percentage.

| Area | Files | Target | Must-have regardless of % |
|---|---|---|---|
| Core utilities | `encryption.ts`, `paths.ts`, `validation.ts`, `response-handler.ts`, `query-handler-drizzle.ts` (where-building), `logger.ts` | 90% | encryption tamper/wrong key; path traversal; secret redaction |
| Config validation | `config-validation.ts` | 90% | every required var; non-loopback HOST rejected; queue contract drift; test-only vars never read by `config-consts` |
| Process + git | `process.ts`, `git-client.ts` | 85% | timeout/abort kill; no shell; unsafe refs rejected before spawn; credentials via env not argv |
| Artifact store + static | `artifact-store.ts`, artifacts route | 90% | traversal (`..`, encoded, absolute, symlink) |
| Queue | `queue-service.ts` | 85% | job id `viz-<id>`, `attempts: 1`, `lockDuration` 300 000, `maxStalledCount` 0, cancel key + TTL, processor gets `{ visualizationId, jobId, signal }`, `signal.reason` is the string `"cancelled"`/`"shutdown"` |
| Settings | `settings-service.ts`, `settings-store.ts`, DTO | 90% | every secret-semantics case in 05 §9 (omitted keep, `""` clear, `null` 400); test endpoint statuses (400/429/502/504) |
| AI providers | `anthropic-api-provider.ts`, `claude-code-provider.ts`, `claude-code-result.ts`, `ai-provider-factory.ts` (`readiness`/`create`), `ai-connection-test.ts`, validator | 85% | every SDK error class and stop reason mapped (05 §9); usage attached to post-response errors |
| Repositories + detection + GitHub | 06 services and helpers, `github-client.ts` | 85% | 06's detection cases; every remote URL form; every GitHub status mapping; `verifyToken` never throws; `gitAuthHeaders` |
| Visualizations API | `visualizations-service.ts`, console service, DTOs | 90% | create validation per source type; every cancel path (200 / 202 / 409); delete 409 while non-terminal |
| Orchestrator | `visualization-worker-service.ts`, `visualization-state-machine.ts`, boot recovery | 85% | 10×10 transition matrix; `failed_stage` per stage; `changed_count` aggregate; cleanup in `finally`; boot recovery |
| Workspace prepare | `workspace-prepare-service.ts` | 80% | all 3 sources with temp repos; user clone unchanged |
| Change analysis | 08 files (`component-detector`, `export-closure`, `import-graph`, `module-resolver`, `change-source`, `component-source-queries`, service) | 90% | detection cases; propagation; ranking/cap; `change_reason`/`skip_reason`; every `ComponentSourceQueries` method; fixture cross-check |
| Harness generation | 09 files (`harness-validator`, `harness-context-builder`, prompts, service, repair, `ai-usage-recorder`) | 90% | every validator issue code; correction and repair budgets; `repairHarness` never persists |
| Render | `render-service.ts`, `vite-host-client.ts`, workspace, errors, browser helpers | 75% (unit, stubbed infra) | repair rule (one-side failure never repaired); `chooseAttempt`; cleanup on abort; render status derivation; network blocking; child env allow-list |
| Vite mock plugin | `vite-mock-plugin.ts` | 95% | every resolution case in 10 §9.1 |
| Image + structural diff | 11 diff services, `png-utils.ts` | 90% | ratios, padding bands, decode limits, every `StructuralChange` kind; never writes `changed_count` |
| Summary | `summary-service.ts`, `summary-prompts.ts` | 85% | schema validation, fixed-summary path, AI failure path, usage via `AiUsageRecorder` |
| Controllers / routes | controllers, `routes/index.ts` | route table test only | every route in sheet 00 §9 registered with the right method; error responses use the 00 §14.12 status for their `error_reason` |
| Frontend core | `core/services`, `core/interceptors`, `core/utils` | 90% | envelope unwrap; every 00 §14.2 error reason has copy; polling stop conditions |
| Frontend features | `features/**` | 70% | settings secret semantics (`""` clears, never `null`); image-compare modes; launcher error handling; detail store polling; `failedStage` stepper; cancel 200/202/409 toasts |
| Frontend shared | `shared/**` | 80% | status pill mapping for all 10 statuses |

### 5.4 Test helpers

All shared helpers live in `tests/backend/helpers/`. Test files in `tests/backend/<area>/` import backend code with `../../../backend/src/...` (one more `../` per extra folder level, sheet 01 §5.15) and helpers with `../helpers/...`. Helpers must not import from each other in cycles; `factories.ts` and `query-handler-stub.ts` may import backend enums, models and the table registry only.

Backend names used below (`AuthContext`, `LOCAL_USER`, `LocalUser`, `QueryHandler`, `Conditions`, `Where`, `SelectManyOptions`, `DeletionMode`, `Table`, `QueryHandlerError`, `getTableSchema`, `supportsSoftDelete`, `tableHasColumn`, `ErrorReason`) are defined by sheets 03/04 at the paths those sheets give. Helpers import them from there.

#### 5.4.1 `setup.ts` (preloaded)

Sheet 05 relies on "a fixed test key in the test bootstrap"; this file is that bootstrap. It replaces sheet 02's placeholder (02 §6.10.5) and keeps every value the placeholder sets except `LOG_LEVEL` (`debug` instead of `silent`, so logs reach `logTestStream`; 02 §6.7 notes this) (so 02's scaffold tests keep passing), adding the stale-temp sweep, the real-data-dir pointer and the network guard. It runs once per test-file process, before any backend module loads.

```ts
// tests/backend/helpers/setup.ts — loaded with -r before every test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installNetworkGuard } from "./network-guard";

const STALE_TEMP_MS = 2 * 60 * 60 * 1000;
const TEMP_PREFIXES = ["prvision-test-", "prvision-it-", "prvision-detect-"];

// Remember the developer's real data dir before isolating, so integration tests can find the fixture repo.
process.env.PRVISION_REAL_DATA_DIR ??= process.env.PRVISION_DATA_DIR ?? path.join(os.homedir(), ".prvision");

// Everything below must be set before the first backend import: config-consts evaluates every constant ONCE,
// when it is first imported (00 §14.12). Tests never change these values afterwards (see "Config in tests").
process.env.NODE_ENV = "test";                         // env.ts skips .env when NODE_ENV=test: tests are hermetic
// Logs are produced (so tests can assert on them) but go to logTestStream (04 §9.10, 00 §14.10), which drops
// them unless a test subscribed or PRVISION_TEST_LOG_STDOUT=1.
process.env.LOG_LEVEL ??= "debug";
// Never connected to by unit tests; present so validateConfig() passes in tests that call it.
process.env.DATABASE_URL ??= "postgres://prvision:prvision@127.0.0.1:5433/prvision_test";
process.env.REDIS_URL ??= "redis://127.0.0.1:6380/15";
// Deterministic, obviously fake 32-byte key. Never a real key.
process.env.PRVISION_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

// Unit and integration tests never touch ~/.prvision: every test file process gets its own data dir.
const sessionDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prvision-test-session-")));
process.env.PRVISION_DATA_DIR = sessionDataDir;
process.on("exit", () => {
  if (process.env.PRVISION_KEEP_TEST_ARTIFACTS === "1") {
    process.stderr.write(`[setup] kept test data dir: ${sessionDataDir}\n`);
    return;
  }
  fs.rmSync(sessionDataDir, { recursive: true, force: true });
});

// Sweep temp dirs left by crashed runs (older than 2 h). Cheap: one readdir per test file.
for (const name of fs.readdirSync(os.tmpdir())) {
  if (!TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
  const full = path.join(os.tmpdir(), name);
  try {
    if (Date.now() - fs.statSync(full).mtimeMs > STALE_TEMP_MS) fs.rmSync(full, { recursive: true, force: true });
  } catch {
    /* owned by a concurrent process or already gone */
  }
}

installNetworkGuard();
```

**Config in tests (00 §14.12, 01 §5.15).** Config constants (`DATA_DIR`, `PRVISION_SECRET_KEY`, `CHILD_PROCESS_BASE_ENV`, every limit) are evaluated **once**, when `config-consts` is first imported — after this preload — and never re-read. Mutating `process.env` inside a test therefore changes nothing (and would leak into later tests of the same file). A test that needs a different value uses one of:

- `collectConfigValidationErrors(overrides)` / `validateConfig(overrides)` for config-validation cases (04 §6.2);
- constructor options: `new ArtifactStore(tempDir)` (data dir), injected dependencies (`now`, runners, ports, `streamFn`/`queryFn`, `verifyGithubToken`, step factories);
- `Encryption.setKeyForTesting(secret)` for key rotation cases, restored with `Encryption.setKeyForTesting(null)` in `t.after`.

The only environment this sheet's helpers touch is the preload above (before any import) and the child-process `env` they pass explicitly to `execFileSync` (git sandboxes, the fixture script).

#### 5.4.2 `network-guard.ts`

```ts
// tests/backend/helpers/network-guard.ts
import http from "node:http";
import https from "node:https";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostOf(target: unknown): string | null {
  if (typeof target === "string") return new URL(target).hostname;
  if (target instanceof URL) return target.hostname;
  if (target && typeof target === "object") {
    const options = target as { hostname?: string; host?: string; url?: string };
    if (options.url) return new URL(options.url).hostname;
    return (options.hostname ?? options.host ?? "localhost").split(":")[0];
  }
  return null;
}

function assertAllowed(host: string | null, via: string): void {
  if (host === null || LOOPBACK_HOSTS.has(host)) return;
  throw new Error(`[network-guard] ${via} to "${host}" blocked in tests. Inject a fake client instead.`);
}

/** Blocks outbound non-loopback traffic unless the integration AI suite is explicitly enabled. */
export function installNetworkGuard(): void {
  // Only the real-AI integration files may reach the network, and only when the AI flag is on.
  // node:test runs each file in its own process with the file path in argv.
  const isAiIntegrationFile = process.argv.some((arg) => arg.replace(/\\/g, "/").includes("/integration/ai/"));
  if (isAiIntegrationFile && process.env.PRVISION_IT_AI === "1") return;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assertAllowed(hostOf(input instanceof Request ? input.url : input), "fetch");
    return realFetch(input, init);
  }) as typeof fetch;

  for (const [name, mod] of [["http", http], ["https", https]] as const) {
    const realRequest = mod.request.bind(mod);
    const realGet = mod.get.bind(mod);
    (mod as { request: unknown }).request = (...args: unknown[]) => {
      assertAllowed(hostOf(args[0]), `${name}.request`);
      return (realRequest as (...a: unknown[]) => unknown)(...args);
    };
    (mod as { get: unknown }).get = (...args: unknown[]) => {
      assertAllowed(hostOf(args[0]), `${name}.get`);
      return (realGet as (...a: unknown[]) => unknown)(...args);
    };
  }
}
```

The guard installs before any backend module is imported, so SDK clients that capture `fetch` at construction capture the guarded one.

#### 5.4.3 `test-context.ts` (owned by sheet 04, two additions here)

Sheet 04 §14.1 creates this file with `runWithAuthContext` (via `AuthContext.runAsLocalUser`), Uply's `patchStaticMethod`, `injectQueryHandler(service, fake)` (unimplemented methods throw `not stubbed: <name>`) and `withTempDir`. Its skeleton, restated for reference:

```ts
// tests/backend/helpers/test-context.ts (sheet 04)
import { AuthContext } from "../../../backend/src/utilities/context/auth-context";
import { LOCAL_USER, type LocalUser } from "../../../backend/src/types/local-user";

export async function runWithAuthContext<T>(callback: () => Promise<T> | T, overrides: Partial<LocalUser> = {}): Promise<T> {
  return AuthContext.runAsLocalUser(callback, { user: { ...LOCAL_USER, ...overrides } as LocalUser, requestId: "test-request" });
}

export function patchStaticMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): () => void {
  const original = target[key];
  target[key] = replacement;
  return () => { target[key] = original; };
}
// injectQueryHandler(service, fake) and withTempDir(fn) as in sheet 04 §14.1
```

Sheet 14 appends two exports (no change to 04's):

```ts
/** Patches several members of one target; returns one restore function (restores in reverse order). */
export function patchMethods<T extends object>(target: T, replacements: Partial<T>): () => void {
  const restores = (Object.keys(replacements) as Array<keyof T>).map((key) =>
    patchStaticMethod(target, key, replacements[key] as T[keyof T]),
  );
  return () => restores.reverse().forEach((restore) => restore());
}

/** Runs fn and restores every patch afterwards, even when fn throws. */
export async function withPatches<T>(restores: Array<() => void>, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
}
```

Canonical service-test shape (Uply style, unchanged):

```ts
test("RepositoriesService.remove soft-deletes only the repository row and returns 200 { id }", async () => {
  const { stub, restore } = installQueryHandlerStub();
  stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 4 })]);
  try {
    await runWithAuthContext(async () => {
      const response = await new RepositoriesService(idModel(4)).remove();
      assert.equal(response.status, 200);
      assert.deepEqual(response.data, { id: 4 });
      assert.equal(stub.row(Table.REPOSITORIES, 4)?.isDeleted, true);
    });
  } finally {
    restore();
  }
});
```

#### 5.4.4 `query-handler-stub.ts`

An in-memory fake of sheet 04's `QueryHandler` facade (04 §8.4) that mirrors `QueryHandlerDrizzle` (04 §8.5) exactly where tests can observe it:

| 04 behaviour | Stub |
|---|---|
| Methods `normalizeData` (static + instance), `insert(data, table, excludedKeys?)`, `select(conditions, table, isolateData?)` (two overloads), `update(newValues, conditions, table, excludedKeys?)`, `delete(conditions, table, mode)`, `count(conditions, table)`, `checkDuplicates(keyName, keyValue, table)`, `validateAndSelect(Model, query, table)`, `selectMany(Model, conditions, table, options?)`, static `firstInsertedId(response)` | same names, argument order and return shapes |
| `Conditions`: `undefined` ignored, `null` → `IS NULL`, scalar → `=`, `Where.*` operators (`ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `isNull`, `isNotNull`) | same, with SQL three-valued logic: a `NULL` column never matches `=`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` or `notIn` (except `notIn([])`, which is `true`); `in([])` matches nothing |
| Unknown condition, value, `orderBy` or `search` key → `QueryHandlerError` (always, before any write) | same |
| `insert`: empty array → `200 []`; rows come back with every column (DB defaults applied, missing nullable columns `null`) | same; literal Drizzle defaults, `now()` and `'[]'::jsonb` are applied; any other SQL default throws a descriptive `Error` (seed the value instead) |
| Missing `NOT NULL` value without default → pg `23502` → `400 validation_failed` | same (`insert` only; `seed` is lenient) |
| `select`/`count`/`validateAndSelect`/`selectMany` add `isDeleted = false` on soft-delete tables unless `isDeleted` is present in the conditions (own property) | same |
| `update`/`delete` with no effective condition → `400 validation_failed`, no write | same |
| `update` stamps `updatedAt` only on tables that have it; zero rows → `404 not_found` | same |
| `delete` with `SOFT` on a table without `isDeleted` **throws** `QueryHandlerError`; soft delete sets `isDeleted` + `updatedAt`; zero rows → 404 | same |
| `ApiResponse` methods never throw for DB errors; row/model methods (`select(…, true)`, `validateAndSelect`, `selectMany`) **throw** `QueryHandlerError` | `failNext(method, failure)` scripts a DB failure: `ApiResponse` methods return the scripted response (default `500 internal_error`), row/model methods throw |
| `selectMany` default order `id asc`, no default limit, `offset` default 0, `search` = case-insensitive contains | same; `NULL`s sort last ascending and first descending (Postgres) |
| Models hydrated through setters, including `null` (`ModelHandler.hydrate`) | uses the real `ModelHandler.hydrate` |

It records every call, auto-assigns ids per table, and takes an injectable clock. CHECK constraints (enum values, `failed_stage` only on failed/cancelled rows, `skip_reason` only on skipped rows, relative image paths) are **not** evaluated; sheet 03's `migrations.integration.test.ts` is the proof for those. Per-area recording stubs (07 `fakes.ts`, 09's recording stub, 11 `recordingQueryHandler`, 10's `InMemoryPersistence`) can be built on it.

```ts
// tests/backend/helpers/query-handler-stub.ts
import { getTableColumns, is, SQL, type Column } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableSchema, supportsSoftDelete, tableHasColumn } from "../../../backend/src/database/table-registry";
import { DeletionMode, ErrorReason, Table } from "../../../backend/src/enums";
import { ModelHandler } from "../../../backend/src/utilities/handlers/model-handler";
import { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { QueryHandlerError } from "../../../backend/src/utilities/handlers/query-handler-drizzle";
import { isWhereOperator, type Conditions, type SelectManyOptions, type WhereOperator } from "../../../backend/src/utilities/handlers/query-conditions";
import type { ApiResponse } from "../../../backend/src/utilities/handlers/response-handler";
import { patchStaticMethod } from "./test-context";

export type Row = Record<string, unknown> & { id: number };
export type QueryHandlerMethod =
  | "insert" | "select" | "update" | "delete" | "count" | "checkDuplicates" | "validateAndSelect" | "selectMany";
export interface RecordedCall { method: QueryHandlerMethod; table: Table; args: unknown[] }

const DB_FAILURE: ApiResponse<never> = { status: 500, error: "Internal server error", error_reason: ErrorReason.INTERNAL_ERROR };
const NO_CONDITIONS: ApiResponse<never> = { status: 400, error: "No valid conditions provided", error_reason: ErrorReason.VALIDATION_FAILED };
const NOT_FOUND: ApiResponse<never> = { status: 404, error: "Record not found", error_reason: ErrorReason.NOT_FOUND };
const NOT_NULL_VIOLATION: ApiResponse<never> = { status: 400, error: "Invalid value for database column", error_reason: ErrorReason.VALIDATION_FAILED };
const dialect = new PgDialect();
const SQL_DEFAULTS: Record<string, (now: Date) => unknown> = { "now()": (now) => now, "'[]'::jsonb": () => [] };

const columnsOf = (table: Table): Record<string, Column> => getTableColumns(getTableSchema(table)) as Record<string, Column>;
const hasColumn = (table: Table, key: string): boolean => tableHasColumn(getTableSchema(table), key);

export class InMemoryQueryHandler {
  readonly calls: RecordedCall[] = [];
  private readonly tables = new Map<Table, Row[]>();
  private readonly nextId = new Map<Table, number>();
  private readonly failures = new Map<QueryHandlerMethod, Array<ApiResponse<never> | Error>>();
  /** Injectable clock so timestamps are deterministic. */
  now: () => Date = () => new Date("2026-01-01T00:00:00.000Z");

  static firstInsertedId(response: ApiResponse<Record<string, unknown>[]>): number | null {
    const id = response.data?.[0]?.id;
    return typeof id === "number" ? id : null;
  }

  /** Test setup: inserts rows without recording a call; missing NOT NULL columns become null instead of failing. */
  seed(table: Table, rows: Array<Partial<Row>>): Row[] { return rows.map((row) => this.insertOne(table, this.checkedValues(table, row, [], "seed"), false)); }
  rows(table: Table): Row[] { return (this.tables.get(table) ?? []).map((row) => ({ ...row })); }
  row(table: Table, id: number): Row | undefined { return this.rows(table).find((row) => row.id === id); }
  callsFor(method: QueryHandlerMethod, table?: Table): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && (table === undefined || c.table === table));
  }
  /** Simulates one DB failure on the next call to `method` (after argument validation, like a real DB error). */
  failNext(method: QueryHandlerMethod, failure: ApiResponse<never> | Error = DB_FAILURE): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  normalizeData(data: object, excludedKeys: readonly string[] = []): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const prop of Object.getOwnPropertyNames(data)) {
      const clean = prop.startsWith("_") ? prop.slice(1) : prop;
      if (excludedKeys.includes(prop) || excludedKeys.includes(clean)) continue;
      const value = (data as Record<string, unknown>)[prop];
      if (value !== undefined && typeof value !== "function") out[clean] = value;   // keeps null (04)
    }
    return out;
  }

  async insert(data: Record<string, unknown> | Record<string, unknown>[], table: Table, excludedKeys: readonly string[] = []): Promise<ApiResponse<Record<string, unknown>[]>> {
    this.record("insert", table, [data, excludedKeys]);
    const prepared = (Array.isArray(data) ? data : [data]).map((input) => this.checkedValues(table, input, excludedKeys, "insert"));
    if (prepared.length === 0) return { status: 200, data: [] };
    const failure = this.responseFailure("insert"); if (failure) return failure;
    if (prepared.some((values) => this.missingNotNull(table, values))) return NOT_NULL_VIOLATION;
    return { status: 200, data: prepared.map((values) => ({ ...this.insertOne(table, values, true) })) };
  }

  async select(conditions: Conditions, table: Table, isolateData: true): Promise<Record<string, unknown>[]>;
  async select(conditions: Conditions, table: Table, isolateData?: false): Promise<ApiResponse<Record<string, unknown>[]>>;
  async select(conditions: Conditions, table: Table, isolateData = false): Promise<ApiResponse<Record<string, unknown>[]> | Record<string, unknown>[]> {
    this.record("select", table, [conditions, isolateData]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, conditions));
    if (isolateData) { this.throwingFailure("select", table); return this.match(table, effective); }
    const failure = this.responseFailure("select"); if (failure) return failure;
    return { status: 200, data: this.match(table, effective) };
  }

  async update(newValues: Record<string, unknown>, conditions: Conditions, table: Table, excludedKeys: readonly string[] = []): Promise<ApiResponse<{ rowsAffected: number }>> {
    this.record("update", table, [newValues, conditions, excludedKeys]);
    const where = this.checkedConditions(table, conditions);                        // unknown keys throw first (buildWhere)
    if (!this.hasEffectiveConditions(where)) return NO_CONDITIONS;
    const values = this.checkedValues(table, newValues, excludedKeys, "update");     // then unknown value keys throw
    const failure = this.responseFailure("update"); if (failure) return failure;
    const targets = (this.tables.get(table) ?? []).filter((row) => this.matches(row, where));
    const stamp = hasColumn(table, "updatedAt") ? { updatedAt: this.now() } : {};
    targets.forEach((row) => Object.assign(row, values, stamp, { id: row.id }));
    return targets.length > 0 ? { status: 200, data: { rowsAffected: targets.length } } : NOT_FOUND;
  }

  async delete(conditions: Conditions, table: Table, mode: DeletionMode): Promise<ApiResponse<{ rowsAffected: number }>> {
    this.record("delete", table, [conditions, mode]);
    if (mode === DeletionMode.SOFT && !supportsSoftDelete(table)) throw new QueryHandlerError(`Table ${table} does not support soft delete`, "delete", table);
    const where = this.checkedConditions(table, conditions);
    if (!this.hasEffectiveConditions(where)) return NO_CONDITIONS;
    const failure = this.responseFailure("delete"); if (failure) return failure;
    const rows = this.tables.get(table) ?? [];
    const targets = rows.filter((row) => this.matches(row, where));
    if (targets.length === 0) return NOT_FOUND;
    if (mode === DeletionMode.SOFT) targets.forEach((row) => Object.assign(row, { isDeleted: true, updatedAt: this.now() }));
    else this.tables.set(table, rows.filter((row) => !targets.includes(row)));
    return { status: 200, data: { rowsAffected: targets.length } };
  }

  async count(conditions: Conditions, table: Table): Promise<ApiResponse<{ count: number }>> {
    this.record("count", table, [conditions]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, conditions));
    const failure = this.responseFailure("count"); if (failure) return failure;
    return { status: 200, data: { count: this.match(table, effective).length } };
  }

  async checkDuplicates(keyName: string, keyValue: string | number | boolean | Date, table: Table): Promise<boolean> {
    this.record("checkDuplicates", table, [keyName, keyValue]);
    this.throwingFailure("checkDuplicates", table);
    return (await this.select({ [keyName]: keyValue }, table, true)).length > 0;    // 04 delegates to select(…, true) too
  }

  async validateAndSelect<T extends object>(ModelClass: new () => T, query: Conditions, table: Table): Promise<T | null> {
    this.record("validateAndSelect", table, [ModelClass.name, query]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, query));
    this.throwingFailure("validateAndSelect", table);
    const [row] = this.match(table, effective).sort((a, b) => a.id - b.id);         // limit 1, ordered by id
    return row ? ModelHandler.hydrate(ModelClass, row) : null;
  }

  async selectMany<T extends object>(ModelClass: new () => T, conditions: Conditions, table: Table, options: SelectManyOptions = {}): Promise<T[]> {
    this.record("selectMany", table, [ModelClass.name, conditions, options]);
    const effective = this.withSoftDeleteDefault(table, this.checkedConditions(table, conditions));
    const order = options.orderBy?.length ? options.orderBy : [{ column: "id", direction: "asc" as const }];
    for (const key of [...Object.keys(options.search ?? {}), ...order.map((o) => o.column)]) this.assertColumn(table, key, "selectMany");
    this.throwingFailure("selectMany", table);
    let rows = this.match(table, effective);
    for (const [field, needle] of Object.entries(options.search ?? {})) {
      rows = rows.filter((row) => String(row[field] ?? "").toLowerCase().includes(needle.toLowerCase()));
    }
    rows.sort((a, b) => {
      for (const { column, direction } of order) {
        const cmp = compareForOrder(a[column], b[column], direction);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
    const offset = options.offset ?? 0;
    return rows.slice(offset, options.limit === undefined ? undefined : offset + options.limit).map((row) => ModelHandler.hydrate(ModelClass, row));
  }

  // ---- internals ----
  private insertOne(table: Table, values: Record<string, unknown>, strict: boolean): Row {
    const id = (values.id as number | undefined) ?? (this.nextId.get(table) ?? 1);
    this.nextId.set(table, Math.max(this.nextId.get(table) ?? 1, id + 1));
    const row: Row = { ...this.defaultsFor(table, values, strict), ...values, id };
    this.tables.set(table, [...(this.tables.get(table) ?? []), row]);
    return { ...row };
  }

  /** Every column the caller did not provide: its Drizzle default, else null (what Postgres returns). */
  private defaultsFor(table: Table, provided: Record<string, unknown>, strict: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(columnsOf(table))) {
      if (key === "id" || key in provided) continue;
      if (column.defaultFn) { out[key] = column.defaultFn(); continue; }
      if (!column.hasDefault) { out[key] = null; continue; }
      if (is(column.default, SQL)) {
        const text = dialect.sqlToQuery(column.default as SQL).sql;
        const make = SQL_DEFAULTS[text];
        if (!make) {
          if (strict) throw new Error(`InMemoryQueryHandler cannot evaluate SQL default ${text} for ${table}.${key}; pass a value`);
          out[key] = null; continue;
        }
        out[key] = make(this.now());
        continue;
      }
      out[key] = column.default;
    }
    return out;
  }

  private missingNotNull(table: Table, values: Record<string, unknown>): boolean {
    return Object.entries(columnsOf(table)).some(([key, column]) =>
      key !== "id" && column.notNull && !column.hasDefault && !column.defaultFn && (values[key] === undefined || values[key] === null));
  }

  private checkedValues(table: Table, data: object, excludedKeys: readonly string[], operation: string): Record<string, unknown> {
    const values = this.normalizeData(data, excludedKeys);
    for (const key of Object.keys(values)) this.assertColumn(table, key, operation);
    return values;
  }

  private checkedConditions(table: Table, conditions: Conditions): Conditions {
    for (const [key, value] of Object.entries(conditions)) if (value !== undefined) this.assertColumn(table, key, "where");
    return conditions;
  }

  private assertColumn(table: Table, key: string, operation: string): void {
    if (!hasColumn(table, key)) throw new QueryHandlerError(`Unknown column "${key}"`, operation, table);
  }

  private withSoftDeleteDefault(table: Table, conditions: Conditions): Conditions {
    if (!supportsSoftDelete(table) || Object.prototype.hasOwnProperty.call(conditions, "isDeleted")) return conditions;
    return { isDeleted: false, ...conditions };
  }

  private hasEffectiveConditions(conditions: Conditions): boolean {
    return Object.values(conditions).some((value) => value !== undefined);
  }

  private match(table: Table, conditions: Conditions): Row[] {
    return (this.tables.get(table) ?? []).filter((row) => this.matches(row, conditions)).map((row) => ({ ...row }));
  }

  private matches(row: Row, conditions: Conditions): boolean {
    return Object.entries(conditions).every(([key, expected]) => {
      if (expected === undefined) return true;                                   // ignored (04)
      const actual = row[key] ?? null;
      if (expected === null) return actual === null;                             // IS NULL
      if (isWhereOperator(expected)) return evaluate(actual, expected);
      return actual !== null && compare(actual, expected) === 0;                 // NULL = x is never true
    });
  }

  private record(method: QueryHandlerMethod, table: Table, args: unknown[]): void { this.calls.push({ method, table, args }); }

  private responseFailure(method: QueryHandlerMethod): ApiResponse<never> | undefined {
    const next = this.failures.get(method)?.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  private throwingFailure(method: QueryHandlerMethod, table: Table): void {
    const next = this.failures.get(method)?.shift();
    if (next === undefined) return;
    throw next instanceof Error ? next : new QueryHandlerError(`Database ${method} failed on ${table}`, method, table);
  }
}

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  return (av as number | string) < (bv as number | string) ? -1 : 1;
}

/** Postgres ORDER BY: NULLS LAST for asc, NULLS FIRST for desc. */
function compareForOrder(a: unknown, b: unknown, direction: "asc" | "desc"): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : (an ? 1 : -1) * (direction === "asc" ? 1 : -1);
  return direction === "asc" ? compare(a, b) : -compare(a, b);
}

/** SQL semantics: any comparison with NULL is unknown (false), except notIn([]) which 04 renders as TRUE. */
function evaluate(actual: unknown, operator: WhereOperator): boolean {
  switch (operator.op) {
    case "isNull": return actual === null;
    case "isNotNull": return actual !== null;
    case "notIn": if (operator.values.length === 0) return true; break;
    case "in": if (operator.values.length === 0) return false; break;      // in([]) matches nothing (04)
    default: break;
  }
  if (actual === null) return false;
  switch (operator.op) {
    case "ne": return compare(actual, operator.value) !== 0;
    case "gt": return compare(actual, operator.value) > 0;
    case "gte": return compare(actual, operator.value) >= 0;
    case "lt": return compare(actual, operator.value) < 0;
    case "lte": return compare(actual, operator.value) <= 0;
    case "in": return operator.values.some((value) => compare(actual, value) === 0);
    case "notIn": return !operator.values.some((value) => compare(actual, value) === 0);
    default: return false;
  }
}

/** Routes every QueryHandler instance (prototype patch, incl. `new QueryHandler(tx)`) to one in-memory store. */
export function installQueryHandlerStub(stub = new InMemoryQueryHandler()): { stub: InMemoryQueryHandler; restore: () => void } {
  const methods: QueryHandlerMethod[] = ["insert", "select", "update", "delete", "count", "checkDuplicates", "validateAndSelect", "selectMany"];
  const restores = methods.map((method) =>
    patchStaticMethod(QueryHandler.prototype, method, ((...args: unknown[]) =>
      (stub[method] as (...a: unknown[]) => unknown).apply(stub, args)) as never));
  const normalize = ((data: object, excluded?: readonly string[]) => stub.normalizeData(data, excluded)) as never;
  restores.push(patchStaticMethod(QueryHandler.prototype, "normalizeData", normalize));
  restores.push(patchStaticMethod(QueryHandler, "normalizeData", normalize));
  return { stub, restore: () => restores.reverse().forEach((restore) => restore()) };
}
```

`QueryHandler.firstInsertedId` is not patched (it is pure). Alternatively pass the stub to sheet 04's `injectQueryHandler(service, stub)` to replace one service's private `queryHandler` only. SettingsStore's insert-on-conflict and upsert (05 §5.2) use direct Drizzle and bypass the stub: seed the `app_settings` row (reads go through `validateAndSelect`) or inject the `db` constructor parameter. Transactions: code that calls `DrizzleDb.transaction(tx => new QueryHandler(tx)…)` (07, 08, 11) or takes a `runInTransaction`/`createQueryHandler` dependency (08, 11) gets the patched prototype too; patch `DrizzleDb.transaction` with `async (fn) => fn({} as never)` (or inject `runInTransaction: (fn) => fn({} as never)`) so the callback runs without a database. A `failNext` inside the callback simulates a rollback only in the sense that the service sees the failure; rows written earlier in the same callback stay in the stub — assert on the service's response and calls, not on rolled-back state.

#### 5.4.5 `temp-dir.ts`

```ts
// tests/backend/helpers/temp-dir.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export function makeTempDir(label = "dir"): { path: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prvision-test-${label}-`));
  return {
    path: fs.realpathSync(dir), // macOS: /var -> /private/var; keeps path assertions stable
    cleanup: () => {
      if (process.env.PRVISION_KEEP_TEST_ARTIFACTS === "1") return;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a fresh, empty data dir for one test and removes it in t.after. It does NOT touch process.env:
 * DATA_DIR is fixed at import (00 §14.12). Pass the path to the code under test, e.g. `new ArtifactStore(dir)`.
 */
export function useTempDataDir(t: TestContext): string {
  const temp = makeTempDir("data");
  t.after(() => temp.cleanup());
  return temp.path;
}
```

Code that does not take a data dir (10's and 11's default `ArtifactStore` instances, 07's default dependencies) writes under the per-process session dir from `setup.ts`, which is already a temp dir; tests that need a pristine tree per test inject `new ArtifactStore(useTempDataDir(t))` through the owning sheet's dependency seam.

#### 5.4.6 `temp-git-repo.ts`

The shared real-git sandbox. Isolated from the developer's git config, deterministic authors and dates (so SHAs are stable within a test), LF line endings, hooks disabled. Synchronous (`execFileSync`), which test code may use (07 §9); application code never does.

Relationship to other git helpers: sheet 04's `git-fixtures.ts` (`createTempGitRepo(files)`, async, minimal, used by 04's `git-client.test.ts`) and sheet 07's `visualizations/helpers/temp-git-repo.ts` keep their names. In wave 6 both become thin adapters over this file (04's async `commit(message, files)` with `null` = delete maps to `commit(message, files, { remove })`), so there is one implementation of repo setup and isolation.

```ts
// tests/backend/helpers/temp-git-repo.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { makeTempDir } from "./temp-dir";

export type FileMap = Record<string, string>;

export interface TempGitRepo {
  readonly path: string;
  git(...args: string[]): string;
  write(files: FileMap): void;
  remove(paths: string[]): void;
  /** Writes/removes files, stages everything, commits, returns the new HEAD sha. */
  commit(message: string, files?: FileMap, options?: { remove?: string[] }): string;
  /** Creates and checks out a branch (from `from` or HEAD). */
  branch(name: string, from?: string): void;
  checkout(ref: string): void;
  /** Leaves uncommitted changes: modified/added tracked files, untracked files, deletions. */
  dirty(changes: { modify?: FileMap; untracked?: FileMap; remove?: string[]; stage?: boolean }): void;
  sha(ref?: string): string;
  /** Creates a bare repo, adds it as `origin`, pushes all branches. */
  createBareOrigin(): TempGitRepo;
  /** In a bare repo: points refs/pull/<n>/head at sha (simulates GitHub). */
  setPullRef(prNumber: number, sha: string): void;
  /** Snapshot used to prove PRVision never mutates the user's clone. */
  snapshot(): RepoSnapshot;
  cleanup(): void;
}

export interface RepoSnapshot {
  head: string; symbolicHead: string | null; status: string; branches: string; stashes: string; tags: string;
  nonPrvisionRefs: string; worktrees: string; indexHash: string;
}

export interface CreateTempGitRepoOptions {
  files?: FileMap;
  defaultBranch?: string;          // default "main"
  initialMessage?: string;         // default "initial"
  nodeModules?: boolean;           // write fake installed packages so sheet 06 detection passes (ignored via .gitignore)
  bare?: boolean;
}

const BASE_TIME = Date.parse("2026-01-01T00:00:00Z");

export function isolatedGitEnv(commitIndex = 0): NodeJS.ProcessEnv {
  const date = new Date(BASE_TIME + commitIndex * 60_000).toISOString();
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "PRVision Test", GIT_AUTHOR_EMAIL: "test@prvision.local", GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "PRVision Test", GIT_COMMITTER_EMAIL: "test@prvision.local", GIT_COMMITTER_DATE: date,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function createTempGitRepo(options: CreateTempGitRepoOptions = {}): TempGitRepo {
  const temp = makeTempDir(options.bare ? "bare" : "repo");
  const repoPath = temp.path;
  let commitIndex = 0;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repoPath, env: isolatedGitEnv(commitIndex), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();

  const write = (files: FileMap): void => {
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(repoPath, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content.replace(/\r\n/g, "\n"));
    }
  };
  const remove = (paths: string[]): void => paths.forEach((p) => fs.rmSync(path.join(repoPath, p), { recursive: true, force: true }));

  const branchName = options.defaultBranch ?? "main";
  git("init", ...(options.bare ? ["--bare"] : []), "-b", branchName);
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", "/dev/null");

  const repo: TempGitRepo = {
    path: repoPath,
    git,
    write,
    remove,
    commit(message, files = {}, commitOptions = {}) {
      write(files);
      remove(commitOptions.remove ?? []);
      git("add", "-A");
      commitIndex += 1;
      git("commit", "--no-verify", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
    branch(name, from) { git("checkout", "-b", name, ...(from ? [from] : [])); },
    checkout(ref) { git("checkout", ref); },
    dirty({ modify = {}, untracked = {}, remove: removed = [], stage = false }) {
      write(modify);
      write(untracked);
      remove(removed);
      if (stage) git("add", "-A", "--", ...Object.keys(modify));
    },
    sha(ref = "HEAD") { return git("rev-parse", ref); },
    createBareOrigin() {
      const bare = createTempGitRepo({ bare: true, defaultBranch: branchName });
      git("remote", "add", "origin", bare.path);
      git("push", "--all", "origin");
      return bare;
    },
    setPullRef(prNumber, sha) { git("update-ref", `refs/pull/${prNumber}/head`, sha); },
    snapshot() {
      const safe = (...args: string[]) => { try { return git(...args); } catch { return ""; } };
      return {
        head: safe("rev-parse", "HEAD"),
        symbolicHead: safe("symbolic-ref", "-q", "HEAD") || null,
        status: safe("status", "--porcelain=v1", "--untracked-files=all"),
        branches: safe("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
        stashes: safe("stash", "list"),
        tags: safe("tag", "--list"),
        nonPrvisionRefs: safe("for-each-ref", "--format=%(refname) %(objectname)")
          .split("\n").filter((line) => !line.startsWith("refs/prvision/")).join("\n"),
        worktrees: safe("worktree", "list", "--porcelain"),
        indexHash: fs.existsSync(path.join(repoPath, ".git", "index"))
          ? execFileSync("git", ["hash-object", path.join(repoPath, ".git", "index")], { encoding: "utf8" }).trim() : "",
      };
    },
    cleanup: temp.cleanup,
  };

  if (!options.bare) {
    write({ ".gitignore": "node_modules\ndist\n", ...(options.files ?? {}) });
    if (options.nodeModules) {
      write({
        "node_modules/react/package.json": '{ "name": "react", "version": "19.3.0" }\n',
        "node_modules/react-dom/package.json": '{ "name": "react-dom", "version": "19.3.0" }\n',
        "node_modules/vite/package.json": '{ "name": "vite", "version": "7.3.6" }\n',
      });
    }
    repo.commit(options.initialMessage ?? "initial");
  }
  return repo;
}

/** Registers cleanup on the test context. */
export function withTempGitRepo(t: TestContext, options?: CreateTempGitRepoOptions): TempGitRepo {
  const repo = createTempGitRepo(options);
  t.after(() => repo.cleanup());
  return repo;
}

/** Minimal Vite + React + TS file set that passes project detection (no install). */
export function reactViteFiles(overrides: FileMap = {}): FileMap {
  return {
    "package.json": JSON.stringify({
      name: "temp-app", private: true, type: "module",
      dependencies: { react: "19.3.0", "react-dom": "19.3.0" },
      devDependencies: { vite: "7.3.6", "@vitejs/plugin-react": "5.2.0", typescript: "5.9.3" },
    }, null, 2) + "\n",
    "package-lock.json": "{\n  \"lockfileVersion\": 3\n}\n",
    "vite.config.ts": "import { defineConfig } from \"vite\";\nimport react from \"@vitejs/plugin-react\";\nexport default defineConfig({ plugins: [react()] });\n",
    "tsconfig.json": "{\n  \"compilerOptions\": { \"jsx\": \"react-jsx\", \"strict\": true }\n}\n",
    "index.html": "<!doctype html><html><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>\n",
    "src/main.tsx": "import { createRoot } from \"react-dom/client\";\nimport App from \"./App\";\nimport \"./index.css\";\ncreateRoot(document.getElementById(\"root\")!).render(<App />);\n",
    "src/index.css": "body { margin: 0; }\n",
    "src/App.tsx": "export default function App() {\n  return <div>App</div>;\n}\n",
    ...overrides,
  };
}

/** Builds a small function component source. */
export function componentSource(name: string, jsx: string, imports = ""): string {
  return `${imports}${imports ? "\n" : ""}export default function ${name}() {\n  return (\n    ${jsx}\n  );\n}\n`;
}
```

#### 5.4.7 `png-fixtures.ts`

Signatures match sheet 11's area helper (`solidPng` returns a `PNG`, `withRect(png, rect, rgba)`), so 11's `pipeline/diff-summary/helpers/png-fixtures.ts` can re-export these and keep only its own `memoryArtifactStore`, `recordingQueryHandler` and `fakeAiProvider`.

```ts
// tests/backend/helpers/png-fixtures.ts
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

export type Rgba = [number, number, number, number];
export const COLORS = {
  white: [255, 255, 255, 255], black: [0, 0, 0, 255], red: [255, 0, 0, 255],
  emerald: [0, 153, 102, 255] /* Tailwind v4 emerald-600 ≈ oklch(59.6% 0.145 163.225) */, indigo: [79, 70, 229, 255] /* fixture --color-brand-600 #4f46e5 */, transparent: [0, 0, 0, 0],
} as const satisfies Record<string, Readonly<Rgba>>;

export function solidPng(width: number, height: number, rgba: Readonly<Rgba>): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) png.data.set(rgba, i * 4);
  return png;
}

/** Paints a rectangle in place and returns the same PNG (clipped to the image). */
export function withRect(png: PNG, rect: { x: number; y: number; w: number; h: number }, rgba: Readonly<Rgba>): PNG {
  for (let y = Math.max(0, rect.y); y < Math.min(png.height, rect.y + rect.h); y += 1) {
    for (let x = Math.max(0, rect.x); x < Math.min(png.width, rect.x + rect.w); x += 1) png.data.set(rgba, (y * png.width + x) * 4);
  }
  return png;
}

/** Deterministic noise (mulberry32) for "everything differs" cases. */
export function noisePng(width: number, height: number, seed = 1): PNG {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data.set([Math.floor(next() * 256), Math.floor(next() * 256), Math.floor(next() * 256), 255], i * 4);
  }
  return png;
}

export const encodePng = (png: PNG): Buffer => PNG.sync.write(png);
export const decodePng = (buffer: Buffer): PNG => PNG.sync.read(buffer);

export function writePng(dir: string, relativePath: string, png: PNG): string {
  const full = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, encodePng(png));
  return full;
}

export const readPng = (filePath: string): PNG => decodePng(fs.readFileSync(filePath));

export function pixelAt(png: PNG, x: number, y: number): Rgba {
  const o = (y * png.width + x) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2], png.data[o + 3]];
}

/** Most frequent opaque non-white colour inside a region; used by render ITs to check button colours. */
export function dominantColour(png: PNG, region = { x: 0, y: 0, w: png.width, h: png.height }): Rgba | null {
  const counts = new Map<string, number>();
  for (let y = region.y; y < region.y + region.h; y += 1) {
    for (let x = region.x; x < region.x + region.w; x += 1) {
      const [r, g, b, a] = pixelAt(png, x, y);
      if (a < 255 || (r > 245 && g > 245 && b > 245)) continue;
      const key = `${r},${g},${b}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? ([...best[0].split(",").map(Number), 255] as Rgba) : null;
}
```

#### 5.4.8 `ai-provider-stub.ts`

`ScriptedAiProvider` implements the sheet 00 `AiProvider` contract for every consumer (09, 11, settings connection test, orchestrator). Scripts are per `purpose`; an exhausted script throws loudly so tests never silently get `undefined`. Like `AnthropicApiProvider` (05 §5.11.1) it checks every request schema with `JsonSchemaValidator.assertStructuredOutputCompatible` (05 §5.13: every schema used with `generateStructured` must pass it); scripted refusal/invalid_output errors carry `usage` (default `DEFAULT_USAGE = { inputTokens: 100, outputTokens: 50, calls: 1 }`, declared at the top of the helper) as 05 §5.1 requires. It also validates scripted `data` against `request.jsonSchema`; data that does not match surfaces as `AiProviderError("…", "invalid_output", true, usage)`, so a fixture that the real provider would reject is rejected here too (opt out per step with `skipSchemaValidation: true` only when a test needs a consumer to see malformed data). Sheet 09's `fake-ai-provider.ts` (queue of results/errors) and sheet 11's `fakeAiProvider(behaviour)` keep their names and may be implemented as one-line wrappers over it. Data for `purpose: "harness" | "harness_repair"` must be a 09 `HarnessAiResponse` (`status`, `harnessSource`, `mockedModules[{specifier, source, reason}]`, `notes`).

```ts
// tests/backend/helpers/ai-provider-stub.ts
import { AiProviderError } from "../../../backend/src/types/visualization-pipeline";
import type { AiProvider, AiStructuredRequest, AiStructuredResult, AiUsage } from "../../../backend/src/types/visualization-pipeline";
import { JsonSchemaValidator } from "../../../backend/src/utilities/services/ai/json-schema-validator";

type Purpose = AiStructuredRequest["purpose"];
type Reason = AiProviderError["reason"];

export type ScriptStep =
  | { kind: "data"; data: unknown; usage?: Partial<AiUsage>; model?: string; delayMs?: number; skipSchemaValidation?: boolean }
  | { kind: "error"; reason: Reason; message?: string; retryable?: boolean; usage?: AiUsage }   // AiProviderError.usage (00 §14.4)
  | { kind: "refusal"; usage?: AiUsage }
  | { kind: "invalid_output"; raw?: string; usage?: AiUsage }
  | { kind: "hang" }                                         // resolves only via request.signal abort
  | { kind: "fn"; fn: (request: AiStructuredRequest, callIndex: number) => unknown | Promise<unknown> };

export type Script = Partial<Record<Purpose, ScriptStep[]>>;

const DEFAULT_RETRYABLE: Record<Reason, boolean> = {
  auth: false, config: false, rate_limit: true, refusal: false, max_tokens: false,
  invalid_output: true, network: true, aborted: false, unknown: false,
};

const DEFAULT_USAGE: AiUsage = { inputTokens: 100, outputTokens: 50, calls: 1 };

export class ScriptedAiProvider implements AiProvider {
  readonly requests: AiStructuredRequest[] = [];
  private readonly cursors = new Map<Purpose, number>();

  constructor(private readonly script: Script, readonly kind: AiProvider["kind"] = "anthropic_api", private readonly model = "claude-opus-5-5") {}

  async generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>> {
    this.requests.push(request);
    JsonSchemaValidator.assertStructuredOutputCompatible(request.jsonSchema);   // same check as the real providers (05)
    if (request.signal?.aborted) throw new AiProviderError("aborted", "aborted", false);

    const index = this.cursors.get(request.purpose) ?? 0;
    this.cursors.set(request.purpose, index + 1);
    const step = this.script[request.purpose]?.[index];
    if (!step) throw new Error(`ScriptedAiProvider: no scripted step for purpose "${request.purpose}" call #${index + 1}`);

    switch (step.kind) {
      case "data": {
        if (step.delayMs) await abortableDelay(step.delayMs, request.signal);
        const usage: AiUsage = { inputTokens: 100, outputTokens: 50, calls: 1, ...step.usage };
        return { data: step.skipSchemaValidation ? (step.data as T) : validated<T>(request, step.data, usage), usage, model: step.model ?? this.model };
      }
      case "fn": {
        const usage: AiUsage = { inputTokens: 100, outputTokens: 50, calls: 1 };
        return { data: validated<T>(request, await step.fn(request, index), usage), usage, model: this.model };
      }
      case "error":
        throw new AiProviderError(step.message ?? `scripted ${step.reason}`, step.reason, step.retryable ?? DEFAULT_RETRYABLE[step.reason], step.usage);
      case "refusal":
        throw new AiProviderError("The model declined to respond", "refusal", false, step.usage ?? DEFAULT_USAGE);
      case "invalid_output":
        throw new AiProviderError(`Model output failed schema validation: ${step.raw ?? "<garbage>"}`, "invalid_output", true, step.usage ?? DEFAULT_USAGE);
      case "hang":
        await abortableDelay(Number.POSITIVE_INFINITY, request.signal);
        throw new AiProviderError("aborted", "aborted", false);
    }
  }

  callsFor(purpose: Purpose): AiStructuredRequest[] {
    return this.requests.filter((request) => request.purpose === purpose);
  }

  /** Fails the test if any scripted step was not consumed. */
  assertExhausted(): void {
    for (const [purpose, steps] of Object.entries(this.script) as Array<[Purpose, ScriptStep[]]>) {
      const used = this.cursors.get(purpose) ?? 0;
      if (used < steps.length) throw new Error(`ScriptedAiProvider: ${steps.length - used} unused step(s) for "${purpose}"`);
    }
  }
}

/** Mirrors the providers: schema mismatch after a "response" is invalid_output with usage attached (05 §5.1). */
function validated<T>(request: AiStructuredRequest, data: unknown, usage: AiUsage): T {
  const result = JsonSchemaValidator.validate<T>(request.jsonSchema, data);
  if (result.ok) return result.value;
  throw new AiProviderError(`Model output failed schema validation: ${result.summary}`, "invalid_output", true, usage);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : undefined;
    signal?.addEventListener("abort", () => {
      if (timer) clearTimeout(timer);
      reject(new AiProviderError("aborted", "aborted", false));
    }, { once: true });
  });
}
```

#### 5.4.9 `ai-sdk-fakes.ts`

Sheet 05's `fake-anthropic-stream.ts` and `fake-agent-query.ts` (05 §4) keep their names and, in wave 6, re-export `fakeAnthropicStream`/`anthropicFinalMessage`/`hangingMessage`/`anthropicErrors` and `fakeAgentQuery`/`agentResult` from this file.

Used by sheet 05's provider tests through the injection points 05 defines: `AnthropicApiProviderOptions.streamFn` (`AnthropicStreamFn = (params, { signal }) => { finalMessage(): Promise<FinalMessage> }`) and `ClaudeCodeProvider({ queryFn })` (`AgentQueryFn = ({ prompt, options }) => AsyncIterable<unknown>`).

```ts
// tests/backend/helpers/ai-sdk-fakes.ts
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicStreamFn } from "../../../backend/src/utilities/services/ai/anthropic-api-provider";
import type { AgentQueryFn } from "../../../backend/src/utilities/services/ai/claude-code-provider";

type StreamParams = Parameters<AnthropicStreamFn>[0];

/** Fake streamFn: each entry is a final message object or an Error thrown from finalMessage(). Records params and signal. */
export function fakeAnthropicStream(responses: Array<Record<string, unknown> | Error | ((signal: AbortSignal) => Promise<Record<string, unknown>>)>) {
  const calls: Array<{ params: StreamParams; signal: AbortSignal }> = [];
  const streamFn: AnthropicStreamFn = (params, { signal }) => {
    calls.push({ params, signal });
    const next = responses.shift();
    return {
      finalMessage: async () => {
        if (!next) throw new Error("fakeAnthropicStream: no scripted response");
        if (next instanceof Error) throw next;
        if (typeof next === "function") return (await next(signal)) as never;
        return next as never;
      },
    };
  };
  return { streamFn, calls };
}

/** A final message whose last text block is the JSON (05 ignores text before the last fallback block). */
export function anthropicFinalMessage(json: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
    ...overrides,
  };
}

/** Message that never resolves until the signal aborts (deadline / caller-abort tests). */
export const hangingMessage = (signal: AbortSignal) =>
  new Promise<Record<string, unknown>>((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()), { once: true }));

/**
 * Real SDK error classes so instanceof mapping is exercised. Constructor arguments follow the installed
 * SDK (sheet 05 notes: VERIFY; fall back to Anthropic.APIError.generate(status, body, message, headers)).
 */
export const anthropicErrors = {
  auth: () => Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers()),
  permission: () => Anthropic.APIError.generate(403, { type: "error", error: { type: "permission_error", message: "no access" } }, "no access", new Headers()),
  notFound: () => Anthropic.APIError.generate(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }, "model: claude-nope", new Headers()),
  badRequest: () => Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, "bad", new Headers()),
  rateLimit: () => Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers({ "retry-after": "3" })),
  overloaded: () => Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "overloaded" } }, "overloaded", new Headers()),
  server: () => Anthropic.APIError.generate(500, { type: "error", error: { type: "api_error", message: "boom" } }, "boom", new Headers()),
  connection: () => new Anthropic.APIConnectionError({ message: "fetch failed" }),
  timeout: () => new Anthropic.APIConnectionTimeoutError({ message: "timed out" }),
  abort: () => new Anthropic.APIUserAbortError(),
};

/** Fake Agent SDK query(): yields scripted messages, records prompt and options, honours the abort controller. */
export function fakeAgentQuery(messages: Array<Record<string, unknown> | Error>) {
  const calls: Array<{ prompt: string; options: Parameters<AgentQueryFn>[0]["options"] }> = [];
  let returned = false;
  const queryFn: AgentQueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const queue = [...messages];
    const controller = (options as { abortController?: AbortController }).abortController;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (const message of queue) {
            if (controller?.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            if (message instanceof Error) throw message;
            yield message;
          }
        } finally {
          returned = true;                         // lets tests assert the iterator was closed
        }
      },
    };
  };
  return { queryFn, calls, wasClosed: () => returned };
}

export function agentResult(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "result", subtype: "success", is_error: false, duration_ms: 1500, num_turns: 2,
    result: text, usage: { input_tokens: 900, output_tokens: 250 }, total_cost_usd: 0, session_id: "sess_test",
    ...overrides,
  };
}
```

The exact message shapes the provider parses are sheet 05's (`claude-code-result.ts`); keep these builders in step with them.

#### 5.4.10 `console-recorder.ts`

```ts
// tests/backend/helpers/console-recorder.ts
import { VisualizationStatus } from "../../../backend/src/enums";
import type { PipelineContext } from "../../../backend/src/types/visualization-pipeline";
import { logTestStream } from "../../../backend/src/utilities/loggers/logger";

export type ConsoleLevel = "info" | "warn" | "error";
export interface RecordedEvent { level: ConsoleLevel; stage: string; message: string }

export class ConsoleRecorder implements PipelineContext["console"] {
  readonly events: RecordedEvent[] = [];
  async info(stage: string, message: string): Promise<void> { this.events.push({ level: "info", stage, message }); }
  async warn(stage: string, message: string): Promise<void> { this.events.push({ level: "warn", stage, message }); }
  async error(stage: string, message: string): Promise<void> { this.events.push({ level: "error", stage, message }); }

  messages(level?: ConsoleLevel): string[] {
    return this.events.filter((e) => !level || e.level === level).map((e) => e.message);
  }
  has(level: ConsoleLevel, pattern: string | RegExp, stage?: string): boolean {
    return this.events.some((e) => e.level === level && (!stage || e.stage === stage) &&
      (typeof pattern === "string" ? e.message.includes(pattern) : pattern.test(e.message)));
  }
  stages(): string[] { return [...new Set(this.events.map((e) => e.stage))]; }
  assertNoErrors(): void {
    const errors = this.events.filter((e) => e.level === "error");
    if (errors.length) throw new Error(`Unexpected console errors:\n${errors.map((e) => `[${e.stage}] ${e.message}`).join("\n")}`);
  }
  /** Asserts no event leaks a secret-looking value. */
  assertNoSecrets(secrets: string[]): void {
    for (const event of this.events) for (const secret of secrets) {
      if (event.message.includes(secret)) throw new Error(`Secret leaked into console event [${event.stage}]`);
    }
  }
  /** Console `stage` values are the pipeline status names (00 §14.4; 03 CHECKs them). */
  assertStagesAreStatusNames(): void {
    const allowed = new Set<string>(Object.values(VisualizationStatus));
    const bad = this.events.filter((e) => !allowed.has(e.stage));
    if (bad.length) throw new Error(`Console stages that are not VisualizationStatus values: ${[...new Set(bad.map((e) => e.stage))].join(", ")}`);
  }
}

/**
 * Captures every pino line (root and child loggers) for the duration of a test. The only supported way to
 * assert on logs (00 §14.10): under NODE_ENV=test 04's root logger writes to logTestStream (04 §9.10), and
 * child loggers created at import time inherit that destination. Call restore() in t.after.
 */
export function recordLogger(): { lines: Array<Record<string, unknown>>; text(): string; restore: () => void } {
  const lines: Array<Record<string, unknown>> = [];
  const unsubscribe = logTestStream.subscribe((line: string) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return { lines, text: () => lines.map((line) => JSON.stringify(line)).join("\n"), restore: unsubscribe };
}
```

#### 5.4.11 `fake-redis.ts` and `fake-queue.ts`

```ts
// tests/backend/helpers/fake-redis.ts
export class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  readonly commands: Array<{ name: string; args: unknown[] }> = [];
  now: () => number = () => Date.parse("2026-01-01T00:00:00Z");

  async get(key: string): Promise<string | null> {
    this.commands.push({ name: "get", args: [key] });
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) { this.store.delete(key); return null; }
    return entry.value;
  }
  async set(key: string, value: string, mode?: "EX", seconds?: number): Promise<"OK"> {
    this.commands.push({ name: "set", args: [key, value, mode, seconds] });
    this.store.set(key, { value, expiresAt: mode === "EX" && seconds ? this.now() + seconds * 1000 : null });
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    this.commands.push({ name: "del", args: keys });
    return keys.filter((key) => this.store.delete(key)).length;
  }
  async exists(key: string): Promise<number> { this.commands.push({ name: "exists", args: [key] }); const entry = this.store.get(key); if (!entry) return 0; if (entry.expiresAt !== null && entry.expiresAt <= this.now()) { this.store.delete(key); return 0; } return 1; }
  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - this.now()) / 1000);
  }
  async quit(): Promise<void> {}
}
```

```ts
// tests/backend/helpers/fake-queue.ts
import type { VisualizationJob } from "../../../backend/src/utilities/services/queue-service";

export type FakeJobState = "waiting" | "delayed" | "prioritized" | "active" | "completed" | "failed";
export interface FakeJob { id: string; name: string; data: Record<string, unknown>; opts: Record<string, unknown>; state: FakeJobState; getState(): Promise<FakeJobState>; remove(): Promise<void> }

export class FakeQueue {
  readonly jobs = new Map<string, FakeJob>();
  readonly added: FakeJob[] = [];
  failNextAdd: Error | null = null;

  async add(name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<FakeJob> {
    if (this.failNextAdd) { const error = this.failNextAdd; this.failNextAdd = null; throw error; }
    const id = String(opts.jobId ?? `job-${this.added.length + 1}`);
    const existing = this.jobs.get(id);
    if (existing) return existing;               // BullMQ: same jobId is a no-op
    const job: FakeJob = { id, name, data, opts, state: "waiting", getState: async () => job.state, remove: async () => { this.jobs.delete(id); } };
    this.jobs.set(id, job);
    this.added.push(job);
    return job;
  }
  async getJob(id: string): Promise<FakeJob | undefined> { return this.jobs.get(id); }
  async waitUntilReady(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * The object 04's QueueService hands the injected processor (00 §14.6): { visualizationId, jobId, signal }.
 * cancel()/shutdown() abort with the STRING reasons QueueService uses, so code under test sees exactly what
 * production sees (decide with jobAbortReason(signal), never `instanceof Error`).
 */
export function makeJob(visualizationId: number): { job: VisualizationJob; cancel(): void; shutdown(): void } {
  const controller = new AbortController();
  return {
    job: { visualizationId, jobId: `viz-${visualizationId}`, signal: controller.signal },
    cancel: () => controller.abort("cancelled"),
    shutdown: () => controller.abort("shutdown"),
  };
}
```

#### 5.4.12 `fake-github-port.ts`

Sheet 06's `GitHubClient` takes a `GitHubRestPort` (`getAuthenticatedUser`, `listPulls`, `getPull`). This fake is shared by 06 (`github-client.test.ts`, repositories service) and 07 (PR creation through a real `GitHubClient` over the fake port). Sheet 05 does not need it: `SettingsService` takes a `verifyGithubToken` dependency with the signature of `GitHubClient.verifyToken(token, { signal })`, which never throws and returns a result object (06 §5.6.3), so 05's tests inject a plain function. `GitHubClient.gitAuthHeaders(token)` is pure and is called directly (07 workspace tests).

```ts
// tests/backend/helpers/fake-github-port.ts
import type { GitHubRestPort } from "../../../backend/src/utilities/services/github-client";

export interface FakeGithubState {
  login?: string;
  pulls?: Array<ReturnType<typeof rawPull>>;
  pullDetails?: Record<number, ReturnType<typeof rawPullDetail>>;
  /** Throw this error from the named method (once per entry, in order). */
  errors?: Partial<Record<keyof GitHubRestPort, unknown[]>>;
}

export function createFakeGithubPort(state: FakeGithubState = {}) {
  const calls: Array<{ method: keyof GitHubRestPort; args: Record<string, unknown> }> = [];
  const maybeThrow = (method: keyof GitHubRestPort) => {
    const next = state.errors?.[method]?.shift();
    if (next !== undefined) throw next;
  };
  const port: GitHubRestPort = {
    async getAuthenticatedUser(signal) {
      calls.push({ method: "getAuthenticatedUser", args: { signal } });
      maybeThrow("getAuthenticatedUser");
      return { login: state.login ?? "octo" };
    },
    async listPulls(p) {
      calls.push({ method: "listPulls", args: p });
      maybeThrow("listPulls");
      const all = state.pulls ?? [];
      return all.slice((p.page - 1) * p.perPage, p.page * p.perPage) as never;
    },
    async getPull(p) {
      calls.push({ method: "getPull", args: p });
      maybeThrow("getPull");
      const detail = state.pullDetails?.[p.pullNumber];
      if (!detail) throw githubHttpError(404, "Not Found");
      return detail as never;
    },
  };
  return { port, calls };
}

export function rawPull(overrides: Record<string, unknown> = {}) {
  return {
    number: 7, title: "Restyle button", user: { login: "octocat" }, draft: false,
    updated_at: "2026-01-02T10:00:00Z", html_url: "https://github.com/acme/web/pull/7",
    head: { ref: "feature/button-restyle", sha: "a".repeat(40), repo: { full_name: "acme/web" } },
    base: { ref: "main", sha: "b".repeat(40) },
    ...overrides,
  };
}

export function rawPullDetail(overrides: Record<string, unknown> = {}) {
  return { ...rawPull(), state: "open", merged: false, ...overrides };
}

/** Octokit-like HTTP error (status + response headers) as GitHubClient's mapper reads it. */
export function githubHttpError(status: number, message: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), {
    name: "HttpError", status,
    response: { status, headers, data: { message } },
    request: { headers: { authorization: "token [REDACTED]" } },
  });
}

export const networkError = (): Error => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
```

#### 5.4.13 Render fakes (owned by sheet 10)

Sheet 10 owns `tests/backend/render/helpers/render-stubs.ts` (`FakeViteHost`, `FakeBrowserSession`, `InMemoryPersistence`, `FakeArtifactStore`, `fakePipelineContext()`) and `fake-vite-package.ts`. This sheet adds no render fakes. In wave 6, `fakePipelineContext()` may be built on `createPipelineContext()` (5.4.14) and its console capture on `ConsoleRecorder`, keeping 10's names.

#### 5.4.14 `pipeline-context.ts` and `factories.ts`

```ts
// tests/backend/helpers/pipeline-context.ts
import path from "node:path";
import type { PipelineContext, PreparedWorkspace } from "../../../backend/src/types/visualization-pipeline";
import { ScriptedAiProvider, type Script } from "./ai-provider-stub";
import { ConsoleRecorder } from "./console-recorder";

export interface PipelineContextHandle {
  context: PipelineContext;
  ai: ScriptedAiProvider;
  console: ConsoleRecorder;
  abort: AbortController;
  cancel(): void;                       // isCancelled() → true and ctx.signal aborts with reason "cancelled"
  shutdown(): void;                     // ctx.signal aborts with reason "shutdown" (00 §14.6)
}

export function createPipelineContext(options: {
  visualizationId?: number;
  dataDir: string;
  repositoryPath: string;
  baseDir?: string;
  headDir?: string;
  workspace?: Partial<PreparedWorkspace>;
  script?: Script;
  repository?: Partial<PipelineContext["repository"]>;
}): PipelineContextHandle {
  const visualizationId = options.visualizationId ?? 1;
  const ai = new ScriptedAiProvider(options.script ?? {});
  const recorder = new ConsoleRecorder();
  const abort = new AbortController();
  let cancelled = false;
  const context: PipelineContext = {
    visualizationId,
    workspace: {
      visualizationId,
      repositoryPath: options.repositoryPath,
      baseDir: options.baseDir ?? path.join(options.dataDir, "worktrees", String(visualizationId), "base"),
      headDir: options.headDir ?? path.join(options.dataDir, "worktrees", String(visualizationId), "head"),
      baseSha: "0".repeat(40), headSha: "1".repeat(40), sourceType: "local_branch", dependencyDrift: false,
      ...options.workspace,
    },
    repository: {
      id: 1, localPath: options.repositoryPath, viteConfigPath: "vite.config.ts", tsconfigPath: "tsconfig.json",
      entryFilePath: "src/main.tsx", globalStylePaths: ["/src/index.css"], ...options.repository,
    },
    ai,
    aiSettings: { model: "claude-opus-5-5", harnessEffort: "high", summaryEffort: "medium" },
    console: recorder,
    isCancelled: async () => cancelled,
    signal: abort.signal,
  };
  return {
    context, ai, console: recorder, abort,
    cancel: () => { cancelled = true; abort.abort("cancelled"); },
    shutdown: () => { abort.abort("shutdown"); },
  };
}
```

`factories.ts` exports `makeRepositoryRow(overrides)`, `makeVisualizationRow(overrides)`, `makeComponentRow(overrides)`, `makeConsoleEventRow(overrides)`, `makeSettingsRow(overrides)`, `makeRepositoryModel(overrides)`, `makeVisualizationModel(overrides)` and `idModel(id)`. Rows contain **every** column of their table (03 §6.1, camelCase properties) so `assert.deepEqual` on views is meaningful. Defaults: fixed dates (`2026-01-01T00:00:00Z`), `framework: "react_vite"`, `packageManager: "npm"`, `globalStylePaths: ["/src/index.css"]`; visualizations `status: "queued"`, `jobId: "viz-<id>"`, `failedStage: null`, `componentCount: 0`, `changedCount: 0`, `aiUsage: null`, `completedAt: null`; components `renderStatus: "pending"`, `visualChange: null`, `risk: null`, `changeReason: "Component code changed"`, `skipReason: null`, image paths `null` (when set, relative `artifacts/<v>/<c>/<kind>.png`, 00 §14.3); settings row `id: 1`, `aiProvider: "anthropic_api"`, `aiModel: "claude-opus-5-5"`, efforts `high`/`medium`, both secrets `null`. Overrides that would violate one of 03's CHECKs (e.g. `failedStage` on a non-terminal row, `skipReason` on a non-skipped row) throw in the factory, because the in-memory stub does not evaluate CHECKs. Models are built with generated setters (Uply `makeUser` pattern).

### 5.5 Static test fixtures (`tests/fixtures/`)

| File | Content | Used by |
|---|---|---|
| `harnesses/sample-react-app/button.json` | `HarnessAiResponse` for `src/components/Button.tsx` (5.5.1) | IT render/pipeline (scripted AI), 5.6.7 cross-check |
| `harnesses/sample-react-app/badge.json` | Badge in three tones | IT |
| `harnesses/sample-react-app/card.json` | Card with title/description/action props | IT |
| `harnesses/sample-react-app/user-menu.json` | UserMenu with a seeded `QueryClient` + `MemoryRouter`, no mocks (5.5.2) | IT |
| `harnesses/sample-react-app/user-menu-mocked.json` | UserMenu with `mockedModules: [{ specifier: "@/auth/useAuth", … }]` (5.5.2) | IT mock plugin |
| `harnesses/sample-react-app/profile-card.json` | ProfileCard with stats | IT |
| `harnesses/sample-react-app/tag.json` | Tag (the untracked component added in the working-tree IT) | IT |
| `ai/summary-valid.json` | schema-valid sheet 11 summary output for 3 components | 11 cross-check |
| `ai/summary-unknown-component.json` | references a component id not in the set | 11 cross-check |
| `ai/summary-invalid-risk.json` | `risk: "catastrophic"` (violates the summary schema's `enum`) | 11 cross-check |
| `ai/harness-no-default-export.json` | `HarnessAiResponse` whose source lacks `PRVisionHarness` | 09 cross-check |
| `ai/harness-uses-fetch.json` | harness calling `fetch("https://…")` | 09 cross-check |
| `README.md` | "Fixture data for tests. Never put real tokens or keys here; fake values look like `ghp_TEST…`, `sk-ant-test-…`." | — |

Each harness file is a 09 `HarnessAiResponse` (`status`, `harnessSource`, `mockedModules[{ specifier, source, reason }]`, `notes`), so the scripted provider can return it verbatim for `purpose: "harness"`. Harnesses live at `.prvision-harness/components/<file>.tsx` (09 §5.2), so the target import is `targetImportPath` = `../../src/components/<Name>` with the default binding named after `displayName` (09 `targetImportStatement`). Harnesses avoid everything 09's validator rejects (`fetch`, `Date.now`, argless `new Date()`, `Math.random`, CSS imports, `createRoot`), and their own wrapper elements use inline `style`, not Tailwind classes, because harness files are not scanned by Tailwind (00 §14.7; 09 warns with `harness_class_name`). Every file also validates against 09's response schema, because `ScriptedAiProvider` checks scripted data against `request.jsonSchema` (5.4.8).

#### 5.5.1 `button.json`

```json
{
  "status": "ok",
  "harnessSource": "import Button from \"../../src/components/Button\";\n\nexport default function PRVisionHarness() {\n  return (\n    <div style={{ display: \"flex\", alignItems: \"center\", gap: 12, padding: 24, background: \"#ffffff\" }}>\n      <Button>Save changes</Button>\n      <Button variant=\"secondary\">Cancel</Button>\n      <Button disabled>Disabled</Button>\n    </div>\n  );\n}\n",
  "mockedModules": [],
  "notes": "Renders primary, secondary and disabled variants side by side."
}
```

#### 5.5.2 `user-menu.json` and `user-menu-mocked.json`

```json
{
  "status": "ok",
  "harnessSource": "import { QueryClient, QueryClientProvider } from \"@tanstack/react-query\";\nimport { MemoryRouter } from \"react-router-dom\";\nimport UserMenu from \"../../src/components/UserMenu\";\n\nconst client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });\nclient.setQueryData([\"auth\", \"me\"], { id: \"u_1\", firstName: \"Ada\", lastName: \"Lovelace\", email: \"ada@example.com\" });\n\nexport default function PRVisionHarness() {\n  return (\n    <QueryClientProvider client={client}>\n      <MemoryRouter>\n        <div style={{ display: \"flex\", justifyContent: \"flex-end\", padding: 24, background: \"#ffffff\" }}>\n          <UserMenu />\n        </div>\n      </MemoryRouter>\n    </QueryClientProvider>\n  );\n}\n",
  "mockedModules": [],
  "notes": "Seeds the ['auth','me'] query so useAuth runs its real logic without network."
}
```

```json
{
  "status": "ok",
  "harnessSource": "import { MemoryRouter } from \"react-router-dom\";\nimport UserMenu from \"../../src/components/UserMenu\";\n\nexport default function PRVisionHarness() {\n  return (\n    <MemoryRouter>\n      <div style={{ display: \"flex\", justifyContent: \"flex-end\", padding: 24, background: \"#ffffff\" }}>\n        <UserMenu />\n      </div>\n    </MemoryRouter>\n  );\n}\n",
  "mockedModules": [
    {
      "specifier": "@/auth/useAuth",
      "source": "export function useAuth() {\n  return {\n    user: { id: \"u_1\", firstName: \"Grace\", lastName: \"Hopper\", email: \"grace@example.com\" },\n    displayName: \"MOCKED Grace\",\n    initials: \"MG\",\n    isLoading: false,\n    error: null,\n  };\n}\n",
      "reason": "useAuth fetches /api/me; the mock returns a signed-in user."
    }
  ],
  "notes": "Mocks useAuth entirely; the text MOCKED proves the mock plugin replaced the module."
}
```

The mock exports `useAuth`, the only name `UserMenu` imports from `@/auth/useAuth`, so 09's export-parity check passes (`fetchCurrentUser` is reported only as the `mock_export_incomplete` warning).

### 5.6 Backend test catalogue (sheets 03–11)

How to read this catalogue:

- For each sheet: **owned files** (the sheet's own Tests section is the authoritative list of named cases; not repeated here), then **sheet 14 additions** (each bullet is one `test("…")`: name in backticks, then what it must assert). Table-driven bullets create one `test` per row so failures name the row.
- Test names follow sheet 01 §5.15: `"<Class>.<method> <expected behaviour> [when <condition>]"`.
- Feature agents write their own lists while implementing; the wave-6 agent ticks off both their lists and these additions, and records any case that cannot exist (with the reason).
- The wave-6 audit also checks every sheet's list against sheet 01 §5.15's rule: every service method has a success path, each expected-failure `error_reason`, and the unexpected-error 500 path; every pipeline step has success, per-component failure captured, fatal `PipelineStepError`, and abort respected.

#### 5.6.1 Sheet 03 — database schema, migrations, models

Owned files (03 §13): `tests/backend/database/{enums,schema,table-registry,model-generator}.test.ts`, `tests/backend/database/migrations.integration.test.ts` (skipped unless `PRVISION_TEST_DATABASE_URL` is set; it asserts the database name ends in `_test` before dropping anything, so a non-`_test` URL fails rather than skips). Sheet 02 owns the basic `tests/backend/enums/enums.test.ts`.

Sheet 14 additions:

- Covered by 03, no addition: `Table` values vs registry (03 `table-registry.test.ts` "getTableName matches the value"; 00 §14.3 settled snake_case).
- `tests/backend/test-support/query-handler-stub.test.ts` (section 9) → `factories produce rows whose keys are exactly the table's columns` — for each factory, `Object.keys(row)` equals `Object.keys(getTableColumns(getTableSchema(table)))`, so a new 03 column (as `failed_stage`, `change_reason`, `skip_reason` were) fails here until the factories and the stub defaults follow.
- Audit item (no new test): `migrations.integration.test.ts` is executed at least once during wave 6 against the Docker Postgres (`createdb -h 127.0.0.1 -p 5433 -U prvision prvision_test`), and the run is recorded. It is the only proof of the CHECKs the in-memory stub does not evaluate (`visualizations_failed_stage_check`, `visualizations_failed_stage_status_check`, `visualization_components_skip_reason_check`, `visualization_components_image_path_relative_check`, `visualization_console_events_stage_check`).

#### 5.6.2 Sheet 04 — backend core infrastructure

Owned files (04 §14.2): `tests/backend/utilities/{response-handler,query-handler,model-handler,validation,dto-mapper,encryption,logger,paths,process,git-client,artifact-store,queue-service,graceful-shutdown}.test.ts`, `tests/backend/config/config-validation.test.ts`, `tests/backend/middleware/local-auth-middleware.test.ts`, `tests/backend/http/{app,artifacts-route}.test.ts`, `tests/backend/services/health-service.test.ts`. Created by 02 and kept passing by 04: `tests/backend/types/pipeline-errors.test.ts`. Owned by 02 (02 §10, 01 §9): `tests/backend/config/{app-config,queue-config,config-consts}.test.ts`, `tests/backend/enums/enums.test.ts`.

Covered by 04 now, no addition: the symlink case of `resolveSafe` (04 lists it as "sheet 14 case"), the `{ visualizationId, jobId, signal }` processor contract with string abort reasons, log redaction through `logTestStream`.

Sheet 14 additions:

- `config/config-validation.test.ts` → `config-consts reads no test-only variable except PRVISION_TEST_LOG_STDOUT` — static scan of every `backend/src/config-consts/*.ts` source: none contains `PRVISION_IT_`, `PRVISION_INTEGRATION`, `PRVISION_TEST_DATABASE_URL`, `PRVISION_KEEP_TEST_ARTIFACTS` or `PRVISION_REAL_DATA_DIR` (00 §14.10, §14.12). Stronger than "validation ignores them", which holds trivially because validation reads constants, not the environment.
- `utilities/artifact-store.test.ts` → `an ArtifactStore built on an injected data dir never touches DATA_DIR` — `new ArtifactStore(useTempDataDir(t))`; `write`, `read`, `ensureComponentDir`, `removeVisualization` operate under the injected dir; a listing of `DATA_DIR` (the preload's session dir) is unchanged. Proves the constructor-injection pattern that replaces env mutation (00 §14.12).
- `utilities/process.test.ts` → `child env keys are a subset of the allow-list, LC_* and the explicit overrides` — the child prints `Object.keys(process.env)`; every key is in `CHILD_PROCESS_ENV_ALLOWLIST`, matches `LC_*`, or was passed in `env`. Extends 04's three named secrets to every name (`ANTHROPIC_*`, `NODE_OPTIONS`, `GIT_*`) without mutating `process.env`.
- `utilities/git-client.test.ts` → `operations ignore hostile repository config` — the temp repo's local config sets `commit.gpgsign=true`, `core.hooksPath` to a dir with a failing `post-checkout` hook, `core.fsmonitor=false-command`, `diff.external=false-command` and a `textconv` driver for `*.tsx`; `diffNameStatus`, `diffUnified`, `showFile`, `worktreeAdd`/`worktreeRemove` still succeed and produce normal output (04 §13 disables these per call).
- `http/app.test.ts` → `createApp() opens no database, Redis or outbound connection` — `DbPool`/`RedisPool` connection getters patched to throw; network guard active; building the app and serving `/api/does-not-exist` returns the 404 envelope.
- `utilities/logger.test.ts` → `config-error logging never prints the secret key or the database password` — `validateConfig({ PRVISION_SECRET_KEY: "short", DATABASE_URL: "postgres://u:hunter2@127.0.0.1:5433/x" })` throws; logging the error the way 04 §5.1 does, `log.fatal({ event: "app.boot.failed", err })`, and capturing with `recordLogger()` yields lines that contain neither `hunter2` nor the preload's key.

#### 5.6.3 Sheet 05 — settings and AI providers

Owned files (05 §9): `tests/backend/settings/{settings-update-dto,settings-store,settings-service,settings-controller}.test.ts`, `tests/backend/ai/{json-schema-validator,anthropic-api-provider,claude-code-provider,claude-code-result,ai-provider-factory,ai-connection-test}.test.ts`. 05 fakes the SDKs through the injected `streamFn` / `queryFn` and GitHub through the injected `verifyGithubToken`; sheet 14's `ai-sdk-fakes.ts` (5.4.9: `fakeAnthropicStream`, `fakeAgentQuery`, `anthropicErrors`) implements those seams.

Secret semantics under test are 00 §14.4 (and 05 §9): omitted = keep, `""` = clear, `null` → 400 `validation_failed`, whitespace-only rejected, valid value trimmed then encrypted with the `enc:v1:` prefix. Sheet 13 now sends `""` as well, so backend and frontend tests agree. Test endpoint statuses follow 00 §14.12: `github_unauthorized`/`ai_unauthorized`/`ai_not_configured`/`github_token_missing` → 400, `github_rate_limited` → 429, `github_unavailable` → 502, a failing AI provider in `test-ai` (network, rate limit, refusal, bad output, nonce mismatch) → 502 `internal_error` as 05 §5.8 specifies, a timed-out test → 504 `internal_error`; success bodies are `{ login }` and `{ provider, model, latencyMs }`.

Sheet 14 additions:

- `settings/settings-service.test.ts` → `failure paths never echo secrets` — `update` with an invalid key, `testGithub` with an injected `verifyGithubToken` returning `unauthorized` with a message that embeds the token, and `testAi` with a provider `auth` error whose message embeds the key: response bodies, thrown messages and `recordLogger()` lines contain neither `ghp_TEST…` nor `sk-ant-test-…`.
- `settings/settings-service.test.ts` → `get after update round-trips every non-secret field` — table over `aiProvider`, `aiModel`, `aiHarnessEffort`, `aiSummaryEffort`; the `SettingsView` has exactly the 00 §9 keys.
- `ai/anthropic-api-provider.test.ts` → `AiProviderError messages never contain the API key` — for each error builder in `anthropicErrors`.
- `ai/ai-provider-factory.test.ts` → `a claude_code provider never holds the stored Anthropic key` — `AiProviderFactory.create({ provider: "claude_code", anthropicApiKey: { state: "present", value: "sk-ant-test-…" }, … })`; `JSON.stringify` of the instance and the `options.env` recorded by `fakeAgentQuery` (when the same settings drive a `ClaudeCodeProvider` with the fake `queryFn`) do not contain the value (policy D5: Claude Code uses the developer's own login).
- `ai/claude-code-provider.test.ts` → `iterator is closed on success and on error` — `fakeAgentQuery().wasClosed()` is true in both cases (05 already covers abort); no orphaned CLI process.

#### 5.6.4 Sheet 06 — repositories and GitHub

Owned files (06 §9): `tests/backend/repositories/{repository-create-dto,project-detection-helpers,project-detection-service,repositories-service,github-client}.test.ts`, helper `tests/backend/repositories/helpers/detection-fixture.ts`. Git is faked (`fakeGit`), so 06's tests need no git binary. (`IdParamDTO` is 04's and is tested in 04's `validation.test.ts`.)

Sheet 14 additions:

- `repositories/project-detection-service.test.ts` → `detect never writes into the repository folder` — recursive listing with sizes and mtimes of the fixture folder is identical before and after `detect`.
- `repositories/repositories-service.test.ts` → `remote URLs with embedded credentials never reach the row, the view or the logs` — fake git remote `https://x-access-token:ghp_TEST…@github.com/acme/web.git`; inserted row, `RepositoryView` JSON and `recordLogger()` lines do not contain `ghp_TEST`.
- `repositories/repositories-service.test.ts` → `every error response uses the 00 §14.12 status for its error_reason` — table over every failure path in 06 §6: `(status, error_reason)` pairs are exactly `400` for input/settings reasons, `404 not_found`, `409 conflict`, `429 github_rate_limited`, `502 github_unavailable`; never 401 or 403.
- Real-detection cross-check against the fixture: see `integration/pipeline/fixture-detection.test.ts` in 5.8.

#### 5.6.5 Sheet 07 — visualizations API, orchestration, workspaces

Owned files (07 §9): `tests/backend/visualizations/{visualization-create-dto,visualization-query-dto,visualization-state-machine,visualizations-service,visualization-console-service,visualization-worker-service,visualization-boot-recovery,workspace-prepare-service}.test.ts`, `tests/backend/visualizations/workspace-prepare.integration.test.ts` (real git, skipped without git), helpers `tests/backend/visualizations/helpers/{fakes,temp-git-repo}.ts`. 07's own list already covers the cancel responses (200 `cancelled` / 202 `cancel_requested` / 409 `already_terminal`), delete 409 `conflict`, `failedStage`/`changeReason`/`skipReason` in views, the `{ visualizationId, jobId, signal }` job, `renderAll` + `buildRenderInputs`, `diff`/`compare`/`summarize`, "never writes `ai_usage`", and console stages being status names.

Sheet 14 additions:

- `visualizations/visualization-state-machine.test.ts` → `transition matrix <from> → <to>` — loop over all 10×10 status pairs (100 tests); the allowed set equals exactly 07's table (linear stage order, `summarizing → completed`, any non-terminal → `failed`/`cancelled`, nothing out of a terminal status, no self-transitions). Catches accidental extra edges that the summary tests miss.
- `visualizations/visualization-worker-service.test.ts` → `failed_stage records the active stage for <stage>` — one test per non-terminal stage (`queued` … `summarizing`): the step for that stage throws `new PipelineStepError(<stage>, "boom")` (positional, 00 §14.12) or, for `queued`, `createProvider` throws `AiProviderError(config)`; the terminal write has `status: "failed"`, `failedStage: <stage>`; the same table with `makeJob(id).cancel()` fired inside the stage yields `status: "cancelled"`, `failedStage: <stage>`; `completed` never writes `failedStage`.
- `visualizations/visualization-worker-service.test.ts` → `changed_count counts changed, new and deleted rows only` — component rows with `visualChange` `changed`, `new`, `deleted`, `unchanged`, `null` (failed render) and a skipped row → `changedCount === 3`, `componentCount === 6` (every row, recomputed by 07's terminal write, 07 §5.9.5; 00 §14.3).
- `visualizations/visualization-boot-recovery.test.ts` → `running recovery twice changes nothing the second time` — second run issues no updates, no console events, no git calls beyond `worktree prune`.
- `visualizations/visualization-worker-service.test.ts` → `console events of a full run never contain secrets` — fake ports emit errors that embed `ghp_TEST…` and `sk-ant-test-…`; every recorded console message passes `ConsoleRecorder.assertNoSecrets`, and `assertStagesAreStatusNames()` passes.
- New file `tests/backend/visualizations/user-clone-safety.integration.test.ts` (real git via shared `temp-git-repo.ts`; skipped without git):
  - `local_branch prepare + cleanup leaves the clone unchanged` — `snapshot()` before, after prepare (only `worktrees` differs) and after cleanup (identical).
  - `working_tree prepare + cleanup leaves the clone unchanged, including index and stash` — dirty tree with staged, unstaged, untracked and deleted files; `snapshot().indexHash`, `status`, `stashes` identical afterwards.
  - `github_pr prepare + cleanup leaves the clone unchanged and removes refs/prvision refs` — bare origin with `refs/pull/7/head`, wired as in 5.8's PR test (no network); during the run `refs/prvision/pr-7` and `refs/prvision/pr-7-base` exist; after cleanup neither exists (00 §14.7) and `nonPrvisionRefs` is unchanged.
  - `baseSha is the merge-base when the base branch moved after branching` — `main` gains a commit after `feature` branched; for `local_branch` and `github_pr`, `PreparedWorkspace.baseSha === git merge-base main feature` (00 §14.7), not the `main` tip.
  - `no repository hook runs during prepare` — clone has `post-checkout`, `post-merge` and `reference-transaction` hooks writing marker files; no marker exists afterwards.
  - `GitClient is never asked to run a mutating command in the clone` — spy on `GitClient` methods with `cwd === repositoryPath`: no `checkout`, `reset`, `stash`, `commit`, `clean`, `merge`, `rebase`, `push`, `branch -D`; `deleteRef` only for `refs/prvision/*`.
  - `the token never appears in argv, logs, console events or error_message when every fetch attempt fails` — the clone's named remote and the `https://github.com/…` URL both point (via `insteadOf`) at a missing path, so all three attempts of 07 §5.13.5 run and fail; a runner spy records every git argv; `recordLogger()` lines, `ConsoleRecorder` messages, the row's `error_message` and every argv contain neither `ghp_TEST…` nor `AUTHORIZATION` (07 §10).

#### 5.6.6 Sheet 08 — change analysis

Owned files (08 §9): `tests/backend/pipeline/change-analysis/{component-detector,export-closure,change-source,module-resolver,import-graph,change-analysis-service,component-source-queries}.test.ts`, optional `change-source.git.test.ts`, helper `helpers/worktree-fixture.ts` (`makeWorktrees`, `stubGitClient`, `stubPersistence`, `makeContext`).

Sheet 14 additions — new file `tests/backend/pipeline/change-analysis/fixture-branches.test.ts`. It builds base/head worktrees with 08's `makeWorktrees` from `MAIN_FILES` and the branch overlays in `BRANCHES` (imported from `tools/fixture-repo/sample-app-files.mjs`), a `stubGitClient` whose `ChangedFile` entries are computed by diffing the two file maps, `stubPersistence()` to capture the inserted rows, and `makeContext` with the fixture's repository settings (`viteConfigPath: "vite.config.ts"`, `tsconfigPath: "tsconfig.app.json"`, `entryFilePath: "src/main.tsx"`, `globalStylePaths: ["/src/index.css"]`). It proves 08 works on a realistic Vite + alias + CSS-module project, and keeps 5.10.6 honest:

- `feature/button-restyle yields Card, Button, Badge and UserMenu in rank order` — candidates exactly (rank, filePath, exportName, changeKind, reason): 0 `src/components/Card.tsx` `default` modified "Component code changed"; 1 `src/components/Button.tsx` `default` modified "Component code changed"; 2 `src/components/Badge.tsx` `Badge` added "New file"; 3 `src/components/UserMenu.tsx` `default` affected_parent "Imports changed hook src/auth/useAuth.ts" with `codeDiff === null`. No `Dashboard`, `App`, `ProfileCard`; `main.tsx`, `useAuth.ts`, `useDisclosure.ts`, `format.ts` are never candidates; `skipped` is empty.
- `persisted rows carry change_reason on every row and no skip_reason` — the captured inserts for `feature/button-restyle` have `changeReason` equal to each candidate's `reason`, `skipReason: null`, `renderStatus: "pending"`; `componentCount` written as 4.
- `qa/render-failure yields only Card modified`.
- `qa/no-visual-change yields only Button modified` — the refactor changes Button's export closure (not formatting-only), so it is a candidate.
- `qa/css-module-only yields ProfileCard modified with the stylesheet diff` — co-located CSS module ⇒ `modified` (08 §5.11, direct style owner), `exportName "ProfileCard"`, reason "Uses changed stylesheet src/components/ProfileCard/ProfileCard.module.css", `codeDiff` contains the `.module.css` hunk.
- `qa/dependency-drift yields only Button modified and warns about package.json` — `package.json` is outside `src/`: listed in `changedFiles`, one console `warn`, never a candidate.
- `working tree with Button edit and untracked Tag yields Button modified and Tag added` — head = main + `WORKING_TREE_EXTRAS`; `diffNameStatusNoIndex` entries; Tag reason "New file".
- `alias imports resolve through vite.config.ts and tsconfig.app.json` — the `@/auth/useAuth` edge from `UserMenu.tsx` exists (no unresolved-import warning), and `sourceQueries.getModuleExports("src/auth/useAuth.ts", "head")` returns `["fetchCurrentUser", "useAuth"]` (type-only `CurrentUser` excluded) — the input 09's `mock_export_incomplete` check uses for `user-menu-mocked.json`.

#### 5.6.7 Sheet 09 — harness generation

Owned files (09 §9): `tests/backend/harness/{harness-prompts,harness-truncation,harness-context-builder,harness-validator,harness-generation-service,harness-repair,ai-usage-recorder}.test.ts`, helpers `tests/backend/harness/helpers/{fake-ai-provider,fake-source-queries,temp-worktrees}.ts`, fixtures `tests/fixtures/harness/` (Example A/B). 09's list already covers `repairHarness` returning `HarnessRepairOutcome` without writing `visualization_components`, `AiUsageRecorder` serialisation, and the positional `PipelineStepError`.

Sheet 14 additions — new file `tests/backend/harness/fixture-harnesses.test.ts`, so the scripted-AI integration tests can never drift from what the validator accepts. The validator is `new HarnessValidator(sourceQueries, fileExists)` where `sourceQueries` is the real 08 `ChangeAnalysisResult.sourceQueries` from analysing the fixture files in `makeWorktrees` (`main` as base, `feature/button-restyle` as head, plus `WORKING_TREE_EXTRAS` for `tag.json`) and `fileExists` checks the temp worktrees; each `HarnessValidationInput` is built exactly as 09's context builder builds it (`paths`, `viteRootRel: ""`, `targetImportPath(filePath)`, `directImports` from `getDirectImports` per side, `sidesPresent`, `entryFilePath: "src/main.tsx"`):

- `every tests/fixtures/harnesses/sample-react-app/*.json passes HarnessValidator` — `report.ok === true` for each file (one test per file).
- `user-menu-mocked.json produces only the mock_export_incomplete warning` — no errors; the single warning names `fetchCurrentUser`.
- `tests/fixtures/ai/harness-no-default-export.json is rejected with missing_default_export`.
- `tests/fixtures/ai/harness-uses-fetch.json is rejected with network_api`.
- `tests/backend/harness/ai-usage-recorder.test.ts` → `no other backend source writes aiUsage` — static scan of `backend/src/**/*.ts`: an `aiUsage` key inside a `.update(` values literal appears only in `ai-usage-recorder.ts` (00 §14.7: 07 and 11 never write the column directly).

#### 5.6.8 Sheet 10 — render engine

Owned files (10 §9): `tests/backend/render/{vite-mock-plugin,render-groups,vite-loader,vite-server-config,harness-workspace,vite-host-client,render-errors,browser-session.helpers,render-service}.test.ts`, `tests/backend/integration/render-engine.integration.test.ts` (real Vite + Chromium, self-contained components copied into a copy of the fixture; gated on `PRVISION_IT_RENDER` / `PRVISION_INTEGRATION` through this sheet's `itSkip`; it must locate the fixture with `requireFixtureRepo()` / `fixturePath()` from `integration/helpers/fixture.ts`, because under the preload `DATA_DIR` is a temp dir and the fixture lives under `PRVISION_REAL_DATA_DIR`), helpers `tests/backend/render/helpers/{render-stubs,fake-vite-package}.ts`. 10's list already covers the repair rule (one-side failure of a two-sided component → `partial`, no repair; both sides failing → one repair with a `HarnessRenderError`), `chooseAttempt`, and persistence through `update(values, { id, visualizationId }, Table.VISUALIZATION_COMPONENTS)`.

Sheet 10's integration file and this sheet's `integration/render/*` complement each other: 10's uses test-owned components to prove engine mechanics (pixels, mocks, portals, off-origin blocking, cleanup); this sheet's use the fixture's real components and harness files to prove the end-to-end outcomes in 5.10.6.

Sheet 14 additions:

- `render/render-service.test.ts` → `persisted errors and console events contain no secrets and no absolute data-dir or worktree paths` — scripted outcomes whose messages embed `ghp_TEST…` and `<dataDir>/worktrees/…`; `InMemoryPersistence` payloads (`baseError`/`headError`) and console events pass `assertNoSecrets` and contain neither path prefix (10 §5.12.3 strips paths; 04 `redactSecrets`).
- `render/render-service.test.ts` → `buildRenderInputs over the fixture's feature/button-restyle candidates keeps rank order and sets basePath` — candidates from 5.6.6 and the four fixture harnesses → four inputs in rank order (Card, Button, Badge, UserMenu); `basePath` is `null` only for Badge (added) and equals `filePath` otherwise; a candidate without a harness is omitted.
- `render/harness-workspace.test.ts` → `every tests/fixtures harness file writes cleanly` — each `harnessSource` from 5.5 passes `writeComponentHarness` (pragma handling) unchanged otherwise.

#### 5.6.9 Sheet 11 — image diff, structural diff, AI summary

Owned files (11 §9): `tests/backend/pipeline/diff-summary/{png-utils,image-diff-service,structural-diff-service,summary-prompts,summary-service}.test.ts`, helper `helpers/png-fixtures.ts` (`solidPng`/`withRect` re-export the shared builders, 5.4.7; `memoryArtifactStore`, `recordingQueryHandler`, `fakeAiProvider` stay 11's). 11's list already covers "never writes `visualizations.changed_count`", `visual_change = null` for not-compared pairs, `AiUsageRecorder` use including `AiProviderError.usage`, and the decode limits.

Sheet 11 already covers padding bands, transparent pixels and anti-aliasing explicitly. Note for implementers: pixelmatch blends alpha against a background, so 11 never runs pixelmatch on the size-difference band. It pads conceptually with fully transparent pixels and counts band pixels explicitly: a band pixel counts only when the real pixel's alpha > 0 (11 §5.2.2 steps 3 and 5). 11's "transparent band pixels are not counted" and "taller head counts the white band as changed" cases test that explicit band accounting; there is no opaque sentinel.

Sheet 14 additions:

- `image-diff-service.test.ts` → `noise images with the same seed give ratio 0, different seeds give ratio > 0.9` (`noisePng`).
- `image-diff-service.test.ts` → `a 1280×4000 pair (render max height, within DIFF_MAX_WIDTH × DIFF_MAX_HEIGHT) is diffed, not refused` — classification `compare`, ratio computed; duration reported with `t.diagnostic` (the time budget lives in 5.14; unit tests assert no timings, 5.12 rule 3).
- `summary-service.test.ts` → `tests/fixtures/ai/summary-valid.json is persisted; summary-unknown-component.json drops the unknown id with a warning; summary-invalid-risk.json fails schema validation as invalid_output` — scripted through `ScriptedAiProvider`, which validates data against the summary schema like the real providers (5.4.8); the invalid file takes 11's failure path (`summary_markdown = null`, console warning, usage recorded). Keeps the shared fixture files honest.
- `summary-service.test.ts` → `summary, notes and console warnings never contain secrets` — code diffs containing `ghp_TEST…` are not echoed into console events (prompt content is allowed to contain the diff).

#### 5.6.10 Sheet 14 — self-tests

See section 9.

### 5.7 Conventions for writing backend tests

1. **Imports**: `import test from "node:test"; import assert from "node:assert/strict";`. Use `test(name, async (t) => …)`; use `t.after()` for cleanup and `describe` only when grouping a table.
2. **Patching**: patch `QueryHandler.prototype` (or a service's `queryHandler` field) and infrastructure statics with `patchStaticMethod`; always restore in `finally` or `t.after`. Never patch inside module scope.
3. **No real network, DB, Redis, AI, GitHub** in `tests/backend`. The network guard throws; Redis/DB URLs point at unused ports and pools are lazy (sheet 04).
4. **Config is fixed at import** (00 §14.12): never assign `process.env.*` in a test. Use `collectConfigValidationErrors(overrides)`, constructor options / injected dependencies (`new ArtifactStore(useTempDataDir(t))`, `now`, runners, ports) or `Encryption.setKeyForTesting(secret)` restored with `setKeyForTesting(null)` in `t.after`.
5. **Real git is allowed** but only inside `makeTempDir`/`createTempGitRepo` directories, with `isolatedGitEnv()`; such tests skip when `git --version` fails. File naming follows the owning sheet (`*.integration.test.ts` for 07's and this sheet's real-git files).
6. **Time**: inject clocks (`now: () => Date`) or use `mock.timers` from `node:test` (`t.mock.timers.enable({ apis: ["setTimeout", "Date"] })`). No real sleeps above 50 ms; no `setTimeout`-based waiting for conditions.
7. **Randomness**: seeded (`noisePng(seed)`); never assert on random ids.
8. **Assertions**: `assert.deepEqual` on whole view objects where practical (catches extra fields leaking); for errors use `assert.rejects(promise, { name, message: /…/ })` or check `response.status` **and** `response.error_reason` together, against the 00 §14.12 status for that reason (e.g. `400 github_unauthorized`, `409 conflict`, `429 github_rate_limited`; never 401).
9. **Logs**: assert through `recordLogger()` (which subscribes to 04's `logTestStream`); never patch a logger and never read stdout.
10. **Pipeline fakes match the contracts**: fakes throw `new PipelineStepError(stage, userMessage, { code?, detail?, cause? })` positionally with a non-terminal stage; job signals are aborted with the string reasons `"cancelled"`/`"shutdown"` (`makeJob`, `createPipelineContext`) and code is asserted via `jobAbortReason(signal)`; repair fakes return a `HarnessRepairOutcome` (`{ ok: true, result }` or `{ ok: false, reason, message, notesAppendix? }`), never `null`.
11. **One behaviour per test**; table-driven tests loop to create one `test` per row so failures name the row.
12. **Speed**: each test < 500 ms (warn), < 2 s (hard; tests over 2 s move to integration or get fixed). Whole backend unit suite < 60 s.
13. **Secrets in tests** are fake and recognisable: `ghp_TEST0000000000000000000000000000000000`, `sk-ant-test-0000000000`, never copied from a real account.
14. **Lint and types**: `tests/**` is covered by the backend ESLint/Prettier config and by `npm run typecheck` through `tsconfig.eslint.json` (sheet 01 §5.2.1, 02).
15. **Integration tests**: flag-gated render/AI tests live under `tests/backend/integration/` and gate every test with `itSkip(...)` (5.8). The real-git `*.integration.test.ts` files of 07 and this sheet (skipped when `git --version` fails) and 03's `migrations.integration.test.ts` (skipped unless `PRVISION_TEST_DATABASE_URL` is set) live beside their area's tests; 02's `test:it` glob covers both locations. All must pass `npm run test:backend` as skipped when their flag or prerequisite is missing.

### 5.8 Integration suite (`tests/backend/integration`)

Location follows sheet 01 §5.15 and 00 §14.10 (`tests/backend/integration/`). Gating uses exactly the 00 §14.10 flags: `PRVISION_IT_RENDER=1`, or the umbrella `PRVISION_INTEGRATION=1`, enables render ITs (never the AI flag, which costs money); `PRVISION_IT_AI=1` enables real-AI ITs. Sheet 10's `render-engine.integration.test.ts` uses the same `itSkip("render")`. Real Postgres is covered by sheet 03's own `PRVISION_TEST_DATABASE_URL` tests and is not repeated here.

```ts
// tests/backend/integration/helpers/it-flags.ts
export type ItFlag = "render" | "ai";

function enabled(flag: ItFlag): boolean {
  if (flag === "render") return process.env.PRVISION_IT_RENDER === "1" || process.env.PRVISION_INTEGRATION === "1";
  return process.env.PRVISION_IT_AI === "1";
}

/** Skip reason when a required flag is off: test(name, { skip: itSkip("render") }, fn). */
export function itSkip(...flags: ItFlag[]): string | false {
  const missing = flags.filter((flag) => !enabled(flag));
  if (missing.length === 0) return false;
  // 10 §9.9 expects exactly "set PRVISION_IT_RENDER=1 (needs Chromium and the fixture repo)" for the render gate.
  return `set ${missing.map((f) => (f === "render" ? "PRVISION_IT_RENDER=1 (needs Chromium and the fixture repo)" : "PRVISION_IT_AI=1")).join(" ")}`;
}
```

```ts
// tests/backend/integration/helpers/fixture.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { makeTempDir } from "../../helpers/temp-dir";
import { isolatedGitEnv } from "../../helpers/temp-git-repo";

export const FIXTURE_BRANCHES = [
  "main", "feature/button-restyle", "qa/render-failure", "qa/no-visual-change", "qa/css-module-only", "qa/dependency-drift",
] as const;

export function fixturePath(): string {
  return path.join(process.env.PRVISION_REAL_DATA_DIR!, "fixtures", "sample-react-app");
}

/** Throws a helpful error if the fixture is missing or not installed (flag on ⇒ the developer wants these to run). */
export function requireFixtureRepo(): string {
  const root = fixturePath();
  if (!fs.existsSync(path.join(root, ".git", "prvision-fixture.json"))) {
    throw new Error(`Fixture repo missing at ${root}. Run: npm run fixture:create (node tools/create-fixture-repo.mjs)`);
  }
  if (!fs.existsSync(path.join(root, "node_modules", "vite", "package.json"))) {
    throw new Error("Fixture dependencies missing. Run: npm run fixture:create (node tools/create-fixture-repo.mjs; it re-runs only the install)");
  }
  return root;
}

/** Clones the fixture into a temp dir with all branches local and node_modules symlinked. Never mutates the shared fixture. */
export function cloneFixture(t: TestContext): string {
  const source = requireFixtureRepo();
  const temp = makeTempDir("it-clone");
  const target = path.join(temp.path, "sample-react-app");
  const env = isolatedGitEnv();
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", source, target], { env });
  for (const branch of FIXTURE_BRANCHES.filter((b) => b !== "main")) {
    execFileSync("git", ["-C", target, "branch", "--quiet", branch, `origin/${branch}`], { env });
  }
  execFileSync("git", ["-C", target, "remote", "remove", "origin"], { env });
  fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"), "dir");
  t.after(() => temp.cleanup());
  return target;
}
```

`tests/backend/integration/helpers/it-pipeline.ts` exports `runPipelineInProcess({ t, repositoryPath, source, onStage?, summary? })`. It:

1. installs `InMemoryQueryHandler` and patches `DrizzleDb.transaction` to run the callback directly;
2. seeds the settings row (`makeSettingsRow`; for `github_pr` with `githubTokenEncrypted` = `SettingsStore`'s encryption of `ghp_TEST…` under the preload key), a repository row from the real `ProjectDetectionService.detect(repositoryPath)` (with `githubOwner`/`githubRepo` overrides for the PR case), and the visualization row exactly as `VisualizationsService.create` would (`status "queued"`, `jobId "viz-<id>"`, refs; for `github_pr` the PR is created through the real `VisualizationsService.create` with a real `GitHubClient` over `createFakeGithubPort`, and `QueueService.enqueueVisualization` patched to record);
3. runs the real `new VisualizationWorkerService({ readAiSettings, createProvider: () => scripted, queue: fakeQueueStatics }).run(job)` with `job` from `makeJob(visualizationId)` (00 §14.6). `fakeQueueStatics` answers `isCancelRequested` from the `FakeRedis` key `prvision:cancel:<id>`, and `clearCancel`/`getVisualizationJobState` in memory. Every other dependency and step factory is 07's default: real `WorkspacePrepareService`, `ChangeAnalysisService`, `HarnessGenerationService` (scripted AI returning `tests/fixtures/harnesses/sample-react-app/<kebab displayName>.json` for each candidate), `RenderService` (real Vite + Chromium), `ImageDiffService`, `StructuralDiffService`, `SummaryService` with a scripted `fn` summary built from the component ids in the request;
4. writes worktrees and artifacts under `DATA_DIR`, which is the preload's per-process temp dir (nothing touches `process.env`);
5. calls `onStage(stage, handle)` whenever a console event opens a new stage (through a wrapping `consoleFactory` that also feeds a `ConsoleRecorder`), so tests can cancel (`handle.cancel()` → `job` aborted with `"cancelled"`) at a precise point.

Returns `{ stub, console, dataDir: DATA_DIR, visualizationId, timings }`. No Postgres, Redis or network needed.

Integration catalogue:

Colour policy for render ITs (00 §14.10): the fixture uses Tailwind 4, whose palette is oklch-based (`emerald-600` is `oklch(59.6% 0.145 163.225)`, about `rgb(0, 153, 102)`; `red-500` about `rgb(251, 44, 54)`, not v3's `rgb(239, 68, 68)`). Tests assert pixel-diff ratios first; where a colour matters they assert a **channel relationship** (which channel dominates, by a margin), never an exact RGB value.

`tests/backend/integration/render/render-fixture-button.test.ts` — flags: render
- `renders Button base and head from feature/button-restyle with the known-good harness` — both PNGs exist under `artifacts/<v>/<c>/{base,head}.png` (relative paths in the row), width/height > 0, `diffPixelRatio > 0.01`, `visualChange "changed"`, `diff.png` exists.
- `head button is green-dominant and base button is indigo-dominant` — `dominantColour` of the head image has `G > R + 80` and `G > B + 30` (Tailwind v4 `emerald-600`); of the base image `B > R + 100` and `B > G + 100` (the fixture's `--color-brand-600: #4f46e5`). No exact RGB comparison.

`tests/backend/integration/render/render-mock-plugin.test.ts` — flags: render
- `mocked @/auth/useAuth replaces the real module through real Vite` — `user-menu-mocked.json`; captured DOM text contains `MOCKED Grace`; no page request to `/api/me`.
- `seeded QueryClient renders UserMenu without network` — `user-menu.json`; base shows `Ada` / `A`, head shows `Ada Lovelace` / `AL` (feature branch `useAuth` change), `visualChange "changed"`.

`tests/backend/integration/render/render-failure.test.ts` — flags: render
- `qa/render-failure: Card head fails, base renders, status partial` — `renderStatus "partial"`, `headError` contains `intentional render failure`, `baseImagePath` set, `headImagePath` null; `repairHarness` is not called because a one-side failure of a two-sided component is never repaired (00 §14.7, 10 §9.8).
- `structural diff is computed for the failed component` — `visualChange` is `null` (not compared, 00 §14.3) and `structural_diff` contains a change `{ kind: "element_added", tag: "p" }` (the "Last updated today" line; `element_added` carries no text) and no `element_removed` (11 runs structural diff when either side has no pixel output, 11 §5.3.1).

`tests/backend/integration/render/render-determinism.test.ts` — flags: render
- `rendering the same side twice yields ratio 0` — base Button rendered in two sessions → `diffPixelRatio === 0`.
- `qa/no-visual-change: refactored Button renders pixel-identical` — ratio 0, `visualChange "unchanged"`.

`tests/backend/integration/pipeline/fixture-detection.test.ts` — flags: render (needs the installed fixture)
- `ProjectDetectionService detects the fixture exactly` — `framework "react_vite"`, `packageManager "npm"`, `viteConfigPath "vite.config.ts"`, `tsconfigPath "tsconfig.app.json"`, `entryFilePath "src/main.tsx"`, `globalStylePaths ["/src/index.css"]`, `defaultBranch "main"`, `githubOwner/githubRepo null`.

`tests/backend/integration/pipeline/pipeline-local-branch.test.ts` — flags: render
- `feature/button-restyle completes with the expected components` — status `completed`, `failedStage null`; components, ranks, `changeReason`s and outcomes match 5.10.6; `componentCount === 4`, `changedCount === 4`; `baseSha` equals the merge-base; worktrees removed; artifacts present; `ai_usage` equals the sum of the scripted harness and summary usages (written only through `AiUsageRecorder`).
- `stage console events appear in pipeline order` — first event per stage follows `preparing → … → summarizing`.
- `wall time within budget` — logged always; fails only above 2× the budget in 5.14.

`tests/backend/integration/pipeline/pipeline-working-tree.test.ts` — flags: render
- `uncommitted Button change and untracked Tag component are visualised` — clone, edit `Button.tsx` (`bg-brand-600` → `bg-rose-600`), add `src/components/Tag.tsx`; Button `changed`, Tag `new`; the clone's `snapshot()` is identical before and after.

`tests/backend/integration/pipeline/pipeline-github-pr.test.ts` — flags: render
- `PR from a bare origin with refs/pull/1/head completes like the local-branch run` — the clone is pushed to a bare repo with `setPullRef(1, <feature sha>)`. To keep git off the network, the clone's `origin` URL is `https://github.com/acme/sample-react-app.git` and its **local** config has `url.<bare path>.insteadOf=https://github.com/acme/sample-react-app.git`, so every PRVision fetch attempt (the named remote, then the `https://github.com/…` URL used by both token attempts, 07 §5.13.5) resolves to the bare repo; before the run the test proves the rewrite with `git -c protocol.https.allow=never ls-remote https://github.com/acme/sample-react-app.git refs/pull/1/head` (fails instead of reaching the network if the rewrite is missing; the test then fails with that message). Fake `GitHubRestPort` returns PR #1 with the fixture's head/base shas; outcome equals the local-branch run; during the run `refs/prvision/pr-1` and `pr-1-base` exist, afterwards no `refs/prvision/*` remain.

`tests/backend/integration/pipeline/pipeline-cancel.test.ts` — flags: render
- `cancel during rendering stops within 10 s and cleans up` — once the first component row has a `base_image_path`, abort the job with `handle.cancel()` (reason `"cancelled"`, what 04's poller does on the Redis flag); status `cancelled`, `failedStage "rendering"`; rows still `pending` swept to `skipped` with a `skipReason` (07); worktrees removed; no Vite or Chromium process whose command line contains the worktree path remains; already-written artifacts kept.
- `shutdown during rendering fails the run` — same setup with `handle.shutdown()`; status `failed` with 07's "Worker stopped…" message, `failedStage "rendering"`, cleanup as above.

`tests/backend/integration/pipeline/pipeline-dependency-drift.test.ts` — flags: render
- `qa/dependency-drift reports drift and still renders` — `PreparedWorkspace.dependencyDrift === true`; console warn mentions dependencies; Button `changed`.

`tests/backend/integration/ai/anthropic-api.test.ts` — flags: ai; skips with a reason when `ANTHROPIC_API_KEY` is unset
- `connection test succeeds` — real API through `AiProviderFactory.create(settings)` with `settings.anthropicApiKey = { state: "present", value: <env key> }` and 05's connection test (effort `low`); result has `provider`, `model`, `latencyMs`.
- `harness generation for the fixture Button and UserMenu passes post-validation and reuses the prompt cache` — real `HarnessGenerationService` (`anthropic_api`, model from `PRVISION_IT_AI_MODEL`, default `claude-opus-5-5`) on the fixture clone's `feature/button-restyle` candidates; every result's validator report is `ok`; at least one `harness.ai.call` log after the first reports `cacheReadInputTokens > 0` (09 §10 acceptance).
- `summary for two known PNGs returns schema-valid output` — risk is one of the enum values.

`tests/backend/integration/ai/claude-code.test.ts` — flags: ai; skips when `claude` is not on PATH or not logged in
- `connection test succeeds`.
- `provider cannot write files` — prompt asks it to create `pwned.txt` in the working directory; the file does not exist afterwards.

`tests/backend/integration/ai/pipeline-real-ai.test.ts` — flags: render + ai
- `feature/button-restyle with real AI completes with Button changed and a summary` — provider from `PRVISION_IT_AI_PROVIDER` (`anthropic_api` default, or `claude_code`), model from `PRVISION_IT_AI_MODEL` (default `claude-opus-5-5`); asserts loose properties only (status, Button `changed`, summary non-empty and mentions `Button`), within the real-AI budget in 5.14.

AI integration credentials (`ANTHROPIC_API_KEY`, `PRVISION_IT_AI_PROVIDER`, `PRVISION_IT_AI_MODEL`) are read only by these tests, only from the environment, and never logged.

### 5.9 Frontend test catalogue (sheets 12–13)

Stack: Angular 19 standalone + Karma/Jasmine (Uply parity), specs next to the code, run once headless by `npm test --prefix frontend` (02's `karma-chrome.mjs --watch=false`, 00 §14.10). Conventions are sheet 01 §5.15 and sheet 12 §10 / 13 §9: `provideHttpClient(withInterceptors([errorInterceptor]))` + `provideHttpClientTesting()` + `HttpTestingController` (end with `httpMock.verify()`); components via `TestBed` with `fixture.componentRef.setInput(...)`; polling with `fakeAsync` + `tick` + `discardPeriodicTasks()`. HTTP mocks answer with the 00 §14.2 envelope (`{ status, data }` / `{ status, error, error_reason }`), never Uply's raw format.

Owned files (paths under `frontend/src/app/`):

- Sheet 12 §10: `app.component.spec.ts`; `core/services/{api,theme,health,notification,confirm-dialog}.service.spec.ts`; `core/interceptors/error.interceptor.spec.ts`; `core/models/api-error.model.spec.ts`; `core/utils/{error-messages,visualization-status,labels,artifact-url}.util.spec.ts`; `layouts/main-layout/main-layout.component.spec.ts`; `shared/components/{page-header,status-pill,segmented-control,inline-alert,empty-state,generic-popup,not-found-page}/*.component.spec.ts`; `shared/components/data-grid/{data-grid-helpers,action-menu-cell-renderer.component}.spec.ts`; `shared/pipes/*.spec.ts`; one stub spec per feature page (replaced by 13).
- Sheet 13 §9: `core/utils/route-params.util.spec.ts`; `core/services/visualization-launcher.service.spec.ts`; `features/settings/{settings-form,settings-unsaved-changes.guard}.spec.ts`, `features/settings/settings-page/settings-page.component.spec.ts`; `features/repositories/repository-format.spec.ts`, `features/repositories/repository-list/repository-list.component.spec.ts`, `features/repositories/repository-detail/repository-detail.component.spec.ts`, `features/repositories/components/{add-repository-dialog,pull-request-table,local-sources}/*.component.spec.ts`; `features/visualizations/visualization-format.spec.ts`, `features/visualizations/visualization-list/visualization-list.component.spec.ts`, `features/visualizations/visualization-detail/{component-filters,visualization-detail.store,visualization-detail.component}.spec.ts`, `features/visualizations/components/{pipeline-stepper,console-panel,summary-card,component-card,image-compare,structural-diff-list}/*.component.spec.ts`, `features/visualizations/components/code-diff/{unified-diff,code-diff.component}.spec.ts`.

Covered by 12/13 now, no addition: secrets sent as `""` to clear and never `null` (13 `settings-form.spec.ts`, 12 `api.service.spec.ts`), no overlapping detail polls (13 store spec, `exhaustMap`), every `ApiErrorReason` has copy (12 `error-messages.util.spec.ts`), `failedStage` drives the stepper, cancel 200/202/409 toasts (13 list and store specs).

Shared frontend test helpers (this sheet, `frontend/src/testing/`):

```ts
// frontend/src/testing/view-builders.ts — one builder per 00 §9 + §14.4 view; fixed ISO dates; Partial overrides.
export const ISO = "2026-01-01T00:00:00.000Z";
export function buildSettingsView(o: Partial<SettingsView> = {}): SettingsView {
  return { hasGithubToken: false, githubLogin: null, aiProvider: "anthropic_api", hasAnthropicApiKey: false,
           aiModel: "claude-opus-5-5", aiHarnessEffort: "high", aiSummaryEffort: "medium", ...o };
}
export function buildComponentView(o: Partial<VisualizationComponentView> = {}): VisualizationComponentView {
  return { id: 1, filePath: "src/components/Button.tsx", exportName: "default", displayName: "Button",
           changeKind: "modified", renderStatus: "rendered", visualChange: "changed", risk: "check", rank: 0,
           baseImageUrl: "/artifacts/1/1/base.png", headImageUrl: "/artifacts/1/1/head.png", diffImageUrl: "/artifacts/1/1/diff.png",
           imageWidth: 320, imageHeight: 120, diffPixelRatio: 0.0123, codeDiff: "@@ -1 +1 @@\n-a\n+b\n", structuralDiff: null,
           aiNote: "Primary colour changed.", harnessSource: null, harnessNotes: null, baseError: null, headError: null,
           changeReason: "Component code changed", skipReason: null, ...o };
}
export function buildVisualizationDetail(o: Partial<VisualizationDetailView> = {}): VisualizationDetailView {
  return { ...buildVisualizationSummary(), baseSha: "0".repeat(40), headSha: "1".repeat(40), errorMessage: null,
           summaryMarkdown: null, aiProvider: "anthropic_api", aiModel: "claude-opus-5-5", aiUsage: null, startedAt: ISO,
           failedStage: null, components: [buildComponentView()], ...o };
}
// buildHealthView, buildGithubTestResult ({ login }), buildAiTestResult ({ provider, model, latencyMs }),
// buildRepositoryView, buildPullRequestView, buildBranchListView, buildVisualizationSummary,
// buildConsoleEvent (stage is a VisualizationStatus value), buildCreateVisualizationResponse,
// buildCancelResponse ({ id, status: "cancelled" | "cancel_requested" }) — same pattern.
```

`frontend/src/testing/api-service.mock.ts` mirrors Uply's `tests/frontend/testing/api-service.mock.ts` with Jasmine: `createApiServiceMock()` returns every `ApiService` method as `jasmine.createSpy(name).and.returnValue(of(<builder default>))` (the unwrapped `data`, as `ApiService` returns it). The builders follow sheet 12's `core/models` names exactly and include every 00 §14.4 field (`failedStage`, `changeReason`, `skipReason`, `tokensAdded`/`tokensRemoved` on `attribute_changed`); if a model gains a field, the builder gains it in the same change.

Sheet 14 additions (cross-cutting; add to the named spec files):

- `features/settings/settings-page/settings-page.component.spec.ts` → `secret inputs are type=password with autocomplete=new-password` (01 §5.14.4; browsers ignore `off` on password fields).
- `features/settings/settings-page/settings-page.component.spec.ts` → `secret values never reach the DOM, console or storage after save` — spy on `console.*` and `localStorage.setItem`; after typing and saving `ghp_TEST…`, neither the DOM nor any spy argument contains it.
- `features/visualizations/components/image-compare/image-compare.component.spec.ts` → `views built for each 5.10.6 fixture outcome render without errors` — table over `changed`, `new` (base null), `deleted` (head null), `partial` with `headError` and `visualChange: null`, `unchanged` (ratio 0).
- `core/utils/error-messages.util.spec.ts` → `API_ERROR_REASONS equals the 00 §14.2 list exactly` — literal array of the 18 reasons in the spec; a reason added to or missing from the frontend list fails here, so the "every reason has copy" case stays complete.
- `core/services/api.service.spec.ts` → `error statuses follow 00 §14.12` — flushing `{ status: 429, error: "…", error_reason: "github_rate_limited" }` and `{ status: 502, …, "github_unavailable" }` yields `ApiError` with that status and reason; a 400 `github_unauthorized` is not treated as a session problem (PRVision has no 401).
- `app.routes.spec.ts` (new, small) → `"" redirects to /repositories`, `every 00 §12 route resolves`, `unknown path renders not-found`.

### 5.10 `tools/create-fixture-repo.mjs` — the sample app fixture

#### 5.10.1 Behaviour

```text
node tools/create-fixture-repo.mjs [--force] [--reset] [--skip-install] [--data-dir <path>] [--pm npm|pnpm|yarn] [--help]
```

| Flag | Meaning |
|---|---|
| (none) | Create the fixture if absent; if present and valid, repair what is missing (install) and print next steps; exit 0. |
| `--force` | Delete the fixture directory (after the safety check) and recreate from scratch. |
| `--reset` | Restore a valid existing fixture to its pristine state: `git checkout -f main`, `git reset --hard <main sha>`, `git clean -fd` (keeps ignored `node_modules`), re-point every fixture branch to its recorded sha (`git branch -f`), delete non-fixture local branches and `refs/prvision/*`, `git worktree prune`. No reinstall. |
| `--skip-install` | Do not run the package manager (used by the unit test of this script). Marker records `installed: false`. |
| `--data-dir <path>` | Overrides `PRVISION_DATA_DIR` (default `~/.prvision`). |
| `--pm` | Package manager for install. Default `npm`. For `yarn`, writes an ignored `.yarnrc.yml` with `nodeLinker: node-modules` so `node_modules` exists. |

Target: `<dataDir>/fixtures/sample-react-app`.

State machine on start:

| State found | Action |
|---|---|
| target missing | full create (5.10.2) |
| marker `.git/prvision-fixture.json` present, `version === FIXTURE_VERSION`, all branches at recorded shas, `node_modules/vite` present | print "Fixture is up to date" + next steps; warn if `git status --porcelain` is non-empty ("uncommitted changes — expected only during the working-tree QA scenario; run `npm run fixture:reset` to discard") |
| marker valid but `node_modules/vite` missing | run install only |
| marker valid but a branch moved/missing | error exit 1: "Fixture branches were modified; run `npm run fixture:reset`" |
| target exists without marker, or with another version | error exit 1: "… was not created by this version of the script; re-run with --force" |
| `--force` | safety check, `rm -rf`, full create |

Safety check before any delete: the resolved target must equal `path.join(resolvedDataDir, "fixtures", "sample-react-app")`, `resolvedDataDir` must not be `/`, the home directory itself, or the PRVision repo root, and the directory must either contain the marker or be empty/nonexistent unless `--force` is given. `--force` on a directory without a marker additionally requires that the directory name is `sample-react-app` under a `fixtures` parent (it always is by construction); it never follows symlinks (`fs.lstatSync` — refuse if the target is a symlink).

Exit codes: `0` success, `1` usage/precondition/state error, `2` install failed (git repo left valid; re-run without `--force` retries the install), `3` required tool missing (`git` or the package manager).

Preconditions checked first: Node `>=22.12` (PRVision's floor per sheet 01; Vite 7 itself needs 20.19+), `git --version` succeeds, and (unless `--skip-install`) the chosen package manager is on `PATH`.

#### 5.10.2 Creation steps

1. `mkdir -p <target>`.
2. `git init -b main` (fallback for git < 2.28: `git init` + `git symbolic-ref HEAD refs/heads/main`). Local config: `commit.gpgsign=false`, `core.autocrlf=false`, `core.hooksPath=<empty temp>` not needed because all git commands run with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
3. Write `MAIN_FILES` (5.10.5), `git add -A`, commit `chore: scaffold sample react app`.
4. For each branch in `BRANCHES` (5.10.5), in order: `git checkout -b <name> main`; for each commit: write/delete files, `git add -A`, commit with its message; then `git checkout main`.
5. Assert `git status --porcelain` is empty and all branches exist.
6. Unless `--skip-install`: run the install (`npm install --no-audit --no-fund`, `pnpm install`, or `yarn install`) with `stdio: "inherit"` in the target. Lockfiles are gitignored, so the tree stays clean.
7. Write `.git/prvision-fixture.json`: `{ "version": FIXTURE_VERSION, "packageManager": "<pm>", "installed": true|false, "branches": { "<name>": "<sha>" }, "createdAt": "<ISO now>" }` (inside `.git`, so never tracked and never dirty).
8. Print the summary and next steps (5.10.7).

Determinism: every commit uses author/committer `PRVision Fixture <fixture@prvision.local>` and a fixed date (`2026-01-01T09:00:00Z` plus one hour per commit, in creation order), files are written with LF endings and mode 0644, and git runs with the global/system config disabled. Therefore every machine produces **identical commit SHAs** for the same `FIXTURE_VERSION`. Tests still resolve refs by name; the stable SHAs simply make bug reports reproducible. Bump `FIXTURE_VERSION` whenever any file content or commit changes.

#### 5.10.3 Script structure

Two files, so tests can import the content without running the CLI:

- `tools/fixture-repo/sample-app-files.mjs` — pure data: `export const FIXTURE_VERSION = 1; export const MAIN_FILES = {...}; export const BRANCHES = [...];` (no side effects, no top-level await; importable from the CommonJS tests via `require(esm)` on Node ≥ 22.12). A sibling `sample-app-files.d.mts` declares the exports (`FIXTURE_VERSION: number`, `MAIN_FILES: Record<string, string>`, `BRANCHES: Array<{ name: string; from: string; commits: Array<{ message: string; files?: Record<string, string>; remove?: string[] }> }>`, `WORKING_TREE_EXTRAS: { modify: Record<string, string>; untracked: Record<string, string> }`) so `npm run typecheck` covers the tests that import it.
- `tools/create-fixture-repo.mjs` — the CLI below. It only runs `main()` when executed directly, so tests may also import `parseArgs`/`resolveDataDir`.

```js
#!/usr/bin/env node
// tools/create-fixture-repo.mjs — creates <dataDir>/fixtures/sample-react-app (sheet 14 §5.10)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BRANCHES, FIXTURE_VERSION, MAIN_FILES } from "./fixture-repo/sample-app-files.mjs";

const FIXTURE_NAME = "sample-react-app";
const BASE_TIME = Date.parse("2026-01-01T09:00:00Z");
const IDENTITY = { name: "PRVision Fixture", email: "fixture@prvision.local" };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_COMMANDS = {
  npm: ["npm", ["install", "--no-audit", "--no-fund"]],
  pnpm: ["pnpm", ["install"]],
  yarn: ["yarn", ["install"]],
};

class FixtureError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

const log = (message) => console.log(`[fixture] ${message}`);

export function parseArgs(argv) {
  const options = { force: false, reset: false, skipInstall: false, dataDir: null, pm: "npm", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") options.force = true;
    else if (arg === "--reset") options.reset = true;
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--pm") options.pm = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new FixtureError(`Unknown argument: ${arg}`);
  }
  if (!INSTALL_COMMANDS[options.pm]) throw new FixtureError(`--pm must be one of npm, pnpm, yarn`);
  if (options.force && options.reset) throw new FixtureError("--force and --reset are mutually exclusive");
  if (options.dataDir === undefined) throw new FixtureError("--data-dir needs a value");
  return options;
}

export function resolveDataDir(flagValue) {
  const raw = flagValue ?? process.env.PRVISION_DATA_DIR ?? path.join(os.homedir(), ".prvision");
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new FixtureError(`Node >= 22.12 is required (found ${process.versions.node})`);
}

function assertTool(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error) throw new FixtureError(`${command} not found on PATH`, 3);
}

let commitCounter = 0;
function gitEnv() {
  const date = new Date(BASE_TIME + commitCounter * 3_600_000).toISOString();
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: date,
  };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o644 });
  }
}

function commit(root, message, { files = {}, remove = [] } = {}) {
  writeFiles(root, files);
  for (const relative of remove) fs.rmSync(path.join(root, relative), { force: true });
  git(root, ["add", "-A"]);
  commitCounter += 1;
  git(root, ["commit", "--quiet", "--no-verify", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function markerPath(target) { return path.join(target, ".git", "prvision-fixture.json"); }

function readMarker(target) {
  try { return JSON.parse(fs.readFileSync(markerPath(target), "utf8")); } catch { return null; }
}

function assertSafeTarget(dataDir, target) {
  const expected = path.join(dataDir, "fixtures", FIXTURE_NAME);
  const forbidden = [path.parse(dataDir).root, os.homedir(), REPO_ROOT];
  if (target !== expected) throw new FixtureError(`Refusing to touch unexpected path ${target}`);
  if (forbidden.includes(dataDir)) throw new FixtureError(`Refusing to use ${dataDir} as the data dir`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new FixtureError(`${target} is a symlink; refusing`);
}

function createRepository(target) {
  fs.mkdirSync(target, { recursive: true });
  try { git(target, ["init", "--quiet", "-b", "main"]); }
  catch { git(target, ["init", "--quiet"]); git(target, ["symbolic-ref", "HEAD", "refs/heads/main"]); }
  git(target, ["config", "commit.gpgsign", "false"]);
  git(target, ["config", "core.autocrlf", "false"]);

  const shas = { main: commit(target, "chore: scaffold sample react app", { files: MAIN_FILES }) };
  for (const branch of BRANCHES) {
    git(target, ["checkout", "--quiet", "-b", branch.name, branch.from]);
    for (const step of branch.commits) shas[branch.name] = commit(target, step.message, step);
    git(target, ["checkout", "--quiet", "main"]);
  }
  const status = git(target, ["status", "--porcelain"]);
  if (status) throw new FixtureError(`Fixture working tree not clean after creation:\n${status}`);
  return shas;
}

function install(target, pm) {
  if (pm === "yarn") writeFiles(target, { ".yarnrc.yml": "nodeLinker: node-modules\n" });
  const [command, args] = INSTALL_COMMANDS[pm];
  log(`Installing dependencies with ${pm} (this takes a minute the first time)…`);
  const result = spawnSync(command, args, { cwd: target, stdio: "inherit", env: process.env });
  if (result.error) throw new FixtureError(`${pm} not found on PATH`, 3);
  if (result.status !== 0) {
    throw new FixtureError(`${pm} install failed (exit ${result.status}). Fix the problem and re-run \`npm run fixture:create\`; it retries the install only.`, 2);
  }
}

function writeMarker(target, data) {
  fs.writeFileSync(markerPath(target), `${JSON.stringify(data, null, 2)}\n`);
}

function branchesMatch(target, marker) {
  return Object.entries(marker.branches).every(([name, sha]) => {
    try { return git(target, ["rev-parse", `refs/heads/${name}`]) === sha; } catch { return false; }
  });
}

function resetFixture(target, marker) {
  git(target, ["checkout", "--quiet", "-f", "main"]);
  git(target, ["reset", "--quiet", "--hard", marker.branches.main]);
  git(target, ["clean", "-fdq"]);
  for (const [name, sha] of Object.entries(marker.branches)) {
    if (name !== "main") git(target, ["branch", "-f", name, sha]);
  }
  const keep = new Set(Object.keys(marker.branches));
  for (const name of git(target, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean)) {
    if (!keep.has(name)) git(target, ["branch", "-D", name]);
  }
  for (const ref of git(target, ["for-each-ref", "--format=%(refname)", "refs/prvision"]).split("\n").filter(Boolean)) {
    git(target, ["update-ref", "-d", ref]);
  }
  git(target, ["worktree", "prune"]);
}

function printNextSteps(target, marker) {
  const branches = Object.keys(marker.branches).join(", ");
  console.log(`
Fixture ready: ${target}
Branches: ${branches}

Next steps:
  1. From the PRVision root: npm run dev, then open http://localhost:4210
  2. Repositories → Add repository → paste: ${target}
  3. New visualization → Local branch → head "feature/button-restyle", base "main"
  4. Manual QA scenarios: docs/specs/14-testing-fixtures-and-qa.md §5.11
  5. Integration tests: npm run test:it

Optional: cd "${target}" && npm run dev   # view the sample app itself at http://localhost:5173
Reset after QA: npm run fixture:reset     Recreate from scratch: npm run fixture:recreate
`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("usage: create-fixture-repo.mjs [--force] [--reset] [--skip-install] [--data-dir <path>] [--pm npm|pnpm|yarn]");
    return 0;
  }
  assertNodeVersion();
  assertTool("git");
  if (!options.skipInstall) assertTool(options.pm);

  const dataDir = resolveDataDir(options.dataDir);
  const target = path.join(dataDir, "fixtures", FIXTURE_NAME);
  assertSafeTarget(dataDir, target);
  const exists = fs.existsSync(target);
  let marker = exists ? readMarker(target) : null;

  if (options.reset) {
    if (!marker || marker.version !== FIXTURE_VERSION) throw new FixtureError("No valid fixture to reset; run npm run fixture:recreate");
    resetFixture(target, marker);
    log("Fixture reset to pristine state.");
    printNextSteps(target, marker);
    return 0;
  }

  if (exists && options.force) {
    log(`Removing ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
    marker = null;
  } else if (exists && (!marker || marker.version !== FIXTURE_VERSION)) {
    throw new FixtureError(`${target} exists but was not created by fixture version ${FIXTURE_VERSION}. Re-run with --force (npm run fixture:recreate).`);
  } else if (exists && !branchesMatch(target, marker)) {
    throw new FixtureError("Fixture branches were modified. Run npm run fixture:reset.");
  }

  if (!marker) {
    log(`Creating ${target}`);
    const branches = createRepository(target);
    marker = { version: FIXTURE_VERSION, packageManager: options.pm, installed: false, branches, createdAt: new Date().toISOString() };
    writeMarker(target, marker);
  } else {
    log("Fixture repository already exists.");
    if (git(target, ["status", "--porcelain"])) {
      log("Warning: uncommitted changes present (expected only during the working-tree QA scenario). Run npm run fixture:reset to discard.");
    }
  }

  const needsInstall = !fs.existsSync(path.join(target, "node_modules", "vite"));
  if (!options.skipInstall && needsInstall) {
    install(target, options.pm);
    marker = { ...marker, packageManager: options.pm, installed: true };
    writeMarker(target, marker);
  } else if (options.skipInstall) {
    log("Skipping dependency install (--skip-install).");
  }

  printNextSteps(target, marker);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`[fixture] ${error.message}`);
    process.exit(error instanceof FixtureError ? error.exitCode : 1);
  });
}
```

#### 5.10.4 `sample-app-files.mjs` structure

```js
// tools/fixture-repo/sample-app-files.mjs — pure data, no side effects.
export const FIXTURE_VERSION = 1;

export const MAIN_FILES = {
  ".gitignore": GITIGNORE,
  "README.md": README,
  "package.json": PACKAGE_JSON,
  "index.html": INDEX_HTML,
  "vite.config.ts": VITE_CONFIG,
  "tsconfig.json": TSCONFIG,
  "tsconfig.app.json": TSCONFIG_APP,
  "tsconfig.node.json": TSCONFIG_NODE,
  "src/vite-env.d.ts": VITE_ENV,
  "src/main.tsx": MAIN_TSX,
  "src/index.css": INDEX_CSS,
  "src/App.tsx": APP_TSX,
  "src/pages/Dashboard.tsx": DASHBOARD_TSX,
  "src/components/Button.tsx": BUTTON_MAIN,
  "src/components/Card.tsx": CARD_MAIN,
  "src/components/UserMenu.tsx": USER_MENU,
  "src/components/ProfileCard/ProfileCard.tsx": PROFILE_CARD,
  "src/components/ProfileCard/ProfileCard.module.css": PROFILE_CARD_CSS_MAIN,
  "src/auth/useAuth.ts": USE_AUTH_MAIN,
  "src/hooks/useDisclosure.ts": USE_DISCLOSURE,
  "src/lib/format.ts": FORMAT_TS,
};

export const BRANCHES = [
  {
    name: "feature/button-restyle", from: "main",
    commits: [
      { message: "style(button): emerald palette and roomier padding", files: { "src/components/Button.tsx": BUTTON_RESTYLED } },
      { message: "feat(badge): add Badge component", files: { "src/components/Badge.tsx": BADGE } },
      { message: "feat(card): header with status badge and footer", files: { "src/components/Card.tsx": CARD_WITH_BADGE } },
      { message: "feat(auth): full display name and two-letter initials", files: { "src/auth/useAuth.ts": USE_AUTH_FULL_NAME } },
    ],
  },
  {
    name: "qa/render-failure", from: "main",
    commits: [{ message: "test(qa): make Card throw during render", files: { "src/components/Card.tsx": CARD_THROWS } }],
  },
  {
    name: "qa/no-visual-change", from: "main",
    commits: [{ message: "refactor(button): extract class maps (no visual change)", files: { "src/components/Button.tsx": BUTTON_REFACTORED } }],
  },
  {
    name: "qa/css-module-only", from: "main",
    commits: [{ message: "style(profile-card): more padding and indigo border", files: { "src/components/ProfileCard/ProfileCard.module.css": PROFILE_CARD_CSS_TWEAKED } }],
  },
  {
    name: "qa/dependency-drift", from: "main",
    commits: [{ message: "chore(deps): add clsx and bolder button label", files: { "package.json": PACKAGE_JSON_WITH_CLSX, "src/components/Button.tsx": BUTTON_BOLD } }],
  },
];

/** Uncommitted edits for the working-tree scenario (QA-09, pipeline-working-tree IT); never committed. */
export const WORKING_TREE_EXTRAS = {
  modify: { "src/components/Button.tsx": BUTTON_ROSE },
  untracked: { "src/components/Tag.tsx": TAG_TSX },
};
```

Each constant is a template string holding exactly the content in 5.10.5 (declare the constants above the exports in the real file; shown here after for readability). Content must use LF line endings and end with a single newline.

#### 5.10.5 File contents

Pinned versions (verified on npm at the time of writing; all exact, no ranges): `react 19.3.0`, `react-dom 19.3.0`, `react-router-dom 7.18.4`, `@tanstack/react-query 5.104.1`, `vite 7.3.6`, `@vitejs/plugin-react 5.2.0`, `tailwindcss 4.3.3`, `@tailwindcss/vite 4.3.3`, `typescript 5.9.3`, `@types/react 19.3.0`, `@types/react-dom 19.3.0`, `@types/node 22.20.5`. Vite 7 is chosen over 8 deliberately: it is the most common major in real projects and exercises the "target repo's own Vite" path; Vite 7 is the top of the supported range (Vite 4–7, 02 §6.7 `SUPPORTED_VITE_MAJOR_MIN`/`MAX`, 10 §5.5.2; 8 only warns as untested). Bumping versions requires bumping `FIXTURE_VERSION`.

`GITIGNORE` → `.gitignore`

```gitignore
node_modules
dist
*.log
.DS_Store
.vite
# Lockfiles are generated by the install step and intentionally untracked so
# commit SHAs are identical on every machine. Their presence on disk still
# drives package-manager detection.
package-lock.json
pnpm-lock.yaml
yarn.lock
.yarnrc.yml
.yarn
.pnp.*
```

`README` → `README.md`

```markdown
# sample-react-app

PRVision fixture. Generated by `tools/create-fixture-repo.mjs`; do not edit by hand.

Branches:

- `main` — baseline
- `feature/button-restyle` — Button restyle, new Badge, Card markup change, useAuth change
- `qa/render-failure` — Card throws during render
- `qa/no-visual-change` — Button refactor with identical output
- `qa/css-module-only` — ProfileCard CSS module tweak
- `qa/dependency-drift` — package.json adds a dependency; Button label weight change
```

`PACKAGE_JSON` → `package.json`

```json
{
  "name": "sample-react-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b"
  },
  "dependencies": {
    "@tanstack/react-query": "5.104.1",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-router-dom": "7.18.4"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@types/node": "22.20.5",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "tailwindcss": "4.3.3",
    "typescript": "5.9.3",
    "vite": "7.3.6"
  }
}
```

`PACKAGE_JSON_WITH_CLSX` (branch `qa/dependency-drift`) is identical except `"dependencies"` gains `"clsx": "2.1.1"` (inserted alphabetically after `@tanstack/react-query`). `clsx` is not imported anywhere, so rendering still works with the main branch's `node_modules`.

`INDEX_HTML` → `index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sample React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`VITE_CONFIG` → `vite.config.ts`

```ts
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
```

`TSCONFIG` → `tsconfig.json`

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]
}
```

`TSCONFIG_APP` → `tsconfig.app.json`

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "types": ["vite/client"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

`TSCONFIG_NODE` → `tsconfig.node.json`

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "types": ["node"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

`VITE_ENV` → `src/vite-env.d.ts`

```ts
/// <reference types="vite/client" />
```

`MAIN_TSX` → `src/main.tsx`

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

`INDEX_CSS` → `src/index.css`

```css
@import "tailwindcss";

@theme {
  --font-sans: ui-sans-serif, system-ui, sans-serif;
  --color-brand-50: #eef2ff;
  --color-brand-600: #4f46e5;
  --color-brand-700: #4338ca;
}

body {
  @apply bg-slate-50 font-sans text-slate-900 antialiased;
}
```

`APP_TSX` → `src/App.tsx`

```tsx
import { Route, Routes } from "react-router-dom";
import Dashboard from "@/pages/Dashboard";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  );
}
```

`DASHBOARD_TSX` → `src/pages/Dashboard.tsx`

```tsx
import Card from "@/components/Card";
import { ProfileCard } from "@/components/ProfileCard/ProfileCard";
import UserMenu from "@/components/UserMenu";

export default function Dashboard() {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Sample Dashboard</h1>
        <UserMenu />
      </header>
      <main className="mx-auto grid max-w-5xl gap-4 p-6 sm:grid-cols-2">
        <Card title="Monthly report" description="Revenue and churn for the last 30 days." actionLabel="Open report" />
        <Card title="Team" description="Invite people and manage roles." actionLabel="Manage team" />
        <ProfileCard name="Ada Lovelace" role="Engineer" stats={{ reviews: 1042, merged: 317 }} />
      </main>
    </div>
  );
}
```

`BUTTON_MAIN` → `src/components/Button.tsx` (on `main`)

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

export default function Button({ variant = "primary", className = "", children, ...rest }: ButtonProps) {
  const variantClass =
    variant === "primary"
      ? "bg-brand-600 text-white hover:bg-brand-700"
      : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50";

  return (
    <button
      type="button"
      className={`inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${variantClass} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
```

`BUTTON_RESTYLED` → `src/components/Button.tsx` (on `feature/button-restyle`): colour and padding change.

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

export default function Button({ variant = "primary", className = "", children, ...rest }: ButtonProps) {
  const variantClass =
    variant === "primary"
      ? "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
      : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50";

  return (
    <button
      type="button"
      className={`inline-flex items-center rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-50 ${variantClass} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
```

`BUTTON_REFACTORED` → `src/components/Button.tsx` (on `qa/no-visual-change`): produces the **exact same** `className` string as `BUTTON_MAIN` for every variant.

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

const BASE_CLASSES = "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary: "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50",
};

export default function Button({ variant = "primary", className = "", children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
```

`BUTTON_BOLD` → `src/components/Button.tsx` (on `qa/dependency-drift`): identical to `BUTTON_MAIN` except `font-medium` → `font-bold`.

`CARD_MAIN` → `src/components/Card.tsx` (on `main`)

```tsx
import Button from "./Button";

export interface CardProps {
  title: string;
  description: string;
  actionLabel: string;
  onAction?: () => void;
}

export default function Card({ title, description, actionLabel, onAction }: CardProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <div className="mt-4 flex justify-end">
        <Button onClick={onAction}>{actionLabel}</Button>
      </div>
    </section>
  );
}
```

`CARD_WITH_BADGE` → `src/components/Card.tsx` (on `feature/button-restyle`): markup change (header/footer), uses the new Badge.

```tsx
import { Badge } from "./Badge";
import Button from "./Button";

export interface CardProps {
  title: string;
  description: string;
  actionLabel: string;
  status?: "new" | "updated";
  onAction?: () => void;
}

export default function Card({ title, description, actionLabel, status = "new", onAction }: CardProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <Badge tone={status === "new" ? "success" : "neutral"}>{status === "new" ? "New" : "Updated"}</Badge>
      </header>
      <p className="px-5 pt-3 text-sm text-slate-600">{description}</p>
      <footer className="flex justify-end px-5 py-4">
        <Button onClick={onAction}>{actionLabel}</Button>
      </footer>
    </section>
  );
}
```

`CARD_THROWS` → `src/components/Card.tsx` (on `qa/render-failure`): throws on every render and adds one element so the structural diff has content.

```tsx
import Button from "./Button";

export interface CardProps {
  title: string;
  description: string;
  actionLabel: string;
  onAction?: () => void;
}

function failOnPurpose(): never {
  throw new Error("PRVision QA: intentional render failure in Card");
}

export default function Card({ title, description, actionLabel, onAction }: CardProps) {
  if (title.length >= 0) failOnPurpose();

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <p className="mt-2 text-xs text-slate-400">Last updated today</p>
      <div className="mt-4 flex justify-end">
        <Button onClick={onAction}>{actionLabel}</Button>
      </div>
    </section>
  );
}
```

`BADGE` → `src/components/Badge.tsx` (added on `feature/button-restyle`; named arrow export)

```tsx
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "warning";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700",
  success: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-800",
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
}

export const Badge = ({ tone = "neutral", children }: BadgeProps) => (
  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>
    {children}
  </span>
);
```

`USER_MENU` → `src/components/UserMenu.tsx` (unchanged on every branch)

```tsx
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/useAuth";
import { useDisclosure } from "@/hooks/useDisclosure";
import Button from "./Button";

export default function UserMenu() {
  const { user, displayName, initials, isLoading, error } = useAuth();
  const menu = useDisclosure(false);

  if (isLoading) {
    return <div className="h-8 w-32 animate-pulse rounded-md bg-slate-200" aria-label="Loading user" />;
  }

  if (error || !user) {
    return <Button variant="secondary">Sign in</Button>;
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={menu.toggle}
        aria-expanded={menu.isOpen}
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 hover:bg-slate-100"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
          {initials}
        </span>
        <span className="text-sm font-medium text-slate-800">{displayName}</span>
      </button>
      {menu.isOpen && (
        <div className="absolute right-0 mt-2 w-48 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          <Link to="/profile" onClick={menu.close} className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
            Profile
          </Link>
          <p className="px-4 py-2 text-xs text-slate-500">{user.email}</p>
        </div>
      )}
    </div>
  );
}
```

`USE_AUTH_MAIN` → `src/auth/useAuth.ts` (on `main`; fetches, so harnesses must seed or mock it)

```ts
import { useQuery } from "@tanstack/react-query";

export interface CurrentUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  const response = await fetch("/api/me", { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to load current user (${response.status})`);
  }
  return (await response.json()) as CurrentUser;
}

export function useAuth() {
  const query = useQuery({ queryKey: ["auth", "me"], queryFn: fetchCurrentUser, staleTime: 60_000 });
  const user = query.data ?? null;

  return {
    user,
    displayName: user ? user.firstName : "Guest",
    initials: user ? user.firstName.charAt(0).toUpperCase() : "?",
    isLoading: query.isLoading,
    error: query.error,
  };
}
```

`USE_AUTH_FULL_NAME` → `src/auth/useAuth.ts` (on `feature/button-restyle`): identical except the return block and staleTime:

```ts
import { useQuery } from "@tanstack/react-query";

export interface CurrentUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  const response = await fetch("/api/me", { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to load current user (${response.status})`);
  }
  return (await response.json()) as CurrentUser;
}

export function useAuth() {
  const query = useQuery({ queryKey: ["auth", "me"], queryFn: fetchCurrentUser, staleTime: 300_000 });
  const user = query.data ?? null;

  return {
    user,
    displayName: user ? `${user.firstName} ${user.lastName}` : "Guest",
    initials: user ? `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase() : "?",
    isLoading: query.isLoading,
    error: query.error,
  };
}
```

`USE_DISCLOSURE` → `src/hooks/useDisclosure.ts`

```ts
import { useCallback, useState } from "react";

export function useDisclosure(initialOpen = false) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((value) => !value), []);
  return { isOpen, open, close, toggle };
}
```

`FORMAT_TS` → `src/lib/format.ts`

```ts
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
```

`PROFILE_CARD` → `src/components/ProfileCard/ProfileCard.tsx` (CSS module component; named export)

```tsx
import { formatCount } from "@/lib/format";
import styles from "./ProfileCard.module.css";

export interface ProfileCardProps {
  name: string;
  role: string;
  stats: { reviews: number; merged: number };
}

export function ProfileCard({ name, role, stats }: ProfileCardProps) {
  return (
    <article className={styles.root}>
      <div className={styles.avatar} aria-hidden="true">
        {name.charAt(0)}
      </div>
      <div>
        <h3 className={styles.name}>{name}</h3>
        <p className={styles.role}>{role}</p>
      </div>
      <dl className={styles.stats}>
        <div>
          <dt>Reviews</dt>
          <dd>{formatCount(stats.reviews)}</dd>
        </div>
        <div>
          <dt>Merged</dt>
          <dd>{formatCount(stats.merged)}</dd>
        </div>
      </dl>
    </article>
  );
}
```

`PROFILE_CARD_CSS_MAIN` → `src/components/ProfileCard/ProfileCard.module.css`

```css
.root {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #ffffff;
}

.avatar {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 9999px;
  background: #e0e7ff;
  color: #3730a3;
  font-size: 20px;
  font-weight: 700;
}

.name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.role {
  margin: 2px 0 0;
  color: #64748b;
  font-size: 13px;
}

.stats {
  display: flex;
  gap: 16px;
  margin: 0;
}

.stats dt {
  color: #94a3b8;
  font-size: 11px;
  text-transform: uppercase;
}

.stats dd {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  text-align: right;
}
```

`PROFILE_CARD_CSS_TWEAKED` (on `qa/css-module-only`): identical except in `.root` `padding: 16px` → `padding: 24px` and `border: 1px solid #e2e8f0` → `border: 2px solid #c7d2fe`, and in `.avatar` `background: #e0e7ff` → `background: #c7d2fe`.

`TAG_TSX` → `src/components/Tag.tsx` — not committed on any branch. Exported through `WORKING_TREE_EXTRAS` (5.10.4) as `untracked`, next to `modify` = `BUTTON_ROSE` (`BUTTON_MAIN` with `bg-brand-600 text-white hover:bg-brand-700` → `bg-rose-600 text-white hover:bg-rose-700`), so the working-tree IT, the 08 cross-check and QA-09 apply exactly the same edit.

```tsx
import type { ReactNode } from "react";

export interface TagProps {
  children: ReactNode;
}

export default function Tag({ children }: TagProps) {
  return <span className="inline-block rounded bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">{children}</span>;
}
```

#### 5.10.6 Expected pipeline outcomes on the fixture

Derived from sheet 08's rules: only changed **non-component** exports (hooks, utilities) and changed stylesheets seed affected parents; a changed component does not propagate to the components that render it; propagation stops at the nearest component-bearing importer; a co-located CSS module change makes its owning component `modified`; ranking is 08 §5.12 (group `modified` < `added` < `removed` < `affected_parent`, then BFS depth ascending for `affected_parent`, then diff size descending, then `filePath`, then `exportName` with `default` first); `MAX_COMPONENTS = 12`, so nothing is skipped. Render outcomes follow 10 and 00 §14.7 (a one-side failure of a two-sided component is `partial` and never repaired). Visual outcomes assume harnesses like those in `tests/fixtures/harnesses/` (UserMenu seeds the query cache; if a harness mocks `useAuth` wholesale, UserMenu shows `unchanged`, which is acceptable for real-AI runs only). `visualChange = null` means "not compared" and `changedCount` = changed + new + deleted (00 §14.3, written by 07). Every run below ends `completed` with `failedStage = null`; every row has a `changeReason` and `skipReason = null`.

Import graph: `main.tsx → App → Dashboard → {Card, UserMenu, ProfileCard}`; `Card → {Button, Badge*}`; `UserMenu → {Button, @/auth/useAuth, @/hooks/useDisclosure}`; `ProfileCard → {ProfileCard.module.css, @/lib/format}`. (* Badge only on `feature/button-restyle`.)

| Head vs `main` | Rank | Component (`exportName`) | changeKind | `changeReason` | renderStatus | visualChange | Notes |
|---|---|---|---|---|---|---|---|
| `feature/button-restyle` | 0 | Card (`default`) | modified | Component code changed | rendered | changed | header + badge + footer; Button inside also restyled |
| | 1 | Button (`default`) | modified | Component code changed | rendered | changed | emerald, `px-5 py-2.5`, `rounded-lg`, `font-semibold` |
| | 2 | Badge (`Badge`) | added | New file | rendered (head only) | new | |
| | 3 | UserMenu (`default`) | affected_parent | Imports changed hook src/auth/useAuth.ts | rendered | changed | `codeDiff null`; full name + two initials |
| | | — | | | | | `componentCount 4`, `changedCount 4`; Dashboard, App, ProfileCard are not candidates |
| `qa/render-failure` | 0 | Card (`default`) | modified | Component code changed | partial (head failed) | null | `headError` contains `intentional render failure`; no repair (one-side failure); structural diff has `element_added` with tag `p`; summary risk ≥ `check` (11 risk floor); `changedCount 0` |
| `qa/no-visual-change` | 0 | Button (`default`) | modified | Component code changed | rendered | unchanged | ratio 0; risk `none`; summary is 11's fixed text "PRVision rendered 1 component(s) and found no visual differences …"; no summary AI call; `changedCount 0` |
| `qa/css-module-only` | 0 | ProfileCard (`ProfileCard`) | modified (direct style owner) | Uses changed stylesheet src/components/ProfileCard/ProfileCard.module.css | rendered | changed | `codeDiff` includes the `.module.css` hunk |
| `qa/dependency-drift` | 0 | Button (`default`) | modified | Component code changed | rendered | changed | bold label; console warns about dependency drift and the `package.json` change; `dependencyDrift true` |
| working tree (QA-09 / IT) | 0 | Button (`default`) | modified | Component code changed | rendered | changed | rose background (uncommitted edit) |
| | 1 | Tag (`default`) | added | New file | rendered (head only) | new | untracked file `src/components/Tag.tsx` (`TAG_TSX` in 5.10.5); `changedCount 2` |

#### 5.10.7 Output

Normal run (abridged):

```text
[fixture] Creating /home/me/.prvision/fixtures/sample-react-app
[fixture] Installing dependencies with npm (this takes a minute the first time)…
…npm output…

Fixture ready: /home/me/.prvision/fixtures/sample-react-app
Branches: main, feature/button-restyle, qa/render-failure, qa/no-visual-change, qa/css-module-only, qa/dependency-drift

Next steps:
  1. From the PRVision root: npm run dev, then open http://localhost:4210
  …
```

### 5.11 Manual E2E QA checklist

Run after wave 5 lands, after any change to sheets 07–11, and before calling the prototype done. Record results in a copy of this checklist (date, commit, pass/fail, notes) — do not edit this sheet. Budget ≈ 45–60 min with real AI.

#### 5.11.1 Preconditions

- [ ] `docker compose up -d` (Postgres on 5433, Redis on 6380) and `npm run db:migrate` succeeded.
- [ ] `npm run fixture:create` printed "Fixture ready" (or `npm run fixture:reset` if it already existed).
- [ ] `npm run dev` running; `http://localhost:4210` loads; `curl -s http://127.0.0.1:3100/api/health` returns HTTP 200 with `status: "ok"`.
- [ ] Settings configured with a working AI provider (one of: Anthropic key, or Claude Code logged in) and, for QA-04/QA-10, a GitHub fine-grained token with read access to one of your repos that has an open UI PR.
- [ ] Note `PRVISION_DATA_DIR` (default `~/.prvision`) for the disk checks below.

Common disk checks referenced below ("**post-run checks**"):

1. `ls <dataDir>/worktrees/` has no directory for the visualization id.
2. `ls <dataDir>/artifacts/<id>/` has one folder per rendered component with the expected PNGs.
3. In the registered clone: `git status` unchanged from before the run, `git branch` unchanged, `git worktree list` shows only the main worktree, `git stash list` unchanged, `git for-each-ref refs/prvision` empty.

#### 5.11.2 Scenarios

| ID | Scenario | Steps | Expected result |
|---|---|---|---|
| QA-01 | First boot, empty state | Fresh DB. Open `/`. | Redirects to `/repositories`; empty state with "Add repository"; nav shows Repositories, Visualizations, Settings; theme toggle works and persists across reload; health pill online; no errors in browser devtools. |
| QA-02 | Settings — AI provider | Provider `anthropic_api`, paste key, Save, reload, "Test AI". Switch to `claude_code`, Save, "Test AI". | After save the key input is empty with a "saved" indicator; reload shows the same; the key is never visible in the UI, in `GET /api/settings`, or in backend logs. Test shows model + latency. Claude Code shows the policy note, hides the key field and tests OK when logged in. |
| QA-03 | Settings — secret semantics | Change only the model, Save. Then "Remove" the Anthropic key (and Undo once, then Remove again and Save). Then type whitespace only into the key field. | Model saved and key still saved (request body has no key field). Remove shows pending-clear with Undo; after Save the indicator disappears. Whitespace-only input is rejected (validation message), nothing changes. |
| QA-04 | Settings — GitHub token | Paste a token, "Save & test". Then paste an invalid token and test. | "Connected as @login" (`POST /api/settings/test-github` → 200 `{ login }`). Invalid token → HTTP 400 `github_unauthorized` and the copy telling you to update the token (never a 401 or a logout); previously saved token unaffected until you save. |
| QA-05 | Repository add and detection | Add the fixture path (also once as `~/.prvision/fixtures/sample-react-app/` with `~` and trailing slash). Then try: a non-existent path, `/tmp` (not git), a sub-folder of the fixture (`…/src`), a git repo without React/Vite, the fixture path again, a React+Vite repo without `node_modules`. | Fixture detected: React + Vite, npm, `vite.config.ts`, `tsconfig.app.json`, entry `src/main.tsx`, global styles `/src/index.css`, default branch `main`, no GitHub remote (info alert). `~` and trailing slash normalised. Errors show title + tip: validation (missing path), not a git repo (also for the sub-folder), unsupported framework, already registered (409 `conflict`), install dependencies first (all other errors are HTTP 400). |
| QA-06 | Repository redetect and delete | Redetect the fixture. Delete a second test repo. Re-add it. | `lastDetectedAt` updates. Delete asks for confirmation, returns `200 { id }` and removes it from the list; re-add works (soft-delete uniqueness, new id). Delete is refused (409 `conflict`) while one of its visualizations is queued or running. |
| QA-07 | Local branch visualization (happy path) | Fixture → Local tab → head `feature/button-restyle`, base `main` → Visualize. Watch the detail page until done. | Stepper walks queued → preparing → analyzing → generating harnesses → rendering → diffing → summarizing → completed; console events stream (1.5 s cadence) without reload. Components exactly as 5.10.6, in rank order Card, Button, Badge (New), UserMenu, each card showing its change reason (UserMenu: "Imports changed hook src/auth/useAuth.ts"). Button: base indigo/compact vs head emerald/roomier; diff highlights the button. Summary present and mentions the Button restyle and the new Badge; per-component notes and risk pills. Post-run checks pass. Polling stops after completion (devtools network goes quiet after one final console fetch). |
| QA-08 | Image compare modes | On Button from QA-07 use every mode; drag the slider with mouse and with arrow keys; zoom 100%. On Badge try the comparison modes. | Side-by-side, slider (clip follows pointer and keys; `aria-valuetext` updates), diff overlay with opacity, diff-only, 100% zoom scrolls. Badge: base placeholder ("new component"), slider and diff disabled. Harness source and notes are viewable in the component card. |
| QA-09 | Working tree change | In the fixture: `git checkout main`, apply `WORKING_TREE_EXTRAS` by hand (edit `Button.tsx` `bg-brand-600 … hover:bg-brand-700` → `bg-rose-600 … hover:bg-rose-700`; create `src/components/Tag.tsx` from 5.10.5). Refresh the repository page → Working tree → Visualize. | Before editing, the working-tree card is disabled with the "clean" copy; after editing it shows "Changes detected" (the page reloads branches on window focus). Result: Button changed (rose), Tag new; head shows "working tree". Afterwards the fixture still has the uncommitted edit and the untracked file exactly as left (no stash/reset). Run `npm run fixture:reset` afterwards. |
| QA-10 | GitHub PR on a real repo | Register a real clone of a repo you own (React + Vite, deps installed, GitHub `origin`) with an open PR that changes a component. Pull requests tab → Visualize on the PR. | PR list shows title, author, branches, draft flag, GitHub link. Run completes; head SHA matches the PR head and base SHA is `git merge-base` of the PR base and head (00 §14.7). During the run `git for-each-ref refs/prvision` shows `pr-<n>` and `pr-<n>-base`; after the run both are gone (07 deletes them). Post-run check 3 passes. If a fork PR is available, it also works and shows a fork warning in the console. |
| QA-11 | Cancel | (a) Start QA-07 again; Cancel while `rendering`. (b) Stop the worker, create a visualization (stays `queued`), Cancel it, start the worker. (c) Open a completed run; also `curl -s -X POST http://127.0.0.1:3100/api/visualizations/<id>/cancel` on it. | (a) Cancel returns 202 `cancel_requested` (one "Cancellation requested" toast); status `cancelled` within ~10 s; the stepper marks `rendering` as the stop stage (`failedStage`); console shows the cancellation; components not yet rendered become `skipped` with a skip reason; worktrees removed; artifacts already written kept; no leftover processes (`ps aux \| grep -E "vite\|chrom" \| grep worktrees` is empty). (b) Cancel returns 200 `cancelled` at once, `failedStage` `queued`; the run never starts after the worker restarts. (c) Cancel is not offered; Delete is; the curl returns 409 `already_terminal`. |
| QA-12 | AI misconfigured | (a) Provider `anthropic_api`, remove the key, try to Visualize. (b) Save an invalid but well-formed key (`sk-ant-test-invalid000000`), Visualize. | (a) `POST /api/visualizations` returns 400 `ai_not_configured`; the UI shows the "AI provider not configured" prompt (12 `ERROR_REASON_COPY` title, server message as body) that offers "Open settings". (b) Run fails with "Failed during Generating harnesses" (`failedStage` `generating_harnesses`) and the credentials message on the detail page and in the console; worktrees removed; no secret in any message. Restore the key afterwards. |
| QA-13 | Render failure → structural diff | Fixture → Local, head `qa/render-failure`, base `main`. | Completes (not failed). Card render status `partial`: base image shown, head shows the error `PRVision QA: intentional render failure in Card`; no repair attempt in the console (a failure on one side of a modified component is reported as `partial`, never repaired — 00 §14.7). Visual change shows "not compared". Structural diff section lists an added `p` element. Card risk is at least `check`; summary mentions the failure. |
| QA-14 | Zero visual change | Fixture → head `qa/no-visual-change`, base `main`. | Completes; Button rendered with visual change "unchanged", 0% diff and risk `none`; summary is 11's fixed text "PRVision rendered 1 component(s) and found no visual differences …"; AI usage counts only the harness call(s). |
| QA-15 | CSS module only + dependency drift | Run `qa/css-module-only` and `qa/dependency-drift` against `main`. | CSS: ProfileCard listed as modified with the `.module.css` hunk in its code diff; changed (more padding, indigo border). Drift: console warns that dependencies differ; Button rendered with a bold label. |
| QA-16 | Worker restart recovery | Start QA-07; during `rendering` (a) stop the worker with Ctrl+C, and in a second run (b) `kill -9 <pid>`, then start it again. | (a) The run becomes `failed` with "Worker stopped…" (`failedStage` `rendering`) and the worktrees are removed before exit. (b) On restart the interrupted run becomes `failed` with the restart message, `failedStage` `rendering` and a console event; its worktree directory is gone; `git worktree list` in the fixture shows only the main worktree; no `refs/prvision/*` left. |
| QA-17 | Backend down while polling | During a run, stop the backend for ~10 s, then start it. | UI shows the "API offline"/connection-lost state once (no toast storm), resumes polling when back, and shows the final state. |
| QA-18 | Concurrency 1 | Create two visualizations back-to-back. | The second stays `queued` until the first finishes, then runs. |
| QA-19 | Delete visualization | Delete a completed visualization. Try deleting a running one via `curl -X DELETE`. | Confirmation; `200 { id }`; removed from lists; `<dataDir>/artifacts/<id>` removed; its artifact URLs return 404. Running one → 409 `conflict`. |
| QA-20 | Security spot checks | `curl -s "http://127.0.0.1:3100/artifacts/..%2f..%2f..%2fetc/passwd"`; `curl -s -X POST -H "Origin: http://evil.test" http://127.0.0.1:3100/api/settings/test-ai`; `curl -s -H "Host: evil.test" http://127.0.0.1:3100/api/health`; `ss -ltnp | grep 3100` (macOS: `lsof -iTCP:3100 -sTCP:LISTEN`); grep backend output for `ghp_`, `github_pat_`, `sk-ant-`. | Traversal → 404 without file content. Foreign-origin POST → 403 `forbidden_origin`. Foreign Host → 403. Backend listens on `127.0.0.1` only. No secret-shaped strings in logs. |

#### 5.11.3 Sign-off

QA passes when every scenario passes or has a filed issue with an agreed waiver. Any failure in QA-07, QA-09, QA-11, QA-13, QA-16 or QA-20 blocks sign-off.

### 5.12 Determinism and flakiness policy

Sources of non-determinism and how each is neutralised:

| Source | Policy |
|---|---|
| Wall clock | Services accept `now: () => Date` (default `() => new Date()`); tests pass a fixed clock or use `t.mock.timers`. Stubs (`InMemoryQueryHandler`, `FakeRedis`) default to `2026-01-01T00:00:00Z`. |
| Timers / polling / backoff | Inject `sleep`/`setTimeout`; backend uses `t.mock.timers`, frontend uses `fakeAsync`. No real waits > 50 ms in unit tests. |
| Randomness | Seeded generators only (`noisePng(seed)`); never assert generated ids; IV randomness tested as "differs", not by value. |
| Ordering | DB lists have explicit `ORDER BY`; tests assert order only where the API promises it. Karma runs specs in random order. Backend files run serially (`--test-concurrency=1`); each test leaves global state as it found it (patch restore in `finally`/`t.after`). |
| Filesystem | Every test uses its own temp dir (`prvision-test-*`); macOS `realpath` normalisation; LF endings; no reliance on `~/.prvision`. |
| Git | `isolatedGitEnv()` (no global/system config, fixed identity and dates, no prompts, no hooks, no signing). |
| Network | Guarded; unit tests cannot reach anything but loopback. |
| AI | Never real in unit tests; integration AI tests assert schema validity and loose properties (e.g. "summary mentions Button"), never exact text. |
| Rendering | Same Chromium build for base and head; fixed viewport `RENDER_VIEWPORT` (1280×800) and DPR 1; `reducedMotion: "reduce"`, animations/transitions disabled by CSS; fonts awaited; `locale "en-US"`, `timezoneId "UTC"`, `colorScheme "light"`; network blocked except the Vite server; harnesses cannot use `Date.now`, argless `new Date()`, `Math.random` or `setInterval` (09 validator). Determinism IT (`integration/render/render-determinism.test.ts`) guards this: same input twice must give ratio 0. |
| Process cleanup | Fakes count `create`/`close`; integration tests check for leftover Vite/Chromium processes. |

Flakiness rules:

1. No automatic retries in either suite. A test that fails intermittently is a bug in the test or the code.
2. A flaky test may be quarantined with `test(name, { skip: "flaky: <short reason> (<YYYY-MM-DD>)" }, …)` for at most 7 days while it is fixed; quarantines are listed in the wave-6 audit and must be zero at sign-off.
3. Timing-based assertions use budgets ≥ 2× the expected value and only in integration tests.
4. A unit test that needs > 2 s is moved to integration or rewritten.
5. Re-running `npm run test:backend` and `npm run test:frontend` three times in a row must produce identical results (acceptance criterion).

### 5.13 Test data cleanup

| Data | Created by | Cleaned by |
|---|---|---|
| Per-process data dir `prvision-test-session-*` | `setup.ts` | `process.on("exit")`; stale ones by the `setup.ts` sweep |
| Temp dirs/repos `prvision-test-*` | `makeTempDir`, `createTempGitRepo` | `t.after(cleanup)`; stale (> 2 h) by the `setup.ts` sweep |
| Integration clones and data dirs `prvision-test-it-clone-*` / `prvision-test-data-*` | `cloneFixture`, `it-pipeline.ts` | `t.after`; `setup.ts` sweep |
| Kept artifacts | `PRVISION_KEEP_TEST_ARTIFACTS=1` (00 §14.12) | manual; the session dir path is printed |
| Postgres test DB `prvision_test` | sheet 03's `migrations.integration.test.ts` (`PRVISION_TEST_DATABASE_URL`) | schema dropped and recreated by that test; it refuses database names not ending in `_test` |
| Fixture repo | `fixture:create` | `npm run fixture:reset` (after QA), `npm run fixture:recreate` (full) |
| Manual QA visualizations | the UI | delete in the UI (removes artifacts); or `rm -rf <dataDir>/artifacts/<id>` |
| `refs/prvision/pr-<n>` and `pr-<n>-base` in real clones | github_pr runs | deleted by 07's cleanup after every run; after a crash, worker boot recovery or manually `git for-each-ref --format='%(refname)' refs/prvision \| xargs -n1 git update-ref -d` |
| Stale worktrees after a crash | worker kill | worker boot recovery; manually `git -C <clone> worktree prune` |
| Whole local state | — | `docker compose down -v` and `rm -rf ~/.prvision` (last resort; destroys the fixture too) |

Unit tests never write outside `os.tmpdir()`. A unit test that writes to `~/.prvision` or the repo tree is a bug; `tests/backend/test-support/network-guard.test.ts` also asserts that the `DATA_DIR` constant from `config-consts` starts with `os.tmpdir()` inside tests.

### 5.14 Performance smoke budgets

Measured on a typical developer laptop (8 cores, SSD), warm npm cache, fixture installed. Integration tests fail only above **2× budget** and log the measured value always. Budgets are revisited if hardware differs significantly; log the machine in the QA record.

| Operation | Budget | Measured by |
|---|---|---|
| `npm run test:backend` (backend unit, ≈450 tests) | < 60 s | wall time |
| Single unit test | < 500 ms typical, < 2 s hard | node:test durations (spec reporter) |
| `npm run test:frontend` | < 90 s | Karma |
| `npm run fixture:create` (with install, warm cache) | < 90 s; without install < 3 s | script |
| Workspace prepare on fixture (local branch) | < 5 s | console stage duration |
| Change analysis on fixture | < 2 s | console stage duration |
| Vite cold start for one side | < 8 s | render logs |
| Render one component side (warm server) | < 5 s | `RenderSideResult.durationMs` |
| Image diff 1280×2000 | < 500 ms | `t.diagnostic` from 11's unit tests and the 5.6.9 1280×4000 case (logged, not asserted) |
| Fixture `feature/button-restyle` pipeline, scripted AI (IT) | < 90 s | `integration/pipeline/pipeline-local-branch.test.ts` |
| Fixture `feature/button-restyle` pipeline, real AI (QA-07 / AI IT) | < 6 min | detail page timestamps |
| Cancel to `cancelled` while rendering | < 10 s | `integration/pipeline/pipeline-cancel.test.ts`, QA-11 |
| UI detail page first paint with 20 components | < 1 s | manual |

---

## 6. Error handling and edge cases

Test infrastructure itself:

| Situation | Behaviour |
|---|---|
| `npm run test:backend` glob matches nothing (wrong cwd, typo) | `node --test` exits non-zero ("Could not find …"); never a silently green empty run. |
| `npm run test:it` with the render flag on but the fixture missing | Each render/pipeline integration test fails fast with "Fixture repo missing … run npm run fixture:create" (not skipped: the flag says the developer wants them). |
| `PRVISION_IT_AI=1` without `ANTHROPIC_API_KEY` / `claude` | The corresponding tests skip with an explicit reason; the real-AI pipeline test uses `PRVISION_IT_AI_PROVIDER` and skips if that provider is unavailable. |
| `PRVISION_TEST_DATABASE_URL` set but Postgres down | Sheet 03's DB tests fail with the connection error; start Postgres with `docker compose up -d postgres`. |
| Playwright Chromium not installed | Render integration tests fail with sheet 10's install hint (`npx playwright install chromium`). |
| Karma cannot find Chrome | 02's `karma-chrome.mjs` points `CHROME_BIN` at Playwright's Chromium (5.2.2); if neither exists, Karma's own error is shown — run `npm run setup:browsers`. |
| A test leaks a handle | `--test-force-exit` ends the run; the leaking test is fixed (fakes expose `openCount` / `openPages`). |
| A test forgets to restore a patch | Later tests fail confusingly. Prevention: patches only through helpers with `finally`/`t.after`; the wave-6 audit greps for `patchStaticMethod(` results that are never called. |
| Developer's global git config has signing, hooks or `diff.external` | Helpers and the fixture script run git with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`; temp repos also set `core.hooksPath=/dev/null`. Application code is protected separately by 04's per-call `-c` overrides. |
| Git < 2.31 | Unsupported by PRVision (04); helpers do not try to work around it. |
| macOS `/var` vs `/private/var` | `makeTempDir` and `setup.ts` return `realpath`s. |
| Running `npm test` while `npm run dev` is up | Safe: tests use their own data dir, never connect to Postgres/Redis, and bind only ephemeral loopback ports. |
| A test assigns `process.env.X` and expects config to follow | It does not: constants are evaluated once at import (00 §14.12). Use `collectConfigValidationErrors(overrides)`, constructor options or `Encryption.setKeyForTesting` (5.4.1); the wave-6 audit greps `tests/backend` for `process.env.` assignments outside `setup.ts` and the integration helpers that only read flags. |
| A pipeline fake throws an object-form `PipelineStepError` or aborts a signal without a reason | Code under test misclassifies the failure. Fakes use the positional constructor and `makeJob` / `createPipelineContext` (string reasons); the wave-6 audit greps for `new PipelineStepError({` and `.abort()` without an argument in `tests/backend`. |

Fixture script edge cases: the state table in 5.10.1 (absent / up to date / install missing / branches moved / foreign directory), exit codes, safety checks (symlinked target, unexpected path, home/root/repo used as data dir), `--force` with `--reset`, unknown `--pm`, missing `--data-dir` value, and install failure leaving a valid repo with `installed: false` so a plain re-run only installs.

## 7. Logging

- Tests produce logs at `LOG_LEVEL=debug` into sheet 04's `logTestStream` (04 §9.10), which discards them unless a test records them (`recordLogger()`) or the developer sets `PRVISION_TEST_LOG_STDOUT=1` to see them while debugging (`PRVISION_TEST_LOG_STDOUT=1 npm test --prefix backend -- --test-name-pattern="Workspace"`).
- Tests that assert logging use `recordLogger()` (a `logTestStream` subscription, 00 §14.10); never patch a logger and never assert on stdout.
- Pipeline console events in tests are captured by `ConsoleRecorder`, which provides `assertNoSecrets()` and `assertStagesAreStatusNames()`; every pipeline step's test file has at least one `assertNoSecrets` with the fake token/key values.
- Integration tests print measured stage timings (`[it] feature/button-restyle: preparing 2.1 s, …`) through `t.diagnostic()`, so budgets are visible without failing.
- `tools/create-fixture-repo.mjs` prints `[fixture]` lines for each step, the package manager output verbatim, and the next-steps block; errors go to stderr prefixed `[fixture]`.
- `setup.ts` prints `[setup] kept test data dir: …` only when `PRVISION_KEEP_TEST_ARTIFACTS=1`.

## 8. Security notes

- **No real secrets in the repo.** Test values are fake, recognisable and still valid for the DTOs: `ghp_TEST0000000000000000000000000000000000`, `sk-ant-test-0000000000`, and the `Buffer.alloc(32, 7)` encryption key. `tests/fixtures/README.md` says so; reviewers reject anything real-looking.
- **Network guard** blocks accidental calls to GitHub/Anthropic from unit tests (it also stops fake tokens from ever reaching real services). Only files under `integration/ai/` with `PRVISION_IT_AI=1` bypass it.
- **Real AI tests are opt-in** and read credentials only from the environment, never from files, never logged; they cost money.
- **Secret-leak assertions** across layers: logger redaction (04), console redaction (07), `assertNoSecrets` in pipeline tests, settings failure paths (5.6.3), remote-URL credentials (5.6.4), the Agent SDK child env (5.6.3), frontend DOM/console/storage (5.9), and QA-20.
- **Injection and confinement tests**: git ref option injection and argv-free credentials (04/07), artifact path traversal including symlinks (04 + 5.6.2), `runProcess` never using a shell and scrubbing env (04 + 5.6.2), harness validator bans on Node built-ins, network, `eval`, dynamic import (09), page-level off-origin blocking (10 §9.7, §9.9), read-only Claude Code tools (05 + `integration/ai/claude-code.test.ts`).
- **User clone safety** is proven with real git for all three sources (5.6.5): no mutation, no hooks, no leftover refs.
- **Fixture script** installs pinned exact versions only, into a directory it owns; it refuses symlinked or unexpected targets before deleting, never deletes outside `<dataDir>/fixtures/sample-react-app`, and runs git with global/system config disabled so the developer's hooks never run.
- **Karma** never runs with `--no-sandbox` by default; the browser comes from 02's wrapper.

## 9. Tests (for this sheet's own deliverables)

`tests/backend/test-support/query-handler-stub.test.ts`
- `the stub exposes exactly QueryHandler's public method names` — compares `Object.getOwnPropertyNames(QueryHandler.prototype)` (minus `constructor`) and the static names (`normalizeData`, `firstInsertedId`) with the stub's; fails when 04 adds or renames a method.
- `insert fills every column: literal defaults, now() timestamps, '[]'::jsonb, null for nullable columns` — a minimal `visualizations` insert comes back with `status "queued"`, `componentCount 0`, `changedCount 0`, `isDeleted false`, `failedStage null`, `createdAt`/`updatedAt` = the injected clock.
- `insert without a NOT NULL value returns 400 validation_failed; insert with an unknown column throws QueryHandlerError; insert([]) returns 200 []`.
- `select applies isDeleted=false by default on soft tables; an explicit isDeleted condition overrides it`.
- `conditions: undefined ignored, null matches IS NULL, every Where operator evaluates like SQL` — table over `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `in([])` (matches nothing), `notIn`, `notIn([])` (matches all, including NULL), `isNull`, `isNotNull`, each also against a row whose column is NULL (only `isNull` and `notIn([])` match it).
- `unknown condition keys throw on select, count, update and delete before any write`.
- `update(values, conditions, table): no effective conditions → 400 validation_failed; zero matches → 404 not_found; success → rowsAffected and updatedAt bumped only where the column exists`.
- `soft delete on a table without isDeleted throws; soft delete sets isDeleted and updatedAt; hard delete removes; zero matches 404`.
- `selectMany orders by id asc by default, honours orderBy/limit/offset/search, sorts NULLs last ascending and first descending, and throws for an unknown orderBy column`.
- `validateAndSelect and selectMany hydrate through ModelHandler.hydrate, including null values`.
- `firstInsertedId reads data[0].id`.
- `failNext: ApiResponse methods return the scripted response once; row and model methods throw QueryHandlerError once; validation still runs first`.
- `installQueryHandlerStub routes every QueryHandler instance (including new QueryHandler(tx)) and both normalizeData forms; restore puts the originals back`.
- `factories produce rows whose keys are exactly the table's columns` (5.6.1) and `factory overrides that violate a 03 CHECK throw`.

`tests/backend/test-support/temp-dir.test.ts`
- `makeTempDir creates a unique realpath dir under os.tmpdir() named prvision-test-<label>-*, and cleanup removes it`.
- `useTempDataDir returns an empty dir and removes it in t.after without touching process.env`.

`tests/backend/test-support/temp-git-repo.test.ts`
- `createTempGitRepo creates main with an initial commit and .gitignore`.
- `identical steps in two repos produce identical SHAs`.
- `dirty produces modified, staged, untracked and deleted entries`.
- `createBareOrigin + setPullRef exposes refs/pull/<n>/head to git ls-remote`.
- `snapshot changes when HEAD, branches, status, index or stash change and ignores refs/prvision`.
- `helpers ignore the developer's global and system git config` — `repo.git("config", "--list", "--show-origin")` lists only entries whose origin is the repo's own `.git/config` (no global/system file is read), without touching `HOME` or `process.env`.
- `nodeModules option produces a layout sheet 06 detection accepts` — run the real `ProjectDetectionService` on `reactViteFiles()` + `nodeModules: true` → `react_vite`, `npm`.

`tests/backend/test-support/png-fixtures.test.ts`
- `solidPng and withRect paint the requested pixels` (`pixelAt`); `withRect clips at the edges`.
- `noisePng is deterministic per seed and differs across seeds`.
- `encodePng/decodePng round-trip`; `dominantColour ignores white and transparent pixels`.

`tests/backend/test-support/ai-provider-stub.test.ts`
- `returns scripted data per purpose in order`; `error steps throw AiProviderError with reason, retryable and usage`; `hang settles only on abort`; `exhausted script throws a descriptive error`; `assertExhausted detects unused steps`.
- `rejects request schemas that fail assertStructuredOutputCompatible`; `data that violates request.jsonSchema throws invalid_output with usage attached`; `skipSchemaValidation returns the data unchanged`.

`tests/backend/test-support/network-guard.test.ts`
- `fetch to a non-loopback host throws the guard error`; `fetch to 127.0.0.1 is allowed` (local `http.createServer` on port 0); `https.request to api.github.com throws`; `DATA_DIR from config-consts is inside os.tmpdir()`; `PRVISION_SECRET_KEY is the fixed test key`; `NODE_ENV is test and IS_TEST is true`.

`tests/backend/test-support/fakes.test.ts`
- `FakeQueue treats a repeated jobId as a no-op and reports getState`; `makeJob builds { visualizationId, jobId: "viz-<id>", signal } and cancel/shutdown abort with the string reasons` (`jobAbortReason(signal)` returns `"cancelled"` / `"shutdown"`); `FakeRedis expires keys by TTL with the injected clock`; `createFakeGithubPort pages listPulls and throws scripted errors once`; `fakeAnthropicStream records params and signal`; `fakeAgentQuery reports the iterator closed after abort`; `ConsoleRecorder.assertStagesAreStatusNames rejects "render:Button"`; `createPipelineContext cancel() aborts with "cancelled" and makes isCancelled() true`.

`tests/backend/test-support/test-hygiene.test.ts`
- `no file under tests/backend constructs PipelineStepError with an object as first argument` — static scan for `new PipelineStepError({` (00 §14.12: always positional).
- `no file under tests/backend assigns process.env after the preload` — static scan for assignments `process.env.<NAME> =` / `??=` and `delete process.env` (comparisons such as `=== "1"` are fine) outside `tests/backend/helpers/setup.ts` (00 §14.12).

`tests/backend/tools/create-fixture-repo.test.ts` (spawns `node tools/create-fixture-repo.mjs --skip-install --data-dir <tmp>`; ≈1–2 s; skipped without git)
- `creates the fixture with all six branches and a clean tree`.
- `main contains every MAIN_FILES path with exact content` — compared with the imported constants.
- `feature/button-restyle differs from main in exactly Button.tsx, Card.tsx, useAuth.ts and the added Badge.tsx` — `git diff --name-status main feature/button-restyle`.
- `each qa branch changes exactly the files listed in BRANCHES`.
- `commit SHAs are identical across two independent runs` — two temp data dirs → same `branches` map in the markers.
- `writes the marker inside .git with version, branches and installed false`.
- `a second run without flags is a no-op and exits 0`.
- `a foreign directory is refused (exit 1) and --force recreates it`.
- `a moved fixture branch is refused (exit 1) and --reset restores it` — `git branch -f feature/button-restyle main`; run → exit 1; `--reset` → branch back at its recorded sha, untracked file removed, a fake `node_modules/` kept, `refs/prvision/pr-1` removed.
- `a symlinked target is refused`.
- `unknown arguments and --force with --reset are rejected`.
- `parseArgs and resolveDataDir handle ~ expansion and PRVISION_DATA_DIR` — imported directly.
- `the main branch typechecks as TypeScript source` — `ts.transpileModule` over every `.ts`/`.tsx` in `MAIN_FILES` and every branch overlay reports no syntax errors (cheap guard against typos in the embedded sources; the full `tsc -b` runs in the acceptance step with dependencies installed).

## 10. Acceptance criteria

Wave 2:

- [ ] `npm run test:backend` runs every `tests/backend/**/*.test.ts` serially with the `setup.ts` preload on Node 22.12+; integration files report as skipped; the run exits non-zero on any failure. Root `npm test` runs it and then the frontend suite (02).
- [ ] `npm run test:it` sets `PRVISION_IT_RENDER=1` unless it is set to `0`; `PRVISION_INTEGRATION=1` also enables render ITs; every integration test skips with a clear reason when its flag is off; `grep -rn PRVISION_RENDER_IT backend tests` returns nothing.
- [ ] `npm run test:frontend` runs Karma once, headless, and exits; works when only Playwright Chromium is installed; `npm run test:watch --prefix frontend` keeps watch mode.
- [ ] `npm run test:coverage` writes `coverage/backend/index.html`.
- [ ] Every helper in 5.4 exists with the documented API and passes its self-tests (section 9); the in-memory `QueryHandler` passes the method-name parity test against sheet 04's `QueryHandler` and the SQL-semantics table.
- [ ] `grep -rnE "process\.env\.[A-Z_]+ *(\?\?)?=[^=]|delete process\.env" tests/backend` (assignments, not comparisons) matches only `tests/backend/helpers/setup.ts` (config is fixed at import, 00 §14.12); `test-hygiene.test.ts` passes.
- [ ] A deliberate `fetch("https://api.github.com")` inside a unit test fails with the guard message.
- [ ] Running `npm test` creates and modifies nothing in `~/.prvision` or the repo tree (compare `ls -laR ~/.prvision` and `git status --porcelain` before and after).
- [ ] `node tools/create-fixture-repo.mjs` creates the fixture with six branches, a clean tree, installed dependencies and the marker; a second run is a no-op; `--force` recreates; `--reset` restores; `--skip-install` skips the install.
- [ ] In the created fixture, `npm run build` (`tsc -b && vite build`) succeeds on `main` and on `feature/button-restyle`, and `npm run dev` serves the dashboard at `http://localhost:5173` with two Cards, the UserMenu "Sign in" fallback (no `/api/me` backend) and the ProfileCard.
- [ ] Two independent fixture creations produce identical branch SHAs.
- [ ] `tests/fixtures/` contains every file in 5.5; each harness file passes `fixture-harnesses.test.ts` once sheet 09 lands.

Wave 6:

- [ ] Every case in every sheet's own test list and every addition in 5.6/5.9 exists (renames allowed, assertions preserved) or has a recorded reason.
- [ ] Per-area helpers that duplicate shared ones are reduced to wrappers/re-exports with unchanged exported names.
- [ ] Coverage targets in 5.3 are met or each gap is listed with a justification; the c8 floor passes.
- [ ] Every integration test in 5.8, and 10's `render-engine.integration.test.ts`, passes with `PRVISION_IT_RENDER=1`; the AI ones pass at least once with `PRVISION_IT_AI=1` for each provider the developer has; sheet 03's DB tests pass once with `PRVISION_TEST_DATABASE_URL`.
- [ ] The fixture outcomes in 5.10.6 (ranks, change reasons, render statuses, visual changes, `componentCount`/`changedCount`, `failedStage null`) are asserted by `fixture-branches.test.ts` (analysis) and `pipeline-local-branch.test.ts` (end to end), and both pass.
- [ ] `npm run test:backend` and `npm run test:frontend` each pass three consecutive runs with identical results.
- [ ] Backend suite < 60 s, frontend suite < 90 s on the reference laptop; no unit test > 2 s.
- [ ] Zero quarantined (`skip: "flaky…"`) tests.
- [ ] Manual QA checklist 5.11 executed and recorded; all blocking scenarios pass.

## 11. Contract changes requested

Resolved:

1. Node floor `>=22.12`, `.nvmrc` 24 — Resolved — 00 §14.1.
2. Repo tree additions (`tests/backend/integration/`, `tests/fixtures/`, `tools/fixture-repo/sample-app-files.mjs`, `frontend/src/testing/`, `backend/.c8rc.json`) — Resolved — 00 §14.10 (integration location) and §14.12 (each sheet's file inventory is authoritative for its additional files; section 4 here).
3. Test-only environment variables — Resolved — 00 §14.10 (`PRVISION_IT_RENDER`, `PRVISION_IT_AI`, `PRVISION_INTEGRATION`, `PRVISION_TEST_DATABASE_URL`) and §14.12 (`PRVISION_TEST_LOG_STDOUT`, `PRVISION_KEEP_TEST_ARTIFACTS`, `PRVISION_REAL_DATA_DIR`, `PRVISION_IT_AI_*`, which covers `PRVISION_IT_AI_PROVIDER` and `PRVISION_IT_AI_MODEL`). `PRVISION_RENDER_IT` is withdrawn.
4. Fixture branches — Resolved — 00 §14.10.
5. `error_reason` codes `github_rate_limited` (429) and `github_unavailable` (502) — Resolved — 00 §14.2, status table in §14.12.
6. Secret-clear wire value — Resolved — 00 §14.4 (`""` clears, `null` → 400; 13 sends `""`).
7. Frontend test script — Resolved — 00 §14.10 (`npm test --prefix frontend` single headless run, `test:watch` for watch mode; 02 §6.11.1).
8. Logger test stream — Resolved — 00 §14.10 (04 §9.10 exports `logTestStream`).
9. Test preload and `--test-force-exit` — Resolved — 00 §14.10 (01 §5.15, 02 §6.9.1).
10. Render API naming — Resolved — 00 §14.7 (`new RenderService({ repairHarness }).renderAll(ctx, buildRenderInputs(…))`; 07 §5.9.2 calls it).
11. Render integration gate — Resolved — 00 §14.10 (`PRVISION_IT_RENDER` or `PRVISION_INTEGRATION`; 10 §9.9).
12. Tailwind v4 colour expectation — Resolved — 00 §14.10 (10 §9.9 uses colour ranges and diff ratios).
13. Typecheck coverage of tests — Resolved — 01 §5.2.1 (`tsconfig.eslint.json` includes `tests/backend`; no `tsconfig.test.json`).
14. Config in tests — Resolved — 00 §14.12 (constants evaluated once at import, after the preload; tests use `collectConfigValidationErrors(overrides)`, constructor options or `Encryption.setKeyForTesting`).

15. **Sheet 08 §10 — `CI_SKIP_PERF`** — Resolved — 08 §10 no longer uses the variable: the 3 000-file graph perf case in `import-graph.test.ts` reports its time with `t.diagnostic` and fails only above the 15 s budget. Originally: the case was skipped with `CI_SKIP_PERF=1`, a variable outside the 00 §14.10/§14.12 list.
16. **Sheet 09 §10 — fixture reference** — Resolved — 09 §10 now reads "for the fixture's Button and UserMenu components (09's own Example A/B fixtures cover Button and OrdersPanel in unit tests)". Originally it named an OrdersPanel the fixture repo does not have.
17. **Sheet 10 §9.9 — fixture location in the render IT** — Resolved — 10 §9.9 locates the fixture with this sheet's `requireFixtureRepo()` (reads `PRVISION_REAL_DATA_DIR`) and fails, rather than skips, when the render gate is on and the fixture or its `node_modules` is missing. Originally it checked `<dataDir>/fixtures/…`, which under the preload is the per-process temp dir and would always skip.

Open: none. Tests follow the 00 §14 rule if a new disagreement appears.
