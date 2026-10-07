/**
 * Render engine test doubles (sheet 10 §9.8): FakeViteHost / FakeViteHostFactory, FakeBrowserSession,
 * InMemoryPersistence, FakeArtifactStore and fakePipelineContext(). No Vite, no Chromium.
 */
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import type {
  ComponentRenderPayload,
  ComponentRenderPersistence,
  RenderArtifactStore,
  RenderBrowserSession,
  RenderComponentInput
} from "../../../../backend/src/services/visualizations/pipeline/render-service";
import { ViteHostStartError } from "../../../../backend/src/services/visualizations/pipeline/render/vite-host-client";
import type {
  PageRenderInput,
  PageRenderOutcome,
  RenderFailureKind,
  RenderSide,
  ViteHostHandle,
  ViteHostStartOptions,
  ViteLogEntry
} from "../../../../backend/src/services/visualizations/pipeline/render/render-types";
import type {
  ComponentCandidate,
  HarnessGenerationResult,
  MockedModule
} from "../../../../backend/src/types/visualization-pipeline";
import { createPipelineContext, type PipelineContextHandle } from "../../helpers/pipeline-context";
import { makeTempDir } from "../../helpers/temp-dir";

/** A tiny valid PNG (2×2 white) written by the fake session on success. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8/5+hnoEIwDiqEAAZ1gH/0YMV8AAAAABJRU5ErkJggg==",
  "base64"
);

// ---------------------------------------------------------------------------------------------------------------
// Vite hosts
// ---------------------------------------------------------------------------------------------------------------

export class FakeViteHost implements ViteHostHandle {
  alive = true;
  stopCalls = 0;
  logs: ViteLogEntry[] = [];
  readonly harnessUrlPath: string;
  readonly viteVersion = "7.3.6";
  readonly reactDomVersion = "19.3.0";
  readonly tailwindMajor: 3 | 4 | null = 4;

  constructor(
    readonly side: RenderSide,
    readonly groupKey: string,
    readonly origin: string,
    harnessUrlPath: string,
    readonly warnings: readonly string[] = [],
    private readonly events: string[] = []
  ) {
    this.harnessUrlPath = harnessUrlPath;
  }

  isAlive(): boolean {
    return this.alive;
  }
  exitReason(): string | null {
    return this.alive ? null : "exited with code 1 (signal null)";
  }
  currentSeq(): number {
    return this.logs.length;
  }
  logsSince(seq: number, level?: "warn" | "error"): ViteLogEntry[] {
    return this.logs.filter((entry) => entry.seq > seq && (level === undefined || entry.level === level));
  }
  sawDepsReoptimizeSince(): boolean {
    return false;
  }
  stop(): Promise<void> {
    if (this.stopCalls === 0) {
      this.events.push(`stop:${this.side}:${this.groupKey}`);
    }
    this.stopCalls += 1;
    this.alive = false;
    return Promise.resolve();
  }
}

export type HostScript = (options: ViteHostStartOptions, startIndex: number) => "ready" | ViteHostStartError;

/** Records start options; returns ready hosts unless `script` returns a ViteHostStartError. */
export class FakeViteHostFactory {
  readonly started: ViteHostStartOptions[] = [];
  readonly hosts: FakeViteHost[] = [];
  readonly events: string[] = [];
  private port = 41000;

  constructor(
    private readonly script: HostScript = () => "ready",
    private readonly warnings: readonly string[] = []
  ) {}

  readonly start = (
    options: ViteHostStartOptions,
    harnessUrlPath: string,
    signal: AbortSignal
  ): Promise<ViteHostHandle> => {
    const index = this.started.length;
    this.started.push(options);
    this.events.push(`start:${options.side}:${options.groupKey}`);
    if (signal.aborted) {
      return Promise.reject(new ViteHostStartError("Cancelled", "aborted", null));
    }
    const outcome = this.script(options, index);
    if (outcome instanceof ViteHostStartError) {
      return Promise.reject(outcome);
    }
    this.port += 1;
    const host = new FakeViteHost(
      options.side,
      options.groupKey,
      `http://127.0.0.1:${String(this.port)}`,
      harnessUrlPath,
      this.warnings,
      this.events
    );
    this.hosts.push(host);
    return Promise.resolve(host);
  };

