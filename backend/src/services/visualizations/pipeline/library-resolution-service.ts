/**
 * Library resolution (16 §8.4): the last step of `analyzing`. Decides per analysed row whether each side reuses a
 * saved harness of the repository's library or needs a new one (D6), counts the new harnesses and applies the
 * component pause (D9, E12), skips rows needing new harnesses beyond the confirmed limit, and adds the whole-library
 * re-check rows of a global style change (D7, E11). Persists the reuse links, skips, re-check rows and run counts in
 * one transaction. Never calls the AI.
 */
import { LIBRARY_RECHECK_MAX_COMPONENTS, MAX_COMPONENTS } from "../../../config-consts";
import { ComponentChangeKind, ComponentHarnessOrigin, ComponentRenderStatus, Table } from "../../../enums";
import {
  identityKey,
  type HarnessLibraryEntryRecord,
  type HarnessLibraryStorePort,
  type LibraryComponentIdentity,
  type LibraryResolution,
  type SideHarnessPlan
} from "../../../types/harness-library";
import type {
  ChangeAnalysisResult,
  ComponentCandidate,
  PipelineContext,
  WorktreeSide
} from "../../../types/visualization-pipeline";
import { createLogger, DrizzleDb, getErrorMessage, QueryHandler, type Transaction } from "../../../utilities";
import { HarnessLibraryStore } from "../../harness-library/harness-library-store";
import { LibraryFingerprinter } from "../../harness-library/library-fingerprint";
import { confinedFileExists, readConfinedText } from "./change-source";
import {
  detectGlobalStyleTriggers,
  GLOBAL_STYLE_TRIGGER_LABELS,
  type GlobalStyleTrigger
} from "./global-style-triggers";
import { candidateBaseExport, candidateBasePath, isReplacedCandidate } from "./replaced-components";

const STAGE = "analyzing";

/** What the worker needs on top of the 16 §6.11 LibraryResolution (16 §8.4). */
export interface LibraryResolutionResult extends LibraryResolution {
  /** Rows to send to harness generation, with the sides to write. */
  toWrite: Array<{ candidate: ComponentCandidate; sides: WorktreeSide[] }>;
  /** Every row that will reach rendering (reused, to write, rechecked), rank order. */
  renderCandidates: ComponentCandidate[];
  /**
   * E25: revision of a harness-less entry the resolution saw at a write side's identity, keyed by
   * `identityKey(plan.identity)`. A write side whose identity is absent here saves with `expectedRevision: 0`.
   */
  writeRevisions: Map<string, number>;
}

/** Collaborators; every field defaults to the real implementation. */
export interface LibraryResolutionDeps {
  store: HarnessLibraryStorePort;
  queryHandler: QueryHandler;
  /** DrizzleDb.transaction. */
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  createQueryHandler: (tx: Transaction) => QueryHandler;
  fingerprinter: Pick<LibraryFingerprinter, "fingerprint">;
  /** True when the repo-relative path is a file on that side's worktree; default a confined check of ctx's worktrees. */
  fileExists?: (side: WorktreeSide, path: string) => Promise<boolean>;
  now: () => number;
}

/** A row's identities: `head` is the head (or only) component, `base` the base-side component. */
interface RowIdentities {
  head: LibraryComponentIdentity | null;
  base: LibraryComponentIdentity | null;
}

interface RowPlan {
  candidate: ComponentCandidate;
  plans: SideHarnessPlan[];
  /** Sides (by plan side) that need a new harness. */
  writeSides: WorktreeSide[];
}

/** An entry is usable when it has a harness, whatever its status (E4, E26). */
function usable(entry: HarnessLibraryEntryRecord | undefined): entry is HarnessLibraryEntryRecord {
  return entry !== undefined && entry.harnessSource !== null;
}

function sameIdentity(a: LibraryComponentIdentity, b: LibraryComponentIdentity): boolean {
  return a.filePath === b.filePath && a.exportName === b.exportName;
}

function byIdentity(a: { filePath: string; exportName: string }, b: { filePath: string; exportName: string }): number {
  if (a.filePath !== b.filePath) {
    return a.filePath < b.filePath ? -1 : 1;
  }
  if (a.exportName === b.exportName) {
    return 0;
  }
  if (a.exportName === "default") {
    return -1;
  }
  if (b.exportName === "default") {
    return 1;
  }
  return a.exportName < b.exportName ? -1 : 1;
}

/** `change_reason` of a re-check row (16 §8.4 step 6). */
export function recheckReason(triggerPath: string): string {
  return `Global style changed (${triggerPath}); re-checked with the saved harness`;
}

