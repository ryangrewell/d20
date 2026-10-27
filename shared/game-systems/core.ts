/**
 * Versioned, declarative game-system adapters. Adapters are registered from
 * trusted application code only; no user-supplied code is ever executed.
 * A sheet is plain JSON described by sections of typed fields, so the client
 * can render any adapter's sheet generically and the server can validate it.
 */
import { z } from 'zod';
import { parseDice } from '../dice/dice';

export type ListItemField = { key: string; label: string; kind: 'text' | 'number' | 'dice' };

export type FieldDef =
  | { key: string; label: string; kind: 'number'; min?: number; max?: number; default?: number; hint?: string }
  | { key: string; label: string; kind: 'text'; max?: number; default?: string; hint?: string }
  | { key: string; label: string; kind: 'textarea'; max?: number; default?: string; hint?: string }
  | { key: string; label: string; kind: 'resource'; default?: { current: number; max: number }; hint?: string }
  | { key: string; label: string; kind: 'list'; itemFields: ListItemField[]; maxItems?: number; hint?: string };

export type SheetSection = { id: string; title: string; layout: 'grid' | 'stack'; fields: FieldDef[] };

export type ValidationResult = { ok: true; sheet: Record<string, unknown> } | { ok: false; errors: { path: string; message: string }[] };

export interface GameSystemAdapter {
  id: string;
  version: string;
  displayName: string;
  sections: SheetSection[];
  conditionDefinitions: string[];
  /** Sheet key holding the initiative modifier (falls back to derived stats). */
  initiative: { label: string; dice: string };
  diceNotationSupport: string[];
  defaultGridDistance: { value: number; unit: 'ft' | 'm' };
  defaultSheet(): Record<string, unknown>;
  validateCharacter(data: unknown): ValidationResult;
  deriveDisplayStats(sheet: Record<string, unknown>): Record<string, number | string>;
  initiativeModifier(sheet: Record<string, unknown>): number;
  /** Upgrades sheets from older adapter versions; unknown keys must be preserved. */
  migrate(fromVersion: string, sheet: Record<string, unknown>): Record<string, unknown>;
}

const MAX_TEXT = 200;
const MAX_TEXTAREA = 20000;

const diceString = z
  .string()
  .max(120)
  .refine((v) => {
    if (!v.trim()) return true;
    try {
      parseDice(v);
      return true;
    } catch {
      return false;
    }
  }, 'Use dice notation like 1d20+5');

function fieldSchema(f: FieldDef): z.ZodType {
  switch (f.kind) {
    case 'number': {
      let n = z.number().finite();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      return n;
    }
    case 'text':
      return z.string().max(f.max ?? MAX_TEXT);
    case 'textarea':
      return z.string().max(f.max ?? MAX_TEXTAREA);
    case 'resource':
      return z.object({ current: z.number().finite().min(-100000).max(100000), max: z.number().finite().min(0).max(100000) });
    case 'list':
      return z
        .array(
          z.object(
            Object.fromEntries(
              f.itemFields.map((i) => [i.key, i.kind === 'number' ? z.number().finite().optional() : i.kind === 'dice' ? diceString.optional() : z.string().max(MAX_TEXT).optional()]),
            ),
          ),
        )
        .max(f.maxItems ?? 50);
  }
}

/** Builds a validator from the declarative sections. Unknown keys pass through untouched. */
export function buildSheetValidator(sections: SheetSection[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const s of sections) for (const f of s.fields) shape[f.key] = fieldSchema(f).optional();
  const schema = z.object(shape).passthrough();
  return (data: unknown): ValidationResult => {
    if (JSON.stringify(data ?? {}).length > 100_000) return { ok: false, errors: [{ path: '', message: 'Character sheet is too large.' }] };
    const r = schema.safeParse(data ?? {});
    if (r.success) return { ok: true, sheet: r.data as Record<string, unknown> };
    return { ok: false, errors: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) };
  };
}

export function defaultsFor(sections: SheetSection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sections)
    for (const f of s.fields) {
      if (f.kind === 'list') out[f.key] = [];
      else if (f.default !== undefined) out[f.key] = f.default;
    }
  return out;
}

export const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
