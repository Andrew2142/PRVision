/**
 * The per-repository harness library (16 §8.2): one saved harness per component identity (E1), written with
 * optimistic revisions (E25), status refreshed by renders (E4, E5) and marked — never deleted — by scans (E26).
 * Every statement goes through QueryHandler; multi-statement writes run in one DrizzleDb transaction.
 */
import { RENDER_ERROR_MAX_CHARS } from "../../config-consts";
import { HarnessLibraryStatus, Table } from "../../enums";
import { HarnessLibraryEntryModel } from "../../models";
import {
  identityKey,
  type HarnessLibraryEntryRecord,
  type HarnessLibraryStorePort,
  type HarnessStateSpec,
  type LibraryComponentIdentity,
  type LibraryCounts,
  type LibraryRenderOutcome,
  type SaveWrittenHarnessInput,
  type SaveWrittenHarnessOutcome
} from "../../types/harness-library";
import type { AiUsage, MockedModule } from "../../types/visualization-pipeline";
import {
  createLogger,
  DrizzleDb,
  QueryHandler,
  usageCostUsd,
  Where,
  type ApiResponse,
  type Conditions,
  type Transaction
} from "../../utilities";

const log = createLogger("library");

/** `notes` cap of a library entry (16 §6.3). */
export const LIBRARY_NOTES_MAX_CHARS = 4_000;

/** Collaborators; defaults are the real database. */
export interface HarnessLibraryStoreDeps {
  queryHandler: QueryHandler;
  /** Default DrizzleDb.transaction. */
  runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createQueryHandler(tx: Transaction): QueryHandler;
  now(): Date;
}

/** Thrown inside a transaction to roll it back after a unique violation; the save is retried once. */
class IdentityRaceError extends Error {
  override readonly name = "IdentityRaceError";
}

function capped(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function isStateSpec(value: unknown): value is HarnessStateSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    Array.isArray((value as { steps?: unknown }).steps)
  );
}

function isMockedModule(value: unknown): value is MockedModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { specifier?: unknown }).specifier === "string" &&
    typeof (value as { source?: unknown }).source === "string"
  );
}

/** Generated model → record; jsonb arrays filtered defensively (16 §8.2). */
export function toHarnessLibraryEntryRecord(model: HarnessLibraryEntryModel): HarnessLibraryEntryRecord {
  const states: unknown = model.states;
  const mocks: unknown = model.mockedModules;
  return {
    id: model.id,
    repositoryId: model.repositoryId,
    framework: model.framework,
    filePath: model.filePath,
    exportName: model.exportName,
    displayName: model.displayName,
    selector: model.selector ?? null,
    sourceFingerprint: model.sourceFingerprint ?? null,
    harnessSource: model.harnessSource ?? null,
    mockedModules: Array.isArray(mocks) ? mocks.filter(isMockedModule) : [],
    notes: model.notes,
    states: Array.isArray(states) ? states.filter(isStateSpec) : [],
    stateAllowance: model.stateAllowance,
    status: model.status,
    origin: model.origin,
    revision: model.revision,
    lastError: model.lastError ?? null,
    lastFailedVisualizationId: model.lastFailedVisualizationId ?? null,
    aiModel: model.aiModel ?? null,
    aiUsage: model.aiUsage ?? null,
    costUsd: model.costUsd ?? null,
    writtenAt: model.writtenAt ?? null,
    lastRenderedAt: model.lastRenderedAt ?? null
  };
}

function requireOk<T>(response: ApiResponse<T>, what: string): T | undefined {
  if (response.status >= 400) {
    const detail = response.error === undefined ? `status ${String(response.status)}` : String(response.error);
    throw new Error(`Harness library ${what} failed: ${detail}`);
  }
  return response.data;
}

/** The library store (16 §8.2). Implements the port every later task depends on. */
export class HarnessLibraryStore implements HarnessLibraryStorePort {
  private readonly deps: HarnessLibraryStoreDeps;

  constructor(deps: Partial<HarnessLibraryStoreDeps> = {}) {
    this.deps = {
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      runInTransaction: deps.runInTransaction ?? ((fn) => DrizzleDb.transaction(fn)),
      createQueryHandler: deps.createQueryHandler ?? ((tx) => new QueryHandler(tx)),
      now: deps.now ?? ((): Date => new Date())
    };
  }

