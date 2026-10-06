import assert from "node:assert/strict";
import { test } from "node:test";
import { STRUCTURAL_DIFF_MAX_DEPTH, STRUCTURAL_DIFF_MAX_NODES } from "../../../../backend/src/config-consts";
import {
  angularTemplateToTree,
  diffAngularTemplateTrees
} from "../../../../backend/src/services/visualizations/pipeline/angular/angular-template-tree";
import {
  newJsxBudget,
  type AttributeValue,
  type JsxElementNode,
  type JsxTreeNode
} from "../../../../backend/src/services/visualizations/pipeline/structural-diff-service";
import type { StructuralChange } from "../../../../backend/src/types/visualization-pipeline";

/** Plain-object view of a tree (Maps → objects, empty attribute maps and child lists omitted). */
type PlainNode =
  { text: string } | { tag: string; key?: string; attributes?: Record<string, string>; children?: PlainNode[] };

function plain(nodes: readonly JsxTreeNode[]): PlainNode[] {
  return nodes.map((node): PlainNode => {
    if (node.kind === "text") {
      return { text: node.text };
    }
    const out: PlainNode = { tag: node.tag };
    if (node.key !== null) {
      out.key = node.key;
    }
    if (node.attributes.size > 0) {
      out.attributes = Object.fromEntries([...node.attributes].map(([name, value]) => [name, value.text]));
    }
    if (node.children.length > 0) {
      out.children = plain(node.children);
    }
    return out;
  });
}

function tree(template: string): PlainNode[] {
  const result = angularTemplateToTree(template, "test.html");
  assert.equal(result.parseFailed, false, `parsed: ${result.errors.join("; ")}`);
  return plain(result.nodes);
}

function firstElement(template: string): JsxElementNode {
  const [node] = angularTemplateToTree(template, "test.html").nodes;
  assert.ok(node?.kind === "element", "first node is an element");
  return node;
}

function attribute(template: string, name: string): AttributeValue | undefined {
  return firstElement(template).attributes.get(name);
}

function diff(base: string, head: string): StructuralChange[] {
  return diffAngularTemplateTrees(
    angularTemplateToTree(base, "base.html").nodes,
    angularTemplateToTree(head, "head.html").nodes
  ).changes;
}

// ---------------------------------------------------------------------------------------------------------------
// Node table (15 §5.8.2)
// ---------------------------------------------------------------------------------------------------------------

test("angularTemplateToTree maps elements, nested elements and namespaced tags", () => {
  assert.deepEqual(tree(`<section><h2>Title</h2><svg><path d="M0"></path></svg></section>`), [
    {
      tag: "section",
      children: [
        { tag: "h2", children: [{ text: "Title" }] },
        { tag: "svg", children: [{ tag: "path", attributes: { d: "M0" } }] }
      ]
    }
  ]);
});

test("angularTemplateToTree maps <ng-template> to ng-template with its own attributes", () => {
  assert.deepEqual(tree(`<ng-template #row let-item><li>{{ item }}</li></ng-template>`), [
    {
      tag: "ng-template",
      attributes: { "#row": "true", "let-item": "true" },
      children: [{ tag: "li", children: [{ text: "{{ item }}" }] }]
    }
  ]);
});

test("angularTemplateToTree maps a structural directive to ng-template holding the microsyntax", () => {
  assert.deepEqual(tree(`<p *ngIf="user as u; else empty" class="name">{{ u.name }}</p>`), [
    {
      tag: "ng-template",
      attributes: { "*ngIf": "user as u; else empty" },
      children: [{ tag: "p", attributes: { class: "name" }, children: [{ text: "{{ u.name }}" }] }]
    }
  ]);
});

test("angularTemplateToTree maps @if / @else if / @else to @if with branch elements", () => {
  assert.deepEqual(tree(`@if (count > 1) {<b>many</b>} @else if (count === 1) {<i>one</i>} @else {<u>none</u>}`), [
    {
      tag: "@if",
      attributes: { condition: "count > 1" },
      children: [
        { tag: "@if-branch", children: [{ tag: "b", children: [{ text: "many" }] }] },
        {
          tag: "@else-if",
          attributes: { condition: "count === 1" },
          children: [{ tag: "i", children: [{ text: "one" }] }]
        },
        { tag: "@else", children: [{ tag: "u", children: [{ text: "none" }] }] }
      ]
    }
  ]);
});

test("angularTemplateToTree keeps an @if alias in the condition", () => {
  assert.deepEqual(tree(`@if (user$ | async; as user) {<span>{{ user.name }}</span>}`), [
    {
      tag: "@if",
      attributes: { condition: "user$ | async; as user" },
      children: [{ tag: "@if-branch", children: [{ tag: "span", children: [{ text: "{{ user.name }}" }] }] }]
    }
  ]);
});

