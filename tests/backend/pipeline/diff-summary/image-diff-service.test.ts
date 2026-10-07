import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { PNG } from "pngjs";
import { PIXELMATCH_THRESHOLD, UNCHANGED_RATIO_CUTOFF } from "../../../../backend/src/config-consts";
import { Table } from "../../../../backend/src/enums";
import {
  ImageDiffService,
  PIXELMATCH_OPTIONS,
  classifyRender,
  computePixelDiff
} from "../../../../backend/src/services/visualizations/pipeline/image-diff-service";
import {
  PipelineStepError,
  type ComponentRenderResult,
  type ImageDiffResult
} from "../../../../backend/src/types/visualization-pipeline";
import { createPipelineContext, type PipelineContextHandle } from "../../helpers/pipeline-context";
import {
  VISUALIZATION_ID,
  artifactPath,
  decodePng,
  encodePng,
  failedSide,
  memoryArtifactStore,
  okSide,
  pixelAt,
  recordingQueryHandler,
  solidPng,
  withRect,
  type MemoryArtifactStore,
  type RecordingQueryHandler
} from "./helpers/png-fixtures";

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [255, 0, 0, 255];

interface Harness {
  service: ImageDiffService;
  store: MemoryArtifactStore;
  db: RecordingQueryHandler;
  handle: PipelineContextHandle;
}

function setup(componentIds: number[], files: Record<string, Buffer> = {}): Harness {
  const store = memoryArtifactStore(files);
  const db = recordingQueryHandler(componentIds.map((id) => ({ id, displayName: `Comp${String(id)}` })));
  const handle = createPipelineContext({
    visualizationId: VISUALIZATION_ID,
    dataDir: "/tmp/unused",
    repositoryPath: "/tmp/repo"
  });
  const service = new ImageDiffService({
    artifactStore: store,
    createQueryHandler: () => db.asQueryHandler()
  });
  return { service, store, db, handle };
}

/** One compared pair through the service. */
async function diffPair(
  base: PNG,
  head: PNG
): Promise<{
  results: ImageDiffResult[];
  values: Record<string, unknown>;
  h: Harness;
}> {
  const h = setup([1], {
    [artifactPath(1, "base")]: encodePng(base),
    [artifactPath(1, "head")]: encodePng(head)
  });
  const results = await h.service.diff(h.handle.context, [
    {
      componentId: 1,
      base: okSide("base", 1, base.width, base.height),
      head: okSide("head", 1, head.width, head.height),
      states: []
    }
  ]);
  const values = h.db.updatesFor(1).at(-1) ?? {};
  return { results, values, h };
}

test("classifyRender table", () => {
  const render = (base: ComponentRenderResult["base"], head: ComponentRenderResult["head"]): ComponentRenderResult => ({
    componentId: 1,
    base,
    head,
    states: []
  });
  const ok = (side: "base" | "head") => okSide(side, 1);
  const failed = (side: "base" | "head") => failedSide(side);
  const okNoImage = (side: "base" | "head") => okSide(side, 1, 10, 10, { imagePath: null });

  assert.equal(classifyRender(render(null, ok("head"))).kind, "new");
  assert.deepEqual(classifyRender(render(null, failed("head"))), {
    kind: "not_comparable",
    reason: "head render failed"
  });
  assert.equal(classifyRender(render(ok("base"), null)).kind, "deleted");
  assert.deepEqual(classifyRender(render(failed("base"), null)), {
    kind: "not_comparable",
    reason: "base render failed"
  });
  assert.equal(classifyRender(render(ok("base"), ok("head"))).kind, "compare");
  assert.deepEqual(classifyRender(render(failed("base"), ok("head"))), {
    kind: "not_comparable",
    reason: "base render failed"
  });
  assert.deepEqual(classifyRender(render(ok("base"), okNoImage("head"))), {
    kind: "not_comparable",
    reason: "head render failed"
  });
  assert.deepEqual(classifyRender(render(failed("base"), failed("head"))), {
    kind: "not_comparable",
    reason: "both renders failed"
  });
  assert.deepEqual(classifyRender(render(null, null)), {
    kind: "not_comparable",
    reason: "component missing on both sides"
  });
});

test("identical images give ratio 0 and unchanged", async () => {
  const png = withRect(solidPng(60, 40, WHITE), { x: 5, y: 5, w: 10, h: 10 }, RED);
  const { results, values } = await diffPair(png, png);
  assert.equal(results[0]?.diffPixelRatio, 0);
  assert.equal(values.visualChange, "unchanged");
});

