import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  attributeDiagnostic,
  componentOwnsFile,
  errorDiagnosticsOfFailedBuild,
  formatAngularBuildError,
  parseAngularBuildMessages,
  runExclusionLoop,
  warningLines,
  type AngularDiagnostic,
  type ExclusionBuildResult
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-diagnostics";

/** Builder output captured from the Acme prototype run (harnesses 106 and 107, Angular 21.2). */
const PROTOTYPE_ERRORS = fs.readFileSync(
  path.join(__dirname, "../../../fixtures/angular-build/prototype-harness-errors.txt"),
  "utf8"
);

const WARNING_BLOCK = `▲ [WARNING] NG8107: The left side of this optional chain operation does not include 'null' or 'undefined'. [plugin angular-compiler]

    src/app/foo/foo.component.html:3:12:
      3 │ {{ user?.name }}
        ╵            ~~~~
`;

function diagnostic(file: string | null, message = "TS2304: Cannot find name 'x'."): AngularDiagnostic {
  return { severity: "error", code: "TS2304", message, file, line: 1, column: 1, frame: [] };
}

test("parseAngularBuildMessages parses the captured prototype output (missing import, NG8008, NG8002, NG8001)", () => {
  const diagnostics = parseAngularBuildMessages([PROTOTYPE_ERRORS]);
  assert.equal(diagnostics.length, 4);
  assert.ok(diagnostics.every((entry) => entry.severity === "error"));
  const [missing, ng8008, ng8002, ng8001] = diagnostics;
  assert.ok(missing && ng8008 && ng8002 && ng8001);
  assert.equal(missing.code, null);
  assert.match(missing.message, /^Could not resolve "\.\.\/\.\.\/src\/app\/does-not-exist\/missing\.component"$/);
  assert.equal(missing.file, ".prvision-harness/components/106.ts");
  assert.equal(missing.line, 4);
  assert.equal(missing.column, 24);
  assert.equal(ng8008.code, "NG8008");
  assert.ok(!ng8008.message.includes("[plugin"), "the [plugin …] suffix is stripped");
  assert.equal(ng8008.file, ".prvision-harness/components/107.ts");
  assert.equal(ng8002.code, "NG8002");
  assert.match(ng8002.message, /Can't bind to 'titel'[\s\S]*3\. To allow any property/);
  assert.equal(ng8002.line, 6);
  assert.equal(ng8002.column, 95);
  assert.equal(ng8001.code, "NG8001");
  assert.equal(ng8001.column, 109);
  for (const entry of diagnostics) {
    assert.ok(entry.frame.length >= 1 && entry.frame.length <= 6);
    assert.match(entry.frame[0] ?? "", /│/);
  }
});

test("parseAngularBuildMessages separates warnings, accepts the non-UTF marker and caps frames at 6 lines", () => {
  const longFrame = [
    "X [ERROR] TS2307: Cannot find module './gone' or its corresponding type declarations.",
    "",
    "    src/app/a.ts:1:20:",
    ...Array.from({ length: 10 }, (_, index) => `      ${String(index)} │ line`),
    ""
  ].join("\n");
  const diagnostics = parseAngularBuildMessages([WARNING_BLOCK, longFrame]);
  assert.equal(diagnostics.length, 2);
  const [warning, error] = diagnostics;
  assert.ok(warning && error);
  assert.equal(warning.severity, "warning");
  assert.equal(warning.code, "NG8107");
  assert.equal(error.severity, "error");
  assert.equal(error.code, "TS2307");
  assert.equal(error.file, "src/app/a.ts");
  assert.equal(error.frame.length, 6);
  assert.deepEqual(warningLines([{ message: WARNING_BLOCK }], 10), [
    "NG8107: The left side of this optional chain operation does not include 'null' or 'undefined'. (src/app/foo/foo.component.html)"
  ]);
});

test("errorDiagnosticsOfFailedBuild ignores warnings and turns an unparseable failure into one location-less diagnostic", () => {
  const parsed = errorDiagnosticsOfFailedBuild([
    { level: "warn", message: WARNING_BLOCK },
    { level: "error", message: PROTOTYPE_ERRORS }
  ]);
  assert.equal(parsed.length, 4);
  const fallback = errorDiagnosticsOfFailedBuild([
    { level: "info", message: "Application bundle generation failed." },
    {
      level: "error",
      message:
        'Schema validation failed with the following errors:\n  Data path "" must NOT have additional properties(foo).'
    }
  ]);
  const [only] = fallback;
  assert.ok(only && fallback.length === 1);
  assert.equal(only.file, null);
  assert.match(only.message, /^Schema validation failed/);
  assert.equal(errorDiagnosticsOfFailedBuild([]).length, 1);
});

test("attributeDiagnostic follows the attribution table (component, mock, harness file, side-wide files, repo file, none)", () => {
  const context = {
    itemIds: new Set([101, 102]),
    mockOwners: new Map([["0123456789abcdef", [102]]]),
    sideWideFiles: new Set(["src/styles.css", "angular.json", "tsconfig.app.json"])
  };
  assert.deepEqual(attributeDiagnostic(diagnostic(".prvision-harness/components/101.ts"), context), {
    kind: "items",
    componentIds: [101]
  });
  assert.deepEqual(attributeDiagnostic(diagnostic(".prvision-harness/mocks/0123456789abcdef.ts"), context), {
    kind: "items",
    componentIds: [102]
  });
  for (const file of [
    ".prvision-harness/main.ts",
    ".prvision-harness/http-backend.ts",
    ".prvision-harness/harness-api.ts",
    ".prvision-harness/registry.generated.ts",
    ".prvision-harness/framework.generated.ts",
    ".prvision-harness/index.html",
    ".prvision-harness/tsconfig.json",
    ".prvision-harness/components/999.ts",
    "src/styles.css",
    "angular.json",
    "tsconfig.app.json"
  ]) {
    assert.deepEqual(attributeDiagnostic(diagnostic(file), context), { kind: "side_wide" }, file);
  }
  assert.deepEqual(attributeDiagnostic(diagnostic(null), context), { kind: "side_wide" });
  assert.deepEqual(attributeDiagnostic(diagnostic("src/app/orders/order-list.component.ts"), context), {
    kind: "unattributed",
    file: "src/app/orders/order-list.component.ts"
  });
});

test("formatAngularBuildError writes the Angular build section (at most 10 diagnostics) and strips worktree paths", () => {
  const diagnostics = parseAngularBuildMessages([PROTOTYPE_ERRORS]).map((entry) => ({
    ...entry,
    message: entry.message.replace("Could not resolve", "Could not resolve /data/worktrees/7/head/x")
  }));
  const text = formatAngularBuildError("module_load", "Angular build error in the harness:", diagnostics, [
    "/data/worktrees/7/head"
  ]);
  assert.match(
    text,
    /^\[module_load\] Module load failed: Angular build error in the harness:\nAngular build:\n- Could not resolve x/
  );
  assert.ok(text.includes("  .prvision-harness/components/107.ts:6:95"));
  assert.ok(!text.includes("/data/worktrees"));
  const many = Array.from({ length: 12 }, (_, index) => diagnostic(`src/f${String(index)}.ts`));
  const capped = formatAngularBuildError("vite_unavailable", "The Angular build failed on the head side:", many, []);
  assert.equal(capped.split("\n").filter((line) => line.startsWith("- TS2304")).length, 10);
  assert.ok(capped.includes("- … 2 more"));
  assert.ok(capped.startsWith("[vite_unavailable] The Angular build failed on the head side:"));
});

// ---------------------------------------------------------------------------------------------------------------
// Exclusion and bisect loop
// ---------------------------------------------------------------------------------------------------------------

type BuildScript = (ids: number[]) => ExclusionBuildResult;

async function loop(ids: number[], script: BuildScript, budget = 4, targetFiles?: ReadonlyMap<number, string>) {
  const builds: number[][] = [];
  const result = await runExclusionLoop({
    side: "head",
    componentIds: ids,
    budget,
    mockOwners: new Map(),
    sideWideFiles: new Set(["src/styles.css"]),
    ...(targetFiles === undefined ? {} : { targetFiles }),
    build: (componentIds) => {
      builds.push([...componentIds]);
      return Promise.resolve(script(componentIds));
    }
  });
  return { result, builds };
}

/** Unattributed failure while `bad` is in the build (a repo file breaks the build for that component). */
function brokenBy(bad: number): BuildScript {
  return (ids) =>
    ids.includes(bad)
      ? {
          status: "failed",
          diagnostics: [diagnostic("src/app/broken.component.ts", "NG8001: 'x' is not a known element")]
        }
      : { status: "success", outputDir: `/dist/${ids.join("-")}` };
}

test("runExclusionLoop builds everything once when the build succeeds", async () => {
  const { result, builds } = await loop([1, 2, 3], () => ({ status: "success", outputDir: "/dist/a" }));
  assert.deepEqual(builds, [[1, 2, 3]]);
  assert.deepEqual(result.builds, [{ componentIds: [1, 2, 3], outputDir: "/dist/a", buildNo: 1 }]);
  assert.equal(result.failures.size, 0);
});

test("runExclusionLoop excludes attributed harnesses and rebuilds the rest once (prototype case: one extra build)", async () => {
  const { result, builds } = await loop([105, 106, 107], (ids) =>
    ids.includes(106) || ids.includes(107)
      ? {
          status: "failed",
          diagnostics: parseAngularBuildMessages([PROTOTYPE_ERRORS]).filter((entry) => entry.file !== null)
        }
      : { status: "success", outputDir: "/dist/105" }
  );
  assert.deepEqual(builds, [[105, 106, 107], [105]]);
  assert.equal(result.buildsUsed, 2);
  assert.deepEqual([...result.failures.keys()].sort(), [106, 107]);
  assert.equal(result.failures.get(107)?.kind, "module_load");
  assert.equal(result.failures.get(107)?.diagnostics.length, 3);
  assert.equal(result.failures.get(106)?.diagnostics.length, 1);
  assert.deepEqual(result.exclusions, [{ buildNo: 1, componentIds: [106, 107], reason: "attributed" }]);
  assert.deepEqual(
    result.builds.map((build) => build.componentIds),
    [[105]]
  );
});

test("runExclusionLoop fails every item side-wide on a global style error and stops", async () => {
  const { result, builds } = await loop([1, 2], () => ({
    status: "failed",
    diagnostics: [diagnostic("src/styles.css", "Unexpected token")]
  }));
  assert.equal(builds.length, 1);
  assert.equal(result.failures.get(1)?.kind, "vite_unavailable");
  assert.equal(result.failures.get(2)?.kind, "vite_unavailable");
  assert.equal(result.sideWide?.headline, "The Angular build failed on the head side:");
});

test("runExclusionLoop bisect plan for 1, 2, 5 and 12 items stays within the 4-build budget", async () => {
  // 1 item: no bisect, the item fails with the repo file named.
  const one = await loop([1], brokenBy(1));
  assert.deepEqual(one.builds, [[1]]);
  assert.match(one.result.failures.get(1)?.headline ?? "", /^Angular build error in src\/app\/broken\.component\.ts:$/);

  // 2 items: [1,2] → [1] ok → [2] fails alone.
  const two = await loop([1, 2], brokenBy(2));
  assert.deepEqual(two.builds, [[1, 2], [1], [2]]);
  assert.deepEqual([...two.result.failures.keys()], [2]);
  assert.deepEqual(
    two.result.builds.map((build) => build.componentIds),
    [[1]]
  );

  // 5 items: [1..5] → [1,2,3] ok → [4,5] → [4] (budget used) → 5 fails with the last diagnostics.
  const five = await loop([1, 2, 3, 4, 5], brokenBy(4));
  assert.deepEqual(five.builds, [[1, 2, 3, 4, 5], [1, 2, 3], [4, 5], [4]]);
  assert.equal(five.result.buildsUsed, 4);
  assert.deepEqual([...five.result.failures.keys()].sort(), [4, 5]);
  assert.match(five.result.failures.get(5)?.headline ?? "", /4-build limit/);
  assert.deepEqual(
    five.result.builds.map((build) => build.componentIds),
    [[1, 2, 3]]
  );

  // 12 items: [1..12] → [1..6] ok → [7..12] → [7,8,9] (budget used) → 10..12 fail unbuilt.
  const twelve = await loop(
    Array.from({ length: 12 }, (_, index) => index + 1),
    brokenBy(8)
  );
  assert.equal(twelve.builds.length, 4);
  assert.deepEqual(twelve.builds[1], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(twelve.builds[2], [7, 8, 9, 10, 11, 12]);
  assert.deepEqual(twelve.builds[3], [7, 8, 9]);
  assert.deepEqual(
    [...twelve.result.failures.keys()].sort((a, b) => a - b),
    [7, 8, 9, 10, 11, 12]
  );
  for (const id of [1, 2, 3, 4, 5, 6]) {
    assert.ok(!twelve.result.failures.has(id));
  }
  // Every item ends up in exactly one successful build or in failures.
  for (const run of [one, two, five, twelve]) {
    const built = run.result.builds.flatMap((build) => build.componentIds);
    assert.equal(new Set(built).size, built.length);
    for (const id of built) {
      assert.ok(!run.result.failures.has(id));
    }
  }
});

test("runExclusionLoop maps unavailable, timeout and cancelled outcomes", async () => {
  const unavailable = await loop([1, 2], () => ({
    status: "unavailable",
    message: "The Angular build process exited (exit code null, signal SIGKILL)."
  }));
  assert.equal(unavailable.result.failures.get(2)?.kind, "vite_unavailable");
  const timeout = await loop([1], () => ({
    status: "timeout",
    message: "The Angular build did not finish within 240 s."
  }));
  assert.equal(timeout.result.failures.get(1)?.kind, "timeout");
  assert.equal(timeout.result.failures.get(1)?.headline, "The Angular build did not finish within 240 s.");
  const cancelled = await loop([1, 2], () => ({ status: "cancelled" }));
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(cancelled.result.failures.size, 0);
  const none = await loop([], () => ({ status: "cancelled" }));
  assert.deepEqual(none.builds, []);
});

test("componentOwnsFile: the target file and its same-stem template and stylesheets", () => {
  const target = "src/app/orders/order-list/order-list.component.ts";
  for (const file of [
    target,
    "src/app/orders/order-list/order-list.component.html",
    "src/app/orders/order-list/order-list.component.scss",
    "src/app/orders/order-list/./order-list.component.css"
  ]) {
    assert.equal(componentOwnsFile(target, file), true, file);
  }
  for (const file of [
    "src/app/orders/order-list/order-list.component.spec.ts",
    "src/app/orders/order-list/order-list.component.json",
    "src/app/orders/order-list.component.html",
    "src/app/orders/order-list/other.component.html",
    "src/app/shared/badge/badge.component.html"
  ]) {
    assert.equal(componentOwnsFile(target, file), false, file);
  }
});

test("runExclusionLoop fails the item that owns the failing repository file and rebuilds the rest once", async () => {
  const html = "src/app/orders/order-list/order-list.component.html";
  const targets = new Map([
    [1, "src/app/orders/order-list/order-list.component.ts"],
    [2, "src/app/shared/badge/badge.component.ts"],
    [3, "src/app/shared/signal-card/signal-card.component.ts"]
  ]);
  const script: BuildScript = (ids) =>
    ids.includes(1)
      ? { status: "failed", diagnostics: [diagnostic(html, "NG8002: Can't bind to 'size'")] }
      : { status: "success", outputDir: `/dist/${ids.join("-")}` };
  const { result, builds } = await loop([1, 2, 3], script, 4, targets);
  assert.deepEqual(builds, [
    [1, 2, 3],
    [2, 3]
  ]);
  assert.equal(result.buildsUsed, 2);
  assert.deepEqual([...result.failures.keys()], [1]);
  assert.equal(result.failures.get(1)?.kind, "module_load");
  assert.equal(result.failures.get(1)?.headline, `Angular build error in ${html}:`);
  assert.equal(result.failures.get(1)?.diagnostics.length, 1);
  assert.deepEqual(result.exclusions, [{ buildNo: 1, componentIds: [1], reason: "owner" }]);
  assert.deepEqual(
    result.builds.map((build) => build.componentIds),
    [[2, 3]]
  );

  // A parent that imports the broken component still fails on its own rebuild (single item: named file).
  const parentScript: BuildScript = (ids) =>
    ids.includes(1) || ids.includes(4)
      ? { status: "failed", diagnostics: [diagnostic(html, "NG8002: Can't bind to 'size'")] }
      : { status: "success", outputDir: `/dist/${ids.join("-")}` };
  const withParent = await loop(
    [1, 4],
    parentScript,
    4,
    new Map([
      [1, targets.get(1) ?? ""],
      [4, "src/app/page.component.ts"]
    ])
  );
  assert.deepEqual(withParent.builds, [[1, 4], [4]]);
  assert.deepEqual([...withParent.result.failures.keys()].sort(), [1, 4]);
  assert.equal(withParent.result.failures.get(4)?.headline, `Angular build error in ${html}:`);

  // Without an owner among the items, bisect is unchanged.
  const unowned = await loop([1, 2], brokenBy(2), 4, targets);
  assert.deepEqual(unowned.builds, [[1, 2], [1], [2]]);
});
