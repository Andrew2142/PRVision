import assert from "node:assert/strict";
import { test } from "node:test";
import pixelmatch from "pixelmatch";
import {
  ImageDecodeError,
  createTransparentPng,
  cropPng,
  cropWindowAround,
  decodePng,
  findDiffBoundingBox,
  readPngHeader
} from "../../../../backend/src/services/visualizations/pipeline/png-utils";
import { encodePng, pixelAt, solidPng, withRect } from "./helpers/png-fixtures";

const DIFF: readonly [number, number, number] = [255, 0, 80];
const ALT: readonly [number, number, number] = [0, 150, 255];

function isDecodeError(reason: ImageDecodeError["reason"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ImageDecodeError && error.reason === reason;
}

test("readPngHeader reads IHDR dimensions without decoding", () => {
  const full = encodePng(solidPng(30, 20, [10, 20, 30, 255]));
  assert.deepEqual(readPngHeader(full), { width: 30, height: 20 });
  // Signature + IHDR only: no image data at all, so this would fail any decode.
  assert.deepEqual(readPngHeader(full.subarray(0, 33)), {
    width: 30,
    height: 20
  });
});

test("readPngHeader rejects a tiny PNG declaring 100000x100000 as png_too_large", () => {
  const bomb = Buffer.from(encodePng(solidPng(2, 2, [0, 0, 0, 255])));
  bomb.writeUInt32BE(100_000, 16);
  bomb.writeUInt32BE(100_000, 20);
  assert.ok(bomb.length < 200);
  assert.throws(() => readPngHeader(bomb), isDecodeError("png_too_large"));
});

test("readPngHeader rejects a missing signature or IHDR as invalid_png", () => {
  assert.throws(() => readPngHeader(Buffer.from("definitely not a png file at all")), isDecodeError("invalid_png"));
  const noIhdr = Buffer.from(encodePng(solidPng(2, 2, [0, 0, 0, 255])));
  noIhdr.write("IDAT", 12, "latin1");
  assert.throws(() => readPngHeader(noIhdr), isDecodeError("invalid_png"));
});

test("pixelmatch default import is a function", () => {
  assert.equal(typeof pixelmatch, "function");
});

test("decodePng rejects garbage", () => {
  assert.throws(() => decodePng(Buffer.from("garbage bytes")), isDecodeError("invalid_png"));
  const truncated = encodePng(solidPng(30, 20, [10, 20, 30, 255])).subarray(0, 40);
  assert.throws(() => decodePng(truncated), isDecodeError("invalid_png"));
});

test("createTransparentPng is fully transparent", () => {
  const png = createTransparentPng(7, 5);
  assert.equal(png.width, 7);
  assert.equal(png.height, 5);
  assert.equal(png.data.length, 7 * 5 * 4);
  assert.ok(png.data.every((byte) => byte === 0));
});

test("cropPng copies the requested region", () => {
  const src = withRect(solidPng(20, 10, [255, 255, 255, 255]), { x: 5, y: 3, w: 4, h: 2 }, [255, 0, 0, 255]);
  const out = cropPng(src, 4, 2, 6, 4);
  assert.equal(out.width, 6);
  assert.equal(out.height, 4);
  assert.deepEqual(pixelAt(out, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(out, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(out, 4, 2), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(out, 5, 3), [255, 255, 255, 255]);
});

test("findDiffBoundingBox finds painted pixels only", () => {
  const diff = solidPng(50, 40, [200, 200, 200, 255]); // faded base pixels (grey) are not diff pixels
  withRect(diff, { x: 10, y: 5, w: 3, h: 2 }, [...DIFF, 255]);
  withRect(diff, { x: 30, y: 20, w: 1, h: 1 }, [...ALT, 255]);
  withRect(diff, { x: 45, y: 35, w: 2, h: 2 }, [...DIFF, 128]); // not opaque: ignored
  withRect(diff, { x: 0, y: 0, w: 2, h: 2 }, [255, 200, 0, 255]); // aaColor: ignored
  assert.deepEqual(findDiffBoundingBox(diff, [DIFF, ALT]), {
    x: 10,
    y: 5,
    w: 21,
    h: 16
  });
});

test("findDiffBoundingBox returns null for clean diff", () => {
  assert.equal(findDiffBoundingBox(solidPng(20, 20, [240, 240, 240, 255]), [DIFF, ALT]), null);
  assert.equal(findDiffBoundingBox(createTransparentPng(20, 20), [DIFF, ALT]), null);
});

test("cropWindowAround centres on bbox and clamps to image", () => {
  assert.deepEqual(cropWindowAround({ x: 1000, y: 3000, w: 100, h: 100 }, 1280, 4000, 1568), {
    x: 0,
    y: 2266,
    w: 1280,
    h: 1568
  });
  // Near the bottom edge the window is clamped inside the image.
  assert.deepEqual(cropWindowAround({ x: 0, y: 3950, w: 10, h: 40 }, 1280, 4000, 1568), {
    x: 0,
    y: 2432,
    w: 1280,
    h: 1568
  });
  // Near the top-left corner too.
  assert.deepEqual(cropWindowAround({ x: 5, y: 5, w: 10, h: 10 }, 2000, 2000, 1000), { x: 0, y: 0, w: 1000, h: 1000 });
});

test("cropWindowAround uses top-left without bbox", () => {
  assert.deepEqual(cropWindowAround(null, 1280, 4000, 1568), {
    x: 0,
    y: 0,
    w: 1280,
    h: 1568
  });
  assert.deepEqual(cropWindowAround(null, 300, 200, 1568), {
    x: 0,
    y: 0,
    w: 300,
    h: 200
  });
});
