import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import ts from "typescript";
import { parseArgs, resolveDataDir } from "../../../tools/create-angular-fixture-repo.mjs";
import {
  ANGULAR_PROJECT,
  APP_ROOT,
  BRANCHES,
  BUILD_FAILURE_BRANCHES,
  FIXTURE_VERSION,
  MAIN_FILES,
  PINNED_VERSIONS
} from "../../../tools/fixture-repo/sample-angular-app-files.mjs";
import { makeTempDir } from "../helpers/temp-dir";
import { isolatedGitEnv } from "../helpers/temp-git-repo";

const SCRIPT = path.resolve(__dirname, "../../../tools/create-angular-fixture-repo.mjs");
const FIXTURE_NAME = "sample-angular-monorepo";
const EXPECTED_BRANCHES = [
  "main",
  "feature/badge-restyle",
  "qa/service-change",
  "qa/template-formatting",
  "qa/signal-inputs",
  "qa/ngmodule-chip",
  "qa/build-error",
  "qa/render-failure",
  "qa/global-style",
  "qa/replaced-component" // 00 §17
];
const web = (relative: string): string => `${APP_ROOT}/${relative}`;
/** Files sheet 15 §5.9.2 lists for the app root (app.component.ts and app.routes.ts are the bootstrap additions). */
const SPEC_FILES = [
  "package.json",
  "angular.json",
  "tailwind.config.js",
  "tsconfig.json",
  "tsconfig.app.json",
  "src/index.html",
  "src/main.ts",
  "src/styles.css",
  "src/app/tokens.ts",
  "src/app/shared/badge/badge.component.ts",
  "src/app/shared/badge/badge.component.html",
  "src/app/shared/badge/badge.component.css",
  "src/app/shared/signal-card/signal-card.component.ts",
  "src/app/shared/legacy-chip/legacy-chip.module.ts",
  "src/app/orders/orders.service.ts",
  "src/app/orders/order-list/order-list.component.ts",
  "src/app/orders/order-list/order-list.component.html",
  "src/app/orders/order-list/order-list.component.scss",
  "src/app/notifications/poller.service.ts",
  "src/app/notifications/notification-bell.component.ts"
].map(web);
const skip = spawnSync("git", ["--version"]).status !== 0 ? "git is not available" : false;

interface Marker {
  version: number;
  packageManager: string;
  installed: boolean;
  branches: Record<string, string>;
  createdAt: string;
}

interface PackageJson {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
  return { dataDir: temp.path, root: path.join(temp.path, "fixtures", FIXTURE_NAME), cleanup: temp.cleanup };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: isolatedGitEnv(), encoding: "utf8" }).trimEnd();
}

function readMarker(root: string): Marker {
  return JSON.parse(fs.readFileSync(path.join(root, ".git", "prvision-fixture.json"), "utf8")) as Marker;
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

function mainFile(relative: string): string {
  const content = MAIN_FILES[relative];
  assert.ok(content !== undefined, `MAIN_FILES has no ${relative}`);
  return content;
}

function branchFile(branchName: string, relative: string): string {
  const branch = BRANCHES.find((candidate) => candidate.name === branchName);
  const content = branch?.commits
    .flatMap((step) => Object.entries(step.files ?? {}))
    .find(([file]) => file === relative);
  assert.ok(content, `${branchName} does not change ${relative}`);
  return content[1];
}

let shared: { dataDir: string; root: string; cleanup: () => void } | null = null;
function sharedRoot(): string {
  assert.ok(shared, "shared fixture was not created");
  return shared.root;
}

before(() => {
  if (!skip) {
    shared = createFixture("ng-fixture");
  }
});
after(() => {
  shared?.cleanup();
});

test("creates the fixture with all ten branches and a clean tree", { skip }, () => {
  const root = sharedRoot();
  const branches = git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  assert.deepEqual([...branches].sort(), [...EXPECTED_BRANCHES].sort());
  assert.deepEqual(
    BRANCHES.map((branch) => branch.name),
    EXPECTED_BRANCHES.slice(1)
  );
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("main contains every MAIN_FILES path with exact content, including every file the spec lists", { skip }, () => {
  const root = sharedRoot();
  const tracked = git(root, "ls-tree", "-r", "--name-only", "main").split("\n");
  assert.deepEqual([...tracked].sort(), Object.keys(MAIN_FILES).sort());
  for (const file of [".gitignore", "package.json", ...SPEC_FILES]) {
    assert.ok(tracked.includes(file), `missing ${file}`);
  }
  for (const [file, content] of Object.entries(MAIN_FILES)) {
    assert.ok(content.endsWith("\n") && !content.endsWith("\n\n") && !content.includes("\r"), `${file} line endings`);
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), content, file);
  }
});

test("the repository root has no dependencies and the app root pins Angular 21.2, Tailwind 3.4 and TypeScript 5.9", () => {
  const rootPackage = JSON.parse(mainFile("package.json")) as PackageJson;
  assert.deepEqual(rootPackage, { name: FIXTURE_NAME, private: true });

  const appPackage = JSON.parse(mainFile(web("package.json"))) as PackageJson;
  const deps = appPackage.dependencies ?? {};
  const devDeps = appPackage.devDependencies ?? {};
  for (const name of ["core", "common", "compiler", "platform-browser", "router", "forms", "animations"]) {
    assert.match(deps[`@angular/${name}`] ?? "", /^21\.2\.\d+$/, `@angular/${name}`);
  }
  assert.match(deps["@angular/cdk"] ?? "", /^21\.2\.\d+$/);
  assert.match(deps.rxjs ?? "", /^7\.8\.\d+$/);
  assert.match(deps["zone.js"] ?? "", /^0\.15\.\d+$/);
  assert.ok(deps.tslib);
  for (const name of ["@angular/build", "@angular/cli", "@angular/compiler-cli"]) {
    assert.match(devDeps[name] ?? "", /^21\.2\.\d+$/, name);
  }
  assert.match(devDeps.typescript ?? "", /^5\.9\.\d+$/);
  assert.match(devDeps.tailwindcss ?? "", /^3\.4\.\d+$/);
  assert.ok(devDeps.postcss && devDeps.autoprefixer);
  // Exact pins only, so every install of one FIXTURE_VERSION resolves the same top-level versions.
  for (const version of [...Object.values(deps), ...Object.values(devDeps)]) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
  }
  assert.equal(deps["@angular/core"], PINNED_VERSIONS.angular);
  assert.equal(devDeps["@angular/build"], PINNED_VERSIONS.angularCli);
});

