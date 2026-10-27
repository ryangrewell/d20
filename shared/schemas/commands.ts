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
      })
      .partial(),
  }),
  removeSceneObject: z.object({ objectId: Id }),
  updateFog: z.object({ sceneId: Id, op: FogOpSchema }),
  resetFog: z.object({ sceneId: Id, initial: z.enum(['covered', 'revealed']) }),
  switchActiveScene: z.object({ sceneId: Id }),
  presenterFocus: z.object({ sceneId: Id, center: Point, zoom: z.number().positive().max(16) }),
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
