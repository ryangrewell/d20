/**
 * Turns domain changes into per-audience event items and publishes them.
 *
 * Every viewer gets exactly one durable stream carrying its own projection:
 *   - gm channel: full GM projection (no whispers unless addressed to them)
 *   - user/{sub} channel: that player's projection, or for GMs only personal items
 *   - shared channel: the common player projection (Shared Display)
 * so a hidden object never travels on a channel a player can subscribe to.
 */
import type { FogOp, FogShape, FogState } from '@shared/fog';
import { channelPath, type ActorStamp, type DurableEvent, type DurableEventBody } from '@shared/events';
import type { ChatMessage, GameSession, InitiativeState, PresenterFocus, Scene, SceneObject } from '@shared/model';
import { canViewerSeeObject, publicInitiative, publicObject, publicScene, publicSession, SHARED_VIEWER, type Viewer } from '@shared/projection';

export type Change =
  | { kind: 'object'; before?: SceneObject; after?: SceneObject; fog: FogState }
  | { kind: 'fog'; sceneId: string; seq: number; op: FogOp; objects: SceneObject[]; fogBefore: FogState; fogAfter: FogState }
  | { kind: 'fogReset'; sceneId: string; initial: 'covered' | 'revealed'; objects: SceneObject[]; fogBefore: FogState; fogAfter: FogState }
  | { kind: 'fogLayers'; sceneId: string; objects: SceneObject[]; fogBefore: FogState; fogAfter: FogState; explored: string | null; lights: FogShape[] }
  | { kind: 'session'; session: GameSession }
  | { kind: 'activeScene'; sceneId: string }
  | { kind: 'scene'; scene: Scene }
  | { kind: 'chat'; message: ChatMessage }
  | { kind: 'focus'; focus: PresenterFocus }
  | { kind: 'initiative'; state: InitiativeState }
  | { kind: 'character'; characterId: string; ownerSub: string }
  | { kind: 'sceneRefresh'; sceneId: string; reason: 'undo' | 'checkpoint' }
  | { kind: 'journal'; entryId: string; title: string; readers: 'ALL' | 'GM_ONLY' | string[]; newlyShared: boolean }
  | { kind: 'access'; reason: 'epoch-rotated' | 'member-removed' };

export type Audience = { kind: 'gm' } | { kind: 'shared' } | { kind: 'player'; sub: string } | { kind: 'gmPersonal'; sub: string };

function viewerOf(a: Audience): Viewer {
  if (a.kind === 'gm') return { kind: 'gm' };
  if (a.kind === 'player') return { kind: 'player', sub: a.sub };
  return SHARED_VIEWER;
}

function canReadMessage(m: ChatMessage, a: Audience): boolean {
  if (a.kind === 'shared') return false;
  if (m.scope === 'TABLE') return a.kind !== 'gmPersonal';
  if (a.kind === 'gm') return false; // whispers to a GM arrive on their personal channel
  return !!m.recipientSubs?.includes(a.sub);
}

