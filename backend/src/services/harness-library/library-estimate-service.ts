/**
 * Scan estimate (16 §10.7, D3, D13): the inventory count over a folder (read-only, no fingerprints) and a cost model
 * from the price table, either the repository's own history or the default per-harness usage. Only the count is
 * cached (API process memory, LIBRARY_ESTIMATE_CACHE_MS); pricing is recomputed on every request.
 */
import {
  LIBRARY_ESTIMATE_CACHE_MS,
  LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE,
  LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS,
  LIBRARY_ESTIMATE_MIN_SAMPLES,
  LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE,
  LIBRARY_ESTIMATE_SECONDS_PER_HARNESS,
  LIBRARY_ESTIMATE_TIMEOUT_MS
} from "../../config-consts";
import type { LibraryEstimateView } from "../../dtos/harness-library/library-estimate-view.dto";
import { identityKey, type HarnessLibraryStorePort } from "../../types/harness-library";
import type { AiUsage } from "../../types/visualization-pipeline";
import { GitClient, GitCommandError, createLogger, priceFor, usageCostUsd } from "../../utilities";
import { ComponentInventoryService } from "./component-inventory";
import { HarnessLibraryStore } from "./harness-library-store";

/** One estimate request (16 §10.7). */
export interface LibraryEstimateInput {
  rootDir: string;
  framework: "react_vite" | "angular";
  appRoot: string;
  tsconfigPath: string | null;
  viteConfigPath: string | null;
  angularProject: string | null;
  stateAllowance: number;
  kind: "scan" | "rescan";
  /** null for a folder that is not registered (every component is to write). */
  repositoryId: number | null;
  model: string;
}

/** Thrown when counting exceeded LIBRARY_ESTIMATE_TIMEOUT_MS; the API answers 504 internal_error. */
export class LibraryEstimateTimeoutError extends Error {
  override readonly name = "LibraryEstimateTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Counting components took longer than ${String(timeoutMs)} ms`);
  }
}

/** The cached part of an estimate: what the inventory found. */
interface CountedInventory {
  identities: string[];
  truncated: boolean;
  warnings: string[];
}

interface CacheEntry {
  expiresAt: number;
  counted: CountedInventory;
}

/** Process-wide count cache, keyed by (rootDir, appRoot, angularProject, HEAD sha). */
export class EstimateCountCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string, now: number): CountedInventory | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.counted;
  }

  set(key: string, counted: CountedInventory, expiresAt: number): void {
    for (const [existing, entry] of this.entries) {
      if (entry.expiresAt <= expiresAt - LIBRARY_ESTIMATE_CACHE_MS) {
        this.entries.delete(existing); // drop expired entries so the cache stays small
      }
    }
    this.entries.set(key, { expiresAt, counted });
  }

  clear(): void {
    this.entries.clear();
  }
}

const DEFAULT_CACHE = new EstimateCountCache();

export interface LibraryEstimateDependencies {
  inventory: Pick<ComponentInventoryService, "inventory">;
  store: Pick<HarnessLibraryStorePort, "listForRepository">;
  git: Pick<GitClient, "revParse">;
  cache: EstimateCountCache;
  now: () => number;
  timeoutMs: number;
  cacheMs: number;
}

/** Output-token scale of the requested allowance relative to the samples' mean allowance (16 §10.7). */
function allowanceScale(allowance: number): number {
  return 1 + 0.3 * (allowance - 1);
}

function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** Inventory count and cost of a scan or rescan (16 §10.7). */
export class LibraryEstimateService {
  private readonly deps: LibraryEstimateDependencies;
  private readonly log = createLogger("library");

  constructor(deps: Partial<LibraryEstimateDependencies> = {}) {
    this.deps = {
      inventory: deps.inventory ?? new ComponentInventoryService(),
      store: deps.store ?? new HarnessLibraryStore(),
      git: deps.git ?? new GitClient(),
      cache: deps.cache ?? DEFAULT_CACHE,
      now: deps.now ?? Date.now,
      timeoutMs: deps.timeoutMs ?? LIBRARY_ESTIMATE_TIMEOUT_MS,
      cacheMs: deps.cacheMs ?? LIBRARY_ESTIMATE_CACHE_MS
    };
  }

  /**
   * @throws LibraryEstimateTimeoutError when counting takes longer than LIBRARY_ESTIMATE_TIMEOUT_MS.
   */
  async estimate(input: LibraryEstimateInput, signal: AbortSignal): Promise<LibraryEstimateView> {
    const started = this.deps.now();
    const counted = await this.count(input, signal);
    const entryKeys =
      input.repositoryId === null
        ? new Set<string>()
        : new Set((await this.deps.store.listForRepository(input.repositoryId)).map((entry) => identityKey(entry)));
    const toWriteCount =
      input.kind === "rescan"
        ? counted.identities.length
        : counted.identities.filter((key) => !entryKeys.has(key)).length;

    const { usage, basis } = await this.usagePerHarness(input);
    const price = priceFor(input.model);
    const perHarnessUsd = usageCostUsd(input.model, usage).usd;
    const estimatedUsd = perHarnessUsd * toWriteCount;
    this.log.info(
      {
        event: "library.estimate",
        components: counted.identities.length,
        toWrite: toWriteCount,
        ms: this.deps.now() - started,
        basis
      },
      "Library estimate"
    );
    return {
      componentCount: counted.identities.length,
      toWriteCount,
      truncated: counted.truncated,
      stateAllowance: input.stateAllowance,
      kind: input.kind,
      model: input.model,
      priceModel: price.priceModel,
      priceExact: price.exact,
      basis,
      perHarnessUsd,
      estimatedUsd: roundCents(estimatedUsd),
      lowUsd: roundCents(estimatedUsd * 0.6),
      highUsd: roundCents(estimatedUsd * 1.6),
      estimatedMinutes: Math.ceil((toWriteCount * LIBRARY_ESTIMATE_SECONDS_PER_HARNESS) / 60),
      warnings: [...counted.warnings]
    };
  }

