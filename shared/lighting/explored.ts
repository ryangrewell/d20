/**
 * The "explored" fog layer: a bounded bit grid of map area revealed automatically
 * (torchlight in remember mode, rooms walked into). Kept at ≤512 cells on the long
 * side so it stays small however long a session runs; sent run-length encoded.
 */
import type { Point } from '../geometry/transform';
import { pointInPolygon } from '../fog';

export type ExploredGrid = { cellPx: number; cols: number; rows: number; bits: Uint8Array };

const MAX_CELLS = 512;
const MIN_CELL_PX = 4;

export function createExplored(widthPx: number, heightPx: number): ExploredGrid {
  const cellPx = Math.max(MIN_CELL_PX, Math.ceil(Math.max(widthPx, heightPx) / MAX_CELLS));
  const cols = Math.max(1, Math.ceil(widthPx / cellPx));
  const rows = Math.max(1, Math.ceil(heightPx / cellPx));
  return { cellPx, cols, rows, bits: new Uint8Array(Math.ceil((cols * rows) / 8)) };
}

const getBit = (g: ExploredGrid, i: number) => (g.bits[i >> 3]! >> (i & 7)) & 1;
const setBit = (g: ExploredGrid, i: number) => (g.bits[i >> 3]! |= 1 << (i & 7));

/** Marks every cell whose centre is inside the polygon. Returns whether any cell was newly marked. */
export function markPolygon(g: ExploredGrid, points: Point[]): boolean {
  if (points.length < 3) return false;
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
      if (getBit(g, i)) continue;
      if (pointInPolygon({ x: (c + 0.5) * g.cellPx, y: (r + 0.5) * g.cellPx }, points)) {
        setBit(g, i);
        changed = true;
      }
    }
  }
  return changed;
}

export function exploredContains(g: ExploredGrid, p: Point): boolean {
  const c = Math.floor(p.x / g.cellPx);
  const r = Math.floor(p.y / g.cellPx);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
  return getBit(g, r * g.cols + c) === 1;
}

/** Calls `fn(row, colStart, colEnd)` for each horizontal run of marked cells (for drawing). */
export function forEachExploredRun(g: ExploredGrid, fn: (row: number, c0: number, c1: number) => void) {
  for (let r = 0; r < g.rows; r++) {
    let start = -1;
    for (let c = 0; c <= g.cols; c++) {
      const on = c < g.cols && getBit(g, r * g.cols + c) === 1;
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        fn(r, start, c - 1);
        start = -1;
      }
    }
  }
}

function pushVarint(out: number[], n: number) {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

function toBase64(bytes: number[] | Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Header (cellPx, cols, rows) then alternating run lengths starting with unmarked cells, as varints, base64. */
export function encodeExplored(g: ExploredGrid): string {
  const out: number[] = [];
  pushVarint(out, g.cellPx);
  pushVarint(out, g.cols);
  pushVarint(out, g.rows);
  const total = g.cols * g.rows;
  let current = 0;
  let run = 0;
  for (let i = 0; i < total; i++) {
    const bit = getBit(g, i);
    if (bit === current) run++;
    else {
      pushVarint(out, run);
      current = bit;
      run = 1;
    }
  }
  pushVarint(out, run);
  return toBase64(out);
}

export function decodeExplored(s: string): ExploredGrid {
  const bin = atob(s);
  let pos = 0;
  const read = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = bin.charCodeAt(pos++);
      n |= (b & 0x7f) << shift;
      if (b < 0x80) return n >>> 0;
      shift += 7;
    }
  };
  const cellPx = read();
  const cols = read();
  const rows = read();
  const g: ExploredGrid = { cellPx, cols, rows, bits: new Uint8Array(Math.ceil((cols * rows) / 8)) };
  let i = 0;
  let bit = 0;
  while (pos < bin.length) {
    const run = read();
    if (bit) for (let k = 0; k < run; k++) setBit(g, i + k);
    i += run;
    bit ^= 1;
  }
  return g;
}
