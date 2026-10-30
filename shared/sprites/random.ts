/** "Randomize" in the sprite builder: a believable outfit and colours for a chosen race. */
import { BODY_TYPES, findItem, type BodyType, type SpriteManifest, type SpriteRecipe } from './compose';

type Race = {
  id: string;
  label: string;
  heads: Partial<Record<BodyType, string[]>>;
  skins: string[];
  /** Always-on extras (ears, tails…), one picked from each list. */
  extras?: string[][];
  bodies?: BodyType[];
  /** Replaces the base body (skeletons). */
  body?: string;
  hair?: boolean;
  beard?: number;
};

export const RACES: Race[] = [
  { id: 'human', label: 'Human', heads: { male: ['heads_human_male', 'heads_human_male_gaunt', 'heads_human_male_plump', 'heads_human_male_elderly'], female: ['heads_human_female', 'heads_human_female_elderly'] }, skins: ['light', 'amber', 'olive', 'taupe', 'bronze', 'brown', 'black'], hair: true, beard: 0.3 },
  { id: 'elf', label: 'Elf', heads: { male: ['heads_human_male', 'heads_human_male_gaunt'], female: ['heads_human_female'] }, skins: ['light', 'amber', 'olive', 'taupe', 'lavender'], extras: [['head_ears_elven', 'head_ears_medium', 'head_ears_long', 'head_ears_hang']], hair: true },
  { id: 'dwarf', label: 'Dwarf', heads: { male: ['heads_human_male_plump', 'heads_human_male_small'], female: ['heads_human_female_small'] }, skins: ['light', 'amber', 'taupe', 'bronze', 'brown'], hair: true, beard: 1 },
  { id: 'orc', label: 'Orc', heads: { male: ['heads_orc_male'], female: ['heads_orc_female'] }, skins: ['green', 'dark_green', 'pale_green', 'bright_green', 'olive'], hair: true },
  { id: 'goblin', label: 'Goblin', heads: { male: ['heads_goblin'], female: ['heads_goblin'] }, skins: ['green', 'dark_green', 'pale_green', 'bright_green'] },
  { id: 'troll', label: 'Troll', heads: { male: ['heads_troll'], female: ['heads_troll'] }, skins: ['pale_green', 'dark_green', 'blue', 'taupe'] },
  { id: 'lizardfolk', label: 'Lizardfolk', heads: { male: ['heads_lizard_male'], female: ['heads_lizard_female'] }, skins: ['green', 'dark_green', 'bright_green', 'blue'], extras: [['tail_lizard']] },
  { id: 'skeleton', label: 'Skeleton', heads: { male: ['heads_skeleton'], female: ['heads_skeleton'] }, skins: ['light'], body: 'body_skeleton' },
  { id: 'zombie', label: 'Zombie', heads: { male: ['heads_zombie'], female: ['heads_zombie'] }, skins: ['zombie', 'zombie_green'] },
  { id: 'vampire', label: 'Vampire', heads: { male: ['heads_vampire'], female: ['heads_vampire'] }, skins: ['lavender', 'light'], hair: true },
  { id: 'wolffolk', label: 'Wolf-folk', heads: { male: ['heads_wolf_male'], female: ['heads_wolf_female'] }, skins: ['fur_grey', 'fur_brown', 'fur_black', 'fur_tan', 'fur_white'] },
  { id: 'minotaur', label: 'Minotaur', heads: { male: ['heads_minotaur'], female: ['heads_minotaur_female'] }, skins: ['fur_brown', 'fur_tan', 'fur_black'], extras: [['feet_hoofs']] },
  { id: 'boarfolk', label: 'Boar-folk', heads: { male: ['heads_boarman', 'heads_wartotaur'], female: ['heads_boarman'] }, skins: ['fur_brown', 'fur_black', 'fur_tan'] },
];

/** Which parts make a sensible random outfit (by id pattern), and how often each slot is filled. */
const SLOTS: { pick: RegExp; skip?: RegExp; chance: number }[] = [
  { pick: /^torso_(clothes|armour)|^torso_chainmail$/, chance: 0.95 },
  { pick: /^legs_(pants|pants2|leggings|shorts|armour|skirts_plain|formal|cuffed)$/, chance: 0.95 },
  { pick: /^feet_(boots|shoes)_/, chance: 0.8 },
  { pick: /^hat_(helmet|hood|bandana|magic_wizard$)/, chance: 0.3 },
  { pick: /^weapon_/, chance: 0.6 },
  { pick: /^shield_(round|kite|heater_wood|spartan|crusader)$/, chance: 0.15 },
];

const pickFrom = <T,>(list: T[], rand: () => number): T => list[Math.floor(rand() * list.length) % list.length]!;

function hasArt(m: SpriteManifest, id: string, body: BodyType) {
  return !!findItem(m, id)?.layers.some((l) => l.src[body]);
}

/** Colours for each non-skin slot of a part, drawn from its palette family. */
function colorsFor(m: SpriteManifest, id: string, rand: () => number) {
  const item = findItem(m, id);
  const out: Record<string, string> = {};
  for (const ch of item?.channels ?? []) if (!ch.skin) out[ch.key] = pickFrom(Object.keys(m.palettes[ch.material]), rand);
  return Object.keys(out).length ? out : undefined;
}

export function randomRecipe(m: SpriteManifest, raceId: string, rand: () => number = Math.random): SpriteRecipe {
  const race = RACES.find((r) => r.id === raceId) ?? RACES[0]!;
  const body = pickFrom([...(race.bodies ?? BODY_TYPES)].filter((b) => race.heads[b]?.length), rand);
  const all = m.categories.flatMap((c) => c.items.map((i) => i.id));
  const parts: SpriteRecipe['parts'] = [];
  const add = (id: string) => {
    const colors = colorsFor(m, id, rand);
    parts.push(colors ? { item: id, colors } : { item: id });
  };
  const head = pickFrom(race.heads[body]!, rand);
  // Bones stay bone-coloured: a replacement body and its head keep their own colours.
  if (race.body) parts.push({ item: head }, { item: race.body });
  else add(head);
  for (const options of race.extras ?? []) add(pickFrom(options.filter((id) => hasArt(m, id, body)), rand));
  if (race.hair) {
    const hair = all.filter((id) => /^hair_/.test(id) && hasArt(m, id, body));
    if (hair.length && rand() < 0.9) add(pickFrom(hair, rand));
  }
  if (race.beard && body === 'male' && rand() < race.beard) add(pickFrom(all.filter((id) => /^beards_/.test(id) && hasArt(m, id, body)), rand));
  // Skeletons wear little; everyone else gets a random outfit.
  for (const slot of race.body ? SLOTS.slice(3) : SLOTS) {
    if (rand() >= slot.chance) continue;
    const pool = all.filter((id) => slot.pick.test(id) && hasArt(m, id, body) && !parts.some((p) => p.item === id));
    if (pool.length) add(pickFrom(pool, rand));
  }
  return { v: 1, body, skin: pickFrom(race.skins.filter((s) => m.palettes.body[s]), rand), parts };
}
