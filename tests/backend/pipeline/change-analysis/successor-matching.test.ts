/**
 * Successor matching core (00 §17): evidence helpers, scoring, threshold, one-to-one greedy pairing and the
 * `replaced` draft it produces. Framework evidence extraction is covered by the React and Angular analysis tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SUCCESSOR_MIN_SCORE,
  callSiteSwapEvidence,
  callSiteSwapPlace,
  componentNameStem,
  contentSimilarityEvidence,
  editDistance,
  featureFolder,
  gitRenameEvidence,
  jaccardSimilarity,
  markupTokens,
  matchSuccessors,
  nameSimilarityEvidence,
  pairSuccessors,
  replacementReason,
  sortEvidence,
  sourceQueryRows,
  successorScore
} from "../../../../backend/src/services/visualizations/pipeline/successor-matching";
import type { DraftCandidate } from "../../../../backend/src/types/change-analysis";
import type { SuccessorEvidence } from "../../../../backend/src/types/visualization-pipeline";

const EVENTS = "src/app/modules/events";

function draft(overrides: Partial<DraftCandidate>): DraftCandidate {
  return {
    filePath: "src/components/X.tsx",
    exportName: "default",
    displayName: "X",
    changeKind: "modified",
    codeDiff: null,
    reason: "Component code changed",
    diffSize: 1,
    depth: 0,
    forcedSkipReason: null,
    ...overrides
  };
}

const swap = (place: string): SuccessorEvidence => callSiteSwapEvidence(place, "<app-a>", "<app-b>");
const rename: SuccessorEvidence = { kind: "git_rename", detail: "a → b" };
const name: SuccessorEvidence = { kind: "name_similarity", detail: "A → B" };
const content: SuccessorEvidence = { kind: "content_similarity", detail: "template tokens 50% alike" };

// ---- evidence kinds ----------------------------------------------------------------------------------------------

test("callSiteSwapEvidence keeps the place before ': ' so the reason and the UI can name it", () => {
  const evidence = callSiteSwapEvidence(
    `${EVENTS}/events-list/events-list.component.html`,
    "<app-event-form>",
    "<app-event-form-modal>"
  );
  assert.deepEqual(evidence, {
    kind: "call_site_swap",
    detail: `${EVENTS}/events-list/events-list.component.html: <app-event-form> → <app-event-form-modal>`
  });
  assert.equal(callSiteSwapPlace(evidence.detail), `${EVENTS}/events-list/events-list.component.html`);
});

test("gitRenameEvidence needs git's R entry from R's file to A's file and at least 40% similarity", () => {
  const from = `${EVENTS}/event-form/event-form.component.ts`;
  const to = `${EVENTS}/event-form-modal/event-form-modal.component.ts`;
  const changed = [{ path: to, status: "R" as const, previousPath: from }];
  assert.deepEqual(
    gitRenameEvidence(from, to, changed, () => 51),
    {
      kind: "git_rename",
      detail: `${from} → ${to} (51% similar)`
    }
  );
  assert.deepEqual(gitRenameEvidence(from, to, changed), { kind: "git_rename", detail: `${from} → ${to}` });
  assert.equal(
    gitRenameEvidence(from, to, changed, () => 39),
    null,
    "below 40%"
  );
  assert.equal(gitRenameEvidence(from, to, changed, () => 40)?.kind, "git_rename", "40% counts");
  assert.equal(gitRenameEvidence(from, "src/other.ts", changed), null, "renamed to another file");
  assert.equal(
    gitRenameEvidence(from, to, [
      { path: from, status: "D" },
      { path: to, status: "A" }
    ]),
    null,
    "git did not pair them"
  );
});

test("nameSimilarityEvidence: containment or edit distance ≤ 4, in one feature folder", () => {
  const removed = { displayName: "EventFormComponent", filePath: `${EVENTS}/event-form/event-form.component.ts` };
  const added = {
    displayName: "EventFormModalComponent",
    filePath: `${EVENTS}/event-form-modal/event-form-modal.component.ts`
  };
  assert.deepEqual(nameSimilarityEvidence(removed, added), {
    kind: "name_similarity",
    detail: `EventFormComponent → EventFormModalComponent: one name contains the other, both in ${EVENTS}`
  });
  // edit distance 2 (UserCard → UserCart), flat folder
  assert.equal(
    nameSimilarityEvidence(
      { displayName: "UserCard", filePath: "src/components/UserCard.tsx" },
      { displayName: "UserCart", filePath: "src/components/UserCart.tsx" }
    )?.detail,
    "UserCard → UserCart: names differ by 1 letters, both in src/components"
  );
  // the same folder, although only the old file is named after it
  assert.equal(
    nameSimilarityEvidence(
      { displayName: "BadgeComponent", filePath: "src/app/shared/badge/badge.component.ts" },
      { displayName: "BadgeModalComponent", filePath: "src/app/shared/badge/badge-modal.component.ts" }
    )?.detail,
    "BadgeComponent → BadgeModalComponent: one name contains the other, both in src/app/shared/badge"
  );
  // different feature folders
  assert.equal(
    nameSimilarityEvidence(removed, {
      displayName: "EventFormModalComponent",
      filePath: "src/app/modules/members/event-form-modal/event-form-modal.component.ts"
    }),
    null
  );
  // short unrelated names: distance 4 equals the stem length
  assert.equal(
    nameSimilarityEvidence(
      { displayName: "Card", filePath: "src/components/Card.tsx" },
      { displayName: "Menu", filePath: "src/components/Menu.tsx" }
    ),
    null
  );
  // distance 5
  assert.equal(
    nameSimilarityEvidence(
      { displayName: "OrderSummary", filePath: "src/components/OrderSummary.tsx" },
      { displayName: "OrderHistory", filePath: "src/components/OrderHistory.tsx" }
    ),
    null
  );
});

test("componentNameStem, featureFolder and editDistance", () => {
  assert.equal(componentNameStem("EventFormComponent"), "EventForm");
  assert.equal(componentNameStem("Component"), "Component");
  assert.equal(componentNameStem("NoteForm"), "NoteForm");
  assert.equal(featureFolder(`${EVENTS}/event-form/event-form.component.ts`), EVENTS);
  assert.equal(featureFolder("src/components/ProfileCard/ProfileCard.tsx"), "src/components");
  assert.equal(featureFolder("src/components/Button.tsx"), "src/components");
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("same", "same"), 0);
});

test("contentSimilarityEvidence: token Jaccard of the markup, 0.35 or more", () => {
  assert.deepEqual([...markupTokens('<div class="Card">Hi <!-- note --></div>')].sort(), [
    "card",
    "class",
    "div",
    "hi"
  ]);
  assert.equal(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
  assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
  const form = '<form class="space-y-4"><label>Name</label><input formControlName="name"><button>Save</button></form>';
  const modal =
    '<div class="modal"><form class="space-y-4"><label>Name</label><input formControlName="name"><button>Save</button></form></div>';
  assert.deepEqual(contentSimilarityEvidence(form, modal, "template"), {
    kind: "content_similarity",
    detail: "template tokens 82% alike"
  });
  assert.equal(contentSimilarityEvidence(form, "<img src=logo.png>", "template"), null);
  assert.equal(contentSimilarityEvidence(null, modal, "JSX"), null);
});

// ---- scoring and pairing -----------------------------------------------------------------------------------------

test("successorScore counts each kind once: swap 3, rename 3, name 2, content 1", () => {
  assert.equal(successorScore([swap("a.html")]), 3);
  assert.equal(successorScore([swap("a.html"), swap("b.html")]), 3, "a second call site adds nothing");
  assert.equal(successorScore([rename]), 3);
  assert.equal(successorScore([name]), 2);
  assert.equal(successorScore([content]), 1);
  assert.equal(successorScore([name, content]), 3);
  assert.equal(successorScore([swap("a"), rename, name, content]), 9);
  assert.equal(successorScore([]), 0);
});

test("pairSuccessors keeps pairs at the 3-point threshold and drops weaker ones", () => {
  assert.equal(SUCCESSOR_MIN_SCORE, 3);
  const pairs = pairSuccessors([
    { removedKey: "r1", addedKey: "a1", score: 3 },
    { removedKey: "r2", addedKey: "a2", score: 2 },
    { removedKey: "r3", addedKey: "a3", score: 1 }
  ]);
  assert.deepEqual(
    pairs.map((pair) => `${pair.removedKey}>${pair.addedKey}`),
    ["r1>a1"]
  );
});

test("pairSuccessors is one-to-one and greedy by score, ties broken by key", () => {
  const pairs = pairSuccessors([
    { removedKey: "r1", addedKey: "a1", score: 5 },
    { removedKey: "r1", addedKey: "a2", score: 9 }, // best: r1 → a2
    { removedKey: "r2", addedKey: "a2", score: 6 }, // a2 taken
    { removedKey: "r2", addedKey: "a1", score: 4 }, // r2 → a1
    { removedKey: "r3", addedKey: "a1", score: 4 } // tie with r2, but a1 is taken by then
  ]);
  assert.deepEqual(
    pairs.map((pair) => `${pair.removedKey}>${pair.addedKey}`),
    ["r1>a2", "r2>a1"]
  );
});

test("replacementReason names call-site places, rename, name and markup", () => {
  assert.equal(
    replacementReason("EventFormModalComponent", [
      swap(`${EVENTS}/events-list/events-list.component.html`),
      { kind: "git_rename", detail: "x" }
    ]),
    "Replaced by EventFormModalComponent (call site swap in events-list, rename)"
  );
  assert.equal(
    replacementReason("NoteFormModal", [
      swap("src/a/One.tsx"),
      swap("src/b/two.component.html"),
      swap("src/c/Three.tsx"),
      name,
      content
    ]),
    "Replaced by NoteFormModal (call site swap in One and two and 1 more, similar name, similar markup)"
  );
  assert.equal(replacementReason("X", []), "Replaced by X");
});

test("sortEvidence orders by kind and removes duplicates", () => {
  assert.deepEqual(sortEvidence([content, name, swap("b"), rename, swap("a"), swap("a")]), [
    swap("a"),
    swap("b"),
    rename,
    name,
    content
  ]);
});

// ---- the sub-step ------------------------------------------------------------------------------------------------

test("matchSuccessors replaces a matched removed + added pair with one replaced draft keyed by A", async () => {
  const removed = draft({
    filePath: "src/components/NoteForm.tsx",
    displayName: "NoteForm",
    changeKind: "removed",
    reason: "File deleted",
    codeDiff: "--- removed"
  });
  const added = draft({
    filePath: "src/components/NoteFormModal.tsx",
    displayName: "NoteFormModal",
    changeKind: "added",
    reason: "New file",
    codeDiff: "+++ added"
  });
  const modified = draft({ filePath: "src/pages/Notes.tsx", displayName: "Notes" });
  const drafts = new Map(
    [removed, added, modified].map((item) => [`${item.filePath}\u0000${item.exportName}`, item] as const)
  );
  const evidence = [swap("src/pages/Notes.tsx"), name];
  const matches = await matchSuccessors(
    drafts,
    () => Promise.resolve(evidence),
    () => ({ codeDiff: "diff R → A", diffSize: 12 })
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.score, 5);
  assert.equal(drafts.size, 2);
  assert.equal(drafts.has("src/components/NoteForm.tsx\u0000default"), false);
  assert.deepEqual(drafts.get("src/components/NoteFormModal.tsx\u0000default"), {
    filePath: "src/components/NoteFormModal.tsx",
    exportName: "default",
    displayName: "NoteFormModal",
    changeKind: "replaced",
    codeDiff: "diff R → A",
    reason: "Replaced by NoteFormModal (call site swap in Notes, similar name)",
    diffSize: 12,
    depth: 0,
    forcedSkipReason: null,
    predecessor: {
      filePath: "src/components/NoteForm.tsx",
      exportName: "default",
      displayName: "NoteForm",
      evidence: [swap("src/pages/Notes.tsx"), name]
    }
  });
});

test("matchSuccessors does not pair unrelated removed and added components", async () => {
  const drafts = new Map<string, DraftCandidate>();
  for (const item of [
    draft({ filePath: "src/components/Card.tsx", displayName: "Card", changeKind: "removed" }),
    draft({ filePath: "src/components/Menu.tsx", displayName: "Menu", changeKind: "added" }),
    draft({ filePath: "src/pages/Settings.tsx", displayName: "Settings", changeKind: "removed" }),
    draft({ filePath: "src/widgets/Chart.tsx", displayName: "Chart", changeKind: "added" })
  ]) {
    drafts.set(`${item.filePath}\u0000${item.exportName}`, item);
  }
  const before = [...drafts.values()].map((item) => item.changeKind);
  const collect = (r: DraftCandidate, a: DraftCandidate): Promise<SuccessorEvidence[]> => {
    // what a framework collector finds for unrelated components: at most weak content similarity
    const evidence = [nameSimilarityEvidence(r, a), contentSimilarityEvidence("<div>x</div>", "<div>x</div>", "JSX")];
    return Promise.resolve(evidence.filter((item): item is SuccessorEvidence => item !== null));
  };
  const matches = await matchSuccessors(drafts, collect, () => ({ codeDiff: null, diffSize: 0 }));
  assert.deepEqual(matches, []);
  assert.deepEqual(
    [...drafts.values()].map((item) => item.changeKind),
    before
  );
});

test("matchSuccessors never calls the collector without both a removed and an added draft", async () => {
  const drafts = new Map([["a\u0000default", draft({ filePath: "a", changeKind: "removed" })]]);
  let calls = 0;
  await matchSuccessors(
    drafts,
    () => {
      calls++;
      return Promise.resolve([rename]);
    },
    () => ({ codeDiff: null, diffSize: 0 })
  );
  assert.equal(calls, 0);
});

test("sourceQueryRows lists A as added and R as removed so each side resolves its own file", () => {
  const replaced = draft({
    filePath: "src/b/B.tsx",
    changeKind: "replaced",
    predecessor: { filePath: "src/a/A.tsx", exportName: "default", displayName: "A", evidence: [] }
  });
  const sameFile = draft({
    filePath: "src/c/C.tsx",
    exportName: "CModal",
    changeKind: "replaced",
    predecessor: { filePath: "src/c/C.tsx", exportName: "C", displayName: "C", evidence: [] }
  });
  assert.deepEqual(sourceQueryRows([replaced, sameFile, draft({ filePath: "src/d/D.tsx" })]), [
    { filePath: "src/b/B.tsx", changeKind: "added" },
    { filePath: "src/a/A.tsx", changeKind: "removed" },
    { filePath: "src/c/C.tsx", changeKind: "modified" },
    { filePath: "src/d/D.tsx", changeKind: "modified" }
  ]);
});
