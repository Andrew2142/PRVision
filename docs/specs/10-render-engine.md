# 10 — Render Engine

Owner: build agent (wave 5)
Status: implementation-ready
Depends on: 00 (contracts, esp. §14.3, §14.5, §14.7, §14.8, §14.10), 02 (render config, tooling), 04 (core infra: `ArtifactStore`, `QueryHandler`, `createLogger`, `PipelineStepError`), 07 (worker orchestration, worktrees), 08 (candidates, `basePathFor`), 09 (harness generation + `repairHarness`, `targetImportPath`), 14 (fixture repo, integration gating)

This sheet specifies everything that turns a `HarnessGenerationResult` into two PNGs (base and head): the `RenderService` orchestrator, the Vite mock plugin, the Vite host child process, the Playwright browser session, and the static harness templates under `backend/harness-templates/`. An agent must be able to build it from this sheet alone. Where an assumption about another sheet's API is made, it is stated explicitly and repeated in section 11.

---

## 1. Purpose

Render every changed React component in isolation, on both sides of the change, through the target repository's **own** Vite toolchain, and produce deterministic screenshots.

Concretely, `RenderService.renderAll()`:

1. Writes the render harness (static templates + per-component harness modules + a generated global-styles module) into `.prvision-harness/` of both worktrees.
2. Starts the target repo's Vite dev server for each side (in a child process whose cwd is the worktree), with PRVision's mock plugin injected so AI-declared module mocks replace real modules.
3. Opens each component's harness page in headless Chromium with a fully deterministic environment (fixed clock, seeded randomness, no animations, no network egress), waits for a ready signal, measures what was painted (including portals), and takes a stable screenshot.
4. Classifies failures, asks sheet 09 to repair a failed harness once (only when every present side failed, 00 §14.7), re-renders every present side with the repaired harness, keeps the better attempt, and persists image paths, dimensions, errors, `render_status` and — when the repaired attempt is kept — the repaired harness per component. 09's `repairHarness` never persists; this sheet is the only writer of render results and repaired harness fields.
5. Cleans up every process, page, context and browser it created, including on cancellation and crashes.

Success is defined by section 10: identical inputs on both sides give byte-identical pixel data (diff ratio 0), and failures carry messages good enough for an AI repair and a human reviewer.

## 2. Scope / Out of scope

In scope:

- `RenderService` (public API `renderAll`) and its per-run orchestration (`RenderRun`).
- Loading the target repo's Vite (4.x–7.x) from the worktree; ESM/CJS handling; version checks.
- Vite inline config construction (root, cacheDir, server, fs.allow, optimizeDeps, env, plugins, base).
- The Vite host child process and its IPC protocol.
- `vite-mock-plugin.ts` (virtual mock modules, matching rules) and the small harness plugin (`virtual:prvision-mount`).
- Harness templates (`index.html`, `entry.tsx`, `error-boundary.tsx`) written out in full, and the per-run generated files (`components/<id>.tsx`, `globals.ts`, `.gitignore`).
- Tailwind v3/v4 and global CSS checks.
- Playwright: browser launch, context options, init scripts, request routing, clock, ready waiting, capture (incl. portals and empty renders), stability loop, PNG writing.
- Error taxonomy, repair triggering (`HARNESS_MAX_REPAIRS_PER_COMPONENT = 1`, 05 §5.10), result selection, status mapping, persistence through `QueryHandler`.
- Cancellation, per-component and stage timeouts, cleanup, memory bounds.
- Unit tests, orchestration tests with stubs, gated integration test against the fixture repo.

Out of scope (owned elsewhere):

- Generating or repairing harness source and mocks (sheet 09). This sheet only defines what the render engine supports and how errors are reported back.
- Choosing candidates, ranks, display names (sheet 08).
- Creating/removing worktrees and the `node_modules` symlink (sheet 07). Worktrees are removed by 07 in `finally`; the render engine never deletes `.prvision-harness/`.
- Pixel diff, structural diff, AI summary, `visual_change`, `risk`, `diff_*` columns (sheet 11).
- Installing Chromium (sheet 02 setup script runs `npx playwright install chromium`).
- Non-Vite or non-React targets (Next.js, Angular) — post-prototype.
- Rendering with each side's own dependency versions (both worktrees share the user's single `node_modules`; see 5.15).
- DOM snapshot capture for structural diff (not in the contracts; see section 11, item 9).

## 3. Dependencies

Sheets and contracts used:

| From | What | Used for |
|---|---|---|
| 00 §8 | `PipelineContext`, `PreparedWorkspace`, `ComponentCandidate`, `HarnessGenerationResult`, `MockedModule`, `RenderSideResult`, `ComponentRenderResult` | API in/out |
| 00 §4 | `.prvision-harness/`, artifacts layout `<dataDir>/artifacts/<vid>/<cid>/{base,head}.png` | file layout |
| 00 §5 | `ComponentRenderStatus`, `ComponentChangeKind`, `Table.VISUALIZATION_COMPONENTS` | status mapping, persistence |
| 02 | `config-consts/render.config.ts` (every constant in 5.14, names per 00 §14.8 incl. `RENDER_VIEWPORT` and `HARNESS_TEMPLATES_DIR`); `playwright` ^1.58 in backend deps; tsconfig/ESLint/Prettier exclude `backend/harness-templates/` (00 §14.1) | config, deps |
| 04 | `QueryHandler` (§8.4), `ArtifactStore` (§9.8 + 00 §14.8), `createLogger` (§9.10), `getErrorMessage`, `PipelineStepError` (§10), `CHILD_PROCESS_BASE_ENV` (values in 02 §6.7) is the **only** base of the Vite child env, plus fixed Vite values (00 §14.12, 5.6.2); `process.env` is never read | persistence, paths, logging, errors |
| 07 | Calls `renderAll` during status `rendering` exactly as 5.13.1 defines (00 §14.7); builds `PipelineContext`; symlinks `<worktree>/node_modules` (and `<viteRoot>/node_modules` when the Vite root is a subfolder) to the user's real `node_modules`; removes worktrees after summarizing | invocation |
| 08 | `basePathFor(filePath, changeKind, changedFiles)` (08 §5.14.7) for renamed components | side paths |
| 09 | `HarnessGenerationService.repairHarness(componentId, previous, renderError: HarnessRenderError): Promise<HarnessRepairOutcome>` (09 §5.1, §5.10; never persists); `targetImportPath(filePath, viteRootRel)` (09 §5.2); `HARNESS_MAX_REPAIRS_PER_COMPONENT = 1` (05 §5.10) | repair loop, base rewrite |
| 14 | `tools/create-fixture-repo.mjs` → `<dataDir>/fixtures/sample-react-app` (Vite + React + Tailwind, dependencies installed) | integration test |

APIs used from sheet 04 (names fixed by 00 §14.8; only the `ArtifactStoreRenderAdapter` and `QueryHandlerRenderPersistence` in `render-service.ts` touch them):

```ts
// ArtifactStore (04 §9.8, 00 §14.8)
componentImagePath(visualizationId: number, componentId: number, kind: "base" | "head" | "diff"): string;  // "artifacts/<v>/<c>/<kind>.png", dataDir-relative POSIX (00 §14.3)
resolveSafe(relativePath: string): string;                                   // absolute path inside dataDir
ensureComponentDir(visualizationId: number, componentId: number): Promise<void>;     // mkdir -p

// QueryHandler (04 §8.4)
update(newValues: Record<string, unknown>, conditions: Conditions, table: Table): Promise<ApiResponse<{ rowsAffected: number }>>;   // sets updated_at itself

// PipelineStepError (04 §10, 00 §14.7)
new PipelineStepError("rendering", userMessage, { code?, detail?, cause? });
```

npm packages: `playwright` (backend dependency, already required by 00 D2). No `vite` dependency in the backend: Vite is always loaded from the target repo, and PRVision uses minimal structural types for it (`render-types.ts`). Integration tests additionally use `pngjs` and `pixelmatch` (runtime dependencies, 00 §14.1).

Runtime prerequisites: Node ≥ 22.12 (00 §14.1; also satisfies Vite 7's `^20.19 || >=22.12`), Chromium installed for Playwright (`npx playwright install chromium`, run by setup, 00 §14.1).

## 4. File inventory

All backend paths are under `backend/src/services/visualizations/pipeline/` unless stated.

| File | Responsibility |
|---|---|
| `render-service.ts` | `RenderService` (public `renderAll`) and private `RenderRun` (per-call state): planning, workspace prep, groups, host lifecycle, per-component rendering, repair loop, attempt selection, persistence, cancellation, budget, cleanup. |
| `mock-rules.ts` | Pure mock rules shared with 08 and 09 (5.8.2): `validateMockedModules()`, `isUnmockableSpecifier()`, `classifySpecifier()`, `packageNameOf()`, `STYLE_OR_ASSET_EXTENSIONS`, `MOCK_SOURCE_MAX_CHARS`. Imports only `node:path`. Fully specified here; whichever of 08/09/10 is built first creates it verbatim. |
| `vite-mock-plugin.ts` | `createMockPlugin()`, `mockHash()`, `mockVirtualId()`; re-exports `mock-rules.ts`. Pure module (no DB/env imports); runs inside the Vite host child; unit tested in the parent. |
| `render/index.ts` | Barrel for `render/` (exports types and the classes used by `render-service.ts`). |
| `render/render-types.ts` | Internal types: structural Vite types (`ViteModuleLike`, `VitePluginLike`, `ViteDevServerLike`, …), IPC messages, `ViteHostStartOptions`, `RenderWorkItem`, `RenderGroup`, `RenderFailureKind`, `PageRenderInput/Outcome`, `HarnessSideLayout`. |
| `render/esm-import.ts` | `esmImport(url)` — the single place that dynamically imports the target repo's ESM Vite (native `import()`, preserved by `module: nodenext`). |
| `render/vite-loader.ts` | `loadTargetVite(viteRoot)`: locate, version-check, and import the repo's Vite; `ViteLoadError`. |
| `render/vite-server-config.ts` | `buildViteInlineConfig()` (pure), `flattenUserPlugins()`, `PLUGIN_DENYLIST_PREFIXES`, `resolveWatchOption()`, `detectConfigFile()`. |
| `render/vite-harness-plugin.ts` | `createHarnessPlugin()` → `virtual:prvision-mount` (React 18+ `createRoot`, React 16.8–17 legacy `render`). |
| `render/vite-host-process.ts` | Child-process entry: receives `start`, loads Vite, builds config, starts server, forwards logs, handles `shutdown`/disconnect. |
| `render/vite-host-client.ts` | `ViteHostClient.start()` → `ViteHostHandle` (fork in its own process group, env allowlist, IPC, start timeout, log ring buffer, stop with process-group SIGKILL fallback, global kill-on-exit registry). |
| `render/harness-workspace.ts` | `resolveSideLayout()`, `HarnessWorkspaceWriter` (templates, `.gitignore`, `globals.ts`, `components/<id>.tsx`), `toHarnessFileSource()`, `rewriteTargetSpecifier()`, `buildGlobalsSource()`, `scanReferencedEnvKeys()`, `assertTemplatesPresent()`, path-containment guard. |
| `render/render-groups.ts` | `mockFingerprint()`, `normalizeMockMatchKey()`, `buildRenderGroups()`. |
| `render/browser-session.ts` | `BrowserSession` (launch, context per render, routing, listeners, ready wait, capture, stability loop, PNG write, crash handling), `CHROMIUM_LAUNCH_ARGS`, `buildContextOptions()`, `decideRoute()`. |
| `render/page-scripts.ts` | Browser-side functions/strings: `buildDeterminismInitScript()`, `readHarnessState`, `measureCapture`, `collectTimeoutDiagnostics`, `detectStylesheetHealth`. |
| `render/render-errors.ts` | `RenderFailureKind` helpers: `isRepairableFailure()`, `formatRenderError()`, `extractViteErrorFromBody()`, `rewriteMockIds()`, `isOptimizeDepsChurn()`, start-failure messages. |
| `render/browser-media-permissions.ts` | Copied from Uply-v2 (`browserContextWithBlockedMedia`, `blockBrowserContextMediaPermissions`), message text changed to "PRVision". |
| `config-consts/render.config.ts` | (Sheet 02 file; consumed, not modified) the constants listed in 5.14 are already in 02 §6.7 (00 §14.8). |
| `backend/harness-templates/index.html` | Static harness page (5.4.2). |
| `backend/harness-templates/entry.tsx` | Static harness entry (5.4.3). |
| `backend/harness-templates/error-boundary.tsx` | Static error boundary (5.4.4). |
| `tests/backend/render/vite-mock-plugin.test.ts` | Mock plugin unit tests. |
| `tests/backend/render/render-groups.test.ts` | Fingerprint and grouping tests. |
| `tests/backend/render/vite-loader.test.ts` | Vite loading/version tests with fake packages. |
| `tests/backend/render/vite-server-config.test.ts` | Inline config construction tests. |
| `tests/backend/render/harness-workspace.test.ts` | Harness file writing tests. |
| `tests/backend/render/render-errors.test.ts` | Error formatting/classification tests. |
| `tests/backend/render/browser-session.helpers.test.ts` | Pure helpers: `decideRoute`, clip math, PNG size read. |
| `tests/backend/render/render-service.test.ts` | Orchestration with stubbed hosts/session/persistence/repair. |
| `tests/backend/integration/render-engine.integration.test.ts` | Real Vite + Chromium against the fixture repo; gated by `PRVISION_IT_RENDER=1` or `PRVISION_INTEGRATION=1` (00 §14.10). |
| `tests/backend/render/vite-host-client.test.ts` | Child env allowlist, execArgv, process-group kill and orphan prevention with a fake host entry (no Vite). |
| `tests/backend/render/helpers/fake-vite-package.ts` | Writes fake `node_modules/vite` packages (v4/v5/v6/v7 export shapes) into temp dirs. |
| `tests/backend/render/helpers/render-stubs.ts` | `FakeViteHost`, `FakeBrowserSession`, `InMemoryPersistence`, `FakeArtifactStore`, `fakePipelineContext()`. |

Build/lint note for sheet 02: `backend/harness-templates/**` is browser code. It must be excluded from backend `tsc`, ESLint and Prettier-check globs, and copied as-is (not compiled). It is read at runtime from disk (5.4.8).

---

## 5. Detailed design

### 5.1 Architecture overview

```text
 Worker process (BullMQ, sheet 07)                         Child processes
 ─────────────────────────────────                         ───────────────
 RenderService.renderAll(ctx, components)
   └─ RenderRun
       ├─ plan items (sides, mocks, fingerprints)
       ├─ HarnessWorkspaceWriter → base/.prvision-harness, head/.prvision-harness
       ├─ BrowserSession.launch()  ── Playwright ──► Chromium (1 per job)
       ├─ for each RenderGroup (same mock set):
       │    ViteHostClient.start(base) ──fork(cwd=base viteRoot)──► vite-host-process ─► repo's Vite (base)
       │    ViteHostClient.start(head) ──fork(cwd=head viteRoot)──► vite-host-process ─► repo's Vite (head)
       │    for each item: render base ∥ head → context per render → PNG
       │    stop both hosts
       ├─ repair phase (09 repairHarness when every present side failed, max 1) → re-group → re-render all present sides
       ├─ persist per component (QueryHandler)
       └─ finally: close contexts, stop hosts, close browser
```

Key decisions (each justified in its subsection):

| # | Decision |
|---|---|
| R1 | Vite runs in a **child process per side** with `cwd = viteRoot` (5.2). |
| R2 | Mocks are per component; components are batched into **render groups by identical mock set**; one Vite server per side per group, started sequentially, sharing an on-disk dep cache (5.3). |
| R3 | The user's Vite config is loaded with the repo's own `loadConfigFromFile`, sanitized, and passed as an inline config with `configFile: false`, so PRVision controls plugin order (mock plugin first) (5.7). |
| R4 | Harness page is served by Vite's HTML middleware (`appType: "mpa"`) at `/.prvision-harness/index.html?c=<id>` so user `transformIndexHtml` hooks still run (5.7). |
| R5 | One Chromium per job; a **fresh browser context per (component, side, attempt)** for storage isolation (5.11). |
| R6 | Capture is a top-left-anchored clip of the painted area (text + painting elements, portals included); full viewport when fixed overlays exist (5.11.7). |
| R7 | Ready = React commit + DOM quiet + fonts + images + 2 rAF, then a two-identical-frames stability loop (5.4.3, 5.11.8). |
| R8 | Repair only when the primary side fails with a harness-attributable error; a repaired harness re-renders **both** sides (5.13.6). |

### 5.2 Process model: why Vite runs in a child process

Running the target's Vite inside the worker process does not work reliably:

- Tailwind v3 resolves `content` globs and finds `tailwind.config.*` relative to `process.cwd()` (unless the user opted into `relative: true`). With the worker's cwd, no classes are generated.
- Many `vite.config.ts` files call `loadEnv(mode, process.cwd())` or read files relative to cwd.
- Base and head servers must run at the same time; `process.chdir` is process-global.
- User plugins can leak memory, hold handles, monkey-patch globals, or crash; isolating them makes cleanup a `SIGKILL`.
- The backend compiles to CommonJS (`module: nodenext` with `"type": "commonjs"`, 01 §5.2.1), while Vite 5+ is ESM-first and Vite 7 is ESM-only; a dedicated entry keeps the ESM loading contained.

So each Vite server is hosted by `render/vite-host-process.ts`, forked with `cwd = viteRoot`. The parent talks to it over Node IPC (5.6). Chromium stays in the parent (one per job).

Child-process rules:

- The child imports only: `node:*`, `render/render-types.ts`, `render/esm-import.ts`, `render/vite-loader.ts`, `render/vite-server-config.ts`, `render/vite-harness-plugin.ts`, `vite-mock-plugin.ts`, `mock-rules.ts`, and `config-consts/render.config.ts` **directly** (not through the `config-consts` barrel, which may run env validation that fails with the stripped env).
- The child never imports the DB, Redis, logger, or `AuthContext`. All logging goes over IPC.
- The child's environment is `CHILD_PROCESS_BASE_ENV` (02 §6.7, the strict allow-list 00 §14.12 assigns to git and the Vite host) plus fixed Vite values (5.6.2); PRVision secrets never reach it.
- The child runs in its own process group (`detached: true`) and is always killed as a group (`process.kill(-pid, "SIGKILL")`), so Vite's and plugins' grandchildren die with it (5.6.2).

### 5.3 Render groups and per-component mocks (decision)

Mocks (`MockedModule[]`) differ per component, but a Vite dev server has one module graph: `src/api/client.ts` is transformed and served once, and its URL (`/src/api/client.ts`) is identical for every page. A resolver cannot know which component's page is asking. Options considered:

| Option | How | Verdict |
|---|---|---|
| A. Scope propagation via query (`?prvision-c=<id>`) | Harness imports target with a query; `resolveId` appends the query to every user-source import so each component gets its own module graph | Rejected. Breaks plugins whose filters test the full id (`vanilla-extract` `.css.ts`, `svgr` `?react`, mdx, linaria), duplicates CSS-module instances, interacts with `?import`/`?url`/`?raw`, and is fragile across Vite 4–7 and arbitrary user plugins. |
| B. Per-page URL substitution with `page.route` | Fulfill the real module URL with transformed mock code per page | Rejected. Needs CJS-interop shims for pre-bundled deps, exact URL prediction (`/@fs/`, `?v=` hashes, aliases), and loops when a mock imports its real module. |
| C. Restart Vite per component | One server per component | Correct but wasteful when many components share the same (often empty) mock set. |
| **D. Render groups (chosen)** | Group components by an exact fingerprint of their accepted mocks; one Vite server per side per group; inside a server, mocks are global | Robust: all resolution is done by Vite itself, no URL/query tricks, mock semantics are simple ("this module is replaced for everything this page loads"). Cost is one server start per distinct mock set, mitigated below. |

Cost control for D:

- All servers for one side share `cacheDir` (`<viteRoot>/.prvision-harness/.vite-cache`). Only the first server per side runs the dependency scan/optimization; later servers find a matching `_metadata.json` hash (the hash covers config, lockfile and plugin names, not `optimizeDeps.entries` or plugin internals, and PRVision keeps the inline config identical across groups) and start in about 0.5–1.5 s.
- The mock plugin returns `null` while Vite is scanning (`options.scan === true`) so every real dependency, including mocked packages, is discovered by the first scan. Later groups never trigger a re-optimization because of mocks.
- Components without mocks share one group (`"none"`), processed first; it is usually the largest group and warms the dep cache.
- Base and head servers for a group start in parallel; groups run sequentially. At most two Vite servers are alive at any time.

Group key = `mockFingerprint(filePath, acceptedMocks)` (5.3.1). Two components belong to the same group only when, after normalization, their mock sets are identical (same match keys and same source text). A component's own file path matters only for relative specifiers.

#### 5.3.1 `render/render-groups.ts`

```ts
import { createHash } from "node:crypto";
import path from "node:path";
import type { MockedModule } from "../../../../types/visualization-pipeline";
import type { RenderGroup, RenderWorkItem } from "./render-types";

export const NO_MOCKS_GROUP_KEY = "none";

/** Syntactic match key: relative specifiers are anchored to the component's repo-relative directory. */
export function normalizeMockMatchKey(componentRepoPath: string, specifier: string): string {
  const isRelative = specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
  if (!isRelative) {
    return `spec:${specifier}`;
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(componentRepoPath), specifier));
  return `rel:${joined}`;
}

export function mockFingerprint(componentRepoPath: string, acceptedMocks: readonly MockedModule[]): string {
  if (acceptedMocks.length === 0) {
    return NO_MOCKS_GROUP_KEY;
  }
  const parts = acceptedMocks
    .map((mock) => `${normalizeMockMatchKey(componentRepoPath, mock.specifier)}\u0000${mock.source}`)
    .sort();
  return createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 16);
}

/** "none" first, then groups by their best (lowest) rank, then key. Items by rank, then componentId. */
export function buildRenderGroups(items: readonly RenderWorkItem[]): RenderGroup[] {
  const byKey = new Map<string, RenderWorkItem[]>();
  for (const item of items) {
    const bucket = byKey.get(item.fingerprint) ?? [];
    bucket.push(item);
    byKey.set(item.fingerprint, bucket);
  }
  const groups: RenderGroup[] = [...byKey.entries()].map(([key, groupItems]) => ({
    key,
    items: [...groupItems].sort(
      (a, b) => a.candidate.rank - b.candidate.rank || a.candidate.componentId - b.candidate.componentId,
    ),
  }));
  return groups.sort((a, b) => {
    if (a.key === NO_MOCKS_GROUP_KEY) return -1;
    if (b.key === NO_MOCKS_GROUP_KEY) return 1;
    const rankA = a.items[0]?.candidate.rank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.items[0]?.candidate.rank ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB || a.key.localeCompare(b.key);
  });
}
```

### 5.4 Harness workspace

#### 5.4.1 Layout and side resolution

The Vite root (`viteRoot`) is the directory containing the repo's Vite config: `viteRoot = repository.viteConfigPath ? join(worktreeDir, dirname(viteConfigPath)) : worktreeDir`. For the prototype (single-package repos) `viteRoot === worktreeDir`. The harness folder lives at `<viteRoot>/.prvision-harness/` (equal to `<worktree>/.prvision-harness/` in the prototype; see section 11, item 1).

```text
<viteRoot>/.prvision-harness/
  .gitignore              "*"  — keeps the folder invisible to git and to Tailwind v4 source detection
  index.html              copied from backend/harness-templates/index.html
  entry.tsx               copied from backend/harness-templates/entry.tsx
  error-boundary.tsx      copied from backend/harness-templates/error-boundary.tsx
  globals.ts              generated per side (global style imports)
  components/<id>.tsx     generated per component per side (pragma + harnessSource)
  .vite-cache/            Vite cacheDir (created by Vite; shared by all groups of this side)
```

```ts
// render/render-types.ts
export type RenderSide = "base" | "head";

export interface HarnessSideLayout {
  side: RenderSide;
  worktreeDir: string;      // PreparedWorkspace.baseDir / headDir
  viteRoot: string;         // absolute
  configFile: string | null;// absolute path of repository.viteConfigPath on this side if the file exists, else null (auto-detect in child)
  harnessDir: string;       // <viteRoot>/.prvision-harness
  componentsDir: string;    // <harnessDir>/components
  cacheDir: string;         // <harnessDir>/.vite-cache
  harnessUrlPath: string;   // "/.prvision-harness/index.html" (POSIX, root-relative)
}
```

`resolveSideLayout(side, worktreeDir, viteConfigPath)` validates that `viteConfigPath` (repo-relative) stays inside the worktree (`assertInside`), and computes the fields above. `harnessUrlPath = "/" + posix(relative(viteRoot, harnessDir)) + "/index.html"`.

#### 5.4.2 `backend/harness-templates/index.html` (full)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PRVision harness</title>
    <!--
      PRVision render harness page (static template, sheet 10).
      Served by the target repo's Vite at /.prvision-harness/index.html?c=<componentId>.
      #prvision-root is a full-width block so components lay out as they would in a page;
      the backend crops the screenshot to the painted area (anchored at the top-left).
    -->
    <style id="prvision-base-style">
      html,
      body {
        margin: 0;
        padding: 0;
        background: #ffffff;
      }
      #prvision-root {
        display: flow-root;
        box-sizing: border-box;
        width: 100%;
        min-height: 48px;
        padding: 0;
      }
    </style>
  </head>
  <body>
    <div id="prvision-root"></div>
    <script type="module" src="./entry.tsx"></script>
  </body>
