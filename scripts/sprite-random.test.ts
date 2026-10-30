import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findItem, VARIANT_KEY, type SpriteManifest } from '../shared/sprites/compose';
import { RACES, randomRecipe } from '../shared/sprites/random';

const manifest = JSON.parse(readFileSync(new URL('../public/sprites/manifest.json', import.meta.url), 'utf8')) as SpriteManifest;

/** Deterministic stand-in for Math.random. */
const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe('randomRecipe', () => {
  it.each(RACES.map((r) => [r.label, r.id] as const))('makes valid %s sprites', (_label, race) => {
    for (let s = 1; s <= 25; s++) {
      const recipe = randomRecipe(manifest, race, seeded(s * 7919));
      expect(manifest.palettes.body[recipe.skin], recipe.skin).toBeDefined();
      for (const part of recipe.parts) {
        const item = findItem(manifest, part.item)!;
        expect(item, part.item).toBeDefined();
        expect(item.layers.some((l) => l.src[recipe.body]), `${part.item} for ${recipe.body}`).toBe(true);
        for (const [key, colour] of Object.entries(part.colors ?? {})) {
          if (key === VARIANT_KEY) {
            expect(item.variants, `${part.item} variants`).toContain(colour);
            continue;
          }
          const ch = item.channels.find((c) => c.key === key)!;
          expect(manifest.palettes[ch.material][colour], `${part.item} ${key}`).toBeDefined();
        }
      }
    }
  });

  it('dresses modern races in modern clothes, and keeps modern zombies unarmed', () => {
    const fantasy = /armour|chainmail|plate|legion|helmet|sword_(?!dagger)|halberd|spear|staff|magic|bow|shield|cape_/;
    for (let s = 1; s <= 40; s++) {
      const human = randomRecipe(manifest, 'modern', seeded(s * 104729));
      expect(human.parts.filter((p) => fantasy.test(p.item)).map((p) => p.item)).toEqual([]);
      const zombie = randomRecipe(manifest, 'modern_zombie', seeded(s * 7));
      expect(zombie.parts[0]!.item).toBe('heads_zombie');
      expect(zombie.parts.some((p) => /^(weapon_|tool_)/.test(p.item))).toBe(false);
    }
  });

  it('gives each race its look', () => {
    const r = seeded(42);
    expect(randomRecipe(manifest, 'orc', r).parts[0]!.item).toMatch(/heads_orc/);
    expect(randomRecipe(manifest, 'elf', r).parts.some((p) => /ears/.test(p.item))).toBe(true);
    const bones = randomRecipe(manifest, 'skeleton', r).parts;
    expect(bones.map((p) => p.item)).toEqual(expect.arrayContaining(['body_skeleton', 'heads_skeleton']));
    expect(bones.filter((p) => /skeleton/.test(p.item)).every((p) => !p.colors)).toBe(true);
  });
});
