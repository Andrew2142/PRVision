import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeAnalysisService } from "../../../../backend/src/services/visualizations/pipeline/change-analysis-service";
import {
  ComponentDetector,
  normalizeSource
} from "../../../../backend/src/services/visualizations/pipeline/component-detector";
import { diffEntries, makeContext, makeWorktrees, stubGitClient, stubPersistence } from "./helpers/worktree-fixture";

const detector = new ComponentDetector();

function closure(source: string, name: string, file = "src/X.tsx"): string {
  const text = detector.closureText(detector.parse(file, source), name);
  assert.ok(text !== null, `closure of ${name}`);
  return text;
}

function normalized(source: string, name: string, file = "src/X.tsx"): string | null {
  return detector.normalizedClosure(detector.parse(file, source), name);
}

test("closure includes referenced local helpers transitively", () => {
  const text = closure(
    `const base = "p-2";
const cx = (...c: string[]) => [base, ...c].join(" ");
const unrelated = 1;
export function Box() { return <div className={cx("x")}/> }`,
    "Box"
  );
  assert.match(text, /const base = "p-2";/);
  assert.match(text, /const cx =/);
  assert.doesNotMatch(text, /unrelated/);
});

test("closure includes local sub-components used in JSX", () => {
  const text = closure(
    `function Row() { return <li/> }
function Unused() { return <p/> }
export function List() { return <ul><Row/></ul> }`,
    "List"
  );
  assert.match(text, /function Row\(\)/);
  assert.doesNotMatch(text, /Unused/);
});

test("closure includes defaultProps and displayName statements", () => {
  const text = closure(
    `export function Tag({ label }) { return <b>{label}</b> }
Tag.defaultProps = { label: "x" };
Tag.displayName = "TagThing";
other.call();`,
    "Tag"
  );
  assert.match(text, /Tag\.defaultProps = /);
  assert.match(text, /Tag\.displayName = /);
  assert.doesNotMatch(text, /other\.call/);
});

test("closure includes side-effect imports for every export", () => {
  const source = `import "./b.css";
import "./a.css";
export const A = () => <a/>;
export const B = () => <b/>;`;
  for (const name of ["A", "B"]) {
    const text = closure(source, name);
    assert.ok(text.startsWith(`import "./a.css";\nimport "./b.css";`), name);
  }
});

test("canonical import lines ignore unrelated specifiers", () => {
  const before = `import { a, b } from "x";\nexport const C = () => <i>{a}</i>;`;
  const after = `import { a, b, c } from "x";\nexport const C = () => <i>{a}</i>;`;
  assert.equal(closure(before, "C"), closure(after, "C"));
  assert.match(closure(before, "C"), /^import \{ a as a \} from "x";/);
  const aliased = closure(`import D, * as NS from "y";\nexport const E = () => <D>{NS.v}</D>;`, "E");
  assert.match(aliased, /import \{ default as D \} from "y";/);
  assert.match(aliased, /import \* as NS from "y";/);
});

test("normalization ignores formatting, quotes, comments and trailing commas", () => {
  const before = `import { memo, forwardRef } from "react";
export const IconButton = memo(forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => <button className='btn' ref={ref}>{p.icon}</button>));`;
  const after = `import { memo, forwardRef } from "react";
// a comment
export const IconButton = memo(
  forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => (
    <button className="btn" ref={ref}>
      {p.icon}
    </button>
  )),
);`;
  assert.notEqual(closure(before, "IconButton"), closure(after, "IconButton"));
  assert.equal(normalized(before, "IconButton"), normalized(after, "IconButton"));
  assert.equal(normalizeSource("const n = 1_000;", "x.ts"), normalizeSource("const n = 1000;", "x.ts"));
});

test("normalization ignores type-only edits", () => {
  const before = `type P = { label: string };
export function L({ label }: P) { return <b>{label}</b> }`;
  const after = `interface P { label: string; extra?: number }
export function L({ label }: P): JSX.Element { return <b>{label}</b> }`;
  assert.equal(normalized(before, "L"), normalized(after, "L"));
});

