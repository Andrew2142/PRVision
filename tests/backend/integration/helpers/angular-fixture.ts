/**
 * The sample-angular-monorepo fixture (15 §5.9.2) for the gated Angular integration tests: locating and cloning it,
 * and the hand-written Angular harnesses (15 §5.6.1) that a scripted AI provider or the render IT hands to the
 * pipeline. The fixture lives in the developer's REAL data dir and is never modified: tests work on clones.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { makeTempDir } from "../../helpers/temp-dir";
import { isolatedGitEnv } from "../../helpers/temp-git-repo";

/** App root and project of the fixture (tools/fixture-repo/sample-angular-app-files.mjs). */
export const ANGULAR_APP_ROOT = "apps/web";
export const ANGULAR_PROJECT = "web";

export const ANGULAR_FIXTURE_BRANCHES = [
  "main",
  "feature/badge-restyle",
  "qa/service-change",
  "qa/template-formatting",
  "qa/signal-inputs",
  "qa/ngmodule-chip",
  "qa/build-error",
  "qa/render-failure",
  "qa/global-style",
  "qa/replaced-component"
] as const;

export type AngularFixtureBranch = (typeof ANGULAR_FIXTURE_BRANCHES)[number];

/** <real data dir>/fixtures/sample-angular-monorepo. */
export function angularFixturePath(): string {
  return path.join(process.env.PRVISION_REAL_DATA_DIR!, "fixtures", "sample-angular-monorepo");
}

/** Throws a helpful error if the fixture is missing or not installed (flag on ⇒ the developer wants these to run). */
export function requireAngularFixtureRepo(): string {
  const root = angularFixturePath();
  if (!fs.existsSync(path.join(root, ".git", "prvision-fixture.json"))) {
    throw new Error(`Angular fixture repo missing at ${root}. Run: npm run fixture:create:angular`);
  }
  if (!fs.existsSync(path.join(root, ANGULAR_APP_ROOT, "node_modules", "@angular", "build", "package.json"))) {
    throw new Error("Angular fixture dependencies missing. Run: npm run fixture:create:angular (re-runs the install)");
  }
  return root;
}

/**
 * Clones the fixture into a temp dir with every branch local and `apps/web/node_modules` symlinked to the
 * fixture's. Never mutates the shared fixture.
 */
