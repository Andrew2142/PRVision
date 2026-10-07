/**
 * Pure planning of render work items (16 §9.1, §12.3 step 2): the state plan of a row and the work items built from
 * persisted run rows. Shared by both render services (states) and live mode (16i builds its hosts from these
 * items). No I/O: file existence, layouts and mock labels are the render services' job.
 */
import { MAX_STATE_ORDINALS } from "../../../../config-consts/render.config";
import type { RepositoryModel, VisualizationComponentModel } from "../../../../models";
import { DEFAULT_STATE_NAME, type HarnessStateSpec } from "../../../../types/harness-library";
import type {
  ComponentCandidate,
  HarnessGenerationResult,
  MockedModule
} from "../../../../types/visualization-pipeline";
import { validateMockedModules } from "../mock-rules";
import { mockFingerprint } from "./render-groups";
import type { RenderWorkItem, StatePlan } from "./render-types";
import { isTwoSidedItem, sideHarnessOf, twoSidedFingerprint } from "./replaced-harness";

const DEFAULT_ONLY: readonly HarnessStateSpec[] = [{ name: DEFAULT_STATE_NAME, steps: [] }];

function orDefault(states: readonly HarnessStateSpec[] | null | undefined): readonly HarnessStateSpec[] {
  return states === null || states === undefined || states.length === 0 ? DEFAULT_ONLY : states;
}

/**
 * The states of one row (16 §9.1). Same-harness rows: the harness's states on every present side. Replaced rows
 * (`baseStates` given): head states in head order, then base-only states in base order, matched by name (E9).
 * At most MAX_STATE_ORDINALS states.
 *
 * @param headStates - States of the head (or only) harness; [] counts as one Default state.
 * @param baseStates - States of a replaced row's base harness, or null for same-harness rows.
 * @param sides - Which sides the row has.
 */
export function planStates(
  headStates: readonly HarnessStateSpec[],
  baseStates: readonly HarnessStateSpec[] | null,
  sides: { base: boolean; head: boolean }
): StatePlan[] {
  const plans: StatePlan[] = [];
  if (baseStates === null) {
    for (const state of orDefault(headStates)) {
      plans.push({
        ordinal: plans.length,
        name: state.name,
        onBase: sides.base,
        onHead: sides.head,
        steps: state.steps
      });
    }
    return plans.slice(0, MAX_STATE_ORDINALS);
  }
  const head = sides.head ? orDefault(headStates) : [];
  const base = sides.base ? orDefault(baseStates) : [];
  const baseNames = new Set(base.map((state) => state.name));
  const headNames = new Set(head.map((state) => state.name));
  for (const state of head) {
    plans.push({
      ordinal: plans.length,
      name: state.name,
      onBase: baseNames.has(state.name),
      onHead: true,
      steps: state.steps
    });
  }
  for (const state of base) {
    if (!headNames.has(state.name)) {
      plans.push({ ordinal: plans.length, name: state.name, onBase: true, onHead: false, steps: state.steps });
    }
  }
  return plans.slice(0, MAX_STATE_ORDINALS);
}

/** The states of a work item from its harness (both sides of a replaced row). */
export function planItemStates(item: Pick<RenderWorkItem, "candidate" | "harness" | "sides">): StatePlan[] {
  const twoSided = isTwoSidedItem(item);
  return planStates(item.harness.states, twoSided ? sideHarnessOf(item.harness, "base").states : null, item.sides);
}

/**
 * A work item without any I/O: accepted mocks, group fingerprint, states and origins. `mockLabels` stays empty and
 * `plannedFailures` null (the render services fill them from the worktrees).
 */
