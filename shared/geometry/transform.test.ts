import { describe, expect, it } from 'vitest';
import { computeCalibration, distanceToPixels, fitCamera, mapToScreen, pixelsToDistance, screenToMap, zoomAt, CalibrationError, distance } from './transform';
import { fromMeters, toMeters, convert, formatDistance } from '../units';
import { gridSpacingPixels, gridStride, shouldDrawGrid, snapToGrid, DEFAULT_GRID } from './grid';

describe('units', () => {
  it('converts exactly', () => {
    expect(toMeters(1, 'mi')).toBe(1609.344);
    expect(convert(5280, 'ft', 'mi')).toBeCloseTo(1, 12);
    expect(fromMeters(1.524, 'ft')).toBeCloseTo(5, 12);
    expect(formatDistance(1.524 * 7, 'ft')).toBe('35.0 ft');
  });
});

describe('camera transforms', () => {
  const cam = { x: 120, y: -40, zoom: 2.5 };
  it('round-trips screen and map coordinates', () => {
    const p = { x: 333.3, y: 71.7 };
    const back = screenToMap(mapToScreen(p, cam), cam);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });
  it('keeps the anchor fixed while zooming', () => {
    const anchor = { x: 400, y: 300 };
    const before = screenToMap(anchor, cam);
    const after = screenToMap(anchor, zoomAt(cam, anchor, 1.7));
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
  it('fits and centres a map', () => {
    const c = fitCamera(4000, 2000, 1000, 800, 0);
    expect(c.zoom).toBeCloseTo(0.25);
    expect(screenToMap({ x: 500, y: 400 }, c)).toEqual({ x: 2000, y: 1000 });
  });
});

describe('two-point calibration (spec section 5.2)', () => {
  it('stores scale independent of zoom: 1 mile = 400 px', () => {
    const cal = computeCalibration({ x: 100, y: 100 }, { x: 500, y: 100 }, 1, 'mi');
    expect(cal.pixelsPerMeter).toBeCloseTo(400 / 1609.344, 12);
    // 100-ft grid on a mile-scale map is ~7.58 native pixels.
    const grid = { intervalMeters: toMeters(100, 'ft') };
    expect(gridSpacingPixels(grid, cal.pixelsPerMeter)).toBeCloseTo(7.5758, 3);
    // Too dense to draw at low zoom, drawable when zoomed in.
    expect(shouldDrawGrid(7.5758, 0.5)).toBe(false);
    expect(shouldDrawGrid(7.5758, 2)).toBe(true);
  });

  it('thins a too-dense grid to every 2nd, 5th, 10th… line instead of hiding it', () => {
    expect(gridStride(10, 1)).toBe(1);
    expect(gridStride(3.37, 1)).toBe(2);
    expect(gridStride(3.37, 0.85)).toBe(5);
    expect(gridStride(3.37, 0.1)).toBe(20);
    expect(gridStride(0.001, 1)).toBe(10000);
    expect(gridStride(0, 1)).toBe(0);
  });

  it('measures distances on an interior map (30 ft reference)', () => {
    const cal = computeCalibration({ x: 0, y: 0 }, { x: 300, y: 400 }, 30, 'ft');
    // Reference is 500 px for 30 ft; a 250 px span is 15 ft regardless of zoom.
    expect(fromMeters(pixelsToDistance(250, cal.pixelsPerMeter), 'ft')).toBeCloseTo(15, 9);
    expect(distanceToPixels(toMeters(5, 'ft'), cal.pixelsPerMeter)).toBeCloseTo(83.333, 3);
    // Measurement is in native pixels, so camera zoom never enters the calculation.
    const a = screenToMap({ x: 10, y: 10 }, { x: 0, y: 0, zoom: 3 });
    const b = screenToMap({ x: 760, y: 10 }, { x: 0, y: 0, zoom: 3 });
    expect(fromMeters(pixelsToDistance(distance(a, b), cal.pixelsPerMeter), 'ft')).toBeCloseTo(15, 9);
  });

  it('rejects invalid inputs', () => {
    expect(() => computeCalibration({ x: 1, y: 1 }, { x: 1, y: 1 }, 5, 'ft')).toThrow(CalibrationError);
    expect(() => computeCalibration({ x: 0, y: 0 }, { x: 10, y: 0 }, 0, 'ft')).toThrow(CalibrationError);
    expect(() => computeCalibration({ x: 0, y: 0 }, { x: 10, y: 0 }, -3, 'ft')).toThrow(CalibrationError);
  });
});

describe('grid snapping', () => {
  it('snaps to square cell centres honouring origin', () => {
    const g = { ...DEFAULT_GRID, originX: 10, originY: 10 };
    expect(snapToGrid({ x: 12, y: 58 }, g, 50)).toEqual({ x: 35, y: 35 });
    expect(snapToGrid({ x: 61, y: 61 }, g, 50)).toEqual({ x: 85, y: 85 });
  });
  it('snaps to hex centres', () => {
    const g = { ...DEFAULT_GRID, type: 'hex' as const };
    const p = snapToGrid({ x: 1, y: 1 }, g, 50);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
    const q = snapToGrid({ x: 48, y: 3 }, g, 50);
    expect(q.x).toBeCloseTo(50);
    expect(q.y).toBeCloseTo(0);
  });
  it('does not snap when disabled', () => {
    expect(snapToGrid({ x: 12, y: 13 }, { ...DEFAULT_GRID, snapEnabled: false }, 50)).toEqual({ x: 12, y: 13 });
  });
});
