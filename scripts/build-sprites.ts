/**
 * Builds the sprite builder's art from Liberated Pixel Cup (LPC) sources:
 *   npx tsx scripts/build-sprites.ts --lpc <clone of Universal-LPC-Spritesheet-Character-Generator> --animals <dir with OpenGameArt wolf/dog/cat sheets>
 *
 * The LPC clone needs only sheet_definitions/, palette_definitions/, idle sheets and weapon walk sheets
 * (a sparse checkout). For every part layer it keeps one standing, front-facing 64x64 frame, and it
 * writes public/sprites/manifest.json with palettes, layer order and per-part credits.
 * Sources are read as data only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { crop, decodePng, encodePng, isEmpty, type Rgba } from './lib/png';
import { MATERIALS, type Material, type SpriteAnimal, type SpriteCategory, type SpriteChannel, type SpriteCredit, type SpriteItem, type SpriteManifest } from '../shared/sprites/compose';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1]!;
};
const LPC = arg('lpc');
const ANIMALS = arg('animals');
const OUT = join(process.cwd(), 'public/sprites');
const FRAME = 64;
/** Row of the front-facing (south) direction in LPC idle and walk sheets. */
const SOUTH_ROW = 2;
const BODY_TYPES = ['male', 'female'] as const;

/** Which LPC definitions become which builder category (first match wins; null = skip). */
const CATEGORY_RULES: [RegExp, string | null][] = [
  [/^body\/body\.json$/, 'body'],
  [/^body\/special\/body_skeleton\.json$/, 'body'],
  [/^body\/(wounds|prostheses|wings|tails)\//, null],
  [/^body\/(shadow|wheelchair)\.json$/, null],
  [/^body\/lizard\//, 'extras'],
  [/^head\/heads\//, 'head'],
  [/^head\/(ears|furry_ears)\//, 'ears'],
  [/^head\/appendages\//, 'horns'],
  [/^head\/nose\//, 'nose'],
  [/^head\/eyebrows\//, 'eyebrows'],
  [/^head\/eyes\//, 'eyes'],
  [/^head\/head_wrinkles\.json$/, 'extras'],
  [/^head\/faces\//, null],
  [/^hair\/(beards|mustaches)\//, 'beard'],
  [/^hair\//, 'hair'],
  [/^torso\//, 'torso'],
  [/^arms\//, 'arms'],
  [/^legs\//, 'legs'],
  [/^feet\//, 'feet'],
  [/^headwear\//, 'headwear'],
  [/^weapons\/shields\/.*pattern/, null],
  [/^weapons\/shields\//, 'shield'],
  [/^weapons\//, 'weapon'],
];
const MATERIAL_LABELS: Record<Material, string> = { body: 'Skin', hair: 'Hair', cloth: 'Colour', metal: 'Metal', eye: 'Eyes', wood: 'Wood' };
const CATEGORY_LABELS: Record<string, string> = {
  body: 'Body',
  head: 'Head',
  ears: 'Ears',
  horns: 'Horns & fins',
  nose: 'Nose',
  eyes: 'Eyes',
  eyebrows: 'Eyebrows',
  hair: 'Hair',
  beard: 'Beard',
  torso: 'Torso',
  arms: 'Arms',
  legs: 'Legs',
  feet: 'Feet',
  headwear: 'Headwear',
  weapon: 'Weapon',
  shield: 'Shield',
  extras: 'Extras',
};

type Def = {
  name: string;
  tags?: string[];
  match_body_color?: boolean;
  recolors?: Record<string, unknown>;
  variants?: string[];
  credits?: { authors?: string[]; licenses?: string[]; urls?: string[]; notes?: string }[];
  [layer: `layer_${number}`]: { zPos: number; custom_animation?: string } & Partial<Record<string, string>>;
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const sheet = (p: string) => join(LPC, 'spritesheets', p);
const read = (p: string): Rgba => decodePng(readFileSync(p));

/** The front-facing standing frame for a layer path, trying LPC's file layouts in turn. */
function frameFor(layerPath: string, variants: string[], wide = false): Rgba | null {
  const p = layerPath.endsWith('/') ? layerPath : `${layerPath}/`;
  if (wide) {
    // Oversize "walk_128" sheets: 128 px frames with the 64 px character centred in each.
    const files = existsSync(sheet(p)) ? readdirSync(sheet(p)).filter((n) => n.endsWith('.png')).sort() : [];
    const pick = variants.map((v) => `${v}.png`).find((f) => files.includes(f)) ?? files[0];
    // Some sheets sit beside the folder the definition names (".../walk/background.png").
    const file = pick ? `${p}${pick}` : existsSync(sheet(`${p.replace(/\/$/, '')}.png`)) ? `${p.replace(/\/$/, '')}.png` : null;
    if (!file) return null;
    const frame = crop(read(sheet(file)), 32, SOUTH_ROW * 128 + 32, FRAME, FRAME);
    return isEmpty(frame) ? null : frame;
  }
  const candidates = [`${p}idle.png`, `${p}walk.png`, ...variants.flatMap((v) => [`${p}idle/${v}.png`, `${p}walk/${v}.png`])];
  if (p.includes('/universal/')) {
    const [parent, rest] = p.split('/universal/') as [string, string];
    candidates.push(`${parent}/walk/${rest.replace(/\/$/, '')}.png`);
  }
  if (existsSync(sheet(`${p}walk`)) && statSync(sheet(`${p}walk`)).isDirectory()) {
    for (const f of readdirSync(sheet(`${p}walk`)).filter((n) => n.endsWith('.png')).sort()) candidates.push(`${p}walk/${f}`);
  }
  for (const c of candidates) {
    if (!existsSync(sheet(c))) continue;
    const img = read(sheet(c));
    const frame = crop(img, 0, SOUTH_ROW * FRAME, FRAME, FRAME);
    return isEmpty(frame) ? null : frame;
  }
  return null;
}

function paletteName(base: unknown): string | undefined {
  if (typeof base !== 'string') return undefined;
  const [scheme, name] = base.includes('.') ? (base.split('.') as [string, string]) : ['ulpc', base];
  return scheme === 'ulpc' ? name : undefined;
}

function channelsFor(def: Def, palettes: SpriteManifest['palettes'], isBody: boolean): SpriteChannel[] {
  const rec = def.recolors as Record<string, unknown> | undefined;
  if (!rec) return [];
  const single = typeof rec.material === 'string' ? [['color', rec] as const] : Object.entries(rec).filter(([k]) => k.startsWith('color_'));
  const out: SpriteChannel[] = [];
  let plain = 0;
  for (const [, raw] of single) {
    const r = raw as { material?: string; base?: unknown; label?: string };
    if (!r.material || !(MATERIALS as readonly string[]).includes(r.material)) continue;
    const material = r.material as Material;
    const base = paletteName(r.base);
    if (r.base && !base) continue; // drawn in a palette scheme we don't ship
    if (base && !palettes[material][base]) continue;
    const skin = material === 'body' && (isBody || !!def.match_body_color);
    // Slots are skin, eyes, then color, color2, … in the order LPC lists them.
    const key = skin ? 'skin' : material === 'eye' ? 'eyes' : ++plain === 1 ? 'color' : `color${plain}`;
    const label = skin ? 'Skin' : material === 'eye' ? 'Eyes' : (r.label ?? MATERIAL_LABELS[material]);
    out.push({ key, label, material, ...(base ? { base } : {}), ...(skin ? { skin } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- build
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'lpc'), { recursive: true });
mkdirSync(join(OUT, 'animals'), { recursive: true });

const palettes = Object.fromEntries(MATERIALS.map((m) => [m, JSON.parse(readFileSync(join(LPC, 'palette_definitions', m, `${m}_ulpc.json`), 'utf8')) as Record<string, string[]>])) as SpriteManifest['palettes'];
const bases = Object.fromEntries(MATERIALS.map((m) => [m, (JSON.parse(readFileSync(join(LPC, 'palette_definitions', m, `meta_${m}.json`), 'utf8')) as { base: string }).base])) as SpriteManifest['bases'];

const credits: SpriteCredit[] = [];
const creditIndex = new Map<string, number>();
const creditOf = (c: SpriteCredit) => {
  const k = JSON.stringify(c);
  if (!creditIndex.has(k)) {
    creditIndex.set(k, credits.length);
    credits.push(c);
  }
  return creditIndex.get(k)!;
};

const written = new Map<string, string>();
const save = (key: string, img: Rgba) => {
  if (!written.has(key)) {
    const file = `lpc/${key.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}.png`;
    writeFileSync(join(OUT, file), encodePng(img));
    written.set(key, file);
  }
  return written.get(key)!;
};

const categories = new Map<string, SpriteItem[]>();
const unresolved: string[] = [];
const defsDir = join(LPC, 'sheet_definitions');
for (const file of walk(defsDir).filter((f) => f.endsWith('.json') && !basename(f).startsWith('meta')).sort()) {
  const rel = relative(defsDir, file);
  const category = CATEGORY_RULES.find(([re]) => re.test(rel))?.[1];
  if (!category) continue;
  const def = JSON.parse(readFileSync(file, 'utf8')) as Def;
  const variants = def.variants ?? [];
  const layers: SpriteItem['layers'] = [];
  for (const key of Object.keys(def).filter((k) => /^layer_\d+$/.test(k)).sort()) {
    const layer = def[key as `layer_${number}`];
    if (!layer) continue;
    if (layer.custom_animation && layer.custom_animation !== 'walk_128') continue;
    const src: SpriteItem['layers'][number]['src'] = {};
    for (const bt of BODY_TYPES) {
      const path = layer[bt];
      if (typeof path !== 'string') continue;
      const frame = frameFor(path, variants, layer.custom_animation === 'walk_128');
      if (frame) src[bt] = save(`${path}`, frame);
    }
    if (Object.keys(src).length) layers.push({ z: layer.zPos, src });
  }
  if (!layers.length) {
    unresolved.push(rel);
    continue;
  }
  const id = rel === 'body/body.json' ? 'body' : basename(rel, '.json');
  const items = categories.get(category) ?? [];
  if (items.some((i) => i.id === id) || [...categories.values()].flat().some((i) => i.id === id)) {
    unresolved.push(`${rel} (duplicate id ${id})`);
    continue;
  }
  const isBody = category === 'body';
  items.push({
    id,
    name: def.name,
    ...(def.tags?.length ? { tags: def.tags } : {}),
    layers,
    channels: channelsFor(def, palettes, isBody),
    credit: (def.credits ?? []).map((c) => creditOf({ authors: c.authors ?? [], licenses: c.licenses ?? [], urls: c.urls ?? [], ...(c.notes ? { notes: c.notes } : {}) })),
  });
  categories.set(category, items);
}

// ---------------------------------------------------------------- animals (OpenGameArt LPC-style sheets)
/** Crops a frame tight to its pixels and centres it on a square canvas. */
function squareTight(img: Rgba): Rgba {
  let [x0, y0, x1, y1] = [img.width, img.height, -1, -1];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
  const size = Math.max(w, h) + 2;
  return crop(img, x0 - Math.floor((size - w) / 2), y0 - Math.floor((size - h) / 2), size, size);
}

const WOLF_CREDIT = creditOf({ authors: ['Stephen "Redshrike" Challener', 'William.Thompsonj'], licenses: ['CC-BY 4.0', 'CC-BY 3.0', 'GPL 3.0', 'GPL 2.0', 'OGA-BY 3.0'], urls: ['https://opengameart.org/content/lpc-wolf-animation'], notes: 'LPC Wolf Animation' });
const PET_CREDIT = creditOf({ authors: ['bluecarrot16'], licenses: ['CC-BY 3.0', 'CC-BY-SA 3.0', 'GPL 3.0', 'GPL 2.0', 'OGA-BY 3.0'], urls: ['https://opengameart.org/content/lpc-cats-and-dogs'], notes: '[LPC] Cats and Dogs' });
const animals: SpriteAnimal[] = [];
/** Grey-scales a sprite, then scales its brightness (grey, white and black wolves from a brown one). */
const greyed = (k: number) => (img: Rgba): Rgba => {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.min(255, Math.round((0.3 * data[i]! + 0.59 * data[i + 1]! + 0.11 * data[i + 2]!) * k));
    data[i] = data[i + 1] = data[i + 2] = l;
  }
  return { ...img, data };
};
const animal = (id: string, name: string, file: string, x: number, y: number, w: number, h: number, credit: number, tint = (i: Rgba) => i) => {
  const src = `animals/${id}.png`;
  writeFileSync(join(OUT, src), encodePng(tint(squareTight(crop(read(join(ANIMALS, file)), x, y, w, h)))));
  animals.push({ id, name, src, credit: [credit] });
};
// The wolf sheets come in six browns; grey, white and black are derived from the brown one.
const WOLVES: [string, string, number, ((i: Rgba) => Rgba)?][] = [
  ['brown', 'Brown wolf', 1],
  ['dark', 'Dark wolf', 2],
  ['red', 'Red wolf', 5],
  ['grey', 'Grey wolf', 1, greyed(1.9)],
  ['white', 'White wolf', 1, greyed(3.4)],
  ['black', 'Black wolf', 2, greyed(0.9)],
];
for (const [id, name, sheetNo, tint] of WOLVES) animal(`wolf_${id}`, name, `wolfsheet${sheetNo}_0.png`, 320, 0, 64, 32, WOLF_CREDIT, tint);
const PET_COLOURS = ['White', 'Brown', 'Golden', 'Black'];
PET_COLOURS.forEach((c, i) => {
  animal(`dog_${c.toLowerCase()}`, `${c} dog`, 'dog_2.png', i * 128, 0, 32, 32, PET_CREDIT);
  animal(`cat_${c.toLowerCase()}`, `${c} cat`, 'cat_0.png', i * 128, 0, 32, 32, PET_CREDIT);
});

const order = Object.keys(CATEGORY_LABELS);
const manifest: SpriteManifest = {
  version: 1,
  frame: FRAME,
  palettes,
  bases,
  categories: order.filter((c) => categories.has(c)).map((c): SpriteCategory => ({ id: c, label: CATEGORY_LABELS[c]!, items: categories.get(c)!.sort((a, b) => a.name.localeCompare(b.name)) })),
  animals,
  credits,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest));
const count = manifest.categories.reduce((n, c) => n + c.items.length, 0);
console.log(`${count} parts in ${manifest.categories.length} categories, ${animals.length} animals, ${written.size + animals.length} images, ${credits.length} credit entries`);
for (const c of manifest.categories) console.log(`  ${c.id}: ${c.items.length}`);
if (unresolved.length) console.log(`skipped (no front-facing frame):\n  ${unresolved.join('\n  ')}`);