export function planWorkItem(input: {
  candidate: ComponentCandidate;
  harness: HarnessGenerationResult;
  paths: { base: string | null; head: string | null };
}): RenderWorkItem {
  const { candidate, harness, paths } = input;
  const sides = { base: paths.base !== null, head: paths.head !== null };
  const item: RenderWorkItem = {
    candidate,
    harness,
    paths,
    acceptedMocks: validateMockedModules(harness.mockedModules).accepted,
    fingerprint: "none",
    sides,
    primarySide: sides.head ? "head" : "base",
    repairsUsed: 0,
    mockLabels: new Map(),
    plannedFailures: { base: null, head: null },
    states: [],
    origin: harness.origin
  };
  if (isTwoSidedItem(item)) {
    const base = sideHarnessOf(harness, "base");
    const baseMocks = validateMockedModules(base.mockedModules).accepted;
    item.baseAcceptedMocks = baseMocks;
    item.baseOrigin = base.origin;
    item.fingerprint = twoSidedFingerprint(
      paths.base ?? candidate.filePath,
      baseMocks,
      paths.head ?? candidate.filePath,
      item.acceptedMocks
    );
  } else {
    item.fingerprint = mockFingerprint(paths.head ?? paths.base ?? candidate.filePath, item.acceptedMocks);
  }
  item.states = planItemStates(item);
  return item;
}

function mockedModulesOf(value: unknown): MockedModule[] {
  return Array.isArray(value)
    ? value.filter(
        (mock): mock is MockedModule =>
          typeof mock === "object" &&
          mock !== null &&
          typeof (mock as { specifier?: unknown }).specifier === "string" &&
          typeof (mock as { source?: unknown }).source === "string"
      )
    : [];
}

function originOf(value: string | null): "library" | "written" {
  return value === "library" ? "library" : "written";
}

/**
 * Render work items from a finished run's component rows (16 §12.3 step 2): the harness snapshot columns, change
 * kind and paths. Rows without a harness snapshot are left out. The caller passes the states it extracted from the
 * snapshots (`baseStates` for replaced rows). Renamed same-harness rows render the head path on both sides (the
 * run's rename information is not persisted on the row).
 */
export function planLiveItems(
  rows: ReadonlyArray<{
    row: VisualizationComponentModel;
    states: HarnessStateSpec[];
    baseStates: HarnessStateSpec[] | null;
  }>,
  _repository: RepositoryModel // 16 §12.3 signature; layouts and mock labels are resolved by the caller (16i)
): RenderWorkItem[] {
  const items: RenderWorkItem[] = [];
  for (const { row, states, baseStates } of [...rows].sort((a, b) => a.row.rank - b.row.rank)) {
    const harnessSource = row.harnessSource ?? null;
    if (harnessSource === null || harnessSource.trim() === "") {
      continue;
    }
    const replaced = row.changeKind === "replaced";
    const baseSource = row.baseHarnessSource ?? null;
    const basePathOfRow = row.baseFilePath ?? null;
    const candidate: ComponentCandidate = {
      componentId: row.id,
      filePath: row.filePath,
      exportName: row.exportName,
      displayName: row.displayName,
      changeKind: row.changeKind,
      rank: row.rank,
      codeDiff: row.codeDiff ?? null,
      reason: row.changeReason ?? "",
      ...(replaced && basePathOfRow !== null
        ? {
            predecessor: {
              filePath: basePathOfRow,
              exportName: row.baseExportName ?? row.exportName,
              displayName: row.baseDisplayName ?? row.displayName,
              evidence: []
            }
          }
        : {})
    };
    const harness: HarnessGenerationResult = {
      componentId: row.id,
      harnessSource,
      mockedModules: mockedModulesOf(row.mockedModules),
      notes: row.harnessNotes ?? "",
      states,
      origin: originOf(row.harnessOrigin ?? null),
      libraryEntryId: row.libraryEntryId ?? null,
      ...(replaced && baseSource !== null
        ? {
            baseHarness: {
              harnessSource: baseSource,
              mockedModules: mockedModulesOf(row.baseMockedModules),
              notes: row.baseHarnessNotes ?? "",
              states: baseStates ?? [],
              origin: originOf(row.baseHarnessOrigin ?? null),
              libraryEntryId: row.baseLibraryEntryId ?? null
            }
          }
        : {})
    };
    const paths = {
      base: row.changeKind === "added" ? null : replaced ? basePathOfRow : row.filePath,
      head: row.changeKind === "removed" ? null : row.filePath
    };
    if (paths.base === null && paths.head === null) {
      continue;
    }
    items.push(planWorkItem({ candidate, harness, paths }));
  }
  return items;
}
