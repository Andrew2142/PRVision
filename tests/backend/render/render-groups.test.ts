import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS,
  RENDER_GROUP_STARTUP_ALLOWANCE_MS,
  RENDER_PAGE_CONCURRENCY,
  RENDER_STAGE_MS_PER_PAGE,
  RENDER_STAGE_TIMEOUT_MAX_MS,
  RENDER_STAGE_TIMEOUT_MS
} from "../../../backend/src/config-consts";
import {
  NO_MOCKS_GROUP_KEY,
  buildRenderGroups,
  mockFingerprint,
  normalizeMockMatchKey,
  plannedPagesOf,
  renderStageBudgetMs,
  splitLargeGroups
} from "../../../backend/src/services/visualizations/pipeline/render/render-groups";
import type { RenderWorkItem } from "../../../backend/src/services/visualizations/pipeline/render/render-types";
import type { MockedModule } from "../../../backend/src/types/visualization-pipeline";
import { candidate, harnessFor } from "./helpers/render-stubs";

function item(componentId: number, filePath: string, rank: number, mocks: MockedModule[] = []): RenderWorkItem {
  return {
    candidate: candidate(componentId, filePath, "modified", rank),
    harness: harnessFor(componentId, filePath, mocks),
    paths: { base: filePath, head: filePath },
    acceptedMocks: mocks,
    fingerprint: mockFingerprint(filePath, mocks),
    sides: { base: true, head: true },
    primarySide: "head",
    repairsUsed: 0,
    mockLabels: new Map(),
    plannedFailures: { base: null, head: null },
    states: [{ ordinal: 0, name: "Default", onBase: true, onHead: true, steps: [] }],
    origin: "written"
  };
}

const API_MOCK: MockedModule = { specifier: "@/lib/api", source: "export const fetchUser = () => null;" };

