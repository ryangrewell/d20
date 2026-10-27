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
});

export const CalibrationSchema = z.object({
  a: Point,
  b: Point,
  enteredDistance: z.number().positive(),
  enteredUnit: DistanceUnit,
  pixelsPerMeter: z.number().positive(),
});

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
