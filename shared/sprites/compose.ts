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
/** `from`: the part's own shades (dark to light) when its art matches none of the palettes. */
export type SpriteChannel = { key: string; label?: string; material: Material; base?: string; from?: string[]; skin?: boolean };
/** `variants`: for parts drawn in fixed colours (one file per colour) rather than recoloured. */
export type SpriteLayer = { z: number; src: Partial<Record<BodyType, string>>; variants?: Record<string, Partial<Record<BodyType, string>>> };
export type SpriteItem = { id: string; name: string; tags?: string[]; layers: SpriteLayer[]; channels: SpriteChannel[]; variants?: string[]; credit: number[] };

/** The recipe colour key that picks a fixed-colour variant. */
export const VARIANT_KEY = 'variant';
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
  for (const part of entries as SpriteRecipe['parts']) {
    const item = findItem(m, part.item);
    if (!item) continue;
    const swaps: PlannedLayer['swaps'] = [];
    for (const ch of item.channels) {
      const target = ch.skin ? r.skin : part.colors?.[ch.key];
      const base = ch.base ?? m.bases[ch.material];
      if (!target || (!ch.from && target === base)) continue;
      const from = ch.from ?? m.palettes[ch.material]?.[base];
      const shades = m.palettes[ch.material]?.[target];
      if (!from || !shades) continue;
      // Own shades map onto the target by brightness rank when the counts differ.
      const to = from.length === shades.length ? shades : from.map((_, i) => shades[Math.round((i * (shades.length - 1)) / Math.max(1, from.length - 1))]!);
      swaps.push({ from, to });
    }
    const variant = part.colors?.[VARIANT_KEY];
    for (const layer of item.layers) {
      const src = (variant && layer.variants?.[variant]?.[r.body]) || layer.src[r.body];
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
