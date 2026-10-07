import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBudget,
  codeMarker,
  listMarker,
  sourceSectionLimit,
  truncateDiff,
  truncateLines,
  truncateSourceAroundExport,
  type PromptSection,
  type SectionDraft,
  type SectionId
} from "../../../backend/src/services/visualizations/pipeline/harness-context-builder";
import {
  HARNESS_SECTION_LIMITS,
  buildHarnessUserPrompt,
  estimateTokens,
  targetImportPath,
  targetImportStatement,
  type SectionLimit
} from "../../../backend/src/services/visualizations/pipeline/harness-prompts";

const helper = (name: string, lines: number): string =>
  [
    `export function ${name}(value: number): number {`,
    ...Array.from({ length: lines }, (_, i) => `  value += ${i}; // ${name} step ${i}`),
    "  return value;",
    "}"
  ].join("\n");

const COMPONENT = [
  'import clsx from "clsx";',
  'import type { ReactNode } from "react";',
  "",
  'type Tone = "info" | "warn";',
  "",
  "export interface BadgeProps {",
  "  tone?: Tone;",
  "  children: ReactNode;",
  "}",
  "",
  helper("formatA", 60),
  "",
  helper("formatB", 60),
  "",
  'export function Badge({ tone = "info", children }: BadgeProps) {',
  '  return <span className={clsx("badge", tone)}>{children}</span>;',
  "}",
  "",
  helper("formatC", 60)
].join("\n");

test("truncateLines appends exact marker with omitted count", () => {
  assert.equal(truncateLines("a\nb\nc\nd\ne", 2, codeMarker), "a\nb\n// [truncated 3 lines]");
  assert.equal(truncateLines("a\nb\nc", 1, listMarker), "a\n[truncated 2 lines]");
  assert.equal(truncateLines("a\nb", 2, listMarker), "a\nb");
});

test("truncateSourceAroundExport keeps imports, target and props types", () => {
  const out = truncateSourceAroundExport(COMPONENT, "Badge", 300);
  assert.ok(estimateTokens(COMPONENT) > 300);
  for (const kept of [
    'import clsx from "clsx";',
    'import type { ReactNode } from "react";',
    "export interface BadgeProps {",
    'type Tone = "info" | "warn";',
    'export function Badge({ tone = "info", children }: BadgeProps) {'
  ]) {
    assert.ok(out.includes(kept), kept);
  }
  assert.ok(!out.includes("formatB step 59"));
  assert.match(out, /\/\/ \[truncated \d+ lines\]/);
  assert.ok(estimateTokens(out) <= 300 + 20);
});

test("truncateSourceAroundExport collapses omitted runs into single markers", () => {
  const out = truncateSourceAroundExport(COMPONENT, "Badge", 150);
  const lines = out.split("\n");
  const markers = lines.filter((line) => line.startsWith("// [truncated"));
  // formatA + formatB (with the blank line between them) form one run; formatC is a second run
  assert.equal(markers.length, 2, out);
  for (let i = 1; i < lines.length; i += 1) {
    assert.ok(!(lines[i]?.startsWith("// [truncated") && lines[i - 1]?.startsWith("// [truncated")));
  }
  const omitted = markers.reduce((sum, marker) => sum + Number(/(\d+)/.exec(marker)?.[1]), 0);
  assert.equal(lines.length - markers.length + omitted, COMPONENT.split("\n").length);
  // default export target via `export default X` + the declaration of X
  const withDefault = `${COMPONENT.replace("export function Badge", "function Badge")}\nexport default Badge;`;
  const defaultOut = truncateSourceAroundExport(withDefault, "default", 150);
  assert.ok(defaultOut.includes('function Badge({ tone = "info", children }: BadgeProps) {'));
  assert.ok(defaultOut.includes("export default Badge;"));
});

test("truncateSourceAroundExport falls back to head-of-file on parse error", () => {
  const broken = `export function Broken( {{{ ;\n${Array.from({ length: 400 }, (_, i) => `const x${i} = ${i};`).join("\n")}`;
  const out = truncateSourceAroundExport(broken, "Broken", 100);
  assert.ok(out.startsWith("export function Broken( {{{ ;\nconst x0 = 0;"));
  assert.match(out.split("\n").at(-1) ?? "", /^\/\/ \[truncated \d+ lines\]$/);
  assert.ok(estimateTokens(out) <= 100);
});

test("truncateDiff keeps whole hunks then marks the rest", () => {
  const hunk = (n: number): string[] => [
    `@@ -${n},5 +${n},5 @@`,
    ...Array.from({ length: 40 }, (_, i) => `+line ${n}-${i} ${"x".repeat(20)}`)
  ];
  const lines = ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", ...hunk(1), ...hunk(100), ...hunk(200)];
  const diff = lines.join("\n");
  const firstHunkChars = lines.slice(0, 44).join("\n").length;
  const out = truncateDiff(diff, Math.ceil((firstHunkChars + 300) / 3));
  const outLines = out.split("\n");
  assert.deepEqual(outLines.slice(0, 44), lines.slice(0, 44), "header and the whole first hunk");
  assert.equal(outLines[44], "@@ -100,5 +100,5 @@", "the next hunk is cut, not skipped");
  const marker = outLines.at(-1) ?? "";
  assert.match(marker, /^\[truncated \d+ lines\]$/);
  assert.equal(Number(/(\d+)/.exec(marker)?.[1]), lines.length - (outLines.length - 1));
  assert.equal(truncateDiff("@@ -1 +1 @@\n-a\n+b", 1_000), "@@ -1 +1 @@\n-a\n+b");
});

// ---- budget (09 §5.4.3) ----

