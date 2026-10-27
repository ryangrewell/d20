/**
 * Draws a generated floor as a clean top-down map. The image covers exactly
 * the building footprint (no margin) so the server can calibrate it from the
 * pixel width alone. Styling never changes geometry.
 */
import type { Floor, Floorplan, Theme } from '@shared/generator/floorplan';
import { hashSeed } from '@shared/generator/rng';

type Palette = { floor: string; roomTones: string[]; hall: string; stairs: string; wall: string; door: string; window: string; label: string; labelShadow: string };

export const PALETTES: Record<Theme, Palette> = {
  medieval: { floor: '#c8b08a', roomTones: ['#cdb48c', '#c4ab84', '#d2ba94', '#bfa67f'], hall: '#b89f79', stairs: '#9e8664', wall: '#3a2d22', door: '#7a5532', window: '#a7c7d8', label: '#2b2019', labelShadow: 'rgba(255,245,225,0.6)' },
  fantasy: { floor: '#b9c3a3', roomTones: ['#c1caa9', '#b3bd9b', '#c7cfb0', '#adb795'], hall: '#a8b291', stairs: '#8f9a79', wall: '#2f3a2a', door: '#6b4b2e', window: '#9fd0e0', label: '#1f281b', labelShadow: 'rgba(240,250,230,0.6)' },
  modern: { floor: '#e6e3dc', roomTones: ['#eceae4', '#e2dfd7', '#f0eee9', '#dcd8cf'], hall: '#d6d2c8', stairs: '#c2bdb2', wall: '#2a2a2a', door: '#8a8a8a', window: '#9cc9e6', label: '#222', labelShadow: 'rgba(255,255,255,0.7)' },
  industrial: { floor: '#a7a39a', roomTones: ['#aca89f', '#a19d94', '#b2aea5', '#9b978e'], hall: '#96928a', stairs: '#86827a', wall: '#2f3439', door: '#c9a227', window: '#8fb4c9', label: '#1d2125', labelShadow: 'rgba(240,240,235,0.55)' },
  scifi: { floor: '#1c2731', roomTones: ['#1f2b36', '#1a2530', '#22303c', '#18222b'], hall: '#25333f', stairs: '#2c3d4b', wall: '#7fd3ea', door: '#f0b84a', window: '#5ef2ff', label: '#d9f6ff', labelShadow: 'rgba(0,0,0,0.6)' },
};

/** Pixels per meter for the exported image: ~20 px per foot, capped at 4096 px on the long side. */
export function exportScale(fp: Floorplan): number {
  return Math.min(65.6168, 4096 / Math.max(fp.widthM, fp.depthM));
}

export function imageSize(fp: Floorplan, pxPerM: number) {
  return { w: Math.round(fp.widthM * pxPerM), h: Math.round(fp.depthM * pxPerM) };
}

export type RenderOptions = { pxPerM: number; theme: Theme; showLabels: boolean; roomNames: Record<string, string> };

