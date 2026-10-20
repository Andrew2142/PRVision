import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRequestView } from "../dtos/agent-requests/agent-request-view.dto";

/**
 * The folder a headless run talks through (no server): the engine writes `status.json` and one
 * `requests/<id>/` folder per AI request; the prvision CLI drops `submit.json` or `fail.json` into a request
 * folder, and `continue.json` into the run folder, and the engine answers with `result.json`.
 *
 *   <run>/status.json               engine → CLI   current state of the run
 *   <run>/continue.json             CLI → engine   { "limit": n } for a run paused for confirmation
 *   <run>/requests/<id>/task.md     engine → agent the request in words
 *   <run>/requests/<id>/schema.json engine → agent the JSON schema of the answer
 *   <run>/requests/<id>/submit.json CLI → engine   the answer ("@file:" references already inlined)
 *   <run>/requests/<id>/fail.json   CLI → engine   { "message": "..." } when the agent gives up
 *   <run>/requests/<id>/result.json engine → CLI   { "accepted": true } or { "accepted": false, "errors": [...] }
 */

/** What `status.json` holds. `state` is the run's visualization status, or "error" when the engine itself failed. */
export interface RunStatusFile {
  state: string;
  title: string | null;
  visualizationId: number | null;
  componentCount: number;
  changedCount: number;
  /** Ids of requests written and not yet answered or failed. */
  openRequests: number[];
  message: string | null;
  /** The report folder once the run has ended. */
  reportDir: string | null;
  updatedAt: string;
}

export interface RequestResultFile {
  accepted: boolean;
  errors?: string[];
}

const PURPOSE_TEXT: Record<string, string> = {
  harness: "Write a render harness for one UI component.",
  harness_repair: "Fix a render harness that failed to render.",
  summary: "Write the review summary of the whole run and one note per component."
};

export class RunFolder {
  constructor(readonly root: string) {}

  get requestsDir(): string {
    return path.join(this.root, "requests");
  }

  get dataDir(): string {
    return path.join(this.root, "data");
  }

  requestDir(id: number): string {
    return path.join(this.requestsDir, String(id));
  }

  async init(): Promise<void> {
    await mkdir(this.requestsDir, { recursive: true, mode: 0o700 });
  }

  async writeStatus(status: Omit<RunStatusFile, "updatedAt">): Promise<void> {
    await writeJsonAtomic(path.join(this.root, "status.json"), { ...status, updatedAt: new Date().toISOString() });
  }

  /** Writes task.md and schema.json for a claimed request. `cli` is the command the agent submits with. */
  async writeRequest(
    request: AgentRequestView,
    context: { title: string; repository: string; cli: string }
  ): Promise<void> {
    const dir = this.requestDir(request.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "schema.json"), `${JSON.stringify(request.jsonSchema, null, 2)}\n`);
    const images =
      request.images.length === 0
        ? []
        : ["", "## Images", "", ...request.images.map((image) => `- ${image.label}: ${image.path}`)];
    const task = [
      `# PRVision AI request #${String(request.id)} (${request.purpose})`,
      "",
      PURPOSE_TEXT[request.purpose] ?? "Answer the request below.",
      "",
      `Run: ${context.title}. Repository: ${context.repository}`,
      "",
      "## How to answer",
      "",
      `1. The answer is one JSON object that matches ${path.join(dir, "schema.json")}. Write it to ${path.join(dir, "answer.json")}.`,
      '2. A string value that is exactly "@file:<path>" is replaced by that file\'s contents (path relative to this folder, or absolute). Put harness sources and mock module sources in their own files this way instead of escaping code inside JSON.',
      `3. Submit: ${context.cli} answer ${this.root} ${String(request.id)} ${path.join(dir, "answer.json")}`,
      "   If it prints validation errors, fix answer.json and submit again until it is accepted.",
      `   If the request cannot be answered: ${context.cli} fail ${this.root} ${String(request.id)} "<reason>"`,
      "4. You may read the repository for context. Do not modify it.",
      "5. The system instructions below are written for an API model. Follow their content rules; ignore anything about how to return output (the answer file above is the output).",
      ...images,
      "",
      "## System instructions",
      "",
      request.system,
      "",
      "## Request",
      "",
      request.prompt,
      ""
    ].join("\n");
    await writeFile(path.join(dir, "task.md"), task);
  }

  /** Request folders holding a submit.json or fail.json the engine has not processed yet. */
  async pendingSubmissions(): Promise<Array<{ id: number; kind: "submit" | "fail"; body: unknown }>> {
    let entries: string[];
    try {
      entries = await readdir(this.requestsDir);
    } catch {
      return [];
    }
    const found: Array<{ id: number; kind: "submit" | "fail"; body: unknown }> = [];
    for (const name of entries) {
      const id = Number(name);
      if (!Number.isSafeInteger(id)) {
        continue;
      }
      for (const kind of ["submit", "fail"] as const) {
        const body = await readJson(path.join(this.requestDir(id), `${kind}.json`));
        if (body !== undefined) {
          found.push({ id, kind, body });
        }
      }
    }
    return found;
  }

  /** Records the engine's verdict and removes the processed submission. */
  async writeResult(id: number, kind: "submit" | "fail", result: RequestResultFile): Promise<void> {
    await writeJsonAtomic(path.join(this.requestDir(id), "result.json"), result);
    await rm(path.join(this.requestDir(id), `${kind}.json`), { force: true });
  }

  /** The limit the user chose for a paused run, consumed once. */
  async takeContinue(): Promise<number | null> {
    const file = path.join(this.root, "continue.json");
    const body = await readJson(file);
    if (body === undefined) {
      return null;
    }
    await rm(file, { force: true });
    const limit = typeof body === "object" && body !== null && "limit" in body ? Number(body.limit) : Number.NaN;
    return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Write then rename, so a reader never sees half a file. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}