test("single changed pixel in 1280x800 is below cutoff and unchanged", async () => {
  const base = solidPng(1280, 800, WHITE);
  const head = withRect(solidPng(1280, 800, WHITE), { x: 640, y: 400, w: 1, h: 1 }, [0, 0, 0, 255]);
  const { results, values } = await diffPair(base, head);
  assert.equal(results[0]?.diffPixelRatio, 0.000001);
  assert.ok(Math.round(UNCHANGED_RATIO_CUTOFF * 1e6) > 1); // the cutoff is above one pixel in a 1280x800 canvas
  assert.equal(values.visualChange, "unchanged");
});

test("10x10 changed block is changed with exact ratio", async () => {
  const base = solidPng(100, 100, WHITE);
  const head = withRect(solidPng(100, 100, WHITE), { x: 20, y: 30, w: 10, h: 10 }, RED);
  const out = computePixelDiff(base, head);
  assert.equal(out.diffPixels, 100);
  assert.equal(out.ratio, 0.01);
  const { values } = await diffPair(base, head);
  assert.equal(values.visualChange, "changed");
  assert.equal(values.diffPixelRatio, 0.01);
});

test("taller head counts the white band as changed", () => {
  const out = computePixelDiff(solidPng(100, 50, WHITE), solidPng(100, 60, WHITE));
  assert.equal(out.width, 100);
  assert.equal(out.height, 60);
  assert.equal(out.diffPixels, 1000);
  assert.equal(out.ratio, 1000 / 6000);
  assert.deepEqual(pixelAt(out.diff, 50, 55), [255, 0, 80, 255]);
  assert.equal(pixelAt(out.diff, 50, 10)[0], pixelAt(out.diff, 50, 10)[1]); // faded grey inside the intersection
});

test("transparent band pixels are not counted", async () => {
  const base = solidPng(100, 50, WHITE);
  const head = withRect(solidPng(100, 60, WHITE), { x: 0, y: 50, w: 100, h: 10 }, [0, 0, 0, 0]);
  const out = computePixelDiff(base, head);
  assert.equal(out.diffPixels, 0);
  assert.deepEqual(pixelAt(out.diff, 50, 55), [0, 0, 0, 0]);
  const { values } = await diffPair(base, head);
  assert.equal(values.visualChange, "unchanged");
  assert.equal(values.imageHeight, 60);
});

test("wider base counts base-only band with alt colour", () => {
  const out = computePixelDiff(solidPng(120, 50, WHITE), solidPng(100, 50, WHITE));
  assert.equal(out.width, 120);
  assert.equal(out.diffPixels, 20 * 50);
  assert.deepEqual(pixelAt(out.diff, 110, 10), [0, 150, 255, 255]);
});

test("anti-aliased edge differences are not counted", () => {
  const base = withRect(solidPng(40, 40, WHITE), { x: 10, y: 0, w: 10, h: 40 }, [0, 0, 0, 255]);
  const head = withRect(
    withRect(solidPng(40, 40, WHITE), { x: 10, y: 0, w: 10, h: 40 }, [0, 0, 0, 255]),
    { x: 20, y: 5, w: 1, h: 30 },
    [128, 128, 128, 255]
  );
  const out = computePixelDiff(base, head);
  assert.equal(out.diffPixels, 0);
  assert.deepEqual(pixelAt(out.diff, 20, 10), [255, 200, 0, 255]); // painted aaColor, not counted
});

test("images above the decode limits are refused as png_too_large without decoding", async () => {
  // IHDR declares 3000 x 100 and there is no image data: decoding would fail as invalid_png.
  const wide = Buffer.from(encodePng(solidPng(2, 2, WHITE)).subarray(0, 33));
  wide.writeUInt32BE(3000, 16);
  const huge = Buffer.concat([encodePng(solidPng(2, 2, WHITE)), Buffer.alloc(33 * 1024 * 1024)]);
  const h = setup([1, 2], {
    [artifactPath(1, "base")]: wide,
    [artifactPath(1, "head")]: encodePng(solidPng(2, 2, WHITE)),
    [artifactPath(2, "base")]: huge,
    [artifactPath(2, "head")]: encodePng(solidPng(2, 2, WHITE))
  });
  const results = await h.service.diff(h.handle.context, [
    { componentId: 1, base: okSide("base", 1), head: okSide("head", 1), states: [] },
    { componentId: 2, base: okSide("base", 2), head: okSide("head", 2), states: [] }
  ]);
  assert.deepEqual(results, []);
  assert.ok(h.handle.console.has("warn", "Could not compare screenshots for Comp1: PNG too large."));
  assert.ok(h.handle.console.has("warn", "Could not compare screenshots for Comp2: PNG too large."));
  for (const id of [1, 2]) {
    assert.deepEqual(h.db.updatesFor(id), [{ visualChange: null, diffImagePath: null, diffPixelRatio: null }]);
  }
});