export function cloneAngularFixture(t: TestContext): string {
  const source = requireAngularFixtureRepo();
  const temp = makeTempDir("it-angular-clone");
  const target = path.join(temp.path, "sample-angular-monorepo");
  const env = isolatedGitEnv();
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", source, target], { env });
  for (const branch of ANGULAR_FIXTURE_BRANCHES.filter((b) => b !== "main")) {
    execFileSync("git", ["-C", target, "branch", "--quiet", branch, `origin/${branch}`], { env });
  }
  execFileSync("git", ["-C", target, "remote", "remove", "origin"], { env });
  fs.symlinkSync(
    path.join(source, ANGULAR_APP_ROOT, "node_modules"),
    path.join(target, ANGULAR_APP_ROOT, "node_modules"),
    "dir"
  );
  t.after(() => {
    temp.cleanup();
  });
  return target;
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-written harnesses (15 §5.6.1 / §5.6.5 rules). `TARGET` is replaced by the exact target import statement.
// ---------------------------------------------------------------------------------------------------------------

const TARGET = "/*TARGET*/";

/** Fixture rows for GET /api/orders (OrderDto shape of orders.service.ts). One is cancelled (qa/render-failure). */
const ORDERS_FIXTURE = `[
    { id: 'ord_9001', customer_name: 'Ada Lovelace', total_cents: 12950, status: 'paid' },
    { id: 'ord_9002', customer_name: '  Grace Hopper ', total_cents: 4999, status: 'shipped' },
    { id: 'ord_9003', customer_name: 'Alan Turing', total_cents: 2075, status: 'pending' },
    { id: 'ord_9004', customer_name: 'Katherine Johnson', total_cents: 8800, status: 'cancelled' },
  ]`;

interface AngularHarnessTemplate {
  source: string;
  /** Extra named imports added to the target import statement (same specifier, still one statement). */
  extraTargetNames?: string[];
  /**
   * Inputs set only when the prompt mentions them (as a model would, from <component_meta>): placeholder →
   * [pattern on the prompt, replacement]. Setting an input that neither side declares fails 15c's validator.
   */
  inputsFromMeta?: Record<string, [RegExp, string]>;
  notes: string;
}

/** Harness templates by component class name. */
export const ANGULAR_FIXTURE_HARNESSES: Record<string, AngularHarnessTemplate> = {
  BadgeComponent: {
    source: `import { definePrvisionHarness } from '../harness-api';
${TARGET}

export default definePrvisionHarness({
  component: BadgeComponent,
  inputs: { label: 'cancelled', tone: 'danger' },
  hostStyle: { width: '240px', padding: '16px' },
});
`,
    notes: "Danger tone with a short status label."
  },
  OrderListComponent: {
    source: `import { definePrvisionHarness } from '../harness-api';
${TARGET}
import { API_BASE_URL } from '../../src/app/tokens';

export default definePrvisionHarness({
  component: OrderListComponent,
  providers: [{ provide: API_BASE_URL, useValue: '/api' }],
  http: [
    {
      method: 'GET',
      url: '/api/orders',
      body: ${ORDERS_FIXTURE},
    },
  ],
  hostStyle: { width: '640px', padding: '16px' },
});
`,
    notes: "Four orders served through the real OrdersService and a canned /api/orders response."
  },
  SignalCardComponent: {
    source: `import { definePrvisionHarness } from '../harness-api';
${TARGET}

export default definePrvisionHarness({
  component: SignalCardComponent,
  inputs: { title: 'Orders this week', count: 12/*TREND*/ },
  hostStyle: { width: '360px', padding: '16px' },
});
`,
    notes: "Signal inputs; trend is set only when a side declares it.",
    inputsFromMeta: { "/*TREND*/": [/\btrend\b/, ", trend: 'up'"] }
  },
  LegacyChipComponent: {
    source: `import { importProvidersFrom } from '@angular/core';
import { definePrvisionHarness } from '../harness-api';
${TARGET}

export default definePrvisionHarness({
  component: LegacyChipComponent,
  inputs: { text: '3 new', tone: 'bad' },
  providers: [importProvidersFrom(LegacyChipModule)],
  hostStyle: { width: '240px', padding: '16px' },
});
`,
    extraTargetNames: ["LegacyChipModule"],
    notes: "NgModule-declared chip rendered through importProvidersFrom(LegacyChipModule)."
  },
  NotificationBellComponent: {
    source: `import { definePrvisionHarness } from '../harness-api';
${TARGET}

export default definePrvisionHarness({
  component: NotificationBellComponent,
  hostStyle: { width: '360px', padding: '16px' },
});
`,
    notes: "Real PollerService (its 30 s interval keeps the app unstable)."
  },
  // qa/replaced-component (00 §17): the removed form (base harness) and its -modal successor (head harness)
  OrderNoteFormComponent: {
    source: `import { definePrvisionHarness } from '../harness-api';
${TARGET}

export default definePrvisionHarness({
  component: OrderNoteFormComponent,
  hostStyle: { width: '480px', padding: '16px' },
});
`,
    notes: "The inline note form on its own."
  },
  OrderNoteFormModalComponent: {
    source: `import { definePrvisionHarness } from '../harness-api';
${TARGET}

export default definePrvisionHarness({
  component: OrderNoteFormModalComponent,
  inputs: { open: true },
  hostStyle: { width: '480px', padding: '16px' },
});
`,
    notes: "The note form dialog, open."
  },
  AppComponent: {
    source: `import { definePrvisionHarness } from '../harness-api';
${TARGET}

export default definePrvisionHarness({
  component: AppComponent,
  hostStyle: { width: '800px' },
});
`,
    notes: "Shell with navigation; the router never navigates, so the outlet is empty."
  }
};

/** Adds named imports to `import { A } from "x";` (keeps one statement for the target specifier). */
function withExtraNames(statement: string, names: string[]): string {
  if (names.length === 0) {
    return statement;
  }
  const replaced = statement.replace(
    /\{\s*([^}]*?)\s*\}/,
    (_match, inner: string) => `{ ${[inner, ...names].join(", ")} }`
  );
  if (replaced === statement) {
    throw new Error(`cannot add ${names.join(", ")} to the target import: ${statement}`);
  }
  return replaced;
}

/**
 * Harness source for `className` with the exact target import statement the prompt gave. `prompt` (the user prompt,
 * or "" for the render IT) decides the optional inputs of `inputsFromMeta`.
 */
export function angularFixtureHarness(
  className: string,
  targetImportStatement: string,
  prompt: string
): { harnessSource: string; notes: string } {
  const template = ANGULAR_FIXTURE_HARNESSES[className];
  if (template === undefined) {
    throw new Error(`no scripted Angular harness for ${className}`);
  }
  const statement = withExtraNames(targetImportStatement, template.extraTargetNames ?? []);
  let source = template.source.replace(TARGET, statement);
  for (const [placeholder, [pattern, text]] of Object.entries(template.inputsFromMeta ?? {})) {
    source = source.replace(placeholder, pattern.test(prompt) ? text : "");
  }
  return { harnessSource: source, notes: template.notes };
}