  /** Entries of the given identities, keyed by `identityKey` (one select by file path, filtered by export). */
  async findByIdentities(
    repositoryId: number,
    identities: readonly LibraryComponentIdentity[]
  ): Promise<Map<string, HarnessLibraryEntryRecord>> {
    const result = new Map<string, HarnessLibraryEntryRecord>();
    if (identities.length === 0) {
      return result;
    }
    const wanted = new Set(identities.map((identity) => identityKey(identity)));
    const paths = [...new Set(identities.map((identity) => identity.filePath))];
    const models = await this.deps.queryHandler.selectMany(
      HarnessLibraryEntryModel,
      { repositoryId, filePath: Where.in(paths) },
      Table.HARNESS_LIBRARY_ENTRIES
    );
    for (const model of models) {
      const record = toHarnessLibraryEntryRecord(model);
      const key = identityKey(record);
      if (wanted.has(key)) {
        result.set(key, record);
      }
    }
    return result;
  }

  /** Entries of a repository ordered by file path and export name. */
  async listForRepository(
    repositoryId: number,
    options: { withHarnessOnly?: boolean; onDefaultBranchOnly?: boolean } = {}
  ): Promise<HarnessLibraryEntryRecord[]> {
    const conditions: Conditions = { repositoryId };
    if (options.withHarnessOnly === true) {
      conditions.harnessSource = Where.isNotNull();
    }
    if (options.onDefaultBranchOnly === true) {
      conditions.status = Where.ne(HarnessLibraryStatus.OFF_DEFAULT_BRANCH);
    }
    const models = await this.deps.queryHandler.selectMany(
      HarnessLibraryEntryModel,
      conditions,
      Table.HARNESS_LIBRARY_ENTRIES,
      {
        orderBy: [
          { column: "filePath", direction: "asc" },
          { column: "exportName", direction: "asc" }
        ]
      }
    );
    return models.map(toHarnessLibraryEntryRecord);
  }

  /** One entry by id, or null. */
  async get(entryId: number): Promise<HarnessLibraryEntryRecord | null> {
    const model = await this.deps.queryHandler.validateAndSelect(
      HarnessLibraryEntryModel,
      { id: entryId },
      Table.HARNESS_LIBRARY_ENTRIES
    );
    return model === null ? null : toHarnessLibraryEntryRecord(model);
  }

  /**
   * Saves a written harness: insert, or replace with revision + 1 under the optimistic rule of E25. A unique
   * violation on insert (a concurrent writer inserted first) re-runs the whole save once.
   */
  async saveWritten(input: SaveWrittenHarnessInput): Promise<SaveWrittenHarnessOutcome> {
    try {
      return await this.saveOnce(input);
    } catch (error: unknown) {
      if (!(error instanceof IdentityRaceError)) {
        throw error;
      }
      return this.saveOnce(input);
    }
  }