test("PIXELMATCH_OPTIONS contains only options of the installed pixelmatch", () => {
  const typings = fs.readFileSync(
    path.join(__dirname, "../../../../backend/node_modules/pixelmatch/index.d.ts"),
    "utf8"
  );
  const optionsBlock = /options\?: \{([\s\S]*?)\}\): number;/.exec(typings)?.[1] ?? "";
  const known = new Set([...optionsBlock.matchAll(/^\s*(\w+)\?:/gm)].map((match) => match[1]));
  assert.ok(known.size > 0);
  for (const key of Object.keys(PIXELMATCH_OPTIONS)) {
    assert.ok(known.has(key), `unknown pixelmatch option ${key}`);
  }
  assert.equal(PIXELMATCH_OPTIONS.threshold, PIXELMATCH_THRESHOLD);
  assert.equal(PIXELMATCH_OPTIONS.includeAA, false);
});

test("writes diff.png through ArtifactStore for changed and unchanged", async () => {
  const same = solidPng(20, 20, WHITE);
  const changed = withRect(solidPng(20, 20, WHITE), { x: 0, y: 0, w: 10, h: 10 }, RED);
  const h = setup([1, 2], {
    [artifactPath(1, "base")]: encodePng(same),
    [artifactPath(1, "head")]: encodePng(same),
    [artifactPath(2, "base")]: encodePng(same),
    [artifactPath(2, "head")]: encodePng(changed)
  });
  const results = await h.service.diff(h.handle.context, [
    {
      componentId: 2,
      base: okSide("base", 2, 20, 20),
      head: okSide("head", 2, 20, 20),
      states: []
    },
    {
      componentId: 1,
      base: okSide("base", 1, 20, 20),
      head: okSide("head", 1, 20, 20),
      states: []
    }
  ]);
  assert.deepEqual(
    results.map((result) => result.componentId),
    [1, 2]
  );
  for (const id of [1, 2]) {
    const written = h.store.files.get(artifactPath(id, "diff"));
    assert.ok(written, `diff.png of ${String(id)} written`);
    assert.equal(decodePng(written).width, 20);
  }
  assert.equal(h.db.updatesFor(1)[0]?.visualChange, "unchanged");
  assert.equal(h.db.updatesFor(2)[0]?.visualChange, "changed");
});

test("persists ratio as a number rounded to 6 decimals, dimensions and visual_change", async () => {
  const base = solidPng(7, 3, WHITE);
  const head = withRect(solidPng(7, 3, WHITE), { x: 3, y: 1, w: 1, h: 1 }, RED);
  const { results, values } = await diffPair(base, head);
  assert.deepEqual(values, {
    visualChange: "changed",
    diffImagePath: "artifacts/1/1/diff.png",
    diffPixelRatio: 0.047619,
    imageWidth: 7,
    imageHeight: 3
  });
  assert.equal(typeof values.diffPixelRatio, "number");
  assert.deepEqual(results, [
    {
      componentId: 1,
      diffImagePath: "artifacts/1/1/diff.png",
      diffPixelRatio: 0.047619,
      width: 7,
      height: 3,
      states: []
    }
  ]);
});

test("new and deleted set visual_change and dimensions without diff", async () => {
  const h = setup([1, 2]);
  const results = await h.service.diff(h.handle.context, [
    { componentId: 1, base: null, head: okSide("head", 1, 320, 200), states: [] },
    { componentId: 2, base: okSide("base", 2, 640, 480), head: null, states: [] }
  ]);
  assert.deepEqual(results, []);
  assert.deepEqual(h.db.updatesFor(1), [
    {
      visualChange: "new",
      imageWidth: 320,
      imageHeight: 200,
      diffImagePath: null,
      diffPixelRatio: null
    }
  ]);
  assert.deepEqual(h.db.updatesFor(2), [
    {
      visualChange: "deleted",
      imageWidth: 640,
      imageHeight: 480,
      diffImagePath: null,
      diffPixelRatio: null
    }
  ]);
  assert.equal(h.store.reads.length, 0);
  assert.ok(h.handle.console.has("info", "0 changed, 0 unchanged, 1 new, 1 removed, 0 not compared."));
});