test("angularTemplateToTree maps @for with of/track attributes, keyed body and @empty", () => {
  assert.deepEqual(
    tree(`@for (item of items; track item.id; let i = $index) {<li>{{ item.name }}</li>} @empty {<p>None</p>}`),
    [
      {
        tag: "@for",
        attributes: { of: "item of items", track: "item.id" },
        children: [
          { tag: "li", key: "{item.id}", children: [{ text: "{{ item.name }}" }] },
          { tag: "@empty", children: [{ tag: "p", children: [{ text: "None" }] }] }
        ]
      }
    ]
  );
});

test("angularTemplateToTree keys elements in a *ngFor template with trackBy", () => {
  assert.deepEqual(tree(`<li *ngFor="let row of rows; trackBy: trackById">{{ row }}</li>`), [
    {
      tag: "ng-template",
      attributes: { "*ngFor": "let row of rows; trackBy: trackById" },
      children: [{ tag: "li", key: "{trackById}", children: [{ text: "{{ row }}" }] }]
    }
  ]);
  const [withoutTrackBy] = tree(`<li *ngFor="let row of rows">{{ row }}</li>`);
  assert.deepEqual(withoutTrackBy, {
    tag: "ng-template",
    attributes: { "*ngFor": "let row of rows" },
    children: [{ tag: "li", children: [{ text: "{{ row }}" }] }]
  });
});

test("angularTemplateToTree maps @switch / @case / @default", () => {
  assert.deepEqual(
    tree(
      `@switch (mode) { @case ('a') {<a-view></a-view>} @case ('b') @case ('c') {<bc-view></bc-view>} @default {<em>?</em>} }`
    ),
    [
      {
        tag: "@switch",
        attributes: { expression: "mode" },
        children: [
          { tag: "@case", attributes: { value: "'a'" }, children: [{ tag: "a-view" }] },
          { tag: "@case", attributes: { value: "'b', 'c'" }, children: [{ tag: "bc-view" }] },
          { tag: "@default", children: [{ tag: "em", children: [{ text: "?" }] }] }
        ]
      }
    ]
  );
});

test("angularTemplateToTree maps @defer with triggers and its sub-blocks in source order", () => {
  assert.deepEqual(
    tree(
      `@defer (on viewport; prefetch on idle) {<big-chart></big-chart>} @loading {<spinner></spinner>} @placeholder (minimum 500ms) {<p>Soon</p>} @error {<p>Failed</p>}`
    ),
    [
      {
        tag: "@defer",
        attributes: { triggers: "on viewport; prefetch on idle" },
        children: [
          { tag: "big-chart" },
          { tag: "@loading", children: [{ tag: "spinner" }] },
          {
            tag: "@placeholder",
            attributes: { parameters: "minimum 500ms" },
            children: [{ tag: "p", children: [{ text: "Soon" }] }]
          },
          { tag: "@error", children: [{ tag: "p", children: [{ text: "Failed" }] }] }
        ]
      }
    ]
  );
  assert.deepEqual(tree(`@defer {<lazy-thing></lazy-thing>}`), [{ tag: "@defer", children: [{ tag: "lazy-thing" }] }]);
});

test("angularTemplateToTree maps @let to an element with name and value", () => {
  assert.deepEqual(tree(`@let fullName = user.first + ' ' + user.last;`), [
    { tag: "@let", attributes: { name: "fullName", value: "user.first + ' ' + user.last" } }
  ]);
});

test("angularTemplateToTree maps text, bound text and ICU expressions to text nodes", () => {
  assert.deepEqual(
    tree(
      `<p>Hello   world</p><p>{{ notification.title }}</p><p>Due {{ date | date }} today</p><p>{count, plural, =0 {none} other {many}}</p>`
    ),
    [
      { tag: "p", children: [{ text: "Hello world" }] },
      { tag: "p", children: [{ text: "{{ notification.title }}" }] },
      { tag: "p", children: [{ text: "Due {{ date | date }} today" }] },
      { tag: "p", children: [{ text: "{count, plural, =0 {none} other {many}}" }] }
    ]
  );
});

test("angularTemplateToTree collapses whitespace and drops whitespace-only text and comments", () => {
  assert.deepEqual(tree(`<div>\n   <!-- a comment -->\n   <span>  a\n   b  </span>\n</div>`), [
    { tag: "div", children: [{ tag: "span", children: [{ text: "a b" }] }] }
  ]);
});

