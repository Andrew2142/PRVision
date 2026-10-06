import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NO_MOCKS_GROUP_KEY,
  buildRenderGroups,
  mockFingerprint,
  normalizeMockMatchKey
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
    plannedFailures: { base: null, head: null }
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