/** Skip reason of a row beyond the new-harness limit (16 §8.4 step 5). */
export function overLimitReason(position: number, total: number, limit: number): string {
  return `over_limit: needs a new harness, ranked ${String(position)} of ${String(total)}; PRVision writes at most ${String(limit)} new harnesses per visualization`;
}

/** The awaiting_confirmation message of the D9 pause (16 §8.4, §18). */
export function newHarnessPauseMessage(newHarnessCount: number, reusedCount: number): string {
  return `${String(newHarnessCount)} new harnesses needed (${String(reusedCount)} components reuse saved harnesses); PRVision writes ${String(MAX_COMPONENTS)} by default. Waiting for you to choose how many to write.`;
}

/** Decides reuse, new harnesses, the pause and the whole-library re-check of one run (16 §8.4). */
export class LibraryResolutionService {
  private readonly deps: LibraryResolutionDeps;

  constructor(deps: Partial<LibraryResolutionDeps> = {}) {
    this.deps = {
      store: deps.store ?? new HarnessLibraryStore(),
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      transaction: deps.transaction ?? ((fn) => DrizzleDb.transaction(fn)),
      createQueryHandler: deps.createQueryHandler ?? ((tx) => new QueryHandler(tx)),
      fingerprinter: deps.fingerprinter ?? new LibraryFingerprinter(),
      ...(deps.fileExists !== undefined ? { fileExists: deps.fileExists } : {}),
      now: deps.now ?? Date.now
    };
  }

