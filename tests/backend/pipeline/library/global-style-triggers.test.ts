import assert from "node:assert/strict";
import { test } from "node:test";
import { GLOBAL_STYLE_TRIGGER_PATTERNS } from "../../../../backend/src/config-consts";
import {
  appLevelFolders,
  detectGlobalStyleTriggers,
  GLOBAL_STYLE_TRIGGER_LABELS,
  type GlobalStyleTriggerInput,
  type GlobalStyleTriggerReason
} from "../../../../backend/src/services/visualizations/pipeline/global-style-triggers";

const REACT: Omit<GlobalStyleTriggerInput, "changedFiles"> = {
  framework: "react_vite",
  appRoot: ".",
  viteConfigPath: "vite.config.ts",
  globalStylePaths: ["/src/index.css"],
  globalStyleChanges: []
};
const ANGULAR: Omit<GlobalStyleTriggerInput, "changedFiles"> = {
  framework: "angular",
  appRoot: "apps/web",
  viteConfigPath: null,
  globalStylePaths: [],
  globalStyleChanges: ["apps/web/src/styles.css"]
};

interface Row {
  name: string;
  base: Omit<GlobalStyleTriggerInput, "changedFiles">;
  path: string;
  status?: "A" | "M" | "D";
  expected: GlobalStyleTriggerReason | null;
}

const ROWS: Row[] = [
  // global_stylesheet
  { name: "repository globalStylePaths entry", base: REACT, path: "src/index.css", expected: "global_stylesheet" },
  {
    name: "analysis globalStyleChanges entry",
    base: ANGULAR,
    path: "apps/web/src/styles.css",
    expected: "global_stylesheet"
  },
  { name: "a component stylesheet is not global", base: REACT, path: "src/components/Button.css", expected: null },
  { name: "deleted global stylesheet", base: REACT, path: "src/index.css", status: "D", expected: "global_stylesheet" },
  // tailwind_config
  { name: "tailwind.config.js at the root", base: REACT, path: "tailwind.config.js", expected: "tailwind_config" },
  { name: "tailwind.config.mts at the root", base: REACT, path: "tailwind.config.mts", expected: "tailwind_config" },
  {
    name: "tailwind config in the app root (sub-folder)",
    base: ANGULAR,
    path: "apps/web/tailwind.config.js",
    expected: "tailwind_config"
  },
  {
    name: "tailwind config in a folder between root and app root",
    base: ANGULAR,
    path: "apps/tailwind.config.ts",
    expected: "tailwind_config"
  },
  { name: "tailwind config of a sibling app", base: ANGULAR, path: "apps/admin/tailwind.config.js", expected: null },
  { name: "tailwind config below the app root", base: REACT, path: "src/tailwind.config.js", expected: null },
  // postcss_config
  { name: "postcss.config.cjs", base: REACT, path: "postcss.config.cjs", expected: "postcss_config" },
  {
    name: "postcss.config.json in the app root",
    base: ANGULAR,
    path: "apps/web/postcss.config.json",
    expected: "postcss_config"
  },
  { name: ".postcssrc", base: REACT, path: ".postcssrc", expected: "postcss_config" },
  { name: ".postcssrc.yml", base: ANGULAR, path: ".postcssrc.yml", expected: "postcss_config" },
  // design_tokens
  { name: "tokens.css", base: REACT, path: "src/styles/tokens.css", expected: "design_tokens" },
  { name: "design-tokens.json", base: REACT, path: "design-tokens.json", expected: "design_tokens" },
  { name: "design-tokens.ts", base: REACT, path: "src/design-tokens.ts", expected: "design_tokens" },
  { name: "_variables.scss", base: REACT, path: "src/styles/_variables.scss", expected: "design_tokens" },
  { name: "theme.less", base: ANGULAR, path: "apps/web/src/theme.less", expected: "design_tokens" },
  { name: "JSON below a tokens folder", base: REACT, path: "src/tokens/colors.json", expected: "design_tokens" },
  {
    name: "stylesheet below a design-tokens folder",
    base: ANGULAR,
    path: "apps/web/src/design-tokens/spacing.scss",
    expected: "design_tokens"
  },
  { name: "Angular DI tokens.ts is not a trigger", base: ANGULAR, path: "apps/web/src/app/tokens.ts", expected: null },
  { name: "src/app/tokens.ts (React) is not a trigger", base: REACT, path: "src/app/tokens.ts", expected: null },
  { name: "a script below a tokens folder is not a trigger", base: REACT, path: "src/tokens/index.ts", expected: null },
  { name: "tokens outside the app root", base: ANGULAR, path: "libs/ui/tokens.css", expected: null },
  // index_html
  { name: "React index.html in the Vite root", base: REACT, path: "index.html", expected: "index_html" },
  {
    name: "React index.html in a sub-folder Vite root",
    base: { ...REACT, viteConfigPath: "web/vite.config.ts" },
    path: "web/index.html",
    expected: "index_html"
  },
  {
    name: "React root index.html when the Vite root is a sub-folder",
    base: { ...REACT, viteConfigPath: "web/vite.config.ts" },
    path: "index.html",
    expected: null
  },
  {
    name: "React index.html in the app root without a Vite config path",
    base: { ...REACT, appRoot: "packages/app", viteConfigPath: null },
    path: "packages/app/index.html",
    expected: "index_html"
  },
  { name: "React public/index.html", base: REACT, path: "public/index.html", expected: null },
  { name: "Angular src/index.html", base: ANGULAR, path: "apps/web/src/index.html", expected: "index_html" },
  { name: "Angular index.html in the app root", base: ANGULAR, path: "apps/web/index.html", expected: "index_html" },
  // angular_workspace
  {
    name: "angular.json in the app root (Angular)",
    base: ANGULAR,
    path: "apps/web/angular.json",
    expected: "angular_workspace"
  },
  {
    name: "angular.json at the root of a root-level Angular app",
    base: { ...ANGULAR, appRoot: "." },
    path: "angular.json",
    expected: "angular_workspace"
  },
  { name: "angular.json is not a trigger for React", base: REACT, path: "angular.json", expected: null },
  // unrelated
  { name: "a component file", base: REACT, path: "src/components/Card.tsx", expected: null },
  { name: "package.json", base: REACT, path: "package.json", expected: null }
];

