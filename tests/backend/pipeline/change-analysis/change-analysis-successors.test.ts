/**
 * React successor matching through ChangeAnalysisService (00 §17): call-site swaps found through resolved imports
 * (relative and tsconfig alias), git renames, similar names and JSX; the persisted `replaced` row; the source queries
 * of both sides; no pairing of unrelated components.
 */
import assert from "node:assert/strict";
import { test, type TestContext as NodeTestContext } from "node:test";
import { ChangeAnalysisService } from "../../../../backend/src/services/visualizations/pipeline/change-analysis-service";
import type { ChangeAnalysisResult } from "../../../../backend/src/types/visualization-pipeline";
import type { GitNameStatusEntry } from "../../../../backend/src/utilities/services/git-client";
import {
  ALIAS_TSCONFIG,
  diffEntries,
  makeContext,
  makeWorktrees,
  stubGitClient,
  stubPersistence,
  type FileMap,
  type StubPersistence,
  type TestContext
} from "./helpers/worktree-fixture";

const NOTE_FORM = `export default function NoteForm({ onSave }: { onSave: () => void }) {
  return (
    <form className="space-y-3 rounded border p-4">
      <label className="block text-sm font-medium">Note</label>
      <textarea className="w-full rounded border p-2" name="note" />
      <button type="button" className="rounded bg-indigo-600 px-3 py-1 text-white" onClick={onSave}>Save note</button>
    </form>
  );
}
`;

const NOTE_FORM_MODAL = `export default function NoteFormModal({ onSave }: { onSave: () => void }) {
  return (
    <div className="rounded-xl shadow-lg">
      <h2 className="px-4 pt-4 text-lg font-semibold">New note</h2>
      <form className="space-y-3 rounded border p-4">
        <label className="block text-sm font-medium">Note</label>
        <textarea className="w-full rounded border p-2" name="note" />
        <button type="button" className="rounded bg-indigo-600 px-3 py-1 text-white" onClick={onSave}>Save note</button>
      </form>
    </div>
  );
}
`;

const NOTES_PAGE = (specifier: string, name: string): string => `import ${name} from "${specifier}";

export default function Notes() {
  return (
    <section>
      <h1>Notes</h1>
      <${name} onSave={() => undefined} />
    </section>
  );
}
`;

const CARD = `export default function Card() {
  return <div className="rounded border p-4">Card</div>;
}
`;
const CHART = `export default function Chart() {
  return <svg width={10} height={10}><rect width={10} height={10} /></svg>;
}
`;

async function analyze(
  t: NodeTestContext,
  base: FileMap,
  head: FileMap,
  entries: GitNameStatusEntry[] = diffEntries(base, head)
): Promise<{ result: ChangeAnalysisResult; ctx: TestContext; persistence: StubPersistence }> {
  const wt = await makeWorktrees({ base, head });
  t.after(() => wt.cleanup());
  const persistence = stubPersistence();
  const ctx = makeContext({ baseDir: wt.baseDir, headDir: wt.headDir }, { tsconfigPath: "tsconfig.json" });
  const service = new ChangeAnalysisService({ gitClient: stubGitClient(entries), ...persistence });
  return { result: await service.analyze(ctx), ctx, persistence };
}

const kinds = (result: ChangeAnalysisResult): Array<[string, string]> =>
  result.candidates.map((candidate) => [candidate.displayName, candidate.changeKind]);

test("ChangeAnalysisService.analyze pairs a deleted form and its added -Modal successor as one replaced row", async (t) => {
  const base: FileMap = {
    "tsconfig.json": "{}",
    "src/components/notes/NoteForm.tsx": NOTE_FORM,
    "src/pages/Notes.tsx": NOTES_PAGE("../components/notes/NoteForm", "NoteForm")
  };
  const head: FileMap = {
    "tsconfig.json": "{}",
    "src/components/notes/NoteFormModal.tsx": NOTE_FORM_MODAL,
    "src/pages/Notes.tsx": NOTES_PAGE("../components/notes/NoteFormModal", "NoteFormModal")
  };
  const { result, ctx, persistence } = await analyze(t, base, head);

  assert.deepEqual(kinds(result), [
    ["NoteFormModal", "replaced"],
    ["Notes", "modified"]
  ]);
  const replaced = result.candidates[0];
  assert.equal(replaced?.filePath, "src/components/notes/NoteFormModal.tsx");
  assert.equal(replaced.exportName, "default");
  assert.equal(replaced.reason, "Replaced by NoteFormModal (call site swap in Notes, similar name, similar markup)");
  assert.deepEqual(replaced.predecessor, {
    filePath: "src/components/notes/NoteForm.tsx",
    exportName: "default",
    displayName: "NoteForm",
    evidence: [
      {
        kind: "call_site_swap",
        detail: "src/pages/Notes.tsx: <NoteForm> → <NoteFormModal>"
      },
      {
        kind: "name_similarity",
        detail: "NoteForm → NoteFormModal: one name contains the other, both in src/components/notes"
      },
      { kind: "content_similarity", detail: "JSX tokens 73% alike" }
    ]
  });
  // the code diff compares R's base file with A's head file
  assert.match(
    replaced.codeDiff ?? "",
    /^diff --git a\/src\/components\/notes\/NoteForm\.tsx b\/src\/components\/notes\/NoteFormModal\.tsx/
  );
  assert.match(replaced.codeDiff ?? "", /^\+\s+<h2 className="px-4 pt-4 text-lg font-semibold">New note<\/h2>$/m);

  // persisted through the shared helper with the base columns and the evidence
  const row = persistence.inserted.flat().find((inserted) => inserted.changeKind === "replaced");
  assert.ok(row, "replaced row inserted");
  assert.equal(row.filePath, "src/components/notes/NoteFormModal.tsx");
  assert.equal(row.baseFilePath, "src/components/notes/NoteForm.tsx");
  assert.equal(row.baseExportName, "default");
  assert.equal(row.baseDisplayName, "NoteForm");
  assert.deepEqual(row.successorEvidence, replaced.predecessor.evidence);
  assert.equal(row.changeReason, replaced.reason);
  const modified = persistence.inserted.flat().find((inserted) => inserted.changeKind === "modified");
  assert.equal("baseFilePath" in (modified ?? {}), false, "other rows leave the base columns null");

  // each side's source queries resolve its own file
  assert.deepEqual(await result.sourceQueries.componentPaths("src/components/notes/NoteFormModal.tsx"), {
    base: null,
    head: "src/components/notes/NoteFormModal.tsx"
  });
  assert.deepEqual(await result.sourceQueries.componentPaths("src/components/notes/NoteForm.tsx"), {
    base: "src/components/notes/NoteForm.tsx",
    head: null
  });
  assert.ok(
    ctx.consoleEvents.some(
      (event) =>
        event.message ===
        "NoteForm was replaced by NoteFormModal (call site swap, name similarity, content similarity); showing them side by side."
    ),
    JSON.stringify(ctx.consoleEvents)
  );
});

