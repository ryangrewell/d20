import { z } from 'zod';
import { CalibrationSchema, DisplayName, GridSchema, HttpsUrl, Id, Point, plainText, HexColor, UserSub } from './common';
import { FOG_LIMITS } from '../fog';

// ------------------------------------------------------------------ profile
export const UpdateProfileInput = z.object({ displayName: DisplayName });

// ---------------------------------------------------------------- campaigns
export const CampaignSettingsInput = z.object({
  meetingUrl: HttpsUrl.optional().or(z.literal('').transform(() => undefined)),
  playerWhispers: z.boolean().default(true),
  allowSecretRolls: z.boolean().default(true),
  freeCamera: z.boolean().default(true),
});

export const CreateCampaignInput = z.object({
  title: plainText(80).pipe(z.string().min(1, 'Give your campaign a title')),
  description: plainText(2000).default(''),
  systemId: z.enum(['generic-d20']).default('generic-d20'),
  settings: CampaignSettingsInput.default({ playerWhispers: true, allowSecretRolls: true, freeCamera: true }),
});

export const UpdateCampaignInput = z.object({
  title: plainText(80).pipe(z.string().min(1)).optional(),
  description: plainText(2000).optional(),
  settings: CampaignSettingsInput.partial().optional(),
});

// ------------------------------------------------------------------ invites
export const CreateInviteInput = z.object({
  role: z.enum(['PLAYER', 'SPECTATOR']).default('PLAYER'),
  expiresInHours: z.number().int().min(1).max(24 * 90).optional(),
  maxUses: z.number().int().min(1).max(100).optional(),
});

export const AcceptInviteInput = z.object({ token: z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/) });

// ----------------------------------------------------------------- sessions
export const CreateSessionInput = z.object({
  title: plainText(80).default(''),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  meetingUrl: HttpsUrl.optional().or(z.literal('').transform(() => undefined)),
});

export const SessionTransitionInput = z.object({ action: z.enum(['start', 'pause', 'resume', 'end']) });

// --------------------------------------------------------------------- maps
export const MAP_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const UploadMapIntentInput = z.object({
  fileName: plainText(120),
  contentType: z.enum(MAP_CONTENT_TYPES),
  bytes: z.number().int().positive(),
});

export const MAP_CATEGORIES = ['world', 'region', 'city', 'outdoor', 'building', 'floor', 'dungeon', 'encounter', 'other'] as const;

export const FinalizeMapInput = z.object({
  assetId: Id,
  name: plainText(80).pipe(z.string().min(1, 'Name the map')),
  category: z.enum(MAP_CATEGORIES).default('other'),
  parentMapId: Id.optional(),
});

export const UpdateMapInput = z.object({
  name: plainText(80).pipe(z.string().min(1)).optional(),
  category: z.enum(MAP_CATEGORIES).optional(),
  calibration: CalibrationSchema.nullable().optional(),
  grid: GridSchema.optional(),
});

// ------------------------------------------------------------------- scenes
export const CreateSceneInput = z.object({
  mapId: Id,
  name: plainText(80).pipe(z.string().min(1, 'Name the scene')),
  fogInitial: z.enum(['covered', 'revealed']).default('revealed'),
  parentSceneId: Id.optional(),
});

export const UpdateSceneInput = z.object({
  name: plainText(80).pipe(z.string().min(1)).optional(),
  gmNotes: plainText(10000).optional(),
});

// --------------------------------------------------------------------- fog
const FogShapeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rect'), x: z.number().finite(), y: z.number().finite(), w: z.number().positive(), h: z.number().positive() }),
  z.object({ kind: z.literal('polygon'), points: z.array(Point).min(3).max(FOG_LIMITS.maxPolygonPoints) }),
  z.object({ kind: z.literal('brush'), radius: z.number().positive().max(100000), points: z.array(Point).min(1).max(FOG_LIMITS.maxBrushPoints) }),
]);
export const FogOpSchema = z.object({ mode: z.enum(['reveal', 'conceal']), shape: FogShapeSchema });

export { HexColor, UserSub };
