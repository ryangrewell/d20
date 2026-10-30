/**
 * Manual fog of war. Fog is an ordered list of reveal/conceal operations over
 * an initial state. Both the renderer and the server-side projection evaluate
 * the same operations, so "is this point hidden from players?" has one answer.
 */
import type { Point } from './geometry/transform';
import { exploredContains, type ExploredGrid } from './lighting/explored';

export type FogShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'polygon'; points: Point[] }
  | { kind: 'brush'; radius: number; points: Point[] };

export type FogOp = { mode: 'reveal' | 'conceal'; shape: FogShape };

export type FogState = {
  initial: 'covered' | 'revealed';
  ops: FogOp[];
  /** Area revealed automatically (rooms walked into, remembered torchlight). Below the GM's ops. */
  explored?: ExploredGrid;
  /** Current light from party tokens. Shows through everything. */
  lights?: FogShape[];
};

export const FOG_LIMITS = { maxPolygonPoints: 200, maxBrushPoints: 400, maxOpsPerScene: 5000 };

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToSegmentSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  const cx = a.x + t * dx - p.x;
  const cy = a.y + t * dy - p.y;
  return cx * cx + cy * cy;
}

export function shapeContains(shape: FogShape, p: Point): boolean {
  switch (shape.kind) {
    case 'rect':
      return p.x >= shape.x && p.x <= shape.x + shape.w && p.y >= shape.y && p.y <= shape.y + shape.h;
    case 'polygon':
      return shape.points.length >= 3 && pointInPolygon(p, shape.points);
    case 'brush': {
      const r2 = shape.radius * shape.radius;
      const pts = shape.points;
      if (pts.length === 1) return distToSegmentSq(p, pts[0]!, pts[0]!) <= r2;
      for (let i = 1; i < pts.length; i++) if (distToSegmentSq(p, pts[i - 1]!, pts[i]!) <= r2) return true;
      return false;
    }
  }
}

/** True when players cannot see map point `p`: light, then the GM's ops (last wins), then explored, then the initial state. */
export function isFogged(fog: FogState, p: Point): boolean {
  if (fog.lights?.some((s) => shapeContains(s, p))) return false;
  for (let i = fog.ops.length - 1; i >= 0; i--) {
    const op = fog.ops[i]!;
    if (shapeContains(op.shape, p)) return op.mode === 'conceal';
  }
  if (fog.explored && exploredContains(fog.explored, p)) return false;
  return fog.initial === 'covered';
}