  liveCount(): number {
    return this.hosts.filter((host) => host.alive).length;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Browser session
// ---------------------------------------------------------------------------------------------------------------

export type ScriptedOutcome =
  | { ok: true; width?: number; height?: number; mode?: "content" | "viewport" | "empty"; stable?: boolean }
  | { ok: false; kind: RenderFailureKind; error?: string; infraRetryable?: boolean };

export interface RecordedRender {
  componentId: number;
  side: RenderSide;
  /** 16 §7.6.3: the state the page was asked for. */
  stateName: string;
  attempt: number;
  timeoutMs: number;
  origin: string;
  outputPath: string;
  checkStylesheets: PageRenderInput["checkStylesheets"];
}

/**
 * Outcome key: `${componentId}:${side}:${attempt}`; a key without the attempt (`${componentId}:${side}`) matches any.
 * 16e: `${componentId}:${side}@${stateName}` (optionally `:${attempt}`) scripts one state only and wins.
 */
export class FakeBrowserSession implements RenderBrowserSession {
  readonly renders: RecordedRender[] = [];
  connected = true;
  /** Pages currently rendering and the most seen at once (16 §9.2 concurrency). */
  inFlight = 0;
  maxInFlight = 0;
  /** Milliseconds every render waits (lets concurrency show). */
  delayMs = 0;
  closeCalls = 0;
  closeAllContextsCalls = 0;
  /** Called before an outcome is returned (e.g. to abort mid-render). Awaited. */
  beforeOutcome: ((input: PageRenderInput, record: RecordedRender) => Promise<void> | void) | null = null;
  private readonly calls = new Map<string, number>();

  constructor(private readonly outcomes: Record<string, ScriptedOutcome | ScriptedOutcome[]> = {}) {}

  isConnected(): boolean {
    return this.connected;
  }

  async renderComponent(input: PageRenderInput): Promise<PageRenderOutcome> {
    const attemptMatch = /\.attempt(\d+)\.png$/.exec(input.outputPath);
    const attempt = attemptMatch ? Number(attemptMatch[1]) : 0;
    const record: RecordedRender = {
      componentId: input.componentId,
      side: input.host.side,
      stateName: input.stateName,
      attempt,
      timeoutMs: input.timeoutMs,
      origin: input.host.origin,
      outputPath: input.outputPath,
      checkStylesheets: input.checkStylesheets
    };
    this.renders.push(record);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.beforeOutcome) {
        await this.beforeOutcome(input, record);
      }
      return this.outcomeFor(input, attempt);
    } finally {
      this.inFlight -= 1;
    }
  }

  private outcomeFor(input: PageRenderInput, attempt: number): PageRenderOutcome {
    if (input.signal.aborted) {
      return {
        ok: false,
        kind: "cancelled",
        error: "[cancelled] Cancelled.",
        consoleErrors: [],
        durationMs: 1,
        infraRetryable: false
      };
    }
    const sideKey = `${String(input.componentId)}:${input.host.side}`;
    const stateKey = `${sideKey}@${input.stateName}`;
    const scripted = this.pick(`${stateKey}:${String(attempt)}`) ??
      this.pick(stateKey) ??
      this.pick(`${sideKey}:${String(attempt)}`) ??
      this.pick(sideKey) ?? { ok: true };
    if (scripted.ok) {
      fs.writeFileSync(input.outputPath, TINY_PNG);
      return {
        ok: true,
        width: scripted.width ?? 100,
        height: scripted.height ?? 40,
        mode: scripted.mode ?? "content",
        stable: scripted.stable ?? true,
        truncated: false,
        consoleErrors: [],
        durationMs: 5,
        blockedRequests: 0,
        stylesheetWarning: null,
        stateNames: [input.stateName],
        stepsRun: 0
      };
    }
    if (scripted.kind === "browser") {
      this.connected = false;
    }
    return {
      ok: false,
      kind: scripted.kind,
      error: scripted.error ?? `[${scripted.kind}] scripted ${scripted.kind} failure`,
      consoleErrors: [],
      durationMs: 5,
      infraRetryable: scripted.infraRetryable ?? false
    };
  }

  private pick(key: string): ScriptedOutcome | undefined {
    const entry = this.outcomes[key];
    if (entry === undefined) {
      return undefined;
    }
    if (!Array.isArray(entry)) {
      return entry;
    }
    const index = this.calls.get(key) ?? 0;
    this.calls.set(key, index + 1);
    return entry[Math.min(index, entry.length - 1)];
  }

