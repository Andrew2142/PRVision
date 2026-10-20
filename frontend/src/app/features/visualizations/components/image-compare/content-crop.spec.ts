import { contentCrop, type PixelData } from './content-crop';

/** A white image with the given rectangles painted black. */
function image(width: number, height: number, boxes: { x: number; y: number; w: number; h: number }[]): PixelData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const b of boxes) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  }
  return { width, height, data };
}

describe('contentCrop', () => {
  it('boxes the content with padding and reports the background colour', () => {
    expect(contentCrop([image(100, 80, [{ x: 30, y: 20, w: 10, h: 5 }])], 4)).toEqual({
      x: 26,
      y: 16,
      width: 18,
      height: 13,
      imageWidth: 100,
      imageHeight: 80,
      background: 'rgb(255, 255, 255)',
    });
  });

  it('one crop covers the content of every image so before and after line up', () => {
    const before = image(100, 80, [{ x: 10, y: 10, w: 10, h: 10 }]);
    const after = image(100, 80, [{ x: 50, y: 40, w: 10, h: 20 }]);
    const crop = contentCrop([before, after], 0);
    expect(crop).toEqual(jasmine.objectContaining({ x: 10, y: 10, width: 50, height: 50 }));
  });

  it('clamps the padding at the image edges', () => {
    const crop = contentCrop([image(50, 50, [{ x: 0, y: 0, w: 50, h: 2 }])], 24);
    expect(crop).toEqual(jasmine.objectContaining({ x: 0, y: 0, width: 50, height: 26 }));
  });

  it('ignores anti-aliasing noise close to the background', () => {
    const noisy = image(20, 20, []);
    noisy.data[(5 * 20 + 5) * 4] = 250;
    expect(contentCrop([noisy])).toBeNull();
  });

  it('is null for blank images, no images, or images of different sizes', () => {
    expect(contentCrop([image(20, 20, [])])).toBeNull();
    expect(contentCrop([])).toBeNull();
    expect(contentCrop([image(20, 20, [{ x: 1, y: 1, w: 2, h: 2 }]), image(30, 20, [])])).toBeNull();
  });
});
