import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  JSON_COLUMN_TYPES,
  generateModelClass,
  mapColumnType,
  readSchemaTables,
  renderModelFiles,
  type TableDefinition
} from "../../../backend/scripts/generate-models";

const MODELS_DIR = path.resolve(__dirname, "../../../backend/src/models");

function tableByName(tables: TableDefinition[], tableName: string): TableDefinition {
  const table = tables.find((candidate) => candidate.tableName === tableName);
  assert.ok(table, `table ${tableName}`);
  return table;
}

function fieldLine(source: string, field: string): string {
  const match = new RegExp(`private _${field}!:([^;]+);`).exec(source);
  assert.ok(match?.[1], `field _${field}`);
  return match[1].replace(/\s+/g, " ").trim();
}

test("produces the five class names from §9.2 and the five of 16 §6.10", () => {
  const tables = readSchemaTables();
  assert.deepEqual(
    tables.map((table) => [table.exportName, table.tableName, table.className]),
    [
      ["appSettings", "app_settings", "AppSettingModel"],
      ["harnessLibraryEntries", "harness_library_entries", "HarnessLibraryEntryModel"],
      ["harnessLibraryJobEvents", "harness_library_job_events", "HarnessLibraryJobEventModel"],
      ["harnessLibraryJobs", "harness_library_jobs", "HarnessLibraryJobModel"],
      ["liveSessions", "live_sessions", "LiveSessionModel"],
      ["repositories", "repositories", "RepositoryModel"],
      ["visualizationComponentStates", "visualization_component_states", "VisualizationComponentStateModel"],
      ["visualizationComponents", "visualization_components", "VisualizationComponentModel"],
      ["visualizationConsoleEvents", "visualization_console_events", "VisualizationConsoleEventModel"],
      ["visualizations", "visualizations", "VisualizationModel"]
    ]
  );
});

