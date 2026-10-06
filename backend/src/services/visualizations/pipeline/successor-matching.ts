/**
 * Successor matching (00 §17), the framework-neutral core shared by the React (08) and Angular (15b) change
 * analysis services: it scores every (removed R, added A) draft pair from the evidence a framework collector finds,
 * pairs them one-to-one, greedily by score, and turns each pair into one `replaced` draft (head = A, base = R).
 *
 * Evidence and points: `call_site_swap` +3 and `git_rename` +3 (strong), `name_similarity` +2 (medium),
 * `content_similarity` +1 (weak). A pair needs SUCCESSOR_MIN_SCORE points. Each kind counts once per pair.
 *
 * Framework-specific extraction (which files referenced R and now reference A, which markup to compare) stays in the
 * services; the helpers here build the evidence objects so every framework words them the same way.
 */
import path from "node:path";
import type { DraftCandidate } from "../../../types/change-analysis";
import type {
  ChangeAnalysisResult,
  ComponentPredecessor,
  SuccessorEvidence,
  SuccessorEvidenceKind
} from "../../../types/visualization-pipeline";
import { analysisRowKey } from "./change-analysis-persistence";

/** Points per evidence kind (00 §17). */
export const SUCCESSOR_EVIDENCE_POINTS: Readonly<Record<SuccessorEvidenceKind, number>> = {
  call_site_swap: 3,
  git_rename: 3,
  name_similarity: 2,
  content_similarity: 1
};
/** A pair is a replacement from this score on (00 §17). */
export const SUCCESSOR_MIN_SCORE = 3;
/** Smallest git rename similarity (percent) that counts as `git_rename` (00 §17). */
export const SUCCESSOR_RENAME_MIN_SIMILARITY = 40;
/** Largest edit distance between name stems that counts as `name_similarity` (00 §17). */
export const SUCCESSOR_NAME_MAX_EDIT_DISTANCE = 4;
/** Smallest stem a containment match may use, so `Ab` is not "contained" in every name. */
export const SUCCESSOR_NAME_MIN_STEM_CHARS = 3;
/** Smallest template/JSX token Jaccard similarity that counts as `content_similarity` (00 §17). */
export const SUCCESSOR_CONTENT_MIN_SIMILARITY = 0.35;

const EVIDENCE_ORDER: readonly SuccessorEvidenceKind[] = [
  "call_site_swap",
  "git_rename",
  "name_similarity",
  "content_similarity"
];
const REASON_MAX_CHARS = 300;
const MAX_REASON_PLACES = 2;

/** Collects the evidence for one (removed, added) pair. Never rejects for a missing side: it returns []. */
export type SuccessorEvidenceCollector = (
  removed: DraftCandidate,
  added: DraftCandidate
) => Promise<SuccessorEvidence[]>;

/** Code diff of a replaced pair (R's files on base against A's files on head). */
export type ReplacedDiffBuilder = (
  removed: DraftCandidate,
  added: DraftCandidate
) => { codeDiff: string | null; diffSize: number };

/** One accepted pair. */
export interface SuccessorMatch {
  removed: DraftCandidate;
  added: DraftCandidate;
  evidence: SuccessorEvidence[];
  score: number;
}

