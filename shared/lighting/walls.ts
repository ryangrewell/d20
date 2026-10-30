/**
 * Walls and rooms for automatic fog reveal. Rooms are polygons in map pixels;
 * their outlines are the walls, minus doorway gaps that let light through.
 * Generated maps derive these from the floorplan; uploaded maps are drawn by the GM.
 */
import type { Point } from '../geometry/transform';
import type { Floor } from '../generator/floorplan';
import { distToSegmentSq, pointInPolygon } from '../fog';

export type Segment = { a: Point; b: Point };
export type WallRoom = { id: string; name?: string; points: Point[] };
/** `generated`: derived from the interior generator (read-only in the editor). */
export type MapWalls = { rooms: WallRoom[]; doorways: Segment[]; generated?: boolean };

const DOORWAY_TOLERANCE = 2;
const EDGE_TOLERANCE = 0.5;

function edges(points: Point[]): Segment[] {
  return points.map((a, i) => ({ a, b: points[(i + 1) % points.length]! }));
}

const pointKey = (p: Point) => `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`;
const segKey = (s: Segment) => [pointKey(s.a), pointKey(s.b)].sort().join('|');

/** Parameter range [t0, t1] of `d` along edge `e`, or null when `d` isn't on that edge. */
function overlapOnEdge(e: Segment, d: Segment): [number, number] | null {
  if (distToSegmentSq(d.a, e.a, e.b) > DOORWAY_TOLERANCE ** 2 || distToSegmentSq(d.b, e.a, e.b) > DOORWAY_TOLERANCE ** 2) return null;
  const dx = e.b.x - e.a.x;
  const dy = e.b.y - e.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return null;
  const t = (p: Point) => ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / len2;
  const [t0, t1] = [t(d.a), t(d.b)].sort((x, y) => x - y) as [number, number];
  const lo = Math.max(0, t0);
  const hi = Math.min(1, t1);
  return hi > lo ? [lo, hi] : null;
}

/** Every wall segment light can't pass: room edges (shared ones once) with doorway gaps cut out. */
export function wallSegments(walls: MapWalls): Segment[] {
  const seen = new Set<string>();
  const out: Segment[] = [];
  for (const room of walls.rooms) {
    for (const e of edges(room.points)) {
      const k = segKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      const gaps = walls.doorways.map((d) => overlapOnEdge(e, d)).filter((g): g is [number, number] => !!g).sort((x, y) => x[0] - y[0]);
      const at = (t: number): Point => ({ x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t });
      let from = 0;
      for (const [g0, g1] of gaps) {
        if (g0 > from) out.push({ a: at(from), b: at(g0) });
        from = Math.max(from, g1);
      }
      if (from < 1) out.push({ a: at(from), b: at(1) });
    }
  }
  return out;
}

/** Rooms that contain `p`; a point on a wall counts as inside every room sharing that wall. */
export function roomsContaining(walls: MapWalls, p: Point): WallRoom[] {
  return walls.rooms.filter((r) => r.points.length >= 3 && (pointInPolygon(p, r.points) || edges(r.points).some((e) => distToSegmentSq(p, e.a, e.b) <= EDGE_TOLERANCE ** 2)));
}

/** A generated floor's rooms (every kind) and doors, in map pixels. Windows stay solid walls. */
export function floorplanToWalls(floor: Floor, pxPerMeter: number): MapWalls {
  const k = pxPerMeter;
  return {
    rooms: floor.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      points: [
        { x: r.x * k, y: r.y * k },
        { x: (r.x + r.w) * k, y: r.y * k },
        { x: (r.x + r.w) * k, y: (r.y + r.h) * k },
        { x: r.x * k, y: (r.y + r.h) * k },
      ],
    })),
    doorways: floor.doors.map((d) =>
      d.orientation === 'h'
        ? { a: { x: (d.x - d.width / 2) * k, y: d.y * k }, b: { x: (d.x + d.width / 2) * k, y: d.y * k } }
        : { a: { x: d.x * k, y: (d.y - d.width / 2) * k }, b: { x: d.x * k, y: (d.y + d.width / 2) * k } },
    ),
  };
}
