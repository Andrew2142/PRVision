/**
 * Vite host child-process entry (10 §5.6.3). Forked by `ViteHostClient` with `cwd = viteRoot` in its own process
 * group; receives one `start` message, loads the repository's own Vite, builds the inline config, starts the dev
 * server on a probed free port and reports `ready` (or `start_failed`). Logs go over IPC; `shutdown` or a
 * disconnected parent closes the server and exits.
 *
 * Imports only: node built-ins, render-types, esm-import (via vite-loader), vite-loader, vite-server-config,
 * vite-harness-plugin, vite-mock-plugin, mock-rules and config-consts/render.config.ts (directly). Never the DB,
 * Redis, the logger, AuthContext or the config-consts barrel.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMockPlugin } from "../vite-mock-plugin";
import {
  describeError,
  isRecord,
  isViteHostRequest,
  stackOf,
  type UnknownRecord,
  type ViteDevServerLike,
  type ViteHostEvent,
  type ViteHostStartFailureKind,
  type ViteHostStartOptions,
  type ViteLoggerLike,
  type ViteModuleLike,
  type VitePluginLike
} from "./render-types";
import { createHarnessPlugin } from "./vite-harness-plugin";
import { loadTargetVite, ViteLoadError } from "./vite-loader";
import {
  buildViteInlineConfig,
  detectConfigFile,
  filterUserPlugins,
  flattenUserPlugins,
  PLUGIN_DENYLIST_PREFIXES
} from "./vite-server-config";

const SHUTDOWN_WATCHDOG_MS = 5_000;
const SERVER_CLOSE_WAIT_MS = 4_000;
// eslint-disable-next-line no-control-regex -- strips ANSI colour escapes from Vite log lines
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

let server: ViteDevServerLike | null = null;
let shuttingDown = false;
let started = false;

class HostStartFailure extends Error {
  constructor(
    message: string,
    readonly kind: ViteHostStartFailureKind,
    readonly detail: string | null = null
  ) {
    super(message);
  }
}

function send(event: ViteHostEvent): void {
  if (process.connected && process.send) {
    try {
      process.send(event);
    } catch {
      // The parent is gone; nothing to report to.
    }
  }
}

function log(level: "info" | "warn" | "error", message: string): void {
  send({ type: "log", level, message: message.replace(ANSI_PATTERN, ""), at: Date.now() });
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const watchdog = setTimeout(() => {
    process.exit(code || 1);
  }, SHUTDOWN_WATCHDOG_MS);
  watchdog.unref();
  const current = server;
  if (current !== null) {
    try {
      await Promise.race([current.close(), delay(SERVER_CLOSE_WAIT_MS, undefined, { ref: false })]);
    } catch (error) {
      log("warn", `Vite server close failed: ${describeError(error)}`);
    }
  }
  send({ type: "closed" });
  // process.exit (not draining the event loop) is deliberate: user plugins may leave handles open.
  process.exit(code);
}

/** Fire-and-forget shutdown for event handlers; a failure still ends the process. */
function requestShutdown(code: number): void {
  shutdown(code).catch(() => {
    process.exit(1);
  });
}

function createForwardingLogger(vite: ViteModuleLike): ViteLoggerLike {
  const base = vite.createLogger("info", { allowClearScreen: false });
  const warned = new Set<string>();
  const errorText = (message: string, options?: UnknownRecord): string => {
    const error = options?.error;
    const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : null;
    return stack !== null && !message.includes(stack) ? `${message}\n${stack}` : message;
  };
  const logger: ViteLoggerLike = {
    info(message: string): void {
      log("info", message);
    },
    warn(message: string): void {
      logger.hasWarned = true;
      log("warn", message);
    },
    warnOnce(message: string): void {
      if (warned.has(message)) {
        return;
      }
      warned.add(message);
      logger.hasWarned = true;
      log("warn", message);
    },
    error(message: string, options?: UnknownRecord): void {
      log("error", errorText(message, options));
    },
    clearScreen(): void {
      // Never clear anything: output goes over IPC.
    },
    hasErrorLogged(error: unknown): boolean {
      return base.hasErrorLogged(error);
    },
    hasWarned: false
  };
  return logger;
}

function readPackageVersion(requireFromRoot: NodeJS.Require, name: string): string | null {
  try {
    const pkgPath = requireFromRoot.resolve(`${name}/package.json`);
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function majorMinor(version: string): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return {
    major: match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10),
    minor: match?.[2] === undefined ? 0 : Number.parseInt(match[2], 10)
  };
}

function realpathIfExists(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Probes a free port on 127.0.0.1 (Vite maps a falsy configured port to 5173, so port 0 cannot be used). */
async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(new Error("Could not probe a free port"));
        }
      });
    });
  });
}

async function transpileMock(vite: ViteModuleLike, code: string, filename: string): Promise<string> {
  if (vite.transformWithEsbuild) {
    const out = await vite.transformWithEsbuild(code, filename, {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
      sourcemap: false,
      target: "es2020"
    });
    return out.code;
  }
  if (vite.transformWithOxc) {
    const out = await vite.transformWithOxc(code, filename, { lang: "tsx", jsx: { runtime: "automatic" } });
    return out.code;
  }
  throw new Error("This Vite version exposes no TypeScript transform; mocks cannot be compiled.");
}

