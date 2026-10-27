import { z } from 'zod';
import { HexColor, UserSub, plainText } from './common';

export const ConditionList = z.array(plainText(40).pipe(z.string().min(1))).max(30);

export const CreateCharacterInput = z.object({
  name: plainText(60).pipe(z.string().min(1, 'Name your character')),
  /** GM may create a character for any member; players always own what they create. */
  ownerSub: UserSub.optional(),
  sheet: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateCharacterInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  name: plainText(60).pipe(z.string().min(1)).optional(),
  /** Full replacement sheet; validated by the campaign's game-system adapter. */
  sheet: z.record(z.string(), z.unknown()).optional(),
  conditions: ConditionList.optional(),
  ownerSub: UserSub.optional(),
  gmNotes: plainText(10000).optional(),
});

export const ItemInput = z.object({
  name: plainText(80).pipe(z.string().min(1, 'Name the item')),
  description: plainText(2000).default(''),
  quantity: z.number().int().min(0).max(100000).default(1),
  weight: z.number().min(0).max(100000).optional(),
  tags: z.array(plainText(30).pipe(z.string().min(1))).max(10).default([]),
  charges: z.object({ current: z.number().int().min(0).max(1000), max: z.number().int().min(0).max(1000) }).optional(),
  state: z.enum(['EQUIPPED', 'CARRIED', 'STASHED']).default('CARRIED'),
  gmNote: plainText(2000).optional(),
});

export const CharacterExport = z.object({
  format: z.literal('d20.character'),
  version: z.literal(1),
  name: plainText(60).pipe(z.string().min(1)),
  systemId: z.string().max(40),
  systemVersion: z.string().max(20),
  sheet: z.record(z.string(), z.unknown()),
  conditions: ConditionList.default([]),
  items: z.array(ItemInput.omit({ gmNote: true })).max(500).default([]),
});

export const ImportCharacterInput = z.object({ data: CharacterExport, ownerSub: UserSub.optional() });

export const CreatureInput = z.object({
  name: plainText(60).pipe(z.string().min(1, 'Name the creature')),
  tint: HexColor.default('#b23a48'),
  sizeMeters: z.number().positive().max(1000).optional(),
  hpMax: z.number().int().min(1).max(100000),
  ac: z.number().int().min(0).max(100).optional(),
  initiativeMod: z.number().int().min(-50).max(50).default(0),
  notes: plainText(10000).default(''),
});

export const EncounterInput = z.object({
  name: plainText(80).pipe(z.string().min(1, 'Name the encounter')),
  notes: plainText(10000).default(''),
  groups: z
    .array(z.object({ creatureId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), count: z.number().int().min(1).max(30) }))
    .min(1, 'Add at least one creature')
    .max(20),
});

export const JournalInput = z.object({
  title: plainText(120).pipe(z.string().min(1, 'Give the entry a title')),
  body: plainText(50000).default(''),
  visibility: z.enum(['GM_ONLY', 'ALL', 'SELECTED_PLAYERS']).default('GM_ONLY'),
  allowedViewerIds: z.array(UserSub).max(50).optional(),
});