test("angular.json declares one application project built with @angular/build:application", () => {
  interface AngularJson {
    projects: Record<
      string,
      {
        projectType: string;
        sourceRoot: string;
        architect: {
          build: {
            builder: string;
            options: { polyfills: string[]; styles: string[]; tsConfig: string; browser: string };
            configurations: Record<string, unknown>;
          };
        };
      }
    >;
  }
  const workspace = JSON.parse(mainFile(web("angular.json"))) as AngularJson;
  assert.deepEqual(Object.keys(workspace.projects), [ANGULAR_PROJECT]);
  const project = workspace.projects[ANGULAR_PROJECT];
  assert.ok(project);
  assert.equal(project.projectType, "application");
  assert.equal(project.sourceRoot, "src");
  const build = project.architect.build;
  assert.equal(build.builder, "@angular/build:application");
  assert.deepEqual(build.options.polyfills, ["zone.js"]);
  assert.deepEqual(build.options.styles, ["src/styles.css"]);
  assert.equal(build.options.tsConfig, "tsconfig.app.json");
  assert.deepEqual(Object.keys(build.configurations).sort(), ["development", "production"]);

  const appTsconfig = JSON.parse(mainFile(web("tsconfig.app.json"))) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  assert.deepEqual(appTsconfig.compilerOptions.paths, { "@app/*": ["./src/app/*"] });
  assert.match(mainFile(web("tailwind.config.js")), /content: \["\.\/src\/\*\*\/\*\.\{html,ts\}"\]/);
  assert.match(mainFile(web("src/styles.css")), /@tailwind base;\n@tailwind components;\n@tailwind utilities;\n/);
});