function resolveOrigin(current: ViteDevServerLike): string {
  const address = current.httpServer?.address() ?? null;
  if (typeof address === "object" && address !== null) {
    return `http://127.0.0.1:${String(address.port)}`;
  }
  const local = current.resolvedUrls?.local[0];
  if (local !== undefined && local !== "") {
    return local.replace(/\/+$/, "");
  }
  throw new HostStartFailure("Vite did not report a listening address", "listen_error");
}

function postcssMentionsTailwind(viteRoot: string): boolean {
  for (const name of [
    "postcss.config.js",
    "postcss.config.cjs",
    "postcss.config.mjs",
    "postcss.config.ts",
    ".postcssrc",
    ".postcssrc.json"
  ]) {
    try {
      if (fs.readFileSync(path.join(viteRoot, name), "utf8").includes("@tailwindcss/postcss")) {
        return true;
      }
    } catch {
      // Not present.
    }
  }
  return false;
}

function tailwindWarnings(
  viteRoot: string,
  tailwindMajor: 3 | 4 | null,
  keptPlugins: readonly VitePluginLike[]
): string[] {
  if (tailwindMajor === 3) {
    const found = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts"].some(
      (name) => fs.existsSync(path.join(viteRoot, name))
    );
    return found ? [] : [`Tailwind v3 is installed but no tailwind.config was found in ${viteRoot}`];
  }
  if (tailwindMajor === 4) {
    const hasVitePlugin = keptPlugins.some((plugin) => plugin.name.startsWith("@tailwindcss/vite"));
    return hasVitePlugin || postcssMentionsTailwind(viteRoot)
      ? []
      : [
          "Tailwind v4 is installed but neither @tailwindcss/vite nor @tailwindcss/postcss is configured; utility classes may be missing"
        ];
  }
  return [];
}