  /**
   * Steps 1–8 of 16 §8.4.
   *
   * @throws PipelineStepError-free: store and persistence failures propagate as errors (the worker fails the run in
   *   `analyzing`, before any AI call).
   */
  async resolve(ctx: PipelineContext, analysis: ChangeAnalysisResult): Promise<LibraryResolutionResult> {
    const started = this.deps.now();
    const log = createLogger("library", { visualizationId: ctx.visualizationId });
    const fileExists =
      this.deps.fileExists ??
      ((side: WorktreeSide, path: string): Promise<boolean> =>
        confinedFileExists(side === "base" ? ctx.workspace.baseDir : ctx.workspace.headDir, path));
    const rows = [...analysis.candidates].sort((a, b) => a.rank - b.rank);

    // 1. identities per row
    const identities = new Map<number, RowIdentities>();
    for (const candidate of rows) {
      identities.set(candidate.componentId, await this.identitiesOf(candidate, analysis));
    }
    const all = new Map<string, LibraryComponentIdentity>();
    for (const ids of identities.values()) {
      for (const identity of [ids.head, ids.base]) {
        if (identity !== null) {
          all.set(identityKey(identity), identity);
        }
      }
    }

    // 2. entries
    const entries: ReadonlyMap<string, HarnessLibraryEntryRecord> =
      all.size > 0
        ? await this.deps.store.findByIdentities(ctx.repository.id, [...all.values()])
        : new Map<string, HarnessLibraryEntryRecord>();
    const entryAt = (identity: LibraryComponentIdentity | null): HarnessLibraryEntryRecord | undefined =>
      identity === null ? undefined : entries.get(identityKey(identity));

    // 3. plan per row
    const writeRevisions = new Map<string, number>();
    const rememberWrite = (identity: LibraryComponentIdentity): void => {
      const existing = entryAt(identity);
      if (existing !== undefined) {
        writeRevisions.set(identityKey(identity), existing.revision); // a harness-less entry (E25)
      }
    };
    const rowPlans: RowPlan[] = [];
    for (const candidate of rows) {
      const ids = identities.get(candidate.componentId) ?? { head: null, base: null };
      const plans: SideHarnessPlan[] = [];
      const writeSides: WorktreeSide[] = [];
      if (isReplacedCandidate(candidate)) {
        for (const side of ["base", "head"] as const) {
          const identity = side === "base" ? ids.base : ids.head;
          if (identity === null) {
            continue;
          }
          const entry = entryAt(identity);
          if (usable(entry)) {
            plans.push({ side, identity, entry });
          } else {
            plans.push({ side, identity, entry: null });
            writeSides.push(side);
            rememberWrite(identity);
          }
        }
      } else {
        const side: WorktreeSide = candidate.changeKind === ComponentChangeKind.REMOVED ? "base" : "head";
        const own = side === "base" ? ids.base : ids.head;
        if (own !== null) {
          const ownEntry = entryAt(own);
          const baseEntry =
            side === "head" && ids.base !== null && !sameIdentity(ids.base, own) ? entryAt(ids.base) : undefined;
          if (usable(ownEntry)) {
            plans.push({ side, identity: own, entry: ownEntry });
          } else if (usable(baseEntry)) {
            // a renamed component: reuse the base identity's entry, moved after a successful head render
            plans.push({ side, identity: own, entry: baseEntry });
          } else {
            plans.push({ side, identity: own, entry: null });
            writeSides.push(side);
            rememberWrite(own);
          }
        }
      }
      rowPlans.push({ candidate, plans, writeSides });
    }

    // 4. new harness count
    const newHarnessCount = rowPlans.reduce((sum, row) => sum + row.writeSides.length, 0);
    const reusedRows = rowPlans.filter((row) => row.plans.some((plan) => plan.entry !== null));

    // 5. D9 pause (E12)
    if (ctx.componentLimit === undefined && newHarnessCount > MAX_COMPONENTS) {
      await this.persistPauseCounts(ctx.visualizationId, newHarnessCount, reusedRows.length);
      log.info(
        {
          event: "library.resolve",
          visualizationId: ctx.visualizationId,
          reused: reusedRows.length,
          toWrite: newHarnessCount,
          rechecked: 0,
          paused: true,
          trigger: null
        },
        "Library resolved: pause for confirmation"
      );
      return {
        plans: new Map(rowPlans.map((row) => [row.candidate.componentId, row.plans])),
        newHarnessCount,
        reusedCount: reusedRows.length,
        recheckedCount: 0,
        globalStyleTrigger: null,
        pause: true,
        skippedOverLimit: [],
        toWrite: [],
        renderCandidates: [],
        writeRevisions
      };
    }
    const limit = ctx.componentLimit ?? MAX_COMPONENTS;
    const needing = rowPlans.filter((row) => row.writeSides.length > 0);
    const skipped = new Map<number, string>();
    let remaining = limit;
    needing.forEach((row, index) => {
      if (row.writeSides.length <= remaining) {
        remaining -= row.writeSides.length;
        return;
      }
      skipped.set(row.candidate.componentId, overLimitReason(index + 1, needing.length, limit));
    });
    const kept = rowPlans.filter((row) => !skipped.has(row.candidate.componentId));

    // 6. D7 re-check
    const triggers = detectGlobalStyleTriggers({
      framework: ctx.repository.framework,
      appRoot: ctx.repository.appRoot,
      viteConfigPath: ctx.repository.viteConfigPath,
      globalStylePaths: ctx.repository.globalStylePaths,
      globalStyleChanges: analysis.globalStyleChanges,
      changedFiles: analysis.changedFiles
    });
    const trigger: GlobalStyleTrigger | null = triggers[0] ?? null;
    let recheck: HarnessLibraryEntryRecord[] = [];
    let libraryEmpty = true;
    let eligibleCount = 0;
    if (trigger !== null) {
      const library = await this.deps.store.listForRepository(ctx.repository.id, {
        withHarnessOnly: true,
        onDefaultBranchOnly: true
      });
      libraryEmpty = library.length === 0;
      // every identity of a row (either side), including rows analysis skipped at its ceiling (unique row key)
      const rowKeys = new Set(all.keys());
      for (const row of analysis.skipped) {
        rowKeys.add(identityKey(row));
      }
      const eligible: HarnessLibraryEntryRecord[] = [];
      for (const entry of [...library].sort(byIdentity)) {
        if (entry.harnessSource === null || rowKeys.has(identityKey(entry))) {
          continue;
        }
        if ((await fileExists("base", entry.filePath)) && (await fileExists("head", entry.filePath))) {
          eligible.push(entry);
        }
      }
      eligibleCount = eligible.length;
      recheck = eligible.slice(0, LIBRARY_RECHECK_MAX_COMPONENTS);
    }

    // 7. persist (fingerprints first, outside the transaction: they read worktree files)
    const sourceChanged = new Map<number, boolean | null>();
    for (const row of kept) {
      // the head (or only) harness's entry; a replaced row whose head side is written has none (16 §6.7)
      const reusedEntry = row.plans.find(
        (plan) => plan.entry !== null && (plan.side === "head" || !isReplacedCandidate(row.candidate))
      )?.entry;
      if (reusedEntry === undefined || reusedEntry === null) {
        continue;
      }
      sourceChanged.set(row.candidate.componentId, await this.sourceChangedSinceWrite(ctx, row.candidate, reusedEntry));
    }
    const rankBase = rows.length;
    const reason = trigger === null ? "" : recheckReason(trigger.path);
    const recheckIds = await this.deps.transaction(async (tx) => {
      const qh = this.deps.createQueryHandler(tx);
      let ids: number[] = [];
      if (recheck.length > 0) {
        const inserted = await qh.insert(
          recheck.map((entry, index) =>
            QueryHandler.normalizeData({
              visualizationId: ctx.visualizationId,
              filePath: entry.filePath,
              exportName: entry.exportName,
              displayName: entry.displayName,
              changeKind: ComponentChangeKind.RECHECKED,
              renderStatus: ComponentRenderStatus.PENDING,
              rank: rankBase + index,
              codeDiff: null,
              mockedModules: [],
              changeReason: reason,
              skipReason: null,
              libraryEntryId: entry.id,
              harnessOrigin: ComponentHarnessOrigin.LIBRARY
            })
          ),
          Table.VISUALIZATION_COMPONENTS
        );
        if (inserted.status !== 200 || !Array.isArray(inserted.data)) {
          throw new Error(`re-check rows insert failed (${String(inserted.status)})`);
        }
        ids = inserted.data.map((row) => (typeof row.id === "number" ? row.id : Number.NaN));
        if (ids.length !== recheck.length || ids.some((id) => !Number.isSafeInteger(id))) {
          throw new Error("re-check rows insert returned no ids");
        }
      }
      for (const [componentId, skipReason] of skipped) {
        await this.updateRow(qh, ctx.visualizationId, componentId, {
          renderStatus: ComponentRenderStatus.SKIPPED,
          skipReason
        });
      }
      for (const row of kept) {
        const values: Record<string, unknown> = {};
        for (const plan of row.plans) {
          if (plan.entry === null) {
            continue;
          }
          if (isReplacedCandidate(row.candidate) && plan.side === "base") {
            values.baseLibraryEntryId = plan.entry.id;
            values.baseHarnessOrigin = ComponentHarnessOrigin.LIBRARY;
          } else {
            values.libraryEntryId = plan.entry.id;
            values.harnessOrigin = ComponentHarnessOrigin.LIBRARY;
          }
        }
        if (Object.keys(values).length === 0) {
          continue;
        }
        values.sourceChangedSinceWrite = sourceChanged.get(row.candidate.componentId) ?? null;
        await this.updateRow(qh, ctx.visualizationId, row.candidate.componentId, values);
      }
      const reusedKept = kept.filter((row) => row.plans.some((plan) => plan.entry !== null)).length;
      const written = kept.reduce((sum, row) => sum + row.writeSides.length, 0);
      const counted = await qh.update(
        {
          componentCount: rows.length + analysis.skipped.length + recheck.length,
          reusedHarnessCount: reusedKept,
          newHarnessCount: written,
          globalStyleTrigger: trigger?.path ?? null
        },
        { id: ctx.visualizationId },
        Table.VISUALIZATIONS
      );
      if (counted.status !== 200) {
        throw new Error(`visualization counts update failed (${String(counted.status)})`);
      }
      return ids;
    });

    // 8. console
    const reusedKept = kept.filter((row) => row.plans.some((plan) => plan.entry !== null)).length;
    const toWriteRows = kept.filter((row) => row.writeSides.length > 0);
    await ctx.console.info(
      STAGE,
      `Harness library: ${String(reusedKept)} component(s) reuse saved harnesses, ${String(toWriteRows.length)} need a new harness.`
    );
    if (skipped.size > 0) {
      await ctx.console.warn(
        STAGE,
        `${String(skipped.size)} component(s) need a new harness beyond the limit of ${String(limit)}; they are skipped.`
      );
    }
    if (trigger !== null) {
      const label = GLOBAL_STYLE_TRIGGER_LABELS[trigger.reason];
      await ctx.console.info(
        STAGE,
        libraryEmpty
          ? `Global style change in ${trigger.path} (${label}). The harness library is empty, so nothing else is re-checked. Scan the whole app from the repository page for full coverage.`
          : `Global style change in ${trigger.path} (${label}): re-checking all ${String(recheck.length)} saved harnesses.`
      );
      if (eligibleCount > LIBRARY_RECHECK_MAX_COMPONENTS) {
        await ctx.console.warn(
          STAGE,
          `Only the first ${String(LIBRARY_RECHECK_MAX_COMPONENTS)} saved harnesses are re-checked.`
        );
      }
    }

    // result
    const plans = new Map<number, SideHarnessPlan[]>(kept.map((row) => [row.candidate.componentId, row.plans]));
    const recheckCandidates: ComponentCandidate[] = recheck.map((entry, index) => {
      const componentId = recheckIds[index] ?? 0;
      plans.set(componentId, [
        { side: "head", identity: { filePath: entry.filePath, exportName: entry.exportName }, entry }
      ]);
      return {
        componentId,
        filePath: entry.filePath,
        exportName: entry.exportName,
        displayName: entry.displayName,
        changeKind: ComponentChangeKind.RECHECKED,
        rank: rankBase + index,
        codeDiff: null,
        reason
      };
    });
    log.info(
      {
        event: "library.resolve",
        visualizationId: ctx.visualizationId,
        reused: reusedKept,
        toWrite: toWriteRows.length,
        rechecked: recheck.length,
        paused: false,
        trigger: trigger?.path ?? null,
        durationMs: this.deps.now() - started
      },
      "Library resolved"
    );
    return {
      plans,
      newHarnessCount,
      reusedCount: reusedKept,
      recheckedCount: recheck.length,
      globalStyleTrigger: trigger?.path ?? null,
      pause: false,
      skippedOverLimit: [...skipped.keys()],
      toWrite: toWriteRows.map((row) => ({ candidate: row.candidate, sides: [...row.writeSides] })),
      renderCandidates: [...kept.map((row) => row.candidate), ...recheckCandidates],
      writeRevisions
    };
  }