test("angularTemplateToTree maps <ng-content> with its select attribute", () => {
  assert.deepEqual(tree(`<header><ng-content select="[slot=title]"></ng-content><ng-content></ng-content></header>`), [
    {
      tag: "header",
      children: [{ tag: "ng-content", attributes: { select: "[slot=title]" } }, { tag: "ng-content" }]
    }
  ]);
});

// ---------------------------------------------------------------------------------------------------------------
// Attribute table (15 §5.8.2)
// ---------------------------------------------------------------------------------------------------------------

test("angularTemplateToTree class attribute has text and tokens", () => {
  assert.deepEqual(attribute(`<div class="px-4  py-2 px-4"></div>`, "class"), {
    text: "px-4 py-2 px-4",
    tokens: ["px-4", "py-2"]
  });
});

test("angularTemplateToTree [ngClass] object literal gives key tokens", () => {
  assert.deepEqual(
    attribute(`<div [ngClass]="{ active: isActive, 'text-red-500 font-bold': hasError }"></div>`, "[ngClass]"),
    {
      text: "{{ active: isActive, 'text-red-500 font-bold': hasError }}",
      tokens: ["active", "text-red-500", "font-bold"]
    }
  );
});

test("angularTemplateToTree [ngClass] / [class] strings, arrays, conditionals and template literals give tokens", () => {
  assert.deepEqual(
    attribute(`<div [ngClass]="['card', big ? 'card-lg' : 'card-sm', on && 'is-on']"></div>`, "[ngClass]")?.tokens,
    ["card", "card-lg", "card-sm", "is-on"]
  );
  assert.deepEqual(attribute(`<div [class]="'a b'"></div>`, "[class]")?.tokens, ["a", "b"]);
  assert.deepEqual(attribute('<div [class]="`btn btn-${size}`"></div>', "[class]")?.tokens, ["btn", "btn-", "${size}"]);
});

test("angularTemplateToTree [ngClass] with any other expression gives one {expr} token", () => {
  assert.deepEqual(attribute(`<div [ngClass]="classesFor(item)"></div>`, "[ngClass]"), {
    text: "{classesFor(item)}",
    tokens: ["{classesFor(item)}"]
  });
});

test("angularTemplateToTree bound attributes, events, two-way bindings and [class.x] are {expr} without tokens", () => {
  const span = firstElement(
    `<span [class.active]="isOn" [style.width.px]="w" [ngStyle]="styles" [disabled]="busy" [attr.aria-label]="label" (click)="select(item)" [(ngModel)]="value"></span>`
  );
  assert.deepEqual(Object.fromEntries(span.attributes), {
    "[class.active]": { text: "{isOn}", tokens: null },
    "[style.width.px]": { text: "{w}", tokens: null },
    "[ngStyle]": { text: "{styles}", tokens: null },
    "[disabled]": { text: "{busy}", tokens: null },
    "[attr.aria-label]": { text: "{label}", tokens: null },
    "(click)": { text: "{select(item)}", tokens: null },
    "[(ngModel)]": { text: "{value}", tokens: null }
  });
});