</html>
```

Why block, not `inline-block`: shrink-to-fit containers collapse `w-full`/`flex justify-between` layouts (navbars, toolbars, tables) into their min-content width, which misrepresents most real components. A 1280 px block container gives realistic layout; tightness of the image is achieved by the painted-area clip (5.11.7), not by the container. `display: flow-root` contains child margins and floats so the root's own box is meaningful. `min-height: 48px` guarantees a non-zero root box for components that render nothing. No root padding: a full-screen component must start at the viewport's edge and be exactly as wide as it, or it overflows narrow (mobile) viewports and the capture shows a margin the app does not have. The user's global CSS loads after this block and may override `body` background — intended, so components look as they do in the app.

#### 5.4.3 `backend/harness-templates/entry.tsx` (full)

```tsx
/** @jsxRuntime automatic */
/*
 * PRVision render harness entry (static template, sheet 10).
 * Copied verbatim to <viteRoot>/.prvision-harness/entry.tsx before every render run.
 *
 * Page URL:  /.prvision-harness/index.html?c=<componentId>&quiet=<ms>&settleMax=<ms>&assetWait=<ms>
 * Signals:   window.__PRVISION_STATUS__  booting | importing | mounting | settling | ready | error
 *            window.__PRVISION_READY__   true once mounted and visually settled
 *            window.__PRVISION_ERROR__   { phase, message, stack, componentStack } on failure (first error wins)
 *
 * This file must not import application code except through ./globals and ./components/*.
 */
import { Suspense, useEffect, type ComponentType, type ReactElement } from "react";
import { mount } from "virtual:prvision-mount";
import { PrvisionErrorBoundary } from "./error-boundary";

type PrvisionPhase = "booting" | "importing" | "mounting" | "settling" | "ready" | "error";

interface PrvisionErrorReport {
  phase: "import" | "mount" | "render";
  message: string;
  stack: string | null;
  componentStack: string | null;
}

declare global {
  interface Window {
    __PRVISION_STATUS__?: PrvisionPhase;
    __PRVISION_READY__?: boolean;
    __PRVISION_ERROR__?: PrvisionErrorReport | null;
  }
}

// Lazy map of every generated harness module; only the requested one is fetched.
const harnessModules = import.meta.glob<{ default?: unknown }>("./components/*.tsx");

const params = new URLSearchParams(window.location.search);
const componentId = params.get("c") ?? "";
const quietMs = readPositiveInt(params.get("quiet"), 250);
const settleMaxMs = readPositiveInt(params.get("settleMax"), 5000);
const assetWaitMs = readPositiveInt(params.get("assetWait"), 3000);

function readPositiveInt(raw: string | null, fallback: number): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function setPhase(phase: PrvisionPhase): void {
  window.__PRVISION_STATUS__ = phase;
}

function reportError(phase: PrvisionErrorReport["phase"], error: unknown, componentStack: string | null = null): void {
  if (window.__PRVISION_READY__ === true || window.__PRVISION_ERROR__) {
    return; // first error wins; errors after ready are console noise, not render failures
  }
  const normalized = error instanceof Error ? error : new Error(String(error));
  window.__PRVISION_ERROR__ = {
    phase,
    message: normalized.message || String(error),
    stack: normalized.stack ?? null,
    componentStack,
  };
  setPhase("error");
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([promise.then(() => undefined, () => undefined), delay(ms)]);
}

/** Resolves after `quiet` ms without DOM mutations under `target`, or after `max` ms. */
function waitForDomQuiet(target: Node, quiet: number, max: number): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer = window.setTimeout(finish, quiet);
    const hardTimer = window.setTimeout(finish, max);
    const observer = new MutationObserver(() => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(finish, quiet);
    });
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    function finish(): void {
      observer.disconnect();
      window.clearTimeout(quietTimer);
      window.clearTimeout(hardTimer);
      resolve();
    }
  });
}

function waitForImages(max: number): Promise<void> {
  const pending = Array.from(document.images).filter((image) => !image.complete);
  const loaded = Promise.all(
    pending.map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  return settleWithin(loaded, max);
}

/** Commits together with the harness (same Suspense boundary), so its effect marks "harness committed". */
function ReadyProbe(props: { onCommit: () => void }): null {
  const { onCommit } = props;
  useEffect(() => {
    onCommit();
  }, [onCommit]);
  return null;
}

function isRenderableComponent(value: unknown): value is ComponentType {
  return typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
}

async function main(): Promise<void> {
  window.__PRVISION_READY__ = false;
  window.__PRVISION_ERROR__ = null;
  setPhase("booting");

  const container = document.getElementById("prvision-root");
  if (container === null) {
    reportError("mount", new Error("#prvision-root is missing from the harness index.html."));
    return;
  }

  const moduleKey = `./components/${componentId}.tsx`;
  const loadHarness = harnessModules[moduleKey];
  if (!/^\d+$/.test(componentId) || loadHarness === undefined) {
    reportError("import", new Error(`No harness module found for component "${componentId}" (expected ${moduleKey}).`));
    return;
  }

  setPhase("importing");
  let Harness: ComponentType;
  try {
    // Global styles first (dynamic so a failing stylesheet is reported, not a silent entry failure).
    await import("./globals");
    const harnessModule = await loadHarness();
    if (!isRenderableComponent(harnessModule.default)) {
      throw new Error("The harness module has no default export. It must `export default function PRVisionHarness()`.");
    }
    Harness = harnessModule.default;
  } catch (error) {
    reportError("import", error);
    return;
  }

  setPhase("mounting");
  let markCommitted: () => void = () => undefined;
  const committed = new Promise<void>((resolve) => {
    markCommitted = resolve;
  });
  const tree: ReactElement = (
    <PrvisionErrorBoundary onError={(error, componentStack) => reportError("render", error, componentStack)}>
      <Suspense fallback={null}>
        <Harness />
        <ReadyProbe onCommit={markCommitted} />
      </Suspense>
    </PrvisionErrorBoundary>
  );

  try {
    mount(container, tree);
  } catch (error) {
    reportError("mount", error);
    return;
  }

  await committed; // never resolves if the boundary caught an error; the backend sees __PRVISION_ERROR__ instead
  if (window.__PRVISION_ERROR__) return;

  setPhase("settling");
  await nextFrame();
  await nextFrame();
  await waitForDomQuiet(document.body, quietMs, settleMaxMs);
  await settleWithin(document.fonts.ready, assetWaitMs);
  await waitForImages(assetWaitMs);
  await nextFrame();
  await nextFrame();
  if (window.__PRVISION_ERROR__) return;

  window.__PRVISION_READY__ = true;
  setPhase("ready");
}

void main().catch((error: unknown) => {
  reportError("mount", error);
});
```

Notes for the implementer:

- `/** @jsxRuntime automatic */` makes the template independent of the project's JSX setting (classic runtime projects, projects without `@vitejs/plugin-react`). Both esbuild and Babel honour the pragma.
- `import.meta.glob` with a generic is supported by Vite ≥ 3. The glob is evaluated when the entry is transformed; since every server is started after all harness files are written, the map is complete. Repaired harness files are rendered in new servers (5.13.6), so a stale glob is impossible.
- `ReadyProbe` sits inside the same `Suspense` boundary as the harness, so it commits only when the harness tree commits (siblings in a boundary commit together). Nested Suspense boundaries inside the harness can still commit fallbacks first; the DOM-quiet wait covers that.
- Phase `import` errors become failure kind `module_load`; `render`/`mount` become `render_error` (5.12).

#### 5.4.4 `backend/harness-templates/error-boundary.tsx` (full)

```tsx
/** @jsxRuntime automatic */
/*
 * PRVision render harness error boundary (static template, sheet 10).
 * Reports the first render error (with React's component stack) to the entry, then shows a visible marker.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface PrvisionErrorBoundaryProps {
  children?: ReactNode;
  onError: (error: unknown, componentStack: string | null) => void;
}

interface PrvisionErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

export class PrvisionErrorBoundary extends Component<PrvisionErrorBoundaryProps, PrvisionErrorBoundaryState> {
  state: PrvisionErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): PrvisionErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError(error, info.componentStack ?? null);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return (
      <pre
        data-prvision-error=""
        style={{
          margin: 0,
          padding: 12,
          font: "12px/1.4 monospace",
          color: "#b00020",
          background: "#fff0f0",
          whiteSpace: "pre-wrap",
        }}
      >
        {message}
      </pre>
    );
  }
}
```

No `override` keywords: template files are not type-checked by the backend and must parse with any Babel/esbuild version a target repo uses.

#### 5.4.5 Generated `components/<id>.tsx`

```ts
export const HARNESS_JSX_PRAGMA = "/** @jsxRuntime automatic */";

/** Prepends the automatic-runtime pragma unless the harness already declares a JSX pragma. */
export function toHarnessFileSource(harnessSource: string): string {
  const hasPragma = /@jsx(Runtime|ImportSource)?\s/.test(harnessSource.slice(0, 2000));
  const header = `// Generated by PRVision for this render run. Do not edit.\n`;
  return hasPragma ? `${header}${harnessSource}\n` : `${HARNESS_JSX_PRAGMA}\n${header}${harnessSource}\n`;
}
```

The file name is `${componentId}.tsx` (numeric id from the DB, so no path injection). The harness imports the component under test with the exact relative statement 09 prescribes (`targetImportPath(headPath, viteRootRel)`, 09 §5.2, e.g. `../../src/components/Button/Button`); other repository imports may use the project alias form. Both resolve through the repo's Vite. Harness conventions (00 §14.7): default export `PRVisionHarness`, wrappers styled with inline `style` only, mocks per 5.8.1.

Renamed components (base path ≠ head path, `RenderComponentInput.basePath`): the **base-side** file is written from `rewriteTargetSpecifier(harnessSource, targetImportPath(headPath, viteRootRel), targetImportPath(basePath, viteRootRel))`; the head-side file uses the source unchanged.

```ts
/** Replaces the single module specifier string literal equal to `from` (ImportDeclaration/ExportDeclaration only) by `to`.
 *  AST-based (ts.createSourceFile, TSX): finds the StringLiteral node and splices the text at [getStart()+1, getEnd()-1).
 *  Throws Error("target specifier not found exactly once") when the count is not 1 — 09's validator guarantees it (09 §5.8 step 4);
 *  RenderRun turns the throw into a base-side `module_load` failure with that message. */
export function rewriteTargetSpecifier(source: string, from: string, to: string): string;
```

If `harnessSource` contains `className=` the writer emits one console warning per run: harness wrappers should use inline `style` because Tailwind does not scan `.prvision-harness/` (5.10).

#### 5.4.6 Generated `globals.ts`

`repository.globalStylePaths` entries are **import specifiers** (00 §14.3): `/src/index.css` for repository files (root-relative, i.e. relative to the worktree root, which is the Vite root in the prototype) and bare names for package stylesheets (`bootstrap/dist/css/bootstrap.min.css`, `@fontsource/inter`).

```ts
export function buildGlobalsSource(
  layout: HarnessSideLayout,
  globalStylePaths: readonly string[],
  exists: (absolutePath: string) => boolean,
): { source: string; missing: string[] } {
  const lines = ["// Generated by PRVision: global styles of the repository, in detection order.", ""];
  const missing: string[] = [];
  for (const specifier of globalStylePaths) {
    if (specifier.startsWith("/")) {
      const absolute = path.join(layout.worktreeDir, specifier.slice(1));
      assertInside(layout.worktreeDir, absolute);
      if (!exists(absolute)) {
        missing.push(specifier);
        lines.push(`// missing on the ${layout.side} side: ${specifier}`);
        continue;
      }
      const relative = toPosix(path.relative(layout.harnessDir, absolute));
      lines.push(`import ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};`);
      continue;
    }
    // Bare package stylesheet: emit only when the package is installed (a failing import would break every render).
    const pkg = packageNameOf(specifier);
    if (pkg === null || !exists(path.join(layout.viteRoot, "node_modules", pkg, "package.json"))) {
      missing.push(specifier);
      lines.push(`// package not installed: ${specifier}`);
      continue;
    }
    lines.push(`import ${JSON.stringify(specifier)};`);
  }
  lines.push("", "export {};", "");
  return { source: lines.join("\n"), missing };
}
```

Example output: `import "../src/index.css";` and `import "bootstrap/dist/css/bootstrap.min.css";`. Order is preserved because CSS insertion order follows import order. Missing entries are logged as a console warning (`"Global style /src/old.css does not exist on the base side"`) and do not fail anything. Entries that are neither root-relative nor bare (e.g. `./x.css`, `../x.css`) are rejected by 06's detection; here they are treated as missing.

#### 5.4.7 `.gitignore`

Content: `*\n`. This makes `.prvision-harness/` (including `.vite-cache/`) invisible to `git status` in the worktree and to Tailwind v4's automatic source detection, which honours nested `.gitignore` files. Consequence: classes used only in harness or mock code are not generated (see 5.10 and section 11, item 5).

#### 5.4.8 `HarnessWorkspaceWriter`

```ts
export class HarnessWorkspaceWriter {
  constructor(private readonly templatesDir: string = HARNESS_TEMPLATES_DIR) {}   // 00 §14.8; value set by 02

  /** mkdir -p, copy templates (overwrite), write .gitignore and globals.ts. Returns missing global styles. */
  async prepareSide(layout: HarnessSideLayout, globalStylePaths: readonly string[]): Promise<{ missingStyles: string[] }>;

  /** Writes components/<id>.tsx atomically (tmp + rename). Returns the absolute path. */
  async writeComponentHarness(layout: HarnessSideLayout, componentId: number, harnessSource: string): Promise<string>;
}

/** Throws HarnessTemplatesMissingError when index.html, entry.tsx or error-boundary.tsx is absent in `dir`.
 *  Called once at the start of renderAll (fatal: "PRVision's harness templates are missing (backend/harness-templates). Reinstall PRVision."). */
export function assertTemplatesPresent(dir: string): Promise<void>;

/** Throws Error("Path escapes worktree: …") if `child` is not inside `parent` after path.resolve. */
export function assertInside(parent: string, child: string): void;
```

`prepareSide` steps:

1. `assertInside(layout.worktreeDir, layout.harnessDir)`; `fs.mkdir(componentsDir, { recursive: true })`.
2. Copy `index.html`, `entry.tsx`, `error-boundary.tsx` from `templatesDir` (`fs.copyFile`, overwrite).
3. Write `.gitignore` (`*\n`).
4. Build and write `globals.ts`.
5. Never touch `node_modules` (it is a symlink to the user's real `node_modules`).

`scanReferencedEnvKeys(roots: string[]): Promise<string[]>` walks each root (skipping `node_modules`, `.git`, `.prvision-harness`, `dist`, `build`, `coverage`), reads files with extensions `.ts .tsx .js .jsx .mjs .mts` up to 1 MB each and 5 000 files total, and collects `/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g` matches whose name starts with the env prefix (`VITE_` default). Returns a sorted, de-duplicated list. Used for missing-env defaults (5.7.4).

### 5.5 Loading the target repo's Vite

#### 5.5.1 `render/esm-import.ts`

```ts
/**
 * Dynamic import of the target repo's Vite entry (a file:// URL).
 * The backend compiles with `module: nodenext` (01 §2): TypeScript keeps `import()` as a native dynamic import
 * in CommonJS output (it is NOT rewritten to require()), so ESM-only Vite 7 loads correctly. ts-node (dev, tests)
 * uses the same tsconfig. No `new Function`/eval trick is needed or allowed (no-implied-eval, CSP-style hygiene).
 * `require(esm)` is not used here because the URL is computed at runtime and Vite's entry may use top-level await.
 */
export async function esmImport(fileUrl: string): Promise<unknown> {
  return import(fileUrl);
}
```

A unit test compiles this file with the backend tsconfig and asserts the emitted JS still contains `import(` (guards against a future `module: commonjs` regression).

#### 5.5.2 `render/vite-loader.ts`

```ts
export type ViteLoadFailureKind = "vite_not_found" | "vite_unsupported" | "vite_load_failed";

export class ViteLoadError extends Error {
  constructor(message: string, readonly kind: ViteLoadFailureKind, readonly detail: string | null = null) {
    super(message);
  }
}

export interface LoadedVite {
  module: ViteModuleLike;
  version: string;
  major: number;
  minor: number;
  packageDir: string;   // realpath of node_modules/vite
  entryPath: string;    // file that was imported
}

export async function loadTargetVite(viteRoot: string): Promise<LoadedVite>;
```

Algorithm:

1. `const requireFromRoot = createRequire(path.join(viteRoot, "package.json"));` (the file need not exist).
2. Locate `package.json`:
   - `requireFromRoot.resolve("vite/package.json")` (exported by Vite 4–7, verified).
   - Fallback: `requireFromRoot.resolve("vite")`, then walk up from the result to the nearest `package.json` whose `name === "vite"`.
   - Both fail → `ViteLoadError("Vite is not installed for this repository (looked from <viteRoot>). Install dependencies in your clone; PRVision reuses its node_modules.", "vite_not_found")`.
   - Node follows the `node_modules` symlink to the real path inside the user's clone; that is expected.
3. Parse `version`; `major`, `minor` from `/^(\d+)\.(\d+)/`. If `major < 4` → `vite_unsupported` (`"Vite 3.2.7 is not supported. PRVision supports Vite 4 to 7."`). If `major > 7` → continue, but return a warning the host forwards as a `warn` log (`"Vite 8.0.0 is newer than the tested range (4–7)"`).
4. Pick the ESM entry. Do **not** import what `require.resolve("vite")` returns: for Vite 4–6 that is `index.cjs` (the deprecated CJS build that prints a warning in Vite 5/6). Instead resolve the `exports["."]` target with conditions `["import", "module-sync", "default"]`:

   ```ts
   export function resolveExportTarget(entry: unknown, conditions: readonly string[]): string | null {
     if (typeof entry === "string") return entry;
     if (Array.isArray(entry)) {
       for (const candidate of entry) {
         const resolved = resolveExportTarget(candidate, conditions);
         if (resolved !== null) return resolved;
       }
       return null;
     }
     if (typeof entry === "object" && entry !== null) {
       const record = entry as Record<string, unknown>;
       for (const condition of conditions) {
         if (condition in record) {
           const resolved = resolveExportTarget(record[condition], conditions);
           if (resolved !== null) return resolved;
         }
       }
     }
     return null;
   }
   // pkg.exports may be a string, a conditions object, or a subpath map with ".".
   ```

   Observed shapes (all handled): Vite 4 `{"types","import":"./dist/node/index.js","require":"./index.cjs"}`; Vite 5 `{"import":{"types","default":"./dist/node/index.js"},"require":{…}}`; Vite 6 `{"module-sync","import","require"}`; Vite 7 `"./dist/node/index.js"`. Fallback when `exports` is absent: `pkg.module ?? pkg.main ?? "index.js"`.
5. `const namespace = await esmImport(pathToFileURL(entryPath).href)`. On throw → `vite_load_failed` with message including `process.version` and `pkg.engines?.node` (`"Vite 7.3.1 could not be loaded with Node v22.11.0 (requires ^20.19.0 || >=22.12.0): <error>"`).
6. Normalize: `const candidate = isViteModuleLike(namespace) ? namespace : isRecord(namespace) && isViteModuleLike(namespace.default) ? namespace.default : null`. `null` → `vite_unsupported` ("The installed Vite does not export createServer").
7. Required functions: `createServer`, `loadConfigFromFile`, `mergeConfig`, `createLogger`, `loadEnv`, `transformWithEsbuild`. Optional: `searchForWorkspaceRoot`, `transformWithOxc`. Missing required ones (other than `transformWithEsbuild` when `transformWithOxc` exists) → `vite_unsupported`.

Structural types (no `any`):

```ts
// render/render-types.ts
export type UnknownRecord = Record<string, unknown>;

export interface ViteLoggerLike {
  info(message: string, options?: UnknownRecord): void;
  warn(message: string, options?: UnknownRecord): void;
  warnOnce(message: string, options?: UnknownRecord): void;
  error(message: string, options?: UnknownRecord): void;
  clearScreen(type: string): void;
  hasErrorLogged(error: unknown): boolean;
  hasWarned: boolean;
}

export interface ViteResolvedIdLike { id: string; external?: boolean | "absolute" | "relative"; }

export interface VitePluginContextLike {
  resolve(
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean; isEntry?: boolean; custom?: unknown; ssr?: boolean },
  ): Promise<ViteResolvedIdLike | null>;
}

export interface ViteResolveIdOptions { scan?: boolean; ssr?: boolean; isEntry?: boolean; custom?: unknown; }

export interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post";
  apply?: "serve" | "build" | ((...args: unknown[]) => boolean);
  resolveId?: (
    this: VitePluginContextLike,
    source: string,
    importer: string | undefined,
    options: ViteResolveIdOptions,
  ) => Promise<string | ViteResolvedIdLike | null> | string | ViteResolvedIdLike | null;
  load?: (this: VitePluginContextLike, id: string) => Promise<{ code: string; map: null } | null> | { code: string; map: null } | null;
}

