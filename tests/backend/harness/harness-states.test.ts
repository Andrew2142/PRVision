import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractHarnessStates,
  stateNameIssue,
  stepIssue,
  type StateExtraction
} from "../../../backend/src/services/visualizations/pipeline/harness-states";
import type { HarnessIssueCode } from "../../../backend/src/services/visualizations/pipeline/harness-validator";

const REACT_IMPORTS =
  'import { definePrvisionHarness } from "../harness-api";\nimport { InvoiceRow } from "../../src/InvoiceRow";\n';

function react(states: string, extra = ""): string {
  return `${REACT_IMPORTS}${extra}\nexport default definePrvisionHarness({\n  states: [\n${states}\n  ],\n});\n`;
}

const THREE = react(`    { name: "Default", render: () => <InvoiceRow /> },
    { name: "Overdue", render: () => <InvoiceRow overdue /> },
    {
      name: "Menu open",
      render: () => <InvoiceRow />,
      steps: [{ action: "click", target: { by: "role", role: "button", name: "More actions" } }],
    },`);

function extract(source: string, allowance = 5, allowLegacy = false): StateExtraction {
  return extractHarnessStates(source, "react_vite", { stateAllowance: allowance, allowLegacy });
}

function issues(result: StateExtraction): Array<{ code: HarnessIssueCode; message: string }> {
  if (result.ok) {
    assert.fail(`expected the extraction to fail: ${JSON.stringify(result)}`);
  }
  return result.issues.map(({ code, message }) => ({ code, message }));
}

function assertIssue(result: StateExtraction, code: HarnessIssueCode, message: string): void {
  const found = issues(result);
  assert.ok(
    found.some((issue) => issue.code === code && issue.message === message),
    `expected [${code}] ${message}; got ${JSON.stringify(found)}`
  );
}

// ---- React ----

test("extractHarnessStates reads a React three-state harness, Default first", () => {
  const result = extract(THREE, 3);
  assert.deepEqual(result, {
    ok: true,
    legacy: false,
    states: [
      { name: "Default", steps: [] },
      { name: "Overdue", steps: [] },
      { name: "Menu open", steps: [{ action: "click", target: { by: "role", role: "button", name: "More actions" } }] }
    ]
  });
});

test("extractHarnessStates accepts a wrapper, function expressions, identifiers and template-literal names", () => {
  const source = react(
    `    { name: \`Default\`, render: Row },
    { name: "Long name", render: function LongName() { return <InvoiceRow name="x" />; } },`,
    "function Row() { return <InvoiceRow />; }\n"
  ).replace("states: [", "wrapper: ({ children }) => <div>{children}</div>,\n  states: [");
  const result = extract(source);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.states.map((state) => state.name),
    ["Default", "Long name"]
  );
});

test("extractHarnessStates: a legacy PRVisionHarness is Default only with allowLegacy, harness_shape without", () => {
  const legacy =
    'import { InvoiceRow } from "../../src/InvoiceRow";\nexport default function PRVisionHarness() { return <InvoiceRow />; }\n';
  assert.deepEqual(extract(legacy, 1, true), { ok: true, legacy: true, states: [{ name: "Default", steps: [] }] });
  assertIssue(
    extract(legacy, 1, false),
    "harness_shape",
    "Default-export definePrvisionHarness({ wrapper?, states }) imported from '../harness-api'."
  );
  const identifier = "const PRVisionHarness = () => null;\nexport default PRVisionHarness;\n";
  assert.deepEqual(extract(identifier, 1, true), { ok: true, legacy: true, states: [{ name: "Default", steps: [] }] });
});

test("extractHarnessStates: harness_shape for a callee not imported from ../harness-api and for unknown keys", () => {
  const otherModule = THREE.replace('from "../harness-api"', 'from "./harness-api"');
  assertIssue(
    extract(otherModule),
    "harness_shape",
    "Default-export definePrvisionHarness({ wrapper?, states }) imported from '../harness-api'."
  );
  const unknownKey = THREE.replace("states: [", "setup: () => undefined,\n  states: [");
  assertIssue(
    extract(unknownKey),
    "harness_shape",
    "Unknown key setup in definePrvisionHarness({...}); allowed keys: wrapper, states."
  );
});

