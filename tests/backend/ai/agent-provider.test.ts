import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AiProviderError, type AiStructuredRequest } from "../../../backend/src/types/visualization-pipeline";
import { AgentAiProvider, type AgentProviderStore } from "../../../backend/src/utilities/services/ai/agent-provider";
import type { AgentRequestState } from "../../../backend/src/utilities/services/ai/agent-request-store";
import type { AgentRequestImage } from "../../../backend/src/types/agent-request";
import { withTempDir } from "../helpers/test-context";

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } }
};

function request(overrides: Partial<AiStructuredRequest> = {}): AiStructuredRequest {
  return {
    purpose: "harness",
    system: "System text",
    prompt: "Do the task.",
    jsonSchema: SCHEMA,
    effort: "high",
    ...overrides
  };
}

/**
 * In-memory store. `script` runs before each poll read and may change the row (simulating the agent); the clock
 * advances by `stepMs` on every sleep.
 */
class FakeStore implements AgentProviderStore {
  readonly created: Array<Record<string, unknown>> = [];
  readonly cancelled: Array<{ id: number; message: string }> = [];
  images: AgentRequestImage[] = [];
  state: AgentRequestState | null = null;
  reads = 0;

  constructor(
    private readonly clock: { now: number },
    private readonly script: (store: FakeStore) => void = () => undefined
  ) {}

  create(input: Parameters<AgentProviderStore["create"]>[0]): Promise<number> {
    this.created.push({ ...input });
    this.state = {
      id: 7,
      status: "pending",
      response: null,
      errorMessage: null,
      createdAt: new Date(this.clock.now),
      claimedAt: null
    };
    return Promise.resolve(7);
  }

  setImages(_id: number, images: AgentRequestImage[]): Promise<void> {
    this.images = images;
    return Promise.resolve();
  }

  readState(): Promise<AgentRequestState | null> {
    this.reads += 1;
    this.script(this);
    return Promise.resolve(this.state === null ? null : { ...this.state });
  }

  cancel(id: number, message: string): Promise<boolean> {
    this.cancelled.push({ id, message });
    if (this.state !== null) {
      this.state = { ...this.state, status: "cancelled" };
    }
    return Promise.resolve(true);
  }

  set(patch: Partial<AgentRequestState>): void {
    if (this.state !== null) {
      this.state = { ...this.state, ...patch };
    }
  }
}

function setup(script?: (store: FakeStore) => void, options: { imageDir?: string } = {}) {
  const clock = { now: 1_000_000 };
  const store = new FakeStore(clock, script);
  const provider = new AgentAiProvider({
    visualizationId: 42,
    store,
    imageDir: options.imageDir ?? "/nonexistent",
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
    pollMs: 1_000,
    claimTimeoutMs: 10_000,
    answerTimeoutMs: 20_000
  });
  return { clock, store, provider };
}

async function rejectsWith(promise: Promise<unknown>, reason: string, pattern?: RegExp): Promise<AiProviderError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof AiProviderError, "AiProviderError");
    assert.equal(error.reason, reason);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return error;
  }
  assert.fail("expected a rejection");
}

test("an answered request returns the response, one call of usage and the agent model label", async () => {
  const { store, provider } = setup((s) => {
    if (s.reads === 3) {
      s.set({ status: "answered", response: { answer: "hi" } });
    }
  });
  const result = await provider.generateStructured<{ answer: string }>(request());
  assert.deepEqual(result.data, { answer: "hi" });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, calls: 1 });
  assert.equal(result.model, "agent");
  assert.equal(provider.kind, "agent");
  assert.deepEqual(store.created[0], {
    visualizationId: 42,
    purpose: "harness",
    systemPrompt: "System text",
    prompt: "Do the task.",
    jsonSchema: SCHEMA
  });
});

test("a stored answer that no longer matches the schema is invalid_output", async () => {
  const { provider } = setup((s) => s.set({ status: "answered", response: { wrong: 1 } }));
  await rejectsWith(provider.generateStructured(request()), "invalid_output");
});

test("a failed request is a refusal carrying the agent's message", async () => {
  const { provider } = setup((s) => s.set({ status: "failed", errorMessage: "component needs a backend" }));
  const error = await rejectsWith(provider.generateStructured(request()), "refusal", /component needs a backend/);
  assert.equal(error.retryable, false);
});

test("a cancelled or deleted request is aborted", async () => {
  const cancelled = setup((s) => s.set({ status: "cancelled" }));
  await rejectsWith(cancelled.provider.generateStructured(request()), "aborted");
  const deleted = setup((s) => {
    s.state = null;
  });
  await rejectsWith(deleted.provider.generateStructured(request()), "aborted");
});

test("a request nobody claims in time fails with config and is cancelled", async () => {
  const { store, provider } = setup();
  await rejectsWith(provider.generateStructured(request()), "config", /No Claude Code session picked up the request/);
  assert.deepEqual(
    store.cancelled.map((c) => c.id),
    [7]
  );
});

test("a claimed request not answered in time fails with network, not retryable", async () => {
  const { store, provider } = setup((s) => {
    if (s.state?.status === "pending") {
      s.set({ status: "claimed", claimedAt: new Date(s.state.createdAt.getTime()) });
    }
  });
  const error = await rejectsWith(provider.generateStructured(request()), "network", /did not answer/);
  assert.equal(error.retryable, false);
  assert.equal(store.cancelled.length, 1);
});

test("aborting while waiting cancels the request", async () => {
  const controller = new AbortController();
  const { store, provider } = setup((s) => {
    if (s.reads === 2) {
      controller.abort();
    }
  });
  await rejectsWith(provider.generateStructured(request({ signal: controller.signal })), "aborted");
  assert.deepEqual(store.cancelled, [{ id: 7, message: "Run cancelled" }]);
});

test("an already aborted signal never creates a request", async () => {
  const { store, provider } = setup();
  await rejectsWith(provider.generateStructured(request({ signal: AbortSignal.abort() })), "aborted");
  assert.equal(store.created.length, 0);
});

test("connection_test is a config error", async () => {
  const { store, provider } = setup();
  await rejectsWith(provider.generateStructured(request({ purpose: "connection_test" })), "config");
  assert.equal(store.created.length, 0);
});

test("images are written as <id>-<n>.png and their paths stored", async () => {
  await withTempDir(async (dir) => {
    const imageDir = path.join(dir, "agent-requests", "42");
    const { store, provider } = setup((s) => s.set({ status: "answered", response: { answer: "ok" } }), { imageDir });
    const png = Buffer.from("not-really-a-png");
    await provider.generateStructured(
      request({
        purpose: "summary",
        images: [
          { mediaType: "image/png", base64: png.toString("base64"), label: "Button head" },
          { mediaType: "image/png", base64: png.toString("base64"), label: "Button diff" }
        ]
      })
    );
    assert.deepEqual(store.images, [
      { label: "Button head", path: path.join(imageDir, "7-1.png") },
      { label: "Button diff", path: path.join(imageDir, "7-2.png") }
    ]);
    assert.deepEqual(await fs.readFile(path.join(imageDir, "7-2.png")), png);
  });
});
