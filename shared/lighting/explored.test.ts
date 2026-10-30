import { describe, expect, it } from 'vitest';
import { createExplored, decodeExplored, encodeExplored, exploredContains, markPolygon } from './explored';

describe('explored grid', () => {
  it('is bounded to 512 cells on the long side', () => {
    const g = createExplored(4096, 4096);
    expect(g.cellPx).toBe(8);
    expect(g.cols).toBe(512);
    expect(createExplored(600, 400).cellPx).toBe(4);
  });

  it('marks a polygon and reports whether anything changed', () => {
    const g = createExplored(600, 400);
    const square = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }];
    expect(markPolygon(g, square)).toBe(true);
    expect(markPolygon(g, square)).toBe(false);
    expect(exploredContains(g, { x: 150, y: 150 })).toBe(true);
    expect(exploredContains(g, { x: 300, y: 300 })).toBe(false);
  });

  it('round-trips compactly on a big map', () => {
    const g = createExplored(4096, 4096);
    markPolygon(g, [{ x: 500, y: 500 }, { x: 1500, y: 500 }, { x: 1500, y: 1500 }, { x: 500, y: 1500 }]);
    const s = encodeExplored(g);
    expect(s.length).toBeLessThan(8000);
    const back = decodeExplored(s);
    expect([back.cellPx, back.cols, back.rows]).toEqual([g.cellPx, g.cols, g.rows]);
    expect(Array.from(back.bits)).toEqual(Array.from(g.bits));
  });
});