async function startHost(options: ViteHostStartOptions): Promise<void> {
  const warnings: string[] = [];

  // 1. The repository's own Vite.
  let loaded;
  try {
    loaded = await loadTargetVite(options.viteRoot);
  } catch (error) {
    if (error instanceof ViteLoadError) {
      throw new HostStartFailure(error.message, error.kind, error.detail);
    }
    throw new HostStartFailure(describeError(error), "vite_load_failed", stackOf(error));
  }
  const vite = loaded.module;
  if (loaded.warning !== null) {
    log("warn", loaded.warning);
    warnings.push(loaded.warning);
  }

  // 2. React and Tailwind versions.
  const requireFromRoot = createRequire(path.join(options.viteRoot, "package.json"));
  const reactDomVersion = readPackageVersion(requireFromRoot, "react-dom");
  if (reactDomVersion === null) {
    throw new HostStartFailure("react-dom is not installed for this repository.", "react_missing");
  }
  const react = majorMinor(reactDomVersion);
  if (react.major < 16 || (react.major === 16 && react.minor < 8)) {
    throw new HostStartFailure(
      `React ${reactDomVersion} is not supported (React 16.8 or newer is required; 18+ recommended).`,
      "react_unsupported"
    );
  }
  const tailwindVersion = readPackageVersion(requireFromRoot, "tailwindcss");
  const tailwindMajorRaw = tailwindVersion === null ? null : majorMinor(tailwindVersion).major;
  const tailwindMajor: 3 | 4 | null = tailwindMajorRaw === 3 ? 3 : tailwindMajorRaw === 4 ? 4 : null;

  // 3. Logger forwarding over IPC.
  const logger = createForwardingLogger(vite);

  // 4. User config.
  const configFile = options.configFile ?? (await detectConfigFile(options.viteRoot));
  let userConfig: UnknownRecord = {};
  if (configFile !== null) {
    try {
      const result = await vite.loadConfigFromFile(
        { command: "serve", mode: "development", isSsrBuild: false, isPreview: false, ssrBuild: false },
        configFile,
        options.viteRoot,
        "silent"
      );
      userConfig = result?.config ?? {};
    } catch (error) {
      const firstLine = describeError(error).split("\n")[0] ?? "";
      throw new HostStartFailure(
        `Loading ${path.basename(configFile)} failed on the ${options.side} side: ${firstLine}`,
        "config_error",
        stackOf(error)
      );
    }
  }

  // 5. User plugins.
  let keptPlugins: VitePluginLike[];
  try {
    const { kept, dropped } = filterUserPlugins(await flattenUserPlugins(userConfig.plugins));
    keptPlugins = kept;
    // Build-only plugins (apply: "build") are inert in serve mode anyway; only report the denylisted dev tools.
    const devTools = dropped.filter((name) => PLUGIN_DENYLIST_PREFIXES.some((prefix) => name.startsWith(prefix)));
    if (devTools.length > 0) {
      warnings.push(`Removed dev-only Vite plugins on the ${options.side} side: ${devTools.join(", ")}.`);
    }
  } catch (error) {
    throw new HostStartFailure(
      `Loading the Vite plugins failed on the ${options.side} side: ${describeError(error)}`,
      "config_error",
      stackOf(error)
    );
  }
  warnings.push(...tailwindWarnings(options.viteRoot, tailwindMajor, keptPlugins));

  // 6. PRVision plugins.
  const mockPlugin = createMockPlugin({
    viteRoot: options.viteRoot,
    cacheDir: options.cacheDir,
    harnessDir: options.harnessDir,
    entries: options.mocks,
    transpile: (code, filename) => transpileMock(vite, code, filename),
    isInstalledPackage: (name) => fs.existsSync(path.join(options.viteRoot, "node_modules", name, "package.json")),
    warn: (message) => {
      log("warn", `[prvision-mock] ${message}`);
    }
  });
  const harnessPlugin = createHarnessPlugin({ reactDomMajor: react.major });

  // 7. Env defaults for referenced but undefined VITE_* keys.
  const envDir = path.resolve(options.viteRoot, typeof userConfig.envDir === "string" ? userConfig.envDir : ".");
  const prefixes =
    typeof userConfig.envPrefix === "string" || Array.isArray(userConfig.envPrefix)
      ? (userConfig.envPrefix as string | string[])
      : "VITE_";
  let loadedEnv: Record<string, string> = {};
  try {
    loadedEnv = vite.loadEnv("development", envDir, prefixes);
  } catch (error) {
    log("warn", `Loading .env files failed: ${describeError(error)}`);
  }
  const userDefine = isRecord(userConfig.define) ? userConfig.define : {};
  const envDefines: Record<string, string> = {};
  for (const key of options.referencedEnvKeys) {
    if (key in loadedEnv || `import.meta.env.${key}` in userDefine) {
      continue;
    }
    envDefines[`import.meta.env.${key}`] = JSON.stringify("");
  }

  // 7b. Free port.
  const port = await findFreePort();

  // 8. fs.allow.
  const fsAllow = [
    ...new Set(
      [
        options.viteRoot,
        options.worktreeDir,
        options.harnessDir,
        options.cacheDir,
        realpathIfExists(path.join(options.viteRoot, "node_modules")),
        realpathIfExists(path.join(options.worktreeDir, "node_modules")),
        vite.searchForWorkspaceRoot?.(options.viteRoot) ?? null
      ].filter((entry): entry is string => typeof entry === "string" && entry !== "")
    )
  ];

  // 9. Inline config.
  const built = buildViteInlineConfig({
    vite,
    viteMajor: loaded.major,
    viteMinor: loaded.minor,
    options,
    userConfig,
    userConfigFound: configFile !== null,
    userPlugins: keptPlugins,
    mockPlugin,
    harnessPlugin,
    logger,
    fsAllow,
    envDefines,
    reactDomMajor: react.major,
    port
  });
  warnings.push(...built.warnings);

  // 10. Server.
  let created: ViteDevServerLike;
  try {
    created = await vite.createServer(built.config);
  } catch (error) {
    throw new HostStartFailure(
      `Loading ${configFile === null ? "the Vite config" : path.basename(configFile)} failed on the ${options.side} side: ${
        describeError(error).split("\n")[0] ?? ""
      }`,
      "config_error",
      stackOf(error)
    );
  }
  server = created;

  // 11. Listen.
  try {
    await created.listen();
  } catch (error) {
    throw new HostStartFailure(
      `The Vite dev server could not start listening: ${describeError(error)}`,
      "listen_error",
      stackOf(error)
    );
  }

  // 12-13. Origin and ready.
  const origin = resolveOrigin(created);
  send({
    type: "ready",
    origin,
    viteVersion: loaded.version,
    reactDomVersion,
    tailwindMajor,
    configFile,
    warnings
  });
}

function start(options: ViteHostStartOptions): void {
  if (started) {
    return;
  }
  started = true;
  startHost(options).catch((error: unknown) => {
    const failure =
      error instanceof HostStartFailure ? error : new HostStartFailure(describeError(error), "unknown", stackOf(error));
    send({ type: "start_failed", kind: failure.kind, message: failure.message, detail: failure.detail });
    requestShutdown(1);
  });
}

process.on("message", (raw: unknown) => {
  if (!isViteHostRequest(raw)) {
    return;
  }
  if (raw.type === "start") {
    start(raw.options);
  } else {
    requestShutdown(0);
  }
});
process.on("disconnect", () => {
  requestShutdown(0); // parent died
});
process.on("unhandledRejection", (reason: unknown) => {
  log("error", `Unhandled rejection in Vite host: ${describeError(reason)}`);
});
process.on("uncaughtException", (error: Error) => {
  log("error", `Uncaught exception in Vite host: ${describeError(error)}`);
  if (server === null) {
    send({ type: "start_failed", kind: "unknown", message: describeError(error), detail: stackOf(error) });
    requestShutdown(1);
  }
});
