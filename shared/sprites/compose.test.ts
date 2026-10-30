import { describe, expect, it } from 'vitest';
import { applySwaps, composePlan, type SpriteManifest } from './compose';

const manifest: SpriteManifest = {
  version: 1,
  frame: 64,
  palettes: {
    body: { light: ['#111111', '#222222'], green: ['#113311', '#225522'] },
    hair: { orange: ['#aa5500'], black: ['#000001'] },
    cloth: {},
    metal: {},
    eye: { blue: ['#0000ff'], red: ['#ff0000'] },
    wood: {},
  },
  bases: { body: 'light', hair: 'orange', cloth: 'white', metal: 'steel', eye: 'blue', wood: 'maple' },
  categories: [
    { id: 'body', label: 'Body', items: [{ id: 'body', name: 'Body', layers: [{ z: 10, src: { male: 'b-m.png', female: 'b-f.png' } }], channels: [{ key: 'skin', material: 'body', skin: true }], credit: [0] }] },
    {
      id: 'head',
      label: 'Head',
      items: [{ id: 'orc', name: 'Orc', layers: [{ z: 100, src: { male: 'orc.png', female: 'orc.png' } }], channels: [{ key: 'skin', material: 'body', base: 'green', skin: true }, { key: 'eyes', material: 'eye' }], credit: [0] }],
    },
    { id: 'hair', label: 'Hair', items: [{ id: 'mop', name: 'Mop', layers: [{ z: 120, src: { male: 'mop.png' } }, { z: 5, src: { male: 'mop-back.png' } }], channels: [{ key: 'color', material: 'hair' }], credit: [0] }] },
  ],
  animals: [],
  credits: [{ authors: ['a'], licenses: ['CC0'], urls: [] }],
};

describe('composePlan', () => {
  it('draws layers back to front for the chosen body, with each part recoloured', () => {
    const plan = composePlan(manifest, { v: 1, body: 'male', skin: 'green', parts: [{ item: 'orc', colors: { eyes: 'red' } }, { item: 'mop', colors: { color: 'black' } }] });
    expect(plan.map((l) => l.src)).toEqual(['mop-back.png', 'b-m.png', 'orc.png', 'mop.png']);
    // Skin follows the recipe's skin colour; the orc head's art starts from green.
    const body = plan.find((l) => l.src === 'b-m.png')!;
    expect(body.swaps).toEqual([{ from: ['#111111', '#222222'], to: ['#113311', '#225522'] }]);
    const head = plan.find((l) => l.src === 'orc.png')!;
    expect(head.swaps).toEqual([{ from: ['#0000ff'], to: ['#ff0000'] }]);
    expect(plan.find((l) => l.src === 'mop.png')!.swaps).toEqual([{ from: ['#aa5500'], to: ['#000001'] }]);
  });

  it('a different body (a skeleton) replaces the base body', () => {
    const m: SpriteManifest = { ...manifest, categories: manifest.categories.map((c) => (c.id === 'body' ? { ...c, items: [...c.items, { id: 'skeleton', name: 'Skeleton', layers: [{ z: 10, src: { male: 'skel.png' } }], channels: [], credit: [0] }] } : c)) };
    expect(composePlan(m, { v: 1, body: 'male', skin: 'light', parts: [{ item: 'skeleton' }] }).map((l) => l.src)).toEqual(['skel.png']);
  });

  it('skips parts that have no art for the chosen body, and unknown parts', () => {
    const plan = composePlan(manifest, { v: 1, body: 'female', skin: 'light', parts: [{ item: 'mop' }, { item: 'nope' }] });
    expect(plan.map((l) => l.src)).toEqual(['b-f.png']);
  });
});

describe('applySwaps', () => {
  it('replaces palette colours within a tolerance and leaves the rest', () => {
    const px = new Uint8Array([0x11, 0x11, 0x12, 255, 0x22, 0x22, 0x22, 255, 0x99, 0x99, 0x99, 255, 0x11, 0x11, 0x11, 0]);
    applySwaps(px, [{ from: ['#111111', '#222222'], to: ['#113311', '#225522'] }]);
    expect(Array.from(px)).toEqual([0x11, 0x33, 0x11, 255, 0x22, 0x55, 0x22, 255, 0x99, 0x99, 0x99, 255, 0x11, 0x11, 0x11, 0]);
  });
});
