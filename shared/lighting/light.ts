/**
 * Torchlight: the area a light source can see, clipped by walls. Only party tokens the
 * players can see carry light; the server and the renderer compute the same shapes.
 */
import type { Point } from '../geometry/transform';
import type { FogShape } from '../fog';
import type { SceneObject } from '../model';
import type { Segment } from './walls';

const BASE_RAYS = 96;
const MAX_POINTS = 200;
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

/** Visibility polygon around `origin`, capped at `radiusPx` and stopped by `walls`. */
export function lightPolygon(origin: Point, radiusPx: number, walls: Segment[]): Point[] {
  const near = walls.filter((w) => Math.min(Math.hypot(w.a.x - origin.x, w.a.y - origin.y), Math.hypot(w.b.x - origin.x, w.b.y - origin.y)) <= radiusPx * 2 || segmentNear(origin, w, radiusPx));
  const angles: number[] = [];
  for (let i = 0; i < BASE_RAYS; i++) angles.push((i / BASE_RAYS) * Math.PI * 2);
  for (const w of near) {
    for (const p of [w.a, w.b]) {
      if (Math.hypot(p.x - origin.x, p.y - origin.y) > radiusPx) continue;
      const a = Math.atan2(p.y - origin.y, p.x - origin.x);
      angles.push(a - EPS, a + EPS);
    }
  }
  let sorted = angles.map((a) => (a + Math.PI * 4) % (Math.PI * 2)).sort((a, b) => a - b);
  if (sorted.length > MAX_POINTS) sorted = Array.from({ length: MAX_POINTS }, (_, i) => sorted[Math.floor((i * sorted.length) / MAX_POINTS)]!);
  return sorted.map((a) => {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let t = radiusPx;
    for (const w of near) t = Math.min(t, hitDistance(origin, dx, dy, w));
    return { x: origin.x + dx * t, y: origin.y + dy * t };
  });
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