/** A scored pair before one-to-one pairing. */
export interface ScoredSuccessorPair {
  removedKey: string;
  addedKey: string;
  score: number;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Name stem used for comparisons: the display name without a trailing `Component` (Angular class naming). */
export function componentNameStem(displayName: string): string {
  const stem = displayName.endsWith("Component") ? displayName.slice(0, -"Component".length) : displayName;
  return stem === "" ? displayName : stem;
}

/** Levenshtein distance (insert, delete, substitute = 1). */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** File name without its extension and Angular role suffix: `events-list.component.html` → `events-list`. */
export function fileStem(filePath: string): string {
  const base = path.posix.basename(filePath);
  const withoutExtension = base.replace(/\.[^.]+$/, "");
  return withoutExtension.replace(/\.(component|module|page|view)$/, "");
}

/**
 * The feature folder of a component file: the parent of the component's own folder when that folder is named after
 * the file (`events/event-form/event-form.component.ts` → `events`, `ProfileCard/ProfileCard.tsx` → its parent),
 * else the file's folder (`src/components/Button.tsx` → `src/components`).
 */
export function featureFolder(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  const own = path.posix.basename(dir);
  return own.toLowerCase() === fileStem(filePath).toLowerCase() ? path.posix.dirname(dir) : dir;
}

/** Short label of a place for reasons and UI text: the file stem (`events-list`, `Dashboard`). */
export function placeLabel(filePath: string): string {
  return fileStem(filePath);
}

/** `git_rename` evidence when git reported R's file renamed to A's file (00 §17). */
export function gitRenameEvidence(
  removedPath: string,
  addedPath: string,
  changedFiles: ChangeAnalysisResult["changedFiles"],
  similarity: (removedPath: string, addedPath: string) => number | null = () => null
): SuccessorEvidence | null {
  const rename = changedFiles.find(
    (file) => file.status === "R" && file.previousPath === removedPath && file.path === addedPath
  );
  if (rename === undefined) {
    return null;
  }
  const percent = similarity(removedPath, addedPath);
  if (percent !== null && percent < SUCCESSOR_RENAME_MIN_SIMILARITY) {
    return null;
  }
  return {
    kind: "git_rename",
    detail: `${removedPath} → ${addedPath}${percent === null ? "" : ` (${String(percent)}% similar)`}`
  };
}

/**
 * `name_similarity` evidence (00 §17): one stem contains the other, or their edit distance is at most
 * SUCCESSOR_NAME_MAX_EDIT_DISTANCE, and both files share a feature folder (the same folder, or sibling component
 * folders under one parent, see `featureFolder`). Containment needs a stem of at least
 * SUCCESSOR_NAME_MIN_STEM_CHARS; the edit distance must also be smaller than the shorter stem, so two short,
 * unrelated names (`Card`, `Menu`) never match.
 */
export function nameSimilarityEvidence(
  removed: { displayName: string; filePath: string },
  added: { displayName: string; filePath: string }
): SuccessorEvidence | null {
  const sameDir = path.posix.dirname(removed.filePath) === path.posix.dirname(added.filePath);
  const folder = sameDir ? path.posix.dirname(removed.filePath) : featureFolder(removed.filePath);
  if (!sameDir && folder !== featureFolder(added.filePath)) {
    return null;
  }
  const a = componentNameStem(removed.displayName).toLowerCase();
  const b = componentNameStem(added.displayName).toLowerCase();
  const shorter = Math.min(a.length, b.length);
  const contains = shorter >= SUCCESSOR_NAME_MIN_STEM_CHARS && (a.includes(b) || b.includes(a));
  const distance = contains ? 0 : editDistance(a, b);
  if (!contains && (distance > SUCCESSOR_NAME_MAX_EDIT_DISTANCE || distance >= shorter)) {
    return null;
  }
  const how = contains ? "one name contains the other" : `names differ by ${String(distance)} letters`;
  return {
    kind: "name_similarity",
    detail: `${removed.displayName} → ${added.displayName}: ${how}, both in ${folder === "." ? "the root folder" : folder}`
  };
}

/** Normalized markup tokens: identifiers, tag and attribute names, class names and words, lower-cased. */
export function markupTokens(text: string): Set<string> {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  return new Set((withoutComments.match(/[A-Za-z_$][\w$-]*/g) ?? []).map((token) => token.toLowerCase()));
}

/** Jaccard similarity of two sets (0 when both are empty). */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) {
      shared++;
    }
  }
  return shared / (a.size + b.size - shared);
}