const LIST_MESSAGE =
  'states must be an array literal of { name: "...", render, steps: [...] } objects with literal names and steps.';

test("state_list_not_literal: states, a state, a name or a step that is not a literal", () => {
  assertIssue(
    extract(react("").replace("states: [\n\n  ]", "states: STATES"), 1),
    "state_list_not_literal",
    LIST_MESSAGE
  );
  assertIssue(extract(react("    ...OTHER,")), "state_list_not_literal", LIST_MESSAGE);
  assertIssue(extract(react("    { name: NAME, render: () => null },")), "state_list_not_literal", LIST_MESSAGE);
  assertIssue(
    extract(
      react('    { name: "Default", render: () => null },\n    { name: "A", render: () => null, steps: STEPS },')
    ),
    "state_list_not_literal",
    LIST_MESSAGE
  );
  assertIssue(
    extract(
      react(
        '    { name: "Default", render: () => null },\n    { name: "A", render: () => null, steps: [{ action: "type", target: { by: "label", label: "Email" }, text: value }] },'
      )
    ),
    "state_list_not_literal",
    LIST_MESSAGE
  );
  assertIssue(
    extract(react('    { name: "Default", render: () => null, ...extra },')),
    "state_list_not_literal",
    LIST_MESSAGE
  );
  assertIssue(
    extract(react('    { name: "Default", render: () => null, title: "x" },')),
    "state_list_not_literal",
    LIST_MESSAGE
  );
});

test("state_default_missing: the first state is not named Default", () => {
  assertIssue(
    extract(react('    { name: "Overdue", render: () => null },\n    { name: "Default", render: () => null },')),
    "state_default_missing",
    'The first state must be named "Default".'
  );
  assertIssue(extract(react("")), "state_default_missing", 'The first state must be named "Default".');
});

test("state_name_invalid, state_duplicate: name rules of 16 §7.1", () => {
  const named = (name: string): StateExtraction =>
    extract(
      react(`    { name: "Default", render: () => null },\n    { name: ${JSON.stringify(name)}, render: () => null },`)
    );
  for (const valid of [
    "Zero balance",
    "Menu open",
    "Long name (40 chars)",
    "A".repeat(40),
    "Paid & sent, v2 / 3+4 - it's ok."
  ]) {
    assert.equal(named(valid).ok, true, valid);
  }
  assertIssue(named(" Leading"), "state_name_invalid", 'State name " Leading" is not allowed: it starts with a space.');
  assertIssue(named("Trailing "), "state_name_invalid", 'State name "Trailing " is not allowed: it ends with a space.');
  assertIssue(
    named("A".repeat(41)),
    "state_name_invalid",
    `State name "${"A".repeat(41)}" is not allowed: it is longer than 40 characters.`
  );
  assertIssue(
    named("Party 🎉"),
    "state_name_invalid",
    'State name "Party 🎉" is not allowed: use only letters, digits, spaces and the characters , . \' ( ) & / + -, starting with a letter or digit.'
  );
  assertIssue(named(""), "state_name_invalid", 'State name "" is not allowed: it is empty.');
  assertIssue(named("Default"), "state_duplicate", 'State "Default" appears twice.');
  assertIssue(named("default"), "state_duplicate", 'State "default" appears twice.');
});

test("state_too_many: more states than the allowance (Default included)", () => {
  assertIssue(extract(THREE, 2), "state_too_many", "3 states written; the state allowance is 2 (Default included).");
  assert.equal(extract(THREE, 3).ok, true);
});

