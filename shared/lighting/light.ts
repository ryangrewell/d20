/**
 * Torchlight: the area a light source can see, clipped by walls. Only party tokens the
 * players can see carry light; the server and the renderer compute the same shapes.
 */
import type { Point } from '../geometry/transform';
import type { FogShape } from '../fog';
import type { SceneObject } from '../model';
import type { Segment } from './walls';

const BASE_RAYS = 96;
const EPS = 0.0001;

/** Party tokens: player characters and anything a player controls. */
export function isPartyToken(o: Pick<SceneObject, 'objectType' | 'assignedControllerSub'>): boolean {
  return o.objectType === 'PC' || !!o.assignedControllerSub;
}

/** Distance along a unit ray to the nearest wall, or Infinity. */
function hitDistance(o: Point, dx: number, dy: number, w: Segment): number {
  const sx = w.b.x - w.a.x;
  const sy = w.b.y - w.a.y;
  const den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-12) return Infinity;
  const t = ((w.a.x - o.x) * sy - (w.a.y - o.y) * sx) / den;
  const u = ((w.a.x - o.x) * dy - (w.a.y - o.y) * dx) / den;
  return t >= 0 && u >= 0 && u <= 1 ? t : Infinity;
}

/**
 * Visibility polygon around `origin`, capped at `radiusPx` and stopped by `walls`.
 * Rays go to every wall corner (just either side of it) and to every point where a wall
 * crosses the light's edge, so the polygon's straight edges never cut behind a wall;
 * evenly spaced rays round out the open edge of the light.
 */
export function lightPolygon(origin: Point, radiusPx: number, walls: Segment[]): Point[] {
  const near = walls.filter((w) => segmentNear(origin, w, radiusPx));
  const angles: number[] = [];
  for (let i = 0; i < BASE_RAYS; i++) angles.push((i / BASE_RAYS) * Math.PI * 2);
  const toward = (p: Point) => {
    const a = Math.atan2(p.y - origin.y, p.x - origin.x);
    angles.push(a - EPS, a, a + EPS);
  };
  for (const w of near) {
    for (const p of [w.a, w.b]) if (Math.hypot(p.x - origin.x, p.y - origin.y) <= radiusPx) toward(p);
    for (const p of circleCrossings(origin, radiusPx, w)) toward(p);
  }
  const sorted = angles.map((a) => (a + Math.PI * 4) % (Math.PI * 2)).sort((a, b) => a - b);
  const points = sorted.map((a) => {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let t = radiusPx;
    for (const w of near) t = Math.min(t, hitDistance(origin, dx, dy, w));
    return { x: origin.x + dx * t, y: origin.y + dy * t };
  });
  return simplify(points);
}

/** Where a wall crosses the circle of light. */
function circleCrossings(o: Point, r: number, w: Segment): Point[] {
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const fx = w.a.x - o.x;
  const fy = w.a.y - o.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (a === 0 || disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].filter((t) => t >= 0 && t <= 1).map((t) => ({ x: w.a.x + t * dx, y: w.a.y + t * dy }));
}

/** Drops points that sit on a straight line between their neighbours (most hits along one wall). */
function simplify(points: Point[]): Point[] {
  if (points.length < 4) return points;
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = out.length ? out[out.length - 1]! : points[points.length - 1]!;
    const cur = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const cross = (cur.x - prev.x) * (next.y - prev.y) - (cur.y - prev.y) * (next.x - prev.x);
    const len = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    if (Math.abs(cross) / len > 0.05) out.push(cur);
  }
  return out.length >= 3 ? out : points;
}

function segmentNear(o: Point, w: Segment, r: number): boolean {
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((o.x - w.a.x) * dx + (o.y - w.a.y) * dy) / len2));
  return Math.hypot(w.a.x + t * dx - o.x, w.a.y + t * dy - o.y) <= r;
}

/** Current light shapes from party tokens the players can see. */
export function partyLights(objects: SceneObject[], pxPerMeter: number, walls: Segment[]): FogShape[] {
  return objects
    .filter((o) => isPartyToken(o) && o.visibility === 'VISIBLE_TO_ALL' && (o.lightRadiusMeters ?? 0) > 0)
    .map((o) => ({ kind: 'polygon' as const, points: lightPolygon({ x: o.x, y: o.y }, o.lightRadiusMeters! * pxPerMeter, walls) }));
}