test('components without mocks share the "none" group', () => {
  const groups = buildRenderGroups([item(1, "src/A.tsx", 0), item(2, "src/b/B.tsx", 1)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.key, NO_MOCKS_GROUP_KEY);
  assert.deepEqual(
    groups[0].items.map((entry) => entry.candidate.componentId),
    [1, 2]
  );
});

test("identical mocks on components in different folders share a group for bare specifiers", () => {
  const a = mockFingerprint("src/components/A.tsx", [API_MOCK]);
  const b = mockFingerprint("src/pages/deep/B.tsx", [API_MOCK]);
  assert.equal(a, b);
  assert.notEqual(a, NO_MOCKS_GROUP_KEY);
  const groups = buildRenderGroups([
    item(1, "src/components/A.tsx", 0, [API_MOCK]),
    item(2, "src/pages/deep/B.tsx", 1, [API_MOCK])
  ]);
  assert.equal(groups.length, 1);
});

test("relative specifier fingerprints depend on the component directory", () => {
  const mock: MockedModule = { specifier: "../api/client", source: "export const x = 1;" };
  assert.equal(normalizeMockMatchKey("src/components/A.tsx", "../api/client"), "rel:src/api/client");
  assert.equal(normalizeMockMatchKey("src/components/A.tsx", "@/api"), "spec:@/api");
  assert.notEqual(mockFingerprint("src/components/A.tsx", [mock]), mockFingerprint("src/pages/x/B.tsx", [mock]));
  // Same target file through different relative paths → same key.
  assert.equal(
    mockFingerprint("src/components/A.tsx", [mock]),
    mockFingerprint("src/hooks/useA.ts", [{ specifier: "../api/client", source: "export const x = 1;" }])
  );
});

test("mock order does not change the fingerprint", () => {
  const other: MockedModule = { specifier: "date-fns", source: "export const format = () => 'x';" };
  assert.equal(mockFingerprint("src/A.tsx", [API_MOCK, other]), mockFingerprint("src/A.tsx", [other, API_MOCK]));
});

test("groups are ordered none-first then by best rank, items by rank then id", () => {
  const otherMock: MockedModule = { specifier: "date-fns", source: "export const format = () => 'x';" };
  const groups = buildRenderGroups([
    item(5, "src/E.tsx", 4, [otherMock]),
    item(3, "src/C.tsx", 2, [API_MOCK]),
    item(4, "src/D.tsx", 0, [otherMock]),
    item(2, "src/B.tsx", 3),
    item(1, "src/A.tsx", 3),
    item(6, "src/F.tsx", 1, [API_MOCK])
  ]);
  assert.equal(groups[0]?.key, NO_MOCKS_GROUP_KEY);
  assert.deepEqual(
    groups.map((group) => group.items.map((entry) => entry.candidate.componentId)),
    [
      [1, 2],
      [4, 5],
      [6, 3]
    ]
  );
});

// ---- 16 §9.2: group splitting and the dynamic stage budget ----

test("splitLargeGroups keeps small groups and cuts large ones into <key>#<n> chunks in order", () => {
  const items = Array.from({ length: 5 }, (_, index) => item(index + 1, `src/C${String(index)}.tsx`, index));
  const [split1, split2, split3, small] = splitLargeGroups(
    [
      { key: "none", items },
      { key: "abc", items: items.slice(0, 2) }
    ],
    2
  ).map((group) => [group.key, group.items.map((entry) => entry.candidate.componentId)]);
  assert.deepEqual(split1, ["none#1", [1, 2]]);
  assert.deepEqual(split2, ["none#2", [3, 4]]);
  assert.deepEqual(split3, ["none#3", [5]]);
  assert.deepEqual(small, ["abc", [1, 2]]);
});

test("renderStageBudgetMs: floor, page term, host starts per framework and the ceiling", () => {
  const plan = (states: number, onBase = true): RenderWorkItem["states"] =>
    Array.from({ length: states }, (_, ordinal) => ({
      ordinal,
      name: ordinal === 0 ? "Default" : `S${String(ordinal)}`,
      onBase,
      onHead: true,
      steps: []
    }));
  const items = (count: number, states: number): Array<Pick<RenderWorkItem, "states" | "sides">> =>
    Array.from({ length: count }, () => ({ states: plan(states), sides: { base: true, head: true } }));
  const group = (count: number): Array<{ items: Array<Pick<RenderWorkItem, "sides">> }> => [
    { items: Array.from({ length: count }, () => ({ sides: { base: true, head: true } })) }
  ];
  const cases: Array<{ name: string; framework: "react_vite" | "angular"; got: number; expected: number }> = [
    {
      name: "small run is the floor",
      framework: "react_vite",
      got: renderStageBudgetMs("react_vite", items(3, 1), group(3)),
      expected: RENDER_STAGE_TIMEOUT_MS
    },
    {
      // 200 × 3 × 2 = 1 200 pages → 300 × 2 500 = 750 000; 5 groups × 2 sides × 20 000 = 200 000 → 950 000
      name: "200 components × 3 states (React)",
      framework: "react_vite",
      got: renderStageBudgetMs("react_vite", items(200, 3), [
        ...group(40),
        ...group(40),
        ...group(40),
        ...group(40),
        ...group(40)
      ]),
      expected: 300 * RENDER_STAGE_MS_PER_PAGE + 10 * RENDER_GROUP_STARTUP_ALLOWANCE_MS
    },
    {
      name: "Angular builds dominate",
      framework: "angular",
      got: renderStageBudgetMs("angular", items(10, 1), [...group(5), ...group(5), ...group(5)]),
      expected:
        Math.ceil(20 / RENDER_PAGE_CONCURRENCY) * RENDER_STAGE_MS_PER_PAGE +
        6 * ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS
    },
    {
      name: "ceiling",
      framework: "react_vite",
      got: renderStageBudgetMs("react_vite", items(3000, 5), group(1)),
      expected: RENDER_STAGE_TIMEOUT_MAX_MS
    }
  ];
  for (const entry of cases) {
    assert.equal(entry.got, entry.expected, entry.name);
  }
  // A state absent on base is not a page there.
  assert.equal(plannedPagesOf({ states: plan(2, false), sides: { base: true, head: true } }), 2);
  assert.equal(plannedPagesOf({ states: plan(2), sides: { base: false, head: true } }), 2);
});
