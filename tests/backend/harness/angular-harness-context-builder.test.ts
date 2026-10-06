import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HARNESS_PROMPT_TOKEN_BUDGET } from "../../../backend/src/config-consts";
import {
  AngularHarnessContextBuilder,
  angularInputsRequiredByTemplateUse,
  renderAngularComponentMeta
} from "../../../backend/src/services/visualizations/pipeline/angular/angular-harness-context-builder";
import type { AngularHarnessContextPackage } from "../../../backend/src/services/visualizations/pipeline/angular/angular-harness-prompts";
import type {
  PromptSection,
  SectionId
} from "../../../backend/src/services/visualizations/pipeline/harness-context-builder";
import type { AngularComponentMeta } from "../../../backend/src/types/angular-analysis";
import type { ComponentCandidate } from "../../../backend/src/types/visualization-pipeline";
import { createPipelineContext } from "../helpers/pipeline-context";
import {
  FakeAngularSourceQueries,
  angularInput,
  angularMeta,
  type FakeAngularSourceQueriesOptions
} from "./helpers/fake-angular-source-queries";
import { directImport } from "./helpers/fake-source-queries";
import { createTempWorktrees, type TempWorktrees } from "./helpers/temp-worktrees";

const APP_ROOT = "src/tenant-frontend";
const DIR = `${APP_ROOT}/src/app/modules/notifications/notification-item`;
const FILE = `${DIR}/notification-item.component.ts`;
const TEMPLATE = `${DIR}/notification-item.component.html`;
const STYLE = `${DIR}/notification-item.component.css`;
const STORY = `${DIR}/notification-item.component.stories.ts`;
const SERVICE = `${APP_ROOT}/src/app/services/notification.service.ts`;
const ENTRY = `${APP_ROOT}/src/main.ts`;
const APP_CONFIG = `${APP_ROOT}/src/app/app.config.ts`;

// ---------------------------------------------------------------------------------------------------------------
// component_meta rendering (15 §5.6.4)
// ---------------------------------------------------------------------------------------------------------------

const EXAMPLE_META: AngularComponentMeta = angularMeta({
  filePath: "src/tenant-frontend/src/app/modules/notifications/notification-item/notification-item.component.ts",
  className: "NotificationItemComponent",
  selector: "app-notification-item",
  changeDetection: "Default",
  template: {
    kind: "external",
    path: "src/tenant-frontend/src/app/modules/notifications/notification-item/notification-item.component.html",
    text: "<div>{{ notification.title }}</div>",
    startLine: 1
  },
  styles: [
    {
      kind: "external",
      path: "src/tenant-frontend/src/app/modules/notifications/notification-item/notification-item.component.css",
      language: "css"
    }
  ],
  imports: ["StatusPillComponent"],
  inputs: [
    angularInput({ name: "notification", typeText: "Notification" }),
    angularInput({ name: "showActions", typeText: "boolean", initializerText: "true" }),
    angularInput({ name: "compact", typeText: "boolean", initializerText: "false" })
  ],
  outputs: [
    { name: "notificationRead", alias: null, kind: "decorator" },
    { name: "notificationDeleted", alias: null, kind: "decorator" },
    { name: "notificationClicked", alias: null, kind: "decorator" }
  ],
  injected: [
    {
      token: "NotificationService",
      via: "constructor",
      optional: false,
      importSpecifier: "../../../services/notification.service",
      resolvedPath: "src/app/services/notification.service.ts",
      providedIn: "root",
      hints: ["constructor starts a timer"]
    },
    {
      token: "Router",
      via: "constructor",
      optional: false,
      importSpecifier: "@angular/router",
      resolvedPath: "package:@angular/router",
      providedIn: null,
      hints: []
    }
  ]
});

