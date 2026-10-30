/**
 * Realtime channel naming and event shapes.
 *
 * Durable channels are published only by the backend. The presence channel
 * accepts validated client publishes (cursor/ping), and the server stamps the
 * sender identity: a packet body can never claim to be someone else.
 */
import type { ChatMessage, CursorPacket, InitiativeState, PresenterFocus } from './model';
import type { PublicScene, PublicSceneObject, PublicSession } from './projection';
import type { FogOp, FogShape } from './fog';

export const GAME_NAMESPACE = 'game';
export const PRESENCE_NAMESPACE = 'presence';

export type ChannelRef =
  | { ns: 'game'; sessionId: string; epoch: number; audience: 'shared' }
  | { ns: 'game'; sessionId: string; epoch: number; audience: 'gm' }
  | { ns: 'game'; sessionId: string; epoch: number; audience: 'user'; sub: string }
  | { ns: 'presence'; sessionId: string; epoch: number };

export function channelPath(c: ChannelRef): string {
  if (c.ns === 'presence') return `/${PRESENCE_NAMESPACE}/${c.sessionId}/${c.epoch}`;
  if (c.audience === 'user') return `/${GAME_NAMESPACE}/${c.sessionId}/${c.epoch}/user/${c.sub}`;
  return `/${GAME_NAMESPACE}/${c.sessionId}/${c.epoch}/${c.audience}`;
}

const SEG = '[0-9A-Za-z-]{1,64}';
const GAME_RE = new RegExp(`^/${GAME_NAMESPACE}/(${SEG})/(\\d{1,9})/(shared|gm|user)(?:/(${SEG}))?$`);
const PRESENCE_RE = new RegExp(`^/${PRESENCE_NAMESPACE}/(${SEG})/(\\d{1,9})$`);

export function parseChannel(path: string): ChannelRef | null {
  const p = PRESENCE_RE.exec(path);
  if (p) return { ns: 'presence', sessionId: p[1]!, epoch: Number(p[2]) };
  const g = GAME_RE.exec(path);
  if (!g) return null;
  const [, sessionId, epoch, audience, sub] = g;
  if (audience === 'user') return sub ? { ns: 'game', sessionId: sessionId!, epoch: Number(epoch), audience: 'user', sub } : null;
  if (sub) return null;
  return { ns: 'game', sessionId: sessionId!, epoch: Number(epoch), audience: audience as 'shared' | 'gm' };
}

export type ActorStamp = { sub: string; displayName: string };

export type DurableEventBody =
  /** Automatic fog layers changed: explored area (encoded grid) and current torchlight. */
  | { type: 'FOG_LAYERS'; sceneId: string; explored: string | null; lights: FogShape[] }
  | { type: 'SESSION_UPDATED'; session: PublicSession }
  | { type: 'ACTIVE_SCENE_CHANGED'; sceneId: string }
  | { type: 'SCENE_UPDATED'; scene: PublicScene }
  | { type: 'SCENE_OBJECT_UPSERTED'; object: PublicSceneObject }
  | { type: 'SCENE_OBJECT_REMOVED'; sceneId: string; objectId: string }
  | { type: 'FOG_UPDATED'; sceneId: string; seq: number; op: FogOp }
  | { type: 'FOG_RESET'; sceneId: string; initial: 'covered' | 'revealed' }
  | { type: 'CHAT_MESSAGE_CREATED'; message: ChatMessage }
  | { type: 'PRESENTER_FOCUS'; focus: PresenterFocus }
  | { type: 'INITIATIVE_UPDATED'; initiative: InitiativeState }
  /** Only the id travels; authorised clients refetch the sheet. */
  | { type: 'CHARACTER_UPDATED'; characterId: string }
  /** Sent only to viewers who may read the entry; `shared` true when it was just shared with them. */
  | { type: 'JOURNAL_UPDATED'; entryId: string; title: string; shared: boolean }
  /** A scene changed in bulk (undo of fog, checkpoint restore); viewers refetch their snapshot. */
  | { type: 'SCENE_REFRESH'; sceneId: string; reason: 'undo' | 'checkpoint' }
  | { type: 'ACCESS_CHANGED'; reason: 'epoch-rotated' | 'member-removed' };

/**
 * One accepted command produces one event per audience, carrying the items
 * that audience may see, in order. Revisions are monotonic per session but
 * not contiguous for a given audience (other audiences' events are absent).
 */
export type DurableEvent = {
  eventId: string;
  sessionId: string;
  revision: number;
  ts: string;
  actor?: ActorStamp;
  items: DurableEventBody[];
};

export type PresenceEvent =
  | { type: 'CURSOR'; actor: ActorStamp & { color: string }; cursor: CursorPacket; ts: number }
  | { type: 'LEAVE'; actor: ActorStamp; ts: number };

export const CURSOR_RATE = { hz: 12, burst: 30 };
