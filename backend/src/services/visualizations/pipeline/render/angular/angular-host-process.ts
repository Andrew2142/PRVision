/**
 * Angular host child-process entry (15 §5.7.7). Forked by `AngularHostClient` with `cwd = <side>/<appRoot>` in
 * its own process group. Loads the TARGET repository's own `@angular-devkit/architect` and `@angular-devkit/core`,
 * reports `ready` (or `fatal`), then runs one build per `build` request: the side's `angular.json` is read, an
 * in-memory project `prvision-harness` (cloned from the app project, with the options computed by the parent) is
 * added and built with the repository's builder. `angular.json` is never written. Builds are sequential.
 *
 * Imports only node built-ins, the protocol file and the pure guards of render-types. Never the DB, Redis, the
 * logger or the config-consts barrel.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describeError, isRecord } from "../render-types";
import {
  ANGULAR_HOST_LOG_MAX_CHARS,
  isAngularHostRequest,
  type AngularHostEvent,
  type AngularHostLogLevel,
  type AngularHostRequest,
  type AngularHostVersions
} from "./angular-host-protocol";

const HARNESS_PROJECT_NAME = "prvision-harness";
// eslint-disable-next-line no-control-regex -- strips ANSI colour escapes from builder log lines
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Structural slices of the Architect and core APIs the child uses (no Angular typings in PRVision). */
interface ArchitectRunLike {
  lastOutput: Promise<{ success: boolean; error?: string }>;
  stop(): Promise<void>;
}
interface ArchitectLike {
  scheduleTarget(
    target: { project: string; target: string },
    overrides: Record<string, unknown>,
    options: { logger: unknown }
  ): Promise<ArchitectRunLike>;
}
interface ProjectDefinitionLike {
  root: string;
  sourceRoot?: string;
  prefix?: string;
}
interface WorkspaceLike {
  projects: {
    get(name: string): ProjectDefinitionLike | undefined;
    has(name: string): boolean;
    add(definition: Record<string, unknown>): unknown;
  };
}
interface LoggerEntryLike {
  level: string;
  message: string;
}
interface LoadedToolchain {
  Architect: new (host: unknown, registry: unknown) => ArchitectLike;
  WorkspaceNodeModulesArchitectHost: new (workspace: WorkspaceLike, root: string) => unknown;
  readWorkspace: (file: string, host: unknown) => Promise<{ workspace: WorkspaceLike }>;
  createWorkspaceHost: (host: unknown) => unknown;
  NodeJsSyncHost: new () => unknown;
  CoreSchemaRegistry: new () => {
    addPostTransform(transform: unknown): void;
    useXDeprecatedProvider(fn: () => undefined): void;
  };
  addUndefinedDefaults: unknown;
  Logger: new (name: string) => { subscribe(fn: (entry: LoggerEntryLike) => void): unknown };
}

const cwd = process.cwd();
let toolchain: LoadedToolchain | null = null;
const pending: Array<Extract<AngularHostRequest, { type: "build" }>> = [];
let draining = false;

function send(event: AngularHostEvent): void {
  if (process.connected && process.send) {
    try {
      process.send(event);
    } catch {
      // The parent is gone; nothing to report to.
    }
  }
}

function capLog(text: string): string {
  const clean = text.replace(ANSI_PATTERN, "");
  return clean.length > ANGULAR_HOST_LOG_MAX_CHARS ? `${clean.slice(0, ANGULAR_HOST_LOG_MAX_CHARS)}…` : clean;
}

function log(buildId: string, level: AngularHostLogLevel, message: string): void {
  send({ type: "log", buildId, level, message: capLog(message) });
}

function prop(value: unknown, key: string): unknown {
  return isRecord(value) || typeof value === "function" ? (value as Record<string, unknown>)[key] : undefined;
}

function requireFunction(module: unknown, key: string, moduleName: string): unknown {
  const value = prop(module, key);
  if (typeof value !== "function") {
    throw new Error(`${moduleName} does not export ${key}`);
  }
  return value;
}