const COMPONENT_SOURCE = [
  "import { Component, EventEmitter, Input, Output } from '@angular/core';",
  "import { Router } from '@angular/router';",
  "import { NotificationService, type Notification } from '../../../services/notification.service';",
  "",
  "@Component({ selector: 'app-notification-item', templateUrl: './notification-item.component.html' })",
  "export class NotificationItemComponent {",
  "  @Input() notification!: Notification;",
  "  @Input() showActions = true;",
  "  @Input() compact = false;",
  "  @Output() notificationRead = new EventEmitter<string>();",
  "  constructor(private readonly notifications: NotificationService, private readonly router: Router) {}",
  "}",
  ""
].join("\n");

test("component_meta renders exactly as 15 §5.6.4", () => {
  const required = angularInputsRequiredByTemplateUse(
    COMPONENT_SOURCE,
    "NotificationItemComponent",
    EXAMPLE_META.inputs,
    "<div>{{ notification.title }}</div>"
  );
  assert.deepEqual([...required], ["notification"]);
  assert.equal(
    renderAngularComponentMeta(EXAMPLE_META, { requiredByTemplate: required }),
    [
      "class: NotificationItemComponent (standalone) selector: app-notification-item",
      "changeDetection: Default",
      "template: external src/tenant-frontend/src/app/modules/notifications/notification-item/notification-item.component.html",
      "styles: notification-item.component.css (css)",
      "imports: StatusPillComponent",
      "inputs:",
      "- notification (decorator, required by template use) : Notification",
      "- showActions (decorator) : boolean = true",
      "- compact (decorator) : boolean = false",
      "outputs: notificationRead, notificationDeleted, notificationClicked",
      "injected:",
      "- NotificationService via constructor [relative → src/app/services/notification.service.ts] providedIn root; hints: constructor starts a timer",
      "- Router via constructor [package @angular/router]",
      "declared in NgModule: (none)"
    ].join("\n")
  );
});

test("required by template use is a heuristic: guarded reads and non-definite inputs get no hint", () => {
  const inputs = EXAMPLE_META.inputs;
  for (const template of [
    "<div>{{ notification?.title }}</div>",
    "@if (notification) { <div>{{ notification.title }}</div> }",
    '<div *ngIf="notification">{{ notification.title }}</div>',
    "<div>{{ title }}</div>"
  ]) {
    assert.deepEqual(
      [...angularInputsRequiredByTemplateUse(COMPONENT_SOURCE, "NotificationItemComponent", inputs, template)],
      [],
      template
    );
  }
  const notDefinite = COMPONENT_SOURCE.replace(
    "notification!: Notification",
    "notification: Notification | null = null"
  );
  assert.deepEqual(
    [
      ...angularInputsRequiredByTemplateUse(
        notDefinite,
        "NotificationItemComponent",
        inputs,
        "<div>{{ notification.title }}</div>"
      )
    ],
    []
  );
});

test("component_meta lists signal, aliased and required inputs, NgModule declaration and base differences", () => {
  const head = angularMeta({
    filePath: "src/app/card.component.ts",
    className: "CardComponent",
    selector: "app-card",
    standalone: false,
    declaringModule: { filePath: "src/app/cards.module.ts", className: "CardsModule" },
    changeDetection: "OnPush",
    template: { kind: "inline", path: null, text: "<b>{{ heading() }}</b>", startLine: 4 },
    styles: [{ kind: "inline", path: null, language: "scss" }],
    inputs: [
      angularInput({ name: "title", alias: "heading", kind: "signal", required: true, typeText: "string" }),
      angularInput({ name: "count", kind: "signal", initializerText: "0", hasTransform: true })
    ],
    outputs: [{ name: "picked", alias: "select", kind: "signal" }],
    injected: [
      {
        token: "API_URL",
        via: "inject",
        optional: true,
        importSpecifier: "@app/tokens",
        resolvedPath: "src/app/tokens.ts",
        providedIn: null,
        hints: []
      }
    ]
  });
  const base = { ...head, inputs: [head.inputs[0]!], changeDetection: null };
  assert.equal(
    renderAngularComponentMeta(head, { base }),
    [
      "class: CardComponent (NgModule-declared) selector: app-card",
      "changeDetection: OnPush",
      "template: inline (src/app/card.component.ts line 4)",
      "styles: inline (scss)",
      "imports: (none)",
      "inputs:",
      "- title (signal, alias heading, required) : string",
      "- count (signal, transform) = 0",
      "outputs: picked (alias select)",
      "injected:",
      "- API_URL via inject (optional) [alias → src/app/tokens.ts]",
      "declared in NgModule: CardsModule (src/app/cards.module.ts)",
      "base: changeDetection: Default",
      "base: inputs: title (signal, alias heading, required) : string"
    ].join("\n")
  );
  assert.ok(
    renderAngularComponentMeta(head, { baseMissing: true }).endsWith(
      "base: (component metadata not found on the base side)"
    )
  );
});

