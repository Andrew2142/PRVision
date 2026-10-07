import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeStep,
  describeStepTarget
} from "../../../backend/src/services/visualizations/pipeline/harness-step-text";

test("describeStep: every action (16 §14.5 examples)", () => {
  assert.equal(
    describeStep({ action: "click", target: { by: "role", role: "button", name: "More actions" } }),
    'Click button "More actions"'
  );
  assert.equal(
    describeStep({ action: "hover", target: { by: "role", role: "link", name: "Docs" } }),
    'Hover link "Docs"'
  );
  assert.equal(
    describeStep({ action: "focus", target: { by: "label", label: "Email" } }),
    'Focus field labelled "Email"'
  );
  assert.equal(
    describeStep({ action: "type", target: { by: "role", role: "textbox", name: "Search" }, text: "abc" }),
    'Type "abc" into textbox "Search"'
  );
  assert.equal(describeStep({ action: "press", key: "Escape" }), "Press Escape");
  assert.equal(
    describeStep({ action: "press", key: "Enter", target: { by: "placeholder", placeholder: "Search" } }),
    'Press Enter in field with placeholder "Search"'
  );
  assert.equal(describeStep({ action: "waitFor", target: { by: "text", text: "Saved" } }), 'Wait for text "Saved"');
});

test("describeStepTarget: every target form", () => {
  assert.equal(describeStepTarget({ by: "role", role: "menuitem", name: "Delete" }), 'menuitem "Delete"');
  assert.equal(describeStepTarget({ by: "text", text: "Overdue" }), 'text "Overdue"');
  assert.equal(describeStepTarget({ by: "label", label: "Amount" }), 'field labelled "Amount"');
  assert.equal(describeStepTarget({ by: "placeholder", placeholder: "Filter" }), 'field with placeholder "Filter"');
  assert.equal(describeStepTarget({ by: "testId", testId: "menu-trigger" }), 'test id "menu-trigger"');
});

test("describeStepTarget appends (match nth + 1) only when nth > 0", () => {
  assert.equal(describeStepTarget({ by: "role", role: "button", name: "Edit", nth: 0 }), 'button "Edit"');
  assert.equal(describeStepTarget({ by: "role", role: "button", name: "Edit", nth: 1 }), 'button "Edit" (match 2)');
  assert.equal(
    describeStep({ action: "click", target: { by: "testId", testId: "row", nth: 4 } }),
    'Click test id "row" (match 5)'
  );
});

test("quoted strings longer than 60 characters are cut to 57 plus ...", () => {
  const sixty = "x".repeat(60);
  const sixtyOne = "y".repeat(61);
  assert.equal(describeStep({ action: "waitFor", target: { by: "text", text: sixty } }), `Wait for text "${sixty}"`);
  assert.equal(
    describeStep({ action: "waitFor", target: { by: "text", text: sixtyOne } }),
    `Wait for text "${"y".repeat(57)}..."`
  );
  assert.equal(
    describeStep({ action: "type", target: { by: "label", label: "Notes" }, text: "z".repeat(200) }),
    `Type "${"z".repeat(57)}..." into field labelled "Notes"`
  );
});
