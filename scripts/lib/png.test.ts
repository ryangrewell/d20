import { describe, expect, it } from 'vitest';
import { crop, decodePng, encodePng, isEmpty } from './png';

describe('png', () => {
  it('round-trips RGBA', () => {
    const data = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) % 256);
    const back = decodePng(encodePng({ width: 5, height: 3, data }));
    expect([back.width, back.height]).toEqual([5, 3]);
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });
  it('crops and spots empty frames', () => {
    const data = new Uint8Array(4 * 4 * 4);
    data.set([255, 0, 0, 255], (2 * 4 + 3) * 4);
    const img = { width: 4, height: 4, data };
    expect(isEmpty(crop(img, 0, 0, 2, 2))).toBe(true);
    expect(Array.from(crop(img, 2, 2, 2, 2).data.subarray(4, 8))).toEqual([255, 0, 0, 255]);
  });
});