// ---------------------------------------------------------------------------------------------------------------
// AngularHarnessContextBuilder
// ---------------------------------------------------------------------------------------------------------------

function headMeta(overrides: Partial<AngularComponentMeta> = {}): AngularComponentMeta {
  return angularMeta({
    ...EXAMPLE_META,
    filePath: FILE,
    template: {
      kind: "external",
      path: TEMPLATE,
      text: "<div>{{ notification.title }}</div>\n<app-status-pill />",
      startLine: 1
    },
    styles: [{ kind: "external", path: STYLE, language: "css" }],
    injected: [{ ...EXAMPLE_META.injected[0]!, resolvedPath: SERVICE }, EXAMPLE_META.injected[1]!],
    ...overrides
  });
}

interface BuilderSetup {
  builder: AngularHarnessContextBuilder;
  queries: FakeAngularSourceQueries;
  trees: TempWorktrees;
}

function setup(
  t: TestContext,
  options: {
    sides?: { base: boolean; head: boolean };
    queries?: FakeAngularSourceQueriesOptions;
    entry?: string | null;
    headSource?: string;
    baseSource?: string;
  } = {}
): BuilderSetup {
  const sides = options.sides ?? { base: true, head: true };
  const trees = createTempWorktrees(t);
  if (sides.head) {
    trees.write("head", FILE, options.headSource ?? COMPONENT_SOURCE);
    trees.write("head", STYLE, ".item { display: flex; }\n");
    trees.write(
      "head",
      STORY,
      "import { NotificationItemComponent } from './notification-item.component';\nexport default {};\n"
    );
  }
  if (sides.base) {
    trees.write("base", FILE, options.baseSource ?? COMPONENT_SOURCE.replace("@Input() compact = false;\n", ""));
    trees.write("base", STYLE, ".item { display: block; }\n");
  }
  trees.write(
    "both",
    ENTRY,
    "import { bootstrapApplication } from '@angular/platform-browser';\nbootstrapApplication(AppComponent, appConfig);\n"
  );
  trees.write(
    "both",
    `${APP_ROOT}/package.json`,
    JSON.stringify({
      dependencies: { "@angular/core": "^21.2.0", "@angular/router": "^21.2.0", rxjs: "~7.8.0", lodash: "^4" }
    })
  );
  const queries = new FakeAngularSourceQueries({
    files: { base: trees.files.base, head: trees.files.head },
    outlines: {
      [`head:${SERVICE}#NotificationService`]: {
        filePath: SERVICE,
        className: "NotificationService",
        providedIn: "root",
        outline: "export class NotificationService {\n  getRelativeTime(date: string): string { … }\n}",
        constructorHints: ["constructor starts a timer"]
      }
    },
    appProviders: {
      head: [
        {
          text: "{ provide: API_AUTH_BRIDGE,\n  useExisting: AuthService }",
          token: "API_AUTH_BRIDGE",
          source: APP_CONFIG
        },
        { text: "provideHttpClient(withInterceptors([authInterceptor]))", token: null, source: APP_CONFIG }
      ]
    },
    specSetups: {
      [`head:${FILE}`]: [
        {
          filePath: `${DIR}/notification-item.component.spec.ts`,
          role: "test",
          line: 9,
          startLine: 9,
          endLine: 12,
          usedAs: "NotificationItemComponent",
          snippet: "TestBed.configureTestingModule({ imports: [NotificationItemComponent] })"
        }
      ]
    },
    callSites: {
      [`head:${FILE}`]: [
        {
          filePath: `${APP_ROOT}/src/app/modules/notifications/list/list.component.html`,
          role: "source",
          line: 3,
          startLine: 1,
          endLine: 5,
          usedAs: "app-notification-item",
          snippet: '<app-notification-item [notification]="n" />'
        }
      ]
    },
    typeSources: {
      [`head:${FILE}`]: {
        found: true,
        propsTypeName: null,
        parameterText: "notification: Notification",
        sources: [
          {
            name: "Notification",
            filePath: SERVICE,
            startLine: 1,
            endLine: 3,
            kind: "interface",
            depth: 0,
            text: "export interface Notification { title: string; }"
          }
        ],
        unresolved: [],
        truncated: false
      }
    },
    directImports: {
      head: {
        [FILE]: [directImport({ specifier: "@angular/core", kind: "package", namedImports: ["Component", "Input"] })]
      },
      base: {
        [FILE]: [directImport({ specifier: "@angular/core", kind: "package", namedImports: ["Component", "Input"] })]
      }
    },
    ...options.queries
  });
  if (sides.head) {
    queries.setMeta("head", headMeta());
  }
  if (sides.base) {
    queries.setMeta(
      "base",
      headMeta({
        inputs: EXAMPLE_META.inputs.slice(0, 2),
        styles: [{ kind: "external", path: STYLE, language: "css" }],
        template: { kind: "external", path: TEMPLATE, text: "<div>{{ notification.title }}</div>", startLine: 1 }
      })
    );
  }
  const handle = createPipelineContext({
    dataDir: trees.root,
    repositoryPath: trees.root,
    baseDir: trees.baseDir,
    headDir: trees.headDir,
    repository: {
      framework: "angular",
      appRoot: APP_ROOT,
      angularProject: "tenant-frontend",
      angularBuildConfiguration: "development",
      viteConfigPath: null,
      tsconfigPath: `${APP_ROOT}/tsconfig.app.json`,
      entryFilePath: options.entry === undefined ? ENTRY : options.entry,
      globalStylePaths: [`${APP_ROOT}/src/styles.scss`]
    }
  });
  return { builder: new AngularHarnessContextBuilder(handle.context, queries), queries, trees };
}

