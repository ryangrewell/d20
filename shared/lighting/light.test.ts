import { describe, expect, it } from 'vitest';
import type { SceneObject } from '../model';
import { generateFloorplan } from '../generator/floorplan';
import { pointInPolygon } from '../fog';
import { lightPolygon, partyLights } from './light';
import { floorplanToWalls, wallSegments, type Segment } from './walls';

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

/** True when the open segment p→q passes through a wall (touching at the very ends doesn't count). */
function crossesWall(p: { x: number; y: number }, q: { x: number; y: number }, walls: Segment[]) {
  for (const w of walls) {
    const d = (q.x - p.x) * (w.b.y - w.a.y) - (q.y - p.y) * (w.b.x - w.a.x);
    if (Math.abs(d) < 1e-9) continue;
    const t = ((w.a.x - p.x) * (w.b.y - w.a.y) - (w.a.y - p.y) * (w.b.x - w.a.x)) / d;
    const u = ((w.a.x - p.x) * (q.y - p.y) - (w.a.y - p.y) * (q.x - p.x)) / d;
    if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) return true;
  }
  return false;
}

describe('lightPolygon on a map packed with walls', () => {
  // 40 x 40 grid of 100 px rooms, each with a doorway in its right and bottom walls.
  const rooms: { id: string; points: { x: number; y: number }[] }[] = [];
  const doorways: Segment[] = [];
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 40; j++) {
      const [x, y] = [i * 100, j * 100];
      rooms.push({ id: `${i}-${j}`, points: [{ x, y }, { x: x + 100, y }, { x: x + 100, y: y + 100 }, { x, y: y + 100 }] });
      doorways.push({ a: { x: x + 100, y: y + 40 }, b: { x: x + 100, y: y + 60 } }, { a: { x: x + 40, y: y + 100 }, b: { x: x + 60, y: y + 100 } });
    }
  const walls = wallSegments({ rooms, doorways });
  it('never lights anything a wall hides from the light', () => {
    for (const r of [270, 540, 800]) {
      for (const o of [{ x: 1033.3, y: 1047.7 }, { x: 2050.1, y: 1990.4 }, { x: 1510, y: 2520 }, { x: 3010.5, y: 960.2 }]) {
        const poly = lightPolygon(o, r, walls);
        for (let x = o.x - r; x <= o.x + r; x += r / 25)
          for (let y = o.y - r; y <= o.y + r; y += r / 25) {
            const q = { x, y };
            if (pointInPolygon(q, poly)) expect(crossesWall(o, q, walls), `r=${r} light ${o.x},${o.y} point ${x.toFixed(0)},${y.toFixed(0)}`).toBe(false);
          }
      }
    }
  });
});

describe('lightPolygon on a dense generated dungeon', () => {
  const fp = generateFloorplan({ name: 'D', buildingType: 'dungeon', width: 300, depth: 300, unit: 'ft', floors: 1, basement: false, density: 'dense', theme: 'medieval', seed: 'leak' });
  const ppm = 4096 / fp.widthM;
  const walls = wallSegments(floorplanToWalls(fp.floors[0]!, ppm));
  it('never lights anything a wall hides from the light', () => {
    for (const radiusM of [6, 12, 18]) {
      for (let gx = 1; gx < 8; gx++) {
        for (let gy = 1; gy < 8; gy++) {
          const o = { x: (gx * 4096) / 8 + 3.3, y: (gy * fp.depthM * ppm) / 8 + 2.7 };
          const poly = lightPolygon(o, radiusM * ppm, walls);
          // Every point the light shape covers must be in plain sight of the light.
          const r = radiusM * ppm;
          for (let x = o.x - r; x <= o.x + r; x += r / 12) {
            for (let y = o.y - r; y <= o.y + r; y += r / 12) {
              const q = { x, y };
              if (pointInPolygon(q, poly)) expect(crossesWall(o, q, walls), `r=${radiusM} light ${o.x.toFixed(0)},${o.y.toFixed(0)} point ${x.toFixed(0)},${y.toFixed(0)}`).toBe(false);
            }
          }
        }
      }
    }
  });
});