  closeAllContexts(): Promise<void> {
    this.closeAllContextsCalls += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.connected = false;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Persistence and artifacts
// ---------------------------------------------------------------------------------------------------------------

export class InMemoryPersistence implements ComponentRenderPersistence {
  readonly saves: Array<{ componentId: number; payload: ComponentRenderPayload }> = [];
  failWith: Error | null = null;

  saveRenderResult(componentId: number, payload: ComponentRenderPayload): Promise<void> {
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    this.saves.push({ componentId, payload: structuredClone(payload) });
    return Promise.resolve();
  }

  /** Last payload saved for a component. */
  latest(componentId: number): ComponentRenderPayload | undefined {
    return [...this.saves].reverse().find((save) => save.componentId === componentId)?.payload;
  }
}

export class FakeArtifactStore implements RenderArtifactStore {
  constructor(readonly dataDir: string) {}

  imagePaths(
    visualizationId: number,
    componentId: number,
    kind: RenderSide
  ): { absolutePath: string; relativePath: string } {
    const relativePath = `artifacts/${String(visualizationId)}/${String(componentId)}/${kind}.png`;
    return { relativePath, absolutePath: path.join(this.dataDir, relativePath) };
  }

  ensureComponentDir(visualizationId: number, componentId: number): Promise<void> {
    fs.mkdirSync(path.join(this.dataDir, "artifacts", String(visualizationId), String(componentId)), {
      recursive: true
    });
    return Promise.resolve();
  }

  stateImagePaths(
    visualizationId: number,
    componentId: number,
    ordinal: number,
    kind: RenderSide
  ): { absolutePath: string; relativePath: string } {
    const folder = ordinal === 0 ? "" : `s${String(ordinal)}/`;
    const relativePath = `artifacts/${String(visualizationId)}/${String(componentId)}/${folder}${kind}.png`;
    return { relativePath, absolutePath: path.join(this.dataDir, relativePath) };
  }

  ensureComponentStateDir(visualizationId: number, componentId: number, ordinal: number): Promise<void> {
    const dir = path.join(this.dataDir, "artifacts", String(visualizationId), String(componentId));
    fs.mkdirSync(ordinal === 0 ? dir : path.join(dir, `s${String(ordinal)}`), { recursive: true });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Context, worktrees and inputs
// ---------------------------------------------------------------------------------------------------------------

export interface FakeRenderEnv {
  handle: PipelineContextHandle;
  dataDir: string;
  baseDir: string;
  headDir: string;
  templatesDir: string;
}

/** Writes the React template files and the shared step runtime (contents irrelevant for stubs) into `dir`. */
export function writeFakeTemplates(dir: string): void {
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  for (const file of ["index.html", "entry.tsx", "error-boundary.tsx", "harness-api.ts"]) {
    fs.writeFileSync(path.join(dir, file), `// ${file}\n`);
  }
  fs.writeFileSync(path.join(dir, "shared", "prvision-steps.ts"), "// prvision-steps.ts\n");
}

/** A PipelineContext over two temp worktrees (`base`, `head`) with `src/index.css`, plus a temp data dir. */
export function fakePipelineContext(
  t: TestContext,
  options: {
    files?: Record<string, { base?: string; head?: string }>;
    dependencyDrift?: boolean;
    globalStylePaths?: string[];
  } = {}
): FakeRenderEnv {
  const temp = makeTempDir("render");
  t.after(() => {
    temp.cleanup();
  });
  const dataDir = path.join(temp.path, "data");
  const baseDir = path.join(temp.path, "worktrees", "base");
  const headDir = path.join(temp.path, "worktrees", "head");
  const templatesDir = path.join(temp.path, "templates");
  writeFakeTemplates(templatesDir);
  for (const dir of [dataDir, baseDir, headDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const dir of [baseDir, headDir]) {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "index.css"), "body { margin: 0; }\n");
  }
  for (const [file, sides] of Object.entries(options.files ?? {})) {
    for (const [side, content] of Object.entries(sides)) {
      const target = path.join(side === "base" ? baseDir : headDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  const handle = createPipelineContext({
    dataDir,
    repositoryPath: path.join(temp.path, "clone"),
    baseDir,
    headDir,
    workspace: { dependencyDrift: options.dependencyDrift ?? false },
    repository: { viteConfigPath: null, globalStylePaths: options.globalStylePaths ?? ["/src/index.css"] }
  });
  return { handle, dataDir, baseDir, headDir, templatesDir };
}

export function candidate(
  componentId: number,
  filePath: string,
  changeKind: ComponentCandidate["changeKind"] = "modified",
  rank = componentId
): ComponentCandidate {
  const displayName = path.posix.basename(filePath).replace(/\.[jt]sx?$/, "");
  return {
    componentId,
    filePath,
    exportName: "default",
    displayName,
    changeKind,
    rank,
    codeDiff: null,
    reason: "Component code changed"
  };
}

export function harnessFor(
  componentId: number,
  filePath: string,
  mocks: MockedModule[] = [],
  notes = "Initial notes."
): HarnessGenerationResult {
  const target = path.posix.relative(".prvision-harness/components", filePath.replace(/\.[jt]sx?$/, ""));
  return {
    componentId,
    harnessSource: `import { definePrvisionHarness } from "../harness-api";\nimport Target from "${target}";\nexport default definePrvisionHarness({ states: [{ name: "Default", render: () => <Target /> }] });\n`,
    mockedModules: mocks,
    notes,
    states: [{ name: "Default", steps: [] }],
    origin: "written",
    libraryEntryId: null
  };
}

export function renderInput(
  componentId: number,
  filePath: string,
  options: {
    changeKind?: ComponentCandidate["changeKind"];
    basePath?: string | null;
    mocks?: MockedModule[];
    rank?: number;
    /** 16e: the harness's states (default: Default only) and where it came from. */
    states?: HarnessGenerationResult["states"];
    origin?: HarnessGenerationResult["origin"];
  } = {}
): RenderComponentInput {
  const changeKind = options.changeKind ?? "modified";
  const harness = harnessFor(componentId, filePath, options.mocks ?? []);
  return {
    candidate: candidate(componentId, filePath, changeKind, options.rank ?? componentId),
    harness: {
      ...harness,
      ...(options.states !== undefined ? { states: options.states } : {}),
      ...(options.origin !== undefined ? { origin: options.origin } : {})
    },
    basePath: options.basePath !== undefined ? options.basePath : changeKind === "added" ? null : filePath
  };
}
