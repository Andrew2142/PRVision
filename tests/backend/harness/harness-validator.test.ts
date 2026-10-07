import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HarnessValidator,
  type HarnessIssueCode,
  type HarnessValidationInput,
  type HarnessValidationReport
} from "../../../backend/src/services/visualizations/pipeline/harness-validator";
import { validateMockedModules } from "../../../backend/src/services/visualizations/pipeline/mock-rules";
import type { DirectImport, WorktreeSide } from "../../../backend/src/types/visualization-pipeline";
import { FakeSourceQueries, directImport } from "./helpers/fake-source-queries";
import { harnessFixture } from "./helpers/temp-worktrees";

// ---- Example A (09 §5.13): Button, named export, no mocks ----

const BUTTON = "src/components/Button/Button.tsx";
const BUTTON_FILES = {
  base: [BUTTON, "src/main.tsx", "src/index.css"],
  head: [BUTTON, "src/components/Spinner/Spinner.tsx", "src/main.tsx", "src/index.css"]
};
const BUTTON_IMPORTS: Record<WorktreeSide, DirectImport[]> = {
  base: [
    directImport({ specifier: "clsx", kind: "package", defaultImport: true }),
    directImport({ specifier: "./Button.module.css", kind: "style", defaultImport: true })
  ],
  head: [
    directImport({ specifier: "clsx", kind: "package", defaultImport: true }),
    directImport({
      specifier: "../Spinner/Spinner",
      kind: "relative",
      resolvedPath: "src/components/Spinner/Spinner.tsx",
      namedImports: ["Spinner"]
    }),
    directImport({ specifier: "./Button.module.css", kind: "style", defaultImport: true })
  ]
};

function exampleA(overrides: Partial<HarnessValidationInput> = {}): HarnessValidationInput {
  return {
    harnessSource: harnessFixture("button/harness.tsx"),
    mockedModules: [],
    candidate: { filePath: BUTTON, exportName: "Button" },
    paths: { base: BUTTON, head: BUTTON },
    viteRootRel: "",
    targetImportPath: "../../src/components/Button/Button",
    directImports: BUTTON_IMPORTS,
    sidesPresent: { base: true, head: true },
    entryFilePath: "src/main.tsx",
    stateAllowance: 1,
    ...overrides
  };
}

// ---- Example B (09 §5.13): OrdersPanel, default export, two mocks ----

const PANEL = "src/features/orders/OrdersPanel.tsx";
const PANEL_SHARED_FILES = [
  PANEL,
  "src/hooks/useAuth.tsx",
  "src/api/orders.ts",
  "src/lib/format.ts",
  "src/main.tsx",
  "src/App.tsx",
  "src/index.css"
];
const PANEL_FILES = {
  base: PANEL_SHARED_FILES,
  head: [...PANEL_SHARED_FILES, "src/features/orders/OrderStatusBadge.tsx"]
};
const PANEL_COMMON_IMPORTS: DirectImport[] = [
  directImport({ specifier: "@tanstack/react-query", kind: "package", namedImports: ["useQuery"] }),
  directImport({ specifier: "react-router-dom", kind: "package", namedImports: ["Link", "useNavigate", "useParams"] }),
  directImport({
    specifier: "@/hooks/useAuth",
    kind: "alias",
    resolvedPath: "src/hooks/useAuth.tsx",
    namedImports: ["useAuth"]
  }),
  directImport({
    specifier: "@/api/orders",
    kind: "alias",
    resolvedPath: "src/api/orders.ts",
    namedImports: ["fetchOrders"]
  }),
  directImport({
    specifier: "@/lib/format",
    kind: "alias",
    resolvedPath: "src/lib/format.ts",
    namedImports: ["formatCurrency", "formatDate"]
  }),
  directImport({ specifier: "./OrdersPanel.css", kind: "style", sideEffectOnly: true })
];
const PANEL_IMPORTS: Record<WorktreeSide, DirectImport[]> = {
  base: PANEL_COMMON_IMPORTS,
  head: [
    ...PANEL_COMMON_IMPORTS,
    directImport({
      specifier: "./OrderStatusBadge",
      kind: "relative",
      resolvedPath: "src/features/orders/OrderStatusBadge.tsx",
      namedImports: ["OrderStatusBadge"]
    })
  ]
};
const MODULE_EXPORTS = {
  "src/hooks/useAuth.tsx": ["AuthContext", "AuthProvider", "useAuth"],
  "src/api/orders.ts": ["cancelOrder", "fetchOrder", "fetchOrders"],
  "src/lib/format.ts": ["formatCurrency", "formatDate", "formatRelative"]
};
const USE_AUTH_MOCK = harnessFixture("orders-panel/mock-use-auth.tsx");
const ORDERS_MOCK = harnessFixture("orders-panel/mock-api-orders.tsx");
const PANEL_HARNESS = harnessFixture("orders-panel/harness.tsx");