for (const row of ROWS) {
  test(`detectGlobalStyleTriggers: ${row.name}`, () => {
    const triggers = detectGlobalStyleTriggers({
      ...row.base,
      changedFiles: [{ path: row.path, status: row.status ?? "M" }]
    });
    assert.deepEqual(triggers, row.expected === null ? [] : [{ path: row.path, reason: row.expected }]);
  });
}

test("detectGlobalStyleTriggers: a rename triggers through either path and lists both", () => {
  const fromTokens = detectGlobalStyleTriggers({
    ...REACT,
    changedFiles: [{ path: "src/styles/palette.css", status: "R", previousPath: "src/styles/tokens.css" }]
  });
  assert.deepEqual(fromTokens, [{ path: "src/styles/tokens.css", reason: "design_tokens" }]);
  const both = detectGlobalStyleTriggers({
    ...REACT,
    changedFiles: [{ path: "tailwind.config.ts", status: "R", previousPath: "tailwind.config.js" }]
  });
  assert.deepEqual(both, [
    { path: "tailwind.config.js", reason: "tailwind_config" },
    { path: "tailwind.config.ts", reason: "tailwind_config" }
  ]);
});

test("detectGlobalStyleTriggers: sorted by path, one trigger per path, [] without triggers", () => {
  const triggers = detectGlobalStyleTriggers({
    ...REACT,
    changedFiles: [
      { path: "tailwind.config.js", status: "M" },
      { path: "src/index.css", status: "M" },
      { path: "index.html", status: "A" },
      { path: "src/components/Card.tsx", status: "M" }
    ]
  });
  assert.deepEqual(
    triggers.map((trigger) => trigger.path),
    ["index.html", "src/index.css", "tailwind.config.js"]
  );
  assert.deepEqual(detectGlobalStyleTriggers({ ...REACT, changedFiles: [] }), []);
});

test("appLevelFolders: the repository root, every folder between and the app root", () => {
  assert.deepEqual(appLevelFolders("."), [""]);
  assert.deepEqual(appLevelFolders("apps/web"), ["", "apps", "apps/web"]);
  assert.deepEqual(appLevelFolders("./apps/web/"), ["", "apps", "apps/web"]);
});

test("GLOBAL_STYLE_TRIGGER_LABELS: the console labels of 16 §8.5.4; patterns come from the shared constant", () => {
  assert.deepEqual(Object.values(GLOBAL_STYLE_TRIGGER_LABELS), [
    "global stylesheet",
    "Tailwind config",
    "PostCSS config",
    "design tokens",
    "index.html",
    "angular.json"
  ]);
  assert.equal(GLOBAL_STYLE_TRIGGER_PATTERNS.tokenFolders.length, 2);
});
