import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AngularHarnessValidator } from "../../../backend/src/services/visualizations/pipeline/angular/angular-harness-validator";
import type {
  HarnessIssueCode,
  HarnessValidationInput,
  HarnessValidationReport
} from "../../../backend/src/services/visualizations/pipeline/harness-validator";
import type { DirectImport, WorktreeSide } from "../../../backend/src/types/visualization-pipeline";
import {
  FakeAngularSourceQueries,
  angularInput,
  angularMeta,
  type FakeAngularSourceQueriesOptions
} from "./helpers/fake-angular-source-queries";
import { directImport } from "./helpers/fake-source-queries";

// Acme-like layout (15 §5.1): the Angular app lives in src/tenant-frontend.
const APP_ROOT = "src/tenant-frontend";
const APP = `${APP_ROOT}/src/app`;
const ENTRY = `${APP_ROOT}/src/main.ts`;
const APP_CONFIG = `${APP}/app.config.ts`;
const NOTIFICATION_ITEM = `${APP}/modules/notifications/notification-item/notification-item.component.ts`;
const NOTIFICATION_SERVICE = `${APP}/services/notification.service.ts`;
const RANK_HISTORY = `${APP}/modules/member-ranks/rank-history/rank-history.component.ts`;
const API_AUTH_BRIDGE = `${APP}/services/api-auth-bridge.ts`;
const SHARED_NOTIFICATION_SERVICE = `${APP}/shared/services/notification.service.ts`;
const LEGACY_BADGE = `${APP_ROOT}/.prvision-harness/proto-fixtures/legacy-badge.module.ts`;
const SIGNAL_CARD = `${APP_ROOT}/.prvision-harness/proto-fixtures/signal-card.component.ts`;

const FILES = [
  ENTRY,
  APP_CONFIG,
  NOTIFICATION_ITEM,
  NOTIFICATION_SERVICE,
  RANK_HISTORY,
  API_AUTH_BRIDGE,
  SHARED_NOTIFICATION_SERVICE,
  LEGACY_BADGE,
  SIGNAL_CARD
];

function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "../../fixtures/angular-harness", name), "utf8");
}

const notificationItemMeta = angularMeta({
  filePath: NOTIFICATION_ITEM,
  className: "NotificationItemComponent",
  selector: "app-notification-item",
  inputs: [
    angularInput({ name: "notification", typeText: "Notification" }),
    angularInput({ name: "showActions", typeText: "boolean", initializerText: "true" }),
    angularInput({ name: "compact", typeText: "boolean", initializerText: "false" })
  ],
  outputs: [
    { name: "notificationRead", alias: null, kind: "decorator" },
    { name: "notificationClicked", alias: null, kind: "decorator" }
  ]
});
const rankHistoryMeta = angularMeta({
  filePath: RANK_HISTORY,
  className: "RankHistoryComponent",
  selector: "app-rank-history",
  inputs: [angularInput({ name: "memberId", typeText: "string" })]
});
const legacyBadgeMeta = angularMeta({
  filePath: LEGACY_BADGE,
  className: "LegacyBadgeComponent",
  selector: "legacy-badge",
  standalone: false,
  declaringModule: { filePath: LEGACY_BADGE, className: "LegacyBadgeModule" },
  inputs: [
    angularInput({ name: "text", initializerText: "''" }),
    angularInput({ name: "tone", initializerText: "'ok'" })
  ]
});
const signalCardMeta = angularMeta({
  filePath: SIGNAL_CARD,
  className: "SignalCardComponent",
  selector: "signal-card",
  inputs: [
    angularInput({ name: "title", kind: "signal", required: true, typeText: "string" }),
    angularInput({ name: "count", kind: "signal", initializerText: "0", hasTransform: true })
  ],
  outputs: [{ name: "picked", alias: null, kind: "signal" }]
});

const NOTIFICATION_IMPORTS: DirectImport[] = [
  directImport({ specifier: "@angular/core", kind: "package", namedImports: ["Component", "Input"] }),
  directImport({
    specifier: "../../../services/notification.service",
    kind: "relative",
    resolvedPath: NOTIFICATION_SERVICE,
    namedImports: ["NotificationService"]
  })
];

