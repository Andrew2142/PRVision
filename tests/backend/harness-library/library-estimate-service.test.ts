import assert from "node:assert/strict";
import { test } from "node:test";
import { LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS } from "../../../backend/src/config-consts";
import type { InventoryRequest } from "../../../backend/src/services/harness-library/component-inventory";
import {
  EstimateCountCache,
  LibraryEstimateService,
  LibraryEstimateTimeoutError,
  type LibraryEstimateInput
} from "../../../backend/src/services/harness-library/library-estimate-service";
import type {
  ComponentInventory,
  HarnessLibraryEntryRecord,
  InventoryComponent
} from "../../../backend/src/types/harness-library";
import { libraryEntry } from "../helpers/fake-library-store";

function component(filePath: string, exportName = "default"): InventoryComponent {
  return {
    identity: { filePath, exportName },
    displayName:
      filePath
        .split("/")
        .pop()
        ?.replace(/\.tsx$/, "") ?? filePath,
    selector: null,
    sourceFingerprint: null,
    childCount: 0,
    layer: 0,
    sourceLines: 10
  };
}

const TEN = Array.from({ length: 10 }, (_, i) => component(`src/components/C${String(i)}.tsx`));

function input(overrides: Partial<LibraryEstimateInput> = {}): LibraryEstimateInput {
  return {
    rootDir: "/srv/repos/shop",
    framework: "react_vite",
    appRoot: ".",
    tsconfigPath: "tsconfig.json",
    viteConfigPath: "vite.config.ts",
    angularProject: null,
    stateAllowance: 1,
    kind: "scan",
    repositoryId: null,
    model: "claude-opus-5-5",
    ...overrides
  };
}

interface Setup {
  service: LibraryEstimateService;
  requests: InventoryRequest[];
  head: { sha: string };
  clock: { now: number };
}

function setup(
  options: {
    components?: InventoryComponent[];
    inventory?: (request: InventoryRequest) => Promise<ComponentInventory>;
    entries?: HarnessLibraryEntryRecord[];
    timeoutMs?: number;
  } = {}
): Setup {
  const requests: InventoryRequest[] = [];
  const head = { sha: "a".repeat(40) };
  const clock = { now: 1_000_000 };
  const service = new LibraryEstimateService({
    inventory: {
      inventory: (request) => {
        requests.push(request);
        return options.inventory
          ? options.inventory(request)
          : Promise.resolve({
              framework: "react_vite",
              components: options.components ?? TEN,
              truncated: false,
              warnings: []
            });
      }
    },
    store: { listForRepository: () => Promise.resolve(options.entries ?? []) },
    git: { revParse: () => Promise.resolve(head.sha) },
    cache: new EstimateCountCache(),
    now: () => clock.now,
    timeoutMs: options.timeoutMs ?? 60_000,
    cacheMs: 60_000
  });
  return { service, requests, head, clock };
}

const signal = (): AbortSignal => new AbortController().signal;

test("default basis for claude-opus-5-5: allowance 1 and 3 (16 §10.7 numbers)", async () => {
  const { service } = setup();
  const one = await service.estimate(input({ stateAllowance: 1 }), signal());
  // (21 500·4 + 4 500·0.2 + 9 000·20) / 1e6
  assert.equal(one.perHarnessUsd, 0.2669);
  assert.equal(one.estimatedUsd, 2.67);
  assert.equal(one.lowUsd, 1.6);
  assert.equal(one.highUsd, 4.27);
  assert.equal(one.estimatedMinutes, 5);
  assert.equal(one.basis, "default");
  assert.equal(one.componentCount, 10);
  assert.equal(one.toWriteCount, 10);
  assert.equal(one.priceExact, true);
  assert.equal(one.priceModel, "claude-opus-5-5");
  assert.equal(one.model, "claude-opus-5-5");
  assert.equal(one.stateAllowance, 1);
  assert.equal(one.kind, "scan");

  const three = await service.estimate(input({ stateAllowance: 3 }), signal());
  // output + 1 500 × 2 = 12 000 tokens
  assert.equal(three.perHarnessUsd, 0.3269);
  assert.equal(three.estimatedUsd, 3.27);
  assert.equal(three.lowUsd, 1.96);
  assert.equal(three.highUsd, 5.23);
});