// Named exports: a renamed file whose default export keeps its name is still 08's rename-aware "modified" component.
const named = (source: string): string => source.replace("export default function", "export function");
const NAMED_PAGE = (specifier: string, name: string): string =>
  NOTES_PAGE(specifier, name).replace(`import ${name} from`, `import { ${name} } from`);

test("ChangeAnalysisService.analyze finds the call-site swap through a tsconfig alias and reports git's rename", async (t) => {
  const base: FileMap = {
    "tsconfig.json": ALIAS_TSCONFIG,
    "src/components/NoteForm.tsx": named(NOTE_FORM),
    "src/pages/Notes.tsx": NAMED_PAGE("@/components/NoteForm", "NoteForm")
  };
  const head: FileMap = {
    "tsconfig.json": ALIAS_TSCONFIG,
    "src/components/NoteFormModal.tsx": named(NOTE_FORM_MODAL),
    "src/pages/Notes.tsx": NAMED_PAGE("@/components/NoteFormModal", "NoteFormModal")
  };
  const entries: GitNameStatusEntry[] = [
    { status: "R", score: 62, path: "src/components/NoteFormModal.tsx", previousPath: "src/components/NoteForm.tsx" },
    { status: "M", path: "src/pages/Notes.tsx" }
  ];
  const { result } = await analyze(t, base, head, entries);
  const replaced = result.candidates.find((candidate) => candidate.changeKind === "replaced");
  assert.deepEqual(
    replaced?.predecessor?.evidence.map((item) => item.detail),
    [
      "src/pages/Notes.tsx: <NoteForm> → <NoteFormModal>",
      "src/components/NoteForm.tsx → src/components/NoteFormModal.tsx (62% similar)",
      "NoteForm → NoteFormModal: one name contains the other, both in src/components",
      "JSX tokens 73% alike"
    ]
  );
  assert.equal(replaced.exportName, "NoteFormModal");
  assert.equal(replaced.predecessor.exportName, "NoteForm");
  assert.equal(
    replaced.reason,
    "Replaced by NoteFormModal (call site swap in Notes, rename, similar name, similar markup)"
  );
  // rename-aware paths still give each side its own file
  assert.deepEqual(await result.sourceQueries.componentPaths("src/components/NoteFormModal.tsx"), {
    base: null,
    head: "src/components/NoteFormModal.tsx"
  });
});

test("ChangeAnalysisService.analyze keeps unrelated removed and added components separate", async (t) => {
  const base: FileMap = { "tsconfig.json": "{}", "src/components/Card.tsx": CARD };
  const head: FileMap = { "tsconfig.json": "{}", "src/widgets/Chart.tsx": CHART };
  const { result, persistence } = await analyze(t, base, head);
  assert.deepEqual(kinds(result), [
    ["Chart", "added"],
    ["Card", "removed"]
  ]);
  assert.equal(
    persistence.inserted.flat().some((row) => row.changeKind === "replaced"),
    false
  );
});

test("ChangeAnalysisService.analyze does not pair on weak evidence alone (similar JSX in another folder)", async (t) => {
  const base: FileMap = { "tsconfig.json": "{}", "src/components/NoteForm.tsx": NOTE_FORM };
  const head: FileMap = {
    "tsconfig.json": "{}",
    "src/admin/FeedbackPanel.tsx": NOTE_FORM_MODAL.replace("NoteFormModal", "FeedbackPanel")
  };
  const { result } = await analyze(t, base, head);
  assert.deepEqual(kinds(result), [
    ["FeedbackPanel", "added"],
    ["NoteForm", "removed"]
  ]);
});
