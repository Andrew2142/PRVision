import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ComponentInventoryService,
  computeLayers,
  orderSmallestFirst,
  type InventoryNode,
  type InventoryRequest
} from "../../../backend/src/services/harness-library/component-inventory";
import { makeTempDir } from "../helpers/temp-dir";
import { writeTree, type FileMap } from "../pipeline/change-analysis/helpers/worktree-fixture";

async function tree(t: TestContext, files: FileMap): Promise<string> {
  const temp = makeTempDir("inventory");
  t.after(() => {
    temp.cleanup();
  });
  await writeTree(temp.path, files);
  return temp.path;
}

function request(rootDir: string, overrides: Partial<InventoryRequest> = {}): InventoryRequest {
  return {
    framework: "react_vite",
    rootDir,
    appRoot: ".",
    tsconfigPath: null,
    viteConfigPath: null,
    angularProject: null,
    signal: new AbortController().signal,
    ...overrides
  };
}

const REACT_APP: FileMap = {
  "package.json": '{ "name": "app" }',
  "src/components/Button.tsx":
    "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n",
  "src/components/Badge.tsx": 'export const Badge = () => <span className="badge">New</span>;\n',
  "src/components/Card.tsx":
    'import { Button } from "./Button";\nimport { Badge } from "./Badge";\nexport default function Card() {\n  return (\n    <div>\n      <Badge />\n      <Button label="Open" />\n    </div>\n  );\n}\n',
  "src/pages/Dashboard.tsx":
    'import Card from "../components/Card";\nexport default function Dashboard() {\n  return <main><Card /><Card /></main>;\n}\n',
  "src/App.tsx":
    'import Dashboard from "./pages/Dashboard";\nexport default function App() {\n  return <Dashboard />;\n}\n',
  "src/main.tsx": 'import App from "./App";\nconsole.log(App);\n',
  "src/components/Button.stories.tsx":
    'import { Button } from "./Button";\nexport const Primary = () => <Button label="x" />;\nexport default { title: "Button" };\n',
  "src/components/Button.test.tsx":
    'import { Button } from "./Button";\nexport function Wrapper() { return <Button label="t" />; }\n',
  "src/generated/Icon.tsx": "export function Icon() { return <svg />; }\n",
  "src/components/Pair.tsx":
    "export function PairLeft() { return <i>L</i>; }\nexport function PairRight() { return <i>R</i>; }\n"
};

