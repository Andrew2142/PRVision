import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { isAngularSourceQueries, type AngularSourceQueriesLike } from "../../../../backend/src/types/angular-analysis";
import { APP_DIR, MAIN_FILES, SRC, analyzeAngular, withChanges } from "./helpers/angular-analysis-fixture";
import type { FileMap } from "../change-analysis/helpers/worktree-fixture";

const BADGE = `${APP_DIR}/shared/badge/badge.component.ts`;
const ORDER_LIST = `${APP_DIR}/orders/order-list/order-list.component.ts`;
const SIGNAL_CARD = `${APP_DIR}/shared/signal-card/signal-card.component.ts`;
const SERVICE = `${APP_DIR}/orders/orders.service.ts`;

/** Queries of a run whose head changes the badge styles (so analysis builds its head index). */
async function queries(
  t: TestContext,
  head: FileMap = withChanges({ [`${APP_DIR}/shared/badge/badge.component.css`]: ".badge{}\n" }),
  base: FileMap = MAIN_FILES,
  repo = {}
): Promise<AngularSourceQueriesLike> {
  const { result } = await analyzeAngular(t, base, head, { repo });
  const q = result.sourceQueries;
  assert.ok(isAngularSourceQueries(q));
  return q;
}

test("AngularSourceQueries.getComponentMeta reads an external template, styles, inputs and injected services", async (t) => {
  const q = await queries(t);
  const meta = await q.getComponentMeta(ORDER_LIST, "OrderListComponent", "head");
  assert.ok(meta !== null);
  assert.equal(meta.selector, "app-order-list");
  assert.equal(meta.standalone, true);
  assert.equal(meta.template?.kind, "external");
  assert.equal(meta.template.path, `${APP_DIR}/orders/order-list/order-list.component.html`);
  assert.ok(meta.template.text.includes("<app-badge"));
  assert.deepEqual(meta.styles, [
    { kind: "external", path: `${APP_DIR}/orders/order-list/order-list.component.scss`, language: "scss" }
  ]);
  assert.deepEqual(meta.imports, ["BadgeComponent", "MoneyPipe", "HighlightDirective"]);
  assert.deepEqual(meta.injected, [
    {
      token: "OrdersService",
      via: "constructor",
      optional: false,
      importSpecifier: "../orders.service",
      resolvedPath: SERVICE,
      providedIn: "root",
      hints: []
    }
  ]);
  assert.equal(meta.changeDetection, "Default");
  assert.equal(meta.declaringModule, null);
});

test("AngularSourceQueries.getComponentMeta returns inline templates unescaped with their line, and NgModule declarations", async (t) => {
  const q = await queries(t);
  const card = await q.getComponentMeta(SIGNAL_CARD, "SignalCardComponent", "head");
  assert.equal(card?.template?.kind, "inline");
  assert.equal(card.template.path, null);
  assert.equal(card.template.startLine, 5);
  assert.ok(card.template.text.startsWith('<article [class.compact]="compact()">\n'));
  assert.deepEqual(
    card.inputs.map((input) => [input.name, input.kind, input.required, input.typeText, input.hasTransform]),
    [
      ["title", "signal", true, "string", false],
      ["compact", "signal", false, null, true]
    ]
  );
  const chip = await q.getComponentMeta(
    `${APP_DIR}/shared/legacy-chip/legacy-chip.component.ts`,
    "LegacyChipComponent",
    "head"
  );
  assert.equal(chip?.standalone, false);
  assert.deepEqual(chip.declaringModule, {
    filePath: `${APP_DIR}/shared/legacy-chip/legacy-chip.module.ts`,
    className: "LegacyChipModule"
  });
  const bell = await q.getComponentMeta(
    `${APP_DIR}/notifications/notification-bell.component.ts`,
    "NotificationBellComponent",
    "head"
  );
  assert.deepEqual(bell?.injected[0]?.hints, ["constructor starts a timer", "constructor subscribes on creation"]);
  assert.equal(await q.getComponentMeta(SERVICE, "OrdersService", "head"), null);
});

