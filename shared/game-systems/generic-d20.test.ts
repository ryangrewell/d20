import { describe, expect, it } from 'vitest';
import { genericD20, abilityMod } from './generic-d20';

describe('generic-d20 adapter', () => {
  it('builds a valid default sheet', () => {
    const r = genericD20.validateCharacter(genericD20.defaultSheet());
    expect(r.ok).toBe(true);
  });

  it('preserves unknown custom keys', () => {
    const r = genericD20.validateCharacter({ ...genericD20.defaultSheet(), homebrewSanity: 42 });
    expect(r.ok && r.sheet.homebrewSanity).toBe(42);
  });

  it('rejects out-of-range values and bad dice', () => {
    expect(genericD20.validateCharacter({ str: 99 }).ok).toBe(false);
    expect(genericD20.validateCharacter({ attacks: [{ name: 'Sword', roll: 'not dice' }] }).ok).toBe(false);
    expect(genericD20.validateCharacter({ attacks: [{ name: 'Sword', roll: '1d20+5', damage: '1d8+3' }] }).ok).toBe(true);
    expect(genericD20.validateCharacter({ hp: { current: 5 } }).ok).toBe(false);
  });

  it('derives modifiers and initiative', () => {
    expect(abilityMod(10)).toBe(0);
    expect(abilityMod(15)).toBe(2);
    expect(abilityMod(7)).toBe(-2);
    expect(genericD20.initiativeModifier({ dex: 16 })).toBe(3);
    expect(genericD20.initiativeModifier({ dex: 16, initiative: 7 })).toBe(7);
    expect(genericD20.deriveDisplayStats({ wis: 14 }).passivePerception).toBe(12);
  });
});