test("normalization detects literal, className and JSX changes", () => {
  const base = `export function A(p: { icon: string }) { return <div className="a">{p.icon} hi</div> }`;
  const variants = [
    base.replace(`className="a"`, `className="b"`),
    base.replace("{p.icon} hi", "{p.icon}hi"),
    base.replace("<div", "<section").replace("</div>", "</section>"),
    base.replace(` hi`, ` ho`)
  ];
  for (const variant of variants) {
    assert.notEqual(normalized(base, "A"), normalized(variant, "A"), variant);
  }
});

test("equal raw closures skip transpileModule", async (t) => {
  const counting = new ComponentDetector();
  let calls = 0;
  const original = counting.normalizeText.bind(counting);
  counting.normalizeText = (raw: string, fileName: string): string => {
    calls++;
    return original(raw, fileName);
  };
  const files = {
    "src/A.tsx": `export const A = () => <a/>;\nexport const B = () => <b/>;\n`
  };
  const head = { "src/A.tsx": `${files["src/A.tsx"]}// trailing comment\n` };
  const wt = await makeWorktrees({ base: files, head });
  t.after(() => wt.cleanup());
  const service = new ChangeAnalysisService({
    gitClient: stubGitClient(diffEntries(files, head)),
    ...stubPersistence(),
    detector: counting
  });
  const result = await service.analyze(makeContext({ baseDir: wt.baseDir, headDir: wt.headDir }));
  assert.equal(result.candidates.length, 0);
  assert.equal(calls, 0, "no closure differed, so nothing was normalized");
});

test("sibling export change does not mark export as modified", () => {
  const before = `import { memo, forwardRef } from "react";
import styles from "./Button.module.css";
export interface ButtonProps { label: string; variant?: "primary" | "ghost" }
const cx = (...c: Array<string | false>) => c.filter(Boolean).join(" ");
export function Button({ label, variant = "primary" }: ButtonProps) {
  return <button className={cx(styles.btn, variant === "ghost" && styles.ghost)}>{label}</button>;
}
export const IconButton = memo(forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => <button ref={ref}>{p.icon}</button>));
export const useButtonSize = (): number => 32;`;
  const after = before
    .replace("{label}</button>", "{label.toUpperCase()}</button>")
    .replace(
      `memo(forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => <button ref={ref}>{p.icon}</button>));`,
      `memo(\n  forwardRef<HTMLButtonElement, { icon: string }>((p, ref) => (\n    <button ref={ref}>{p.icon}</button>\n  )),\n);`
    );
  assert.notEqual(normalized(before, "Button"), normalized(after, "Button"));
  assert.equal(normalized(before, "IconButton"), normalized(after, "IconButton"));
  assert.equal(normalized(before, "useButtonSize"), normalized(after, "useButtonSize"));
});

test("residual side-effect change yields wildcard seed", async (t) => {
  const base = {
    "src/lib/setup.ts": `export const VERSION = 1;\nregisterTheme("light");\n`,
    "src/components/Panel.tsx": `import { VERSION } from "../lib/setup";\nexport function Panel() { return <p>{VERSION}</p> }\n`,
    "src/components/Other.tsx": `import "../lib/setup";\nexport function Other() { return <i/> }\n`
  };
  const head = { ...base, "src/lib/setup.ts": `export const VERSION = 1;\nregisterTheme("dark");\n` };
  const wt = await makeWorktrees({ base, head });
  t.after(() => wt.cleanup());
  const service = new ChangeAnalysisService({
    gitClient: stubGitClient(diffEntries(base, head)),
    ...stubPersistence()
  });
  const result = await service.analyze(makeContext({ baseDir: wt.baseDir, headDir: wt.headDir }));
  assert.deepEqual(
    result.candidates.map((c) => [c.filePath, c.exportName, c.changeKind, c.reason]),
    [
      ["src/components/Other.tsx", "Other", "affected_parent", "Imports changed module src/lib/setup.ts"],
      ["src/components/Panel.tsx", "Panel", "affected_parent", "Imports changed module src/lib/setup.ts"]
    ]
  );
});

test("falls back to whitespace-collapsed text when transpile throws", () => {
  const out = normalizeSource("const  a =\n   1;", "x.ts", () => {
    throw new Error("boom");
  });
  assert.equal(out, "const a = 1;");
});
