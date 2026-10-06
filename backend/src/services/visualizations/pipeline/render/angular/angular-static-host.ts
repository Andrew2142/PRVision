/**
 * In-process static HTTP server for one Angular build output (15 §5.7.9). Serves only realpath-confined regular
 * files under the build's dist folder, GET/HEAD only, on 127.0.0.1 and an ephemeral port. The handle is
 * structurally compatible with `PageRenderInput.host`, so 10's `BrowserSession` renders through it unchanged
 * (same-origin requests `continue` here; everything else follows `decideRoute`).
 */
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ANGULAR_STATIC_HOST } from "../../../../../config-consts";
import { createLogger, isPathInside } from "../../../../../utilities";
import type { RenderSide, ViteHostLogLevel, ViteLogEntry } from "../render-types";

const log = createLogger("render");

/** Build warnings forwarded once per side (15 §5.7.9). */
export const STATIC_HOST_WARNINGS_MAX = 10;
const LOG_BUFFER_MAX = 500;

export const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf"
};

/** MIME type of a served file by extension (`application/octet-stream` when unknown). */
export function mimeTypeFor(file: string): string {
  return STATIC_MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export interface AngularStaticHostHandle {
  readonly side: RenderSide;
  readonly groupKey: string;
  readonly origin: string; // "http://127.0.0.1:<port>"
  readonly harnessUrlPath: "/index.html";
  readonly tailwindMajor: 3 | 4 | null;
  readonly warnings: readonly string[];
  isAlive(): boolean;
  exitReason(): string | null;
  currentSeq(): number;
  logsSince(seq: number, level?: "warn" | "error"): ViteLogEntry[];
  sawDepsReoptimizeSince(seq: number): false;
  stop(): Promise<void>;
}

export interface AngularStaticHostOptions {
  side: RenderSide;
  groupKey: string;
  /** Absolute build output folder. */
  distDir: string;
  /** Builder log lines of the build (kept as the first log entries). */
  buildLogs?: ReadonlyArray<{ level: ViteHostLogLevel; message: string }>;
  /** Installed Tailwind major (stylesheet health check), or null. */
  tailwindMajor?: 3 | 4 | null;
  /** Build warnings (at most STATIC_HOST_WARNINGS_MAX are kept). */
  warnings?: readonly string[];
  /** Interface to bind (tests); default ANGULAR_STATIC_HOST. */
  hostname?: string;
}

class LiveStaticHost implements AngularStaticHostHandle {
  readonly harnessUrlPath = "/index.html" as const;
  readonly side: RenderSide;
  readonly groupKey: string;
  readonly tailwindMajor: 3 | 4 | null;
  readonly warnings: readonly string[];
  private readonly entries: ViteLogEntry[] = [];
  private seq = 0;
  private alive = true;
  private stopReason: string | null = null;
  private stopping: Promise<void> | null = null;
  origin = "";

  constructor(
    private readonly server: http.Server,
    private readonly realDist: string,
    options: AngularStaticHostOptions
  ) {
    this.side = options.side;
    this.groupKey = options.groupKey;
    this.tailwindMajor = options.tailwindMajor ?? null;
    this.warnings = (options.warnings ?? []).slice(0, STATIC_HOST_WARNINGS_MAX);
    for (const entry of options.buildLogs ?? []) {
      this.push(entry.level, entry.message);
    }
    server.on("close", () => {
      this.alive = false;
      this.stopReason ??= "closed";
    });
  }

  push(level: ViteHostLogLevel, message: string): void {
    this.seq += 1;
    this.entries.push({ seq: this.seq, level, message, at: Date.now() });
    if (this.entries.length > LOG_BUFFER_MAX) {
      this.entries.shift();
    }
  }

  isAlive(): boolean {
    return this.alive && this.server.listening;
  }

  exitReason(): string | null {
    return this.isAlive() ? null : (this.stopReason ?? "not listening");
  }

  currentSeq(): number {
    return this.seq;
  }

  logsSince(seq: number, level?: "warn" | "error"): ViteLogEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.seq > seq &&
        (level === undefined || entry.level === "error" || (level === "warn" && entry.level === "warn"))
    );
  }

  sawDepsReoptimizeSince(): false {
    return false;
  }

  stop(): Promise<void> {
    this.stopping ??= new Promise<void>((resolve) => {
      this.stopReason = "stopped";
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
    return this.stopping;
  }

  async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      this.notFound(response, request.url ?? "");
      return;
    }
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }
    const file = await this.resolveFile(pathname);
    if (file === null) {
      this.notFound(response, pathname);
      return;
    }
    let body: Buffer;
    try {
      body = await fs.readFile(file);
    } catch {
      this.notFound(response, pathname);
      return;
    }
    response.writeHead(200, { "Content-Type": mimeTypeFor(file), "Content-Length": String(body.length) });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  private async resolveFile(pathname: string): Promise<string | null> {
    if (pathname.includes("\0")) {
      return null;
    }
    const candidate = path.resolve(this.realDist, `.${pathname}`);
    if (!isPathInside(this.realDist, candidate)) {
      return null;
    }
    try {
      const real = await fs.realpath(candidate);
      if (!isPathInside(this.realDist, real)) {
        return null;
      }
      const stat = await fs.stat(real);
      return stat.isFile() ? real : null;
    } catch {
      return null;
    }
  }

  private notFound(response: http.ServerResponse, pathname: string): void {
    this.push("warn", `${pathname.slice(0, 200)}: HTTP 404`);
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

/** Starts static hosts for Angular build outputs. */
export class AngularStaticHost {
  /**
   * Serves `distDir` on 127.0.0.1 and an ephemeral port.
   *
   * @throws Error when the folder does not exist or the server cannot listen.
   */
  static async start(options: AngularStaticHostOptions): Promise<AngularStaticHostHandle> {
    const realDist = await fs.realpath(options.distDir);
    if (!(await fs.stat(realDist)).isDirectory()) {
      throw new Error(`Build output ${options.distDir} is not a directory`);
    }
    const server = http.createServer();
    const host = new LiveStaticHost(server, realDist, options);
    server.on("request", (request: http.IncomingMessage, response: http.ServerResponse) => {
      host.handle(request, response).catch((error: unknown) => {
        log.warn({ event: "render.angular.static_host", side: options.side, err: error }, "Static host request failed");
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, options.hostname ?? ANGULAR_STATIC_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    host.origin = `http://${options.hostname ?? ANGULAR_STATIC_HOST}:${String(address.port)}`;
    log.debug(
      { event: "render.angular.static_host", side: options.side, groupKey: options.groupKey, port: address.port },
      "Static host listening"
    );
    return host;
  }
}
