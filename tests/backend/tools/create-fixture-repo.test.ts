import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import ts from "typescript";
import { parseArgs, resolveDataDir } from "../../../tools/create-fixture-repo.mjs";
import {
  BRANCHES,
  FIXTURE_VERSION,
  MAIN_FILES,
  WORKING_TREE_EXTRAS
} from "../../../tools/fixture-repo/sample-app-files.mjs";
import { makeTempDir } from "../helpers/temp-dir";
import { isolatedGitEnv } from "../helpers/temp-git-repo";

const SCRIPT = path.resolve(__dirname, "../../../tools/create-fixture-repo.mjs");
const EXPECTED_BRANCHES = [
  "main",
  "feature/button-restyle",
  "qa/render-failure",
  "qa/no-visual-change",
  "qa/css-module-only",
  "qa/dependency-drift",
  "qa/replaced-component", // 00 §17
  "qa/global-style", // 16 §20.10
  "qa/states",
  "qa/library-break"
];
const skip = spawnSync("git", ["--version"]).status !== 0 ? "git is not available" : false;

interface Marker {
  version: number;
  packageManager: string;
  installed: boolean;
  branches: Record<string, string>;
  createdAt: string;
}

function runScript(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Creates a fixture under a fresh temp data dir (no install) and returns its paths. */
function createFixture(label: string): { dataDir: string; root: string; cleanup: () => void } {
  const temp = makeTempDir(label);
  const result = runScript("--skip-install", "--data-dir", temp.path);
  assert.equal(result.status, 0, result.stderr);
  return { dataDir: temp.path, root: path.join(temp.path, "fixtures", "sample-react-app"), cleanup: temp.cleanup };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: isolatedGitEnv(), encoding: "utf8" }).trimEnd();
}

/**
 * Files a branch changes against `from` (main): every file its commits write or remove whose final content differs
 * from main. A file added by one commit and removed by a later one (qa/replaced-component) is not a change.
 */
function netChangedFiles(branch: (typeof BRANCHES)[number]): string[] {
  const state = new Map(Object.entries(MAIN_FILES));
  const touched = new Set<string>();
  for (const step of branch.commits) {
    for (const [file, content] of Object.entries(step.files ?? {})) {
      state.set(file, content.endsWith("\n") ? content : `${content}\n`);
      touched.add(file);
    }
    for (const file of step.remove ?? []) {
      state.delete(file);
      touched.add(file);
    }
  }
  return [...touched].filter((file) => state.get(file) !== MAIN_FILES[file]).sort();
}

function readMarker(root: string): Marker {
  return JSON.parse(fs.readFileSync(path.join(root, ".git", "prvision-fixture.json"), "utf8")) as Marker;
}

let shared: { dataDir: string; root: string; cleanup: () => void } | null = null;
function sharedRoot(): string {
  assert.ok(shared, "shared fixture was not created");
  return shared.root;
}

before(() => {
  if (!skip) {
    shared = createFixture("fixture");
  }
});
after(() => {
  shared?.cleanup();
});

test("creates the fixture with all ten branches and a clean tree", { skip }, () => {
  const root = sharedRoot();
  const branches = git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  assert.deepEqual([...branches].sort(), [...EXPECTED_BRANCHES].sort());
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("main contains every MAIN_FILES path with exact content", { skip }, () => {
  const root = sharedRoot();
  const tracked = git(root, "ls-tree", "-r", "--name-only", "main").split("\n");
  assert.deepEqual([...tracked].sort(), Object.keys(MAIN_FILES).sort());
  for (const [file, content] of Object.entries(MAIN_FILES)) {
    assert.ok(content.endsWith("\n") && !content.endsWith("\n\n") && !content.includes("\r"), `${file} line endings`);
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), content, file);
  }
});

test(
  "feature/button-restyle differs from main in exactly Button.tsx, Card.tsx, useAuth.ts and the added Badge.tsx",
  { skip },
  () => {
    const diff = git(sharedRoot(), "diff", "--name-status", "main", "feature/button-restyle").split("\n").sort();
    assert.deepEqual(diff, [
      "A\tsrc/components/Badge.tsx",
      "M\tsrc/auth/useAuth.ts",
      "M\tsrc/components/Button.tsx",
      "M\tsrc/components/Card.tsx"
    ]);
  }
);

test("each qa branch changes exactly the files listed in BRANCHES", { skip }, () => {
  const root = sharedRoot();
  for (const branch of BRANCHES) {
    const changed = git(root, "diff", "--name-only", branch.from, branch.name).split("\n").filter(Boolean).sort();
    assert.deepEqual(changed, netChangedFiles(branch), branch.name);
    assert.equal(git(root, "rev-list", "--count", `${branch.from}..${branch.name}`), String(branch.commits.length));
  }
});

