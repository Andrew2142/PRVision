/**
 * In-memory HarnessLibraryStorePort (16 §6.11) for pipeline tests: the revision (E25) and status (E4, E26) rules
 * of 16c's store (16 §8.2) without a database. Records every call.
 */
import {
  identityKey,
  type HarnessLibraryEntryRecord,
  type HarnessLibraryStorePort,
  type LibraryComponentIdentity,
  type LibraryCounts,
  type LibraryRenderOutcome,
  type SaveWrittenHarnessInput,
  type SaveWrittenHarnessOutcome
} from "../../../backend/src/types/harness-library";

export interface FakeLibraryCall {
  method: keyof HarnessLibraryStorePort;
  args: unknown[];
}

/** A library entry with defaults (ready, revision 1, one Default state). */
export function libraryEntry(overrides: Partial<HarnessLibraryEntryRecord> = {}): HarnessLibraryEntryRecord {
  const harnessSource =
    overrides.harnessSource === undefined
      ? 'export default definePrvisionHarness({ states: [{ name: "Default", render: () => null }] });'
      : overrides.harnessSource;
  return {
    id: 1,
    repositoryId: 1,
    framework: "react_vite",
    filePath: "src/components/C1.tsx",
    exportName: "default",
    displayName: "C1",
    selector: null,
    sourceFingerprint: null,
    harnessSource,
    mockedModules: [],
    notes: "Saved notes.",
    states: harnessSource === null ? [] : [{ name: "Default", steps: [] }],
    stateAllowance: 3,
    status: harnessSource === null ? "needs_update" : "ready",
    origin: "run",
    revision: 1,
    lastError: null,
    lastFailedVisualizationId: null,
    aiModel: "claude-opus-5-5",
    aiUsage: null,
    costUsd: null,
    writtenAt: null,
    lastRenderedAt: null,
    ...overrides
  };
}

export class FakeLibraryStore implements HarnessLibraryStorePort {
  readonly entries = new Map<number, HarnessLibraryEntryRecord>();
  readonly calls: FakeLibraryCall[] = [];
  private nextId = 100;
  /** When set, every write method rejects with this error. */
  failWrites: Error | null = null;

  constructor(entries: HarnessLibraryEntryRecord[] = []) {
    for (const entry of entries) {
      this.entries.set(entry.id, { ...entry });
    }
  }

  callsOf(method: keyof HarnessLibraryStorePort): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  byIdentity(identity: LibraryComponentIdentity): HarnessLibraryEntryRecord | undefined {
    return [...this.entries.values()].find((entry) => identityKey(entry) === identityKey(identity));
  }

  findByIdentities(
    repositoryId: number,
    identities: readonly LibraryComponentIdentity[]
  ): Promise<Map<string, HarnessLibraryEntryRecord>> {
    this.calls.push({ method: "findByIdentities", args: [repositoryId, identities] });
    const wanted = new Set(identities.map(identityKey));
    const out = new Map<string, HarnessLibraryEntryRecord>();
    for (const entry of this.entries.values()) {
      if (entry.repositoryId === repositoryId && wanted.has(identityKey(entry))) {
        out.set(identityKey(entry), { ...entry });
      }
    }
    return Promise.resolve(out);
  }

  listForRepository(
    repositoryId: number,
    options: { withHarnessOnly?: boolean; onDefaultBranchOnly?: boolean } = {}
  ): Promise<HarnessLibraryEntryRecord[]> {
    this.calls.push({ method: "listForRepository", args: [repositoryId, options] });
    return Promise.resolve(
      [...this.entries.values()]
        .filter(
          (entry) =>
            entry.repositoryId === repositoryId &&
            (options.withHarnessOnly !== true || entry.harnessSource !== null) &&
            (options.onDefaultBranchOnly !== true || entry.status !== "off_default_branch")
        )
        .sort((a, b) => identityKey(a).localeCompare(identityKey(b)))
        .map((entry) => ({ ...entry }))
    );
  }

