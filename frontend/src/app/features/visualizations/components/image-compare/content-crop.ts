/** The part of a screenshot that holds the component, in image pixels, plus the page colour around it. */
export interface ContentCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Full image size the crop was measured on. */
  imageWidth: number;
  imageHeight: number;
  /** CSS colour of the screenshot's empty background (its bottom-right pixel). */
  background: string;
}

/** RGBA pixels as a canvas returns them. */
export interface PixelData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Room left around the component so its shadow and outline are not cut. */
export const CROP_PADDING = 24;
/** A channel must differ by more than this from the background to count as content (anti-aliasing noise). */
const TOLERANCE = 8;

/**
 * Smallest box holding every pixel that differs from the background in any of the images, padded and clamped.
 * All images must share one size (base and head render at one viewport). Null when the sizes differ or the
 * images are blank, so the caller shows the full screenshots.
 */
export function contentCrop(images: readonly PixelData[], padding = CROP_PADDING): ContentCrop | null {
  const first = images[0];
  if (!first || images.some((i) => i.width !== first.width || i.height !== first.height)) return null;
  const { width, height } = first;
  const bgAt = (width * height - 1) * 4;
  const bg = [first.data[bgAt] ?? 255, first.data[bgAt + 1] ?? 255, first.data[bgAt + 2] ?? 255];
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (const { data } of images) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const differs =
          Math.abs((data[i] ?? 0) - (bg[0] ?? 0)) > TOLERANCE ||
          Math.abs((data[i + 1] ?? 0) - (bg[1] ?? 0)) > TOLERANCE ||
          Math.abs((data[i + 2] ?? 0) - (bg[2] ?? 0)) > TOLERANCE;
        if (!differs) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  return {
    x,
    y,
    width: Math.min(width, right + 1 + padding) - x,
    height: Math.min(height, bottom + 1 + padding) - y,
    imageWidth: width,
    imageHeight: height,
    background: `rgb(${String(bg[0])}, ${String(bg[1])}, ${String(bg[2])})`,
  };
}

/** Loads an image with CORS (the artifacts route allows the frontend origin) and reads its pixels. */
function readPixels(src: string): Promise<PixelData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = (): void => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        reject(new Error('no 2d context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = (): void => {
      reject(new Error(`could not load ${src}`));
    };
    img.src = src;
  });
}

/** One crop shared by every given screenshot, so before and after line up; null when it cannot be measured. */
export async function measureContentCrop(srcs: readonly string[]): Promise<ContentCrop | null> {
  if (!srcs.length) return null;
  try {
    return contentCrop(await Promise.all(srcs.map(readPixels)));
  } catch {
    return null;
  }
}
