import { z } from 'zod';
import { DISTANCE_UNITS } from '../units';
import { GRID_TYPES } from '../geometry/grid';

export const Id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Invalid id');
export const UserSub = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);
export const IsoDate = z.string().datetime({ offset: true });

/** Plain text with control characters stripped. Rendered as text, never HTML. */
export const plainText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim());

export const DisplayName = plainText(40).pipe(z.string().min(1, 'Display name is required'));

export const HttpsUrl = z
  .string()
  .max(500)
  .url()
  .refine((u) => u.startsWith('https://'), 'Use an https:// link');

export const Point = z.object({ x: z.number().finite(), y: z.number().finite() });

export const DistanceUnit = z.enum(DISTANCE_UNITS);

export const GridSchema = z.object({
  type: z.enum(GRID_TYPES),
  intervalMeters: z.number().positive().max(1_000_000),
  displayInterval: z.number().positive(),
  displayUnit: DistanceUnit,
  originX: z.number().finite(),
  originY: z.number().finite(),
  rotationRadians: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2),
  snapEnabled: z.boolean(),
  showEnabled: z.boolean(),
  opacity: z.number().min(0).max(1),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a #rrggbb color').optional(),
});

const Segment = z.object({ a: Point, b: Point });
export const MapWallsSchema = z.object({
  rooms: z.array(z.object({ id: z.string().min(1).max(40), name: z.string().max(80).optional(), points: z.array(Point).min(3).max(200) })).max(200),
  doorways: z.array(Segment).max(400),
});

export const CalibrationSchema = z.object({
  a: Point,
  b: Point,
  enteredDistance: z.number().positive(),
  enteredUnit: DistanceUnit,
  pixelsPerMeter: z.number().positive(),
});

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A piece-by-piece LPC sprite (see shared/sprites/compose). */
export const SpriteRecipeSchema = z.object({
  v: z.literal(1),
  body: z.enum(['male', 'female']),
  skin: z.string().min(1).max(40),
  parts: z.array(z.object({ item: z.string().min(1).max(80), colors: z.record(z.string().max(20), z.string().max(40)).optional() })).max(40),
});

/** How a character's or creature's picture was made, so the builder can reopen it. */
export const SpriteSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lpc'), recipe: SpriteRecipeSchema }),
  z.object({ kind: z.literal('animal'), id: z.string().min(1).max(60) }),
  z.object({ kind: z.literal('upload') }),
]);
