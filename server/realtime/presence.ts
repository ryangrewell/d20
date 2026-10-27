import { z } from 'zod';
import { CURSOR_RATE, type PresenceEvent } from '@shared/events';
import type { CampaignMember } from '@shared/model';

const CursorBody = z.object({
  type: z.literal('CURSOR'),
  cursor: z.object({
    sceneId: z.string().max(40),
    nx: z.number().min(-0.05).max(1.05),
    ny: z.number().min(-0.05).max(1.05),
    seq: z.number().int().nonnegative(),
    ping: z.boolean().optional(),
  }),
});
const LeaveBody = z.object({ type: z.literal('LEAVE') });
const PresenceBody = z.union([CursorBody, LeaveBody]);

/** Token bucket per actor; in Lambda this is per warm container (best effort). */
export class PresenceLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  allow(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: CURSOR_RATE.burst, at: now };
    b.tokens = Math.min(CURSOR_RATE.burst, b.tokens + ((now - b.at) / 1000) * CURSOR_RATE.hz * 1.5);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return true;
  }
}

/**
 * Validates a client presence packet and stamps the server-known identity.
 * Any actor/name/color in the client body is discarded.
 */
export function sanitizePresence(raw: unknown, member: CampaignMember): PresenceEvent | null {
  const parsed = PresenceBody.safeParse(raw);
  if (!parsed.success) return null;
  const actor = { sub: member.userSub, displayName: member.displayName };
  if (parsed.data.type === 'LEAVE') return { type: 'LEAVE', actor, ts: Date.now() };
  return { type: 'CURSOR', actor: { ...actor, color: member.color }, cursor: parsed.data.cursor, ts: Date.now() };
}