test("state_default_has_steps: Default with steps", () => {
  assertIssue(
    extract(react('    { name: "Default", render: () => null, steps: [{ action: "press", key: "Escape" }] },')),
    "state_default_has_steps",
    "The Default state has no steps."
  );
  assert.equal(extract(react('    { name: "Default", render: () => null, steps: [] },')).ok, true);
});

test("state_render_missing: a state without a usable render", () => {
  assertIssue(
    extract(react('    { name: "Default", render: () => null },\n    { name: "Overdue" },')),
    "state_render_missing",
    'State "Overdue" needs a render function.'
  );
  assertIssue(
    extract(react('    { name: "Default", render: () => null },\n    { name: "Overdue", render: <InvoiceRow /> },')),
    "state_render_missing",
    'State "Overdue" needs a render function.'
  );
  assertIssue(
    extract(react('    { name: "Default", render: () => null },\n    { name: "Overdue", render: notAFunction },')),
    "state_render_missing",
    'State "Overdue" needs a render function.'
  );
});

test("state_step_invalid: every invalid step names the state, the step and the reason", () => {
  const withStep = (step: string): StateExtraction =>
    extract(
      react(`    { name: "Default", render: () => null },\n    { name: "A", render: () => null, steps: [${step}] },`)
    );
  assertIssue(
    withStep('{ action: "click", target: { by: "role", role: "button", name: "x", nth: 21 } }'),
    "state_step_invalid",
    'State "A", step 1: target.nth must be an integer from 0 to 20.'
  );
  assertIssue(
    withStep(`{ action: "type", target: { by: "label", label: "Email" }, text: "${"t".repeat(201)}" }`),
    "state_step_invalid",
    'State "A", step 1: text is longer than 200 characters.'
  );
  assertIssue(
    withStep('{ action: "press", key: "F5" }'),
    "state_step_invalid",
    'State "A", step 1: key must be one of Enter, Escape, Tab, Space, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Home, End.'
  );
  assertIssue(
    withStep('{ action: "drag", target: { by: "text", text: "x" } }'),
    "state_step_invalid",
    'State "A", step 1: action must be one of "click", "hover", "focus", "type", "press", "waitFor".'
  );
  assertIssue(
    withStep('{ action: "click", target: { by: "role", role: "banner", name: "x" } }'),
    "state_step_invalid",
    'State "A", step 1: target.role "banner" is not supported; use one of button, link, checkbox, radio, switch, tab, menuitem, menuitemcheckbox, menuitemradio, option, combobox, textbox, searchbox, listbox, slider, spinbutton, row, cell, gridcell, heading, img, dialog, menu, tablist, treeitem.'
  );
  assertIssue(
    withStep('{ action: "click", target: { by: "text", text: "  " } }'),
    "state_step_invalid",
    'State "A", step 1: target.text must not be empty.'
  );
  const six = Array.from({ length: 6 }, () => '{ action: "waitFor", target: { by: "testId", testId: "row" } }').join(
    ", "
  );
  assertIssue(withStep(six), "state_step_invalid", 'State "A", step 6: a state has at most 5 steps.');
});

test("extractHarnessStates accepts every action and every target form", () => {
  const steps = [
    '{ action: "click", target: { by: "role", role: "button", name: "More", nth: 1 } }',
    '{ action: "hover", target: { by: "text", text: "Details" } }',
    '{ action: "focus", target: { by: "label", label: "Email" } }',
    '{ action: "type", target: { by: "placeholder", placeholder: "Search" }, text: "abc" }',
    '{ action: "press", key: "Enter", target: { by: "testId", testId: "row-menu" } }'
  ];
  const result = extract(
    react(
      `    { name: "Default", render: () => null },\n    { name: "A", render: () => null, steps: [${steps.join(", ")}] },\n    { name: "B", render: () => null, steps: [{ action: "waitFor", target: { by: "text", text: "Saved" } }, { action: "press", key: "Space" }] },`
    )
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.states[1]?.steps.length, 5);
});

