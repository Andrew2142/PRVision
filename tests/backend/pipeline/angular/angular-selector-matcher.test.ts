import assert from "node:assert/strict";
import { test } from "node:test";
import { AngularSelectorMatcher } from "../../../../backend/src/services/visualizations/pipeline/angular/angular-selector-matcher";
import { AngularTemplateScanner } from "../../../../backend/src/services/visualizations/pipeline/angular/angular-template-scanner";

const matcher = new AngularSelectorMatcher([
  { key: "badge.ts#BadgeComponent", selector: "app-badge" },
  { key: "permission.ts#PermissionDirective", selector: "[appPermission]" },
  { key: "button.ts#MatButton", selector: "button[mat-button], a[mat-button]" },
  { key: "plain.ts#PlainDirective", selector: "div:not(.fancy)" },
  { key: "card.ts#CardComponent", selector: ".card-host" },
  { key: "broken.ts#Broken", selector: "a:not(b:not(c))" }
]);
const scanner = new AngularTemplateScanner();

function matches(template: string): string[] {
  return [...matcher.matchUsages(scanner.scan(template, "t.html")).keys()].sort();
}

test("AngularSelectorMatcher.matchUsages matches element selectors", () => {
  assert.deepEqual(matches("<section><app-badge label='x' /></section>"), ["badge.ts#BadgeComponent"]);
  assert.deepEqual(matches("<app-badge-list />"), []);
});

test("AngularSelectorMatcher.matchUsages matches attribute selectors from attributes, inputs and structural directives", () => {
  assert.deepEqual(matches("<span appPermission></span>"), ["permission.ts#PermissionDirective"]);
  assert.deepEqual(matches("<span [appPermission]=\"'admin'\"></span>"), ["permission.ts#PermissionDirective"]);
  assert.deepEqual(matches("<span *appPermission=\"'admin'\"></span>"), ["permission.ts#PermissionDirective"]);
});

test("AngularSelectorMatcher.matchUsages matches compound selectors only on the right element", () => {
  assert.deepEqual(matches("<button mat-button>ok</button>"), ["button.ts#MatButton"]);
  assert.deepEqual(matches("<a mat-button href='#'>ok</a>"), ["button.ts#MatButton"]);
  assert.deepEqual(matches("<span mat-button>no</span>"), []);
});

test("AngularSelectorMatcher.matchUsages honours :not() and class selectors", () => {
  assert.deepEqual(matches("<div></div>"), ["plain.ts#PlainDirective"]);
  assert.deepEqual(matches("<div class='fancy'></div>"), []);
  assert.deepEqual(matches("<section class='card-host other'></section>"), ["card.ts#CardComponent"]);
});

test("AngularSelectorMatcher records unparsable selectors instead of throwing", () => {
  assert.deepEqual(matcher.invalidSelectors, ["broken.ts#Broken"]);
});

test("AngularSelectorMatcher.matchUsages reports the first line of use", () => {
  const usages = matcher.matchUsages(scanner.scan("<p></p>\n<app-badge />\n<app-badge />", "t.html"));
  assert.equal(usages.get("badge.ts#BadgeComponent"), 2);
});