test("ComponentInventoryService.inventory orders a React app smallest first (Button, Badge before Card before Dashboard before App)", async (t) => {
  const root = await tree(t, REACT_APP);
  const inventory = await new ComponentInventoryService().inventory(request(root));
  assert.equal(inventory.truncated, false);
  const names = inventory.components.map((component) => component.displayName);
  for (const [before, after] of [
    ["Button", "Card"],
    ["Badge", "Card"],
    ["Card", "Dashboard"],
    ["Dashboard", "App"]
  ]) {
    assert.ok(
      names.indexOf(before ?? "") < names.indexOf(after ?? ""),
      `${String(before)} before ${String(after)}: ${names.join(", ")}`
    );
  }
  const card = inventory.components.find((component) => component.displayName === "Card");
  assert.ok(card);
  assert.match(card.sourceFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.ok(card.sourceLines > 3);
  assert.deepEqual(card.identity, { filePath: "src/components/Card.tsx", exportName: "default" });
  assert.equal(card.childCount, 2);
  assert.equal(card.layer, 1);
  assert.equal(inventory.components.find((component) => component.displayName === "App")?.layer, 3);
});

test("ComponentInventoryService.inventory excludes stories, tests and generated files and keeps two components of one file", async (t) => {
  const root = await tree(t, REACT_APP);
  const inventory = await new ComponentInventoryService().inventory(request(root));
  const paths = inventory.components.map(
    (component) => `${component.identity.filePath}#${component.identity.exportName}`
  );
  assert.ok(
    !paths.some((entry) => entry.includes(".stories.") || entry.includes(".test.") || entry.includes("generated/"))
  );
  assert.ok(paths.includes("src/components/Pair.tsx#PairLeft"));
  assert.ok(paths.includes("src/components/Pair.tsx#PairRight"));
});

test("ComponentInventoryService.inventory without fingerprints (estimates) leaves them null", async (t) => {
  const root = await tree(t, REACT_APP);
  const inventory = await new ComponentInventoryService().inventory(request(root, { withFingerprints: false }));
  assert.ok(inventory.components.length > 0);
  assert.ok(inventory.components.every((component) => component.sourceFingerprint === null));
});

test("ComponentInventoryService.inventory truncates above maxComponents with the warning", async (t) => {
  const root = await tree(t, REACT_APP);
  const inventory = await new ComponentInventoryService().inventory(request(root, { maxComponents: 3 }));
  assert.equal(inventory.components.length, 3);
  assert.equal(inventory.truncated, true);
  assert.deepEqual(inventory.warnings, [
    "More than 3 components found; the library covers the first 3 (smallest first)."
  ]);
});

test("ComponentInventoryService.inventory collapses import cycles into one layer", async (t) => {
  const root = await tree(t, {
    "src/A.tsx": 'import { B } from "./B";\nexport function A() { return <B />; }\n',
    "src/B.tsx": 'import { A } from "./A";\nexport function B() { return <A />; }\n',
    "src/Leaf.tsx": "export function Leaf() { return <b />; }\n",
    "src/Top.tsx":
      'import { A } from "./A";\nimport { Leaf } from "./Leaf";\nexport function Top() { return <div><A /><Leaf /></div>; }\n'
  });
  const inventory = await new ComponentInventoryService().inventory(request(root));
  const layer = (name: string): number | undefined =>
    inventory.components.find((component) => component.displayName === name)?.layer;
  assert.equal(layer("A"), layer("B"));
  assert.equal(layer("A"), 0, "a cycle without other children is a building block");
  assert.equal(layer("Top"), 1);
});

test("ComponentInventoryService.inventory reads an Angular layout and uses selector usage for children", async (t) => {
  const component = (name: string, selector: string, template: string, imports = ""): string =>
    `import { Component } from '@angular/core';\n${imports}\n@Component({ selector: '${selector}', standalone: true, template: \`${template}\` })\nexport class ${name} {}\n`;
  const root = await tree(t, {
    "package.json": '{ "dependencies": { "@angular/core": "19.0.0" } }',
    "src/app/badge.component.ts": component("BadgeComponent", "app-badge", "<span>New</span>"),
    "src/app/card.component.ts": component(
      "CardComponent",
      "app-card",
      "<div><app-badge></app-badge></div>",
      "import { BadgeComponent } from './badge.component';"
    ),
    "src/app/page.component.ts": component(
      "PageComponent",
      "app-page",
      "<app-card></app-card><app-card></app-card>",
      "import { CardComponent } from './card.component';"
    ),
    "src/app/page.component.spec.ts": component("SpecHostComponent", "spec-host", "<app-page></app-page>")
  });
  const inventory = await new ComponentInventoryService().inventory(request(root, { framework: "angular" }));
  assert.deepEqual(
    inventory.components.map((entry) => [entry.displayName, entry.selector, entry.layer]),
    [
      ["BadgeComponent", "app-badge", 0],
      ["CardComponent", "app-card", 1],
      ["PageComponent", "app-page", 2]
    ]
  );
  const badge = inventory.components[0];
  assert.ok(badge);
  assert.match(badge.sourceFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.equal(badge.identity.exportName, "BadgeComponent");
});

// ---- orderSmallestFirst (16 §8.3.3) ----

function node(key: string, children: string[] = [], sourceLines = 10, exportName = key): InventoryNode {
  return { key, children, sourceLines, filePath: `src/${key}.tsx`, exportName };
}

test("orderSmallestFirst: layer, then child count, then source lines, then path, then export (default first)", () => {
  const cases: Array<{ name: string; nodes: InventoryNode[]; expected: string[] }> = [
    {
      name: "layers",
      nodes: [node("Page", ["Card"]), node("Card", ["Button"]), node("Button")],
      expected: ["Button", "Card", "Page"]
    },
    {
      name: "child count within a layer",
      nodes: [node("Two", ["A", "B"]), node("One", ["A"]), node("A"), node("B")],
      expected: ["A", "B", "One", "Two"]
    },
    { name: "source lines", nodes: [node("Big", [], 200), node("Small", [], 5)], expected: ["Small", "Big"] },
    {
      name: "path then export with default first",
      nodes: [
        { key: "x2", children: [], sourceLines: 1, filePath: "src/X.tsx", exportName: "Alpha" },
        { key: "x1", children: [], sourceLines: 1, filePath: "src/X.tsx", exportName: "default" },
        { key: "a", children: [], sourceLines: 1, filePath: "src/A.tsx", exportName: "Zed" }
      ],
      expected: ["a", "x1", "x2"]
    },
    {
      name: "unknown children are ignored",
      nodes: [node("A", ["Ghost"]), node("B")],
      expected: ["A", "B"]
    }
  ];
  for (const { name, nodes, expected } of cases) {
    assert.deepEqual(orderSmallestFirst(nodes), expected, name);
  }
});

test("computeLayers: cycles share a layer and layers are capped at 50", () => {
  const cycle = computeLayers([node("A", ["B"]), node("B", ["A"]), node("Top", ["A"])]);
  assert.equal(cycle.get("A")?.layer, 0);
  assert.equal(cycle.get("B")?.layer, 0);
  assert.equal(cycle.get("Top")?.layer, 1);
  assert.equal(cycle.get("Top")?.childCount, 1);
  const chain: InventoryNode[] = Array.from({ length: 60 }, (_, index) =>
    node(`N${String(index)}`, index === 0 ? [] : [`N${String(index - 1)}`])
  );
  assert.equal(computeLayers(chain).get("N59")?.layer, 50);
});