test("nullable columns are typed T | null and not-null columns T", () => {
  const tables = readSchemaTables();
  const visualization = generateModelClass(tableByName(tables, "visualizations"));
  assert.equal(fieldLine(visualization, "baseSha"), "string | null");
  assert.equal(fieldLine(visualization, "completedAt"), "Date | null");
  assert.equal(fieldLine(visualization, "createdAt"), "Date");
  assert.equal(fieldLine(visualization, "id"), "number");
  assert.equal(fieldLine(visualization, "isDeleted"), "boolean");
  assert.equal(fieldLine(visualization, "prNumber"), "number | null");
  assert.match(visualization, /setBaseSha\(value: string \| null\): void/);
  assert.match(visualization, /get title\(\): string \{/);

  const component = generateModelClass(tableByName(tables, "visualization_components"));
  assert.equal(fieldLine(component, "diffPixelRatio"), "number | null");
  assert.equal(fieldLine(component, "changeReason"), "string | null");
  assert.equal(fieldLine(component, "skipReason"), "string | null");

  const consoleEvent = generateModelClass(tableByName(tables, "visualization_console_events"));
  assert.doesNotMatch(consoleEvent, /_updatedAt|_isDeleted/);
});

test("enum text columns become literal unions", () => {
  const tables = readSchemaTables();
  const visualization = generateModelClass(tableByName(tables, "visualizations"));
  assert.equal(fieldLine(visualization, "aiProvider"), '"anthropic_api" | "claude_code"');
  assert.equal(
    fieldLine(visualization, "failedStage"),
    '"queued" | "preparing" | "analyzing" | "generating_harnesses" | "rendering" | "diffing" | "summarizing" | null'
  );
  assert.equal(
    fieldLine(visualization, "status"),
    '"queued" | "preparing" | "analyzing" | "generating_harnesses" | "rendering" | "diffing" | "summarizing" | "completed" | "failed" | "cancelled"'
  );
  const consoleEvent = generateModelClass(tableByName(tables, "visualization_console_events"));
  assert.match(fieldLine(consoleEvent, "stage"), /^"queued" \| .* \| "cancelled"$/);
  assert.equal(fieldLine(consoleEvent, "level"), '"info" | "warn" | "error"');
});

test("json columns use JSON_COLUMN_TYPES and emit type-only imports", () => {
  const tables = readSchemaTables();
  const repository = generateModelClass(tableByName(tables, "repositories"));
  assert.equal(fieldLine(repository, "globalStylePaths"), "string[]");
  assert.doesNotMatch(repository, /^import/m);

  const visualization = generateModelClass(tableByName(tables, "visualizations"));
  assert.equal(fieldLine(visualization, "aiUsage"), "AiUsage | null");
  assert.match(visualization, /^import type \{ AiUsage \} from "\.\.\/types\/visualization-pipeline";$/m);

  const component = generateModelClass(tableByName(tables, "visualization_components"));
  assert.equal(fieldLine(component, "mockedModules"), "MockedModule[]");
  assert.equal(fieldLine(component, "structuralDiff"), "StructuralChange[] | null");
  assert.equal(fieldLine(component, "baseMockedModules"), "MockedModule[] | null"); // 00 §17
  assert.equal(fieldLine(component, "successorEvidence"), "SuccessorEvidence[] | null"); // 00 §17
  assert.match(
    component,
    /^import type \{ MockedModule, StructuralChange, SuccessorEvidence \} from "\.\.\/types\/visualization-pipeline";$/m
  );
});

test("fails when a json column has no type mapping", () => {
  assert.throws(
    () =>
      mapColumnType("visualizations", "untypedJson", {
        dataType: "json",
        notNull: false
      }),
    /Missing JSON_COLUMN_TYPES entry for visualizations\.untypedJson/
  );
  assert.deepEqual(mapColumnType("visualizations", "aiUsage", { dataType: "json" }), {
    tsType: "AiUsage",
    typeImports: ["AiUsage"],
    typesModule: "../types/visualization-pipeline"
  });
});

test('generated source has no "any"', () => {
  for (const table of readSchemaTables()) {
    assert.doesNotMatch(generateModelClass(table), /\bany\b/, table.className);
  }
});

test("committed src/models matches generator output", async () => {
  const expected = await renderModelFiles();
  const committed = fs.readdirSync(MODELS_DIR).sort();
  assert.deepEqual(committed, [...expected.keys()].sort());
  for (const [fileName, content] of expected) {
    assert.equal(fs.readFileSync(path.join(MODELS_DIR, fileName), "utf8"), content, fileName);
  }
});

test("16 §6.10: the eight JSON_COLUMN_TYPES entries of the library tables name their type module", () => {
  const PIPELINE = "../types/visualization-pipeline";
  const LIBRARY = "../types/harness-library";
  const expected: Record<string, { tsType: string; typeImports: string[]; typesModule: string | null }> = {
    "harnessLibraryEntries.mockedModules": {
      tsType: "MockedModule[]",
      typeImports: ["MockedModule"],
      typesModule: PIPELINE
    },
    "harnessLibraryEntries.states": {
      tsType: "HarnessStateSpec[]",
      typeImports: ["HarnessStateSpec"],
      typesModule: LIBRARY
    },
    "harnessLibraryEntries.aiUsage": { tsType: "AiUsage", typeImports: ["AiUsage"], typesModule: PIPELINE },
    "harnessLibraryJobs.componentIds": { tsType: "number[]", typeImports: [], typesModule: null },
    "harnessLibraryJobs.aiUsage": { tsType: "AiUsage", typeImports: ["AiUsage"], typesModule: PIPELINE },
    "visualizationComponentStates.steps": {
      tsType: "HarnessStep[]",
      typeImports: ["HarnessStep"],
      typesModule: LIBRARY
    },
    "liveSessions.hosts": { tsType: "LiveHostState[]", typeImports: ["LiveHostState"], typesModule: LIBRARY },
    "liveSessions.openRequests": {
      tsType: "LiveOpenRequestRecord[]",
      typeImports: ["LiveOpenRequestRecord"],
      typesModule: LIBRARY
    }
  };
  for (const [key, entry] of Object.entries(expected)) {
    assert.deepEqual(JSON_COLUMN_TYPES[key], entry, key);
  }
});

test("16 §6.10: generated files import from both type modules, one import line per module", () => {
  const tables = readSchemaTables();
  const entry = generateModelClass(tableByName(tables, "harness_library_entries"));
  assert.match(entry, /^import type \{ HarnessStateSpec \} from "\.\.\/types\/harness-library";$/m);
  assert.match(entry, /^import type \{ AiUsage, MockedModule \} from "\.\.\/types\/visualization-pipeline";$/m);
  assert.equal(fieldLine(entry, "states"), "HarnessStateSpec[]");
  assert.equal(fieldLine(entry, "aiUsage"), "AiUsage | null");
  assert.equal(fieldLine(entry, "status"), '"ready" | "needs_update" | "off_default_branch"');

  const job = generateModelClass(tableByName(tables, "harness_library_jobs"));
  assert.equal(fieldLine(job, "componentIds"), "number[] | null");
  assert.equal((job.match(/^import type/gm) ?? []).length, 1);

  const live = generateModelClass(tableByName(tables, "live_sessions"));
  assert.match(live, /^import type \{ LiveHostState, LiveOpenRequestRecord \} from "\.\.\/types\/harness-library";$/m);
  assert.doesNotMatch(live, /visualization-pipeline/);

  const state = generateModelClass(tableByName(tables, "visualization_component_states"));
  assert.equal(fieldLine(state, "steps"), "HarnessStep[]");
  assert.match(fieldLine(state, "headFailureKind"), /"step_failed"/);
});
