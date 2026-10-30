/** Draws sprites in the browser from the LPC parts in /sprites (see shared/sprites/compose). */
import { applySwaps, composePlan, type SpriteManifest } from '@shared/sprites/compose';
import type { SpriteSource } from '@shared/model';

let manifest: Promise<SpriteManifest> | null = null;
export function loadManifest(): Promise<SpriteManifest> {
  manifest ??= fetch('/sprites/manifest.json').then((r) => {
    if (!r.ok) throw new Error('Could not load the sprite parts.');
    return r.json() as Promise<SpriteManifest>;
  });
  return manifest;
}

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string): Promise<HTMLImageElement> {
  if (!images.has(src)) {
    images.set(
      src,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Could not load ${src}`));
        img.src = `/sprites/${src}`;
      }),
    );
  }
  return images.get(src)!;
}

/** Renders a built sprite or an animal onto a new canvas at its native size. */
export async function renderSprite(source: Exclude<SpriteSource, { kind: 'upload' }>): Promise<HTMLCanvasElement> {
  const m = await loadManifest();
  if (source.kind === 'animal') {
    const animal = m.animals.find((a) => a.id === source.id);
    if (!animal) throw new Error('That animal is not available.');
    const img = await loadImage(animal.src);
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = [img.naturalWidth, img.naturalHeight];
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return canvas;
  }
  const plan = composePlan(m, source.recipe);
  const layers = await Promise.all(plan.map((l) => loadImage(l.src)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = m.frame;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const scratch = document.createElement('canvas');
  scratch.width = scratch.height = m.frame;
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  plan.forEach((layer, i) => {
    sctx.clearRect(0, 0, m.frame, m.frame);
    sctx.drawImage(layers[i]!, 0, 0);
    if (layer.swaps.length) {
      const px = sctx.getImageData(0, 0, m.frame, m.frame);
      applySwaps(px.data, layer.swaps);
      sctx.putImageData(px, 0, 0);
    }
    ctx.drawImage(scratch, 0, 0);
  });
  return canvas;
}

export const canvasToPng = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not save the picture.'))), 'image/png'));

/** A square, at most `size` px, crop of a photo, ready to upload. */
export async function portraitFromFile(file: File, size = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(size, side);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = out;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  return canvasToPng(canvas);
}
