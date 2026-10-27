/**
 * Game command envelope. Clients submit durable actions here; the server
 * validates, authorises, persists, then broadcasts audience-filtered events.
 * Identity always comes from the verified token, never from this body.
 */
import { z } from 'zod';
import { HexColor, Id, Point, UserSub, plainText } from './common';
import { FogOpSchema } from './api';

const ObjectType = z.enum(['PC', 'NPC', 'CREATURE', 'LOOT', 'PROP', 'PIN']);
const Visibility = z.enum(['GM_ONLY', 'VISIBLE_TO_ALL', 'SELECTED_PLAYERS']);
const Conditions = z.array(plainText(40).pipe(z.string().min(1))).max(20);
const LootEntries = z
  .array(z.object({ id: z.string().min(1).max(40), name: plainText(80).pipe(z.string().min(1)), description: plainText(500).optional(), quantity: z.number().int().min(0).max(100000) }))
  .max(50);
const GmStats = z.object({
  hp: z.object({ current: z.number().int().min(-100000).max(100000), max: z.number().int().min(0).max(100000) }).optional(),
  ac: z.number().int().min(0).max(100).optional(),
  initiativeMod: z.number().int().min(-50).max(50).optional(),
});

export const CommandPayloads = {
  moveToken: z.object({ objectId: Id, x: z.number().finite(), y: z.number().finite(), expectedObjectRevision: z.number().int().nonnegative().optional() }),
  spawnSceneObject: z.object({
    sceneId: Id,
    objectType: ObjectType,
    x: z.number().finite(),
    y: z.number().finite(),
    label: plainText(60).optional(),
    tint: HexColor.optional(),
    sizeMeters: z.number().positive().max(10000).optional(),
    visibility: Visibility.default('VISIBLE_TO_ALL'),
    allowedViewerIds: z.array(UserSub).max(50).optional(),
    assignedControllerSub: UserSub.optional(),
    gmNotes: plainText(4000).optional(),
    /** Spawn from a creature-library template (fills label, size, colour, GM stats and notes). */
    templateId: Id.optional(),
    /** Link a PC token to a character sheet. */
    characterId: Id.optional(),
    loot: LootEntries.optional(),
  }),
  updateSceneObject: z.object({
    objectId: Id,
    patch: z
      .object({
        label: plainText(60),
        tint: HexColor,
        sizeMeters: z.number().positive().max(10000),
        rotationRadians: z.number().finite(),
        zIndex: z.number().int().min(-1000).max(1000),
        visibility: Visibility,
        allowedViewerIds: z.array(UserSub).max(50),
        assignedControllerSub: UserSub.nullable(),
        gmNotes: plainText(4000),
        conditions: Conditions,
        loot: LootEntries,
        gmStats: GmStats,
        characterId: Id.nullable(),
      })
      .partial(),
  }),
  removeSceneObject: z.object({ objectId: Id }),
  /** GM moves a token to another scene, keeping its id, controller and appearance. Omit x/y to drop it at the map centre. */
  transferSceneObject: z.object({ objectId: Id, targetSceneId: Id, x: z.number().finite().optional(), y: z.number().finite().optional() }),
  updateFog: z.object({ sceneId: Id, op: FogOpSchema }),
  resetFog: z.object({ sceneId: Id, initial: z.enum(['covered', 'revealed']) }),
  switchActiveScene: z.object({ sceneId: Id }),
  presenterFocus: z.object({ sceneId: Id, center: Point, zoom: z.number().positive().max(16) }),
  /** GM places every creature of an encounter template around a point (hidden by default). */
  spawnEncounter: z.object({ encounterId: Id, sceneId: Id, x: z.number().finite(), y: z.number().finite(), visibility: Visibility.default('GM_ONLY') }),
  /** A player (or GM) takes items from a visible loot pile into a character's inventory, atomically. */
  pickupLoot: z.object({ objectId: Id, entryId: z.string().min(1).max(40), characterId: Id, quantity: z.number().int().min(1).max(100000) }),
  /** Rolls initiative on the server for these tokens. Players may roll only for tokens they control. */
  rollInitiative: z.object({ objectIds: z.array(Id).min(1).max(50) }),
  setInitiativeEntry: z.object({
    entryId: z.string().min(1).max(40).optional(),
    label: plainText(60).pipe(z.string().min(1)),
    value: z.number().int().min(-100).max(1000),
    hidden: z.boolean().default(false),
  }),
  removeInitiativeEntry: z.object({ entryId: z.string().min(1).max(40) }),
  advanceTurn: z.object({ direction: z.enum(['next', 'prev']).default('next') }),
  endCombat: z.object({}),
  sendChat: z.object({
    body: plainText(2000).pipe(z.string().min(1, 'Message is empty')),
    /** Omit for the whole table; otherwise a whisper to these members. */
    recipientSubs: z.array(UserSub).min(1).max(20).optional(),
  }),
  rollDice: z.object({
    expression: z.string().min(1).max(120),
    label: plainText(60).optional(),
    visibility: z.enum(['PUBLIC', 'GM', 'SELF']).default('PUBLIC'),
  }),
} as const;

export type CommandType = keyof typeof CommandPayloads;
export const COMMAND_TYPES = Object.keys(CommandPayloads) as CommandType[];

export const CommandEnvelope = z.object({
  commandId: z.string().uuid(),
  sessionId: Id,
  type: z.enum(COMMAND_TYPES as [CommandType, ...CommandType[]]),
  payload: z.unknown(),
});

export type CommandPayload<T extends CommandType> = z.infer<(typeof CommandPayloads)[T]>;
export type CommandInput<T extends CommandType = CommandType> = { commandId: string; sessionId: string; type: T; payload: z.input<(typeof CommandPayloads)[T]> };

export type CommandResult = { ok: true; commandId: string; newRevision: number; serverTime: string; duplicate?: boolean; result?: unknown };
