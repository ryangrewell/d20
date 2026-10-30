import { ulid } from 'ulid';
import type { z } from 'zod';
import { AppError, forbidden, notFound } from '@shared/errors';
import { channelPath, type DurableEventBody } from '@shared/events';
import type { FogState } from '@shared/fog';
import type { FogWire } from '@shared/dto';
import { encodeExplored } from '@shared/lighting/explored';
import type { Campaign, FogOpRecord, GameSession, MapDefinition, Scene, SceneObject } from '@shared/model';
import { canViewerSeeObject, publicObject, publicScene, publicSession, SHARED_VIEWER, type Viewer } from '@shared/projection';
import type { CreateSessionInput } from '@shared/schemas/api';
import { keys } from '../repo/db';
import { loadCampaign, loadSession, requireActiveCampaign, requireGM, type Actor, type Deps } from '../context';
import { commit, sessionAudience } from './commit';
import { listMembers } from './campaigns';
import { visibleMessages } from './chat';
import { encodeLights, loadLayers } from './lighting';
import { loadMapWalls } from './mapWalls';

function sessionItem(s: GameSession) {
  return { ...keys.session(s.id), GSI1PK: `CAMP#${s.campaignId}`, GSI1SK: `SESSION#${String(s.number).padStart(6, '0')}`, entity: 'Session', ...s };
}

export async function createSession(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof CreateSessionInput>) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  requireActiveCampaign(ctx);
  const counter = await deps.db.update<{ value: number }>({
    Key: keys.counter(campaignId, 'session'),
    UpdateExpression: 'ADD #v :one',
    ExpressionAttributeNames: { '#v': 'value' },
    ExpressionAttributeValues: { ':one': 1 },
  });
  const number = counter!.value;
  const [previous] = await deps.db.queryPrefix<GameSession>(`CAMP#${campaignId}`, 'SESSION#', { index: 'GSI1', forward: false, limit: 1 });
  const now = deps.now().toISOString();
  const meetingUrl = input.meetingUrl ?? ctx.campaign.settings.meetingUrl;
  const session: GameSession = {
    id: ulid(),
    campaignId,
    number,
    title: input.title || `Session ${number}`,
    status: 'PLANNED',
    revision: 0,
    accessEpoch: 1,
    createdAt: now,
    updatedAt: now,
    ...(previous?.activeSceneId ? { activeSceneId: previous.activeSceneId } : {}),
    ...(meetingUrl ? { meetingUrl } : {}),
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
  };
  await deps.db.put(sessionItem(session), { expr: 'attribute_not_exists(PK)' });
  return session;
}

const TRANSITIONS: Record<string, { from: GameSession['status'][]; to: GameSession['status'] }> = {
  start: { from: ['PLANNED', 'PAUSED'], to: 'LIVE' },
  pause: { from: ['LIVE'], to: 'PAUSED' },
  resume: { from: ['PAUSED'], to: 'LIVE' },
  end: { from: ['PLANNED', 'LIVE', 'PAUSED'], to: 'ENDED' },
};

export async function transitionSession(deps: Deps, actor: Actor, sessionId: string, action: keyof typeof TRANSITIONS) {
  const session = await loadSession(deps, sessionId);
  const ctx = await loadCampaign(deps, actor, session.campaignId, session);
  requireGM(ctx);
  const t = TRANSITIONS[action]!;
  if (!t.from.includes(session.status)) throw new AppError('CONFLICT', `A ${session.status.toLowerCase()} session cannot be ${action === 'end' ? 'ended' : action + 'ed'}.`);
  const now = deps.now().toISOString();
  const next: GameSession = {
    ...session,
    status: t.to,
    updatedAt: now,
    ...(action === 'start' && !session.startedAt ? { startedAt: now } : {}),
    ...(action === 'end' ? { endedAt: now } : {}),
  };
  const campaignUpdate =
    t.to === 'LIVE'
      ? { UpdateExpression: 'SET activeSessionId = :sid, updatedAt = :now', ExpressionAttributeValues: { ':sid': session.id, ':now': now } }
      : action === 'end'
        ? { UpdateExpression: 'REMOVE activeSessionId SET updatedAt = :now', ConditionExpression: 'activeSessionId = :sid', ExpressionAttributeValues: { ':sid': session.id, ':now': now } }
        : null;
  await commit(
    deps,
    session,
    actor,
    [{ kind: 'session', session: next }],
    [
      {
        Update: {
          Key: keys.session(session.id),
          UpdateExpression: 'SET #s = :s, updatedAt = :now, startedAt = :started' + (next.endedAt ? ', endedAt = :ended' : ''),
          ConditionExpression: '#s = :prev',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': next.status, ':now': now, ':prev': session.status, ':started': next.startedAt ?? null, ...(next.endedAt ? { ':ended': next.endedAt } : {}) },
        },
      },
    ],
    { projectionSession: next },
  );
  if (campaignUpdate) {
    await deps.db.update({ Key: keys.campaign(session.campaignId), ...campaignUpdate }).catch(() => undefined);
  }
  return publicSession(next);
}