/** Pure projection of one change for one audience. Exported for tests. */
export function projectChange(change: Change, a: Audience, activeSceneId: string | undefined): DurableEventBody[] {
  if (a.kind === 'gmPersonal') {
    return change.kind === 'chat' && canReadMessage(change.message, a) ? [{ type: 'CHAT_MESSAGE_CREATED', message: change.message }] : [];
  }
  const viewer = viewerOf(a);
  const isGM = viewer.kind === 'gm';
  const sceneVisible = (sceneId: string) => isGM || sceneId === activeSceneId;

  switch (change.kind) {
    case 'object': {
      const obj = change.after ?? change.before!;
      if (!sceneVisible(obj.sceneId)) return [];
      const before = !!change.before && canViewerSeeObject(change.before, viewer, change.fog);
      const after = !!change.after && canViewerSeeObject(change.after, viewer, change.fog);
      if (after) return [{ type: 'SCENE_OBJECT_UPSERTED', object: isGM ? change.after! : publicObject(change.after!) }];
      if (before || (isGM && !change.after)) return [{ type: 'SCENE_OBJECT_REMOVED', sceneId: obj.sceneId, objectId: obj.id }];
      return [];
    }
    case 'fog':
    case 'fogReset':
    case 'fogLayers': {
      if (!sceneVisible(change.sceneId)) return [];
      const items: DurableEventBody[] =
        change.kind === 'fog'
          ? [{ type: 'FOG_UPDATED', sceneId: change.sceneId, seq: change.seq, op: change.op }]
          : change.kind === 'fogReset'
            ? [{ type: 'FOG_RESET', sceneId: change.sceneId, initial: change.initial }]
            : [{ type: 'FOG_LAYERS', sceneId: change.sceneId, explored: change.explored, lights: change.lights }];
      if (isGM) return items;
      for (const o of change.objects) {
        const before = canViewerSeeObject(o, viewer, change.fogBefore);
        const after = canViewerSeeObject(o, viewer, change.fogAfter);
        if (after && !before) items.push({ type: 'SCENE_OBJECT_UPSERTED', object: publicObject(o) });
        if (before && !after) items.push({ type: 'SCENE_OBJECT_REMOVED', sceneId: o.sceneId, objectId: o.id });
      }
      return items;
    }
    case 'session':
      return [{ type: 'SESSION_UPDATED', session: isGM ? change.session : publicSession(change.session) }];
    case 'activeScene':
      return [{ type: 'ACTIVE_SCENE_CHANGED', sceneId: change.sceneId }];
    case 'scene':
      return sceneVisible(change.scene.id) ? [{ type: 'SCENE_UPDATED', scene: isGM ? change.scene : publicScene(change.scene) }] : [];
    case 'chat':
      return canReadMessage(change.message, a) ? [{ type: 'CHAT_MESSAGE_CREATED', message: change.message }] : [];
    case 'focus':
      return [{ type: 'PRESENTER_FOCUS', focus: change.focus }];
    case 'initiative':
      return [{ type: 'INITIATIVE_UPDATED', initiative: isGM ? change.state : publicInitiative(change.state) }];
    case 'character':
      // Sheets are private to their owner and the GM; even the id is not sent to others.
      return isGM || (viewer.kind === 'player' && viewer.sub === change.ownerSub && a.kind === 'player') ? [{ type: 'CHARACTER_UPDATED', characterId: change.characterId }] : [];
    case 'sceneRefresh':
      return sceneVisible(change.sceneId) ? [{ type: 'SCENE_REFRESH', sceneId: change.sceneId, reason: change.reason }] : [];
    case 'journal': {
      if (isGM) return [{ type: 'JOURNAL_UPDATED', entryId: change.entryId, title: change.title, shared: false }];
      if (a.kind !== 'player') return [];
      const readable = change.readers === 'ALL' || (Array.isArray(change.readers) && change.readers.includes(a.sub));
      return readable ? [{ type: 'JOURNAL_UPDATED', entryId: change.entryId, title: change.title, shared: change.newlyShared }] : [];
    }
    case 'access':
      return [{ type: 'ACCESS_CHANGED', reason: change.reason }];
  }
}

export type SessionAudience = { gmSubs: string[]; playerSubs: string[] };

export type AudienceBundle = { channel: string; audience: Audience; event: DurableEvent };

export function buildBundles(
  session: Pick<GameSession, 'id' | 'accessEpoch' | 'activeSceneId'>,
  aud: SessionAudience,
  changes: Change[],
  meta: { eventId: string; revision: number; ts: string; actor?: ActorStamp },
): AudienceBundle[] {
  const epoch = session.accessEpoch;
  const targets: { channel: string; audience: Audience }[] = [
    { channel: channelPath({ ns: 'game', sessionId: session.id, epoch, audience: 'gm' }), audience: { kind: 'gm' } },
    { channel: channelPath({ ns: 'game', sessionId: session.id, epoch, audience: 'shared' }), audience: { kind: 'shared' } },
    ...aud.playerSubs.map((sub) => ({ channel: channelPath({ ns: 'game', sessionId: session.id, epoch, audience: 'user', sub }), audience: { kind: 'player', sub } as Audience })),
    ...aud.gmSubs.map((sub) => ({ channel: channelPath({ ns: 'game', sessionId: session.id, epoch, audience: 'user', sub }), audience: { kind: 'gmPersonal', sub } as Audience })),
  ];
  const out: AudienceBundle[] = [];
  for (const t of targets) {
    const items = changes.flatMap((c) => projectChange(c, t.audience, session.activeSceneId));
    if (items.length) out.push({ ...t, event: { ...meta, sessionId: session.id, items } });
  }
  return out;
}

/** Serialisable per-audience record stored with the session event for replay. */
export function bundlesForStorage(bundles: AudienceBundle[]) {
  const stored: Record<string, DurableEventBody[]> = {};
  for (const b of bundles) {
    const key = b.audience.kind === 'gm' ? 'gm' : b.audience.kind === 'shared' ? 'shared' : `user:${b.audience.sub}`;
    stored[key] = b.event.items;
  }
  return stored;
}