test("AngularSourceQueries.getComponentMeta reads the base side", async (t) => {
  const q = await queries(t);
  const meta = await q.getComponentMeta(BADGE, "BadgeComponent", "base");
  assert.equal(meta?.className, "BadgeComponent");
  assert.deepEqual(
    meta.inputs.map((input) => [input.name, input.typeText, input.initializerText]),
    [
      ["label", "string", null],
      ["tone", '"info" | "warn"', '"info"']
    ]
  );
});

test("AngularSourceQueries.getInjectableOutline elides bodies, drops private members and caps the outline", async (t) => {
  const q = await queries(t);
  const outline = await q.getInjectableOutline(`${APP_DIR}/notifications/poller.service.ts`, "PollerService", "head");
  assert.ok(outline !== null);
  assert.equal(outline.providedIn, "root");
  assert.deepEqual(outline.constructorHints, ["constructor starts a timer", "constructor subscribes on creation"]);
  assert.equal(
    outline.outline,
    `@Injectable({ providedIn: "root" })
export class PollerService {
  constructor() { … }
  current(): number { … }
}`
  );
  const big = `${APP_DIR}/big.service.ts`;
  const methods = Array.from({ length: 150 }, (_, i) => `  m${String(i)}() { return ${String(i)}; }`).join("\n");
  const head = withChanges({ [big]: `export class BigService {\n${methods}\n}\n` });
  const q2 = await queries(t, head, head);
  const capped = await q2.getInjectableOutline(big, "BigService", "head");
  const lines = capped?.outline.split("\n") ?? [];
  assert.equal(lines.length, 120);
  assert.equal(lines.at(-2), "  // … (outline truncated)");
  assert.equal(capped?.providedIn, null);
  assert.equal(await q.getInjectableOutline(SERVICE, "Missing", "head"), null);
});

test("AngularSourceQueries.getAppProviders follows an imported appConfig", async (t) => {
  const q = await queries(t);
  assert.deepEqual(await q.getAppProviders("head"), [
    { text: "provideRouter([])", token: null, source: `${APP_DIR}/app.config.ts` },
    { text: '{ provide: API_BASE_URL, useValue: "/api" }', token: "API_BASE_URL", source: `${APP_DIR}/app.config.ts` }
  ]);
});

test("AngularSourceQueries.getAppProviders reads an object literal and mergeApplicationConfig", async (t) => {
  const main = `${SRC}/main.ts`;
  const literal = withChanges({
    [main]: `import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
bootstrapApplication(AppComponent, { providers: [provideHttpClient(), { provide: TOKEN, useValue: 1 }] });
`
  });
  assert.deepEqual(await (await queries(t, literal, literal)).getAppProviders("head"), [
    { text: "provideHttpClient()", token: null, source: main },
    { text: "{ provide: TOKEN, useValue: 1 }", token: "TOKEN", source: main }
  ]);
  const merged = withChanges({
    [main]: `import { bootstrapApplication, mergeApplicationConfig } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
const extra = { providers: [provideAnimations()] };
bootstrapApplication(AppComponent, mergeApplicationConfig(appConfig, extra));
`
  });
  assert.deepEqual(
    (await (await queries(t, merged, merged)).getAppProviders("head")).map((p) => [p.text, p.source]),
    [
      ["provideRouter([])", `${APP_DIR}/app.config.ts`],
      ['{ provide: API_BASE_URL, useValue: "/api" }', `${APP_DIR}/app.config.ts`],
      ["provideAnimations()", main]
    ]
  );
});