function exampleB(overrides: Partial<HarnessValidationInput> = {}): HarnessValidationInput {
  return {
    harnessSource: PANEL_HARNESS,
    mockedModules: [
      { specifier: "@/hooks/useAuth", source: USE_AUTH_MOCK },
      { specifier: "@/api/orders", source: ORDERS_MOCK }
    ],
    candidate: { filePath: PANEL, exportName: "default" },
    paths: { base: PANEL, head: PANEL },
    viteRootRel: "",
    targetImportPath: "../../src/features/orders/OrdersPanel",
    directImports: PANEL_IMPORTS,
    sidesPresent: { base: true, head: true },
    entryFilePath: "src/main.tsx",
    targetImportStatement: 'import OrdersPanel from "../../src/features/orders/OrdersPanel";',
    stateAllowance: 1,
    ...overrides
  };
}

function makeValidator(files: Record<WorktreeSide, string[]>): {
  validator: HarnessValidator;
  queries: FakeSourceQueries;
} {
  const queries = new FakeSourceQueries({
    files,
    moduleExports: { base: MODULE_EXPORTS, head: MODULE_EXPORTS }
  });
  const exists = { base: new Set(files.base), head: new Set(files.head) };
  const validator = new HarnessValidator(queries, (side, repoRelativePath) =>
    Promise.resolve(exists[side].has(repoRelativePath))
  );
  return { validator, queries };
}

const validateA = (overrides: Partial<HarnessValidationInput> = {}): Promise<HarnessValidationReport> =>
  makeValidator(BUTTON_FILES).validator.validate(exampleA(overrides));
const validateB = (overrides: Partial<HarnessValidationInput> = {}): Promise<HarnessValidationReport> =>
  makeValidator(PANEL_FILES).validator.validate(exampleB(overrides));

function codes(report: HarnessValidationReport): HarnessIssueCode[] {
  return report.errors.map((issue) => issue.code);
}
function warningCodes(report: HarnessValidationReport): HarnessIssueCode[] {
  return report.warnings.map((issue) => issue.code);
}
function assertError(report: HarnessValidationReport, code: HarnessIssueCode): void {
  assert.equal(report.ok, false);
  assert.ok(codes(report).includes(code), `expected ${code}, got ${JSON.stringify(report.errors)}`);
}
function replaceOnce(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `fixture contains ${from}`);
  return text.replace(from, to);
}
const withMock = (specifier: string, source: string): HarnessValidationInput["mockedModules"] => [
  { specifier: "@/hooks/useAuth", source: USE_AUTH_MOCK },
  { specifier, source }
];

test("accepts Example A", async () => {
  const report = await validateA();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.ok, true);
});

test("accepts Example B with its two mocks", async () => {
  const report = await validateB();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.ok, true);
});

// ---- multi-state harnesses (16 §7.7) ----

