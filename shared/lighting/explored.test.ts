import { describe, expect, it } from 'vitest';
import { createExplored, decodeExplored, encodeExplored, exploredStamp, markPolygon } from './explored';

const square = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

describe('explored grid', () => {
  it('is bounded to 512 cells on the long side', () => {
    const g = createExplored(4096, 4096);
    expect(g.cellPx).toBe(8);
    expect(g.cols).toBe(512);
    expect(createExplored(600, 400).cellPx).toBe(4);
  });

  it('stamps cells with when they were explored, and reports changes', () => {
    const g = createExplored(600, 400);
    expect(markPolygon(g, square(100, 100, 100), 1)).toBe(true);
    expect(markPolygon(g, square(100, 100, 100), 1)).toBe(false);
    expect(exploredStamp(g, { x: 150, y: 150 })).toBe(1);
    expect(exploredStamp(g, { x: 300, y: 300 })).toBe(0);
    // Exploring again after the GM painted more fog moves the stamp forward.
    expect(markPolygon(g, square(100, 100, 100), 4)).toBe(true);
    expect(exploredStamp(g, { x: 150, y: 150 })).toBe(4);
    // An older stamp never overwrites a newer one.
    expect(markPolygon(g, square(100, 100, 100), 2)).toBe(false);
  });

  it('round-trips stamps compactly on a big map', () => {
    const g = createExplored(4096, 4096);
    markPolygon(g, square(500, 500, 1000), 1);
    markPolygon(g, square(1200, 1200, 600), 7);
    const s = encodeExplored(g);
    expect(s.length).toBeLessThan(8000);
    const back = decodeExplored(s);
    expect([back.cellPx, back.cols, back.rows]).toEqual([g.cellPx, g.cols, g.rows]);
    expect(Array.from(back.stamps)).toEqual(Array.from(g.stamps));
  });
});
