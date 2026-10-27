/**
 * AppSync Events channel-namespace handler (direct Lambda integration) for
 * onSubscribe and onPublish. Enforces the same channel authorisation as the
 * local hub: campaign membership, role, user-channel ownership and access
 * epoch. Presence publishes are validated and re-stamped with the caller's
 * server-known identity so packets cannot spoof another participant.
 */
import { loadConfig } from '../../../server/config';
import { createDeps } from '../../../server/bootstrap';
import { authorizeChannel } from '../../../server/realtime/authorize';
import { PresenceLimiter, sanitizePresence } from '../../../server/realtime/presence';

const deps = createDeps({ config: loadConfig() });
const limiter = new PresenceLimiter();

type EventsLambdaRequest = {
  info: { channel: { path: string }; channelNamespace: { name: string }; operation: 'SUBSCRIBE' | 'PUBLISH' };
  identity?: { sub?: string; claims?: Record<string, unknown> } | null;
  events?: { id: string; payload: unknown }[];
};

type EventsLambdaResponse = { error?: string; events?: { id: string; payload: unknown }[] } | null;

export async function handler(req: EventsLambdaRequest): Promise<EventsLambdaResponse> {
  const sub = req.identity?.sub ?? (req.identity?.claims?.sub as string | undefined);
  // IAM-authorised publishes come from the API Lambda (no Cognito sub); AppSync
  // already restricts IAM publish to the backend role, so pass them through.
  if (!sub) {
    if (req.info.operation === 'PUBLISH' && req.info.channelNamespace.name === 'game') return { events: (req.events ?? []).map((e) => ({ id: e.id, payload: e.payload })) };
    return { error: 'Unauthorized' };
  }
  const op = req.info.operation === 'SUBSCRIBE' ? 'subscribe' : 'publish';
  const decision = await authorizeChannel(deps, sub, req.info.channel.path, op);
  if (!decision.ok) return { error: 'Unauthorized' };
  if (op === 'subscribe') return null;

  if (!limiter.allow(sub)) return { events: [] };
  const events = (req.events ?? []).slice(0, 5).flatMap((e) => {
    const payload = typeof e.payload === 'string' ? safeJson(e.payload) : e.payload;
    const clean = sanitizePresence(payload, decision.member);
    return clean ? [{ id: e.id, payload: clean }] : [];
  });
  return { events };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