test("stateNameIssue and stepIssue are pure checks", () => {
  assert.equal(stateNameIssue("Overdue"), null);
  assert.equal(
    stateNameIssue("Overdue!"),
    "use only letters, digits, spaces and the characters , . ' ( ) & / + -, starting with a letter or digit"
  );
  assert.equal(stepIssue({ action: "waitFor", target: { by: "testId", testId: "x" } }), null);
  assert.equal(
    stepIssue({ action: "click" }),
    'target must be an object such as { by: "role", role: "button", name: "Save" }'
  );
  assert.equal(
    stepIssue({ action: "click", target: { by: "text", text: "x" }, extra: 1 }),
    "click has unknown field extra"
  );
  assert.equal(
    stepIssue({ action: "click", target: { by: "text", text: "x", nth: 1.5 } }),
    "target.nth must be an integer from 0 to 20"
  );
  assert.equal(
    stepIssue("click"),
    'a step must be an object such as { action: "click", target: { by: "role", role: "button", name: "Save" } }'
  );
});

test("extractHarnessStates never throws on garbage input", () => {
  for (const source of ["", "export default", "}}}{{{", "export default definePrvisionHarness("]) {
    assert.doesNotThrow(() => extract(source));
    assert.equal(extract(source).ok, false);
  }
});

// ---- Angular ----

const ANGULAR_IMPORTS =
  "import { definePrvisionHarness } from '../harness-api';\nimport { NotificationItemComponent } from '../../src/app/n.component';\n";

function angular(descriptor: string): string {
  return `${ANGULAR_IMPORTS}\nexport default definePrvisionHarness(${descriptor});\n`;
}

function extractAngular(source: string, allowance = 5): StateExtraction {
  return extractHarnessStates(source, "angular", { stateAllowance: allowance, allowLegacy: false });
}

test("extractHarnessStates: an Angular harness without states is Default only", () => {
  assert.deepEqual(extractAngular(angular("{ component: NotificationItemComponent }"), 1), {
    ok: true,
    legacy: false,
    states: [{ name: "Default", steps: [] }]
  });
});

test("extractHarnessStates: Angular states follow Default", () => {
  const result = extractAngular(
    angular(
      "{ component: NotificationItemComponent, inputs: { a: 1 }, states: [{ name: 'Unread', inputs: { a: 2 } }, { name: 'Actions menu open', steps: [{ action: 'click', target: { by: 'role', role: 'button', name: 'Notification actions' } }] }] }"
    ),
    3
  );
  assert.deepEqual(result, {
    ok: true,
    legacy: false,
    states: [
      { name: "Default", steps: [] },
      { name: "Unread", steps: [] },
      {
        name: "Actions menu open",
        steps: [{ action: "click", target: { by: "role", role: "button", name: "Notification actions" } }]
      }
    ]
  });
});

test("extractHarnessStates: an Angular state named Default is state_name_invalid", () => {
  const result = extractAngular(angular("{ component: NotificationItemComponent, states: [{ name: 'Default' }] }"));
  assertIssue(
    result,
    "state_name_invalid",
    'State name "Default" is not allowed: the top-level descriptor is the Default state, so states lists only the additional states.'
  );
});

test("extractHarnessStates: Angular states over the allowance and non-literal lists", () => {
  assertIssue(
    extractAngular(angular("{ component: NotificationItemComponent, states: [{ name: 'A' }, { name: 'B' }] }"), 2),
    "state_too_many",
    "3 states written; the state allowance is 2 (Default included)."
  );
  assertIssue(
    extractAngular(angular("{ component: NotificationItemComponent, states: EXTRA }")),
    "state_list_not_literal",
    "states must be an array literal of { name: '...', inputs, providers, http, steps: [...] } objects with literal names and steps."
  );
  assertIssue(
    extractAngular(angular("{ component: NotificationItemComponent, states: [{ name: 'A', render: () => null }] }")),
    "state_list_not_literal",
    "states must be an array literal of { name: '...', inputs, providers, http, steps: [...] } objects with literal names and steps."
  );
});
