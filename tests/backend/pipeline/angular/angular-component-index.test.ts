import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  AngularComponentIndex,
  classifyAngularPath,
  fallbackAngularWorkspaceLayout,
  readAngularWorkspaceLayout,
  type AngularWorkspaceLayout
} from "../../../../backend/src/services/visualizations/pipeline/angular/angular-component-index";
import { makeWorktrees, type FileMap } from "../change-analysis/helpers/worktree-fixture";
import { APP, APP_DIR, MAIN_FILES, SRC, withChanges } from "./helpers/angular-analysis-fixture";

async function buildIndex(
  t: TestContext,
  files: FileMap,
  options: { maxFiles?: number; priorityPaths?: string[] } = {}
): Promise<AngularComponentIndex> {
  const wt = await makeWorktrees({ base: {}, head: files });
  t.after(() => wt.cleanup());
  return AngularComponentIndex.build({
    side: "head",
    rootDir: wt.headDir,
    sourceRoot: SRC,
    appRoot: APP,
    maxFiles: options.maxFiles ?? 3000,
    maxFileBytes: 512 * 1024,
    priorityPaths: options.priorityPaths ?? [],
    angularMajor: 21,
    signal: new AbortController().signal,
    now: Date.now
  });
}

test("AngularComponentIndex.build maps templateUrl, styleUrl and styleUrls files to their owners", async (t) => {
  const index = await buildIndex(t, MAIN_FILES);
  assert.deepEqual(index.templateOwnersOf(`${APP_DIR}/shared/badge/badge.component.html`), [
    `${APP_DIR}/shared/badge/badge.component.ts#BadgeComponent`
  ]);
  assert.deepEqual(index.styleOwnersOf(`${APP_DIR}/shared/badge/badge.component.css`), [
    `${APP_DIR}/shared/badge/badge.component.ts#BadgeComponent`
  ]);
  assert.deepEqual(index.styleOwnersOf(`${APP_DIR}/orders/order-list/order-list.component.scss`), [
    `${APP_DIR}/orders/order-list/order-list.component.ts#OrderListComponent`
  ]);
  assert.equal(index.stats.components, 7);
  assert.equal(index.stats.templates, 7);
});

test("AngularComponentIndex.build records selector, pipe and NgModule usage", async (t) => {
  const index = await buildIndex(t, MAIN_FILES);
  const orderList = `${APP_DIR}/orders/order-list/order-list.component.ts#OrderListComponent`;
  assert.deepEqual(
    index.usagesOf(`${APP_DIR}/shared/badge/badge.component.ts#BadgeComponent`).map((u) => [u.ownerKey, u.line]),
    [[orderList, 4]]
  );
  assert.deepEqual(index.pipeUsersOf("money"), [orderList]);
  assert.deepEqual(
    index.usagesOf(`${APP_DIR}/shared/directives/highlight.directive.ts#HighlightDirective`).map((u) => u.ownerKey),
    [orderList]
  );
  assert.equal(
    index.declaringModuleOf(`${APP_DIR}/shared/legacy-chip/legacy-chip.component.ts#LegacyChipComponent`),
    `${APP_DIR}/shared/legacy-chip/legacy-chip.module.ts#LegacyChipModule`
  );
  assert.equal(index.usageCount(`${APP_DIR}/app.component.ts#AppComponent`), 0);
});

test("AngularComponentIndex.partialOwners follows SCSS partial chains up to depth 3", async (t) => {
  const styles = `${APP_DIR}/styles`;
  const files = withChanges({
    [`${styles}/_a.scss`]: '@use "b";\n',
    [`${styles}/_b.scss`]: '@forward "./c";\n',
    [`${styles}/_c.scss`]: '@import "d.scss";\n',
    [`${styles}/_d.scss`]: "$x: 1;\n",
    [`${APP_DIR}/orders/order-list/order-list.component.scss`]: '@use "../../styles/a";\n'
  });
  const index = await buildIndex(t, files);
  const owner = `${APP_DIR}/orders/order-list/order-list.component.ts#OrderListComponent`;
  assert.deepEqual(index.partialOwners(`${styles}/_b.scss`), [
    { key: owner, via: `${APP_DIR}/orders/order-list/order-list.component.scss`, depth: 2 }
  ]);
  assert.deepEqual(index.partialOwners(`${styles}/_c.scss`), [
    { key: owner, via: `${APP_DIR}/orders/order-list/order-list.component.scss`, depth: 3 }
  ]);
  assert.deepEqual(index.partialOwners(`${styles}/_d.scss`), [], "depth 4 is out of reach");
  assert.deepEqual([...index.styleClosure([`${SRC}/styles.css`])].sort(), [
    `${SRC}/styles.css`,
    `${SRC}/styles/base.css`
  ]);
});