/** `content_similarity` evidence (00 §17) from R's and A's template or JSX text. */
export function contentSimilarityEvidence(
  removedMarkup: string | null,
  addedMarkup: string | null,
  label: "template" | "JSX"
): SuccessorEvidence | null {
  if (removedMarkup === null || addedMarkup === null) {
    return null;
  }
  const similarity = jaccardSimilarity(markupTokens(removedMarkup), markupTokens(addedMarkup));
  if (similarity < SUCCESSOR_CONTENT_MIN_SIMILARITY) {
    return null;
  }
  return { kind: "content_similarity", detail: `${label} tokens ${String(Math.round(similarity * 100))}% alike` };
}

/**
 * `call_site_swap` evidence (00 §17). `detail` is `<place file>: <old reference> → <new reference>`; the UI and the
 * change reason read the place from the text before the first `": "`.
 */
export function callSiteSwapEvidence(placePath: string, oldReference: string, newReference: string): SuccessorEvidence {
  return { kind: "call_site_swap", detail: `${placePath}: ${oldReference} → ${newReference}` };
}

/** The place file of a `call_site_swap` detail. */
export function callSiteSwapPlace(detail: string): string {
  const separator = detail.indexOf(": ");
  return separator === -1 ? detail : detail.slice(0, separator);
}

/** Evidence in kind order (call site swaps, rename, name, content), duplicates removed. */
export function sortEvidence(evidence: readonly SuccessorEvidence[]): SuccessorEvidence[] {
  const seen = new Set<string>();
  const unique: SuccessorEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.kind}\u0000${item.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return unique.sort(
    (a, b) => EVIDENCE_ORDER.indexOf(a.kind) - EVIDENCE_ORDER.indexOf(b.kind) || byString(a.detail, b.detail)
  );
}

/** Score of a pair: the points of every distinct evidence kind (a second call site adds nothing). */
export function successorScore(evidence: readonly SuccessorEvidence[]): number {
  return [...new Set(evidence.map((item) => item.kind))].reduce(
    (total, kind) => total + SUCCESSOR_EVIDENCE_POINTS[kind],
    0
  );
}

/**
 * One-to-one greedy pairing (00 §17): pairs with at least SUCCESSOR_MIN_SCORE points, highest score first (ties by
 * removed key, then added key, so the result is deterministic); a component already paired is skipped.
 */
export function pairSuccessors<T extends ScoredSuccessorPair>(scored: readonly T[]): T[] {
  const ordered = scored
    .filter((pair) => pair.score >= SUCCESSOR_MIN_SCORE)
    .sort((a, b) => b.score - a.score || byString(a.removedKey, b.removedKey) || byString(a.addedKey, b.addedKey));
  const usedRemoved = new Set<string>();
  const usedAdded = new Set<string>();
  const taken: T[] = [];
  for (const pair of ordered) {
    if (usedRemoved.has(pair.removedKey) || usedAdded.has(pair.addedKey)) {
      continue;
    }
    usedRemoved.add(pair.removedKey);
    usedAdded.add(pair.addedKey);
    taken.push(pair);
  }
  return taken;
}