function candidate(overrides: Partial<ComponentCandidate> = {}): ComponentCandidate {
  return {
    componentId: 5,
    filePath: FILE,
    exportName: "NotificationItemComponent",
    displayName: "NotificationItemComponent",
    changeKind: "modified",
    rank: 0,
    codeDiff: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b",
    reason: "Component code changed",
    ...overrides
  };
}

const sectionKeys = (pkg: AngularHarnessContextPackage): string[] =>
  pkg.sections.map((section) =>
    section.attributes.side !== undefined ? `${section.id}:${section.attributes.side}` : section.id
  );

function sectionOf(pkg: AngularHarnessContextPackage, id: SectionId, side?: string): PromptSection {
  const found = pkg.sections.find(
    (section) => section.id === id && (side === undefined || section.attributes.side === side)
  );
  assert.ok(found, `section ${id}${side ? `:${side}` : ""} present`);
  return found;
}

test("modified component: every section in 15 §5.6.3 order", async (t) => {
  const { builder } = setup(t);
  const pkg = await builder.build(candidate());
  assert.deepEqual(sectionKeys(pkg), [
    "head_source:head",
    "template_source:head",
    "code_diff",
    "component_meta",
    "injected_outlines",
    "app_providers",
    "direct_imports",
    "referenced_types",
    "call_sites",
    "stories_tests",
    "template_source:base",
    "base_source:base",
    "style_sources",
    "dependencies",
    "global_styles"
  ]);
  assert.equal(pkg.viteRootRel, APP_ROOT);
  assert.equal(
    pkg.targetImportPath,
    "../../src/app/modules/notifications/notification-item/notification-item.component"
  );
  assert.equal(
    pkg.targetImportStatement,
    'import { NotificationItemComponent } from "../../src/app/modules/notifications/notification-item/notification-item.component";'
  );
  assert.deepEqual(pkg.angular, {
    className: "NotificationItemComponent",
    selector: "app-notification-item",
    appRoot: APP_ROOT
  });
  assert.equal(sectionOf(pkg, "head_source").tag, "component_source");
  assert.equal(sectionOf(pkg, "template_source", "head").attributes.path, TEMPLATE);
  assert.equal(sectionOf(pkg, "template_source", "head").attributes.kind, "external");

  const meta = sectionOf(pkg, "component_meta").body;
  assert.ok(meta.includes("- notification (decorator, required by template use) : Notification"));
  assert.ok(
    meta.includes("base: inputs: notification (decorator) : Notification; showActions (decorator) : boolean = true")
  );
  const outlines = sectionOf(pkg, "injected_outlines").body;
  assert.ok(
    outlines.startsWith(
      `<injectable path="${SERVICE}" class="NotificationService" providedIn="root" hints="constructor starts a timer">`
    )
  );
  const providers = sectionOf(pkg, "app_providers").body;
  assert.ok(
    providers.includes(`- { provide: API_AUTH_BRIDGE, useExisting: AuthService } (from ${APP_CONFIG})`),
    "multi-line provider collapsed to one line"
  );
  assert.ok(providers.includes(`// file: ${ENTRY}\nimport { bootstrapApplication }`));
  const stories = sectionOf(pkg, "stories_tests").body;
  assert.ok(
    stories.includes(
      '<test path="src/tenant-frontend/src/app/modules/notifications/notification-item/notification-item.component.spec.ts" line="9">'
    )
  );
  assert.ok(stories.includes(`<story path="${STORY}">`));
  assert.ok(
    sectionOf(pkg, "style_sources").body.startsWith(
      `<style_source path="${STYLE}" language="css">\n.item { display: flex; }`
    )
  );
  const dependencies = sectionOf(pkg, "dependencies").body;
  assert.ok(dependencies.startsWith("libraries of interest: @angular/router@^21.2.0, rxjs@~7.8.0"), dependencies);
  assert.ok(dependencies.includes("lodash@^4"));
  assert.ok(sectionOf(pkg, "global_styles").body.includes("(already applied by the build; never import)"));
  assert.ok(pkg.estimatedTokens > 0 && pkg.estimatedTokens <= HARNESS_PROMPT_TOKEN_BUDGET);
});