const THREE_STATES = [
  'import type { ReactElement } from "react";',
  'import { definePrvisionHarness } from "../harness-api";',
  'import { Button } from "../../src/components/Button/Button";',
  "",
  "const noop = (): void => {};",
  "",
  "function Saving(): ReactElement {",
  '  return <div style={{ padding: 16 }}><Button variant="primary" loading onClick={noop}>Saving…</Button></div>;',
  "}",
  "",
  "export default definePrvisionHarness({",
  "  wrapper: ({ children }) => <div style={{ maxWidth: 392 }}>{children}</div>,",
  "  states: [",
  '    { name: "Default", render: () => <Button variant="primary" onClick={noop}>Save changes</Button> },',
  '    { name: "Saving", render: Saving },',
  "    {",
  '      name: "Menu open",',
  '      render: () => <Button variant="secondary" onClick={noop}>More</Button>,',
  '      steps: [{ action: "click", target: { by: "role", role: "button", name: "More" } }]',
  "    }",
  "  ]",
  "});"
].join("\n");

test("HarnessValidator.validate accepts a three-state harness and returns its states", async () => {
  const report = await validateA({ harnessSource: THREE_STATES, stateAllowance: 3 });
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
  assert.deepEqual(report.states, [
    { name: "Default", steps: [] },
    { name: "Saving", steps: [] },
    { name: "Menu open", steps: [{ action: "click", target: { by: "role", role: "button", name: "More" } }] }
  ]);
});

test("HarnessValidator.validate respects the state allowance (state_too_many)", async () => {
  const report = await validateA({ harnessSource: THREE_STATES, stateAllowance: 2 });
  assertError(report, "state_too_many");
  assert.ok(
    report.errors.some((issue) => issue.message === "3 states written; the state allowance is 2 (Default included).")
  );
  assert.equal(report.states, null);
});

test("HarnessValidator.validate scans every state's render function (nondeterministic_api)", async () => {
  const report = await validateA({
    harnessSource: replaceOnce(
      THREE_STATES,
      '{ name: "Saving", render: Saving }',
      '{ name: "Saving", render: () => <span>{Math.random()}</span> }'
    ),
    stateAllowance: 3
  });
  assertError(report, "nondeterministic_api");
});

// ---- negative variants of Example B (09 §5.13 table) ----

test("rejects a target imported through the project alias (target_not_imported)", async () => {
  const report = await validateB({
    harnessSource: replaceOnce(
      PANEL_HARNESS,
      '"../../src/features/orders/OrdersPanel"',
      '"@/features/orders/OrdersPanel"'
    )
  });
  assertError(report, "target_not_imported");
  assert.ok(
    report.errors.some((issue) =>
      issue.message.includes('import OrdersPanel from "../../src/features/orders/OrdersPanel";')
    )
  );
});

test("rejects a named import of a default-exported target (target_binding_mismatch)", async () => {
  const report = await validateB({
    harnessSource: replaceOnce(PANEL_HARNESS, "import OrdersPanel from", "import { OrdersPanel } from")
  });
  assertError(report, "target_binding_mismatch");
});

test("rejects a default export that is not definePrvisionHarness from ../harness-api (harness_shape)", async () => {
  // 16 §7.7.2: the module shape is harness_shape for React now; default_export_wrong_name is no longer emitted.
  const report = await validateB({
    harnessSource: replaceOnce(
      PANEL_HARNESS,
      "export default definePrvisionHarness({",
      "export default defineHarness({"
    )
  });
  assertError(report, "harness_shape");
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.message === "Default-export definePrvisionHarness({ wrapper?, states }) imported from '../harness-api'."
    )
  );
  assert.equal(report.states, null);
});

test("rejects a useAuth mock without export function useAuth (mock_missing_export)", async () => {
  const source = replaceOnce(
    USE_AUTH_MOCK,
    "export function useAuth(): typeof AUTH_STATE {",
    "function useAuthLocal(): typeof AUTH_STATE {"
  );
  const report = await validateB({
    mockedModules: withMock("@/api/orders", ORDERS_MOCK).map((m, i) => (i === 0 ? { ...m, source } : m))
  });
  assertError(report, "mock_missing_export");
  assert.ok(
    report.errors.some(
      (issue) =>
        issue.message === `Mock "@/hooks/useAuth" must export: useAuth (imported by ${PANEL}).` &&
        issue.location === "mock @/hooks/useAuth"
    )
  );
});