test("AngularSourceQueries.getAppProviders reads an NgModule bootstrap", async (t) => {
  const main = `${SRC}/main.ts`;
  const module = `${APP_DIR}/app.module.ts`;
  const files = withChanges({
    [main]: `import { platformBrowserDynamic } from "@angular/platform-browser-dynamic";
import { AppModule } from "./app/app.module";
platformBrowserDynamic().bootstrapModule(AppModule);
`,
    [module]: `import { NgModule } from "@angular/core";
import { BrowserModule } from "@angular/platform-browser";
import { HttpClientModule } from "@angular/common/http";
@NgModule({ imports: [BrowserModule, HttpClientModule], providers: [{ provide: API_BASE_URL, useValue: "/v2" }, AuthService] })
export class AppModule {}
`
  });
  assert.deepEqual(await (await queries(t, files, files)).getAppProviders("head"), [
    { text: '{ provide: API_BASE_URL, useValue: "/v2" }', token: "API_BASE_URL", source: module },
    { text: "AuthService", token: null, source: module },
    { text: "importProvidersFrom(BrowserModule)", token: null, source: module },
    { text: "importProvidersFrom(HttpClientModule)", token: null, source: module }
  ]);
  assert.deepEqual(await (await queries(t, files, files, { entryFilePath: null })).getAppProviders("head"), []);
});

test("AngularSourceQueries.findSpecSetups returns the TestBed.configureTestingModule call", async (t) => {
  const q = await queries(t);
  const setups = await q.findSpecSetups(ORDER_LIST, "OrderListComponent", "head", 3);
  assert.equal(setups.length, 1);
  const [setup] = setups;
  assert.equal(setup?.filePath, `${APP_DIR}/orders/order-list/order-list.component.spec.ts`);
  assert.equal(setup.role, "test");
  assert.equal(setup.line, 6);
  assert.equal(
    setup.snippet,
    `// ${APP_DIR}/orders/order-list/order-list.component.spec.ts lines 6–8 (TestBed setup)
TestBed.configureTestingModule({
      imports: [OrderListComponent]
    })`
  );
  assert.deepEqual(await q.findSpecSetups(BADGE, "BadgeComponent", "head", 3), []);
});

test("AngularSourceQueries.findCallSites returns template usages with snippets", async (t) => {
  const q = await queries(t);
  const sites = await q.findCallSites(BADGE, "BadgeComponent", "head", 5);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.filePath, `${APP_DIR}/orders/order-list/order-list.component.html`);
  assert.equal(sites[0].line, 4);
  assert.equal(sites[0].role, "source");
  assert.equal(sites[0].usedAs, "app-badge");
  assert.ok(
    sites[0].snippet.startsWith(
      `// ${APP_DIR}/orders/order-list/order-list.component.html lines 1–10 (usage at line 4)\n`
    )
  );
  const inline = await q.findCallSites(
    `${APP_DIR}/shared/legacy-chip/legacy-chip.component.ts`,
    "LegacyChipComponent",
    "head",
    5
  );
  assert.equal(inline[0]?.filePath, `${APP_DIR}/orders/order-summary.component.ts`);
  assert.equal(inline[0].line, 7, "inline template lines are file lines");
});

test("AngularSourceQueries.resolveTypeSources lists inputs and the declarations of their types", async (t) => {
  const types = `${APP_DIR}/shared/badge/badge.types.ts`;
  const files = withChanges({
    [types]: `export type Tone = "info" | "warn";\nexport interface BadgeStyle { tone: Tone; outline: boolean }\n`,
    [BADGE]: `import { Component, Input, input } from "@angular/core";
import type { BadgeStyle } from "./badge.types";
@Component({ selector: "app-badge", templateUrl: "./badge.component.html" })
export class BadgeComponent {
  @Input() label!: string;
  look = input<BadgeStyle | null>(null);
  extra = input.required<Missing>();
}
`
  });
  const q = await queries(t, files, files);
  const result = await q.resolveTypeSources(BADGE, "BadgeComponent", "head");
  assert.equal(result.found, true);
  assert.equal(result.propsTypeName, null);
  assert.equal(result.parameterText, "label?: string\nlook?: BadgeStyle | null = null\nextra: Missing");
  assert.deepEqual(
    result.sources.map((s) => [s.name, s.kind, s.depth, s.filePath]),
    [
      ["BadgeStyle", "interface", 0, types],
      ["Tone", "type", 1, types]
    ]
  );
  assert.deepEqual(result.unresolved, ["Missing"]);
});