function draft(id: SectionId, tokens: number, limit: SectionLimit = HARNESS_SECTION_LIMITS[id]): SectionDraft {
  const lineText = "x".repeat(29); // 30 chars per line incl. newline = 10 tokens
  const lineCount = Math.ceil(tokens / 10);
  const text = Array.from({ length: lineCount }, () => lineText).join("\n");
  return {
    id,
    attributes: {},
    limit,
    originalLines: lineCount,
    render: (cap) => {
      const keep = lineCount * 10 <= cap ? lineCount : Math.max(0, Math.floor(cap / 10) - 1);
      const omitted = lineCount - keep;
      return {
        text: omitted > 0 ? [...Array.from({ length: keep }, () => lineText), listMarker(omitted)].join("\n") : text,
        totalLines: lineCount,
        omittedLines: omitted
      };
    }
  };
}

const sumTokens = (sections: PromptSection[]): number => sections.reduce((sum, s) => sum + s.tokens, 0);
const byId = (sections: PromptSection[], id: SectionId): PromptSection | undefined => sections.find((s) => s.id === id);

function fullDrafts(): SectionDraft[] {
  return [
    draft("head_source", 12_000),
    draft("base_source", 6_000),
    draft("code_diff", 8_000),
    draft("direct_imports", 1_000),
    draft("referenced_types", 6_000),
    draft("call_sites", 3_000),
    draft("stories_tests", 5_000),
    draft("changed_dependencies", 5_000),
    draft("app_entry", 2_500),
    draft("dependencies", 1_500),
    draft("global_styles", 100)
  ];
}

test("budget shrinks stories first and code diff late", () => {
  const drafts = fullDrafts();
  const total = sumTokens(applyBudget(drafts, sumTokens, Number.POSITIVE_INFINITY).sections);

  const slight = applyBudget(drafts, sumTokens, total - 1_000);
  assert.equal(slight.overBudget, false);
  assert.ok((byId(slight.sections, "stories_tests")?.tokens ?? 0) < 5_000);
  for (const id of ["call_sites", "base_source", "code_diff", "head_source"] as const) {
    assert.equal(byId(slight.sections, id)?.truncatedLines, 0, id);
  }

  const tight = applyBudget(drafts, sumTokens, total - 20_000);
  assert.equal(byId(tight.sections, "stories_tests")?.dropped, true);
  assert.equal(byId(tight.sections, "call_sites")?.dropped, true);
  assert.equal(byId(tight.sections, "base_source")?.dropped, true);
  assert.equal(byId(tight.sections, "code_diff")?.truncatedLines, 0, "code diff shrinks only at position 8");
  assert.equal(byId(tight.sections, "head_source")?.truncatedLines, 0);

  const tighter = applyBudget(drafts, sumTokens, 15_000);
  assert.ok((byId(tighter.sections, "code_diff")?.tokens ?? 0) >= HARNESS_SECTION_LIMITS.code_diff.minTokens - 20);
  assert.ok((byId(tighter.sections, "code_diff")?.truncatedLines ?? 0) > 0);
  assert.ok((byId(tighter.sections, "referenced_types")?.tokens ?? 0) >= 780, "min 800");
  assert.equal(byId(tighter.sections, "direct_imports")?.truncatedLines, 0, "never shrunk");

  const impossible = applyBudget(drafts, sumTokens, 1_000);
  assert.equal(impossible.overBudget, true);
});

test("dropped section keeps its tag with the marker", () => {
  const drafts = [draft("head_source", 2_000), draft("call_sites", 540)];
  const result = applyBudget(drafts, sumTokens, 2_000);
  const callSites = byId(result.sections, "call_sites");
  assert.equal(callSites?.dropped, true);
  assert.equal(callSites.body, "[truncated 54 lines]");
  const candidate = {
    componentId: 1,
    filePath: "src/A.tsx",
    exportName: "A",
    displayName: "A",
    changeKind: "added" as const,
    rank: 0,
    codeDiff: null,
    reason: "new"
  };
  const prompt = buildHarnessUserPrompt({
    candidate,
    sourceSide: "head",
    sidesPresent: { base: false, head: true },
    paths: { base: null, head: "src/A.tsx" },
    viteRootRel: "",
    targetImportPath: targetImportPath("src/A.tsx"),
    targetImportStatement: targetImportStatement(candidate),
    directImports: { base: [], head: [] },
    sections: result.sections,
    estimatedTokens: result.totalTokens,
    purpose: "change",
    stateAllowance: 1
  });
  assert.ok(prompt.includes("<call_sites>[truncated 54 lines]</call_sites>"));
});

test("base source dropped only when code diff is present", () => {
  const withDiff = sourceSectionLimit("secondary", true);
  const withoutDiff = sourceSectionLimit("secondary", false);
  assert.deepEqual(withDiff, HARNESS_SECTION_LIMITS.base_source);
  assert.deepEqual({ min: withoutDiff.minTokens, order: withoutDiff.shrinkOrder }, { min: 3_000, order: 9 });
  assert.deepEqual(sourceSectionLimit("primary", true), HARNESS_SECTION_LIMITS.head_source);

  const run = (limit: SectionLimit): ReturnType<typeof applyBudget> =>
    applyBudget(
      [draft("head_source", 12_000), draft("base_source", 6_000, limit), draft("stories_tests", 1_000)],
      sumTokens,
      10_000
    );
  const dropped = run(withDiff);
  assert.equal(byId(dropped.sections, "base_source")?.dropped, true);
  const kept = run(withoutDiff);
  assert.notEqual(byId(kept.sections, "base_source")?.dropped, true);
  assert.ok((byId(kept.sections, "base_source")?.tokens ?? 0) >= 2_980);
  assert.ok((byId(kept.sections, "head_source")?.truncatedLines ?? 0) > 0, "head shrinks at the same position");
});
