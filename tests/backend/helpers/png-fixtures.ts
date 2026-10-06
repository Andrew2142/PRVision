/**
 * Shared PNG builders (sheet 14 §5.4.7). Signatures match sheet 11's area helper (`solidPng` returns a PNG,
 * `withRect(png, rect, rgba)`), so it can re-export these.
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

export type Rgba = [number, number, number, number];
export const COLORS = {
  white: [255, 255, 255, 255],
  black: [0, 0, 0, 255],
  red: [255, 0, 0, 255],
  /* Tailwind v4 emerald-600 ≈ oklch(59.6% 0.145 163.225) */
  emerald: [0, 153, 102, 255],
  /* fixture --color-brand-600 #4f46e5 */
  indigo: [79, 70, 229, 255],
  transparent: [0, 0, 0, 0]
} as const satisfies Record<string, Readonly<Rgba>>;

/** A width × height PNG filled with one colour. */
export function solidPng(width: number, height: number, rgba: Readonly<Rgba>): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data.set(rgba, i * 4);
  }
  return png;
}

/** Paints a rectangle in place and returns the same PNG (clipped to the image). */
export function withRect(png: PNG, rect: { x: number; y: number; w: number; h: number }, rgba: Readonly<Rgba>): PNG {
  for (let y = Math.max(0, rect.y); y < Math.min(png.height, rect.y + rect.h); y += 1) {
    for (let x = Math.max(0, rect.x); x < Math.min(png.width, rect.x + rect.w); x += 1) {
      png.data.set(rgba, (y * png.width + x) * 4);
    }
  }
  return png;
}

/** Deterministic noise (mulberry32) for "everything differs" cases. */
export function noisePng(width: number, height: number, seed = 1): PNG {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data.set([Math.floor(next() * 256), Math.floor(next() * 256), Math.floor(next() * 256), 255], i * 4);
  }
  return png;
}

export const encodePng = (png: PNG): Buffer => PNG.sync.write(png);
export const decodePng = (buffer: Buffer): PNG => PNG.sync.read(buffer);

/** Writes `png` to `<dir>/<relativePath>` (creating folders) and returns the absolute path. */
export function writePng(dir: string, relativePath: string, png: PNG): string {
  const full = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, encodePng(png));
  return full;
}

export const readPng = (filePath: string): PNG => decodePng(fs.readFileSync(filePath));

/** RGBA of one pixel. */
export function pixelAt(png: PNG, x: number, y: number): Rgba {
  const o = (y * png.width + x) * 4;
  return [png.data[o] ?? 0, png.data[o + 1] ?? 0, png.data[o + 2] ?? 0, png.data[o + 3] ?? 0];
}

/** Most frequent opaque non-white colour inside a region; used by render ITs to check button colours. */
export function dominantColour(png: PNG, region = { x: 0, y: 0, w: png.width, h: png.height }): Rgba | null {
  const counts = new Map<string, number>();
  for (let y = region.y; y < region.y + region.h; y += 1) {
    for (let x = region.x; x < region.x + region.w; x += 1) {
      const [r, g, b, a] = pixelAt(png, x, y);
      if (a < 255 || (r > 245 && g > 245 && b > 245)) {
        continue;
      }
      const key = `${r},${g},${b}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) {
    return null;
  }
  const [r = 0, g = 0, b = 0] = best[0].split(",").map(Number);
  return [r, g, b, 255];
}
