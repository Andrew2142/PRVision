import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

/** Listens on 127.0.0.1:0, returns baseUrl ("http://127.0.0.1:<port>") and close(). Use global fetch. */
export async function startTestServer(
  app: Express
): Promise<{ baseUrl: string; port: number; close(): Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  };
}

/** Raw request with full header control (fetch cannot override Host). */
export async function rawRequest(
  baseUrl: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(options.path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end(options.body);
  });
}