test("AngularComponentIndex.build truncates at the file cap and keeps priority paths", async (t) => {
  const priority = `${APP_DIR}/shared/badge/badge.component.ts`;
  const index = await buildIndex(t, MAIN_FILES, { maxFiles: 3, priorityPaths: [priority] });
  assert.equal(index.truncated, true);
  assert.equal(index.files().length, 3);
  assert.ok(index.totalFiles > 3);
  assert.ok(index.hasFile(priority));
  assert.ok(index.findComponent(priority, "BadgeComponent") !== null);
});

test("readAngularWorkspaceLayout reads the source root, index, global styles and config files", async (t) => {
  const wt = await makeWorktrees({ base: {}, head: MAIN_FILES });
  t.after(() => wt.cleanup());
  const layout = await readAngularWorkspaceLayout(wt.headDir, {
    appRoot: APP,
    angularProject: "web",
    tsconfigPath: `${APP}/tsconfig.app.json`
  });
  assert.ok(layout !== null);
  assert.equal(layout.sourceRoot, SRC);
  assert.equal(layout.indexHtml, `${SRC}/index.html`);
  assert.deepEqual(layout.globalStyles, [`${SRC}/styles.css`]);
  assert.deepEqual([...layout.configFiles].sort(), [
    `${APP}/.postcssrc.json`,
    `${APP}/angular.json`,
    `${APP}/package.json`,
    `${APP}/postcss.config.json`,
    `${APP}/tsconfig.app.json`,
    `${APP}/tsconfig.json`
  ]);
  assert.equal(
    await readAngularWorkspaceLayout(wt.headDir, { appRoot: APP, angularProject: "missing", tsconfigPath: null }),
    null
  );
});

test("classifyAngularPath applies the 15 §5.5.1 rules in order", () => {
  const layout: AngularWorkspaceLayout = {
    ...fallbackAngularWorkspaceLayout(APP),
    indexHtml: `${SRC}/index.html`,
    globalStyles: [`${SRC}/styles.css`],
    globalStyleClosure: new Set([`${SRC}/styles.css`, `${SRC}/styles/base.css`]),
    configFiles: new Set([`${APP}/angular.json`, `${APP}/package.json`, `${APP}/tsconfig.app.json`])
  };
  const cases: Array<[string, string]> = [
    [`${APP}/node_modules/x/y.ts`, "ignored"],
    [`${APP}/.angular/cache/x.ts`, "ignored"],
    [`${SRC}/.prvision-harness/main.ts`, "ignored"],
    [`${SRC}/styles.css`, "global_style"],
    [`${SRC}/styles/base.css`, "global_style"],
    [`${APP}/angular.json`, "global_config"],
    [`${APP}/tailwind.config.ts`, "global_config"],
    [`${APP}/tsconfig.app.json`, "global_config"],
    [`${APP_DIR}/x.component.spec.ts`, "ignored"],
    [`${APP_DIR}/x.stories.ts`, "ignored"],
    [`${APP_DIR}/types.d.ts`, "ignored"],
    [`${APP_DIR}/x.mock.ts`, "ignored"],
    [`${APP_DIR}/x.component.ts`, "script"],
    [`${APP_DIR}/x.component.html`, "template"],
    [`${SRC}/index.html`, "ignored"],
    [`${APP_DIR}/x.component.scss`, "style"],
    [`${APP_DIR}/x.component.less`, "style"],
    [`${SRC}/assets/logo.svg`, "asset"],
    ["README.md", "ignored"],
    ["apps/other/src/app/x.ts", "ignored"]
  ];
  for (const [path, kind] of cases) {
    assert.equal(classifyAngularPath(path, layout), kind, path);
  }
});