/** Version of an installed package, or null (package.json not resolvable through its exports). */
function installedVersion(req: NodeJS.Require, name: string): string | null {
  try {
    const pkg: unknown = req(`${name}/package.json`);
    const version = prop(pkg, "version");
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function loadToolchain(): { toolchain: LoadedToolchain; versions: AngularHostVersions } {
  const req = createRequire(path.join(cwd, "package.json"));
  const load = (name: string): unknown => {
    try {
      return req(name) as unknown;
    } catch (error) {
      throw new Error(`${name} (${describeError(error).split("\n")[0] ?? ""})`, { cause: error });
    }
  };
  const architect = load("@angular-devkit/architect");
  const architectNode = load("@angular-devkit/architect/node");
  const core = load("@angular-devkit/core");
  const coreNode = load("@angular-devkit/core/node");
  const workspaces = prop(core, "workspaces");
  const json = prop(core, "json");
  const schema = prop(json, "schema");
  const transforms = prop(schema, "transforms");
  const logging = prop(core, "logging");
  const loaded: LoadedToolchain = {
    Architect: requireFunction(architect, "Architect", "@angular-devkit/architect") as LoadedToolchain["Architect"],
    WorkspaceNodeModulesArchitectHost: requireFunction(
      architectNode,
      "WorkspaceNodeModulesArchitectHost",
      "@angular-devkit/architect/node"
    ) as LoadedToolchain["WorkspaceNodeModulesArchitectHost"],
    readWorkspace: requireFunction(
      workspaces,
      "readWorkspace",
      "@angular-devkit/core"
    ) as LoadedToolchain["readWorkspace"],
    createWorkspaceHost: requireFunction(
      workspaces,
      "createWorkspaceHost",
      "@angular-devkit/core"
    ) as LoadedToolchain["createWorkspaceHost"],
    NodeJsSyncHost: requireFunction(
      coreNode,
      "NodeJsSyncHost",
      "@angular-devkit/core/node"
    ) as LoadedToolchain["NodeJsSyncHost"],
    CoreSchemaRegistry: requireFunction(
      schema,
      "CoreSchemaRegistry",
      "@angular-devkit/core"
    ) as LoadedToolchain["CoreSchemaRegistry"],
    addUndefinedDefaults: prop(transforms, "addUndefinedDefaults"),
    Logger: requireFunction(logging, "Logger", "@angular-devkit/core") as LoadedToolchain["Logger"]
  };
  const versions: AngularHostVersions = {
    core: installedVersion(req, "@angular/core"),
    build: installedVersion(req, "@angular/build") ?? installedVersion(req, "@angular-devkit/build-angular"),
    architect: installedVersion(req, "@angular-devkit/architect")
  };
  return { toolchain: loaded, versions };
}

function mapLevel(level: string): AngularHostLogLevel | null {
  switch (level) {
    case "warn":
      return "warn";
    case "error":
    case "fatal":
      return "error";
    case "info":
      return "info";
    default:
      return null; // debug: not forwarded
  }
}

function freeProjectName(workspace: WorkspaceLike): string {
  let name = HARNESS_PROJECT_NAME;
  for (let n = 1; workspace.projects.has(name); n += 1) {
    name = `${HARNESS_PROJECT_NAME}-${String(n)}`;
  }
  return name;
}

function outputBaseOf(options: Record<string, unknown>): string | null {
  const outputPath = options.outputPath;
  if (typeof outputPath === "string") {
    return path.resolve(cwd, outputPath);
  }
  const base = prop(outputPath, "base");
  return typeof base === "string" ? path.resolve(cwd, base) : null;
}

async function runBuild(
  tools: LoadedToolchain,
  request: Extract<AngularHostRequest, { type: "build" }>
): Promise<void> {
  const startedAt = Date.now();
  const { buildId } = request;
  try {
    const host = tools.createWorkspaceHost(new tools.NodeJsSyncHost());
    const { workspace } = await tools.readWorkspace(path.join(cwd, "angular.json"), host);
    const project = workspace.projects.get(request.projectName);
    if (project === undefined) {
      log(buildId, "error", `Project ${request.projectName} not found in angular.json.`);
      send({ type: "result", buildId, success: false, durationMs: Date.now() - startedAt, outputDir: null });
      return;
    }
    const harnessProject = freeProjectName(workspace);
    workspace.projects.add({
      name: harnessProject,
      root: project.root,
      sourceRoot: project.sourceRoot,
      prefix: project.prefix,
      ...request.projectExtensions,
      targets: { build: { builder: request.builderName, options: request.options } }
    });
    const registry = new tools.CoreSchemaRegistry();
    registry.addPostTransform(tools.addUndefinedDefaults);
    registry.useXDeprecatedProvider(() => undefined);
    const architect = new tools.Architect(new tools.WorkspaceNodeModulesArchitectHost(workspace, cwd), registry);
    const logger = new tools.Logger("ng");
    logger.subscribe((entry) => {
      const level = mapLevel(entry.level);
      if (level !== null) {
        log(buildId, level, entry.message);
      }
    });
    const run = await architect.scheduleTarget({ project: harnessProject, target: "build" }, {}, { logger });
    const output = await run.lastOutput;
    await run.stop();
    if (!output.success && typeof output.error === "string" && output.error !== "") {
      log(buildId, "error", output.error);
    }
    send({
      type: "result",
      buildId,
      success: output.success,
      durationMs: Date.now() - startedAt,
      outputDir: output.success ? outputBaseOf(request.options) : null
    });
  } catch (error) {
    log(buildId, "error", describeError(error));
    send({ type: "result", buildId, success: false, durationMs: Date.now() - startedAt, outputDir: null });
  }
}

process.on("message", (raw: unknown) => {
  if (!isAngularHostRequest(raw)) {
    return;
  }
  if (raw.type === "shutdown") {
    process.exit(0);
  }
  const tools = toolchain;
  if (tools === null) {
    return;
  }
  pending.push(raw);
  drain(tools).catch((error: unknown) => {
    send({ type: "fatal", message: describeError(error) });
  });
});

/** Runs queued builds one at a time (runBuild never rejects). */
async function drain(tools: LoadedToolchain): Promise<void> {
  if (draining) {
    return;
  }
  draining = true;
  try {
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      await runBuild(tools, next);
    }
  } finally {
    draining = false;
  }
}

process.on("disconnect", () => {
  process.exit(0);
});

try {
  const loaded = loadToolchain();
  toolchain = loaded.toolchain;
  send({ type: "ready", versions: loaded.versions });
} catch (error) {
  send({ type: "fatal", message: describeError(error) });
  setTimeout(() => process.exit(1), 100).unref();
}
