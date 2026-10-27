import type { Point } from './transform';

export const GRID_TYPES = ['square', 'hex', 'none'] as const;
export type GridType = (typeof GRID_TYPES)[number];

export type MapGrid = {
  type: GridType;
  /** In-world interval between grid lines (square) or hex flat-to-flat width, in meters. */
  intervalMeters: number;
  /** Interval as the GM entered it, for display. */
  displayInterval: number;
  displayUnit: 'ft' | 'yd' | 'mi' | 'm' | 'km';
  originX: number;
  originY: number;
  rotationRadians: number;
  snapEnabled: boolean;
  showEnabled: boolean;
  opacity: number;
};

/** Grid lines closer than this on screen are hidden to avoid moiré. */
export const MIN_SCREEN_GRID_SPACING = 6;

export function gridSpacingPixels(grid: Pick<MapGrid, 'intervalMeters'>, pixelsPerMeter: number): number {
  return grid.intervalMeters * pixelsPerMeter;
}

export function shouldDrawGrid(spacingPx: number, zoom: number): boolean {
  return spacingPx * zoom >= MIN_SCREEN_GRID_SPACING;
}

function toLocal(p: Point, grid: Pick<MapGrid, 'originX' | 'originY' | 'rotationRadians'>): Point {
  const dx = p.x - grid.originX;
  const dy = p.y - grid.originY;
  const c = Math.cos(-grid.rotationRadians);
  const s = Math.sin(-grid.rotationRadians);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

function fromLocal(p: Point, grid: Pick<MapGrid, 'originX' | 'originY' | 'rotationRadians'>): Point {
  const c = Math.cos(grid.rotationRadians);
  const s = Math.sin(grid.rotationRadians);
  return { x: p.x * c - p.y * s + grid.originX, y: p.x * s + p.y * c + grid.originY };
}

/** Pointy-top hex geometry where `spacing` is the flat-to-flat width. */
export function hexSize(spacing: number): number {
  return spacing / Math.sqrt(3);
}

function hexRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export function hexCenter(q: number, r: number, spacing: number): Point {
  const size = hexSize(spacing);
  return { x: size * Math.sqrt(3) * (q + r / 2), y: size * 1.5 * r };
}

/** Snap a map point to the centre of the containing grid cell. */
export function snapToGrid(p: Point, grid: MapGrid, spacingPx: number): Point {
  if (grid.type === 'none' || !grid.snapEnabled || !(spacingPx > 0)) return p;
  const local = toLocal(p, grid);
  if (grid.type === 'square') {
    const snapped = {
      x: (Math.floor(local.x / spacingPx) + 0.5) * spacingPx,
      y: (Math.floor(local.y / spacingPx) + 0.5) * spacingPx,
    };
    return fromLocal(snapped, grid);
  }
  const size = hexSize(spacingPx);
  const q = ((Math.sqrt(3) / 3) * local.x - (1 / 3) * local.y) / size;
  const r = ((2 / 3) * local.y) / size;
  const h = hexRound(q, r);
  return fromLocal(hexCenter(h.q, h.r, spacingPx), grid);
}

export const DEFAULT_GRID: MapGrid = {
  type: 'square',
  intervalMeters: 1.524,
  displayInterval: 5,
  displayUnit: 'ft',
  originX: 0,
  originY: 0,
  rotationRadians: 0,
  snapEnabled: true,
  showEnabled: true,
  opacity: 0.35,
};