  get(entryId: number): Promise<HarnessLibraryEntryRecord | null> {
    this.calls.push({ method: "get", args: [entryId] });
    const entry = this.entries.get(entryId);
    return Promise.resolve(entry === undefined ? null : { ...entry });
  }

  saveWritten(input: SaveWrittenHarnessInput): Promise<SaveWrittenHarnessOutcome> {
    this.calls.push({ method: "saveWritten", args: [input] });
    if (this.failWrites !== null) {
      return Promise.reject(this.failWrites);
    }
    const existing = this.byIdentity(input.identity);
    const fields = {
      framework: input.framework,
      displayName: input.displayName,
      selector: input.selector,
      sourceFingerprint: input.sourceFingerprint,
      harnessSource: input.harness?.harnessSource ?? null,
      mockedModules: input.harness?.mockedModules ?? [],
      notes: input.harness?.notes ?? "",
      states: input.harness?.states ?? [],
      stateAllowance: input.stateAllowance,
      status: input.status,
      origin: input.origin,
      lastError: input.status === "ready" ? null : input.lastError,
      lastFailedVisualizationId: input.lastFailedVisualizationId,
      aiModel: input.aiModel,
      aiUsage: input.aiUsage
    };
    if (existing === undefined) {
      const entry = libraryEntry({
        id: (this.nextId += 1),
        repositoryId: input.repositoryId,
        filePath: input.identity.filePath,
        exportName: input.identity.exportName,
        ...fields,
        revision: 1
      });
      this.entries.set(entry.id, entry);
      return Promise.resolve({ saved: true, entry: { ...entry } });
    }
    if (input.expectedRevision !== null && input.expectedRevision !== existing.revision) {
      return Promise.resolve({ saved: false, reason: "revision_changed", current: { ...existing } });
    }
    const entry = { ...existing, ...fields, revision: existing.revision + 1 };
    this.entries.set(entry.id, entry);
    return Promise.resolve({ saved: true, entry: { ...entry } });
  }

  markRenderOutcome(entryId: number, outcome: LibraryRenderOutcome): Promise<void> {
    this.calls.push({ method: "markRenderOutcome", args: [entryId, outcome] });
    if (this.failWrites !== null) {
      return Promise.reject(this.failWrites);
    }
    const entry = this.entries.get(entryId);
    if (entry !== undefined) {
      this.entries.set(
        entryId,
        outcome.ok
          ? {
              ...entry,
              status: entry.harnessSource === null ? entry.status : "ready",
              lastRenderedAt: outcome.at,
              lastError: null
            }
          : {
              ...entry,
              status: "needs_update",
              lastError: outcome.error,
              lastFailedVisualizationId: outcome.visualizationId
            }
      );
    }
    return Promise.resolve();
  }

  moveIdentity(entryId: number, to: LibraryComponentIdentity & { displayName: string }): Promise<void> {
    this.calls.push({ method: "moveIdentity", args: [entryId, to] });
    const entry = this.entries.get(entryId);
    if (entry !== undefined && this.byIdentity(to) === undefined) {
      this.entries.set(entryId, {
        ...entry,
        filePath: to.filePath,
        exportName: to.exportName,
        displayName: to.displayName
      });
    }
    return Promise.resolve();
  }

  markOffDefaultBranch(repositoryId: number, entryIds: readonly number[]): Promise<number> {
    this.calls.push({ method: "markOffDefaultBranch", args: [repositoryId, entryIds] });
    return Promise.resolve(0);
  }

  restoreOnDefaultBranch(repositoryId: number, entryIds: readonly number[]): Promise<number> {
    this.calls.push({ method: "restoreOnDefaultBranch", args: [repositoryId, entryIds] });
    return Promise.resolve(0);
  }

  counts(repositoryId: number, currentAllowance: number): Promise<LibraryCounts> {
    this.calls.push({ method: "counts", args: [repositoryId, currentAllowance] });
    return Promise.resolve({
      total: this.entries.size,
      ready: 0,
      needsUpdate: 0,
      withoutHarness: 0,
      otherAllowance: 0
    });
  }
}
