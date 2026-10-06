/**
 * Pure PNG helpers for the image diff (11 §5.2.4) and the summary's screenshot cropping (11 §5.4.3).
 *
 * `readPngHeader` reads the IHDR dimensions without decompressing, so a tiny PNG declaring a huge canvas is refused
 * before pngjs allocates its pixel buffer (decompression-bomb guard, 11 §8).
 */
import { PNG } from "pngjs";
import { DIFF_MAX_HEIGHT, DIFF_MAX_WIDTH } from "../../../config-consts";

/** Why a PNG could not be used. */
export type ImageDecodeReason = "invalid_png" | "png_too_large";

/** Raised by the PNG helpers; `reason` is the per-component failure code of 11 §6. */
export class ImageDecodeError extends Error {
  override readonly name = "ImageDecodeError";

  constructor(
    readonly reason: ImageDecodeReason,
    message: string = reason
  ) {
    super(message);
  }
}

/** A rectangle in pixel coordinates. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_TYPE_OFFSET = 12;
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;
const IHDR_MIN_BYTES = 24;

/**
 * Reads width/height from the IHDR chunk without decompressing.
 *
 * @throws ImageDecodeError("invalid_png") when the signature or the IHDR chunk is missing or a dimension is 0;
 *   ImageDecodeError("png_too_large") when width > DIFF_MAX_WIDTH or height > DIFF_MAX_HEIGHT.
 */
export function readPngHeader(buf: Buffer): { width: number; height: number } {
  if (buf.length < IHDR_MIN_BYTES || !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new ImageDecodeError("invalid_png", "Missing PNG signature");
  }
  if (buf.toString("latin1", IHDR_TYPE_OFFSET, IHDR_TYPE_OFFSET + 4) !== "IHDR") {
    throw new ImageDecodeError("invalid_png", "Missing IHDR chunk");
  }
  const width = buf.readUInt32BE(IHDR_WIDTH_OFFSET);
  const height = buf.readUInt32BE(IHDR_HEIGHT_OFFSET);
  if (width === 0 || height === 0) {
    throw new ImageDecodeError("invalid_png", "PNG has a zero dimension");
  }
  if (width > DIFF_MAX_WIDTH || height > DIFF_MAX_HEIGHT) {
    throw new ImageDecodeError("png_too_large", "PNG dimensions exceed the decode limit");
  }
  return { width, height };
}

/**
 * Decodes a PNG to 8-bit RGBA. Call readPngHeader first (dimension guard).
 *
 * @throws ImageDecodeError("invalid_png") for anything pngjs cannot decode.
 */
export function decodePng(buf: Buffer): PNG {
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (error: unknown) {
    throw new ImageDecodeError("invalid_png", error instanceof Error ? error.message : "PNG decode failed");
  }
  if (png.width <= 0 || png.height <= 0) {
    throw new ImageDecodeError("invalid_png", "PNG has a zero dimension");
  }
  return png;
}

/** Encodes RGBA (colour type 6). */
export function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png, { colorType: 6 });
}

/** A width × height PNG of fully transparent black pixels. */
export function createTransparentPng(width: number, height: number): PNG {
  const png = new PNG({ width, height });
  png.data.fill(0);
  return png;
}

/** Copies the w × h region at (x, y) of `src` into a new PNG. The region must lie inside `src`. */
export function cropPng(src: PNG, x: number, y: number, w: number, h: number): PNG {
  const out = createTransparentPng(w, h);
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  return out;
}

/** Bounding box of pixels painted with any of `colors` at alpha 255 (diff and band pixels), or null. */
export function findDiffBoundingBox(
  diff: PNG,
  colors: ReadonlyArray<readonly [number, number, number]>
): PixelRect | null {
  const data = diff.data;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < diff.height; y += 1) {
    for (let x = 0; x < diff.width; x += 1) {
      const offset = (y * diff.width + x) * 4;
      if (data[offset + 3] !== 255) {
        continue;
      }
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      if (!colors.some(([cr, cg, cb]) => cr === r && cg === g && cb === b)) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) {
    return null;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * A window of at most maxEdge × maxEdge, centred on `bbox` (or at the top-left when bbox is null), clamped to the
 * width × height image.
 */
export function cropWindowAround(bbox: PixelRect | null, width: number, height: number, maxEdge: number): PixelRect {
  const w = Math.min(maxEdge, width);
  const h = Math.min(maxEdge, height);
  if (bbox === null) {
    return { x: 0, y: 0, w, h };
  }
  const centre = (start: number, size: number, edge: number, limit: number): number => {
    const ideal = Math.round(start + size / 2 - edge / 2);
    return Math.min(Math.max(ideal, 0), limit - edge);
  };
  return { x: centre(bbox.x, bbox.w, w, width), y: centre(bbox.y, bbox.h, h, height), w, h };
}
