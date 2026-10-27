/**
 * Quick Encounter: turns "difficulty, how many, what mix" into creature groups,
 * with stats scaled from the campaign's typical enemy. System-neutral on purpose:
 * d20 doesn't know the rules, so everything is relative to the GM's own baseline.
 */
import type { EnemyBaseline } from './model';

export const DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const MIXES = ['same', 'leader', 'mixed'] as const;
export type Mix = (typeof MIXES)[number];
export const TOUGHNESS = ['minion', 'standard', 'elite', 'boss'] as const;
export type Toughness = (typeof TOUGHNESS)[number];

export const MAX_QUICK_ENEMIES = 20;

export type PlannedGroup = { toughness: Toughness; count: number };

const SCALE: Record<Toughness, { hp: number; ac: number; init: number }> = {
  minion: { hp: 0.4, ac: -1, init: 0 },
  standard: { hp: 1, ac: 0, init: 0 },
  elite: { hp: 2.5, ac: 2, init: 2 },
  boss: { hp: 4, ac: 3, init: 3 },
};

/** Splits `count` enemies into groups by toughness; the last group is the strongest. */
export function planGroups(difficulty: Difficulty, mix: Mix, count: number): PlannedGroup[] {
  const n = Math.max(1, Math.min(MAX_QUICK_ENEMIES, Math.floor(count)));
  const groups: [Toughness, number][] = [];
  if (mix === 'same') {
    if (difficulty === 'easy') groups.push(['minion', n]);
    else if (difficulty === 'moderate') groups.push(['standard', n]);
    else groups.push(['standard', n - 1], ['elite', 1]);
  } else if (mix === 'leader') {
    const [follower, leader]: [Toughness, Toughness] = difficulty === 'easy' ? ['minion', 'standard'] : difficulty === 'moderate' ? ['minion', 'elite'] : ['standard', 'boss'];
    groups.push([follower, n - 1], [leader, 1]);
  } else if (difficulty === 'easy') {
    const minions = n === 1 ? 0 : Math.ceil(n * 0.6);
    groups.push(['minion', minions], ['standard', n - minions]);
  } else if (difficulty === 'moderate') {
    const rest = n - 1;
    groups.push(['standard', Math.ceil(rest / 2)], ['minion', Math.floor(rest / 2)], ['elite', 1]);
  } else {
    const rest = n - 1;
    const elites = rest >= 2 ? Math.max(1, Math.floor(rest / 3)) : 0;
    groups.push(['standard', rest - elites], ['elite', elites], ['boss', 1]);
  }
  return groups.filter(([, c]) => c > 0).map(([toughness, c]) => ({ toughness, count: c }));
}

export function scaleStats(base: EnemyBaseline, toughness: Toughness): { hpMax: number; ac?: number; initiativeMod: number } {
  const s = SCALE[toughness];
  return {
    hpMax: Math.max(1, Math.round(base.hp * s.hp)),
    ...(base.ac !== undefined ? { ac: Math.max(0, base.ac + s.ac) } : {}),
    initiativeMod: base.initiativeMod + s.init,
  };
}

export const TOUGHNESS_LABEL: Record<Toughness, string> = { minion: 'Minions', standard: 'Standard', elite: 'Elite', boss: 'Boss' };
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', moderate: 'Moderate', hard: 'Hard' };
export const MIX_LABEL: Record<Mix, string> = { same: 'All the same', leader: 'Mob + a leader', mixed: 'Mixed' };

/** Token colors for newly named enemies, chosen to stand apart from each other. */
export const ENEMY_TINTS = ['#b23a48', '#c8752a', '#7a4bb3', '#2f7d8c', '#4f8a3a', '#a33b8c'] as const;