  /** Step 1: head and base identities of one analysed row (16 §8.4). */
  private async identitiesOf(candidate: ComponentCandidate, analysis: ChangeAnalysisResult): Promise<RowIdentities> {
    if (isReplacedCandidate(candidate)) {
      return {
        head: { filePath: candidate.filePath, exportName: candidate.exportName },
        base: {
          filePath: candidateBasePath(candidate, analysis.changedFiles) ?? candidate.predecessor.filePath,
          exportName: candidateBaseExport(candidate)
        }
      };
    }
    let basePath = candidate.filePath;
    try {
      basePath = (await analysis.sourceQueries.componentPaths(candidate.filePath)).base ?? candidate.filePath;
    } catch {
      // componentPaths never rejects (08 §5.1.1); fall back to the row's own path
    }
    const base = { filePath: basePath, exportName: candidate.exportName };
    if (candidate.changeKind === ComponentChangeKind.REMOVED) {
      return { head: null, base };
    }
    return { head: { filePath: candidate.filePath, exportName: candidate.exportName }, base };
  }

  /** 16 §8.1: the head fingerprint of the row's head identity differs from the entry's; null when either is null. */
  private async sourceChangedSinceWrite(
    ctx: PipelineContext,
    candidate: ComponentCandidate,
    entry: HarnessLibraryEntryRecord
  ): Promise<boolean | null> {
    if (entry.sourceFingerprint === null || candidate.changeKind === ComponentChangeKind.REMOVED) {
      return null;
    }
    try {
      const head = await this.deps.fingerprinter.fingerprint({
        framework: ctx.repository.framework,
        identity: { filePath: candidate.filePath, exportName: candidate.exportName },
        readFile: (path) => readConfinedText(ctx.workspace.headDir, path)
      });
      return head === null ? null : head !== entry.sourceFingerprint;
    } catch (error: unknown) {
      createLogger("library").warn(
        { event: "library.fingerprint.failed", componentId: candidate.componentId, error: getErrorMessage(error) },
        "Fingerprint failed"
      );
      return null;
    }
  }

  /** On pause, the counts the paused run's popup shows (16h): nothing else is written (16 §8.4 step 5). */
  private async persistPauseCounts(
    visualizationId: number,
    newHarnessCount: number,
    reusedCount: number
  ): Promise<void> {
    const response = await this.deps.queryHandler.update(
      { newHarnessCount, reusedHarnessCount: reusedCount },
      { id: visualizationId },
      Table.VISUALIZATIONS
    );
    if (response.status !== 200) {
      throw new Error(`pause counts update failed (${String(response.status)})`);
    }
  }

  private async updateRow(
    qh: QueryHandler,
    visualizationId: number,
    componentId: number,
    values: Record<string, unknown>
  ): Promise<void> {
    const response = await qh.update(values, { id: componentId, visualizationId }, Table.VISUALIZATION_COMPONENTS);
    if (response.status !== 200) {
      throw new Error(`component ${String(componentId)} update failed (${String(response.status)})`);
    }
  }
}