test("history basis: at least 5 same-model samples, output scaled by the allowance ratio", async () => {
  const usage = { inputTokens: 10_000, cacheReadInputTokens: 0, outputTokens: 4_000, calls: 2 };
  const samples = [1, 2, 3, 4, 5].map((id) =>
    libraryEntry({
      id,
      filePath: `src/S${String(id)}.tsx`,
      aiModel: "claude-opus-5-5",
      aiUsage: usage,
      stateAllowance: 1
    })
  );
  const otherModel = libraryEntry({ id: 6, filePath: "src/X.tsx", aiModel: "claude-sonnet-5", aiUsage: usage });
  const { service } = setup({ entries: [...samples, otherModel] });
  const view = await service.estimate(input({ repositoryId: 1, stateAllowance: 3 }), signal());
  assert.equal(view.basis, "history");
  // scale (1 + 0.3·2) / (1 + 0.3·0) = 1.6 → output 6 400: (10 000·4 + 6 400·20) / 1e6
  assert.equal(view.perHarnessUsd, 0.168);

  const fewer = setup({ entries: [...samples.slice(0, 4), otherModel] });
  assert.equal((await fewer.service.estimate(input({ repositoryId: 1 }), signal())).basis, "default");
});

test("toWriteCount: scan counts components without any entry, rescan counts all", async () => {
  const entries = [
    libraryEntry({ id: 1, filePath: "src/components/C0.tsx" }),
    libraryEntry({ id: 2, filePath: "src/components/C1.tsx", status: "off_default_branch" }),
    libraryEntry({ id: 3, filePath: "src/components/C2.tsx", harnessSource: null })
  ];
  const { service } = setup({ entries });
  assert.equal((await service.estimate(input({ repositoryId: 1 }), signal())).toWriteCount, 7);
  const rescan = await service.estimate(input({ repositoryId: 1, kind: "rescan" }), signal());
  assert.equal(rescan.toWriteCount, 10);
  assert.equal(rescan.kind, "rescan");
});

test("an unknown model is priced with the fallback model and marked approximate (E17)", async () => {
  const { service } = setup();
  const view = await service.estimate(input({ model: "claude-future-9" }), signal());
  assert.equal(view.priceExact, false);
  assert.equal(view.priceModel, "claude-fable-5-1");
  assert.equal(view.model, "claude-future-9");
  // (21 500·10 + 4 500·0.25 + 9 000·50) / 1e6
  assert.equal(view.perHarnessUsd, 0.6661);
});

test("the inventory runs without fingerprints within the estimate budget; truncation is reported", async () => {
  const { service, requests } = setup({
    inventory: () =>
      Promise.resolve({
        framework: "react_vite",
        components: TEN.slice(0, 4),
        truncated: true,
        warnings: ["src has more files than the inventory budget allows; the count is partial."]
      })
  });
  const view = await service.estimate(input(), signal());
  const request = requests[0];
  assert.equal(request?.withFingerprints, false);
  assert.equal(request.budgetMs, LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS);
  assert.equal(request.rootDir, "/srv/repos/shop");
  assert.equal(view.truncated, true);
  assert.equal(view.componentCount, 4);
  assert.deepEqual(view.warnings, ["src has more files than the inventory budget allows; the count is partial."]);
});

test("counting longer than the timeout throws LibraryEstimateTimeoutError and aborts the inventory", async () => {
  let seen: AbortSignal | null = null;
  const { service } = setup({
    timeoutMs: 20,
    inventory: (request) => {
      seen = request.signal;
      return new Promise(() => undefined); // never settles
    }
  });
  await assert.rejects(service.estimate(input(), signal()), LibraryEstimateTimeoutError);
  assert.equal((seen as AbortSignal | null)?.aborted, true);
});

test("the count is cached across allowance and kind changes and recounted when HEAD changes or it expires", async () => {
  const { service, requests, head, clock } = setup();
  await service.estimate(input({ stateAllowance: 1 }), signal());
  const changed = await service.estimate(input({ stateAllowance: 5, kind: "rescan" }), signal());
  assert.equal(requests.length, 1, "pricing changes never recount");
  assert.equal(changed.stateAllowance, 5);
  head.sha = "b".repeat(40);
  await service.estimate(input(), signal());
  assert.equal(requests.length, 2, "a new HEAD recounts");
  clock.now += 60_001;
  await service.estimate(input(), signal());
  assert.equal(requests.length, 3, "an expired count recounts");
  await service.estimate(input({ appRoot: "apps/web" }), signal());
  assert.equal(requests.length, 4, "another app of the same clone has its own count");
});