interface Setup {
  validator: AngularHarnessValidator;
  queries: FakeAngularSourceQueries;
}

function setup(
  options: FakeAngularSourceQueriesOptions = {},
  files: Record<WorktreeSide, string[]> = { base: FILES, head: FILES }
): Setup {
  const queries = new FakeAngularSourceQueries({
    files,
    appProviders: {
      base: [
        { text: "{ provide: API_AUTH_BRIDGE, useExisting: AuthService }", token: "API_AUTH_BRIDGE", source: APP_CONFIG }
      ],
      head: [
        { text: "{ provide: API_AUTH_BRIDGE, useExisting: AuthService }", token: "API_AUTH_BRIDGE", source: APP_CONFIG }
      ]
    },
    directImports: {
      base: { [NOTIFICATION_ITEM]: NOTIFICATION_IMPORTS },
      head: { [NOTIFICATION_ITEM]: NOTIFICATION_IMPORTS }
    },
    moduleExports: {
      base: { [NOTIFICATION_SERVICE]: ["NotificationService"] },
      head: { [NOTIFICATION_SERVICE]: ["NotificationService"] }
    },
    ...options
  });
  for (const meta of [notificationItemMeta, rankHistoryMeta, legacyBadgeMeta, signalCardMeta]) {
    queries.setMeta("both", meta);
  }
  const exists = (side: WorktreeSide, repoPath: string): Promise<boolean> =>
    Promise.resolve(files[side].includes(repoPath));
  return { validator: new AngularHarnessValidator(queries, exists), queries };
}

function inputFor(
  filePath: string,
  exportName: string,
  harnessSource: string,
  overrides: Partial<HarnessValidationInput> = {}
): HarnessValidationInput {
  const targetImportPath = path.posix.relative(
    `${APP_ROOT}/.prvision-harness/components`,
    filePath.replace(/\.ts$/, "")
  );
  return {
    harnessSource,
    mockedModules: [],
    candidate: { filePath, exportName },
    paths: { base: filePath, head: filePath },
    viteRootRel: APP_ROOT,
    targetImportPath,
    directImports: { base: [], head: [] },
    sidesPresent: { base: true, head: true },
    entryFilePath: ENTRY,
    targetImportStatement: `import { ${exportName} } from "${targetImportPath}";`,
    ...overrides
  };
}

const errorCodes = (report: HarnessValidationReport): HarnessIssueCode[] => [
  ...new Set(report.errors.map((issue) => issue.code))
];
const warningCodes = (report: HarnessValidationReport): HarnessIssueCode[] => [
  ...new Set(report.warnings.map((issue) => issue.code))
];

// ---- signal-card (prototype harness 104) is the base of most negative cases ----

const SIGNAL_IMPORTS = [
  "import { definePrvisionHarness } from '../harness-api';",
  "import { SignalCardComponent } from '../proto-fixtures/signal-card.component';"
];

function signalHarness(descriptor: string, extraImports: string[] = [], body: string[] = []): string {
  return [...SIGNAL_IMPORTS, ...extraImports, "", ...body, `export default definePrvisionHarness(${descriptor});`].join(
    "\n"
  );
}

const SIGNAL_OK = "{ component: SignalCardComponent, inputs: { title: 'Signal inputs', count: '21' } }";

async function validateSignal(
  source: string,
  overrides: Partial<HarnessValidationInput> = {},
  s = setup()
): Promise<HarnessValidationReport> {
  return s.validator.validate(inputFor(SIGNAL_CARD, "SignalCardComponent", source, overrides));
}