test("added component: head sections only", async (t) => {
  const { builder } = setup(t, { sides: { base: false, head: true } });
  const pkg = await builder.build(candidate({ changeKind: "added", codeDiff: null }));
  const keys = sectionKeys(pkg);
  assert.ok(!keys.some((key) => key.endsWith(":base")), keys.join(","));
  assert.ok(!keys.includes("code_diff"));
  assert.ok(!sectionOf(pkg, "component_meta").body.includes("base:"));
  assert.deepEqual(pkg.sidesPresent, { base: false, head: true });
});

test("removed component: the base side is the primary source", async (t) => {
  const { builder } = setup(t, { sides: { base: true, head: false } });
  const pkg = await builder.build(candidate({ changeKind: "removed" }));
  assert.equal(pkg.sourceSide, "base");
  const primary = sectionOf(pkg, "base_source", "base");
  assert.equal(primary.attributes.status, "removed in head");
  assert.equal(sectionOf(pkg, "template_source", "base").attributes.path, TEMPLATE);
  assert.equal(pkg.sections.filter((section) => section.id === "template_source").length, 1);
  assert.equal(pkg.sections.filter((section) => section.id === "base_source").length, 1);
});

test("affected parent: changed_dependencies present; base template omitted when identical", async (t) => {
  const { builder, queries } = setup(t, {
    queries: {
      changedDependencies: {
        [`head:${FILE}`]: [{ path: SERVICE, status: "M", depth: 1, codeDiff: "@@ -1 +1 @@\n-x\n+y" }]
      }
    }
  });
  queries.setMeta("base", headMeta());
  const pkg = await builder.build(
    candidate({ changeKind: "affected_parent", codeDiff: null, reason: "Injects changed service" })
  );
  const keys = sectionKeys(pkg);
  assert.ok(keys.includes("changed_dependencies"));
  assert.ok(!keys.includes("template_source:base"), "base template is only for modified components");
  assert.ok(
    sectionOf(pkg, "changed_dependencies").body.startsWith(
      `<dependency_diff path="${SERVICE}" status="modified" depth="1">`
    )
  );
});