test("rejects two mocks with specifier @/api/orders (mock_duplicate_specifier)", async () => {
  const report = await validateB({
    mockedModules: [
      { specifier: "@/hooks/useAuth", source: USE_AUTH_MOCK },
      { specifier: "@/api/orders", source: ORDERS_MOCK },
      { specifier: "@/api/orders", source: ORDERS_MOCK }
    ]
  });
  assertError(report, "mock_duplicate_specifier");
});

test("rejects a mock of ./OrdersPanel.css (mock_forbidden_specifier)", async () => {
  const report = await validateB({ mockedModules: withMock("./OrdersPanel.css", "export default {};") });
  assertError(report, "mock_forbidden_specifier");
});

test("rejects fetch in the fetchOrders mock (network_api)", async () => {
  const source = replaceOnce(
    ORDERS_MOCK,
    "  return ORDERS_PAGE;\n}",
    '  await fetch("/api/orders");\n  return ORDERS_PAGE;\n}'
  );
  const report = await validateB({ mockedModules: withMock("@/api/orders", source) });
  assertError(report, "network_api");
  assert.ok(report.errors.some((issue) => issue.location?.startsWith("mock @/api/orders:") === true));
});

test("rejects new Date() in a fixture (nondeterministic_api)", async () => {
  const report = await validateB({
    harnessSource: replaceOnce(PANEL_HARNESS, 'placedAt: "2024-03-11T14:20:00Z"', "placedAt: new Date().toISOString()")
  });
  assertError(report, "nondeterministic_api");
});

test("rejects a harness importing @testing-library/react (forbidden_import)", async () => {
  const report = await validateB({
    harnessSource: `import { render } from "@testing-library/react";\n${PANEL_HARNESS}`
  });
  assertError(report, "forbidden_import");
});

test("rejects a mock importing ./does-not-exist (mock_import_unresolved)", async () => {
  const source = `import { helper } from "./does-not-exist";\n${ORDERS_MOCK}\nexport const extra = helper;`;
  const report = await validateB({ mockedModules: withMock("@/api/orders", source) });
  assertError(report, "mock_import_unresolved");
});

