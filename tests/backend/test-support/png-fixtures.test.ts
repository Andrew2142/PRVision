import assert from "node:assert/strict";
import test from "node:test";
import {
  COLORS,
  decodePng,
  dominantColour,
  encodePng,
  noisePng,
  pixelAt,
  readPng,
  solidPng,
  withRect,
  writePng
} from "../helpers/png-fixtures";
import { useTempDataDir } from "../helpers/temp-dir";

test("solidPng and withRect paint the requested pixels", () => {
  const png = withRect(solidPng(10, 8, COLORS.white), { x: 2, y: 3, w: 4, h: 2 }, COLORS.red);
  assert.equal(png.width, 10);
  assert.equal(png.height, 8);
  assert.deepEqual(pixelAt(png, 0, 0), [...COLORS.white]);
  assert.deepEqual(pixelAt(png, 2, 3), [...COLORS.red]);
  assert.deepEqual(pixelAt(png, 5, 4), [...COLORS.red]);
  assert.deepEqual(pixelAt(png, 6, 4), [...COLORS.white]);
  assert.deepEqual(pixelAt(png, 2, 5), [...COLORS.white]);
});

test("withRect clips at the edges", () => {
  const png = withRect(solidPng(4, 4, COLORS.white), { x: -2, y: 2, w: 10, h: 10 }, COLORS.black);
  assert.deepEqual(pixelAt(png, 0, 2), [...COLORS.black]);
  assert.deepEqual(pixelAt(png, 3, 3), [...COLORS.black]);
  assert.deepEqual(pixelAt(png, 3, 1), [...COLORS.white]);
  assert.equal(png.data.length, 4 * 4 * 4);
});

test("noisePng is deterministic per seed and differs across seeds", () => {
  assert.deepEqual(noisePng(16, 16, 7).data, noisePng(16, 16, 7).data);
  assert.notDeepEqual(noisePng(16, 16, 7).data, noisePng(16, 16, 8).data);
});

test("encodePng/decodePng round-trip", (t) => {
  const png = withRect(solidPng(6, 5, COLORS.indigo), { x: 1, y: 1, w: 2, h: 2 }, COLORS.emerald);
  const decoded = decodePng(encodePng(png));
  assert.equal(decoded.width, 6);
  assert.equal(decoded.height, 5);
  assert.deepEqual(decoded.data, png.data);
  const file = writePng(useTempDataDir(t), "a/b/image.png", png);
  assert.deepEqual(readPng(file).data, png.data);
});

test("dominantColour ignores white and transparent pixels", () => {
  const png = solidPng(10, 10, COLORS.white);
  withRect(png, { x: 0, y: 0, w: 10, h: 4 }, COLORS.transparent);
  withRect(png, { x: 0, y: 4, w: 3, h: 1 }, COLORS.emerald);
  withRect(png, { x: 0, y: 5, w: 2, h: 1 }, COLORS.indigo);
  assert.deepEqual(dominantColour(png), [...COLORS.emerald]);
  assert.equal(dominantColour(solidPng(3, 3, COLORS.white)), null);
  assert.deepEqual(dominantColour(png, { x: 0, y: 5, w: 10, h: 5 }), [...COLORS.indigo]);
});
