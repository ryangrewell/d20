/**
 * generic-d20: a system-agnostic d20 sheet. Six abilities, defence, hit
 * points, attacks/powers, resources, custom stats and notes. Contains no
 * rulebook text; works for most d20-style games and homebrew.
 */
import { buildSheetValidator, defaultsFor, num, type GameSystemAdapter, type SheetSection } from './core';

const ABILITIES = [
  ['str', 'Strength'],
  ['dex', 'Dexterity'],
  ['con', 'Constitution'],
  ['int', 'Intelligence'],
  ['wis', 'Wisdom'],
  ['cha', 'Charisma'],
] as const;

const sections: SheetSection[] = [
  {
    id: 'identity',
    title: 'Identity',
    layout: 'grid',
    fields: [
      { key: 'role', label: 'Class / role', kind: 'text', default: '' },
      { key: 'level', label: 'Level', kind: 'number', min: 0, max: 100, default: 1 },
      { key: 'ancestry', label: 'Ancestry / origin', kind: 'text', default: '' },
      { key: 'background', label: 'Background', kind: 'text', default: '' },
    ],
  },
  {
    id: 'defense',
    title: 'Defence & health',
    layout: 'grid',
    fields: [
      { key: 'hp', label: 'Hit points', kind: 'resource', default: { current: 10, max: 10 } },
      { key: 'tempHp', label: 'Temporary HP', kind: 'number', min: 0, max: 10000, default: 0 },
      { key: 'ac', label: 'Armour class / defence', kind: 'number', min: 0, max: 100, default: 10 },
      { key: 'speed', label: 'Speed', kind: 'text', default: '30 ft' },
      { key: 'initiative', label: 'Initiative bonus', kind: 'number', min: -50, max: 50, hint: 'Leave empty to use the Dexterity modifier.' },
      { key: 'proficiency', label: 'Proficiency bonus', kind: 'number', min: 0, max: 20, default: 2 },
    ],
  },
  {
    id: 'abilities',
    title: 'Abilities',
    layout: 'grid',
    fields: ABILITIES.map(([key, label]) => ({ key, label, kind: 'number' as const, min: 1, max: 30, default: 10 })),
  },
  {
    id: 'attacks',
    title: 'Attacks & powers',
    layout: 'stack',
    fields: [
      {
        key: 'attacks',
        label: 'Attacks & powers',
        kind: 'list',
        maxItems: 40,
        itemFields: [
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'roll', label: 'To hit / check', kind: 'dice' },
          { key: 'damage', label: 'Damage / effect', kind: 'dice' },
          { key: 'notes', label: 'Notes', kind: 'text' },
        ],
      },
    ],
  },
  {
    id: 'resources',
    title: 'Resources',
    layout: 'stack',
    fields: [
      {
        key: 'resources',
        label: 'Spell slots, ki, hero points…',
        kind: 'list',
        maxItems: 30,
        itemFields: [
          { key: 'name', label: 'Resource', kind: 'text' },
          { key: 'current', label: 'Current', kind: 'number' },
          { key: 'max', label: 'Max', kind: 'number' },
        ],
      },
    ],
  },
  {
    id: 'custom',
    title: 'Custom stats',
    layout: 'stack',
    fields: [
      {
        key: 'custom',
        label: 'House-rule or system-specific values',
        kind: 'list',
        maxItems: 50,
        itemFields: [
          { key: 'label', label: 'Stat', kind: 'text' },
          { key: 'value', label: 'Value', kind: 'text' },
        ],
      },
    ],
  },
  {
    id: 'notes',
    title: 'Notes',
    layout: 'stack',
    fields: [
      { key: 'features', label: 'Features & traits', kind: 'textarea', default: '' },
      { key: 'notes', label: 'Notes', kind: 'textarea', default: '' },
    ],
  },
];

export const abilityMod = (score: number) => Math.floor((score - 10) / 2);

export const genericD20: GameSystemAdapter = {
  id: 'generic-d20',
  version: '1',
  displayName: 'Generic d20',
  sections,
  conditionDefinitions: [
    'Blinded', 'Bloodied', 'Charmed', 'Concentrating', 'Deafened', 'Exhausted', 'Frightened', 'Grappled',
    'Hidden', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
  ],
  initiative: { label: 'Initiative', dice: '1d20' },
  diceNotationSupport: ['NdS', '+/-', 'kh', 'kl', 'dh', 'dl', 'd%'],
  defaultGridDistance: { value: 5, unit: 'ft' },
  defaultSheet: () => defaultsFor(sections),
  validateCharacter: buildSheetValidator(sections),
  deriveDisplayStats(sheet) {
    const out: Record<string, number | string> = {};
    for (const [key] of ABILITIES) out[`${key}Mod`] = abilityMod(num(sheet[key], 10));
    out.initiativeMod = genericD20.initiativeModifier(sheet);
    out.passivePerception = 10 + abilityMod(num(sheet.wis, 10));
    return out;
  },
  initiativeModifier(sheet) {
    return typeof sheet.initiative === 'number' ? sheet.initiative : abilityMod(num(sheet.dex, 10));
  },
  migrate(_fromVersion, sheet) {
    return sheet;
  },
};