  private async saveOnce(input: SaveWrittenHarnessInput): Promise<SaveWrittenHarnessOutcome> {
    const outcome = await this.deps.runInTransaction(async (tx) => {
      const queryHandler = this.deps.createQueryHandler(tx);
      const existing = await queryHandler.validateAndSelect(
        HarnessLibraryEntryModel,
        {
          repositoryId: input.repositoryId,
          filePath: input.identity.filePath,
          exportName: input.identity.exportName
        },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      const values = this.harnessValues(input);
      if (existing === null) {
        const inserted = await queryHandler.insert(
          {
            repositoryId: input.repositoryId,
            framework: input.framework,
            filePath: input.identity.filePath,
            exportName: input.identity.exportName,
            revision: 1,
            ...values
          },
          Table.HARNESS_LIBRARY_ENTRIES
        );
        if (inserted.status === 409) {
          throw new IdentityRaceError("A concurrent writer inserted the same library identity.");
        }
        const id = QueryHandler.firstInsertedId(inserted);
        if (requireOk(inserted, "insert") === undefined || id === null) {
          throw new Error("Harness library insert returned no row.");
        }
        return { saved: true as const, id };
      }
      const current = toHarnessLibraryEntryRecord(existing);
      if (input.expectedRevision !== null && input.expectedRevision !== current.revision) {
        return { saved: false as const, current };
      }
      const updated = await queryHandler.update(
        { ...values, revision: current.revision + 1 },
        { id: current.id, revision: current.revision },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      if (updated.status === 404) {
        // Rewritten between the select and the update (outside this transaction's snapshot).
        const latest = await queryHandler.validateAndSelect(
          HarnessLibraryEntryModel,
          { id: current.id },
          Table.HARNESS_LIBRARY_ENTRIES
        );
        return { saved: false as const, current: latest === null ? current : toHarnessLibraryEntryRecord(latest) };
      }
      requireOk(updated, "update");
      return { saved: true as const, id: current.id };
    });
    if (!outcome.saved) {
      log.info(
        {
          event: "library.entry.kept_newer",
          repositoryId: input.repositoryId,
          entryId: outcome.current.id,
          revision: outcome.current.revision,
          expectedRevision: input.expectedRevision
        },
        "Kept the newer library entry"
      );
      return { saved: false, reason: "revision_changed", current: outcome.current };
    }
    const entry = await this.get(outcome.id);
    if (entry === null) {
      throw new Error(`Harness library entry ${String(outcome.id)} disappeared after saving.`);
    }
    log.info(
      {
        event: "library.entry.saved",
        repositoryId: input.repositoryId,
        entryId: entry.id,
        revision: entry.revision,
        status: entry.status,
        origin: entry.origin
      },
      "Library entry saved"
    );
    return { saved: true, entry };
  }

  /** Every harness field of a save (insert and replace share them). */
  private harnessValues(input: SaveWrittenHarnessInput): Record<string, unknown> {
    const harness = input.harness;
    const aiUsage: AiUsage | null = input.aiUsage;
    const costUsd = input.aiModel !== null && aiUsage !== null ? usageCostUsd(input.aiModel, aiUsage).usd : null;
    return {
      displayName: input.displayName,
      selector: input.selector,
      sourceFingerprint: input.sourceFingerprint,
      harnessSource: harness?.harnessSource ?? null,
      mockedModules: harness?.mockedModules ?? [],
      notes: capped(harness?.notes ?? "", LIBRARY_NOTES_MAX_CHARS),
      states: harness?.states ?? [],
      stateCount: harness === null ? 0 : harness.states.length,
      stateAllowance: input.stateAllowance,
      status: input.status,
      origin: input.origin,
      lastError:
        input.status === HarnessLibraryStatus.READY || input.lastError === null
          ? null
          : capped(input.lastError, RENDER_ERROR_MAX_CHARS),
      lastFailedVisualizationId: input.lastFailedVisualizationId,
      aiModel: input.aiModel,
      aiUsage,
      costUsd,
      writtenAt: this.deps.now()
    };
  }

  /** Status refresh from a render on the status side (E4); never touches the harness. */
  async markRenderOutcome(entryId: number, outcome: LibraryRenderOutcome): Promise<void> {
    if (outcome.ok) {
      const ready = await this.deps.queryHandler.update(
        { status: HarnessLibraryStatus.READY, lastRenderedAt: outcome.at, lastError: null },
        { id: entryId, harnessSource: Where.isNotNull() },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      if (ready.status === 404) {
        // No harness: a successful render cannot make it ready; only the timestamps change.
        await this.updateExisting(entryId, { lastRenderedAt: outcome.at, lastError: null });
      } else {
        requireOk(ready, "render outcome");
      }
    } else {
      await this.updateExisting(entryId, {
        status: HarnessLibraryStatus.NEEDS_UPDATE,
        lastError: capped(outcome.error, RENDER_ERROR_MAX_CHARS),
        lastFailedVisualizationId: outcome.visualizationId
      });
    }
    log.debug(
      { event: "library.entry.render_outcome", entryId, ok: outcome.ok },
      "Library entry render outcome recorded"
    );
  }

  private async updateExisting(entryId: number, values: Record<string, unknown>): Promise<void> {
    const response = await this.deps.queryHandler.update(values, { id: entryId }, Table.HARNESS_LIBRARY_ENTRIES);
    if (response.status !== 404) {
      requireOk(response, "update");
    }
  }

  /** Moves an entry to a renamed component's identity; a no-op when an entry already exists there (the target wins). */
  async moveIdentity(entryId: number, to: LibraryComponentIdentity & { displayName: string }): Promise<void> {
    await this.deps.runInTransaction(async (tx) => {
      const queryHandler = this.deps.createQueryHandler(tx);
      const entry = await queryHandler.validateAndSelect(
        HarnessLibraryEntryModel,
        { id: entryId },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      if (entry === null) {
        return;
      }
      if (entry.filePath === to.filePath && entry.exportName === to.exportName) {
        return;
      }
      const target = await queryHandler.validateAndSelect(
        HarnessLibraryEntryModel,
        { repositoryId: entry.repositoryId, filePath: to.filePath, exportName: to.exportName },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      if (target !== null) {
        return;
      }
      const response = await queryHandler.update(
        { filePath: to.filePath, exportName: to.exportName, displayName: to.displayName },
        { id: entryId },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      if (response.status !== 409) {
        requireOk(response, "move");
      }
    });
  }

  /** E26: marks entries `off_default_branch`; returns the number of rows changed. Never deletes. */
  async markOffDefaultBranch(repositoryId: number, entryIds: readonly number[]): Promise<number> {
    if (entryIds.length === 0) {
      return 0;
    }
    const response = await this.deps.queryHandler.update(
      { status: HarnessLibraryStatus.OFF_DEFAULT_BRANCH },
      {
        repositoryId,
        id: Where.in([...entryIds]),
        status: Where.ne(HarnessLibraryStatus.OFF_DEFAULT_BRANCH)
      },
      Table.HARNESS_LIBRARY_ENTRIES
    );
    return this.rowsAffected(response, "mark");
  }

  /**
   * E26: restores marked entries found again — `ready` with a harness and no last error, else `needs_update`.
   * Returns the number of rows changed.
   */
  async restoreOnDefaultBranch(repositoryId: number, entryIds: readonly number[]): Promise<number> {
    if (entryIds.length === 0) {
      return 0;
    }
    return this.deps.runInTransaction(async (tx) => {
      const queryHandler = this.deps.createQueryHandler(tx);
      const marked = { repositoryId, id: Where.in([...entryIds]), status: HarnessLibraryStatus.OFF_DEFAULT_BRANCH };
      const ready = await queryHandler.update(
        { status: HarnessLibraryStatus.READY },
        { ...marked, harnessSource: Where.isNotNull(), lastError: Where.isNull() },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      const rest = await queryHandler.update(
        { status: HarnessLibraryStatus.NEEDS_UPDATE },
        marked,
        Table.HARNESS_LIBRARY_ENTRIES
      );
      return this.rowsAffected(ready, "restore") + this.rowsAffected(rest, "restore");
    });
  }

  private rowsAffected(response: ApiResponse<{ rowsAffected: number }>, what: string): number {
    if (response.status === 404) {
      return 0;
    }
    return requireOk(response, what)?.rowsAffected ?? 0;
  }

  /** Library counts of a repository; `off_default_branch` entries are never counted (E26). */
  async counts(repositoryId: number, currentAllowance: number): Promise<LibraryCounts> {
    const onBranch: Conditions = { repositoryId, status: Where.ne(HarnessLibraryStatus.OFF_DEFAULT_BRANCH) };
    const count = async (conditions: Conditions): Promise<number> =>
      requireOk(await this.deps.queryHandler.count(conditions, Table.HARNESS_LIBRARY_ENTRIES), "count")?.count ?? 0;
    const [total, ready, needsUpdate, withoutHarness, otherAllowance] = await Promise.all([
      count(onBranch),
      count({ repositoryId, status: HarnessLibraryStatus.READY }),
      count({ repositoryId, status: HarnessLibraryStatus.NEEDS_UPDATE }),
      count({ repositoryId, status: HarnessLibraryStatus.NEEDS_UPDATE, harnessSource: Where.isNull() }),
      count({ ...onBranch, harnessSource: Where.isNotNull(), stateAllowance: Where.ne(currentAllowance) })
    ]);
    return { total, ready, needsUpdate, withoutHarness, otherAllowance };
  }
}