test(
  "qa/replaced-component: commit 1 adds the Notes page with NoteForm, commit 2 replaces it with NoteFormModal",
  { skip },
  () => {
    const root = sharedRoot();
    const branch = "qa/replaced-component";
    assert.deepEqual(git(root, "diff", "--name-status", "main", branch).split("\n").sort(), [
      "A\tsrc/components/notes/NoteFormModal.tsx",
      "A\tsrc/pages/Notes.tsx",
      "M\tsrc/App.tsx"
    ]);
    // the visualized commit (base = its parent): R deleted, A added, the call site swapped
    assert.deepEqual(git(root, "diff", "--name-status", "--no-renames", `${branch}~1`, branch).split("\n").sort(), [
      "A\tsrc/components/notes/NoteFormModal.tsx",
      "D\tsrc/components/notes/NoteForm.tsx",
      "M\tsrc/pages/Notes.tsx"
    ]);
    const before = git(root, "show", `${branch}~1:src/pages/Notes.tsx`);
    const after = git(root, "show", `${branch}:src/pages/Notes.tsx`);
    assert.match(before, /<NoteForm \/>/);
    assert.match(after, /<NoteFormModal \/>/);
    assert.doesNotMatch(after, /<NoteForm \/>/);
    assert.match(
      git(root, "show", `${branch}:src/components/notes/NoteFormModal.tsx`),
      /export function NoteFormModal\(/
    );
    assert.equal(git(root, "rev-list", "--count", `main..${branch}`), "2");
  }
);

test("commit SHAs are identical across two independent runs", { skip }, () => {
  const other = createFixture("fixture-b");
  try {
    assert.deepEqual(readMarker(other.root).branches, readMarker(sharedRoot()).branches);
  } finally {
    other.cleanup();
  }
});

test("writes the marker inside .git with version, branches and installed false", { skip }, () => {
  const root = sharedRoot();
  const marker = readMarker(root);
  assert.equal(marker.version, FIXTURE_VERSION);
  assert.equal(marker.packageManager, "npm");
  assert.equal(marker.installed, false);
  assert.deepEqual(Object.keys(marker.branches).sort(), [...EXPECTED_BRANCHES].sort());
  for (const [name, sha] of Object.entries(marker.branches)) {
    assert.equal(git(root, "rev-parse", `refs/heads/${name}`), sha);
  }
  assert.ok(!Number.isNaN(Date.parse(marker.createdAt)));
  assert.equal(git(root, "status", "--porcelain", "--ignored"), "", "the marker is never tracked or dirty");
});

test("a second run without flags is a no-op and exits 0", { skip }, () => {
  assert.ok(shared);
  const previous = { marker: readMarker(shared.root), head: git(shared.root, "rev-parse", "HEAD") };
  const result = runScript("--skip-install", "--data-dir", shared.dataDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already exists/);
  assert.deepEqual(readMarker(shared.root), previous.marker);
  assert.equal(git(shared.root, "rev-parse", "HEAD"), previous.head);
});

test("a foreign directory is refused (exit 1) and --force recreates it", { skip }, () => {
  const temp = makeTempDir("fixture-foreign");
  try {
    const root = path.join(temp.path, "fixtures", "sample-react-app");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "keep.txt"), "not a fixture\n");
    const refused = runScript("--skip-install", "--data-dir", temp.path);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /was not created by fixture version/);
    assert.ok(fs.existsSync(path.join(root, "keep.txt")));

    const forced = runScript("--force", "--skip-install", "--data-dir", temp.path);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.existsSync(path.join(root, "keep.txt")), false);
    assert.deepEqual(readMarker(root).branches, readMarker(sharedRoot()).branches);
  } finally {
    temp.cleanup();
  }
});

test("a moved fixture branch is refused (exit 1) and --reset restores it", { skip }, () => {
  const fixture = createFixture("fixture-reset");
  try {
    const { root, dataDir } = fixture;
    const marker = readMarker(root);
    git(root, "branch", "-f", "feature/button-restyle", "main");
    git(root, "branch", "scratch");
    git(root, "update-ref", "refs/prvision/pr-1", marker.branches.main ?? "");
    fs.writeFileSync(path.join(root, "untracked.txt"), "x\n");
    fs.mkdirSync(path.join(root, "node_modules", "vite"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "vite", "package.json"), '{ "name": "vite" }\n');

    const refused = runScript("--skip-install", "--data-dir", dataDir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Fixture branches were modified/);

    const reset = runScript("--reset", "--data-dir", dataDir);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(
      git(root, "rev-parse", "refs/heads/feature/button-restyle"),
      marker.branches["feature/button-restyle"]
    );
    assert.equal(fs.existsSync(path.join(root, "untracked.txt")), false);
    assert.ok(fs.existsSync(path.join(root, "node_modules", "vite", "package.json")), "ignored node_modules is kept");
    assert.equal(git(root, "for-each-ref", "refs/prvision"), "");
    assert.deepEqual(
      git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort(),
      [...EXPECTED_BRANCHES].sort()
    );
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally {
    fixture.cleanup();
  }
});

test("a symlinked target is refused", { skip }, () => {
  const temp = makeTempDir("fixture-symlink");
  const elsewhere = makeTempDir("fixture-elsewhere");
  try {
    fs.mkdirSync(path.join(temp.path, "fixtures"), { recursive: true });
    fs.symlinkSync(elsewhere.path, path.join(temp.path, "fixtures", "sample-react-app"), "dir");
    const result = runScript("--force", "--skip-install", "--data-dir", temp.path);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is a symlink; refusing/);
    assert.ok(fs.existsSync(elsewhere.path));
  } finally {
    temp.cleanup();
    elsewhere.cleanup();
  }
});

