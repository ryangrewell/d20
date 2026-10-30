import { describe, expect, it } from 'vitest';
import type { SceneObject } from '../model';
import { lightPolygon, partyLights } from './light';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('lightPolygon', () => {
  it('stops at a wall', () => {
    const poly = lightPolygon({ x: 50, y: 50 }, 100, [{ a: { x: 80, y: -200 }, b: { x: 80, y: 300 } }]);
    expect(Math.max(...poly.map((p) => p.x))).toBeLessThanOrEqual(80.01);
    expect(poly.some((p) => p.x < 0)).toBe(true);
  });

  it('is a radius-capped circle without walls', () => {
    const poly = lightPolygon({ x: 0, y: 0 }, 100, []);
    expect(poly.length).toBeGreaterThanOrEqual(96);
    expect(poly.length).toBeLessThanOrEqual(200);
    expect(poly.every((p) => dist(p, { x: 0, y: 0 }) <= 100.01)).toBe(true);
  });
});

describe('partyLights', () => {
  const base = { sceneId: 's', campaignId: 'c', x: 10, y: 10, rotationRadians: 0, zIndex: 1, appearance: {}, revision: 1, createdAt: '', updatedAt: '' } as const;
  it('only lights visible party tokens with a radius', () => {
    const objects: SceneObject[] = [
      { ...base, id: 'pc', objectType: 'PC', visibility: 'VISIBLE_TO_ALL', lightRadiusMeters: 3 },
      { ...base, id: 'hidden', objectType: 'PC', visibility: 'GM_ONLY', lightRadiusMeters: 3 },
      { ...base, id: 'ghoul', objectType: 'CREATURE', visibility: 'VISIBLE_TO_ALL', lightRadiusMeters: 3 },
      { ...base, id: 'dark', objectType: 'PC', visibility: 'VISIBLE_TO_ALL' },
    ];
    expect(partyLights(objects, 10, [])).toHaveLength(1);
  });
});