  /** The inventory count, from the cache when the folder's HEAD is unchanged. */
  private async count(input: LibraryEstimateInput, signal: AbortSignal): Promise<CountedInventory> {
    const key = await this.cacheKey(input);
    if (key !== null) {
      const cached = this.deps.cache.get(key, this.deps.now());
      if (cached !== null) {
        return cached;
      }
    }
    const counted = await this.countWithTimeout(input, signal);
    if (key !== null) {
      this.deps.cache.set(key, counted, this.deps.now() + this.deps.cacheMs);
    }
    return counted;
  }

  private async countWithTimeout(input: LibraryEstimateInput, signal: AbortSignal): Promise<CountedInventory> {
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let rejectTimeout: (error: Error) => void = () => undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      controller.abort("timeout");
      rejectTimeout(new LibraryEstimateTimeoutError(this.deps.timeoutMs));
    }, this.deps.timeoutMs);
    timer.unref();
    timedOut.catch(() => undefined); // settled by the race below or never observed
    try {
      const inventory = await Promise.race([
        this.deps.inventory.inventory({
          framework: input.framework,
          rootDir: input.rootDir,
          appRoot: input.appRoot,
          tsconfigPath: input.tsconfigPath,
          viteConfigPath: input.viteConfigPath,
          angularProject: input.angularProject,
          signal: controller.signal,
          budgetMs: LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS,
          withFingerprints: false
        }),
        timedOut
      ]);
      if (controller.signal.aborted && controller.signal.reason === "timeout") {
        throw new LibraryEstimateTimeoutError(this.deps.timeoutMs);
      }
      return {
        identities: inventory.components.map((component) => identityKey(component.identity)),
        truncated: inventory.truncated,
        warnings: [...inventory.warnings]
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** `<rootDir>\0<appRoot>\0<angularProject>\0<HEAD sha>`; null (no caching) when HEAD cannot be read. */
  private async cacheKey(input: LibraryEstimateInput): Promise<string | null> {
    let head: string;
    try {
      head = await this.deps.git.revParse(input.rootDir, "HEAD");
    } catch (error: unknown) {
      if (error instanceof GitCommandError) {
        return null;
      }
      throw error;
    }
    return [input.rootDir, input.appRoot, input.angularProject ?? "", head].join("\u0000");
  }

  /** History basis with at least LIBRARY_ESTIMATE_MIN_SAMPLES same-model samples, else the default basis. */
  private async usagePerHarness(
    input: LibraryEstimateInput
  ): Promise<{ usage: AiUsage; basis: "history" | "default" }> {
    const allowance = input.stateAllowance;
    if (input.repositoryId !== null) {
      const model = input.model.trim().toLowerCase();
      const samples = (await this.deps.store.listForRepository(input.repositoryId)).filter(
        (entry) => entry.aiUsage !== null && entry.aiModel !== null && entry.aiModel.trim().toLowerCase() === model
      );
      if (samples.length >= LIBRARY_ESTIMATE_MIN_SAMPLES) {
        const n = samples.length;
        const sum = (pick: (usage: AiUsage) => number): number =>
          samples.reduce((total, entry) => total + (entry.aiUsage === null ? 0 : pick(entry.aiUsage)), 0);
        const meanAllowance = samples.reduce((total, entry) => total + entry.stateAllowance, 0) / n;
        const scale = allowanceScale(allowance) / allowanceScale(meanAllowance);
        return {
          basis: "history",
          usage: {
            inputTokens: sum((usage) => usage.inputTokens) / n,
            cacheReadInputTokens: sum((usage) => usage.cacheReadInputTokens ?? 0) / n,
            cacheWriteInputTokens: sum((usage) => usage.cacheWriteInputTokens ?? 0) / n,
            outputTokens: (sum((usage) => usage.outputTokens) / n) * scale,
            calls: sum((usage) => usage.calls) / n
          }
        };
      }
    }
    const base = LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE;
    return {
      basis: "default",
      usage: {
        inputTokens: base.inputTokens,
        cacheReadInputTokens: base.cacheReadInputTokens,
        cacheWriteInputTokens: base.cacheWriteInputTokens,
        outputTokens: base.outputTokens + LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE * (allowance - 1),
        calls: base.calls
      }
    };
  }
}
