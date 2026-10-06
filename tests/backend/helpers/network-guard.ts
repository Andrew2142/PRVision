/**
 * Blocks outbound non-loopback traffic in tests (sheet 14 §5.4.2). Installed by setup.ts before any backend
 * module loads, so SDK clients that capture `fetch` at construction capture the guarded one.
 */
import http from "node:http";
import https from "node:https";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** "host", "host:port", "[::1]", "[::1]:port" → hostname. */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(":")[0] ?? host;
}

function hostOf(target: unknown): string | null {
  if (typeof target === "string") {
    return new URL(target).hostname;
  }
  if (target instanceof URL) {
    return target.hostname;
  }
  if (target && typeof target === "object") {
    const options = target as { hostname?: string | null; host?: string | null; url?: string };
    if (options.url) {
      return new URL(options.url).hostname;
    }
    if (options.hostname) {
      return options.hostname;
    }
    return options.host ? stripPort(options.host) : "localhost";
  }
  return null;
}

function assertAllowed(host: string | null, via: string): void {
  if (host === null || LOOPBACK_HOSTS.has(host)) {
    return;
  }
  throw new Error(`[network-guard] ${via} to "${host}" blocked in tests. Inject a fake client instead.`);
}

/** Blocks outbound non-loopback traffic unless the integration AI suite is explicitly enabled. */
export function installNetworkGuard(): void {
  // Only the real-AI integration files may reach the network, and only when the AI flag is on.
  // node:test runs each file in its own process with the file path in argv.
  const isAiIntegrationFile = process.argv.some((arg) => arg.replace(/\\/g, "/").includes("/integration/ai/"));
  if (isAiIntegrationFile && process.env.PRVISION_IT_AI === "1") {
    return;
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assertAllowed(hostOf(input instanceof Request ? input.url : input), "fetch");
    return realFetch(input, init);
  };

  for (const [name, mod] of [
    ["http", http],
    ["https", https]
  ] as const) {
    const realRequest = mod.request.bind(mod) as (...args: unknown[]) => unknown;
    const realGet = mod.get.bind(mod) as (...args: unknown[]) => unknown;
    (mod as { request: unknown }).request = (...args: unknown[]) => {
      assertAllowed(hostOf(args[0]), `${name}.request`);
      return realRequest(...args);
    };
    (mod as { get: unknown }).get = (...args: unknown[]) => {
      assertAllowed(hostOf(args[0]), `${name}.get`);
      return realGet(...args);
    };
  }
}