test("accepts a partial @/api/orders mock that re-exports its own specifier and overrides fetchOrders", async () => {
  const source = [
    'export * from "@/api/orders";',
    "export async function fetchOrders(): Promise<{ customerName: string; total: number; items: never[] }> {",
    '  return { customerName: "Northwind Traders", total: 0, items: [] };',
    "}"
  ].join("\n");
  const report = await validateB({ mockedModules: withMock("@/api/orders", source) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test("warns on a harness wrapper with className (harness_class_name)", async () => {
  const report = await validateB({
    harnessSource: replaceOnce(PANEL_HARNESS, "<div style={{ padding: 24, width: 1024 }}>", '<div className="p-6">')
  });
  assert.equal(report.ok, true);
  assert.deepEqual(warningCodes(report), ["harness_class_name"]);
});

test("rejects a harness importing the entry file ../../src/main (entry_import)", async () => {
  const report = await validateB({ harnessSource: `import "../../src/main";\n${PANEL_HARNESS}` });
  assertError(report, "entry_import");
  assert.ok(report.errors.some((issue) => issue.message.includes("src/main.tsx")));
});

test("rejects mocks of react-dom/client and ./logo.svg?react (mock_forbidden_specifier)", async () => {
  for (const specifier of ["react-dom/client", "./logo.svg?react"]) {
    const report = await validateB({ mockedModules: withMock(specifier, "export const x = 1;") });
    assertError(report, "mock_forbidden_specifier");
  }
});

test("rejects a harness importing ../../src/index.css (style_import)", async () => {
  const report = await validateB({ harnessSource: `import "../../src/index.css";\n${PANEL_HARNESS}` });
  assertError(report, "style_import");
});

test("accepts the string fetch( inside a JSX text node (AST, not regex)", async () => {
  const harness = replaceOnce(
    harnessFixture("button/harness.tsx"),
    "Save changes</Button>",
    'Call fetch("/api") and Date.now() later</Button>'
  );
  const report = await validateA({ harnessSource: `// fetch("/x"); Math.random()\n${harness}` });
  assert.deepEqual(report.errors, []);
});

// ---- further cases (09 §9) ----

test("accepts a state render that is the identifier of a top-level const arrow function", async () => {
  const harness = replaceOnce(
    replaceOnce(
      harnessFixture("button/harness.tsx"),
      "function ButtonShowcase(): ReactElement {",
      "const ButtonShowcase = (): ReactElement => {"
    ),
    "  );\n}\n\nexport default",
    "  );\n};\n\nexport default"
  );
  const report = await validateA({ harnessSource: harness });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.states, [{ name: "Default", steps: [] }]);
});

test("rejects default exports other than definePrvisionHarness({...}) and a missing default export (harness_shape)", async () => {
  const fixture = harnessFixture("button/harness.tsx");
  const call = 'export default definePrvisionHarness({\n  states: [{ name: "Default", render: ButtonShowcase }],\n});';
  for (const replacement of [
    "export default function () {\n  return ButtonShowcase();\n}",
    "const Inner = function () {\n  return ButtonShowcase();\n};\nexport default () => Inner();",
    'const harness = definePrvisionHarness({ states: [{ name: "Default", render: ButtonShowcase }] });\nexport default harness;',
    'const harness = definePrvisionHarness({ states: [{ name: "Default", render: ButtonShowcase }] });'
  ]) {
    const report = await validateA({ harnessSource: replaceOnce(fixture, call, replacement) });
    assertError(report, "harness_shape");
  }
});

test("rejects the legacy PRVisionHarness shape for new harnesses (harness_shape)", async () => {
  const legacy = replaceOnce(
    harnessFixture("button/harness.tsx"),
    'export default definePrvisionHarness({\n  states: [{ name: "Default", render: ButtonShowcase }],\n});',
    "export default ButtonShowcase;"
  )
    .replace(/function ButtonShowcase/g, "function PRVisionHarness")
    .replace("export default ButtonShowcase;", "export default PRVisionHarness;");
  const report = await validateA({ harnessSource: legacy });
  assertError(report, "harness_shape");
  assert.ok(!codes(report).includes("default_export_wrong_name"));
});

test("rejects createRoot usage", async () => {
  const harness = `import { createRoot } from "react-dom/client";\nimport ReactDOM from "react-dom";\n${harnessFixture("button/harness.tsx")}\ncreateRoot(document.body);\nReactDOM.render(null, document.body);\ndocument.title = "x";\nwindow.addEventListener("resize", () => {});\nconst later = import("./x");\neval("1");`;
  const report = await validateA({ harnessSource: harness });
  const forbidden = report.errors.filter((issue) => issue.code === "forbidden_api");
  assert.equal(forbidden.length, 6, JSON.stringify(forbidden));
  assert.ok(forbidden[0]?.message.includes("createRoot"));
});

test("rejects relative harness import missing on base for modified component", async () => {
  const harness = `import { Spinner } from "../../src/components/Spinner/Spinner";\n${harnessFixture("button/harness.tsx")}\nexport const s = Spinner;`;
  const report = await validateA({ harnessSource: harness });
  assertError(report, "relative_import_unresolved");
  const issue = report.errors.find((e) => e.code === "relative_import_unresolved");
  assert.ok(issue?.message.includes("base side"));
  assert.equal(report.errors.length, 1, "resolves on head");
});

test("rejects relative import escaping worktree", async () => {
  for (const specifier of ["../../../outside", "../../node_modules/react/index"]) {
    const report = await validateA({
      harnessSource: `import "${specifier}";\n${harnessFixture("button/harness.tsx")}`
    });
    assertError(report, "relative_import_outside_worktree");
  }
});

test("rejects imports of the render page's own .prvision-harness files (forbidden_import)", async () => {
  // 16 §7.7.3: only definePrvisionHarness (and its types) may come from ../harness-api; every other page file,
  // another harness included, is forbidden.
  for (const statement of [
    'import { installStepBridge } from "../prvision-steps";',
    'import type { Step } from "../prvision-steps";',
    'import "../entry";',
    'import "./other-harness";',
    'import { definePrvisionHarness as d, PrvisionStepKey } from "../harness-api";',
    'import * as api from "../harness-api";'
  ]) {
    const report = await validateA({ harnessSource: `${statement}\n${harnessFixture("button/harness.tsx")}` });
    assertError(report, "forbidden_import");
    assert.ok(!codes(report).includes("relative_import_outside_worktree"), statement);
  }
  const typeImport = await validateA({
    harnessSource: `import type { PrvisionStep } from "../harness-api";\n${harnessFixture("button/harness.tsx")}`
  });
  assert.deepEqual(typeImport.errors, []);
});

test("warns on setTimeout", async () => {
  const report = await validateA({
    harnessSource: `${harnessFixture("button/harness.tsx")}\nsetTimeout(() => undefined, 10);\nrequestAnimationFrame(() => undefined);`
  });
  assert.equal(report.ok, true);
  assert.deepEqual(warningCodes(report), ["timer_usage", "timer_usage"]);
});

test("warns on incomplete mock exports vs real module", async () => {
  const source = replaceOnce(USE_AUTH_MOCK, "export function AuthProvider(", "function AuthProvider(");
  const report = await validateB({
    mockedModules: [
      { specifier: "@/hooks/useAuth", source },
      { specifier: "@/api/orders", source: ORDERS_MOCK }
    ]
  });
  assert.equal(report.ok, true);
  assert.deepEqual(warningCodes(report), ["mock_export_incomplete"]);
  assert.ok(report.warnings[0]?.message.includes("AuthProvider"));
});

test("skips parity with warning for namespace imports", async () => {
  const imports = PANEL_COMMON_IMPORTS.map((entry) =>
    entry.specifier === "@/api/orders" ? { ...entry, namespaceImport: true, namedImports: [] } : entry
  );
  const report = await validateB({
    directImports: { base: imports, head: imports },
    mockedModules: withMock("@/api/orders", "export const somethingElse = 1;")
  });
  assert.ok(warningCodes(report).includes("namespace_import_parity_skipped"));
  assert.ok(!codes(report).includes("mock_missing_export"));
});

test("enforces size and mock count limits", async () => {
  const big = await validateA({ harnessSource: `${harnessFixture("button/harness.tsx")}\n// ${"x".repeat(40_000)}` });
  assertError(big, "size_limit");
  const many = await validateB({
    mockedModules: Array.from({ length: 16 }, (_, index) => ({ specifier: `@/m${index}`, source: "export {};" }))
  });
  assertError(many, "too_many_mocks");
  const bigMock = await validateB({
    mockedModules: withMock("@/api/orders", `${ORDERS_MOCK}\n// ${"y".repeat(20_000)}`)
  });
  assertError(bigMock, "size_limit");
  assert.ok(bigMock.errors.some((issue) => issue.location === "mock @/api/orders"));
});

test("rejects every mock that 10's validateMockedModules rejects with the same reason", async () => {
  const cases: Array<Array<{ specifier: string; source: string }>> = [
    [{ specifier: "", source: "export {};" }],
    [{ specifier: "   ", source: "export {};" }],
    [{ specifier: "@/a b", source: "export {};" }],
    [{ specifier: "@/api/orders?raw", source: "export {};" }],
    [{ specifier: "./theme.scss", source: "export {};" }],
    [{ specifier: "./data.json", source: "export {};" }],
    [{ specifier: "react", source: "export {};" }],
    [{ specifier: "react/jsx-runtime", source: "export {};" }],
    [{ specifier: "scheduler", source: "export {};" }],
    [{ specifier: "@/api/orders", source: "   " }],
    [{ specifier: "@/api/orders", source: `export {}; // ${"z".repeat(200_000)}` }],
    [
      { specifier: "@/api/orders", source: ORDERS_MOCK },
      { specifier: "@/api/orders", source: ORDERS_MOCK }
    ]
  ];
  for (const mocks of cases) {
    const expected = validateMockedModules(mocks).rejected;
    assert.equal(expected.length, 1);
    const rejected = expected[0];
    assert.ok(rejected);
    const report = await validateB({ mockedModules: mocks });
    const code: HarnessIssueCode = rejected.duplicate ? "mock_duplicate_specifier" : "mock_forbidden_specifier";
    assert.ok(
      report.errors.some((issue) => issue.code === code && issue.message.includes(rejected.reason)),
      `${JSON.stringify(mocks[0]?.specifier)}: ${JSON.stringify(report.errors)}`
    );
  }
  // 09-only checks on top of 10's rules
  for (const specifier of [
    "/src/api/orders.ts",
    "file:///x",
    "https://cdn.example.com/x.js",
    "data:text/javascript,1",
    `@/${"a".repeat(200)}`,
    "../../src/features/orders/OrdersPanel",
    "./OrdersPanel"
  ]) {
    const report = await validateB({
      mockedModules: withMock(specifier, "export default function X() { return null; }")
    });
    assertError(report, "mock_forbidden_specifier");
  }
  const unresolvable = await validateB({ mockedModules: withMock("not-installed-package", "export const a = 1;") });
  assertError(unresolvable, "mock_unresolvable_specifier");
});

test("accepts a partial mock that re-exports its own specifier", async () => {
  const source =
    'import { fetchOrder } from "@/api/orders";\nexport * from "@/api/orders";\nexport const fetchOrders = async () => fetchOrder("ord_1");';
  const report = await validateB({ mockedModules: withMock("@/api/orders", source) });
  assert.deepEqual(report.errors, []);
});

test("checks relative mock imports from the component file on every present side", async () => {
  const source = `import { OrderStatusBadge } from "./OrderStatusBadge";\n${ORDERS_MOCK}\nexport const badge = OrderStatusBadge;`;
  const modified = await validateB({ mockedModules: withMock("@/api/orders", source) });
  assertError(modified, "mock_import_unresolved");
  assert.ok(modified.errors.some((issue) => issue.message.includes("base side")));

  const added = await validateB({
    mockedModules: withMock("@/api/orders", source),
    paths: { base: null, head: PANEL },
    sidesPresent: { base: false, head: true }
  });
  assert.deepEqual(added.errors, []);
});

test("uses the base path for base-side checks of a renamed component", async () => {
  const basePath = "src/legacy/OrdersTable.tsx";
  const { validator, queries } = makeValidator({
    base: [...PANEL_FILES.base.filter((file) => file !== PANEL), basePath, "src/legacy/theme.ts"],
    head: [...PANEL_FILES.head, "src/features/orders/theme.ts"]
  });
  const source = `import { theme } from "./theme";\n${ORDERS_MOCK}\nexport const t = theme;`;
  const report = await validator.validate(
    exampleB({ paths: { base: basePath, head: PANEL }, mockedModules: withMock("@/api/orders", source) })
  );
  assert.deepEqual(report.errors, []);
  const resolutions = queries.callsTo("resolveSpecifier");
  assert.ok(resolutions.some((args) => args[0] === basePath && args[1] === "./theme" && args[2] === "base"));
  assert.ok(resolutions.some((args) => args[0] === PANEL && args[1] === "./theme" && args[2] === "head"));
  assert.ok(!resolutions.some((args) => args[0] === PANEL && args[2] === "base"));
});