export interface ViteDevServerLike {
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServerLike>;
  close(): Promise<void>;
  httpServer: { address(): string | { address: string; port: number } | null } | null;
  resolvedUrls?: { local: string[]; network: string[] } | null;
}

export interface ViteModuleLike {
  version?: string;
  createServer(config: UnknownRecord): Promise<ViteDevServerLike>;
  loadConfigFromFile(
    env: { command: "serve"; mode: string; isSsrBuild?: boolean; isPreview?: boolean; ssrBuild?: boolean },
    configFile?: string,
    configRoot?: string,
    logLevel?: string,
  ): Promise<{ path: string; config: UnknownRecord; dependencies: string[] } | null>;
  mergeConfig(defaults: UnknownRecord, overrides: UnknownRecord, isRoot?: boolean): UnknownRecord;
  createLogger(level?: string, options?: UnknownRecord): ViteLoggerLike;
  loadEnv(mode: string, envDir: string, prefixes?: string | string[]): Record<string, string>;
  transformWithEsbuild?(code: string, filename: string, options?: UnknownRecord): Promise<{ code: string }>;
  transformWithOxc?(code: string, filename: string, options?: UnknownRecord): Promise<{ code: string }>;
  searchForWorkspaceRoot?(current: string): string;
}

export function isViteModuleLike(value: unknown): value is ViteModuleLike {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as UnknownRecord).createServer === "function" &&
    typeof (value as UnknownRecord).mergeConfig === "function"
  );
}
```

#### 5.5.3 Vite version compatibility matrix

| Concern | Vite 4.x | Vite 5.x | Vite 6.x | Vite 7.x |
|---|---|---|---|---|
| Package entry | ESM `dist/node/index.js` via `exports.import` | ESM via `exports.import.default` | ESM via `exports.import`/`module-sync` | ESM only, `exports["."]` string |
| `server.watch: null` | not supported → `{ ignored: ["**/*"] }` | `null` when minor ≥ 4 (verified in 5.4), else ignore-all | `null` | `null` |
| `server.warmup.clientFiles` | ignored (not set) | set | set | set |
| `optimizeDeps.holdUntilCrawlEnd` | unknown key, harmless | ≥ 5.1 | yes | yes |
| `resolveId` `options.scan` during dep scan | yes (4.4 verified) | yes | yes | yes |
| Error response body for failed module | `new ErrorOverlay({json})` | `const error = {json}` | same as 5 | same as 5 |
| Config bundling temp file | next to config file (worktree) | next to config file | `node_modules/.vite-temp/` | `node_modules/.vite-temp/` (user's real node_modules via symlink; deleted by Vite right after load) |
| Node requirement | ≥ 14.18 | ≥ 18 | ≥ 18 | ≥ 20.19 / ≥ 22.12 |
| Mock transpile | `transformWithEsbuild` | same | same | same (fallback `transformWithOxc` if a future build lacks esbuild) |

```ts
export function resolveWatchOption(major: number, minor: number): null | { ignored: string[] } {
  return major > 5 || (major === 5 && minor >= 4) ? null : { ignored: ["**/*"] };
}
```

A Vite load failure is per side: the host reports `start_failed` and **every** component on that side fails with that message (5.13.4). It is sticky: later groups do not retry the same side.

### 5.6 Vite host child process

#### 5.6.1 IPC protocol (`render/render-types.ts`)

```ts
export interface MockEntryInput {
  componentId: number;
  componentFile: string;   // absolute path of the component file on this side
  specifier: string;       // MockedModule.specifier (already validated)
  source: string;          // MockedModule.source
}

export interface ViteHostStartOptions {
  side: RenderSide;
  groupKey: string;
  worktreeDir: string;
  viteRoot: string;
  harnessDir: string;
  cacheDir: string;
  configFile: string | null;          // null → auto-detect vite.config.{ts,mts,cts,js,mjs,cjs} in viteRoot
  optimizeEntries: string[];          // root-relative POSIX paths: entry.tsx, globals.ts, every components/<id>.tsx on this side
  warmupFiles: string[];              // root-relative POSIX paths: entry.tsx + this group's component files
  referencedEnvKeys: string[];        // union over both sides (5.4.8)
  mocks: MockEntryInput[];            // this group's accepted mocks on this side
}

export type ViteHostRequest = { type: "start"; options: ViteHostStartOptions } | { type: "shutdown" };

export type ViteHostStartFailureKind =
  | "vite_not_found" | "vite_unsupported" | "vite_load_failed"
  | "react_missing" | "react_unsupported"
  | "config_error" | "listen_error" | "unknown";

export type ViteHostEvent =
  | {
      type: "ready";
      origin: string;                  // e.g. "http://127.0.0.1:53817"
      viteVersion: string;
      reactDomVersion: string;
      tailwindMajor: 3 | 4 | null;
      configFile: string | null;
      warnings: string[];              // sanitization notes, untested-version notes, rejected mocks
    }
  | { type: "start_failed"; kind: ViteHostStartFailureKind; message: string; detail: string | null }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; at: number }
  | { type: "closed" };

/** Failures that will repeat for every group on the same side; the side is marked broken for the rest of the run. */
export const STICKY_START_FAILURES: ReadonlySet<ViteHostStartFailureKind> = new Set([
  "vite_not_found", "vite_unsupported", "vite_load_failed", "react_missing", "react_unsupported", "config_error",
]);

export function isViteHostEvent(value: unknown): value is ViteHostEvent; // validates `type` and required fields
```

#### 5.6.2 Parent side: `render/vite-host-client.ts`

```ts
export interface ViteLogEntry { seq: number; level: "info" | "warn" | "error"; message: string; at: number; }

export interface ViteHostHandle {
  readonly side: RenderSide;
  readonly groupKey: string;
  readonly origin: string;
  readonly viteVersion: string;
  readonly reactDomVersion: string;
  readonly tailwindMajor: 3 | 4 | null;
  readonly harnessUrlPath: string;
  isAlive(): boolean;
  exitReason(): string | null;                   // "exited with code 1 (signal null)" etc.
  currentSeq(): number;
  logsSince(seq: number, level?: "warn" | "error"): ViteLogEntry[];
  sawDepsReoptimizeSince(seq: number): boolean;  // "optimized dependencies changed" / "new dependencies optimized"
  stop(): Promise<void>;                         // idempotent; never throws
}

export class ViteHostStartError extends Error {
  constructor(message: string, readonly kind: ViteHostStartFailureKind | "timeout" | "exited" | "aborted", readonly detail: string | null) {
    super(message);
  }
  get sticky(): boolean { return this.kind !== "timeout" && this.kind !== "exited" && this.kind !== "aborted" && STICKY_START_FAILURES.has(this.kind); }
}

