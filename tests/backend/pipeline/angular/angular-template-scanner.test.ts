import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AngularTemplateScanner,
  compactAngularExpression
} from "../../../../backend/src/services/visualizations/pipeline/angular/angular-template-scanner";

const scanner = new AngularTemplateScanner();

function elementNames(template: string): Array<string | null> {
  return scanner.scan(template, "t.html").elements.map((element) => element.element);
}

test("AngularTemplateScanner.scan walks control flow blocks", () => {
  const scan = scanner.scan(
    `@if (user) { <app-avatar /> } @else if (guest) { <app-guest /> } @else { <span>none</span> }
@for (item of items; track item.id) { <app-row /> } @empty { <app-empty /> }
@switch (mode) { @case ("a") { <app-a /> } @default { <app-b /> } }
@defer (on viewport) { <app-heavy /> } @placeholder { <app-ph /> } @loading { <app-load /> }
@let total = items.length;`,
    "t.html"
  );
  assert.deepEqual(scan.parseErrors, []);
  assert.deepEqual(
    scan.elements.map((element) => element.element),
    ["app-avatar", "app-guest", "span", "app-row", "app-empty", "app-a", "app-b", "app-heavy", "app-ph", "app-load"]
  );
  assert.ok(scan.fingerprint.includes("@let total=items.length"));
});

test("AngularTemplateScanner.scan records structural directives as ng-template attributes", () => {
  const scan = scanner.scan('<div *ngIf="show; else other" class="a b" [appTip]="t" (click)="go()"></div>', "t.html");
  const [template, div] = scan.elements;
  assert.deepEqual(template, { element: "ng-template", classNames: [], attrs: ["ngIf", "", "ngIfElse", ""], line: 1 });
  assert.equal(div?.element, "div");
  assert.deepEqual(div.classNames, ["a", "b"]);
  assert.deepEqual(div.attrs, ["class", "a b", "appTip", "", "click", ""]);
});

test("AngularTemplateScanner.scan collects attribute, input and output names for selector matching", () => {
  const [button] = scanner.scan(
    '<button mat-button [disabled]="busy" [(ngModel)]="v" (saved)="x()">ok</button>',
    "t.html"
  ).elements;
  assert.deepEqual(button?.attrs, ["mat-button", "", "disabled", "", "ngModel", "", "ngModelChange", "", "saved", ""]);
});

test("AngularTemplateScanner.scan collects pipe names in bindings, interpolations, blocks and ICUs", () => {
  const scan = scanner.scan(
    `<p [title]="name | uppercase">{{ price | currency: "EUR" | trim }}</p>
@if (items | async; as list) { {{ list.length }} }
<span [data]="value | json"></span>
{count, plural, =0 {none} other {{{ count | number }} items}}`,
    "t.html"
  );
  assert.deepEqual(scan.pipes, ["async", "currency", "json", "number", "trim", "uppercase"]);
});

test("AngularTemplateScanner.scan fingerprint ignores formatting and attribute order but not content", () => {
  const a = scanner.scan('<div class="x" id="y">\n  <b>{{ a + b }}</b>\n  <!-- note -->\n</div>', "t.html");
  const b = scanner.scan('<div   id="y" class="x"><b>{{a+b}}</b></div>', "t.html");
  const c = scanner.scan('<div id="y" class="x"><b>{{a-b}}</b></div>', "t.html");
  const d = scanner.scan('<div id="y" class="x z"><b>{{a+b}}</b></div>', "t.html");
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.notEqual(a.fingerprint, d.fingerprint);
});

test("AngularTemplateScanner.scan tolerates parse errors with a partial result", () => {
  const scan = scanner.scan("<div><app-ok />{{ a | }}</div><span>@if (</span>", "broken.html");
  assert.ok(scan.parseErrors.length > 0);
  assert.ok(Array.isArray(scan.elements));
  assert.equal(typeof scan.fingerprint, "string");
  assert.doesNotThrow(() => scanner.scan("<<<<", "x.html"));
});

test("AngularTemplateScanner.scan reports 1-based element lines", () => {
  const scan = scanner.scan("<div>\n\n  <app-badge />\n</div>", "t.html");
  assert.deepEqual(
    scan.elements.map((element) => [element.element, element.line]),
    [
      ["div", 1],
      ["app-badge", 3]
    ]
  );
  assert.deepEqual(elementNames("<ng-content select='[slot]' /><ng-container><i></i></ng-container>"), [
    "ng-container",
    "i"
  ]);
});

test("compactAngularExpression removes insignificant whitespace outside strings", () => {
  assert.equal(compactAngularExpression("  a  +  b | x : 'a  b' "), "a+b|x:'a  b'");
  assert.equal(compactAngularExpression("item of items; track item.id"), "item of items;track item.id");
});