test("app_providers: present when providers exist, entry-only when there are none, absent without both", async (t) => {
  const none = setup(t, { queries: { appProviders: {} } });
  const entryOnly = await none.builder.build(candidate());
  assert.ok(
    sectionOf(entryOnly, "app_providers").body.startsWith(
      "providers given to the application at bootstrap: (none found)"
    )
  );
  const neither = setup(t, { queries: { appProviders: {} }, entry: null });
  const pkg = await neither.builder.build(candidate());
  assert.ok(!sectionKeys(pkg).includes("app_providers"));
});

test("budget: sections shrink lowest priority first and the component source survives", async (t) => {
  const long = (prefix: string, lines: number): string =>
    Array.from({ length: lines }, (_, index) => `${prefix} ${index} ${"x".repeat(110)}`).join("\n");
  const bigSource = `${COMPONENT_SOURCE}\n${long("// body", 420)}\n`;
  const { builder, queries } = setup(t, {
    headSource: bigSource,
    baseSource: `${long("// base", 220)}\n${COMPONENT_SOURCE}`,
    queries: {
      outlines: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [
          `head:${SERVICE}#Service${index}`,
          {
            filePath: SERVICE,
            className: `Service${index}`,
            providedIn: "root" as const,
            outline: long("member", 90),
            constructorHints: []
          }
        ])
      )
    }
  });
  const meta = headMeta({
    template: { kind: "external", path: TEMPLATE, text: long("<p>", 320), startLine: 1 },
    injected: Array.from({ length: 6 }, (_, index) => ({
      token: `Service${index}`,
      via: "inject" as const,
      optional: false,
      importSpecifier: "../../../services/notification.service",
      resolvedPath: SERVICE,
      providedIn: "root" as const,
      hints: []
    }))
  });
  queries.setMeta("head", meta);
  queries.setMeta("base", {
    ...meta,
    template: { kind: "external", path: TEMPLATE, text: long("<span>", 220), startLine: 1 }
  });
  const pkg = await builder.build(candidate({ codeDiff: long("+", 420) }));
  assert.ok(pkg.estimatedTokens <= HARNESS_PROMPT_TOKEN_BUDGET, `${pkg.estimatedTokens}`);
  const dropped = pkg.sections.filter((section) => section.dropped === true).map((section) => section.id);
  assert.ok(dropped.includes("global_styles"), "priority 7 goes first");
  assert.ok(dropped.includes("base_source"), "priority 6 goes next");
  for (const kept of ["head_source", "component_meta", "code_diff", "app_providers"] as const) {
    assert.ok(!dropped.includes(kept), kept);
  }
  const head = sectionOf(pkg, "head_source", "head");
  assert.ok(head.body.split("\n").length <= 401, "line cap of 400 plus a marker");
  assert.ok(head.truncatedLines > 0);
  assert.ok(sectionOf(pkg, "template_source", "head").body.split("\n").length <= 301);
});

test("a component that exists on neither side throws", async (t) => {
  const { builder } = setup(t);
  await assert.rejects(builder.build(candidate({ filePath: `${DIR}/missing.component.ts` })), /does not exist/);
});