test("AngularSourceQueries.changedDependenciesOf follows imports and template/style ownership", async (t) => {
  const head = withChanges({
    [`${APP_DIR}/shared/badge/badge.component.html`]: "<i>{{ label }}</i>\n",
    [`${APP_DIR}/orders/order-list/order-list.component.html`]: "<p>changed</p><app-badge />\n",
    [SERVICE]: MAIN_FILES[SERVICE]?.replace("/orders", "/v2/orders") ?? ""
  });
  const q = await queries(t, head);
  assert.deepEqual(
    (await q.changedDependenciesOf(ORDER_LIST, "head", 3)).map((d) => [d.path, d.depth, d.status]),
    [
      [SERVICE, 1, "M"],
      [`${APP_DIR}/shared/badge/badge.component.html`, 2, "M"]
    ],
    "own template excluded; the child's template is an ownership edge"
  );
});

test("AngularSourceQueries delegates path, import and export queries to 08", async (t) => {
  const q = await queries(t);
  assert.equal(q.framework, "angular");
  assert.deepEqual(await q.componentPaths(BADGE), { base: BADGE, head: BADGE });
  assert.equal(await q.resolveSpecifier(ORDER_LIST, "@app/shared/badge/badge.component", "head"), BADGE);
  assert.deepEqual(await q.getModuleExports(SERVICE, "head"), ["OrdersService"]);
  const imports = await q.getDirectImports(ORDER_LIST, "head");
  assert.deepEqual(
    imports.map((i) => [i.specifier, i.resolvedPath]),
    [
      ["@angular/core", null],
      ["@app/shared/badge/badge.component", BADGE],
      ["../../shared/directives/highlight.directive", `${APP_DIR}/shared/directives/highlight.directive.ts`],
      ["../../shared/pipes/money.pipe", `${APP_DIR}/shared/pipes/money.pipe.ts`],
      ["../orders.service", SERVICE]
    ]
  );
});

test("AngularSourceQueries methods never reject after the worktrees are gone", async (t) => {
  const { result, ctx } = await analyzeAngular(
    t,
    MAIN_FILES,
    withChanges({ [`${APP_DIR}/shared/badge/badge.component.css`]: "x{}\n" })
  );
  const q = result.sourceQueries;
  assert.ok(isAngularSourceQueries(q));
  assert.ok((await q.getComponentMeta(BADGE, "BadgeComponent", "head")) !== null);
  // 07 removes the worktrees after summarizing
  await rm(ctx.workspace.headDir, { recursive: true, force: true });
  await rm(ctx.workspace.baseDir, { recursive: true, force: true });
  assert.equal(await q.getComponentMeta(BADGE, "BadgeComponent", "head"), null);
  assert.equal(await q.getComponentMeta(BADGE, "BadgeComponent", "base"), null);
  assert.deepEqual(await q.getAppProviders("head"), []);
  assert.deepEqual(await q.findSpecSetups(ORDER_LIST, "OrderListComponent", "head", 1), []);
  assert.deepEqual(await q.findCallSites(BADGE, "BadgeComponent", "head", 1), []);
  assert.equal(await q.getInjectableOutline(SERVICE, "OrdersService", "head"), null);
  assert.deepEqual(await q.changedDependenciesOf(ORDER_LIST, "head", 2), []);
  assert.equal((await q.resolveTypeSources(BADGE, "BadgeComponent", "head")).found, false);
  assert.deepEqual(await q.componentPaths(BADGE), { base: null, head: null });
});
