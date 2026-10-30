/**
 * Piece-by-piece sprites from LPC (Liberated Pixel Cup) parts. The build script turns the LPC
 * sheets into one standing, front-facing 64x64 frame per part layer plus this manifest; the
 * builder stacks those frames back to front, swapping each part's base palette for the chosen
 * colours, and saves the result as a small PNG.
 */
export const BODY_TYPES = ['male', 'female'] as const;
export type BodyType = (typeof BODY_TYPES)[number];
export const MATERIALS = ['body', 'hair', 'cloth', 'metal', 'eye', 'wood'] as const;
export type Material = (typeof MATERIALS)[number];

/** One colour slot of a part: which palette family it uses, and which palette its art is drawn in. */
export type SpriteChannel = { key: string; label?: string; material: Material; base?: string; skin?: boolean };
export type SpriteLayer = { z: number; src: Partial<Record<BodyType, string>> };
export type SpriteItem = { id: string; name: string; tags?: string[]; layers: SpriteLayer[]; channels: SpriteChannel[]; credit: number[] };
export type SpriteCategory = { id: string; label: string; items: SpriteItem[] };
export type SpriteAnimal = { id: string; name: string; src: string; credit: number[] };
export type SpriteCredit = { authors: string[]; licenses: string[]; urls: string[]; notes?: string };

export type SpriteManifest = {
  version: 1;
  frame: number;
  palettes: Record<Material, Record<string, string[]>>;
  /** The palette each material's art is drawn in unless an item says otherwise. */
  bases: Record<Material, string>;
  categories: SpriteCategory[];
  animals: SpriteAnimal[];
  credits: SpriteCredit[];
};

/** What the builder saves so a sprite can be edited later. */
export type SpriteRecipe = { v: 1; body: BodyType; skin: string; parts: { item: string; colors?: Record<string, string> }[] };

export type PlannedLayer = { src: string; z: number; swaps: { from: string[]; to: string[] }[] };

/** The base body every humanoid sprite starts from. */
export const BASE_BODY_ID = 'body';

export function findItem(m: SpriteManifest, id: string): SpriteItem | undefined {
  for (const c of m.categories) {
    const hit = c.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Layers to draw back to front for a recipe, each with the colour swaps it needs. */
export function composePlan(m: SpriteManifest, r: SpriteRecipe): PlannedLayer[] {
  // A body-category part (e.g. a skeleton) replaces the base body; otherwise the base body is drawn.
  const bodies = new Set(m.categories.find((c) => c.id === 'body')?.items.map((i) => i.id));
  const entries = r.parts.some((p) => bodies.has(p.item)) ? r.parts : [{ item: BASE_BODY_ID }, ...r.parts];
  const out: (PlannedLayer & { order: number })[] = [];
  let order = 0;
  for (const part of entries) {
    const item = findItem(m, part.item);
    if (!item) continue;
    const swaps: PlannedLayer['swaps'] = [];
    for (const ch of item.channels) {
      const target = ch.skin ? r.skin : (part as { colors?: Record<string, string> }).colors?.[ch.key];
      const base = ch.base ?? m.bases[ch.material];
      if (!target || target === base) continue;
      const from = m.palettes[ch.material]?.[base];
      const to = m.palettes[ch.material]?.[target];
      if (from && to) swaps.push({ from, to });
    }
    for (const layer of item.layers) {
      const src = layer.src[r.body];
      if (src) out.push({ src, z: layer.z, swaps, order: order++ });
    }
  }
  return out.sort((a, b) => a.z - b.z || a.order - b.order).map(({ order: _o, ...l }) => l);
}

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)] as const;

/** Swaps palette colours in RGBA pixels in place (±1 per channel, as LPC's recolourer does). */
export function applySwaps(px: Uint8ClampedArray | Uint8Array, swaps: PlannedLayer['swaps']) {
  const pairs = swaps.flatMap((s) => s.from.map((f, i) => [hex(f), hex(s.to[i] ?? f)] as const));
  if (!pairs.length) return;
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    for (const [[r, g, b], to] of pairs) {
      if (Math.abs(px[i]! - r) <= 1 && Math.abs(px[i + 1]! - g) <= 1 && Math.abs(px[i + 2]! - b) <= 1) {
        [px[i], px[i + 1], px[i + 2]] = to;
        break;
      }
    }
  }
}
