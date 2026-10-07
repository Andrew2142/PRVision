import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  fingerprintText,
  LibraryFingerprinter,
  normalizeCss
} from "../../../backend/src/services/harness-library/library-fingerprint";

type Files = Record<string, string>;

const fingerprinter = new LibraryFingerprinter();

function reactPrint(files: Files, filePath = "src/components/Card.tsx", exportName = "Card"): Promise<string | null> {
  return fingerprinter.fingerprint({
    framework: "react_vite",
    identity: { filePath, exportName },
    readFile: (repoPath) => Promise.resolve(files[repoPath] ?? null)
  });
}

const CARD = `import styles from "./Card.module.css";
import "./unrelated.css";
import { Badge } from "./Badge";

export function Card({ title }: { title: string }) {
  return <div className={styles.card}><h2>{title}</h2><Badge /></div>;
}
`;
const REACT_FILES: Files = {
  "src/components/Card.tsx": CARD,
  "src/components/Card.module.css": ".card { padding: 8px; /* roomy */ }",
  "src/components/unrelated.css": "body { margin: 0; }"
};

test("LibraryFingerprinter: a React fingerprint is 64 hex chars over the 16 §8.1 text", async () => {
  const print = await reactPrint(REACT_FILES);
  assert.match(print ?? "", /^[0-9a-f]{64}$/);
  const text = fingerprintText("react_vite", { filePath: "src/components/Card.tsx", exportName: "Card" }, ["a"]);
  assert.equal(text, "prvision-fp-v1\nreact_vite\nsrc/components/Card.tsx\nCard\na");
});

test("LibraryFingerprinter: formatting-only edits keep the fingerprint", async () => {
  const reformatted = {
    ...REACT_FILES,
    "src/components/Card.tsx": CARD.replace(
      "  return <div className={styles.card}><h2>{title}</h2><Badge /></div>;",
      "  // a comment\n  return (\n    <div className={styles.card}>\n      <h2>{title}</h2>\n      <Badge />\n    </div>\n  );"
    ).replace('"./Card.module.css"', "'./Card.module.css'"),
    "src/components/Card.module.css": ".card {\n  padding: 8px;\n}\n"
  };
  assert.equal(await reactPrint(reformatted), await reactPrint(REACT_FILES));
});

test("LibraryFingerprinter: a JSX or prop change changes the fingerprint", async () => {
  const base = await reactPrint(REACT_FILES);
  const jsx = { ...REACT_FILES, "src/components/Card.tsx": CARD.replace("<h2>", "<h3>").replace("</h2>", "</h3>") };
  const prop = {
    ...REACT_FILES,
    "src/components/Card.tsx": CARD.replace(
      "{ title }: { title: string }",
      "{ title, compact }: { title: string; compact?: boolean }"
    )
  };
  assert.notEqual(await reactPrint(jsx), base);
  assert.notEqual(await reactPrint(prop), base);
});

test("LibraryFingerprinter: a co-located CSS module change changes it; an unrelated stylesheet does not", async () => {
  const base = await reactPrint(REACT_FILES);
  assert.notEqual(
    await reactPrint({ ...REACT_FILES, "src/components/Card.module.css": ".card { padding: 12px; }" }),
    base
  );
  assert.equal(await reactPrint({ ...REACT_FILES, "src/components/unrelated.css": "body { margin: 4px; }" }), base);
});

test("LibraryFingerprinter: null when the file or the export is missing", async () => {
  assert.equal(await reactPrint({}), null);
  assert.equal(await reactPrint(REACT_FILES, "src/components/Card.tsx", "Missing"), null);
});

const COMPONENT = `import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-badge',
  standalone: true,
  templateUrl: './badge.component.html',
  styleUrls: ['./badge.component.css'],
})
export class BadgeComponent {
  @Input() label = '';
}
`;
const ANGULAR_FILES: Files = {
  "src/app/badge/badge.component.ts": COMPONENT,
  "src/app/badge/badge.component.html": '<span class="badge">{{ label }}</span>',
  "src/app/badge/badge.component.css": ".badge { color: red; }"
};

function angularPrint(files: Files): Promise<string | null> {
  return fingerprinter.fingerprint({
    framework: "angular",
    identity: { filePath: "src/app/badge/badge.component.ts", exportName: "BadgeComponent" },
    readFile: (repoPath) => Promise.resolve(files[repoPath] ?? null)
  });
}

test("LibraryFingerprinter: Angular template whitespace keeps the fingerprint", async () => {
  const base = await angularPrint(ANGULAR_FILES);
  assert.match(base ?? "", /^[0-9a-f]{64}$/);
  const spaced = {
    ...ANGULAR_FILES,
    "src/app/badge/badge.component.html": '<span   class="badge">\n  {{ label }}\n</span>\n'
  };
  assert.equal(await angularPrint(spaced), base);
});

test("LibraryFingerprinter: an Angular template text change and an external style change alter it", async () => {
  const base = await angularPrint(ANGULAR_FILES);
  assert.notEqual(
    await angularPrint({ ...ANGULAR_FILES, "src/app/badge/badge.component.html": '<b class="badge">{{ label }}!</b>' }),
    base
  );
  assert.notEqual(
    await angularPrint({ ...ANGULAR_FILES, "src/app/badge/badge.component.css": ".badge { color: blue; }" }),
    base
  );
  assert.notEqual(
    await angularPrint({
      ...ANGULAR_FILES,
      "src/app/badge/badge.component.ts": COMPONENT.replace("label = ''", "label = 'x'")
    }),
    base
  );
});

test("normalizeCss removes comments and collapses whitespace", () => {
  assert.equal(normalizeCss("/* a */ .x {\n  color : red;\n}\n"), ".x { color : red; }");
  assert.equal(createHash("sha256").update(normalizeCss(".x{}")).digest("hex").length, 64);
});
