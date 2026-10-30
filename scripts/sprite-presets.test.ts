import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findItem, VARIANT_KEY, type SpriteManifest } from '../shared/sprites/compose';
import { SPRITE_PRESETS } from '../shared/sprites/presets';

const manifest = JSON.parse(readFileSync(new URL('../public/sprites/manifest.json', import.meta.url), 'utf8')) as SpriteManifest;

describe('sprite presets', () => {
  it.each(SPRITE_PRESETS.map((p) => [p.name, p] as const))('%s uses parts and colours that exist', (_n, preset) => {
    const { recipe } = preset;
    expect(manifest.palettes.body[recipe.skin], `skin ${recipe.skin}`).toBeDefined();
    for (const part of recipe.parts) {
      const item = findItem(manifest, part.item);
      expect(item, part.item).toBeDefined();
      expect(item!.layers.some((l) => l.src[recipe.body]), `${part.item} has art for ${recipe.body}`).toBe(true);
      for (const [key, colour] of Object.entries(part.colors ?? {})) {
        if (key === VARIANT_KEY) {
          expect(item!.variants, `${part.item} variants`).toContain(colour);
          continue;
        }
        const ch = item!.channels.find((c) => c.key === key);
        expect(ch, `${part.item} colour slot ${key}`).toBeDefined();
        expect(manifest.palettes[ch!.material][colour], `${part.item} ${key}=${colour}`).toBeDefined();
      }
    }
  });

  it('ships animals for the bestiary', () => {
    expect(manifest.animals.map((a) => a.id)).toEqual(expect.arrayContaining(['wolf_grey', 'dog_brown', 'cat_black']));
  });
});