test("main covers standalone, NgModule-declared and signal-input components, HttpClient and a timer service", () => {
  const mainTs = mainFile(web("src/main.ts"));
  for (const provider of [
    "provideZoneChangeDetection(",
    "provideRouter(",
    "provideHttpClient()",
    '{ provide: API_BASE_URL, useValue: "/api" }',
    "provideAnimations()"
  ]) {
    assert.ok(mainTs.includes(provider), provider);
  }
  assert.match(mainFile(web("src/app/tokens.ts")), /new InjectionToken<string>\("API_BASE_URL"\)/);
  const badge = mainFile(web("src/app/shared/badge/badge.component.ts"));
  assert.match(badge, /selector: "app-badge"/);
  assert.match(badge, /@Input\(\{ required: true \}\) label/);
  assert.match(badge, /@Input\(\) tone/);
  const signalCard = mainFile(web("src/app/shared/signal-card/signal-card.component.ts"));
  assert.match(signalCard, /input\.required<string>\(\)/);
  assert.match(signalCard, /input\(0, \{ transform:/);
  assert.match(signalCard, /template: `/);
  const chip = mainFile(web("src/app/shared/legacy-chip/legacy-chip.module.ts"));
  assert.match(chip, /standalone: false/);
  assert.match(chip, /@NgModule\(\{\n {2}declarations: \[LegacyChipComponent\]/);
  const service = mainFile(web("src/app/orders/orders.service.ts"));
  assert.match(service, /inject\(HttpClient\)/);
  assert.match(service, /inject\(API_BASE_URL\)/);
  assert.doesNotMatch(service, /constructor\(/);
  const orderListTs = mainFile(web("src/app/orders/order-list/order-list.component.ts"));
  assert.match(orderListTs, /inject\(OrdersService\)/);
  assert.match(orderListTs, /from "@app\/shared\/badge\/badge.component"/);
  const orderListHtml = mainFile(web("src/app/orders/order-list/order-list.component.html"));
  for (const fragment of ["<app-badge ", "@for (", "@if (", "@empty"]) {
    assert.ok(orderListHtml.includes(fragment), fragment);
  }
  assert.match(mainFile(web("src/app/notifications/poller.service.ts")), /constructor\(\) \{\n.*interval\(30000\)/);
  assert.match(
    mainFile(web("src/app/notifications/notification-bell.component.ts")),
    /constructor\(readonly poller: PollerService\)/
  );
});

test("each branch changes exactly the files listed in BRANCHES", { skip }, () => {
  const root = sharedRoot();
  for (const branch of BRANCHES) {
    const changed = git(root, "diff", "--name-only", branch.from, branch.name).split("\n").filter(Boolean).sort();
    assert.deepEqual(changed, netChangedFiles(branch), branch.name);
    assert.equal(git(root, "rev-list", "--count", `${branch.from}..${branch.name}`), String(branch.commits.length));
  }
});

test("branch changes match the sheet 15 §5.9.2 table", { skip }, () => {
  const root = sharedRoot();
  const changedFiles = (branch: string): string[] =>
    git(root, "diff", "--name-status", "main", branch).split("\n").filter(Boolean).sort();
  assert.deepEqual(changedFiles("feature/badge-restyle"), [
    `M\t${web("src/app/shared/badge/badge.component.css")}`,
    `M\t${web("src/app/shared/badge/badge.component.html")}`
  ]);
  assert.deepEqual(changedFiles("qa/service-change"), [`M\t${web("src/app/orders/orders.service.ts")}`]);
  assert.deepEqual(changedFiles("qa/template-formatting"), [
    `M\t${web("src/app/orders/order-list/order-list.component.html")}`
  ]);
  assert.deepEqual(changedFiles("qa/signal-inputs"), [
    `M\t${web("src/app/shared/signal-card/signal-card.component.ts")}`
  ]);
  assert.deepEqual(changedFiles("qa/ngmodule-chip"), [`M\t${web("src/app/shared/legacy-chip/legacy-chip.module.ts")}`]);
  assert.deepEqual(changedFiles("qa/build-error"), [
    `M\t${web("src/app/orders/order-list/order-list.component.html")}`
  ]);
  assert.deepEqual(changedFiles("qa/render-failure"), [`M\t${web("src/app/shared/badge/badge.component.ts")}`]);
  assert.deepEqual(changedFiles("qa/global-style"), [`M\t${web("src/styles.css")}`]);
  assert.deepEqual(changedFiles("qa/replaced-component"), [
    `A\t${web("src/app/orders/order-note-form-modal/order-note-form-modal.component.html")}`,
    `A\t${web("src/app/orders/order-note-form-modal/order-note-form-modal.component.ts")}`,
    `M\t${web("src/app/orders/order-list/order-list.component.html")}`,
    `M\t${web("src/app/orders/order-list/order-list.component.ts")}`
  ]);
  assert.deepEqual(BUILD_FAILURE_BRANCHES, ["qa/build-error"]);
});

test(
  "qa/replaced-component: the last commit replaces the note form with a -modal successor and swaps the call site",
  { skip },
  () => {
    const root = sharedRoot();
    const branch = "qa/replaced-component";
    const commitFiles = git(root, "diff", "--name-status", "--no-renames", `${branch}~1`, branch).split("\n").sort();
    assert.deepEqual(commitFiles, [
      `A\t${web("src/app/orders/order-note-form-modal/order-note-form-modal.component.html")}`,
      `A\t${web("src/app/orders/order-note-form-modal/order-note-form-modal.component.ts")}`,
      `D\t${web("src/app/orders/order-note-form/order-note-form.component.html")}`,
      `D\t${web("src/app/orders/order-note-form/order-note-form.component.ts")}`,
      `M\t${web("src/app/orders/order-list/order-list.component.html")}`,
      `M\t${web("src/app/orders/order-list/order-list.component.ts")}`
    ]);
    const html = web("src/app/orders/order-list/order-list.component.html");
    assert.match(git(root, "show", `${branch}~1:${html}`), /<app-order-note-form \/>/);
    assert.match(git(root, "show", `${branch}:${html}`), /<app-order-note-form-modal \/>/);
    assert.doesNotMatch(git(root, "show", `${branch}:${html}`), /<app-order-note-form \/>/);
    const modal = git(
      root,
      "show",
      `${branch}:${web("src/app/orders/order-note-form-modal/order-note-form-modal.component.ts")}`
    );
    assert.match(modal, /selector: "app-order-note-form-modal"/);
    assert.match(modal, /export class OrderNoteFormModalComponent/);
    assert.equal(git(root, "rev-list", "--count", `main..${branch}`), "2");
  }
);

test("branch contents carry the intended change", () => {
  const badgeHtml = web("src/app/shared/badge/badge.component.html");
  const restyled = branchFile("feature/badge-restyle", badgeHtml);
  assert.notEqual(restyled, mainFile(badgeHtml));
  assert.match(restyled, /rounded-md px-3 py-1 text-sm/);
  assert.match(restyled, /Status: \{\{ label \}\}/);
  assert.notEqual(
    branchFile("feature/badge-restyle", web("src/app/shared/badge/badge.component.css")),
    mainFile(web("src/app/shared/badge/badge.component.css"))
  );

  const orderListHtml = web("src/app/orders/order-list/order-list.component.html");
  const reindented = branchFile("qa/template-formatting", orderListHtml);
  assert.notEqual(reindented, mainFile(orderListHtml));
  assert.equal(
    reindented.replace(/^ +/gm, ""),
    mainFile(orderListHtml).replace(/^ +/gm, ""),
    "only indentation changes"
  );

  assert.match(branchFile("qa/build-error", orderListHtml), /\[size\]="'lg'"/);
  assert.match(
    branchFile("qa/signal-inputs", web("src/app/shared/signal-card/signal-card.component.ts")),
    /readonly trend = input</
  );
  assert.match(
    branchFile("qa/render-failure", web("src/app/shared/badge/badge.component.ts")),
    /ngOnInit\(\): void \{\n.*danger/
  );
  assert.match(branchFile("qa/global-style", web("src/styles.css")), /\.card \{[^}]*padding: 1\.75rem;/);
});

test("commit SHAs are identical across two independent runs", { skip }, () => {
  const other = createFixture("ng-fixture-b");
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
  const temp = makeTempDir("ng-fixture-foreign");
  try {
    const root = path.join(temp.path, "fixtures", FIXTURE_NAME);
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
  const fixture = createFixture("ng-fixture-reset");
  try {
    const { root, dataDir } = fixture;
    const marker = readMarker(root);
    const installed = path.join(root, APP_ROOT, "node_modules", "@angular", "build");
    git(root, "branch", "-f", "feature/badge-restyle", "main");
    git(root, "branch", "scratch");
    git(root, "update-ref", "refs/prvision/pr-1", marker.branches.main ?? "");
    fs.writeFileSync(path.join(root, APP_ROOT, "untracked.txt"), "x\n");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "package.json"), '{ "name": "@angular/build" }\n');

    const refused = runScript("--skip-install", "--data-dir", dataDir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Fixture branches were modified/);

    const reset = runScript("--reset", "--data-dir", dataDir);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(git(root, "rev-parse", "refs/heads/feature/badge-restyle"), marker.branches["feature/badge-restyle"]);
    assert.equal(fs.existsSync(path.join(root, APP_ROOT, "untracked.txt")), false);
    assert.ok(fs.existsSync(path.join(installed, "package.json")), "ignored app-root node_modules is kept");
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
  const temp = makeTempDir("ng-fixture-symlink");
  const elsewhere = makeTempDir("ng-fixture-elsewhere");
  try {
    fs.mkdirSync(path.join(temp.path, "fixtures"), { recursive: true });
    fs.symlinkSync(elsewhere.path, path.join(temp.path, "fixtures", FIXTURE_NAME), "dir");
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

test("every TypeScript source on every branch parses, and every JSON file is valid", () => {
  const sources: Array<[string, string]> = [
    ...Object.entries(MAIN_FILES),
    ...BRANCHES.flatMap((branch) => branch.commits.flatMap((step) => Object.entries(step.files ?? {})))
  ];
  const typescriptSources = sources.filter(([file]) => file.endsWith(".ts"));
  assert.ok(typescriptSources.length >= 14);
  for (const [file, source] of typescriptSources) {
    const output = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: {
        experimentalDecorators: true,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022
      }
    });
    const messages = (output.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(messages, [], file);
  }
  for (const [file, source] of sources.filter(([name]) => name.endsWith(".json"))) {
    assert.doesNotThrow(() => JSON.parse(source), file);
  }
});
