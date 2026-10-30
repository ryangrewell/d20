/**
 * The "explored" fog layer: area revealed automatically (torchlight in remember mode, rooms
 * walked into). Each cell remembers *when* it was explored as a stamp: the number of GM fog
 * ops that existed at the time, plus one. Fog the GM paints afterwards covers it again;
 * exploring after that paint clears it again. Kept at ≤512 cells on the long side so it
 * stays small however long a session runs; sent run-length encoded.
 */
import type { Point } from '../geometry/transform';
import { pointInPolygon } from '../fog';
import { pushVarint, toBase64, varintReader } from './wire';

export type ExploredGrid = { cellPx: number; cols: number; rows: number; stamps: Uint16Array };

const MAX_CELLS = 512;
const MIN_CELL_PX = 4;
const MAX_STAMP = 0xffff;
/** First varint of the current encoding; older encodings started with cellPx (always ≥ 4). */
const FORMAT_STAMPED = 2;

export function createExplored(widthPx: number, heightPx: number): ExploredGrid {
  const cellPx = Math.max(MIN_CELL_PX, Math.ceil(Math.max(widthPx, heightPx) / MAX_CELLS));
  const cols = Math.max(1, Math.ceil(widthPx / cellPx));
  const rows = Math.max(1, Math.ceil(heightPx / cellPx));
  return { cellPx, cols, rows, stamps: new Uint16Array(cols * rows) };
}

/**
 * Stamps every cell whose centre is inside the polygon with `stamp`, unless it already has a
 * newer one. Returns whether anything changed.
 */
export function markPolygon(g: ExploredGrid, points: Point[], stamp: number): boolean {
  if (points.length < 3) return false;
  const s = Math.max(1, Math.min(MAX_STAMP, Math.floor(stamp)));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const c0 = Math.max(0, Math.floor(Math.min(...xs) / g.cellPx));
  const c1 = Math.min(g.cols - 1, Math.floor(Math.max(...xs) / g.cellPx));
  const r0 = Math.max(0, Math.floor(Math.min(...ys) / g.cellPx));
  const r1 = Math.min(g.rows - 1, Math.floor(Math.max(...ys) / g.cellPx));
  let changed = false;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * g.cols + c;
      if (g.stamps[i]! >= s) continue;
      if (pointInPolygon({ x: (c + 0.5) * g.cellPx, y: (r + 0.5) * g.cellPx }, points)) {
        g.stamps[i] = s;
        changed = true;
      }
    }
  }
  return changed;
}

/** When `p` was last explored (0 = never). */
export function exploredStamp(g: ExploredGrid, p: Point): number {
  const c = Math.floor(p.x / g.cellPx);
  const r = Math.floor(p.y / g.cellPx);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return 0;
  return g.stamps[r * g.cols + c]!;
}

/** Calls `fn(row, colStart, colEnd, stamp)` for each horizontal run of cells explored at the same time. */
export function forEachExploredRun(g: ExploredGrid, fn: (row: number, c0: number, c1: number, stamp: number) => void) {
  for (let r = 0; r < g.rows; r++) {
    let start = 0;
    for (let c = 1; c <= g.cols; c++) {
      const prev = g.stamps[r * g.cols + c - 1]!;
      if (c < g.cols && g.stamps[r * g.cols + c] === prev) continue;
      if (prev) fn(r, start, c - 1, prev);
      start = c;
    }
  }
}

/** Format marker, cellPx, cols, rows, then (stamp, run length) pairs over the cells, as varints, base64. */
export function encodeExplored(g: ExploredGrid): string {
  const out: number[] = [];
  for (const n of [FORMAT_STAMPED, g.cellPx, g.cols, g.rows]) pushVarint(out, n);
  const total = g.cols * g.rows;
  let i = 0;
  while (i < total) {
    const v = g.stamps[i]!;
    let j = i + 1;
    while (j < total && g.stamps[j] === v) j++;
    pushVarint(out, v);
    pushVarint(out, j - i);
    i = j;
  }
  return toBase64(out);
}

export function decodeExplored(s: string): ExploredGrid {
  const { read, done } = varintReader(s);
  const first = read();
  const stamped = first === FORMAT_STAMPED;
  const cellPx = stamped ? read() : first;
  const cols = read();
  const rows = read();
  const g: ExploredGrid = { cellPx, cols, rows, stamps: new Uint16Array(cols * rows) };
  let i = 0;
  if (stamped) {
    while (!done()) {
      const v = read();
      const run = read();
      if (v) g.stamps.fill(v, i, i + run);
      i += run;
    }
    return g;
  }
  // Earlier format: alternating unexplored/explored run lengths. Treat it as explored before any GM fog.
  let on = false;
  while (!done()) {
    const run = read();
    if (on) g.stamps.fill(1, i, i + run);
    i += run;
    on = !on;
  }
  return g;
}