/** "Replaced by EventFormModalComponent (call site swap in events-list, rename)" (00 §17). */
export function replacementReason(addedDisplayName: string, evidence: readonly SuccessorEvidence[]): string {
  const parts: string[] = [];
  const places = [
    ...new Set(
      evidence
        .filter((item) => item.kind === "call_site_swap")
        .map((item) => placeLabel(callSiteSwapPlace(item.detail)))
    )
  ];
  if (places.length > 0) {
    const shown = places.slice(0, MAX_REASON_PLACES).join(" and ");
    const more = places.length > MAX_REASON_PLACES ? ` and ${String(places.length - MAX_REASON_PLACES)} more` : "";
    parts.push(`call site swap in ${shown}${more}`);
  }
  const kinds = new Set(evidence.map((item) => item.kind));
  if (kinds.has("git_rename")) {
    parts.push("rename");
  }
  if (kinds.has("name_similarity")) {
    parts.push("similar name");
  }
  if (kinds.has("content_similarity")) {
    parts.push("similar markup");
  }
  const reason = `Replaced by ${addedDisplayName}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
  return reason.length <= REASON_MAX_CHARS ? reason : `${reason.slice(0, REASON_MAX_CHARS - 1)}…`;
}

/** The `replaced` draft of a pair: head = A's file and export, base = R's (00 §17). */
export function replacedDraft(
  removed: DraftCandidate,
  added: DraftCandidate,
  evidence: readonly SuccessorEvidence[],
  diff: { codeDiff: string | null; diffSize: number }
): DraftCandidate {
  const predecessor: ComponentPredecessor = {
    filePath: removed.filePath,
    exportName: removed.exportName,
    displayName: removed.displayName,
    evidence: [...evidence]
  };
  return {
    filePath: added.filePath,
    exportName: added.exportName,
    displayName: added.displayName,
    changeKind: "replaced",
    codeDiff: diff.codeDiff,
    reason: replacementReason(added.displayName, evidence),
    diffSize: diff.diffSize,
    depth: 0,
    forcedSkipReason: null,
    predecessor
  };
}

/**
 * The successor matching sub-step (00 §17): scores every removed × added draft pair with `collect`, pairs them and
 * replaces each matched R and A in `drafts` by one `replaced` draft keyed by A. Runs before ranking.
 *
 * @returns the accepted pairs, in pairing order.
 */
export async function matchSuccessors(
  drafts: Map<string, DraftCandidate>,
  collect: SuccessorEvidenceCollector,
  buildDiff: ReplacedDiffBuilder
): Promise<SuccessorMatch[]> {
  const removed = [...drafts.values()]
    .filter((draft) => draft.changeKind === "removed")
    .sort((a, b) => byString(analysisRowKey(a), analysisRowKey(b)));
  const added = [...drafts.values()]
    .filter((draft) => draft.changeKind === "added")
    .sort((a, b) => byString(analysisRowKey(a), analysisRowKey(b)));
  if (removed.length === 0 || added.length === 0) {
    return [];
  }
  const scored: Array<ScoredSuccessorPair & SuccessorMatch> = [];
  for (const r of removed) {
    for (const a of added) {
      const evidence = sortEvidence(await collect(r, a));
      const score = successorScore(evidence);
      if (score > 0) {
        scored.push({
          removedKey: analysisRowKey(r),
          addedKey: analysisRowKey(a),
          removed: r,
          added: a,
          evidence,
          score
        });
      }
    }
  }
  const matches = pairSuccessors(scored);
  for (const match of matches) {
    drafts.delete(match.removedKey);
    drafts.set(
      match.addedKey,
      replacedDraft(match.removed, match.added, match.evidence, buildDiff(match.removed, match.added))
    );
  }
  return matches.map(({ removed: r, added: a, evidence, score }) => ({ removed: r, added: a, evidence, score }));
}

/**
 * Rows for the source queries' `componentPaths` (08 §5.14.7): a `replaced` draft stands for A on head ("added") and R
 * on base ("removed"), so each side's harness resolves its own file. Same file on both sides → "modified".
 */
export function sourceQueryRows(
  ordered: readonly DraftCandidate[]
): Array<{ filePath: string; changeKind: DraftCandidate["changeKind"] }> {
  return ordered.flatMap((draft) => {
    const predecessor = draft.predecessor;
    if (draft.changeKind !== "replaced" || predecessor === undefined || predecessor === null) {
      return [{ filePath: draft.filePath, changeKind: draft.changeKind }];
    }
    if (predecessor.filePath === draft.filePath) {
      return [{ filePath: draft.filePath, changeKind: "modified" as const }];
    }
    return [
      { filePath: draft.filePath, changeKind: "added" as const },
      { filePath: predecessor.filePath, changeKind: "removed" as const }
    ];
  });
}

/** Console line for one accepted pair. */
export function replacementConsoleLine(match: SuccessorMatch): string {
  return `${match.removed.displayName} was replaced by ${match.added.displayName} (${match.evidence
    .map((item) => item.kind.replace(/_/g, " "))
    .filter((kind, index, all) => all.indexOf(kind) === index)
    .join(", ")}); showing them side by side.`;
}
