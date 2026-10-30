import { describe, expect, it } from 'vitest';
import { decodePolygon, encodePolygon } from './wire';

describe('polygon wire encoding', () => {
  it('round-trips to whole pixels', () => {
    const pts = [{ x: 1033.4, y: 1047.6 }, { x: 0, y: 0 }, { x: 4095.9, y: 12.2 }, { x: 2000, y: 3999.5 }];
    expect(decodePolygon(encodePolygon(pts))).toEqual(pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
  });
  it('is several times smaller than JSON', () => {
    const pts = Array.from({ length: 180 }, (_, i) => ({ x: 2000 + Math.cos(i / 28.6) * 800.123, y: 2000 + Math.sin(i / 28.6) * 800.456 }));
    expect(encodePolygon(pts).length * 4).toBeLessThan(JSON.stringify(pts).length);
  });
});