export async function updateSessionDetails(deps: Deps, actor: Actor, sessionId: string, input: { title?: string; meetingUrl?: string | null; gmNotes?: string }) {
  const session = await loadSession(deps, sessionId);
  const ctx = await loadCampaign(deps, actor, session.campaignId, session);
  requireGM(ctx);
  const next: GameSession = { ...session, ...(input.title ? { title: input.title } : {}), ...(input.gmNotes !== undefined ? { gmNotes: input.gmNotes } : {}) };
  if (input.meetingUrl === null) delete next.meetingUrl;
  else if (input.meetingUrl) next.meetingUrl = input.meetingUrl;
  const set = ['title = :t', 'gmNotes = :g'];
  const values: Record<string, unknown> = { ':t': next.title, ':g': next.gmNotes ?? '' };
  if (next.meetingUrl) {
    set.push('meetingUrl = :m');
    values[':m'] = next.meetingUrl;
  }
  await commit(
    deps,
    session,
    actor,
    [{ kind: 'session', session: next }],
    [{ Update: { Key: keys.session(session.id), UpdateExpression: `SET ${set.join(', ')}${next.meetingUrl ? '' : ' REMOVE meetingUrl'}`, ExpressionAttributeValues: values } }],
    { projectionSession: next },
  );
  return next;
}

/** Fog as players see it: the GM's ops plus the automatic layers (explored area, current torchlight). */
export async function loadFog(deps: Deps, scene: Scene, opts: { objects?: SceneObject[] } = {}): Promise<{ fog: FogState; seq: number }> {
  const [ops, layers] = await Promise.all([deps.db.queryPrefix<FogOpRecord>(`SCENE#${scene.id}`, 'FOG#'), loadLayers(deps, scene, opts.objects)]);
  return { fog: { initial: scene.fogInitial, ops: ops.map((o) => o.op), ...layers }, seq: ops.at(-1)?.seq ?? 0 };
}

export const fogWire = (fog: FogState): FogWire => ({ initial: fog.initial, ops: fog.ops, explored: fog.explored ? encodeExplored(fog.explored) : null, lights: encodeLights(fog.lights) });

export async function loadSceneObjects(deps: Deps, sceneId: string) {
  return deps.db.queryPrefix<SceneObject>(`SCENE#${sceneId}`, 'OBJ#');
}

export type SnapshotView = 'auto' | 'shared' | { player: string };

/**
 * Authoritative snapshot for (re)connect. Built through the same projection as
 * events. GMs may request the shared or a named player's view for preview.
 */