test("angularTemplateToTree references, i18n markers, style and static attributes keep their value", () => {
  const input = firstElement(
    `<input #name #model="ngModel" i18n-placeholder i18n="@@nameField" style="color: red" placeholder="Name" required>`
  );
  assert.deepEqual(Object.fromEntries([...input.attributes].map(([name, value]) => [name, value.text])), {
    "#name": "true",
    "#model": "ngModel",
    "i18n-placeholder": "true",
    i18n: "@@nameField",
    style: "color: red",
    placeholder: "Name",
    required: "true"
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Diff behaviour through diffAngularTemplateTrees
// ---------------------------------------------------------------------------------------------------------------

test("diffAngularTemplateTrees reports class token changes and added control flow at template paths", () => {
  assert.deepEqual(
    diff(
      `<span class="badge">{{ label }}</span>`,
      `<span class="badge badge-lg">{{ label }}</span> @if (count) {<b>{{ count }}</b>}`
    ),
    [
      {
        kind: "attribute_changed",
        path: "span",
        tag: "span",
        attribute: "class",
        before: "badge",
        after: "badge badge-lg",
        tokensAdded: ["badge-lg"],
        tokensRemoved: []
      },
      { kind: "element_added", path: "@if", tag: "@if" }
    ]
  );
});

test("diffAngularTemplateTrees ignores [ngClass] key order and reports token changes", () => {
  assert.deepEqual(diff(`<div [ngClass]="{ a: x, b: y }"></div>`, `<div [ngClass]="{ b: y, a: x }"></div>`), []);
  assert.deepEqual(diff(`<div [ngClass]="{ a: x }"></div>`, `<div [ngClass]="{ a: x, b: y }"></div>`), [
    {
      kind: "attribute_changed",
      path: "div",
      tag: "div",
      attribute: "[ngClass]",
      before: "{{ a: x }}",
      after: "{{ a: x, b: y }}",
      tokensAdded: ["b"],
      tokensRemoved: []
    }
  ]);
});

test("diffAngularTemplateTrees matches @for body elements by track key", () => {
  assert.deepEqual(
    diff(
      `<ul>@for (item of items; track item.id) {<li>{{ item.name }}</li>}</ul>`,
      `<ul>@for (item of items; track item.id) {<span>new</span><li>{{ item.name }}</li>}</ul>`
    ),
    [{ kind: "element_added", path: "ul > @for > span{key={item.id}}", tag: "span" }]
  );
  assert.deepEqual(
    diff(
      `<ul>@for (item of items; track item.id) {<li>{{ item.name }}</li>}</ul>`,
      `<ul>@for (item of items; track item.id) {<li>{{ item.label }}</li>}</ul>`
    ),
    [
      {
        kind: "text_changed",
        path: "ul > @for > li{key={item.id}} > #text[0]",
        before: "{{ item.name }}",
        after: "{{ item.label }}"
      }
    ]
  );
});

test("diffAngularTemplateTrees reports condition, branch and top-level sibling changes", () => {
  assert.deepEqual(diff(`@if (a) {<p>x</p>} @else {<p>y</p>}`, `@if (b) {<p>x</p>} @else {<p>z</p>}`), [
    { kind: "attribute_changed", path: "@if", tag: "@if", attribute: "condition", before: "a", after: "b" },
    { kind: "text_changed", path: "@if > @else > p > #text[0]", before: "y", after: "z" }
  ]);
  assert.deepEqual(diff(`<h1>T</h1><p>a</p><p>b</p>`, `<h1>T</h1><p>a</p>`), [
    { kind: "element_removed", path: "p[1]", tag: "p" }
  ]);
  assert.deepEqual(diff(`Hello`, `Hello there`), [
    { kind: "text_changed", path: "#text[0]", before: "Hello", after: "Hello there" }
  ]);
});

test("diffAngularTemplateTrees of an empty side reports every top-level element", () => {
  assert.deepEqual(diff(``, `<header></header><main></main>`), [
    { kind: "element_added", path: "header", tag: "header" },
    { kind: "element_added", path: "main", tag: "main" }
  ]);
  assert.deepEqual(diff(`<header></header>`, ``), [{ kind: "element_removed", path: "header", tag: "header" }]);
});

test("diffAngularTemplateTrees stops at maxChanges", () => {
  const base = Array.from({ length: 10 }, (_, i) => `<p>${String(i)}</p>`).join("");
  const head = Array.from({ length: 10 }, (_, i) => `<p>${String(i + 100)}</p>`).join("");
  const result = diffAngularTemplateTrees(
    angularTemplateToTree(base, "b").nodes,
    angularTemplateToTree(head, "h").nodes,
    3
  );
  assert.equal(result.changes.length, 3);
  assert.equal(result.truncated, true);
});

// ---------------------------------------------------------------------------------------------------------------
// Errors and budget
// ---------------------------------------------------------------------------------------------------------------

test("angularTemplateToTree reports parseFailed when the compiler returns errors and no nodes", () => {
  const result = angularTemplateToTree(`@if (a) {`, "broken.html");
  assert.equal(result.parseFailed, true);
  assert.deepEqual(result.nodes, []);
  assert.ok(result.errors.length > 0);
});

test("angularTemplateToTree keeps a partial tree when errors come with nodes", () => {
  const result = angularTemplateToTree(`<div [title]="a b"></div>`, "partial.html");
  assert.equal(result.parseFailed, false);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(plain(result.nodes), [{ tag: "div", attributes: { "[title]": "{a b}" } }]);
});

test("angularTemplateToTree stops at the node budget and the depth limit", () => {
  const many = Array.from({ length: STRUCTURAL_DIFF_MAX_NODES + 5 }, () => "<i></i>").join("");
  const budget = newJsxBudget();
  const wide = angularTemplateToTree(many, "wide.html", budget);
  assert.equal(wide.nodes.length, STRUCTURAL_DIFF_MAX_NODES);
  assert.equal(budget.truncated, true);

  const deepBudget = newJsxBudget();
  const deep = `${"<div>".repeat(STRUCTURAL_DIFF_MAX_DEPTH + 3)}x${"</div>".repeat(STRUCTURAL_DIFF_MAX_DEPTH + 3)}`;
  angularTemplateToTree(deep, "deep.html", deepBudget);
  assert.equal(deepBudget.truncated, true);
});