export function renderFloor(ctx: CanvasRenderingContext2D, fp: Floorplan, floor: Floor, o: RenderOptions) {
  const p = PALETTES[o.theme];
  const { w: Wpx, h: Hpx } = imageSize(fp, o.pxPerM);
  // Scale x and y independently so the footprint fills the integer-sized canvas exactly.
  const sx = Wpx / fp.widthM;
  const sy = Hpx / fp.depthM;
  const X = (m: number) => m * sx;
  const Y = (m: number) => m * sy;
  const k = Math.min(sx, sy);
  ctx.save();
  ctx.clearRect(0, 0, Wpx, Hpx);
  ctx.fillStyle = p.floor;
  ctx.fillRect(0, 0, Wpx, Hpx);

  for (const r of floor.rooms) {
    ctx.fillStyle = r.kind === 'stairs' ? p.stairs : r.kind === 'hall' ? p.hall : p.roomTones[hashSeed(r.id) % p.roomTones.length]!;
    ctx.fillRect(X(r.x), Y(r.y), X(r.w), Y(r.h));
  }

  if (floor.stairs) {
    const s = floor.stairs;
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = Math.max(1, k * 0.04);
    const alongY = s.h >= s.w;
    const treads = Math.max(4, Math.round((alongY ? s.h : s.w) / 0.28));
    for (let i = 1; i < treads; i++) {
      ctx.beginPath();
      if (alongY) {
        const y = Y(s.y + (s.h * i) / treads);
        ctx.moveTo(X(s.x), y);
        ctx.lineTo(X(s.x + s.w), y);
      } else {
        const x = X(s.x + (s.w * i) / treads);
        ctx.moveTo(x, Y(s.y));
        ctx.lineTo(x, Y(s.y + s.h));
      }
      ctx.stroke();
    }
    ctx.strokeRect(X(s.x), Y(s.y), X(s.w), Y(s.h));
  }

  // Interior walls on room boundaries, then a thicker exterior wall drawn inside the footprint.
  ctx.strokeStyle = p.wall;
  ctx.lineWidth = Math.max(2, k * 0.18);
  for (const r of floor.rooms) ctx.strokeRect(X(r.x), Y(r.y), X(r.w), Y(r.h));
  const ext = Math.max(3, k * 0.32);
  ctx.lineWidth = ext;
  ctx.strokeRect(ext / 2, ext / 2, Wpx - ext, Hpx - ext);

  const wallT = ext + 2;
  for (const win of floor.windows) {
    const half = (win.width / 2) * (win.orientation === 'h' ? sx : sy);
    const cx = X(win.x);
    const cy = Y(win.y);
    ctx.fillStyle = p.window;
    if (win.orientation === 'h') {
      const y0 = win.y < fp.depthM / 2 ? 0 : Hpx - ext;
      ctx.fillRect(cx - half, y0, half * 2, ext);
    } else {
      const x0 = win.x < fp.widthM / 2 ? 0 : Wpx - ext;
      ctx.fillRect(x0, cy - half, ext, half * 2);
    }
  }

  for (const d of floor.doors) {
    const outside = d.between.includes('outside');
    const half = (d.width / 2) * (d.orientation === 'h' ? sx : sy);
    const cx = X(d.x);
    const cy = Y(d.y);
    const leaf = half * 2;
    ctx.fillStyle = p.floor;
    if (d.orientation === 'h') {
      const y0 = outside ? Hpx - wallT : cy - wallT / 2;
      ctx.fillRect(cx - half, y0, half * 2, wallT);
    } else ctx.fillRect(cx - wallT / 2, cy - half, wallT, half * 2);
    ctx.strokeStyle = p.door;
    ctx.lineWidth = Math.max(1.5, k * 0.06);
    ctx.beginPath();
    if (d.orientation === 'h') {
      const hingeY = outside ? Hpx - ext : cy;
      ctx.moveTo(cx - half, hingeY);
      ctx.lineTo(cx - half, hingeY - leaf);
      ctx.moveTo(cx + half, hingeY);
      ctx.arc(cx - half, hingeY, leaf, 0, -Math.PI / 2, true);
    } else {
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx + leaf, cy - half);
      ctx.moveTo(cx, cy + half);
      ctx.arc(cx, cy - half, leaf, Math.PI / 2, 0, true);
    }
    ctx.stroke();
  }

  if (o.showLabels) {
    for (const r of floor.rooms) {
      const name = o.roomNames[r.id] ?? r.name;
      const label = r.kind === 'stairs' && floor.stairs ? `${name} ${floor.stairs.direction === 'up' ? '↑' : floor.stairs.direction === 'down' ? '↓' : '↕'}` : name;
      const maxW = X(r.w) * 0.9;
      let size = Math.max(10, Math.min(28, k * 0.5));
      ctx.font = `600 ${size}px Cinzel, Georgia, serif`;
      while (ctx.measureText(label).width > maxW && size > 8) {
        size -= 1;
        ctx.font = `600 ${size}px Cinzel, Georgia, serif`;
      }
      if (ctx.measureText(label).width > maxW) continue;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = p.labelShadow;
      ctx.fillText(label, X(r.x + r.w / 2) + 1, Y(r.y + r.h / 2) + 1);
      ctx.fillStyle = p.label;
      ctx.fillText(label, X(r.x + r.w / 2), Y(r.y + r.h / 2));
    }
  }
  ctx.restore();
}

export async function floorToPng(fp: Floorplan, floor: Floor, o: Omit<RenderOptions, 'pxPerM'>): Promise<Blob> {
  const pxPerM = exportScale(fp);
  const { w, h } = imageSize(fp, pxPerM);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  await document.fonts?.load?.('600 16px Cinzel').catch(() => undefined);
  renderFloor(canvas.getContext('2d')!, fp, floor, { ...o, pxPerM });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render the floorplan image.'))), 'image/png'));
}
