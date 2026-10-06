import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import {
  AngularDecoratorReader,
  type AngularDecoratedClass
} from "../../../../backend/src/services/visualizations/pipeline/angular/angular-decorator-reader";

function read(source: string, angularMajor: number | null = 21): AngularDecoratedClass[] {
  const sf = ts.createSourceFile("x.component.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return new AngularDecoratorReader({ angularMajor }).read(sf);
}

function only(source: string, angularMajor: number | null = 21): AngularDecoratedClass {
  const classes = read(source, angularMajor);
  assert.equal(classes.length, 1);
  const [cls] = classes;
  assert.ok(cls !== undefined);
  return cls;
}

test("AngularDecoratorReader.read resolves an aliased Component import", () => {
  const cls = only(`import { Component as Cmp } from "@angular/core";
@Cmp({ selector: "app-x", templateUrl: "./x.html", styleUrls: ["./x.css", "./y.scss"] })
export class XComponent {}`);
  assert.equal(cls.kind, "Component");
  assert.equal(cls.selector, "app-x");
  assert.equal(cls.templateUrl, "./x.html");
  assert.deepEqual(cls.styleUrls, ["./x.css", "./y.scss"]);
  assert.equal(cls.exportName, "XComponent");
});

test("AngularDecoratorReader.read resolves a namespace import", () => {
  const cls = only(`import * as ng from "@angular/core";
@ng.Component({ selector: "app-x", template: "<b>x</b>", styleUrl: "./x.css" })
export default class XComponent {}`);
  assert.equal(cls.kind, "Component");
  assert.equal(cls.exportName, "default");
  assert.equal(cls.inlineTemplate?.text, "<b>x</b>");
  assert.deepEqual(cls.styleUrls, ["./x.css"]);
});

test("AngularDecoratorReader.read ignores decorators that are not from @angular/core", () => {
  assert.deepEqual(read(`import { Component } from "./my-decorators";\n@Component({}) export class A {}`), []);
  assert.deepEqual(read(`@Component({}) export class A {}`), []);
});

test("AngularDecoratorReader.read defaults standalone by Angular version", () => {
  const source = `import { Component } from "@angular/core";\n@Component({ selector: "a", template: "" }) export class A {}`;
  assert.equal(only(source, 19).standalone, true);
  assert.equal(only(source, null).standalone, true);
  assert.equal(only(source, 18).standalone, false);
  const explicit = `import { Component } from "@angular/core";\n@Component({ standalone: false, template: "" }) export class A {}`;
  assert.equal(only(explicit, 21).standalone, false);
  const explicitTrue = `import { Component } from "@angular/core";\n@Component({ standalone: true, template: "" }) export class A {}`;
  assert.equal(only(explicitTrue, 17).standalone, true);
});

test("AngularDecoratorReader.read reads decorator inputs with alias, required and transform", () => {
  const cls = only(`import { booleanAttribute, Component, Input } from "@angular/core";
@Component({ selector: "a", template: "" })
export class A {
  @Input() label!: string;
  @Input("publicName") inner: number | null = 0;
  @Input({ alias: "on", required: true, transform: booleanAttribute }) enabled = true;
  @Input() set size(value: "s" | "m") {}
}`);
  assert.deepEqual(
    cls.inputs.map((i) => [i.name, i.alias, i.kind, i.required, i.typeText, i.initializerText, i.hasTransform]),
    [
      ["label", null, "decorator", false, "string", null, false],
      ["inner", "publicName", "decorator", false, "number | null", "0", false],
      ["enabled", "on", "decorator", true, null, "true", true],
      ["size", null, "decorator", false, '"s" | "m"', null, false]
    ]
  );
});

test("AngularDecoratorReader.read reads signal inputs, model() and outputs", () => {
  const cls = only(`import { Component, EventEmitter, Output, input, model, output } from "@angular/core";
import { outputFromObservable } from "@angular/core/rxjs-interop";
import { Subject } from "rxjs";
@Component({ selector: "a", template: "", inputs: ["legacy", "inner: outer"], outputs: ["done"] })
export class A {
  title = input.required<string>();
  compact = input(false, { alias: "dense", transform: (v: unknown) => !!v });
  count = input<number>(3);
  value = model<string>("x");
  checked = model.required<boolean>();
  @Output() closed = new EventEmitter<void>();
  @Output("renamed") opened = new EventEmitter<void>();
  saved = output<number>();
  picked = output<string>({ alias: "chosen" });
  changes = outputFromObservable(new Subject<number>(), { alias: "changed" });
}`);
  assert.deepEqual(
    cls.inputs.map((i) => [i.name, i.alias, i.kind, i.required, i.typeText, i.initializerText, i.hasTransform]),
    [
      ["legacy", null, "metadata", false, null, null, false],
      ["inner", "outer", "metadata", false, null, null, false],
      ["title", null, "signal", true, "string", null, false],
      ["compact", "dense", "signal", false, null, "false", true],
      ["count", null, "signal", false, "number", "3", false],
      ["value", null, "model", false, "string", '"x"', false],
      ["checked", null, "model", true, "boolean", null, false]
    ]
  );
  assert.deepEqual(
    cls.outputs.map((o) => [o.name, o.alias, o.kind]),
    [
      ["done", null, "metadata"],
      ["valueChange", null, "model"],
      ["checkedChange", null, "model"],
      ["closed", null, "decorator"],
      ["opened", "renamed", "decorator"],
      ["saved", null, "signal"],
      ["picked", "chosen", "signal"],
      ["changes", "changed", "signal"]
    ]
  );
});

test("AngularDecoratorReader.read reads constructor and inject() dependencies", () => {
  const cls = only(`import { Component, Inject, Optional, inject } from "@angular/core";
import { Router } from "@angular/router";
import { API_URL } from "../tokens";
import { OrdersService } from "../orders/orders.service";
import { Tokens } from "../all-tokens";
@Component({ selector: "a", template: "" })
export class A {
  private readonly http = inject(HttpClient);
  private readonly maybe = inject(Tokens.FLAG, { optional: true });
  constructor(
    private readonly router: Router,
    @Inject(API_URL) private readonly url: string,
    @Optional() private readonly orders: OrdersService
  ) {}
}`);
  assert.deepEqual(
    cls.injected.map((d) => [d.token, d.tokenRoot, d.via, d.optional, d.importSpecifier]),
    [
      ["Router", "Router", "constructor", false, "@angular/router"],
      ["API_URL", "API_URL", "constructor", false, "../tokens"],
      ["OrdersService", "OrdersService", "constructor", true, "../orders/orders.service"],
      ["HttpClient", "HttpClient", "inject", false, null],
      ["Tokens.FLAG", "Tokens", "inject", true, "../all-tokens"]
    ]
  );
});

test("AngularDecoratorReader.read derives constructor hints for timers, subscriptions and HTTP", () => {
  const classes = read(`import { Injectable } from "@angular/core";
import { interval } from "rxjs";
@Injectable({ providedIn: "root" })
export class Poller { constructor() { interval(1000).subscribe(); } }
@Injectable()
export class Ticker { private id = setInterval(() => 0, 10); }
@Injectable({ providedIn: "platform" })
export class Api { constructor(private http: HttpClient) { this.http.get("/x"); } load() { setTimeout(() => 0); } }`);
  assert.deepEqual(
    classes.map((c) => [c.className, c.kind, c.providedIn, c.constructorHints]),
    [
      ["Poller", "Injectable", "root", ["constructor starts a timer", "constructor subscribes on creation"]],
      ["Ticker", "Injectable", null, ["constructor starts a timer"]],
      ["Api", "Injectable", "platform", ["constructor calls HTTP"]]
    ]
  );
});

test("AngularDecoratorReader.read reads NgModule lists, pipes and directives", () => {
  const classes = read(`import { Directive, NgModule, Pipe } from "@angular/core";
import { RouterModule } from "@angular/router";
@Pipe({ name: "money", standalone: false })
export class MoneyPipe {}
@Directive({ selector: "[appHighlight]" })
export class HighlightDirective {}
@NgModule({
  declarations: [MoneyPipe, HighlightDirective],
  imports: [RouterModule.forChild([]), ...SHARED],
  exports: [MoneyPipe],
  providers: [{ provide: X, useValue: 1 }, Service]
})
export class SharedModule {}`);
  assert.deepEqual(
    classes.map((c) => [c.className, c.kind, c.pipeName, c.selector, c.standalone]),
    [
      ["MoneyPipe", "Pipe", "money", null, false],
      ["HighlightDirective", "Directive", null, "[appHighlight]", true],
      ["SharedModule", "NgModule", null, null, false]
    ]
  );
  assert.deepEqual(classes[2]?.ngModule, {
    declarations: ["MoneyPipe", "HighlightDirective"],
    imports: ["RouterModule", "SHARED"],
    exports: ["MoneyPipe"],
    providers: ["{ provide: X, useValue: 1 }", "Service"]
  });
});

test("AngularDecoratorReader.read records dynamic metadata as null", () => {
  const cls = only(`import { ChangeDetectionStrategy, Component } from "@angular/core";
const URL = "./x.html";
@Component({ selector: SELECTOR, templateUrl: URL, changeDetection: ChangeDetectionStrategy.OnPush, imports: SHARED_IMPORTS })
export class A {}`);
  assert.equal(cls.selector, null);
  assert.equal(cls.templateUrl, null);
  assert.equal(cls.inlineTemplate, null);
  assert.equal(cls.templateDynamic, true);
  assert.equal(cls.changeDetection, "OnPush");
  assert.deepEqual(cls.imports, ["SHARED_IMPORTS"]);
});

test("AngularDecoratorReader.read unescapes inline templates and reports their line", () => {
  const cls = only(`import { Component } from "@angular/core";

@Component({
  selector: "a",
  template: "<b title=\\"x\\">a\\nb</b>"
})
export class A {}`);
  assert.equal(cls.inlineTemplate?.text, '<b title="x">a\nb</b>');
  assert.equal(cls.inlineTemplate.startLine, 5);
});

test("AngularDecoratorReader.read finds export names of classes exported separately", () => {
  const classes = read(`import { Component } from "@angular/core";
@Component({ selector: "a", template: "" }) class A {}
@Component({ selector: "b", template: "" }) class B {}
@Component({ selector: "c", template: "" }) class C {}
export { A as PublicA };
export default B;`);
  assert.deepEqual(
    classes.map((c) => [c.className, c.exportName]),
    [
      ["A", "PublicA"],
      ["B", "default"],
      ["C", null]
    ]
  );
});