export async function getSessionSnapshot(deps: Deps, actor: Actor, sessionId: string, view: SnapshotView = 'auto', sceneOverride?: string) {
  const session = await loadSession(deps, sessionId);
  const ctx = await loadCampaign(deps, actor, session.campaignId, session);
  const isGM = ctx.access.isGM;
  if (view !== 'auto' && !isGM) throw forbidden('Only the GM can preview other views.');
  const viewer: Viewer = view === 'auto' ? (isGM ? { kind: 'gm' } : { kind: 'player', sub: actor.sub }) : view === 'shared' ? SHARED_VIEWER : { kind: 'player', sub: view.player };
  const asGM = viewer.kind === 'gm';

  const members = (await listMembers(deps, session.campaignId)).map((m) => ({ userSub: m.userSub, displayName: m.displayName, color: m.color, role: m.role }));
  const epoch = session.accessEpoch;
  const channels =
    view === 'shared' || (view !== 'auto' && !asGM)
      ? [channelPath({ ns: 'game', sessionId, epoch, audience: 'shared' }), channelPath({ ns: 'presence', sessionId, epoch })]
      : [
          ...(asGM ? [channelPath({ ns: 'game', sessionId, epoch, audience: 'gm' })] : []),
          channelPath({ ns: 'game', sessionId, epoch, audience: 'user', sub: actor.sub }),
          channelPath({ ns: 'presence', sessionId, epoch }),
        ];
  // Player preview by a GM uses the shared stream for live updates; the snapshot itself is exact.
  const base = {
    session: asGM ? session : publicSession(session),
    campaign: { id: ctx.campaign.id, title: ctx.campaign.title, systemId: ctx.campaign.systemId, settings: ctx.campaign.settings },
    me: { sub: actor.sub, displayName: actor.displayName, isGM, isOwner: ctx.access.isOwner, color: ctx.access.member!.color },
    viewMode: asGM ? ('gm' as const) : view === 'auto' ? ('player' as const) : ('preview' as const),
    members,
    channels,
    revision: session.revision,
    chat: view === 'auto' ? await visibleMessages(deps, ctx.campaign.id, actor.sub, isGM, 60) : [],
  };

  const playerCanSee = session.status === 'LIVE' || session.status === 'PAUSED';
  if (!asGM && !playerCanSee) return { ...base, waiting: true as const, scene: null };

  const sceneId = asGM && sceneOverride ? sceneOverride : session.activeSceneId;
  if (!sceneId) return { ...base, waiting: false as const, scene: null };
  const scene = await deps.db.get<Scene>(keys.scene(sceneId));
  if (!scene || scene.campaignId !== session.campaignId) {
    if (sceneOverride) throw notFound('Scene');
    return { ...base, waiting: false as const, scene: null };
  }
  const [map, objects] = await Promise.all([deps.db.get<MapDefinition>(keys.map(scene.campaignId, scene.mapId)), loadSceneObjects(deps, scene.id)]);
  const fogState = await loadFog(deps, scene, { objects });
  if (!map) return { ...base, waiting: false as const, scene: null };
  // Walls (and the GM's room names) outline unexplored areas: GM only.
  const { walls: _w, ...playerMap } = map;
  const gmWalls = asGM ? await loadMapWalls(deps, map) : null;
  const asset = await deps.db.get<{ s3Key: string }>(keys.asset(scene.campaignId, map.assetId));
  const imageUrl = asset ? await deps.blobs.presignGet(asset.s3Key, 3600) : null;
  const visible = objects.filter((o) => canViewerSeeObject(o, viewer, fogState.fog));
  return {
    ...base,
    waiting: false as const,
    scene: {
      scene: asGM ? scene : publicScene(scene),
      map: asGM ? (gmWalls ? { ...map, walls: gmWalls } : map) : playerMap,
      imageUrl,
      objects: asGM ? visible : visible.map(publicObject),
      fog: fogWire(fogState.fog),
      fogSeq: fogState.seq,
    },
  };
}

export async function getEventsSince(deps: Deps, actor: Actor, sessionId: string, since: number) {
  const session = await loadSession(deps, sessionId);
  const ctx = await loadCampaign(deps, actor, session.campaignId, session);
  const rows = await deps.db.query<{ eventId: string; revision: number; ts: string; audiences: Record<string, DurableEventBody[]> }>(
    {
      // Bounded range: other SESSION# rows (CMD#, UNDO#) must not match.
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}`, ':from': `EVT#${String(since + 1).padStart(12, '0')}`, ':to': 'EVT#~' },
    },
    { limit: 500, all: false },
  );
  const out = [];
  for (const r of rows) {
    const items = [...(ctx.access.isGM ? (r.audiences.gm ?? []) : []), ...(r.audiences[`user:${actor.sub}`] ?? [])];
    if (items.length) out.push({ eventId: r.eventId, sessionId, revision: r.revision, ts: r.ts, items });
  }
  return { events: out, revision: session.revision, truncated: rows.length >= 500 };
}

/** Rotates access epochs on every non-ended session so stale subscriptions stop receiving events. */
export async function rotateLiveEpochs(deps: Deps, campaignId: string, reason: 'epoch-rotated' | 'member-removed') {
  const sessions = await deps.db.queryPrefix<GameSession>(`CAMP#${campaignId}`, 'SESSION#', { index: 'GSI1' });
  for (const s of sessions.filter((x) => x.status !== 'ENDED')) {
    await deps.db.update({ Key: keys.session(s.id), UpdateExpression: 'ADD accessEpoch :one', ExpressionAttributeValues: { ':one': 1 } });
    // Tell honest clients on the old epoch to resubscribe; revoked clients will fail authorisation.
    const notice = { eventId: ulid(), sessionId: s.id, revision: s.revision, ts: deps.now().toISOString(), items: [{ type: 'ACCESS_CHANGED', reason }] };
    const old = s.accessEpoch;
    const aud = await sessionAudience(deps, s);
    const targets = [
      channelPath({ ns: 'game', sessionId: s.id, epoch: old, audience: 'gm' }),
      channelPath({ ns: 'game', sessionId: s.id, epoch: old, audience: 'shared' }),
      ...[...aud.gmSubs, ...aud.playerSubs].map((sub) => channelPath({ ns: 'game', sessionId: s.id, epoch: old, audience: 'user', sub })),
    ];
    await Promise.allSettled(targets.map((c) => deps.publisher.publish(c, [notice])));
  }
}

export async function getCampaignForSession(deps: Deps, sessionId: string) {
  const s = await loadSession(deps, sessionId);
  return deps.db.get<Campaign>(keys.campaign(s.campaignId));
}