test("failed side leaves visual_change null and returns no result", async () => {
  const h = setup([1]);
  const results = await h.service.diff(h.handle.context, [
    { componentId: 1, base: okSide("base", 1), head: failedSide("head"), states: [] }
  ]);
  assert.deepEqual(results, []);
  assert.deepEqual(h.db.updatesFor(1), [{ visualChange: null, diffImagePath: null, diffPixelRatio: null }]);
  assert.ok(h.handle.console.has("info", "Comparing screenshots for 1 components."));
  assert.ok(h.handle.console.has("info", "0 changed, 0 unchanged, 0 new, 0 removed, 1 not compared."));
});

test("missing screenshot is captured per component, not thrown", async () => {
  const png = encodePng(solidPng(10, 10, WHITE));
  const h = setup([1, 2], {
    [artifactPath(1, "head")]: png,
    [artifactPath(2, "base")]: png,
    [artifactPath(2, "head")]: png
  });
  const results = await h.service.diff(h.handle.context, [
    { componentId: 1, base: okSide("base", 1), head: okSide("head", 1), states: [] },
    { componentId: 2, base: okSide("base", 2), head: okSide("head", 2), states: [] }
  ]);
  assert.deepEqual(
    results.map((result) => result.componentId),
    [2]
  );
  assert.ok(h.handle.console.has("warn", "Could not compare screenshots for Comp1: missing screenshot."));
  assert.deepEqual(h.db.updatesFor(1), [{ visualChange: null, diffImagePath: null, diffPixelRatio: null }]);
});

test("corrupt PNG is captured per component", async () => {
  const h = setup([1], {
    [artifactPath(1, "base")]: Buffer.from("not a png"),
    [artifactPath(1, "head")]: encodePng(solidPng(10, 10, WHITE))
  });
  assert.deepEqual(
    await h.service.diff(h.handle.context, [
      { componentId: 1, base: okSide("base", 1), head: okSide("head", 1), states: [] }
    ]),
    []
  );
  assert.ok(h.handle.console.has("warn", "Could not compare screenshots for Comp1: invalid PNG."));
  assert.deepEqual(h.db.updatesFor(1), [{ visualChange: null, diffImagePath: null, diffPixelRatio: null }]);
});

test("diff image write failure is captured per component without a partial row update", async () => {
  const png = encodePng(solidPng(10, 10, WHITE));
  const h = setup([1], {
    [artifactPath(1, "base")]: png,
    [artifactPath(1, "head")]: png
  });
  h.store.failWrites = true;
  assert.deepEqual(
    await h.service.diff(h.handle.context, [
      { componentId: 1, base: okSide("base", 1), head: okSide("head", 1), states: [] }
    ]),
    []
  );
  assert.ok(h.handle.console.has("warn", "Could not compare screenshots for Comp1: could not write diff image."));
  assert.deepEqual(h.db.updatesFor(1), [{ visualChange: null, diffImagePath: null, diffPixelRatio: null }]);
});

test("never writes visualizations.changed_count", async () => {
  const png = encodePng(solidPng(10, 10, WHITE));
  const h = setup([1, 2, 3], {
    [artifactPath(1, "base")]: png,
    [artifactPath(1, "head")]: png
  });
  await h.service.diff(h.handle.context, [
    { componentId: 1, base: okSide("base", 1), head: okSide("head", 1), states: [] },
    { componentId: 2, base: null, head: okSide("head", 2), states: [] },
    { componentId: 3, base: okSide("base", 3), head: null, states: [] }
  ]);
  assert.equal(h.db.callsFor("update", Table.VISUALIZATIONS).length, 0);
  assert.ok(h.db.updates.every((update) => !("changedCount" in update.values)));
});

test("throws IMAGE_DIFF_PERSIST_FAILED on update error", async () => {
  const h = setup([1]);
  h.db.failNext("update");
  await assert.rejects(
    h.service.diff(h.handle.context, [{ componentId: 1, base: null, head: okSide("head", 1), states: [] }]),
    (error: unknown) =>
      error instanceof PipelineStepError &&
      error.code === "IMAGE_DIFF_PERSIST_FAILED" &&
      error.stage === "diffing" &&
      error.userMessage === "Could not save the image comparison results."
  );
});

test("throws IMAGE_DIFF_CANCELLED when cancelled", async () => {
  const h = setup([1, 2]);
  h.handle.cancel();
  await assert.rejects(
    h.service.diff(h.handle.context, [{ componentId: 1, base: null, head: okSide("head", 1), states: [] }]),
    (error: unknown) =>
      error instanceof PipelineStepError && error.code === "IMAGE_DIFF_CANCELLED" && error.userMessage === "Cancelled."
  );
  assert.equal(h.db.updates.length, 0);
});