export class ViteHostClient {
  /** Live children, killed with SIGKILL on process "exit" (registered once). */
  private static readonly live = new Set<ChildProcess>();
  static liveCount(): number;
  static start(options: ViteHostStartOptions, harnessUrlPath: string, signal: AbortSignal): Promise<ViteHostHandle>;
}
```

`start` algorithm:

1. If `signal.aborted` → throw `ViteHostStartError("Cancelled", "aborted")`.
2. `fork(hostEntryPath(), [], { cwd: options.viteRoot, env: buildChildEnv(), execArgv: childExecArgv(), stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json", detached: true })`.
   - `detached: true` makes the child the leader of a new process group (POSIX `setsid`), so `killGroup(child)` = `process.kill(-child.pid, "SIGKILL")` also kills grandchildren that Vite or user plugins spawn (esbuild service, Tailwind oxide workers, PostCSS helpers). Do **not** call `child.unref()`: the worker must keep the handle so the `exit` event fires and Node reaps the child (no zombies). Linux and macOS only (00 D12).
   - `hostEntryPath()` = `path.join(__dirname, \`vite-host-process${path.extname(__filename)}\`)` (`.ts` under ts-node in dev and tests, `.js` from `dist`).
   - `childExecArgv()` is built from scratch, never copied from `process.execArgv` (ts-node-dev injects its own `--require …/wrap.js`, which would try to talk to the ts-node-dev parent; inspector flags would collide on the debug port): `["--max-old-space-size=" + VITE_HOST_MAX_OLD_SPACE_MB]`, plus `["-r", "ts-node/register/transpile-only"]` when the entry ends in `.ts` (02's dev and test runner, 00 §14.10).
   - `buildChildEnv(base = CHILD_PROCESS_BASE_ENV): Record<string, string>` (pure): `{ ...base, ...fixed }`, where `fixed` is a module-private object literal (not a config constant) holding `NODE_ENV=development`, `BROWSER=none`, `FORCE_COLOR=0`, `NO_COLOR=1`, `BROWSERSLIST_IGNORE_OLD_DATA=1`, plus — only when the entry is `.ts` — `TS_NODE_TRANSPILE_ONLY=true` and `TS_NODE_PROJECT=<backend tsconfig.json>` resolved from this module's own location (`__dirname`), so ts-node never picks up the target repository's tsconfig from `cwd`. It never reads `process.env` (00 §14.12: only `config-consts` does) and copies nothing from the parent beyond `CHILD_PROCESS_BASE_ENV`, so `DATABASE_URL`, `REDIS_URL`, `PRVISION_SECRET_KEY`, every `PRVISION_*`, `ANTHROPIC_*`, `GITHUB_*` and `NODE_OPTIONS` are absent (00 §14.5).
3. Add to `live`; pipe stdout/stderr line-by-line to `log.debug({ event: "render.vite_host.output", side, groupKey, stream, line }, "Vite host output")` (01 §5.8: constant message, data in fields) (cap 2 000 lines per child; then one "output truncated" line). Drain both streams always (an unread pipe can block the child once its buffer fills).
4. Send `{ type: "start", options }`.
5. Startup detection is message-based, never by parsing stdout: race `ready` (resolve handle) / `start_failed` (kill group, throw `ViteHostStartError(message, kind, detail)`) / child `exit` before ready (throw `"exited"` with the last 5 error logs) / `VITE_START_TIMEOUT_MS` (kill group, throw `"timeout"`: `"The Vite dev server for the head side did not become ready within 60 s."`) / `signal` abort (kill group, throw `"aborted"`). Every branch removes its listeners and clears its timer.
6. After ready, `log` events go into a ring buffer (`VITE_HOST_LOG_BUFFER_SIZE` = 500) with a monotonically increasing `seq`. `error` and `warn` entries are also mirrored to `log.debug`. Messages tagged `[prvision-mock]` are additionally surfaced by `RenderRun` as console warnings (once per message).
7. `stop()`: if already exited → return. Send `shutdown`; wait for `exit` up to `VITE_STOP_TIMEOUT_MS`; then `killGroup(child)` and wait for `exit` up to 1 s more; remove from `live`. Never throws (log at `warn`). After a group kill, `ESRCH` (already gone) is ignored.

Orphan prevention, three layers:

- Normal path: `stop()` per host in `RenderRun.cleanup()` (5.13.9) and in `abortInFlight()`.
- Worker crash or exit: `process.once("exit", () => { for (const child of ViteHostClient.live) killGroupSync(child); })` is registered once at module load (synchronous `process.kill` only — `exit` handlers cannot await). The worker's SIGINT/SIGTERM handler (04 §9.11) closes the queue, which aborts the job, which runs `cleanup()` first.
- Worker killed with SIGKILL (no handler runs): the child's IPC channel closes, its `disconnect` handler calls `shutdown(0)` (5.6.3), and a 5 s watchdog in the child calls `process.exit(1)` if `server.close()` hangs. Plugin grandchildren are reaped when the child (their group leader) exits or by the next run's `stop()`.

#### 5.6.3 Child side: `render/vite-host-process.ts`

```ts
let server: ViteDevServerLike | null = null;
let shuttingDown = false;

function send(event: ViteHostEvent): void {
  if (process.connected && process.send) process.send(event);
}

process.on("message", (raw: unknown) => {
  if (!isViteHostRequest(raw)) return;
  if (raw.type === "start") void start(raw.options);
  else void shutdown(0);
});
process.on("disconnect", () => { void shutdown(0); });      // parent died
process.on("unhandledRejection", (reason) => { send({ type: "log", level: "error", message: `Unhandled rejection in Vite host: ${describe(reason)}`, at: Date.now() }); });
process.on("uncaughtException", (error) => {
  send({ type: "log", level: "error", message: `Uncaught exception in Vite host: ${describe(error)}`, at: Date.now() });
  if (server === null) { send({ type: "start_failed", kind: "unknown", message: describe(error), detail: stackOf(error) }); void shutdown(1); }
});
```

`start(options)` steps (each failure → `start_failed` with the listed kind, then `shutdown(1)`):

1. `loadTargetVite(options.viteRoot)` → kinds from `ViteLoadError`.
2. Detect versions from `createRequire(join(viteRoot, "package.json"))`:
   - `react-dom/package.json` → missing → `react_missing` ("react-dom is not installed for this repository."); major < 16 or (16 and minor < 8) → `react_unsupported`.
   - `tailwindcss/package.json` → `tailwindMajor` 3 / 4 / null (diagnostics only).
3. `const logger = createForwardingLogger(vite)`: `vite.createLogger("info", { allowClearScreen: false })` wrapped so `info/warn/warnOnce/error` strip ANSI (`/\x1b\[[0-9;]*m/g`) and `send({ type: "log", … })`; `error` appends `options.error.stack` when present; `clearScreen` is a no-op.
4. Load the user config:
   - `configFile = options.configFile ?? detectConfigFile(viteRoot)` (first existing of `vite.config.ts, .mts, .cts, .js, .mjs, .cjs`).
   - `const loaded = configFile ? await vite.loadConfigFromFile({ command: "serve", mode: "development", isSsrBuild: false, isPreview: false, ssrBuild: false }, configFile, viteRoot, "silent") : null`. Throw → `config_error` (`"Loading vite.config.ts failed on the head side: <message>"`).
   - `userConfig = loaded?.config ?? {}`.
5. `userPlugins = await flattenUserPlugins(userConfig.plugins)` and filter (5.7.5). Throw → `config_error`.
6. Build plugins: `mockPlugin = createMockPlugin({ … })` (5.8) and `harnessPlugin = createHarnessPlugin({ reactDomMajor })` (5.9).
7. Env defaults: `envDir = resolve(viteRoot, userConfig.envDir ?? ".")`; `prefixes = userConfig.envPrefix ?? "VITE_"`; `loadedEnv = vite.loadEnv("development", envDir, prefixes)`; for each `key` in `referencedEnvKeys` not in `loadedEnv` and not already in `userConfig.define` as `import.meta.env.<key>`: `envDefines["import.meta.env." + key] = JSON.stringify("")`.
7b. `port = await findFreePort()`: `net.createServer().listen(0, "127.0.0.1")`, read `address().port`, close it, return the port. Passed as `server.port` (5.7.2). Rationale: Vite does not honour `port: 0` — its `startServer` treats a falsy configured port as "use the default 5173" (`!configPort` check in `startServer`; verify against the oldest supported Vite when implementing), so the OS-assigned-port trick silently becomes 5173/5174/…, racing between the base and head hosts started in parallel and with the user's own dev server. The tiny race between closing the probe socket and Vite's `listen` is covered by `strictPort: false` (Vite then tries the next port) and by reading the real port back in step 12.
8. `fsAllow = unique([viteRoot, worktreeDir, harnessDir, cacheDir, realpathIfExists(join(viteRoot, "node_modules")), realpathIfExists(join(worktreeDir, "node_modules")), vite.searchForWorkspaceRoot?.(viteRoot)])`.
9. `const { config, warnings } = buildViteInlineConfig({ … })` (5.7).
10. `server = await vite.createServer(config)` → throw → `config_error` (plugin `config`/`configResolved` hooks run here).
11. `await server.listen()` → throw → `listen_error`.
12. `origin = resolveOrigin(server)`: `server.httpServer?.address()`; if it is an object, `http://127.0.0.1:${address.port}` (the real bound port, which may differ from step 7b); else `server.resolvedUrls?.local[0]` without trailing slash; else `listen_error` ("Vite did not report a listening address").
13. `send({ type: "ready", origin, viteVersion, reactDomVersion, tailwindMajor, configFile, warnings })`.

`shutdown(code)`: guard re-entry; start an unref'd watchdog `setTimeout(() => process.exit(code || 1), 5000)`; `await Promise.race([server?.close(), delay(4000)])`; `send({ type: "closed" })` when still connected; `process.exit(code)`. `process.exit` (not waiting for the event loop to drain) is deliberate: user plugins may leave handles open.

### 5.7 Vite inline config (`render/vite-server-config.ts`)

#### 5.7.1 Signature

```ts
export interface BuildInlineConfigInput {
  vite: ViteModuleLike;
  viteMajor: number;
  viteMinor: number;
  options: ViteHostStartOptions;
  userConfig: UnknownRecord;            // as loaded; {} when no config file
  userConfigFound: boolean;
  userPlugins: VitePluginLike[];        // flattened + filtered
  mockPlugin: VitePluginLike;
  harnessPlugin: VitePluginLike;
  logger: ViteLoggerLike;
  fsAllow: string[];
  envDefines: Record<string, string>;
  reactDomMajor: number;
  port: number;                         // 5.6.3 step 7b
}

export function buildViteInlineConfig(input: BuildInlineConfigInput): { config: UnknownRecord; warnings: string[] };
```

Pure function (no IO), fully unit-tested.

#### 5.7.2 Algorithm

1. **Shallow-copy and sanitize the user config** (never mutate `input.userConfig`):
   - Delete top-level: `root`, `base`, `cacheDir`, `configFile`, `mode`, `appType`, `logLevel`, `customLogger`, `clearScreen`, `plugins`.
     - If `root` was set and resolves to something other than `viteRoot` → warning `"Ignoring root: <value> from the Vite config; PRVision serves from <viteRoot>"`.
     - If `base` was set and is not `"/"` → warning `"Ignoring base: <value>; the harness is served at /"`.
   - `server` copy: delete `proxy`, `https`, `open`, `port`, `strictPort`, `host`, `hmr`, `watch`, `warmup`, `origin`, `middlewareMode`, `ws`. Warning per removed key that changes behaviour (`proxy`, `https`).
   - `optimizeDeps` copy: delete `entries`, `force`.
2. **Overrides** (merged last, so they win):

   ```ts
   const overrides: UnknownRecord = {
     root: options.viteRoot,
     base: "/",
     mode: "development",
     appType: "mpa",                          // HTML middleware serves .prvision-harness/index.html (runs transformIndexHtml); no SPA fallback
     cacheDir: options.cacheDir,              // isolated per worktree; never the user's node_modules/.vite
     clearScreen: false,
     logLevel: "info",
     customLogger: input.logger,
     server: {
       host: "127.0.0.1",
       port: input.port,                      // free port found in the child (5.6.3 step 7b); actual port read back from httpServer.address()
       strictPort: false,
       hmr: false,                            // also disables @vitejs/plugin-react fast refresh (skipFastRefresh when hmr === false)
       open: false,
       cors: false,
       fs: { strict: true, allow: input.fsAllow },   // arrays concatenate with the user's fs.allow
       ...(input.viteMajor >= 5 ? { warmup: { clientFiles: options.warmupFiles } } : {}),
     },
     optimizeDeps: {
       include: reactIncludes(input.reactDomMajor), // concatenated with the user's include
       holdUntilCrawlEnd: true,
     },
     resolve: { dedupe: ["react", "react-dom"] },  // concatenated with the user's dedupe
     define: input.envDefines,                    // user's define wins on conflict (keys pre-filtered in 5.6.3 step 7)
     ...(input.userConfigFound ? {} : { esbuild: { jsx: "automatic" } }),
   };
   // reactIncludes(major) = major >= 18
   //   ? ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"]
   //   : ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"];
   ```
3. `const merged = input.vite.mergeConfig(sanitizedUser, overrides)` — the repo's own `mergeConfig`, so merge semantics match its version.
4. **Post-merge assignments** (needed because `mergeConfig` skips `null` and concatenates arrays):

   ```ts
   merged.configFile = false;
   merged.plugins = [input.mockPlugin, ...input.userPlugins, input.harnessPlugin];
   asRecord(merged.server).watch = resolveWatchOption(input.viteMajor, input.viteMinor);
   asRecord(merged.optimizeDeps).entries = options.optimizeEntries;
   ```
5. Return `{ config: merged, warnings }`.

#### 5.7.3 Option rationale

- `root = viteRoot`: harness and component files are under the root, so no `/@fs/` URLs for them.
- `configFile: false` + plugins assembled by PRVision: `mockPlugin` is the first `enforce: "pre"` plugin, ahead of user pre plugins such as `vite-tsconfig-paths`. Vite's own alias plugins still run first; aliased sources reach the mock plugin as absolute paths and are matched by resolved path (5.8.4). Plugin arrays may contain nested arrays, promises and falsy values; Vite flattens them, and `flattenUserPlugins` already did.
- `appType: "mpa"`: Vite's HTML middleware serves any `.html` under root with `transformIndexHtml` (so plugins that inject preambles, fonts or scripts keep working), and unknown paths return 404 instead of an SPA fallback that would mask errors. `"custom"` would skip `transformIndexHtml`.
- `server.hmr: false`: no HMR updates, and `@vitejs/plugin-react` skips Fast Refresh (`skipFastRefresh = … || config.server.hmr === false`, verified in 4.7.0), so no "can't detect preamble" errors. The HMR WebSocket server still exists; the browser side must not break it (5.11.4).
- `server.watch: null` / ignore-all: no chokidar crawl of the worktree; files never change during a server's lifetime (repairs use new servers).
- `port`: a free port probed in the child (5.6.3 step 7b), never `0` (Vite maps a falsy port to 5173). `strictPort: false` lets Vite move to the next port if another process grabbed it; PRVision reads the bound port from `httpServer.address()`.
- `cacheDir` inside `.prvision-harness/`: the worktree's `node_modules` is a symlink to the user's real `node_modules`, so the default `node_modules/.vite` would write optimized deps into the user's clone and race with the user's own dev server. Our cache dir is per worktree and removed with it.
- `server.fs.allow`: when `fs.allow` is set Vite stops auto-adding the workspace root, so PRVision adds it explicitly (`searchForWorkspaceRoot`) together with the **realpath** of `node_modules` (resolved module paths point into the user's clone; without it, non-optimized node_modules files such as package CSS are rejected as "outside of Vite serving allow list").
- `optimizeDeps.entries`: explicit file list (entry, globals, every component harness on the side) so the first scan crawls exactly the graphs that will be rendered. Literal paths avoid glob dot-directory pitfalls.
- `optimizeDeps.include` adds React entry points because `virtual:prvision-mount` imports `react-dom/client` from a virtual module the scanner does not crawl. Not adding mocked packages to `exclude` is deliberate: changing `exclude` per group would change the optimizer hash and force a full re-bundle for each group; the pre-resolver intercept (5.8) already prevents user code from reaching the optimized copy of a mocked package.
- `server.warmup.clientFiles` (Vite ≥ 5): pre-transforms the entry and this group's harness files right after listen, shortening the first render.
- `resolve.dedupe` for React: avoids "Invalid hook call" when linked packages carry their own React copy.
- `logLevel: "info"` with a forwarding logger: info lines are needed to detect dependency re-optimization; they are logged at debug level in the parent.

#### 5.7.4 Environment variables

- `mode = "development"`; `NODE_ENV=development` in the child env (also prevents a production-mode worker from flipping Vite into production behaviour).
- `envDir`: the user's `envDir` if set, else the side's `viteRoot`. Each side therefore sees only env files tracked in that side's commit (`.env`, `.env.development`). Untracked local files (`.env.local`) in the user's clone are not used: that keeps base and head faithful to their commits and avoids pulling local secrets into renders.
- Missing referenced keys: `import.meta.env.VITE_X` referenced anywhere in either side's source but not defined → defined as `""` through `define` (Vite folds `define` keys prefixed `import.meta.env.` into the injected `import.meta.env` object; verified in 5.4 `userDefineEnv`). Empty string is falsy (feature flags stay off) and string-safe (`url + "/x"` works). Values are never invented. Code that does `new URL(import.meta.env.VITE_API)` still throws; that becomes a harness error the repair step can address by mocking the config module.
- Built-ins (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`) come from Vite unchanged (`BASE_URL` is `/`).

#### 5.7.5 User plugins

```ts
/** Prefixes of plugin names that are dev-tooling only and harmful or slow in headless rendering. */
export const PLUGIN_DENYLIST_PREFIXES: readonly string[] = [
  "vite-plugin-checker",     // spawns tsc/eslint workers, overlays
  "vite:eslint", "vite-plugin-eslint",
  "vite-plugin-inspect",
  "vite-plugin-pwa",         // service worker registration (service workers are blocked anyway)
  "vite:basic-ssl", "vite:mkcert", "vite-plugin-mkcert",   // https
];

/** Recursively awaits promises, flattens arrays, drops falsy values and non-plugin objects. */
export async function flattenUserPlugins(value: unknown): Promise<VitePluginLike[]>;

export function filterUserPlugins(plugins: readonly VitePluginLike[]): { kept: VitePluginLike[]; dropped: string[] };
// drops: names matching PLUGIN_DENYLIST_PREFIXES, and apply === "build"
```

Everything else is kept and works unmodified: `@vitejs/plugin-react` / `-swc` (JSX, Babel plugins such as emotion or styled-components), `@tailwindcss/vite` (v4), `vite-plugin-svgr` (`?react` imports), `vite-tsconfig-paths`, CSS preprocessors, PostCSS (loaded by Vite from `viteRoot`, where Tailwind v3 also resolves its config because cwd is `viteRoot`). Dropped plugin names go into `warnings` and are logged once per side at info level.

#### 5.7.6 Harness URL

`harnessUrl(origin, layout, componentId)` =

```text
${origin}${layout.harnessUrlPath}?c=${componentId}&quiet=${RENDER_SETTLE_QUIET_MS}&settleMax=${RENDER_SETTLE_MAX_MS}&assetWait=${RENDER_ASSET_WAIT_MS}
```

`base` is forced to `/`, so no base prefix is needed. HTTPS is removed from the config, so the origin is always `http://127.0.0.1:<port>`.

### 5.8 Mock plugin (`vite-mock-plugin.ts`)

#### 5.8.1 Semantics (contract for sheet 09; adopted by 09 per 00 §14.7)

A `MockedModule { specifier, source }` attached to a component means: while rendering this component, the module that `specifier` refers to is replaced by `source`, everywhere in the page's module graph except inside other mocks and inside pre-bundled dependencies.

- `specifier` is written exactly as it appears in an import statement of the component file or of any module it imports.
- Relative specifiers (`./x`, `../x`) are interpreted relative to the **component file** on the side being rendered.
- Bare specifiers are either packages (`@tanstack/react-query`, `date-fns/format`) or project aliases (`@/lib/api`, `~/hooks/useCart`).
- `source` is an ES module in TypeScript/TSX (the plugin transpiles it). It must provide every named/default export that importers use. It may import other modules, including the real module it replaces, using the same specifier (a mock's own imports are never mocked, so partial mocks work: `export * from "@/lib/api"; export const fetchUser = …`). Relative imports inside `source` resolve relative to the component file.
- Not mockable (rejected by `validateMockedModules` with a reason; 09's validator reports the same rejections as `mock_forbidden_specifier`): empty or whitespace-containing specifiers, specifiers with a query (`?`), style and asset files (`STYLE_OR_ASSET_EXTENSIONS`), React core (`isUnmockableSpecifier`: `react`, `react-dom`, `scheduler` and every `react/…` and `react-dom/…` subpath), duplicates (first wins), empty source, source longer than `MOCK_SOURCE_MAX_CHARS` (200 000). Mocks resolving to the component file itself are ignored at resolution time (5.8.3).

#### 5.8.2 Exports

`mock-rules.ts` (pure; imports only `node:path` and the `MockedModule` type; shared by 08, 09 and 10 — create verbatim):

```ts
export const STYLE_OR_ASSET_EXTENSIONS: readonly string[] = [
  ".css", ".scss", ".sass", ".less", ".styl", ".stylus", ".pcss", ".postcss", ".sss",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3", ".wav", ".json", ".wasm",
];
export const MOCK_SOURCE_MAX_CHARS = 200_000;

export function isUnmockableSpecifier(specifier: string): boolean {
  return specifier === "react" || specifier === "react-dom" || specifier === "scheduler"
    || specifier.startsWith("react/") || specifier.startsWith("react-dom/");
}

export type SpecifierKind = "relative" | "absolute" | "bare";
/** "relative": ".", "..", "./*", "../*"; "absolute": "/*" (Vite root-relative); otherwise "bare". */
export function classifySpecifier(specifier: string): SpecifierKind;

/** "@scope/name/sub" → "@scope/name"; "name/sub" → "name"; null for "", relative/absolute, "@/…", "~/…", "#…", or anything containing ":". */
export function packageNameOf(specifier: string): string | null;

export interface MockValidationResult {
  accepted: MockedModule[];
  rejected: Array<{ specifier: string; reason: string; duplicate: boolean }>;
}
/** Pure, syntactic, order-preserving. Reasons (exact text, used in console warnings and 09 issue messages):
 *  "empty specifier" | "specifier contains whitespace" | "specifiers with a query cannot be mocked" |
 *  "stylesheets and assets cannot be mocked" | "React core cannot be mocked" | "duplicate specifier (first one kept)" |
 *  "empty source" | "source is longer than 200000 characters". Extension check uses the specifier without its query/hash, lower-cased. */
export function validateMockedModules(mocks: readonly MockedModule[]): MockValidationResult;
```

`vite-mock-plugin.ts` (re-exports everything above):

```ts
export const MOCK_VIRTUAL_PREFIX = "\0prvision-mock:";

export function mockHash(componentFile: string, specifier: string, source: string): string;
// sha256(`${componentFile}\n${specifier}\n${source}`) hex, first 16 chars

export function mockVirtualId(hash: string): string; // MOCK_VIRTUAL_PREFIX + hash

export interface MockPluginOptions {
  viteRoot: string;
  cacheDir: string;
  harnessDir: string;
  entries: readonly MockEntryInput[];
  transpile: (code: string, filename: string) => Promise<string>;   // wraps vite.transformWithEsbuild / transformWithOxc
  isInstalledPackage: (packageName: string) => boolean;              // node_modules/<name>/package.json exists from viteRoot
  warn: (message: string) => void;                                   // forwarded as a "[prvision-mock]" warn log
}

export function createMockPlugin(options: MockPluginOptions): VitePluginLike;
```

Default `transpile` in the child:

```ts
async function transpileMock(vite: ViteModuleLike, code: string, filename: string): Promise<string> {
  if (vite.transformWithEsbuild) {
    const out = await vite.transformWithEsbuild(code, filename, { loader: "tsx", jsx: "automatic", format: "esm", sourcemap: false, target: "es2020" });
    return out.code;
  }
  if (vite.transformWithOxc) {
    const out = await vite.transformWithOxc(code, filename, { lang: "tsx", jsx: { runtime: "automatic" } });
    return out.code;
  }
  throw new Error("This Vite version exposes no TypeScript transform; mocks cannot be compiled.");
}
```

The mock plugin transpiles itself because Vite's built-in esbuild plugin and `@vitejs/plugin-react` use `createFilter`, which rejects ids containing `\0`. `filename` is `<harnessDir>/mocks/<hash>.tsx` (never written; used for loader inference, tsconfig lookup and error messages).

#### 5.8.3 Registry and target resolution

On creation the plugin builds a registry from `options.entries` (after `validateMockedModules`, de-duplicated by match key so components of one group share entries):

```ts
interface MockRegistryEntry {
  hash: string;
  virtualId: string;                   // "\0prvision-mock:<hash>"
  componentId: number;
  componentFile: string;
  specifier: string;
  specifierKind: SpecifierKind;
  packageName: string | null;          // set when bare and isInstalledPackage(packageNameOf(specifier))
  source: string;
  target: Promise<MockTarget> | null;  // lazily resolved on first resolveId call
  compiled: Promise<string> | null;    // lazily transpiled on first load
}

type MockTarget =
  | { kind: "package" }                // exact-specifier match only
  | { kind: "source"; file: string }   // match by resolved file path
  | { kind: "unresolved" };            // module does not exist; exact-specifier match only
```

Target resolution for entry `e` (first `resolveId` call, memoized as a promise):

1. If `e.packageName !== null` → `{ kind: "package" }` (no resolution).
2. Else `r = await this.resolve(e.specifier, e.componentFile, { skipSelf: true })`.
   - `r === null` or `r.external` → `{ kind: "unresolved" }`.
   - `file = cleanUrl(r.id)` (strip `?query` and `#hash`). If `file` contains `/node_modules/` or starts with `cacheDir` → `{ kind: "package" }` (alias pointing to a package).
   - If `file === e.componentFile` → warn `"Mock for \"<specifier>\" targets the component under test itself and was ignored"` and mark the entry disabled.
   - Else `{ kind: "source", file }`.

#### 5.8.4 `resolveId(source, importer, options)` rules

Evaluated in order; the first rule that returns ends the call.

1. `source.startsWith(MOCK_VIRTUAL_PREFIX)` → return `source`.
2. `importer === undefined` → `null` (entry points are never mocked).
3. **Importer is a mock** (`importer.startsWith(MOCK_VIRTUAL_PREFIX)`): no mock applies to imports made by mocks. If `source` is relative, re-anchor it to the component file: `return this.resolve(source, entry.componentFile, { skipSelf: true })`. Otherwise `null` (normal resolution; bare imports from a virtual importer resolve from root).
4. **Dependency scan** (`options.scan === true`): return the virtual id only for entries whose target is `unresolved` and whose specifier equals `source` (so the scanner does not log a resolution error for a module that only exists as a mock). Otherwise `null`, so the scanner discovers every real dependency (5.3).
5. **Importer inside `node_modules` or the cache dir**: match only entries with target `package` and `specifier === source`. Pre-bundled dependencies never reach this hook (esbuild bundles them without user plugins), so in practice this only affects packages excluded from optimization or linked packages.
6. **User/harness importer** (anything else, including the harness files and `\0prvision-mount`):
   1. Exact specifier match: for entries with target `package` or `unresolved`, or `bare`/`absolute` entries with target `source`: `specifier === source` → return `virtualId`. Relative entries match by string only when `cleanUrl(importer) === entry.componentFile`.
   2. Resolved-path match, only if at least one entry has target `source` and `source` is eligible:
      - not eligible if `source` starts with `\0`, `virtual:`, `/@`, `data:`, `http:`, `https:`; contains `?`; ends with a `STYLE_OR_ASSET_EXTENSIONS` extension; or is bare with an installed package name.
      - `r = await memoResolve(source, importer, options)` where `memoResolve` caches `this.resolve(source, importer, { skipSelf: true, isEntry: options.isEntry, custom: options.custom, ssr: options.ssr })` by `dirname(cleanUrl(importer)) + "\0" + source`.
      - If `r` and `cleanUrl(r.id)` equals some entry's `target.file` → return that `virtualId`.
      - Else return `r` (already resolved by the rest of the chain, which avoids resolving twice). If `r` is `null` return `null`.
   3. Otherwise `null`.

Why resolved-path matching: one file can be imported as `../api/client`, `@/api/client`, `/src/api/client` (after Vite's alias plugin rewrites an alias to an absolute path before our hook sees it) or with/without extension. Comparing Vite's own resolution result is the only representation that is identical for all of them.

#### 5.8.5 `load(id)`

```ts
async load(id: string): Promise<{ code: string; map: null } | null> {
  if (!id.startsWith(MOCK_VIRTUAL_PREFIX)) return null;
  const entry = byVirtualId.get(id);
  if (entry === undefined) {
    throw new Error(`Unknown PRVision mock module ${id.slice(1)}`);
  }
  entry.compiled ??= options
    .transpile(entry.source, path.join(options.harnessDir, "mocks", `${entry.hash}.tsx`))
    .catch((error: unknown) => {
      entry.compiled = null; // allow a later retry to surface the same error again
      throw new Error(
        `Mock for "${entry.specifier}" (component ${entry.componentId}) failed to compile: ${describe(error)}`,
      );
    });
  return { code: await entry.compiled, map: null };
}
```

Served URL: `/@id/__x00__prvision-mock:<hash>` (Vite's encoding of `\0`). Import analysis rewrites the mock's own imports like any other module. A compile error becomes a 500 on that URL; a missing export becomes a browser `SyntaxError` ("does not provide an export named …"); both reach the error formatter, which rewrites `__x00__prvision-mock:<hash>` to `[mock of "<specifier>"]` (5.12.3) so the repair prompt is readable.

#### 5.8.6 Plugin object

```ts
export function createMockPlugin(options: MockPluginOptions): VitePluginLike {
  const registry = buildRegistry(options); // validate, dedupe, compute packageName, hash, virtualId
  const byVirtualId = new Map(registry.map((entry) => [entry.virtualId, entry] as const));
  const bySpecifier = groupBy(registry, (entry) => entry.specifier);
  const memo = new Map<string, Promise<ViteResolvedIdLike | null>>();
  return {
    name: "prvision:mock",
    enforce: "pre",
    async resolveId(source, importer, resolveOptions) { /* rules 5.8.4 */ },
    async load(id) { /* 5.8.5 */ },
  };
}
```

An empty `entries` list yields a plugin whose hooks return `null` immediately (still installed so plugin names, and therefore the optimizer hash, are identical across groups).

#### 5.8.7 Interaction with optimizeDeps (summary)

| Situation | Behaviour |
|---|---|
| User code imports mocked package `x` | Our pre plugin returns the virtual id before `vite:resolve` maps `x` to `.vite-cache/deps/x.js`. |
| Dep scan encounters `x` | `options.scan` → `null` → `x` is discovered and pre-bundled (needed by unmocked groups). |
| A pre-bundled dep imports `x` internally | Real `x` is used (inside the bundle). Documented limitation. |
| Repaired harness imports a new package | Runtime discovery → re-optimization → possible "Outdated Optimize Dep" 504; handled by one infrastructure retry (5.11.10). |

### 5.9 Harness plugin (`render/vite-harness-plugin.ts`)

```ts
export const MOUNT_PUBLIC_ID = "virtual:prvision-mount";
export const MOUNT_RESOLVED_ID = "\0prvision-mount";

export function buildMountModuleSource(reactDomMajor: number): string {
  if (reactDomMajor >= 18) {
    return [
      'import { createRoot } from "react-dom/client";',
      "export function mount(container, element) {",
      "  const root = createRoot(container);",
      "  root.render(element);",
      "  return () => root.unmount();",
      "}",
      "",
    ].join("\n");
  }
  return [
    'import ReactDOM from "react-dom";',
    "export function mount(container, element) {",
    "  ReactDOM.render(element, container);",
    "  return () => ReactDOM.unmountComponentAtNode(container);",
    "}",
    "",
  ].join("\n");
}

export function createHarnessPlugin(options: { reactDomMajor: number }): VitePluginLike {
  return {
    name: "prvision:harness",
    enforce: "pre",
    resolveId(source) {
      return source === MOUNT_PUBLIC_ID ? MOUNT_RESOLVED_ID : null;
    },
    load(id) {
      return id === MOUNT_RESOLVED_ID ? { code: buildMountModuleSource(options.reactDomMajor), map: null } : null;
    },
  };
}
```

React version decision: React 18 and 19 are the supported targets (`createRoot`; React 19 removed `ReactDOM.render`). React 16.8–17 get a best-effort legacy `render` path because it costs one branch and avoids a hard failure; it is not covered by acceptance tests. React < 16.8 (no hooks; the entry uses `useEffect`) is rejected at host start (`react_unsupported`). Projects that alias `react` to `preact/compat` work through the same path because aliases apply to the virtual module's imports.

### 5.10 Tailwind and global CSS

How classes in changed components get generated:

- **Tailwind v3** (PostCSS plugin): `content` globs are resolved relative to `process.cwd()` unless the config uses `relative: true`, and `tailwind.config.*` is looked up in cwd when the PostCSS config does not pass a path. The Vite host's cwd is `viteRoot` (5.2), so both resolve exactly as when the user runs `vite`. Component files live under `src/` and are covered by the user's globs.
- **Tailwind v4** (`@tailwindcss/vite` or `@tailwindcss/postcss`): automatic source detection scans the project from the root, honouring `.gitignore`. Component files are under `src/` and are detected. The harness folder is ignored via its own `.gitignore` (`*`), which also keeps `.vite-cache` (large pre-bundled JS) out of the scan. Explicit `@source` directives in user CSS keep working.
- **Consequence** (contract for 09): classes used only in harness files or mock sources are not guaranteed to exist. Harness wrappers must use inline `style`. With `hmr: false`, v4's dev-time "new candidate found → update CSS via HMR" path cannot apply, so the initial scan must be complete; it is, because component files exist on disk before the server starts.
- **Global CSS** comes only through `globals.ts` (repository `globalStylePaths`, sheet 06). The app entry (`entryFilePath`) is never imported because it would mount the whole app.

Checks:

| When | Check | Action |
|---|---|---|
| Host start | `tailwindMajor` detected from `node_modules/tailwindcss/package.json` | Included in the `ready` event; logged at debug. |
| Host start, v3 | `tailwind.config.{js,cjs,mjs,ts}` exists in `viteRoot` | If missing, one console warning: "Tailwind v3 is installed but no tailwind.config was found in <viteRoot>". |
| Host start, v4 | A kept plugin name starts with `@tailwindcss/vite`, or a PostCSS config mentions `@tailwindcss/postcss` | If neither, one console warning. |
| Harness write | `harnessSource` contains `className=` | One console warning per run (5.4.5). |
| First successful render per host | `detectStylesheetHealth()` in the page (5.11.9): count CSS rules (recursing into `@layer`/`@media`, cap 20 000); if Tailwind is installed, look for at least one utility-like selector (`/^\.(?:[a-z0-9-]+\\?:)*(?:flex|grid|block|hidden|p[trblxy]?-|m[trblxy]?-|text-|bg-|w-|h-)/`) | If `globalStylePaths` is non-empty and rule count is 0, or Tailwind is installed and no utility selector exists: one console warning per side ("Tailwind is installed but no utility classes were generated on the head side; check globalStylePaths and the Tailwind content configuration"). Never fails a render. |

### 5.11 Browser session (`render/browser-session.ts`)

#### 5.11.1 API

```ts
export interface PageRenderInput {
  host: Pick<ViteHostHandle, "origin" | "harnessUrlPath" | "currentSeq" | "logsSince" | "sawDepsReoptimizeSince" | "isAlive" | "exitReason" | "side">;
  componentId: number;
  timeoutMs: number;               // budget for this attempt (goto → PNG written)
  outputPath: string;              // absolute temp path; written atomically
  signal: AbortSignal;             // ctx.signal
  checkStylesheets: { globalStylesExpected: boolean; tailwindMajor: 3 | 4 | null } | null; // first render per host only
}

export type CaptureMode = "content" | "viewport" | "empty";

export type PageRenderOutcome =
  | {
      ok: true;
      width: number; height: number; mode: CaptureMode; stable: boolean; truncated: boolean;
      consoleErrors: string[]; durationMs: number; blockedRequests: number;
      stylesheetWarning: string | null;
    }
  | {
      ok: false;
      kind: RenderFailureKind;
      error: string;                // formatted (5.12.3), already truncated
      consoleErrors: string[];
      durationMs: number;
      infraRetryable: boolean;      // dep re-optimization churn or page crash (5.11.10)
    };

export class BrowserSession {
  static launch(): Promise<BrowserSession>;               // throws BrowserLaunchError
  isConnected(): boolean;
  renderComponent(input: PageRenderInput): Promise<PageRenderOutcome>;  // never throws
  closeAllContexts(): Promise<void>;                      // used on abort
  close(): Promise<void>;                                 // never throws; bounded by BROWSER_CLOSE_TIMEOUT_MS
}
```

#### 5.11.2 Launch (one Chromium per job)

Reuses Uply-v2's pattern (`chromium.launch({ headless: true })`, media permission blocking) and adds rendering-determinism flags:

```ts
export const CHROMIUM_LAUNCH_ARGS: readonly string[] = [
  "--font-render-hinting=none",
  "--disable-font-subpixel-positioning",
  "--disable-lcd-text",
  "--force-color-profile=srgb",
  "--hide-scrollbars",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--mute-audio",
];

static async launch(): Promise<BrowserSession> {
  try {
    const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_LAUNCH_ARGS], timeout: 60_000 });
    return new BrowserSession(browser);
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    const userMessage = /Executable doesn't exist|playwright install/i.test(message)
      ? "Chromium for Playwright is not installed. Run `npx playwright install chromium` in the PRVision folder."
      : `Chromium could not be started: ${message}`;
    throw new BrowserLaunchError(userMessage, message);
  }
}
```

`browser.on("disconnected")` sets `connected = false`. `RenderRun` relaunches once per run if the browser disconnects mid-run (5.13.8).

#### 5.11.3 Context per render

A new context is created for every (component, side, attempt) and closed in `finally`. Contexts are cheap (tens of ms) and this guarantees no `localStorage`/`sessionStorage`/IndexedDB/cookie carry-over between components; a component that writes storage on head would otherwise change what later components render. (The brief suggested one context per side; per-render contexts are strictly more isolated at negligible cost.)

```ts
export function buildContextOptions(): BrowserContextOptions {
  return browserContextWithBlockedMedia({
    viewport: { width: RENDER_VIEWPORT.width, height: RENDER_VIEWPORT.height },
    screen: { width: RENDER_VIEWPORT.width, height: RENDER_VIEWPORT.height },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    reducedMotion: "reduce",
    colorScheme: "light",
    forcedColors: "none",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    acceptDownloads: false,
    javaScriptEnabled: true,
  });
}
```

Per context, before the page loads:

1. `await blockBrowserContextMediaPermissions(context)` (Uply init script; copied file).
2. `await context.addInitScript({ content: buildDeterminismInitScript(RENDER_RANDOM_SEED) })`.
3. `await context.route("**/*", handler)` (5.11.4).
4. `await context.routeWebSocket((url) => url.host !== viteHost, (ws) => ws.close())` — closes non-Vite sockets only.
5. `page = await context.newPage()`; `page.setDefaultTimeout(remaining())`.
6. `await page.clock.setFixedTime(new Date(RENDER_FIXED_TIME_ISO))` — `Date.now()`/`new Date()` return a fixed instant; timers and `requestAnimationFrame` keep running, so the ready logic still works.

Determinism init script (`page-scripts.ts`):

```ts
export function buildDeterminismInitScript(seed: number): string {
  return `(() => {
  let state = ${seed >>> 0};
  Math.random = function prvisionRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const css = "*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}vite-error-overlay{display:none!important}";
  const install = () => {
    if (document.getElementById("prvision-determinism")) return;
    const style = document.createElement("style");
    style.id = "prvision-determinism";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.documentElement) install(); else document.addEventListener("DOMContentLoaded", install, { once: true });
})();`;
}
```

CSS animations are not zeroed here (some libraries wait for `animationend`); they are handled by `reducedMotion: "reduce"` and by `animations: "disabled"` at capture time (finite animations fast-forwarded, infinite ones reset). `crypto.getRandomValues`/`randomUUID` are untouched (ids are not visible output).

#### 5.11.4 Network policy

```ts
export type RouteDecision =
  | { action: "continue" }
  | { action: "abort" }
  | { action: "fulfill"; status: 200; contentType: string; body: string | Buffer };

export const TRANSPARENT_PNG_1X1: Buffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export function decideRoute(requestUrl: string, resourceType: string, viteOrigin: string): RouteDecision {
  let parsed: URL;
  try { parsed = new URL(requestUrl); } catch { return { action: "abort" }; }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") return { action: "continue" };
  if (parsed.origin === viteOrigin) return { action: "continue" };
  switch (resourceType) {
    case "image":      return { action: "fulfill", status: 200, contentType: "image/png", body: TRANSPARENT_PNG_1X1 };
    case "stylesheet": return { action: "fulfill", status: 200, contentType: "text/css", body: "" };
    case "script":     return { action: "fulfill", status: 200, contentType: "text/javascript", body: "" };
    case "document":   return { action: "fulfill", status: 200, contentType: "text/html", body: "<!doctype html><title>blocked by PRVision</title>" };
    case "font":
    case "media":      return { action: "abort" };
    default:           return { action: "fulfill", status: 200, contentType: "application/json", body: "{}" }; // fetch, xhr, eventsource, other
  }
}
```

- Same-origin requests always continue: module imports, Vite internals, files in `public/`. Unknown same-origin paths (e.g. `/api/users`) get Vite's 404 (`appType: "mpa"`), which is deterministic.
- Off-origin requests never leave the machine. Images become 1×1 transparent PNGs (no broken-image icons, `img.complete` settles). Stylesheets/scripts are empty. API calls get `{}`.
- Fonts from external hosts (Google Fonts CSS is a stylesheet → empty; font files are aborted) fall back to local fonts. Both sides use the same machine fonts, so diffs stay at 0 for identical code. Local font packages (`@fontsource/*`, files in `src/assets`) are served by Vite and load normally.
- Vite's HMR WebSocket (same host:port) is not intercepted. Intercepting and closing it would make the Vite client poll `/` and call `location.reload()` once the ping succeeds — a reload loop. Other WebSockets are closed.
- Blocked request count per page is logged at debug with up to 5 sample URLs (query strings stripped).

#### 5.11.5 Listeners

| Event | Handling |
|---|---|
| `console` (type `error`) | Push `text()` unless it starts with `[vite]` (client chatter) or matches `/Download the React DevTools/`. Cap `RENDER_CONSOLE_ERRORS_MAX` entries × `RENDER_CONSOLE_ERROR_MAX_CHARS`. |
| `pageerror` | Push `pageerror: <message>`. React dev re-throws caught render errors here; that is expected. |
| `response` | If URL origin is the Vite origin, status ≥ 400, and resource type is `script`, `stylesheet` or `fetch`: record `firstModuleErrorAt` (if unset) and read up to 64 KB of the body; `extractViteErrorFromBody(body)` (5.12.3) → push to `serverErrors`. |
| `requestfailed` | Same-origin failures (e.g. `net::ERR_ABORTED` on a module) → `serverErrors` entry `"<path>: <errorText>"`. |
| `crash` | `crashed = true`. |

#### 5.11.6 Navigation and waiting for the harness

```ts
await page.goto(harnessUrl(input), { waitUntil: "domcontentloaded", timeout: remaining() });
const signal = await waitForHarnessSignal(page, deadline, () => firstModuleErrorAt);
```

`waitForHarnessSignal` polls every 100 ms with `page.evaluate(readHarnessState)` (`{ status, ready, error }` from the `window.__PRVISION_*__` globals):

1. `error !== null` → `{ kind: "error", report: error }`.
2. `ready === true` → `{ kind: "ready" }`.
3. A module error response was seen more than `RENDER_MODULE_ERROR_GRACE_MS` ago and no harness error was reported → `{ kind: "module_error", status }` (covers the entry or `globals.ts` failing to load, where no in-page code runs).
4. `crashed` or `!host.isAlive()` → `{ kind: "infra", reason }`.
5. `Date.now() >= deadline` → `{ kind: "timeout", status, diagnostics: await collectTimeoutDiagnostics() }` where diagnostics are `{ status, rootChildCount, rootTextSample }` (first 200 chars of `#prvision-root` text).

Polling (instead of `waitForFunction`) lets Node-side conditions (module errors, host death, abort) end the wait early.

#### 5.11.7 Capture measurement (portals, empty renders)

`measureCapture({ padding, maxHeight, rootId })` runs in the page and returns:

```ts
export interface CaptureMeasurement {
  mode: CaptureMode;
  clip: { x: 0; y: 0; width: number; height: number };   // always anchored at the page's top-left
  truncated: boolean;
  hasPortalContent: boolean;
}
```

Algorithm:

1. `scopes = [#prvision-root, ...document.body.children]` excluding the root itself from the second list, and elements with tag `SCRIPT, STYLE, LINK, META, TEMPLATE, NOSCRIPT, VITE-ERROR-OVERLAY` or id `prvision-determinism`. Elements after the root are portal candidates (modals, tooltips, toasts mounted into `document.body`).
2. Walk each scope with a `TreeWalker` (elements and text nodes), visiting at most 20 000 nodes total. Subtrees with `display: none` are rejected (`NodeFilter.FILTER_REJECT`).
3. For each **text node** with non-whitespace content: union every rect from `range.getClientRects()` (`range.selectNodeContents(node)`). Text inside `visibility: hidden` ancestors is skipped (check `getComputedStyle(parentElement).visibility`).
4. For each **element** with `visibility !== "hidden"` and `opacity > 0` that **paints**, union `getBoundingClientRect()`. An element paints when any of these hold:
   - replaced or form element: `IMG, SVG (SVGSVGElement), CANVAS, VIDEO, IFRAME, INPUT, TEXTAREA, SELECT, BUTTON, PROGRESS, METER, OBJECT, EMBED, HR`;
   - background colour alpha > 0, or `background-image !== "none"`;
   - any border side with width > 0, style not `none`/`hidden`, colour alpha > 0;
   - `box-shadow !== "none"`; outline style not `none` with width > 0;
   - `::before` or `::after` has `content` other than `none`/`normal` and itself paints by the same background/border rules.
   Transparent wrapper `div`s do not count, so a harness wrapping a button in a plain `div` still produces a tight image.
5. Rects are converted to document coordinates (`+ scrollX/scrollY`); zero-size rects and rects entirely at negative coordinates are ignored. Any rect found in a scope other than the root sets `hasPortalContent = true`.
6. **Fixed overlays**: if a painting element has computed `position: fixed` and its rect covers at least 25 % of the viewport area (modal backdrop, drawer, full-screen dialog), set `forceViewport`.
7. Result:
   - `forceViewport` → `mode = "viewport"`, `width = innerWidth`, `height = max(innerHeight, ceil(maxBottom + padding))`.
   - No rects → `mode = "empty"`, `width = min(innerWidth, 320)`, `height = 64` (a constant blank canvas, so empty-vs-empty diffs are 0). The outcome is still `ok: true`; `RenderRun` logs a console warning "rendered nothing on the head side".
   - Otherwise `mode = "content"`, `width = min(docScrollWidth, ceil(maxRight + padding))`, `height = min(docScrollHeight, ceil(maxBottom + padding))`.
   - In every mode `height` is capped at `maxHeight` (`RENDER_MAX_CAPTURE_HEIGHT_PX`), setting `truncated = true`; `width` and `height` are at least 1.

The clip starts at (0, 0), not at the content's top-left. If a change moves content 10 px to the right, base and head images differ accordingly instead of both being cropped to their own content. The root's 16 px padding provides the left/top margin.

#### 5.11.8 Stability loop and screenshot

```ts
async function captureStable(page: Page, deadline: number): Promise<{ buffer: Buffer; measurement: CaptureMeasurement; stable: boolean }> {
  let measurement = await page.evaluate(measureCapture, captureArgs());
  let previous: Buffer | null = null;
  for (let attempt = 1; attempt <= RENDER_STABILITY_MAX_ATTEMPTS; attempt += 1) {
    const shot = await page.screenshot({
      clip: measurement.clip,
      fullPage: measurement.clip.height > RENDER_VIEWPORT.height,
      animations: "disabled",
      caret: "hide",
      scale: "css",
      type: "png",
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (previous !== null && previous.equals(shot)) {
      return { buffer: shot, measurement, stable: true };
    }
    previous = shot;
    await delay(RENDER_STABILITY_INTERVAL_MS);
    const next = await page.evaluate(measureCapture, captureArgs());
    if (!sameClip(next.clip, measurement.clip)) {
      measurement = next;
      previous = null; // layout changed; restart the comparison
    }
  }
  if (previous === null) {
    previous = await page.screenshot({ clip: measurement.clip, fullPage: measurement.clip.height > RENDER_VIEWPORT.height, animations: "disabled", caret: "hide", scale: "css", type: "png" });
  }
  return { buffer: previous, measurement, stable: false };
}
```

Two byte-identical consecutive frames prove the render is visually settled (JS-driven animations such as framer-motion that ignore `prefers-reduced-motion`, charts animating via `requestAnimationFrame`, late layout from `ResizeObserver`). Not stable after `RENDER_STABILITY_MAX_ATTEMPTS` → keep the last frame, `stable: false`, console warning. Typical cost: two screenshots plus 150 ms.

PNG write: `fs.writeFile(outputPath + ".tmp", buffer)` then `fs.rename` to `outputPath`. `width`/`height` are read from the PNG header (`buffer.readUInt32BE(16)`, `buffer.readUInt32BE(20)`), which equal the clip because `deviceScaleFactor: 1` and `scale: "css"`.

#### 5.11.9 Stylesheet health (first successful render per host)

`detectStylesheetHealth()` runs once per host after the first `ok` capture when `checkStylesheets` is provided (5.10). Cross-origin sheets throw on `cssRules`; skip them. Returns `{ ruleCount, hasUtilitySelector }`; `BrowserSession` converts it into `stylesheetWarning` text or `null`.

#### 5.11.10 Failure detection and the infrastructure retry

`renderComponent` never throws. It maps outcomes:

| Situation | `kind` | `infraRetryable` |
|---|---|---|
| `__PRVISION_ERROR__.phase === "import"` | `module_load` | if `host.sawDepsReoptimizeSince(seqAtStart)` and the message matches `isOptimizeDepsChurn` |
| `__PRVISION_ERROR__.phase` `render`/`mount` | `render_error` | no |
| module error response, no in-page report | `module_load` | as above |
| timeout | `timeout` | no |
| `page.goto` fails (connection refused, host died) | `navigation` | no (host death is handled by `RenderRun`) |
| page crash / "Target closed" while not aborted | `browser` | yes (once) |
| `input.signal.aborted` | `cancelled` | no |
| screenshot/write error | `screenshot` | no |

```ts
export function isOptimizeDepsChurn(text: string): boolean {
  return /Outdated Optimize Dep|optimized dependencies changed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(text);
}
```

`RenderRun` re-runs the same side once (`RENDER_INFRA_RETRIES = 1`) when `infraRetryable` is true. This is separate from harness repair and does not count against `HARNESS_MAX_REPAIRS_PER_COMPONENT`.

On abort, `RenderRun` calls `closeAllContexts()`; in-flight Playwright calls reject and the outcome becomes `cancelled`.

### 5.12 Error model (`render/render-errors.ts`)

#### 5.12.1 Kinds

```ts
export type RenderFailureKind =
  | "vite_unavailable"   // host could not start for this side (load, config, listen, timeout, exit)
  | "navigation"         // harness page could not be opened
  | "module_load"        // a module in the harness graph failed to resolve/transform/evaluate
  | "render_error"       // React render/mount threw (error boundary or mount)
  | "timeout"            // never became ready within the budget
  | "browser"            // Chromium crashed or disconnected
  | "screenshot"         // capture or PNG write failed
  | "file_missing"       // component file absent on this side although the change kind implies it exists
  | "budget_exceeded"    // render stage time budget ran out
  | "cancelled";         // visualization cancelled (never persisted)

const REPAIRABLE: ReadonlySet<RenderFailureKind> = new Set(["module_load", "render_error", "timeout"]);
export function isRepairableFailure(kind: RenderFailureKind): boolean { return REPAIRABLE.has(kind); }
```

`timeout` is repairable because the usual cause is a harness problem (a query that never resolves, a missing provider that suspends forever); the diagnostics give the AI the phase and what the root contained.

#### 5.12.2 Host start failure messages

| `ViteHostStartError.kind` | Message stored as side error |
|---|---|
| `vite_not_found` | Vite is not installed for this repository (looked from `<viteRoot>`). Install dependencies in your clone; PRVision reuses its node_modules. |
| `vite_unsupported` | Vite `<version>` is not supported. PRVision supports Vite 4 to 7. |
| `vite_load_failed` | Vite `<version>` could not be loaded with Node `<version>` (requires `<engines>`): `<error>` |
| `react_missing` | react-dom is not installed for this repository. |
| `react_unsupported` | React `<version>` is not supported (React 16.8 or newer is required; 18+ recommended). |
| `config_error` | Loading `<config file>` failed on the `<side>` side: `<error first line>` |
| `listen_error` | The Vite dev server could not start listening: `<error>` |
| `timeout` | The Vite dev server for the `<side>` side did not become ready within 60 s. |
| `exited` | The Vite dev server process exited unexpectedly (`<exit reason>`). Last error: `<last error log>` |

#### 5.12.3 Formatting (also the `renderError` passed to `repairHarness`)

```ts
export interface FormatRenderErrorInput {
  kind: RenderFailureKind;
  headline: string;                         // e.g. report.message or the timeout sentence
  stack: string | null;
  componentStack: string | null;
  serverErrors: string[];                   // parsed Vite error responses + error logs in the render window
  consoleErrors: string[];
  viteOrigin: string | null;
  mockLabels: ReadonlyMap<string, string>;  // hash → specifier for this item
}

export function formatRenderError(input: FormatRenderErrorInput): string;
```

Output shape (sections omitted when empty), truncated to `RENDER_ERROR_MAX_CHARS` with a trailing `… (truncated)`:

```text
[module_load] Failed to fetch dynamically imported module: /.prvision-harness/components/42.tsx
Vite:
- [plugin:vite:import-analysis] Failed to resolve import "../hooks/useCart" from "src/components/CartBadge.tsx". Does the file exist?
  File: src/components/CartBadge.tsx:3:24
Stack:
  at …(first 12 lines)
Component stack:
  at CartBadge (…)(first 12 lines)
Console errors:
- (first 5)
```

Headlines by kind: `module_load` "Module load failed: …"; `render_error` "Render error: …"; `timeout` "Timed out after 30000 ms waiting for the component to render (harness phase: importing; root children: 0; root text: "")."; `navigation` "Could not open the harness page: …"; `browser` "Browser error: …"; `screenshot` "Screenshot failed: …"; `file_missing` "src/components/Foo.tsx does not exist on the base side."; `budget_exceeded` "The render stage exceeded its time budget before this component finished.".

Normalization applied before truncation:

- Remove the Vite origin (`http://127.0.0.1:<port>`) everywhere, so messages are stable across runs and shorter.
- `rewriteMockIds(text, mockLabels)`: replace `/@id/__x00__prvision-mock:<hash>`, `__x00__prvision-mock:<hash>` and `\0prvision-mock:<hash>` with `[mock of "<specifier>"]`.
- Absolute worktree paths → repo-relative (strip `<worktreeDir>/`).

```ts
/** Parses Vite's 500 error page. Vite 4: `new ErrorOverlay({json})`; Vite 5–7: `const error = {json}`. */
export function extractViteErrorFromBody(body: string): string | null {
  const match = /(?:const error = |new ErrorOverlay\()(\{.*\})/.exec(body);
  if (match?.[1] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (isRecord(parsed) && typeof parsed.message === "string") {
        const plugin = typeof parsed.plugin === "string" ? `[plugin:${parsed.plugin}] ` : "";
        const loc = isRecord(parsed.loc) ? parsed.loc : null;
        const file = loc && typeof loc.file === "string" ? loc.file : typeof parsed.id === "string" ? parsed.id : null;
        const position = loc && typeof loc.line === "number" ? `:${loc.line}:${typeof loc.column === "number" ? loc.column : 0}` : "";
        const frame = typeof parsed.frame === "string" ? `\n${parsed.frame.trimEnd()}` : "";
        return `${plugin}${parsed.message}${file ? `\n  File: ${file}${position}` : ""}${frame}`;
      }
    } catch {
      // fall through to plain-text extraction
    }
  }
  const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}
```

Server errors for a render window = parsed bodies from that page, plus `host.logsSince(seqAtStart, "error")` messages not already contained in a parsed body (Vite logs "Internal server error: …" and "Pre-transform error: …" for the same failures), de-duplicated, max 5.

### 5.13 `RenderService` orchestration (`render-service.ts`)

#### 5.13.1 Public API and dependencies

This API is authoritative (00 §14.7); sheet 07 calls it exactly as shown below.

```ts
export interface RenderComponentInput {
  candidate: ComponentCandidate;
  harness: HarnessGenerationResult;     // only components with a validated harness are rendered (09 owns the rest, 00 §14.7)
  basePath: string | null;              // repo-relative path on base (≠ filePath for renamed components); null for "added"
}

/** Pure helper for 07: joins 09's results to their candidates (by componentId, input order = candidate rank) and computes basePath with 08's basePathFor. Candidates without a harness are omitted. */
export function buildRenderInputs(
  candidates: readonly ComponentCandidate[],
  harnesses: readonly HarnessGenerationResult[],
  changedFiles: ChangeAnalysisResult["changedFiles"],
): RenderComponentInput[];

/** Same signature as 09's HarnessGenerationService.repairHarness (09 §5.10); 07 passes a closure over the 09 instance. */
export type RepairHarnessFn = (
  componentId: number,
  previous: HarnessGenerationResult,
  renderError: HarnessRenderError,          // 09 §5.1; message = formatRenderError output (5.12.3)
) => Promise<HarnessRepairOutcome>;        // passed through unchanged: verdicts carry notesAppendix

export interface RenderArtifactStore {
  imagePaths(visualizationId: number, componentId: number, kind: RenderSide): { absolutePath: string; relativePath: string };
  ensureComponentDir(visualizationId: number, componentId: number): Promise<void>;
}

export interface ComponentRenderPersistence {
  saveRenderResult(componentId: number, payload: ComponentRenderPayload): Promise<void>; // throws on failure
}

export interface ComponentRenderPayload {
  renderStatus: "rendered" | "partial" | "failed";
  baseImagePath: string | null;
  headImagePath: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  baseError: string | null;
  headError: string | null;
  /** Only when the repaired attempt was kept: the repaired harness replaces the original (09 never persists repairs). */
  harness?: { harnessSource: string; harnessNotes: string; mockedModules: MockedModule[] };
  /** Only when repair returned a verdict (component_defect / cannot_render): original notes + "\n\n" + notesAppendix (capped at 4 000). */
  harnessNotes?: string;
}

export interface RenderServiceDependencies {
  repairHarness: RepairHarnessFn;
  createPersistence: (visualizationId: number) => ComponentRenderPersistence;   // default: new QueryHandlerRenderPersistence(id)
  artifactStore: RenderArtifactStore;
  workspaceWriter: HarnessWorkspaceWriter;
  launchBrowser: () => Promise<RenderBrowserSession>;  // BrowserSession.launch
  startViteHost: (options: ViteHostStartOptions, harnessUrlPath: string, signal: AbortSignal) => Promise<ViteHostHandle>; // ViteHostClient.start
  scanEnvKeys: (roots: string[]) => Promise<string[]>;
  now: () => number;
}

/** Narrow interface over BrowserSession so tests can stub it. */
export type RenderBrowserSession = Pick<BrowserSession, "renderComponent" | "closeAllContexts" | "close" | "isConnected">;

export class RenderService {
  private readonly deps: RenderServiceDependencies;

  constructor(overrides: Partial<RenderServiceDependencies> & Pick<RenderServiceDependencies, "repairHarness">) {
    this.deps = { ...defaultRenderDependencies(), ...overrides };
  }

  /** Renders every present side of every input. Throws only PipelineStepError (stage "rendering"). */
  async renderAll(ctx: PipelineContext, inputs: RenderComponentInput[]): Promise<ComponentRenderResult[]> {
    const run = new RenderRun(ctx, this.deps);
    return run.execute(inputs);
  }
}
```

`defaultRenderDependencies()` wires: `(id) => new QueryHandlerRenderPersistence(id)` (below), `ArtifactStoreRenderAdapter` (sheet 04's `ArtifactStore`: `relativePath = store.componentImagePath(v, c, kind)`, `absolutePath = store.resolveSafe(relativePath)`, `ensureComponentDir` delegates), `new HarnessWorkspaceWriter()`, `BrowserSession.launch`, `ViteHostClient.start`, `scanReferencedEnvKeys`, `Date.now`.

Orchestrator (sheet 07) usage — the same 09 instance that generated the harnesses:

```ts
const renderService = new RenderService({
  repairHarness: (componentId, previous, renderError) => harnessService.repairHarness(componentId, previous, renderError),
});
const renders = await renderService.renderAll(ctx, buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles));
```

The repair closure must pass 09's `HarnessRepairOutcome` through unchanged (10 needs `notesAppendix` from verdicts) and must not reduce it to "result or null".

Persistence adapter (QueryHandler is the default persistence facade; `updated_at` is set by QueryHandler):

```ts
class QueryHandlerRenderPersistence implements ComponentRenderPersistence {
  constructor(private readonly visualizationId: number, private readonly queryHandler: QueryHandler = new QueryHandler()) {}

  async saveRenderResult(componentId: number, payload: ComponentRenderPayload): Promise<void> {
    const row: Record<string, unknown> = {
      renderStatus: payload.renderStatus,
      baseImagePath: payload.baseImagePath,
      headImagePath: payload.headImagePath,
      imageWidth: payload.imageWidth,
      imageHeight: payload.imageHeight,
      baseError: payload.baseError,
      headError: payload.headError,
    };
    if (payload.harness) {
      row.harnessSource = payload.harness.harnessSource;
      row.harnessNotes = payload.harness.harnessNotes;
      row.mockedModules = payload.harness.mockedModules;
    } else if (payload.harnessNotes !== undefined) {
      row.harnessNotes = payload.harnessNotes;
    }
    const response = await this.queryHandler.update(row, { id: componentId, visualizationId: this.visualizationId }, Table.VISUALIZATION_COMPONENTS);
    if (response.status !== 200) {
      throw new Error(`visualization_components update failed for id ${componentId}: ${String(response.error ?? response.status)}`);
    }
  }
}
```

`imageWidth/imageHeight` = head image dimensions when head rendered, else base. Sheet 11 overwrites them with the compared canvas size (11 §5.2.3).

#### 5.13.2 Work items

```ts
export interface RenderWorkItem {
  candidate: ComponentCandidate;
  harness: HarnessGenerationResult;
  paths: { base: string | null; head: string | null };   // repo-relative component path per side
  acceptedMocks: MockedModule[];
  fingerprint: string;
  sides: { base: boolean; head: boolean };
  primarySide: RenderSide;          // head when head exists, else base
  repairsUsed: number;
  mockLabels: Map<string, string>;  // hash → specifier, per side computed with that side's component path
}
```

`planItems(inputs)` per input, in order:

1. Duplicate `componentId` → warn log, skip.
2. Compute side presence (below).
3. `validateMockedModules(harness.mockedModules)` → `acceptedMocks`; one console warning per rejected mock (`Mock "<specifier>" for <displayName> was ignored: <reason>.`). (09 already rejects these, so this only fires for defensive reasons.)
4. `fingerprint = mockFingerprint(paths.head ?? paths.base, acceptedMocks)`; `mockLabels` from `mockHash(componentFileOnSide, specifier, source)` for both sides; `primarySide = sides.head ? "head" : "base"`; `repairsUsed = 0`.

Side presence:

- `paths.base = input.basePath` (null for `added`), `paths.head = changeKind === "removed" ? null : candidate.filePath`.
- `sides.base = paths.base !== null`, `sides.head = paths.head !== null`.
- Then check each file on disk (`join(worktreeDir, paths[side])`, with `assertInside`). An expected side whose file is missing becomes a `file_missing` failure for that side (not `null`, because the change kind says it should exist), logged as a console warning.

#### 5.13.3 `RenderRun.execute` (step by step)

```ts
async execute(inputs: RenderComponentInput[]): Promise<ComponentRenderResult[]> {
  const startedAt = this.deps.now();
  this.deadline = startedAt + RENDER_STAGE_TIMEOUT_MS;

  // 0. Templates must exist (fatal otherwise).
  await assertTemplatesPresent(HARNESS_TEMPLATES_DIR);
  // 1. Plan. Inconsistent inputs (no side on disk) → final failed result immediately (persisted, no servers needed).
  const items = await this.planItems(inputs);              // fills this.results for unrenderable inputs
  if (items.length === 0) return this.orderedResults(inputs);

  // 2. Workspaces: both sides, templates + globals + every component harness for the sides it exists on.
  //    IO failure here is environmental → PipelineStepError("rendering", "Could not write render harness files.").
  const layouts = this.resolveLayouts();
  await this.prepareWorkspaces(layouts, items);
  const envKeys = await this.deps.scanEnvKeys([layouts.base.viteRoot, layouts.head.viteRoot]);

  const groups = buildRenderGroups(items);
  await this.console("info", `Rendering ${items.length} component(s) in ${groups.length} render group(s).`);
  if (this.ctx.workspace.dependencyDrift) {
    await this.console("warn", "Dependencies differ between base and head, but both sides render with the repository's installed node_modules. Dependency changes are not reflected in screenshots.");
  }

  // 3. Browser (fatal on failure).
  this.session = await this.launchBrowserOrThrow();
  const onAbort = (): void => { void this.abortInFlight(); };
  this.ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    // 4. Groups: base and head hosts in parallel, items sequentially, both sides of an item in parallel.
    for (const group of groups) {
      if (await this.shouldStop()) break;
      await this.renderGroup(group, layouts, envKeys);
    }
    // 5. Repair rounds (HARNESS_MAX_REPAIRS_PER_COMPONENT).
    await this.runRepairRounds(layouts, envKeys);
    // 6. Budget exceeded → remaining items failed (persisted). Cancelled → remaining items untouched.
    await this.failUnfinishedIfBudgetExceeded(items);
  } finally {
    this.ctx.signal.removeEventListener("abort", onAbort);
    await this.cleanup(); // contexts, hosts, browser; never throws
  }

  await this.console("info", this.summaryLine(startedAt));
  return this.orderedResults(inputs);
}
```

`orderedResults(inputs)` returns results in input order and **omits** components that were not finished because of cancellation (their rows stay `pending`; sheet 07 marks the visualization cancelled).

`shouldStop()`:

```ts
private async shouldStop(): Promise<boolean> {
  if (this.ctx.signal.aborted) { this.cancelled = true; return true; }
  if (await this.ctx.isCancelled()) { this.cancelled = true; return true; }
  if (this.deps.now() >= this.deadline) { this.budgetExceeded = true; return true; }
  return false;
}
```

Called before each group, before each item, before each repair call, and before starting each repair group.

#### 5.13.4 Groups and hosts

```ts
type HostSlot =
  | { state: "ready"; handle: ViteHostHandle; rendered: number }
  | { state: "failed"; message: string }
  | { state: "not_needed" };

private async renderGroup(group: RenderGroup, layouts: SideLayouts, envKeys: string[]): Promise<void> {
  const needs = { base: group.items.some((i) => i.sides.base), head: group.items.some((i) => i.sides.head) };
  const [base, head] = await Promise.all([
    this.openHost("base", group, layouts.base, envKeys, needs.base),
    this.openHost("head", group, layouts.head, envKeys, needs.head),
  ]);
  try {
    for (const item of group.items) {
      if (await this.shouldStop()) return;
      const attempt = await this.renderItem(item, { base, head }, 0);
      if (attempt === null) return;                                  // cancelled mid-item
      await this.finalizeAttempt(item, attempt, "original");
      if (this.needsRepair(item, attempt)) this.repairQueue.push({ item, attempt });
    }
  } finally {
    await Promise.all([this.closeHost(base), this.closeHost(head)]);
  }
}
```

`openHost(side, group, layout, envKeys, needed)`:

1. `!needed` → `not_needed`.
2. `this.brokenSides[side]` set → `failed` with the sticky message (no new process).
3. Build `ViteHostStartOptions`: `optimizeEntries` = `entry.tsx`, `globals.ts`, and every `components/<id>.tsx` written on that side (all groups); `warmupFiles` = `entry.tsx` + this group's files; `mocks` = this group's accepted mocks with `componentFile = join(layout.worktreeDir, item.paths[side])` (the side's own path, so relative mock specifiers of renamed components anchor correctly).
4. `await this.deps.startViteHost(options, layout.harnessUrlPath, this.ctx.signal)`; add to `liveHosts`. Console info: `"Vite 5.4.20 ready for the head side (group 2/4) in 1.4 s."` for the first group per side, debug afterwards.
5. On `ViteHostStartError`: message from 5.12.2; if `error.sticky` → `brokenSides[side] = message` and a single console error (`"Vite could not start on the base side: …"`); else console warn. Return `failed`.
6. Forward `ready.warnings` once per side as console warnings (rejected mocks are reported once per component instead, see 5.13.5).

#### 5.13.5 Rendering one item

```ts
private async renderItem(item: RenderWorkItem, hosts: { base: HostSlot; head: HostSlot }, attemptNo: number): Promise<ItemAttempt | null> {
  const [base, head] = await Promise.all([
    item.sides.base ? this.renderSide(item, "base", hosts.base, attemptNo) : Promise.resolve(null),
    item.sides.head ? this.renderSide(item, "head", hosts.head, attemptNo) : Promise.resolve(null),
  ]);
  if (base?.kind === "cancelled" || head?.kind === "cancelled") return null;
  return { attemptNo, harness: item.harness, base, head };
}
```

`renderSide(item, side, slot, attemptNo)` → `SideAttempt { result: RenderSideResult; kind: RenderFailureKind | null; tempImagePath: string | null }`:

0. The side was planned as `file_missing` → that failure, no page opened.
1. `slot.state === "failed"` → failure `vite_unavailable` with `slot.message`.
2. `slot.state === "ready"` but `!handle.isAlive()` → failure `vite_unavailable` (`"The Vite dev server exited (…)"`). (The group continues; remaining items on that side fail fast. Hosts are not restarted inside a group: a dead host usually means a crash that will repeat.)
3. `timeoutMs = min(RENDER_TIMEOUT_MS + (slot.rendered === 0 ? RENDER_COLD_START_ALLOWANCE_MS : 0), deadline - now)`. If ≤ 0 → failure `budget_exceeded`.
4. `await this.deps.artifactStore.ensureComponentDir(vid, cid)`; `final = componentImagePath(vid, cid, side)`; `tempImagePath = final.absolutePath + ".attempt" + attemptNo + ".png"`.
5. If the browser is disconnected and no relaunch has happened yet → relaunch (5.13.8).
6. `outcome = await session.renderComponent({ host, componentId, timeoutMs, outputPath: tempImagePath, signal, checkStylesheets })`; `slot.rendered += 1`.
7. If `!outcome.ok && outcome.infraRetryable && retries < RENDER_INFRA_RETRIES` → log debug, re-run step 6 once with the remaining budget.
8. Map to `RenderSideResult`:
   - ok: `{ side, ok: true, imagePath: final.relativePath, width, height, error: null, consoleErrors, durationMs }` (imagePath is the final path; the file is moved there in finalize).
   - failure: `{ side, ok: false, imagePath: null, width: null, height: null, error: outcome.error, consoleErrors, durationMs }`.
9. Console events: ok with `mode === "empty"` → warn; `stable === false` → warn; `truncated` → warn; `stylesheetWarning` → warn (once per side).

`finalizeAttempt(item, attempt, which)`:

- For each present side: if `ok` → `fs.rename(tempImagePath, final.absolutePath)`; if not ok → `fs.rm(final.absolutePath, { force: true })` (so a stale image from an earlier attempt cannot be shown with a failure).
- `result = { componentId, base: attempt.base?.result ?? null, head: attempt.head?.result ?? null }`; `this.results.set(cid, result)`.
- Persist via `saveRenderResult` with `renderStatus = deriveRenderStatus(result)`; include `harness` fields when `which === "repaired"` (the repaired harness is persisted only here, never by 09).
- Persistence failure → `new PipelineStepError("rendering", "Could not save render results.", { code: "RENDER_PERSIST_FAILED", cause })` (thrown after `finally` cleanup).
- Console: `"Rendered Button: base ok (412×88), head ok (412×92)."` or `"Button: head failed (module_load): <first line of error>"`.

```ts
export function deriveRenderStatus(result: ComponentRenderResult): "rendered" | "partial" | "failed" {
  const sides = [result.base, result.head].filter((side): side is RenderSideResult => side !== null);
  const okCount = sides.filter((side) => side.ok).length;
  if (sides.length === 0 || okCount === 0) return "failed";
  return okCount === sides.length ? "rendered" : "partial";
}
```

Status mapping in words: both sides present → both ok `rendered`, one ok `partial`, none `failed`; `added` (head only) and `removed` (base only) → that side ok `rendered`, else `failed`. A one-side failure on a component with both sides (`modified`, `affected_parent`) is `partial` and does **not** trigger repair, whichever side failed and wherever the stack points (00 §14.7): the harness demonstrably works on the other side, and the difference is what the reviewer must see.

#### 5.13.6 Repair loop

Trigger (00 §14.7, 09 §5.10.1): the primary side (head; base for `removed`) failed with a repairable kind **and** every other present side failed too. One-side failures of two-sided components are never repaired.

```ts
private needsRepair(item: RenderWorkItem, attempt: ItemAttempt): boolean {
  const primary = attempt[item.primarySide];
  if (primary === null || primary.result.ok || primary.kind === null || !isRepairableFailure(primary.kind)) return false;
  const other = attempt[item.primarySide === "head" ? "base" : "head"];
  const othersFailed = other === null || !other.result.ok;
  return othersFailed && item.repairsUsed < HARNESS_MAX_REPAIRS_PER_COMPONENT;
}

/** HarnessRenderError for 09 (09 §5.1). */
function toRenderError(item: RenderWorkItem, attempt: ItemAttempt): HarnessRenderError {
  const primary = attempt[item.primarySide];
  if (primary === null) throw new Error("Invariant: toRenderError called without a primary-side attempt");   // guarded by needsRepair (no `!`, 01 §5.3.1)
  const other = attempt[item.primarySide === "head" ? "base" : "head"];
  return {
    sides: (["base", "head"] as const).filter((s) => item.sides[s]),
    kind: primary.kind as "module_load" | "render_error" | "timeout",
    message: primary.result.error ?? "",                                  // already formatRenderError output (5.12.3)
    otherSideMessage: other?.result.error ? other.result.error.slice(0, 1_000) : null,
  };
}
```

`runRepairRounds(layouts, envKeys)`; with `HARNESS_MAX_REPAIRS_PER_COMPONENT = 1` it executes one round:

1. Take `queue = this.repairQueue`; reset `this.repairQueue = []`.
2. For each entry, sequentially (AI calls; keeps provider rate limits simple):
   1. `shouldStop()` → stop.
   2. Console info: `"Repairing the harness for CartBadge after a render failure (head: module_load)."`
   3. `outcome = await this.deps.repairHarness(cid, entry.item.harness, toRenderError(entry.item, entry.attempt))`. A thrown error (a bug: 09 never throws) is caught, logged at warn, console warn `"Harness repair for CartBadge failed: <message>"`, and treated as `{ ok: false, reason: "ai_error", message: <that message> }` (09 §5.1 requires `message` on every failure outcome).
   4. `outcome.ok === false`:
      - `component_defect` / `cannot_render` → persist `harnessNotes = cap(item.harness.notes + "\n\n" + outcome.notesAppendix, 4 000)` together with the unchanged original render result (same payload as the original finalize plus `harnessNotes`). Console warn `"Harness repair for CartBadge: the failure looks like a defect in the component itself."` (or `"… the AI considers it not renderable in isolation."`).
      - other reasons → console info `"No repaired harness for CartBadge (<reason>); keeping the first result."`; nothing else is written (the original result is already persisted).
   5. `outcome.ok === true` → `repaired = outcome.result`; validate mocks, recompute fingerprint and labels, `repairsUsed + 1`. Rewrite `components/<id>.tsx` on every present side (atomic; base side through `rewriteTargetSpecifier` for renamed components). Collect into `repairedItems` together with the original attempt.
3. `for (const group of buildRenderGroups(repairedItems))`: open hosts (new servers; module graphs and the entry's `import.meta.glob` are fresh), `renderItem(item, hosts, item.repairsUsed)`, then choose:

```ts
export function chooseAttempt(primarySide: RenderSide, original: ItemAttempt, repaired: ItemAttempt): "original" | "repaired" {
  const score = (attempt: ItemAttempt): number =>
    (attempt[primarySide]?.result.ok ? 2 : 0) +
    (attempt.base?.result.ok ? 1 : 0) +
    (attempt.head?.result.ok ? 1 : 0);
  return score(repaired) >= score(original) ? "repaired" : "original";
}
```

   - `repaired` → `finalizeAttempt(item, repaired, "repaired")` (moves its temp images over the finals, removes finals for failed sides, persists render columns **and** the repaired `harness_source`, `harness_notes`, `mocked_modules`). Console: `"Repaired harness rendered CartBadge: base ok, head ok."`
   - `original` → delete the repaired temp images; keep what was persisted (the repaired harness is discarded and never written). Console info `"Repaired harness for CartBadge did not improve the result; keeping the first result."`
   - If the repaired attempt is chosen but still meets the repair trigger and `repairsUsed < HARNESS_MAX_REPAIRS_PER_COMPONENT` → push to `repairQueue` for the next round (inactive with the current constant, but the loop is written generally).

Every present side is re-rendered with the repaired harness, so the comparison always uses one harness for both sides. Ties go to the repaired attempt (its harness addressed the failure; with equal scores both attempts failed equally).

#### 5.13.7 Timeouts

| Timer | Value | Scope | On expiry |
|---|---|---|---|
| `VITE_START_TIMEOUT_MS` | 60 s | fork → `ready` | `ViteHostStartError("timeout")`, side failed for this group (not sticky) |
| `RENDER_TIMEOUT_MS` | 30 s | one side attempt: goto → PNG | `timeout` failure (repairable) |
| `RENDER_COLD_START_ALLOWANCE_MS` | +30 s | first render on each host (dep optimization) | — |
| `RENDER_STAGE_TIMEOUT_MS` | 15 min | whole `renderAll` | stop scheduling; per-attempt budgets clamp to the deadline; unfinished items → `budget_exceeded` (persisted `failed`) |
| `VITE_STOP_TIMEOUT_MS` | 5 s | host shutdown | SIGKILL |
| `BROWSER_CLOSE_TIMEOUT_MS` | 10 s | `browser.close()` | log warn; Playwright's driver kills Chromium on process exit |

#### 5.13.8 Browser crash handling

If `session.isConnected()` is false before a render, or an outcome has kind `browser` and the session reports disconnected, `RenderRun` closes the old session (ignoring errors) and launches a new one, at most once per run (console warn `"Chromium disconnected; restarting the browser."`). A second disconnect marks every remaining side render as `browser` failure without further launches.

#### 5.13.9 Cleanup (`finally`, never throws)

```ts
private async cleanup(): Promise<void> {
  await settle(this.session?.closeAllContexts());
  await Promise.all([...this.liveHosts].map((host) => settle(host.stop())));
  this.liveHosts.clear();
  await settle(this.session?.close());
  await this.removeTempImages(); // any "*.attempt*.png" created by this run that was not finalized
}
// settle(p) awaits p and logs (warn) instead of throwing
```

Cleanup runs on success, on `PipelineStepError`, on cancellation and on unexpected exceptions. Unexpected exceptions (bugs) are wrapped: `throw new PipelineStepError("rendering", "Rendering failed unexpectedly.", { code: "RENDER_UNEXPECTED", cause: error })` after cleanup. Harness files are left in place; sheet 07 removes the worktrees.

`abortInFlight()` (abort listener): `session.closeAllContexts()` and `host.stop()` for live hosts, so cancellation takes effect within about a second instead of waiting for a 30 s render timeout.

#### 5.13.10 Memory and resource bounds

- At most two Vite host processes alive (one per side), each capped at `--max-old-space-size=2048`.
- One Chromium; at most two contexts open at a time (base and head of one item).
- Screenshot buffers: at most two per side during the stability loop; released after the write. Max capture 1280 × 4000 px.
- Log ring buffer 500 entries per host; console errors 20 × 500 chars per side; formatted errors 4 000 chars.
- `RenderRun` holds only small result objects; images live on disk.
- Child stdout/stderr capped at 2 000 lines per host.

### 5.14 Configuration constants (`config-consts/render.config.ts`)

Sheet 02 owns the consolidated list (00 §14.8) and must ship exactly these names and values; 10 never defines constants locally. The Vite host child imports `render.config.ts` directly (5.2), so that file must not import env helpers or other config files.

```ts
export const RENDER_VIEWPORT = { width: 1280, height: 800 } as const;
export const RENDER_TIMEOUT_MS = 30_000;
export const VITE_START_TIMEOUT_MS = 60_000;
export const HARNESS_DIR_NAME = ".prvision-harness";
/** Absolute path of backend/harness-templates, resolved by 02 from the backend package root (same value from src/ under ts-node and from dist/). */
export const HARNESS_TEMPLATES_DIR: string;
export const RENDER_STAGE_TIMEOUT_MS = 15 * 60_000;
export const RENDER_COLD_START_ALLOWANCE_MS = 30_000;
export const VITE_STOP_TIMEOUT_MS = 5_000;
export const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
export const RENDER_SETTLE_QUIET_MS = 250;
export const RENDER_SETTLE_MAX_MS = 5_000;
export const RENDER_ASSET_WAIT_MS = 3_000;
export const RENDER_MODULE_ERROR_GRACE_MS = 2_000;
export const RENDER_STABILITY_INTERVAL_MS = 150;
export const RENDER_STABILITY_MAX_ATTEMPTS = 5;
export const RENDER_CAPTURE_PADDING_PX = 16;
export const RENDER_MAX_CAPTURE_HEIGHT_PX = 4_000;
export const RENDER_FIXED_TIME_ISO = "2025-01-15T10:30:00.000Z";
export const RENDER_RANDOM_SEED = 1_337;
export const RENDER_INFRA_RETRIES = 1;
export const RENDER_ERROR_MAX_CHARS = 4_000;
export const RENDER_CONSOLE_ERRORS_MAX = 20;
export const RENDER_CONSOLE_ERROR_MAX_CHARS = 500;
export const VITE_HOST_MAX_OLD_SPACE_MB = 2_048;
export const VITE_HOST_LOG_BUFFER_SIZE = 500;
export const SUPPORTED_VITE_MAJOR_MIN = 4;
export const SUPPORTED_VITE_MAJOR_MAX = 7;
```

`HARNESS_MAX_REPAIRS_PER_COMPONENT` (value 1) lives in `ai.config.ts` (05 §5.10) and is imported from the `config-consts` barrel in the parent process only.

### 5.15 Determinism checklist and known flakiness

Determinism measures (all must hold; each maps to an acceptance check):

1. Same harness source for base and head; a repaired harness re-renders both sides.
2. Same Chromium instance, same launch flags, software rendering (`--disable-gpu`), sRGB, no LCD text, no hinting, hidden scrollbars.
3. Viewport 1280 × 800, `deviceScaleFactor: 1`, `scale: "css"`.
4. `locale: en-US`, `timezoneId: UTC`, fixed `Date` (`page.clock.setFixedTime`).
5. Seeded `Math.random`.
6. `reducedMotion: "reduce"`, transitions zeroed, `animations: "disabled"` and `caret: "hide"` at capture.
7. No network egress; deterministic stand-ins for images, styles, scripts and API calls; external fonts blocked (local fallback fonts on both sides).
8. Fresh context per render (no storage carry-over), service workers blocked, media permissions blocked.
9. Ready only after React commit + DOM quiet (250 ms, max 5 s) + `document.fonts.ready` + images + 2 rAF; then two byte-identical frames.
10. Top-left-anchored clip computed from painted content; constant canvas for empty renders.
11. Same env on both sides except what the commits themselves change; missing referenced keys are `""` on both sides.
12. Same `node_modules` (shared symlink) and the same pre-bundling configuration on both sides.
13. Mouse never moved (no hover states); no focus changes beyond what the component does itself.

Known flakiness sources and mitigations:

| Source | Mitigation | Residual risk |
|---|---|---|
| JS animations ignoring reduced motion (framer-motion without `MotionConfig`, GSAP, chart libraries) | DOM-quiet wait, stability loop | Infinite JS animations: last frame kept, warning logged |
| Vite dependency re-optimization mid-render | Scanner sees all deps (mock plugin returns null while scanning), `holdUntilCrawlEnd`, one infra retry | New deps introduced only by repaired harnesses |
| Late lazy chunks / nested Suspense | DOM-quiet wait | Chunks slower than 5 s settle max |
| `setInterval`-driven UI (countdowns, tickers) | Fixed `Date` | Counters based on tick count, not time |
| `crypto.randomUUID`-dependent rendering (e.g. generated avatar colours) | — | Visible randomness from crypto APIs |
| Canvas/WebGL rendering differences | Software rendering on the same machine | Non-deterministic WebGL shaders |
| `IntersectionObserver` content | Fixed viewport; content below the fold renders consistently on both sides | Content that depends on scroll position |
| CPU contention (base and head in parallel) | Readiness is signal-based, not time-based | Only affects durations |
| Font loading via `font-display: swap` | `document.fonts.ready` wait (max 3 s) | Very slow local font files |
| Dependency drift between base and head | Console warning | Version bumps in the PR are not rendered |

---

## 6. Error handling and edge cases

Rule: `renderAll` throws only `PipelineStepError` (fatal for the visualization). Everything that affects one component or one side is captured in `RenderSideResult.error` and persisted; it never fails the visualization.

Fatal (`PipelineStepError`, stage `"rendering"`), always after cleanup:

| Condition | `userMessage` |
|---|---|
| Chromium cannot launch | "Chromium for Playwright is not installed. Run `npx playwright install chromium` in the PRVision folder." or "Chromium could not be started: …" |
| Harness templates directory not found | "PRVision's harness templates are missing (backend/harness-templates). Reinstall PRVision." |
| Writing harness files fails (EACCES, ENOSPC, path escape) | "Could not write render harness files: …" |
| Persisting a component result fails | "Could not save render results." |
| Unexpected exception (bug) | "Rendering failed unexpectedly." (cause logged with stack) |

Per-component / per-side cases:

| Case | Behaviour |
|---|---|
| Component without a harness | Never passed to 10 (`buildRenderInputs` omits it; 09 already persisted its `skipped`/`failed` row, 00 §14.7). 10 writes nothing for it. |
| Component file missing on a side the change kind requires | That side `file_missing`; other side renders normally. |
| Both sides absent (inconsistent candidate) | Status `failed`, both side results `null`, `base_error = head_error = "Component file not found on either side."`, console warn. |
| Vite missing / unsupported / config throws on one side | Every component's side result on that side is `vite_unavailable` with the 5.12.2 message; sticky for the run; the other side still renders (`partial`). No repair (not a harness problem). |
| Vite start timeout or child exit during start | Side failed for that group only; next group retries a fresh host. |
| Vite host dies mid-group | Remaining items of that group fail fast on that side with the exit reason; next group starts a new host. |
| Harness module has no default export | `module_load` with an explicit message; repairable. |
| Harness/mock syntax error | Vite 500 with plugin/file/frame → `module_load`; repairable. |
| Mock missing a named export | Browser `SyntaxError` naming `[mock of "<specifier>"]` → `module_load`; repairable. |
| Unresolvable import in component graph | `module_load` with "Failed to resolve import …"; repairable (AI can mock it). |
| `globals.ts` CSS fails to compile (e.g. missing `sass`) | `module_load` on every component of that side, message names the stylesheet; repair will not help but is attempted once for the primary side (the AI may not change anything; result kept). |
| Render throws | `render_error` with message, stack, component stack; repairable. |
| Component renders `null` | `ok: true`, `mode: "empty"`, 320 × 64 blank image, console warning. |
| Modal / portal / fixed overlay | Viewport-mode capture (5.11.7). |
| Content taller than 4 000 px | Truncated capture, console warning. |
| Never stabilizes | Last frame used, console warning. |
| Never ready | `timeout` with phase + root diagnostics; repairable. |
| Dep re-optimization during a render | One infra retry; then `module_load`. |
| Chromium crash | Relaunch once per run; side `browser` failure for the affected render. |
| Repair throws or returns `{ ok: false }` | Original result kept; console message (verdicts also append `notesAppendix`, 5.13.6). |
| Repaired attempt worse | Original kept (5.13.6 scoring); repaired temp images deleted. |
| Cancellation | Stop at the next check; abort in-flight pages and hosts; do not persist unfinished components; return finished ones. |
| Stage budget exhausted | Remaining components persisted as `failed` with `budget_exceeded`. |
| Duplicate component ids in input | Second occurrence ignored with a warn log (defensive; 08 guarantees uniqueness). |
| User config sets `root`, `base`, `server.proxy`, `server.https` | Overridden/removed with a warning (5.7.2). |
| User config is a function or async | Handled by the repo's `loadConfigFromFile`. |
| No Vite config file | Plain Vite defaults + `esbuild.jsx = "automatic"`; works for TSX components. |
| Monorepo package outside `viteRoot` imported by a component | Served via `/@fs/` if inside the workspace root found by `searchForWorkspaceRoot`; otherwise Vite's 403 → `module_load`. |
| `.env` missing | Referenced `VITE_*` keys are `""`. |
| React 17 project | Legacy mount path (best effort). |
| Port collision | Probed free port + `strictPort: false`; the real port is read back from the server (5.6.3). |
| Path traversal in `filePath`, `viteConfigPath` or `globalStylePaths` | `assertInside` throws → the item (or the run, for config/global paths) fails with a clear message; never writes outside `.prvision-harness/`. |

## 7. Logging / console events

Pino: `const log = createLogger("render", { visualizationId })` (04 §9.10). The Vite host child has no logger; it forwards over IPC. Never log harness or mock source text at info level (debug only, truncated to 2 000 chars).

Every call carries `event` (01 §5.8) with a constant message:

| Level | Event (`event`) | Fields |
|---|---|---|
| info | run start / finish (`render.run.started` / `render.run.finished`) | `components`, `groups`, `durationMs`, `rendered`, `partial`, `failed` |
| info | host ready (`render.vite_host.ready`) | `side`, `groupKey`, `viteVersion`, `origin`, `startMs` |
| warn | host start failed (`render.vite_host.start_failed`) | `side`, `groupKey`, `kind`, `message`, `detail` |
| debug | host stdout/stderr lines, Vite info/warn logs (`render.vite_host.output`) | `side`, `groupKey`, `stream`, `line` |
| debug | page render (`render.page.completed`) | `componentId`, `side`, `attempt`, `durationMs`, `mode`, `stable`, `blockedRequests`, `width`, `height` |
| warn | side render failed (`render.page.failed`) | `componentId`, `side`, `kind`, `error` (first 500 chars) |
| info | repair requested / result (`render.repair.requested` / `render.repair.result`) | `componentId`, `outcome: "applied" \| "kept_original" \| "none" \| "error"` |
| warn | browser relaunch, cleanup errors, persistence retries (`render.browser.relaunched` / `render.cleanup.failed`) | `error` |
| error | fatal `PipelineStepError` (`render.stage.fatal`) | `userMessage`, `cause` stack |

Console events (`ctx.console.<level>("rendering", message)`; wrapped so a console write failure is logged at warn and never breaks rendering; all calls awaited):

| Level | Message (template) |
|---|---|
| info | `Rendering 12 component(s) in 3 render group(s).` |
| warn | `Dependencies differ between base and head, but both sides render with the repository's installed node_modules. Dependency changes are not reflected in screenshots.` |
| info | `Vite 5.4.20 ready for the base side in 1.8 s.` (first group per side) |
| error | `Vite could not start on the head side: <5.12.2 message>` (sticky, once) |
| warn | `Vite on the base side failed to start for render group 2: <message>` (non-sticky) |
| info | `Removed dev-only Vite plugins on the head side: vite-plugin-checker.` |
| warn | `Ignoring server.proxy from the Vite config (network is disabled while rendering).` |
| warn | `Global style src/old.css does not exist on the base side.` |
| warn | `Mock "react" for CartBadge was ignored: React core cannot be mocked.` |
| warn | `Harness for CartBadge uses className; Tailwind classes in harness files may not be generated.` |
| info | `Rendered Button: base ok (412×88), head ok (412×92).` |
| warn | `CartBadge: head failed (module_load): Failed to resolve import "../hooks/useCart" …` |
| warn | `Modal rendered nothing on the base side.` / `… did not stabilise; using the last frame.` / `… is taller than 4000 px; the image is truncated.` |
| warn | `Tailwind is installed but no utility classes were generated on the head side; check globalStylePaths and the Tailwind content configuration.` |
| info | `Repairing the harness for CartBadge after a head render failure.` |
| info | `Repaired harness rendered CartBadge: base ok, head ok.` / `Repaired harness for CartBadge did not improve the result; keeping the first result.` / `No repaired harness for CartBadge; keeping the first result.` |
| warn | `Harness repair for CartBadge failed: <message>` |
| warn | `Chromium disconnected; restarting the browser.` |
| warn | `The render stage exceeded its 15-minute budget; 4 component(s) were not rendered.` |
| info | `Render stage finished in 74 s: 9 rendered, 2 partial, 1 failed.` |

Volume: at most one line per component per attempt plus a bounded number of per-side lines; no per-request or per-log-line console events.

## 8. Security notes

- **Rendering executes repository code.** The Vite config and its plugins run in the host child with the user's privileges; component, harness and mock code run in Chromium. For `github_pr` sources the head side is code from the PR author. This has the same trust level as checking the PR out and running `npm run dev`. The UI (sheet 13) should state this on the "new visualization from PR" dialog; this sheet only enforces the containment below.
- **Secrets do not reach the child.** The host child gets an allowlisted environment (5.6.2); `DATABASE_URL`, `REDIS_URL`, `PRVISION_SECRET_KEY`, AI keys and `NODE_OPTIONS` are dropped. The child imports nothing that reads PRVision config or opens DB/Redis connections.
- **No network egress from pages.** Every off-origin request is fulfilled locally or aborted; non-Vite WebSockets are closed; service workers are blocked; media permissions are denied (Uply helper). Node-side plugin code is not network-restricted (documented limitation).
- **Local-only servers.** Vite binds `127.0.0.1` on a probed free port (5.6.3 step 7b), lives only for one render group, and has `server.proxy` and HTTPS removed. Other local processes could fetch the worktree's source while it runs; acceptable for a single-user local tool.
- **Filesystem containment.** All writes go to `<viteRoot>/.prvision-harness/` and to artifact paths from `ArtifactStore`. Every path derived from DB values (`filePath`, `viteConfigPath`, `globalStylePaths`) passes `assertInside(worktreeDir, …)`. Component harness file names are numeric ids. Nothing is written into `node_modules` (a symlink into the user's clone), except Vite 6/7's own short-lived config bundle under `node_modules/.vite-temp/`, which Vite deletes immediately (documented side effect of using the repo's own Vite; alternative `configLoader: "runner"` is not used because it rejects some CJS configs).
- **The user's working copy is never modified.** `cacheDir` is redirected away from `node_modules/.vite`.
- **AI-written code** (harness, mocks) is executed only in the browser page; in Node it is only transpiled (esbuild/oxc), never evaluated.
- **Env values** from tracked `.env` files are injected into pages and may appear in screenshots; images stay in the local data dir.
- **Chromium sandbox.** Playwright's default (`chromiumSandbox: false`) is kept because unprivileged user namespaces are unavailable on several supported Linux setups; the browser only loads `127.0.0.1` content and has no egress. Revisit before distribution.
- **Error messages** are normalized (origin and absolute worktree paths stripped) before persistence and before being sent to the AI repair prompt.

## 9. Tests

Framework: `node:test` + `node:assert/strict`, files under `tests/backend/render/`. Unit and orchestration tests must not start Vite or Chromium. Helpers in `tests/backend/render/helpers/`.

### 9.1 `vite-mock-plugin.test.ts`

Uses a fake plugin context whose `resolve(source, importer)` is backed by a map `{ "<importerDir>\0<source>": "<resolved id>" }`.

- `classifySpecifier distinguishes relative, absolute and bare specifiers`
- `packageNameOf handles scoped packages, subpaths and aliases`
- `validateMockedModules rejects queries, styles, assets, React core and its subpaths, scheduler, duplicates, empty and oversized sources with the exact reason texts`
- `mock-rules imports nothing but node:path and types` (static import check)
- `mockVirtualId is stable for identical input and differs when source changes`
- `resolveId returns the virtual id for an exact package specifier from user source`
- `resolveId does not apply alias or relative mocks to node_modules importers`
- `resolveId applies package mocks to node_modules importers`
- `resolveId matches a relative mock when the same file is imported from another directory`
- `resolveId matches an alias mock when the importer uses a relative path to the same file`
- `resolveId matches an alias-expanded absolute source by resolved path`
- `resolveId returns the chain's resolution for non-mocked eligible sources (no double resolution)`
- `resolveId returns null during dependency scan for resolvable targets`
- `resolveId returns the virtual id during dependency scan for unresolvable targets`
- `resolveId never mocks imports made by a mock module`
- `relative imports inside a mock resolve against the component file`
- `resolveId ignores specifiers with queries and asset extensions`
- `a mock targeting the component file itself is ignored with a warning`
- `load transpiles mock source once and caches it`
- `load wraps transpile errors with the specifier and component id`
- `load throws for unknown virtual ids and returns null for other ids`
- `an empty registry yields hooks that return null`

### 9.2 `render-groups.test.ts`

- `components without mocks share the "none" group`
- `identical mocks on components in different folders share a group for bare specifiers`
- `relative specifier fingerprints depend on the component directory`
- `mock order does not change the fingerprint`
- `groups are ordered none-first then by best rank, items by rank then id`

### 9.3 `vite-loader.test.ts` (fake packages from `fake-vite-package.ts`)

- `loads the ESM entry for the Vite 4 exports shape`
- `loads the ESM entry for the Vite 5 nested-conditions shape`
- `loads the ESM entry for the Vite 6 module-sync shape`
- `loads the ESM entry for the Vite 7 string export`
- `uses the default export when the namespace wraps the API`
- `reports vite_not_found when Vite is not installed`
- `reports vite_unsupported for Vite 3`
- `reports vite_unsupported when createServer is missing`
- `reports vite_load_failed with Node version and engines when import throws`
- `resolves through a symlinked node_modules to the real path`
- `resolveWatchOption returns null for 5.4+ and ignore-all for older versions`

### 9.4 `vite-server-config.test.ts`

`mergeConfig` is supplied by a small test double implementing Vite's documented semantics (skip null, concat arrays, deep-merge objects).

- `removes proxy, https, open, port, host, hmr, watch and warmup from the user server config`
- `forces root, base, appType, cacheDir, host 127.0.0.1 and the probed port`
- `places the mock plugin first and the harness plugin last around user plugins`
- `drops denylisted and build-only plugins and reports them`
- `adds harness, cache, node_modules realpath and workspace root to fs.allow while keeping user entries`
- `sets optimizeDeps.entries to exactly the provided list`
- `adds React includes for React 18 and omits react-dom/client for React 17`
- `sets server.watch after merge (null survives)`
- `adds warmup only for Vite 5+`
- `adds env defines without overriding user defines`
- `sets esbuild jsx automatic only when no config file was found`
- `warns when the user config sets root or base`
- `flattenUserPlugins awaits promises, flattens nested arrays and drops falsy values`

### 9.5 `harness-workspace.test.ts`

- `prepareSide copies templates, writes .gitignore and globals.ts`
- `globals.ts maps /src/… specifiers to POSIX relative imports and keeps bare package specifiers, in order`
- `globals.ts comments out missing files and uninstalled packages and reports them`
- `rewriteTargetSpecifier replaces exactly one import specifier and throws when it occurs zero or two times`
- `writeComponentHarness prepends the JSX pragma unless one exists`
- `writeComponentHarness writes atomically and overwrites on repair`
- `assertInside rejects traversal in filePath, viteConfigPath and globalStylePaths`
- `resolveSideLayout uses the config directory as viteRoot`
- `assertTemplatesPresent throws when a template file is missing`
- `scanReferencedEnvKeys collects VITE_ keys and skips node_modules and the harness dir`

### 9.5b `vite-host-client.test.ts`

Uses a fake host entry script (a few lines of Node that answer the IPC protocol and spawn a `sleep` grandchild).

- `buildChildEnv defaults its base to CHILD_PROCESS_BASE_ENV, adds only the fixed Vite values and never reads process.env`
- `buildChildEnv drops DATABASE_URL, REDIS_URL, PRVISION_*, ANTHROPIC_* and NODE_OPTIONS`
- `childExecArgv never copies process.execArgv and adds ts-node only for .ts entries`
- `start resolves on the ready message and reads the origin from it`
- `start timeout kills the whole process group including grandchildren`
- `abort during start kills the process group and rejects with kind aborted`
- `stop sends shutdown, then SIGKILLs the group after VITE_STOP_TIMEOUT_MS`
- `child exits by itself when the IPC channel disconnects`
- `liveCount returns to 0 after stop`

### 9.6 `render-errors.test.ts`

- `extractViteErrorFromBody parses the Vite 4 ErrorOverlay body`
- `extractViteErrorFromBody parses the Vite 5+ const error body`
- `extractViteErrorFromBody falls back to stripped text`
- `formatRenderError orders sections and truncates at RENDER_ERROR_MAX_CHARS`
- `formatRenderError strips the Vite origin and worktree paths`
- `rewriteMockIds replaces encoded and raw mock ids with readable labels`
- `isRepairableFailure is true only for module_load, render_error and timeout`
- `isOptimizeDepsChurn recognises outdated optimize dep messages`

### 9.7 `browser-session.helpers.test.ts`

- `decideRoute continues same-origin, data and blob URLs`
- `decideRoute fulfils off-origin images with a 1x1 PNG, styles and scripts with empty bodies, and fetches with {}`
- `decideRoute aborts off-origin fonts and media`
- `decideRoute aborts unparsable URLs`
- `readPngSize reads width and height from the IHDR chunk`
- `sameClip compares integer clip rectangles`
- `buildContextOptions sets viewport, scale 1, reduced motion, light scheme, en-US, UTC, blocked service workers and no permissions`
- `buildDeterminismInitScript is deterministic for a seed and produces the same first random values`

### 9.8 `render-service.test.ts` (stubs from `render-stubs.ts`)

`FakeViteHost` records start options and returns scripted `ready`/`start_failed`; `FakeBrowserSession.renderComponent` returns scripted outcomes keyed by `(componentId, side, attempt)` and writes a tiny PNG to `outputPath` on success; `InMemoryPersistence` records payloads; `fakePipelineContext()` provides console capture, `isCancelled`, and an `AbortController`.

- `renders both sides of a modified component and persists rendered status with relative image paths`
- `added component renders head only and returns base null`
- `removed component renders base only and returns head null`
- `buildRenderInputs omits candidates without a harness and sets basePath from renames`
- `renamed component: base harness file imports the previous path, head file the new path`
- `missing component file on an expected side yields file_missing for that side`
- `base-only failure yields partial without repair`
- `head-only failure of a modified component yields partial without repair (stack inside the component)`
- `both sides failing with module_load trigger one repair with a HarnessRenderError and re-render both sides`
- `head failure of an added component triggers repair; base failure of a removed component triggers repair`
- `repaired attempt is persisted with the new harness fields and replaces both images`
- `repaired attempt that is worse keeps the original result, deletes temp images and never writes the repaired harness`
- `component_defect verdict appends notesAppendix to harness_notes and keeps the original result`
- `repair outcome ok:false or a thrown error keeps the original result`
- `repairs never exceed HARNESS_MAX_REPAIRS_PER_COMPONENT`
- `vite_unavailable failures are not repaired`
- `sticky host start failure fails every group on that side without starting new hosts`
- `non-sticky host start failure is retried for the next group`
- `groups start base and head hosts in parallel and stop them before the next group starts`
- `components are grouped by mock fingerprint and only that group's mocks are passed to the host`
- `first render on each host gets the cold start allowance`
- `infra-retryable outcome is retried once`
- `cancellation before a group stops scheduling, cleans up and returns only finished components`
- `abort during an in-flight render closes contexts and hosts and does not persist that component`
- `stage budget exhaustion persists remaining components as failed`
- `browser launch failure throws PipelineStepError and starts no hosts`
- `persistence failure throws PipelineStepError after closing hosts and the browser`
- `persistence updates use (values, { id, visualizationId }, Table.VISUALIZATION_COMPONENTS)`
- `missing harness templates throw PipelineStepError before any host starts`
- `browser disconnect triggers one relaunch`
- `results are returned in input order`
- `deriveRenderStatus maps side outcomes to rendered, partial and failed`
- `chooseAttempt prefers a primary-side success and breaks ties toward the repaired attempt`

### 9.9 `tests/backend/integration/render-engine.integration.test.ts` (gated)

Gate (00 §14.10): runs only when `PRVISION_IT_RENDER=1` or `PRVISION_INTEGRATION=1` (use sheet 14's shared gate helper); otherwise every test is `skip`ped with reason `"set PRVISION_IT_RENDER=1 (needs Chromium and the fixture repo)"`. `PRVISION_RENDER_IT` is not read. Locates the fixture with sheet 14's `requireFixtureRepo()` (reads `PRVISION_REAL_DATA_DIR`, because the test preload points `<dataDir>` at a temp dir); when the gate is on and the fixture or its `node_modules` is missing, the test **fails** with "run node tools/create-fixture-repo.mjs" rather than skipping.

Setup per test file:

1. Copy the fixture (excluding `node_modules`, `.git`, `dist`) into `tmp/base` and `tmp/head`; symlink each `node_modules` to the fixture's `node_modules` (same as sheet 07 does).
2. Write test-owned components into `src/__prvision_it__/` of both copies (self-contained, so the test depends on the fixture only for Vite + React + Tailwind being installed):
   - `Swatch.tsx`: `<div className="h-24 w-24 bg-red-500" />`
   - `Greeting.tsx`: imports `{ getName }` from `./api` and renders it; `api.ts` throws at import time (`throw new Error("network not allowed")`).
   - `Modal.tsx`: `createPortal(<div className="fixed inset-0 bg-black/50"><div className="bg-white p-6">Hello</div></div>, document.body)`.
   - `Thrower.tsx`: throws `new Error("boom from Thrower")` during render.
   - `RemoteImage.tsx`: `<img src="https://example.com/a.png" width={40} height={40} />` plus a `fetch("https://example.com/api")` in an effect rendering `JSON.stringify(data)`.
   - On head only, for the "different" case: `Swatch.tsx` uses `bg-blue-500`.
3. Real `RenderService` with real `ViteHostClient`, real `BrowserSession`, `InMemoryPersistence`, an artifact adapter writing under a temp data dir, and a scripted `repairHarness` (returns `{ ok: false, reason: "budget_exhausted", message: "repair budget exhausted" }` unless a case scripts a repaired harness).

The fixture uses Tailwind 4 (00 §14.10): `bg-red-500` is an oklch colour that Chromium renders at about `rgb(251, 44, 54)` (v3 was `rgb(239, 68, 68)`). Assertions therefore prefer pixel-diff ratios (`pixelmatch` with 11's `PIXELMATCH_OPTIONS`) and colour *ranges*, never exact v3 values.

Cases:

- `renders the same component on identical base and head with zero pixel difference` (decode both PNGs with `pngjs`; same size; `Buffer.compare(base.data, head.data) === 0`).
- `rendering the same component twice gives identical pixels` (two runs; same size and pixel data; ratio 0).
- `detects a real visual change between base and head` (bg-red vs bg-blue; same canvas size; pixelmatch ratio over the canvas > 0.4 — the 96×96 swatch covers about 56 % of its 128×128 capture; base pixel at (40, 40) has R > B + 100, head pixel has B > R + 100).
- `applies Tailwind classes` (pixel at (40, 40) of `Swatch` is clearly red: R ≥ 200, G ≤ 90, B ≤ 90 — true for Tailwind v4 `red-500` ≈ `rgb(251, 44, 54)` and v3 `rgb(239, 68, 68)`).
- `applies a mock so a module that throws on import is never loaded` (`Greeting` with mock `{ specifier: "./api", source: "export const getName = () => 'Mocked';" }` renders ok).
- `reports an unresolved import with the missing specifier and calls repair once` (harness imports `./does-not-exist`; head error contains `does-not-exist`; `repairHarness` called once with that error; repaired harness fixes it; final status `rendered`).
- `reports a render error with message and component stack` (`Thrower`; both sides fail, so repair is called once with `kind: "render_error"`; the scripted repairer declines; persisted errors contain `boom from Thrower` and `Thrower`; status `failed`).
- `captures portals in viewport mode` (`Modal`; image width 1280, height ≥ 800).
- `serves off-origin images and fetches locally` (drives `BrowserSession.renderComponent` directly against a started head host for `RemoteImage`: outcome `ok`, `blockedRequests >= 2`, and it completes well inside the render timeout).
- `cleans up hosts and browser` (after `renderAll`, `ViteHostClient.liveCount() === 0` and the recorded host ports refuse connections).

Timeout for the integration file: 5 minutes.

## 10. Acceptance criteria

- [ ] All files in section 4 exist; `backend/harness-templates/*` are excluded from backend `tsc`/ESLint/Prettier and read at runtime from `HARNESS_TEMPLATES_DIR` (works from `src` under ts-node and from `dist`).
- [ ] `new RenderService({ repairHarness }).renderAll(ctx, buildRenderInputs(...))` has exactly the signatures in 5.13.1 and returns `ComponentRenderResult[]` in input order; it throws only `PipelineStepError` (04 §10 constructor, stage `rendering`).
- [ ] `esm-import.ts` uses a native `import()` (no `new Function`/`eval`); a test asserts the compiled output still contains `import(`.
- [ ] Each Vite host is forked with `detached: true` and an execArgv built from scratch; `stop()`, abort and the `exit` handler kill the whole process group; after a test that kills the parent's handle mid-start, no `vite-host-process` remains (`vite-host-client.test.ts`).
- [ ] Vite servers listen on a probed free port (never `port: 0`), and the origin uses the port read back from `httpServer.address()`.
- [ ] No `any`, explicit return types everywhere, no floating promises (`void` only for deliberate fire-and-forget in event handlers), strict TS passes.
- [ ] Vite is always loaded from the target worktree (`createRequire` + ESM entry from `exports`); backend `package.json` has no `vite` dependency; Vite 4, 5, 6 and 7 export shapes pass `vite-loader.test.ts`.
- [ ] Vite runs in a child process with `cwd = viteRoot` and an env built from `CHILD_PROCESS_BASE_ENV` plus fixed Vite values (never `process.env`); `DATABASE_URL`, `REDIS_URL`, `PRVISION_SECRET_KEY` are absent in the child (asserted in a unit test of `buildChildEnv`).
- [ ] Inline config: `configFile: false`, mock plugin first, `appType: "mpa"`, `base: "/"`, `host: 127.0.0.1`, probed non-zero `port` with `strictPort: false`, `hmr: false`, watch disabled, `cacheDir` = `.prvision-harness/.vite-cache`, `fs.allow` includes the realpath of `node_modules`; `server.proxy`/`https` removed.
- [ ] The user's `node_modules/.vite` is never created or modified by a render run (integration: compare mtime/existence before and after).
- [ ] Mock plugin unit tests pass all cases in 9.1; mocks are applied per render group; mocked packages are not added to `optimizeDeps.exclude`.
- [ ] Harness templates match 5.4.2–5.4.4; ready requires commit + DOM quiet + fonts + images + 2 rAF; errors are reported via `__PRVISION_ERROR__` with phase and component stack.
- [ ] Browser: one Chromium per job with `CHROMIUM_LAUNCH_ARGS`; fresh context per render with viewport 1280×800, DSF 1, `reducedMotion: "reduce"`, light scheme, `en-US`, `UTC`; fixed clock; seeded `Math.random`; off-origin requests never leave the machine.
- [ ] Capture: top-left-anchored painted-area clip; viewport mode for fixed overlays; 320×64 canvas for empty renders; max height 4 000 px; two identical frames or a logged "not stable" warning.
- [ ] Integration: same component on identical base and head → pixel-identical PNGs (diff ratio 0); two consecutive runs → pixel-identical PNGs.
- [ ] Integration: Tailwind v4 utility colour is applied (colour range, not v3 exact values); a real change yields a pixelmatch ratio > 0.4 on the swatch canvas; a mocked module that throws on import is never loaded; portal modal captured in viewport mode.
- [ ] `globals.ts` treats `globalStylePaths` as import specifiers (`/src/…` root-relative, bare package names), 00 §14.3.
- [ ] Renamed components: the base-side harness imports the previous path via `rewriteTargetSpecifier`; the head side is unchanged.
- [ ] Repair: called only when the primary side failed with `module_load`/`render_error`/`timeout` **and** every other present side failed; never for one-side failures of two-sided components; at most `HARNESS_MAX_REPAIRS_PER_COMPONENT` times per component; `repairHarness` receives a `HarnessRenderError` (09 §5.1) whose `message` is the 5.12.3 formatted error; repaired harness re-renders every present side; better attempt chosen per `chooseAttempt`; repaired harness fields persisted by 10 only when the repaired attempt is chosen; verdict appendices written to `harness_notes`.
- [ ] Persistence through `QueryHandler.update(values, { id, visualizationId }, Table.VISUALIZATION_COMPONENTS)`: `render_status`, `base_image_path`, `head_image_path` (`artifacts/<v>/<c>/<side>.png`, from `ArtifactStore.componentImagePath`), `image_width`, `image_height`, `base_error`, `head_error` per component received; errors ≤ 4 000 chars, normalized. Components without a harness are never written by 10.
- [ ] Status mapping exactly as `deriveRenderStatus`; any one-side failure of a two-sided component → `partial` without repair.
- [ ] Cancellation: no new hosts/pages after cancel; in-flight work aborted within ~1 s; unfinished components not persisted; cleanup ran (no live child processes, browser closed).
- [ ] Stage budget: remaining components persisted `failed` with the budget message.
- [ ] Every console message in section 7 uses stage `"rendering"`; no per-request console spam.
- [ ] With `PRVISION_IT_RENDER=1`, `npm run test:it` (sheet 14) running `tests/backend/integration/render-engine.integration.test.ts` passes on Linux and macOS with the fixture repo.

## 11. Contract changes requested

Resolved:

1. Harness folder in the Vite root; 07 symlinks `<viteRoot>/node_modules` — Resolved — 00 §14.7.
2. `PipelineStepError` location and constructor — Resolved — 00 §14.7 (04 §10: `new PipelineStepError(stage, userMessage, { code?, detail?, cause? })`).
3. Render config constants incl. `RENDER_VIEWPORT` — Resolved — 00 §14.8 (sheet 02 owns the list; names in 5.14). `HARNESS_TEMPLATES_DIR` replaces the old `resolveHarnessTemplatesDir()` walk.
4. `ArtifactStore` / `QueryHandler` names — Resolved — 00 §14.8 (adapters in 5.13.1 use `componentImagePath`, `resolveSafe`, `ensureComponentDir`, `update(values, conditions, table)`).
5. Harness conventions for 09 — Resolved — 00 §14.7 (09 adopts 5.8.1 and 5.12.3; shared `mock-rules.ts`).
6. Build tooling exclusions; `pngjs`/`pixelmatch` dependencies — Resolved — 00 §14.1.
7. `npx playwright install chromium` in setup — Resolved — 00 §14.1.
8. Repair persistence — Resolved — 00 §14.7 (09 never persists; 10 persists the kept attempt).
9. Render API owned by 10, 07 calls it as defined — Resolved — 00 §14.7.
10. Integration gate `PRVISION_IT_RENDER` and Tailwind v4 assertions — Resolved — 00 §14.10.

Also resolved (Revision 2 final review):

1. **Sheet 04 `ArtifactStore` signatures** — Resolved — 04 §9.8 now defines `componentImagePath(vid, cid, kind): string`, `resolveSafe(rel): string` and `ensureComponentDir(vid, cid): Promise<void>` (the `RenderArtifactStore` adapter in 5.13.1 uses exactly these). Originally requested (00 §14.8 lists the names only): 10 needs `componentImagePath(vid, cid, kind): string` (dataDir-relative POSIX, 00 §14.3), `resolveSafe(rel): string`, `ensureComponentDir(vid, cid)`, in place of the Revision 1 names `imageRelativePath`, `componentArtifactsDir`, `readFile`, `writeFile`, `removeVisualizationArtifacts`.
2. **Sheet 07** — Resolved — 07 §5.9.1/§5.9.4 now import `buildRenderInputs` and pass the outcome through unchanged. Originally requested: (a) use 10's exported `buildRenderInputs(candidates, results, analysis.changedFiles)` (it adds `basePath` for renamed components) instead of 07's own two-argument helper; (b) `toRepairHarnessFn` must pass 09's `HarnessRepairOutcome` through unchanged and forward the `HarnessRenderError` object (07 previously reduced it to `result | null` and documented `renderError` as a string).
Open: none.

Note (not a request): `RenderSideResult` has no warnings field (empty render, unstable frames, truncation are console events only) and no DOM snapshot path. If sheet 11's structural diff ever needs serialized DOM, add `domSnapshotPath: string | null` to `RenderSideResult`.