function hostHarness(template: string, metadata = ""): string {
  return [
    "import { Component } from '@angular/core';",
    ...SIGNAL_IMPORTS,
    "",
    `@Component({ selector: 'prvision-host', imports: [SignalCardComponent], template: '${template}'${metadata} })`,
    "class PrvisionHost { readonly label = 'Card'; onPicked(value: string): void { void value; } }",
    "",
    "export default definePrvisionHarness({ component: PrvisionHost });"
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Positive: the prototype harnesses 101–104 (15 §10 acceptance)
// ---------------------------------------------------------------------------------------------------------------

test("prototype harness 101 (NotificationItemComponent, prototype-backed fake, setup) passes", async () => {
  const report = await setup().validator.validate(
    inputFor(NOTIFICATION_ITEM, "NotificationItemComponent", fixture("101.ts"))
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.ok, true);
});

test("prototype harness 102 (RankHistoryComponent, app-level token, http fixture) passes", async () => {
  const report = await setup().validator.validate(inputFor(RANK_HISTORY, "RankHistoryComponent", fixture("102.ts")));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test("prototype harness 103 (NgModule-declared component with importProvidersFrom) passes", async () => {
  const report = await setup().validator.validate(inputFor(LEGACY_BADGE, "LegacyBadgeComponent", fixture("103.ts")));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test("prototype harness 104 (signal inputs with transform) passes", async () => {
  const report = await validateSignal(fixture("104.ts"));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test("a host component that binds the target's inputs and outputs passes", async () => {
  const report = await validateSignal(
    hostHarness('<signal-card [title]="label" count="2" (picked)="onPicked($event)" />')
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

// ---------------------------------------------------------------------------------------------------------------
// Negative: one case per issue code (15 §5.6.7)
// ---------------------------------------------------------------------------------------------------------------

test("syntax_error: unparsable harness", async () => {
  const report = await validateSignal(signalHarness("{ component: SignalCardComponent, inputs: { title: 'x' }"));
  assert.deepEqual(errorCodes(report), ["syntax_error"]);
  assert.match(report.errors[0]?.location ?? "", /^harness:\d+:\d+$/);
});

test("size_limit: harness over 40 000 characters", async () => {
  const report = await validateSignal(`${fixture("104.ts")}\n// ${"x".repeat(40_000)}`);
  assert.deepEqual(errorCodes(report), ["size_limit"]);
});

test("harness_shape: default export that is not definePrvisionHarness({...})", async () => {
  const report = await validateSignal(
    [...SIGNAL_IMPORTS, "", "export default { component: SignalCardComponent, inputs: { title: 'x' } };"].join("\n")
  );
  assert.deepEqual(errorCodes(report), ["harness_shape"]);
  assert.match(report.errors[0]?.message ?? "", /definePrvisionHarness/);
});

test("harness_shape: definePrvisionHarness not imported from '../harness-api'", async () => {
  const report = await validateSignal(
    signalHarness(SIGNAL_OK).replace("from '../harness-api'", "from '../../src/app/harness-api'")
  );
  assert.ok(errorCodes(report).includes("harness_shape"));
});

test("harness_shape: unknown descriptor key and missing component", async () => {
  const unknown = await validateSignal(
    signalHarness("{ component: SignalCardComponent, inputs: { title: 'x' }, wrapper: true }")
  );
  assert.deepEqual(errorCodes(unknown), ["harness_shape"]);
  assert.match(unknown.errors[0]?.message ?? "", /Unknown key wrapper/);
  const missing = await validateSignal(signalHarness("{ inputs: { title: 'x' } }"));
  assert.deepEqual(errorCodes(missing), ["harness_shape"]);
});

test("harness_shape: host component with templateUrl or another selector; http without url", async () => {
  const templateUrl = await validateSignal(
    hostHarness('<signal-card [title]="label" />').replace(
      "template: '<signal-card [title]=\"label\" />'",
      "templateUrl: './host.html'"
    )
  );
  assert.deepEqual(errorCodes(templateUrl), ["harness_shape"]);
  const selector = await validateSignal(
    hostHarness('<signal-card [title]="label" />').replace("'prvision-host'", "'app-host'")
  );
  assert.deepEqual(errorCodes(selector), ["harness_shape"]);
  const http = await validateSignal(
    signalHarness("{ component: SignalCardComponent, inputs: { title: 'x' }, http: [{ method: 'GET', body: [] }] }")
  );
  assert.deepEqual(errorCodes(http), ["harness_shape"]);
});

test("harness_shape warning: non-literal http url", async () => {
  const report = await validateSignal(
    signalHarness(
      "{ component: SignalCardComponent, inputs: { title: 'x' }, http: [{ url: API_URL }] }",
      [],
      ["const API_URL = '/cards';"]
    )
  );
  assert.equal(report.ok, true);
  assert.deepEqual(warningCodes(report), ["harness_shape"]);
});

test("target_not_imported: the target import is missing", async () => {
  const report = await validateSignal(
    [
      "import { definePrvisionHarness } from '../harness-api';",
      "",
      "export default definePrvisionHarness({ component: null });"
    ].join("\n")
  );
  assert.deepEqual(errorCodes(report), ["target_not_imported"]);
  assert.match(report.errors[0]?.message ?? "", /import \{ SignalCardComponent \} from/);
});

test("target_imported_twice: the target file imported by two statements", async () => {
  const report = await validateSignal(
    signalHarness(SIGNAL_OK, [
      "import { SignalCardComponent as Again } from '../proto-fixtures/signal-card.component';"
    ])
  );
  assert.deepEqual(errorCodes(report), ["target_imported_twice"]);
});

test("target_binding_mismatch: the target import binds another name", async () => {
  const report = await validateSignal(
    signalHarness(SIGNAL_OK).replace(
      "import { SignalCardComponent } from",
      "import { CardComponent as SignalCardComponent } from"
    )
  );
  assert.deepEqual(errorCodes(report), ["target_binding_mismatch"]);
});

test("component_not_target: component is neither the target nor a host that imports it", async () => {
  const report = await validateSignal(
    signalHarness("{ component: NgIf, inputs: { title: 'x' } }", ["import { NgIf } from '@angular/common';"])
  );
  assert.deepEqual(errorCodes(report), ["component_not_target"]);
});

test("host_template_error: unknown binding on both sides names each side", async () => {
  const report = await validateSignal(hostHarness('<signal-card [titel]="label" [title]="label" />'));
  assert.deepEqual(errorCodes(report), ["host_template_error"]);
  assert.equal(report.errors.length, 2);
  assert.ok(report.errors.some((issue) => /\[titel\].*base side/.test(issue.message)));
  assert.ok(report.errors.some((issue) => /\[titel\].*head side/.test(issue.message)));
});

test("host_template_error: binding that exists only on head is reported for the base side", async () => {
  const s = setup();
  s.queries.setMeta(
    "head",
    angularMeta({
      ...signalCardMeta,
      inputs: [...signalCardMeta.inputs, angularInput({ name: "subtitle", kind: "signal" })]
    })
  );
  const report = await validateSignal(hostHarness('<signal-card [title]="label" [subtitle]="label" />'), {}, s);
  assert.deepEqual(errorCodes(report), ["host_template_error"]);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]?.message ?? "", /no input named subtitle on the base side/);
});

test("host_template_error: unparsable template, unknown output and missing required input", async () => {
  const parse = await validateSignal(hostHarness('<signal-card [title]="(" />'));
  assert.deepEqual(errorCodes(parse), ["host_template_error"]);
  const output = await validateSignal(hostHarness('<signal-card [title]="label" (clicked)="onPicked($event)" />'));
  assert.deepEqual(errorCodes(output), ["host_template_error"]);
  const required = await validateSignal(hostHarness('<signal-card count="2" />'));
  assert.deepEqual(errorCodes(required), ["host_template_error"]);
  assert.match(required.errors[0]?.message ?? "", /required input title/);
});

test("prototype harness 107 (host with a typo binding and another selector) fails", async () => {
  const report = await validateSignal(fixture("107.ts"));
  assert.deepEqual(errorCodes(report).sort(), ["harness_shape", "host_template_error"]);
});

test("harness_class_name warning: host styles and class attributes", async () => {
  const report = await validateSignal(
    hostHarness('<div class="p-4"><signal-card [title]="label" /></div>', ", styles: ['div { padding: 4px; }']")
  );
  assert.equal(report.ok, true);
  assert.deepEqual(warningCodes(report), ["harness_class_name"]);
  assert.equal(report.warnings.length, 2);
});

test("unknown_input: error when missing on head, warning when missing only on base", async () => {
  const error = await validateSignal(
    signalHarness("{ component: SignalCardComponent, inputs: { title: 'x', titel: 'y' } }")
  );
  assert.deepEqual(errorCodes(error), ["unknown_input"]);
  assert.equal(error.errors.length, 1, "one error for head; the base miss is the warning");
  assert.deepEqual(warningCodes(error), ["unknown_input"]);
  const s = setup();
  s.queries.setMeta(
    "head",
    angularMeta({
      ...signalCardMeta,
      inputs: [...signalCardMeta.inputs, angularInput({ name: "subtitle", kind: "signal" })]
    })
  );
  const warning = await validateSignal(
    signalHarness("{ component: SignalCardComponent, inputs: { title: 'x', subtitle: 'y' } }"),
    {},
    s
  );
  assert.equal(warning.ok, true);
  assert.deepEqual(warningCodes(warning), ["unknown_input"]);
  assert.match(warning.warnings[0]?.message ?? "", /base side/);
});

test("unknown_input uses the public (aliased) input name", async () => {
  const s = setup();
  s.queries.setMeta(
    "both",
    angularMeta({ ...signalCardMeta, inputs: [angularInput({ name: "title", alias: "heading", required: true })] })
  );
  const byProperty = await validateSignal(
    signalHarness("{ component: SignalCardComponent, inputs: { title: 'x' } }"),
    {},
    s
  );
  assert.deepEqual(errorCodes(byProperty).sort(), ["missing_required_input", "unknown_input"]);
  const byAlias = await validateSignal(
    signalHarness("{ component: SignalCardComponent, inputs: { heading: 'x' } }"),
    {},
    s
  );
  assert.equal(byAlias.ok, true);
});

test("missing_required_input: required signal input not set", async () => {
  const report = await validateSignal(signalHarness("{ component: SignalCardComponent, inputs: { count: 2 } }"));
  assert.deepEqual(errorCodes(report), ["missing_required_input"]);
  assert.match(report.errors[0]?.message ?? "", /required input title/);
});

test("forbidden_provider: provideHttpClient in providers and APP_INITIALIZER as a provide value", async () => {
  const call = await validateSignal(
    signalHarness("{ component: SignalCardComponent, inputs: { title: 'x' }, providers: [provideHttpClient()] }", [
      "import { provideHttpClient } from '@angular/common/http';"
    ])
  );
  assert.deepEqual(errorCodes(call), ["forbidden_provider"]);
  const token = await validateSignal(
    signalHarness(
      "{ component: SignalCardComponent, inputs: { title: 'x' }, providers: [{ provide: APP_INITIALIZER, useValue: () => undefined, multi: true }] }",
      ["import { APP_INITIALIZER } from '@angular/core';"]
    )
  );
  assert.deepEqual(errorCodes(token), ["forbidden_provider"]);
});

test("nondeterministic_api: rxjs interval and timer, Date.now", async () => {
  const rx = await validateSignal(
    signalHarness(
      SIGNAL_OK,
      ["import { interval, timer as delayed } from 'rxjs';"],
      ["const ticks = interval(1000);", "const later = delayed(50);", "void ticks; void later;"]
    )
  );
  assert.deepEqual(errorCodes(rx), ["nondeterministic_api"]);
  assert.equal(rx.errors.length, 2);
  const date = await validateSignal(signalHarness(SIGNAL_OK, [], ["const now = Date.now();", "void now;"]));
  assert.deepEqual(errorCodes(date), ["nondeterministic_api"]);
});

test("network_api and forbidden_api", async () => {
  const network = await validateSignal(signalHarness(SIGNAL_OK, [], ["void fetch('/api/cards');"]));
  assert.deepEqual(errorCodes(network), ["network_api"]);
  const evalCall = await validateSignal(signalHarness(SIGNAL_OK, [], ["eval('1');"]));
  assert.deepEqual(errorCodes(evalCall), ["forbidden_api"]);
});

test("forbidden_import, style_import, entry_import", async () => {
  const testing = await validateSignal(signalHarness(SIGNAL_OK, ["import { TestBed } from '@angular/core/testing';"]));
  assert.deepEqual(errorCodes(testing), ["forbidden_import"]);
  const jasmine = await validateSignal(signalHarness(SIGNAL_OK, ["import 'jasmine-core';"]));
  assert.deepEqual(errorCodes(jasmine), ["forbidden_import"]);
  const style = await validateSignal(signalHarness(SIGNAL_OK, ["import '../../src/styles.scss';"]));
  assert.deepEqual(errorCodes(style), ["style_import"]);
  const config = await validateSignal(
    signalHarness(SIGNAL_OK, ["import { appConfig } from '../../src/app/app.config';"])
  );
  assert.deepEqual(errorCodes(config), ["entry_import"]);
  const main = await validateSignal(signalHarness(SIGNAL_OK, ["import '../../src/main';"]));
  assert.deepEqual(errorCodes(main), ["entry_import"]);
});

test("relative imports resolve from <appRoot>/.prvision-harness/components/", async () => {
  const unresolved = await validateSignal(signalHarness(SIGNAL_OK, ["import { X } from '../../src/app/nope';"]));
  assert.deepEqual(errorCodes(unresolved), ["relative_import_unresolved"]);
  const outside = await validateSignal(signalHarness(SIGNAL_OK, ["import { X } from '../../../../../outside';"]));
  assert.deepEqual(errorCodes(outside), ["relative_import_outside_worktree"]);
});

test("setup_not_allowed warning: anything but document attributes, dataset and storage seeds", async () => {
  const allowed = await validateSignal(
    signalHarness(
      [
        "{ component: SignalCardComponent, inputs: { title: 'x' }, setup: () => {",
        "  document.documentElement.setAttribute('data-ui-shell', 'modern');",
        "  document.documentElement.dataset['theme'] = 'dark';",
        "  document.documentElement.dataset.density = 'compact';",
        "  localStorage.setItem('prefs', JSON.stringify({ lang: 'en' }));",
        "  window.sessionStorage.setItem('tab', '2');",
        "} }"
      ].join("\n")
    )
  );
  assert.deepEqual(allowed.errors, []);
  assert.deepEqual(allowed.warnings, []);
  const disallowed = await validateSignal(
    signalHarness(
      "{ component: SignalCardComponent, inputs: { title: 'x' }, setup() { console.log('booting'); localStorage.setItem('k', key); } }",
      [],
      ["const key = 'v';"]
    )
  );
  assert.equal(disallowed.ok, true);
  assert.deepEqual(warningCodes(disallowed), ["setup_not_allowed"]);
  assert.equal(disallowed.warnings.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// File replacements (15 §5.6.7 step 10)
// ---------------------------------------------------------------------------------------------------------------

async function validateNotification(
  mockedModules: HarnessValidationInput["mockedModules"]
): Promise<HarnessValidationReport> {
  const s = setup();
  return s.validator.validate(
    inputFor(NOTIFICATION_ITEM, "NotificationItemComponent", fixture("101.ts"), {
      mockedModules,
      directImports: { base: NOTIFICATION_IMPORTS, head: NOTIFICATION_IMPORTS }
    })
  );
}

const SERVICE_SPECIFIER = "../../../services/notification.service";
const SERVICE_REPLACEMENT = "export class NotificationService { getRelativeTime(): string { return '2 hours ago'; } }";

test("a file replacement of a repository .ts module passes", async () => {
  const report = await validateNotification([{ specifier: SERVICE_SPECIFIER, source: SERVICE_REPLACEMENT }]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test("mock_package_specifier: a package cannot be replaced", async () => {
  const report = await validateNotification([{ specifier: "@angular/router", source: "export class Router {}" }]);
  assert.deepEqual(errorCodes(report), ["mock_package_specifier"]);
  assert.match(report.errors[0]?.message ?? "", /provide a DI fake instead/);
});

test("mock_forbidden_specifier: a replacement importing the file it replaces", async () => {
  const byOwnSpecifier = await validateNotification([
    { specifier: SERVICE_SPECIFIER, source: `export * from '${SERVICE_SPECIFIER}';\n${SERVICE_REPLACEMENT}` }
  ]);
  assert.deepEqual(errorCodes(byOwnSpecifier), ["mock_forbidden_specifier"]);
  assert.match(byOwnSpecifier.errors[0]?.message ?? "", /cannot import the file it replaces/);
  const target = await validateNotification([{ specifier: "./notification-item.component", source: "export {};" }]);
  assert.deepEqual(errorCodes(target), ["mock_forbidden_specifier"]);
});

test("mock_unresolvable_specifier, mock_syntax_error, mock_missing_export, mock_duplicate_specifier", async () => {
  const unresolvable = await validateNotification([
    { specifier: "../../../services/missing.service", source: "export {};" }
  ]);
  assert.deepEqual(errorCodes(unresolvable), ["mock_unresolvable_specifier"]);
  const syntax = await validateNotification([
    { specifier: SERVICE_SPECIFIER, source: "export class NotificationService {" }
  ]);
  assert.deepEqual(errorCodes(syntax), ["mock_syntax_error"]);
  const missing = await validateNotification([{ specifier: SERVICE_SPECIFIER, source: "export const other = 1;" }]);
  assert.deepEqual(errorCodes(missing), ["mock_missing_export"]);
  const duplicate = await validateNotification([
    { specifier: SERVICE_SPECIFIER, source: SERVICE_REPLACEMENT },
    { specifier: SERVICE_SPECIFIER, source: SERVICE_REPLACEMENT }
  ]);
  assert.deepEqual(errorCodes(duplicate), ["mock_duplicate_specifier"]);
});

test("mock_export_incomplete warning and API checks inside replacements", async () => {
  const s = setup({
    moduleExports: {
      base: { [NOTIFICATION_SERVICE]: ["NotificationService", "NOTIFICATION_POLL_MS"] },
      head: { [NOTIFICATION_SERVICE]: ["NotificationService", "NOTIFICATION_POLL_MS"] }
    }
  });
  const incomplete = await s.validator.validate(
    inputFor(NOTIFICATION_ITEM, "NotificationItemComponent", fixture("101.ts"), {
      mockedModules: [{ specifier: SERVICE_SPECIFIER, source: SERVICE_REPLACEMENT }],
      directImports: { base: NOTIFICATION_IMPORTS, head: NOTIFICATION_IMPORTS }
    })
  );
  assert.equal(incomplete.ok, true);
  assert.deepEqual(warningCodes(incomplete), ["mock_export_incomplete"]);
  const timer = await validateNotification([
    {
      specifier: SERVICE_SPECIFIER,
      source: `import { interval } from 'rxjs';\nexport const ticks = interval(5);\n${SERVICE_REPLACEMENT}`
    }
  ]);
  assert.deepEqual(errorCodes(timer), ["nondeterministic_api"]);
});

test("replacements must resolve to a .ts file inside the app root", async () => {
  const outsideFiles = [...FILES, "shared/lib/flags.ts"];
  const s = setup({ aliases: { "@shared/": "shared/" } }, { base: outsideFiles, head: outsideFiles });
  const report = await s.validator.validate(
    inputFor(NOTIFICATION_ITEM, "NotificationItemComponent", fixture("101.ts"), {
      mockedModules: [{ specifier: "@shared/lib/flags", source: "export const FLAGS = {};" }]
    })
  );
  assert.deepEqual(errorCodes(report), ["mock_unresolvable_specifier"]);
});

test("a removed component is validated against the base side only", async () => {
  const s = setup();
  const report = await s.validator.validate(
    inputFor(
      SIGNAL_CARD,
      "SignalCardComponent",
      signalHarness("{ component: SignalCardComponent, inputs: { title: 'x', titel: 'y' } }"),
      {
        paths: { base: SIGNAL_CARD, head: null },
        sidesPresent: { base: true, head: false }
      }
    )
  );
  assert.deepEqual(errorCodes(report), ["unknown_input"]);
  assert.match(report.errors[0]?.message ?? "", /base side/);
  assert.equal(
    s.queries.angularCalls
      .filter((call) => call.method === "getComponentMeta")
      .every((call) => call.args[2] === "base"),
    true
  );
});