test("unknown arguments and --force with --reset are rejected", () => {
  const unknown = runScript("--frobnicate");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument: --frobnicate/);
  const both = runScript("--force", "--reset");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /mutually exclusive/);
  assert.throws(() => parseArgs(["--pm", "bun"]), /--pm must be one of/);
  assert.throws(() => parseArgs(["--data-dir"]), /--data-dir needs a value/);
});

test("parseArgs and resolveDataDir handle ~ expansion and PRVISION_DATA_DIR", () => {
  assert.deepEqual(parseArgs(["--skip-install", "--data-dir", "~/x", "--pm", "pnpm"]), {
    force: false,
    reset: false,
    skipInstall: true,
    dataDir: "~/x",
    pm: "pnpm",
    help: false
  });
  assert.equal(parseArgs([]).pm, "npm");
  assert.equal(resolveDataDir("~"), os.homedir());
  assert.equal(resolveDataDir("~/x/y"), path.join(os.homedir(), "x", "y"));
  assert.equal(resolveDataDir("/tmp/a/../b"), "/tmp/b");
  // No flag: the preload's PRVISION_DATA_DIR (a per-process temp dir) wins over ~/.prvision.
  assert.equal(resolveDataDir(null), path.resolve(process.env.PRVISION_DATA_DIR ?? ""));
});

test("the main branch typechecks as TypeScript source", () => {
  const sources: Array<[string, string]> = [
    ...Object.entries(MAIN_FILES),
    ...BRANCHES.flatMap((branch) => branch.commits.flatMap((step) => Object.entries(step.files ?? {}))),
    ...Object.entries(WORKING_TREE_EXTRAS.modify),
    ...Object.entries(WORKING_TREE_EXTRAS.untracked)
  ];
  const typescriptSources = sources.filter(([file]) => /\.tsx?$/.test(file));
  assert.ok(typescriptSources.length >= 20);
  for (const [file, source] of typescriptSources) {
    const output = ts.transpileModule(source, {
      fileName: file.replace(/\.d\.ts$/, ".ts"), // declaration files have no emit; parse them as plain TS
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    });
    const messages = (output.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(messages, [], file);
  }
  for (const file of ["package.json", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
    assert.doesNotThrow(() => JSON.parse(MAIN_FILES[file] ?? ""), file);
  }
});

test("sheet 16 §20.10 branches: global style, states and library break change exactly their files", { skip }, () => {
  const root = sharedRoot();
  const changed = (branch: string): string[] =>
    git(root, "diff", "--name-status", "main", branch).split("\n").filter(Boolean).sort();
  assert.deepEqual(changed("qa/global-style"), ["M\tsrc/index.css"]);
  assert.deepEqual(changed("qa/states"), ["A\tsrc/components/InvoiceRow.tsx", "M\tsrc/pages/Dashboard.tsx"]);
  assert.deepEqual(changed("qa/library-break"), ["M\tsrc/components/Card.tsx", "M\tsrc/pages/Dashboard.tsx"]);
  const css = git(root, "show", "qa/global-style:src/index.css");
  assert.ok(css.includes("font-size: 17px;") && css.includes("--radius-xl: 1.5rem;"));
  const row = git(root, "show", "qa/states:src/components/InvoiceRow.tsx");
  for (const needle of ['aria-label="More actions"', "Overdue since", 'className="truncate']) {
    assert.ok(row.includes(needle), needle);
  }
  const card = git(root, "show", "qa/library-break:src/components/Card.tsx");
  assert.ok(card.includes("heading: string;") && card.includes("heading.toUpperCase()"));
  assert.ok(!git(root, "show", "qa/library-break:src/pages/Dashboard.tsx").includes("<Card title="));
  assert.equal(FIXTURE_VERSION, 3);
});
