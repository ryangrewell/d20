/** Compact encodings for fog layers on the wire: varints, base64, and polygons as whole-pixel deltas. */
import type { Point } from '../geometry/transform';

export function pushVarint(out: number[], n: number) {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

export function toBase64(bytes: number[]): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Reads varints back out of a base64 string. */
export function varintReader(s: string) {
  const bin = atob(s);
  let pos = 0;
  return {
    done: () => pos >= bin.length,
    read: () => {
      let n = 0;
      let shift = 0;
      for (;;) {
        const b = bin.charCodeAt(pos++);
        n += (b & 0x7f) * 2 ** shift;
        if (b < 0x80) return n;
        shift += 7;
      }
    },
  };
}

const zig = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzig = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/** A polygon rounded to whole pixels, each point stored as the difference from the previous one. */
export function encodePolygon(points: Point[]): string {
  const out: number[] = [];
  let [px, py] = [0, 0];
  for (const p of points) {
    const [x, y] = [Math.round(p.x), Math.round(p.y)];
    pushVarint(out, zig(x - px));
    pushVarint(out, zig(y - py));
    [px, py] = [x, y];
  }
  return toBase64(out);
}

export function decodePolygon(s: string): Point[] {
  const r = varintReader(s);
  const pts: Point[] = [];
  let [x, y] = [0, 0];
  while (!r.done()) {
    x += unzig(r.read());
    y += unzig(r.read());
    pts.push({ x, y });
  }
  return pts;
}
