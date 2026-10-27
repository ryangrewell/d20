/**
 * Grid geometry for the visible region, in native map pixels. Shared by the
 * calibration preview (SVG) and the tabletop renderer (Pixi).
 */
import type { MapGrid } from './grid';
import { hexCenter, hexSize } from './grid';
import type { Point } from './transform';

export type Segment = [Point, Point];
export type Rect = { x: number; y: number; w: number; h: number };

const MAX_LINES = 1200;
const MAX_HEXES = 6000;

function rotate(p: Point, grid: Pick<MapGrid, 'originX' | 'originY' | 'rotationRadians'>): Point {
  const c = Math.cos(grid.rotationRadians);
  const s = Math.sin(grid.rotationRadians);
  return { x: p.x * c - p.y * s + grid.originX, y: p.x * s + p.y * c + grid.originY };
}

/** Bounding box of `view` expressed in the grid's local (unrotated, origin-relative) frame. */
function localBounds(view: Rect, grid: Pick<MapGrid, 'originX' | 'originY' | 'rotationRadians'>) {
  const c = Math.cos(-grid.rotationRadians);
  const s = Math.sin(-grid.rotationRadians);
  const corners = [
    { x: view.x, y: view.y },
    { x: view.x + view.w, y: view.y },
    { x: view.x, y: view.y + view.h },
    { x: view.x + view.w, y: view.y + view.h },
  ].map((p) => {
    const dx = p.x - grid.originX;
    const dy = p.y - grid.originY;
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  });
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

export function squareGridSegments(grid: MapGrid, spacing: number, view: Rect): Segment[] {
  if (!(spacing > 0)) return [];
  const b = localBounds(view, grid);
  const x0 = Math.floor(b.minX / spacing);
  const x1 = Math.ceil(b.maxX / spacing);
  const y0 = Math.floor(b.minY / spacing);
  const y1 = Math.ceil(b.maxY / spacing);
  if (x1 - x0 + (y1 - y0) > MAX_LINES) return [];
  const out: Segment[] = [];
  for (let i = x0; i <= x1; i++) out.push([rotate({ x: i * spacing, y: y0 * spacing }, grid), rotate({ x: i * spacing, y: y1 * spacing }, grid)]);
  for (let j = y0; j <= y1; j++) out.push([rotate({ x: x0 * spacing, y: j * spacing }, grid), rotate({ x: x1 * spacing, y: j * spacing }, grid)]);
  return out;
}

/** Pointy-top hex outlines intersecting the view. */
export function hexGridPolygons(grid: MapGrid, spacing: number, view: Rect): Point[][] {
  if (!(spacing > 0)) return [];
  const b = localBounds(view, grid);
  const size = hexSize(spacing);
  const rowH = size * 1.5;
  const r0 = Math.floor(b.minY / rowH) - 1;
  const r1 = Math.ceil(b.maxY / rowH) + 1;
  const cols = Math.ceil((b.maxX - b.minX) / spacing) + 3;
  if ((r1 - r0) * cols > MAX_HEXES) return [];
  const out: Point[][] = [];
  for (let r = r0; r <= r1; r++) {
    const qStart = Math.floor(b.minX / spacing - r / 2) - 1;
    for (let q = qStart; q < qStart + cols; q++) {
      const c = hexCenter(q, r, spacing);
      const poly: Point[] = [];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k - 30);
        poly.push(rotate({ x: c.x + size * Math.cos(a), y: c.y + size * Math.sin(a) }, grid));
      }
      out.push(poly);
    }
  }
  return out;
}
