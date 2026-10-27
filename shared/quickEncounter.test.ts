import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, MIXES, planGroups, scaleStats } from './quickEncounter';

const total = (gs: { count: number }[]) => gs.reduce((n, g) => n + g.count, 0);

describe('planGroups', () => {
  it('always places exactly the requested number, with no empty groups', () => {
    for (const d of DIFFICULTIES) for (const m of MIXES) for (let n = 1; n <= 20; n++) {
      const gs = planGroups(d, m, n);
      expect(total(gs), `${d}/${m}/${n}`).toBe(n);
      expect(gs.every((g) => g.count >= 1)).toBe(true);
    }
  });

  it('follows the difficulty table', () => {
    expect(planGroups('easy', 'same', 4)).toEqual([{ toughness: 'minion', count: 4 }]);
    expect(planGroups('moderate', 'same', 4)).toEqual([{ toughness: 'standard', count: 4 }]);
    expect(planGroups('hard', 'same', 4)).toEqual([{ toughness: 'standard', count: 3 }, { toughness: 'elite', count: 1 }]);
    expect(planGroups('easy', 'leader', 4)).toEqual([{ toughness: 'minion', count: 3 }, { toughness: 'standard', count: 1 }]);
    expect(planGroups('moderate', 'leader', 4)).toEqual([{ toughness: 'minion', count: 3 }, { toughness: 'elite', count: 1 }]);
    expect(planGroups('hard', 'leader', 4)).toEqual([{ toughness: 'standard', count: 3 }, { toughness: 'boss', count: 1 }]);
    expect(planGroups('moderate', 'mixed', 5)).toEqual([{ toughness: 'standard', count: 2 }, { toughness: 'minion', count: 2 }, { toughness: 'elite', count: 1 }]);
    expect(planGroups('hard', 'mixed', 6)).toEqual([{ toughness: 'standard', count: 4 }, { toughness: 'elite', count: 1 }, { toughness: 'boss', count: 1 }]);
  });

  it('gives a lone enemy the strongest toughness for the mix', () => {
    expect(planGroups('hard', 'leader', 1)).toEqual([{ toughness: 'boss', count: 1 }]);
    expect(planGroups('hard', 'mixed', 1)).toEqual([{ toughness: 'boss', count: 1 }]);
    expect(planGroups('hard', 'same', 1)).toEqual([{ toughness: 'elite', count: 1 }]);
  });
});

describe('scaleStats', () => {
  const base = { hp: 20, ac: 13, initiativeMod: 1 };
  it('scales from the typical enemy', () => {
    expect(scaleStats(base, 'minion')).toEqual({ hpMax: 8, ac: 12, initiativeMod: 1 });
    expect(scaleStats(base, 'standard')).toEqual({ hpMax: 20, ac: 13, initiativeMod: 1 });
    expect(scaleStats(base, 'elite')).toEqual({ hpMax: 50, ac: 15, initiativeMod: 3 });
    expect(scaleStats(base, 'boss')).toEqual({ hpMax: 80, ac: 16, initiativeMod: 4 });
  });
  it('keeps HP at least 1, AC at least 0, and leaves AC out when the system has none', () => {
    expect(scaleStats({ hp: 1, ac: 0, initiativeMod: 0 }, 'minion')).toEqual({ hpMax: 1, ac: 0, initiativeMod: 0 });
    expect(scaleStats({ hp: 10, initiativeMod: 0 }, 'elite')).toEqual({ hpMax: 25, initiativeMod: 2 });
  });
});
