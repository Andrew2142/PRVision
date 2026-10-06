/**
 * Real-AI check of sheet 15c (15 §10): the Angular fixture's OrderListComponent (apps/web, sheet 15f's files) gets a
 * harness whose first answer passes AngularHarnessValidator without a correction call. Gated on PRVISION_IT_AI=1
 * plus ANTHROPIC_API_KEY (costs tokens). Rendering the harness is 15d/15f's angular-pipeline integration test.
 *
 * The source queries are 15c's in-memory fake fed with the fixture files, so the prompt quality is measured without
 * depending on 15b's analysis.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Table } from "../../../../backend/src/enums";
import { createAngularHarnessGeneration } from "../../../../backend/src/services/visualizations/pipeline/angular/angular-harness-generation";
import { AiProviderFactory, type QueryHandler } from "../../../../backend/src/utilities";
import { APP_ROOT, MAIN_FILES } from "../../../../tools/fixture-repo/sample-angular-app-files.mjs";
import { FakeAngularSourceQueries, angularMeta } from "../../harness/helpers/fake-angular-source-queries";
import { directImport } from "../../harness/helpers/fake-source-queries";
import { createTempWorktrees } from "../../harness/helpers/temp-worktrees";
import { recordLogger } from "../../helpers/console-recorder";
import { makeComponentRow, makeVisualizationRow } from "../../helpers/factories";
import { createPipelineContext } from "../../helpers/pipeline-context";
import { InMemoryQueryHandler } from "../../helpers/query-handler-stub";
import { itSkip } from "../helpers/it-flags";

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
const model = process.env.PRVISION_IT_AI_MODEL ?? "claude-opus-5-5";
const skip = itSkip("ai") || (apiKey === "" ? "set ANTHROPIC_API_KEY" : false);

const DIR = `${APP_ROOT}/src/app/orders/order-list`;
const FILE = `${DIR}/order-list.component.ts`;
const SERVICE = `${APP_ROOT}/src/app/orders/orders.service.ts`;
const BADGE = `${APP_ROOT}/src/app/shared/badge/badge.component.ts`;

test(
  "Angular harness for the fixture's order-list validates on the first answer",
  { skip, timeout: 900_000 },
  async (t) => {
    const logs = recordLogger();
    t.after(logs.restore);
    const trees = createTempWorktrees(t);
    for (const [file, content] of Object.entries(MAIN_FILES)) {
      trees.write("both", file, content);
    }
    const template = MAIN_FILES[`${DIR}/order-list.component.html`] ?? "";
    const imports = [
      directImport({ specifier: "@angular/common", kind: "package", namedImports: ["CurrencyPipe"] }),
      directImport({ specifier: "@angular/core", kind: "package", namedImports: ["Component", "inject", "signal"] }),
      directImport({
        specifier: "@app/shared/badge/badge.component",
        kind: "alias",
        resolvedPath: BADGE,
        namedImports: ["BadgeComponent"]
      }),
      directImport({
        specifier: "../orders.service",
        kind: "relative",
        resolvedPath: SERVICE,
        namedImports: ["OrdersService"]
      })
    ];
    const queries = new FakeAngularSourceQueries({
      files: { base: trees.files.base, head: trees.files.head },
      aliases: { "@app/": `${APP_ROOT}/src/app/` },
      directImports: { base: { [FILE]: imports }, head: { [FILE]: imports } }
    });
    queries.setMeta(
      "both",
      angularMeta({
        filePath: FILE,
        className: "OrderListComponent",
        selector: "app-order-list",
        template: { kind: "external", path: `${DIR}/order-list.component.html`, text: template, startLine: 1 },
        styles: [{ kind: "external", path: `${DIR}/order-list.component.scss`, language: "scss" }],
        imports: ["BadgeComponent", "CurrencyPipe"],
        injected: [
          {
            token: "OrdersService",
            via: "inject",
            optional: false,
            importSpecifier: "../orders.service",
            resolvedPath: SERVICE,
            providedIn: "root",
            hints: []
          }
        ]
      })
    );
    const handle = createPipelineContext({
      dataDir: trees.root,
      repositoryPath: trees.root,
      baseDir: trees.baseDir,
      headDir: trees.headDir,
      repository: {
        framework: "angular",
        appRoot: APP_ROOT,
        angularProject: "web",
        angularBuildConfiguration: "development",
        viteConfigPath: null,
        tsconfigPath: `${APP_ROOT}/tsconfig.app.json`,
        entryFilePath: `${APP_ROOT}/src/main.ts`,
        globalStylePaths: [`${APP_ROOT}/src/styles.scss`]
      }
    });
    handle.context.ai = AiProviderFactory.create({
      provider: "anthropic_api",
      model,
      harnessEffort: "low",
      summaryEffort: "low",
      anthropicApiKey: { state: "present", value: apiKey }
    });
    handle.context.aiSettings = { model, harnessEffort: "low", summaryEffort: "low" };
    const candidate = {
      componentId: 1,
      filePath: FILE,
      exportName: "OrderListComponent",
      displayName: "OrderListComponent",
      changeKind: "modified" as const,
      rank: 0,
      codeDiff: `diff --git a/${FILE} b/${FILE}\n@@ -1 +1 @@\n-  loading = signal(false);\n+  loading = signal(true);`,
      reason: "Component code changed"
    };
    const db = new InMemoryQueryHandler();
    db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "generating_harnesses" })]);
    db.seed(Table.VISUALIZATION_COMPONENTS, [
      makeComponentRow({
        id: 1,
        visualizationId: 1,
        filePath: FILE,
        exportName: "OrderListComponent",
        displayName: "OrderListComponent"
      })
    ]);
    const service = createAngularHarnessGeneration(handle.context, queries, {
      queryHandler: db as unknown as QueryHandler
    });

    const batch = await service.generateAll([candidate]);
    assert.deepEqual(batch.failures, [], JSON.stringify(batch.failures));
    assert.equal(batch.results.length, 1);
    const calls = logs.lines.filter((line) => line.event === "harness.ai.call");
    assert.deepEqual(
      calls.map((line) => line.purpose),
      ["harness"],
      "the first answer passed AngularHarnessValidator (no correction call)"
    );
    assert.match(batch.results[0]?.harnessSource ?? "", /definePrvisionHarness\(/);
  }
);
