import { describe, expect, it } from 'vitest';
import { BUILDING_TYPES, generateFloorplan, validateFloorplan, FloorplanError, type FloorplanInput } from './floorplan';

const base: FloorplanInput = { name: 'The Broken Crown', buildingType: 'tavern', width: 60, depth: 40, unit: 'ft', floors: 2, basement: true, density: 'normal', theme: 'medieval', seed: 'crown-1' };

describe('floorplan generator (spec 6.3)', () => {
  it('keeps the exact requested outside dimensions', () => {
    const fp = generateFloorplan(base);
    expect(fp.widthM).toBeCloseTo(60 * 0.3048, 6);
    expect(fp.depthM).toBeCloseTo(40 * 0.3048, 6);
    for (const f of fp.floors) {
      expect(Math.max(...f.rooms.map((r) => r.x + r.w))).toBeCloseTo(fp.widthM, 4);
      expect(Math.max(...f.rooms.map((r) => r.y + r.h))).toBeCloseTo(fp.depthM, 4);
    }
  });

  it('is reproducible for the same input and seed', () => {
    expect(JSON.stringify(generateFloorplan(base))).toBe(JSON.stringify(generateFloorplan(base)));
  });

  it('usually differs between seeds', () => {
    const layouts = new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(generateFloorplan({ ...base, seed: `s${i}` }).floors[1]!.rooms)));
    expect(layouts.size).toBeGreaterThanOrEqual(7);
  });

  it('produces valid, connected floors with aligned stairs across many types, sizes and seeds', () => {
    let checked = 0;
    for (const buildingType of BUILDING_TYPES)
      for (const [width, depth, unit] of [
        [60, 40, 'ft'],
        [20, 20, 'ft'],
        [150, 90, 'ft'],
        [25, 80, 'ft'],
        [12, 9, 'm'],
      ] as const)
        for (const floors of [1, 3])
          for (let seed = 0; seed < 3; seed++) {
            const fp = generateFloorplan({ ...base, buildingType, width, depth, unit, floors, basement: seed === 1, seed: `seed-${seed}` });
            const errs = validateFloorplan(fp);
            expect(errs, `${buildingType} ${width}x${depth}${unit} floors=${floors} seed=${seed}`).toEqual([]);
            expect(fp.floors).toHaveLength(floors + (seed === 1 ? 1 : 0));
            if (fp.floors.length > 1) expect(fp.floors.every((f) => f.stairs)).toBe(true);
            expect(fp.floors.find((f) => f.level === 0)!.doors.some((d) => d.between.includes('outside'))).toBe(true);
            checked++;
          }
    expect(checked).toBe(BUILDING_TYPES.length * 5 * 2 * 3);
  });

  it('includes the program rooms for a tavern', () => {
    const names = generateFloorplan(base).floors.find((f) => f.level === 0)!.rooms.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Common room', 'Kitchen']));
  });

  it('rejects invalid input', () => {
    expect(() => generateFloorplan({ ...base, width: 10 })).toThrow(FloorplanError);
    expect(() => generateFloorplan({ ...base, floors: 9 })).toThrow(FloorplanError);
    expect(() => generateFloorplan({ ...base, seed: ' ' })).toThrow(FloorplanError);
  });

  it('detects broken geometry', () => {
    const fp = generateFloorplan(base);
    const f = fp.floors[1]!;
    f.doors = f.doors.filter((d) => !d.between.includes(f.rooms[f.rooms.length - 1]!.id));
    f.rooms[0]!.w += 2;
    const errs = validateFloorplan(fp);
    expect(errs.some((e) => e.includes('cannot be reached') || e.includes('overlaps'))).toBe(true);
  });
});
