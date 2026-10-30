import { describe, expect, it } from 'vitest';
import { generateFloorplan } from '../generator/floorplan';
import { floorplanToWalls, roomsContaining, wallSegments, type MapWalls } from './walls';

const rect = (id: string, x: number, y: number, w: number, h: number) => ({ id, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
const key = (s: { a: { x: number; y: number }; b: { x: number; y: number } }) => [s.a, s.b].map((p) => `${p.x},${p.y}`).sort().join('|');

describe('wallSegments', () => {
  it('splits an edge around a doorway', () => {
    const walls: MapWalls = { rooms: [rect('a', 0, 0, 100, 100)], doorways: [{ a: { x: 40, y: 0 }, b: { x: 60, y: 0 } }] };
    const segs = wallSegments(walls).map(key);
    expect(segs).toHaveLength(5);
    expect(segs).toContain('0,0|40,0');
    expect(segs).toContain('100,0|60,0');
    expect(segs).not.toContain('0,0|100,0');
  });

  it('lists an edge shared by two rooms once', () => {
    const walls: MapWalls = { rooms: [rect('a', 0, 0, 100, 100), rect('b', 100, 0, 100, 100)], doorways: [] };
    expect(wallSegments(walls)).toHaveLength(7);
  });
});

describe('roomsContaining', () => {
  const walls: MapWalls = { rooms: [rect('a', 0, 0, 100, 100), rect('b', 100, 0, 100, 100)], doorways: [] };
  it('counts a point on a shared edge as inside both rooms', () => {
    expect(roomsContaining(walls, { x: 100, y: 50 }).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
  it('finds the one room around an interior point', () => {
    expect(roomsContaining(walls, { x: 50, y: 50 }).map((r) => r.id)).toEqual(['a']);
  });
  it('returns nothing outside every room', () => {
    expect(roomsContaining(walls, { x: 500, y: 500 })).toEqual([]);
  });
});

describe('floorplanToWalls', () => {
  it('turns generated rooms and doors into map-pixel rooms and doorways', () => {
    const fp = generateFloorplan({ name: 'T', buildingType: 'tavern', width: 60, depth: 40, unit: 'ft', floors: 1, basement: false, density: 'normal', theme: 'medieval', seed: 'walls' });
    const floor = fp.floors[0]!;
    const walls = floorplanToWalls(floor, 10);
    expect(walls.rooms).toHaveLength(floor.rooms.length);
    expect(walls.doorways).toHaveLength(floor.doors.length);
    for (const r of walls.rooms) {
      for (const p of r.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(fp.widthM * 10 + 1e-6);
        expect(p.y).toBeLessThanOrEqual(fp.depthM * 10 + 1e-6);
      }
    }
  });
});
