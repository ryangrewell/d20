/**
 * Authoritative game commands. Each handler authorises against server-loaded
 * state, returns the domain changes and DynamoDB writes, and `commit`
 * persists + broadcasts them. Identity comes only from the verified actor.
 */
import { randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import { AppError, conflict, forbidden, invalid, notFound } from '@shared/errors';
import { describeRoll, DiceError, parseDice, rollDice } from '@shared/dice/dice';
import { FOG_LIMITS, type FogState } from '@shared/fog';
import type { CampaignMember, ChatMessage, GameSession, MapDefinition, Scene, SceneObject } from '@shared/model';
import { canViewerSeeObject } from '@shared/projection';
import { CommandEnvelope, CommandPayloads, type CommandPayload, type CommandResult, type CommandType } from '@shared/schemas/commands';
import { isConditionalFailure, keys } from '../repo/db';
import { loadCampaign, loadSession, type Actor, type CampaignContext, type Deps } from '../context';
import type { Change } from '../realtime/fanout';
import { commit, type TransactItem } from './commit';
import { loadFog, loadSceneObjects } from './sessions';
import { rateLimit } from './rateLimit';
import { listMembers } from './campaigns';
import { loadCreature } from './creatures';
import { loadCharacter } from './characters';
import { initiativeHandlers } from './initiative';
import { pickupLoot } from './loot';
import { spawnEncounter } from './encounters';

export type HandlerCtx = { deps: Deps; actor: Actor; session: GameSession; campaign: CampaignContext };
export type HandlerOutput = { changes: Change[]; writes: TransactItem[]; result?: unknown; projectionSession?: GameSession };
export type Handler<T extends CommandType> = (ctx: HandlerCtx, payload: CommandPayload<T>) => Promise<HandlerOutput>;

const MAX_OBJECTS_PER_SCENE = 500;

export function requireGM(ctx: HandlerCtx) {
  if (!ctx.campaign.access.isGM) throw forbidden('Only the GM can do that.');
}

export function requirePlayable(ctx: HandlerCtx) {
  if (ctx.campaign.access.isGM) {
    if (ctx.session.status === 'ENDED') throw conflict('This session has ended.');
    return;
  }
  if (ctx.session.status !== 'LIVE') throw conflict(ctx.session.status === 'PAUSED' ? 'The GM has paused the game.' : 'This session is not live.');
}

async function loadSceneFor(ctx: HandlerCtx, sceneId: string): Promise<Scene> {
  const scene = await ctx.deps.db.get<Scene>(keys.scene(sceneId));
  if (!scene || scene.campaignId !== ctx.session.campaignId) throw notFound('Scene');
  if (!ctx.campaign.access.isGM && scene.id !== ctx.session.activeSceneId) throw notFound('Scene');
  return scene;
}

export async function loadObjectFor(ctx: HandlerCtx, objectId: string, sceneHint?: string): Promise<{ obj: SceneObject; scene: Scene; fog: FogState }> {
  // Objects are keyed by scene; players can only address the active scene.
  const sceneId = sceneHint ?? ctx.session.activeSceneId;
  if (!sceneId) throw notFound('Token');
  const scene = await loadSceneFor(ctx, sceneId);
  const obj = await ctx.deps.db.get<SceneObject>(keys.object(scene.id, objectId));
  const { fog } = await loadFog(ctx.deps, scene);
  // Do not disclose the existence of objects the caller cannot see.
  if (!obj || (!ctx.campaign.access.isGM && !canViewerSeeObject(obj, { kind: 'player', sub: ctx.actor.sub }, fog))) throw notFound('Token');
  return { obj, scene, fog };
}

export function objectItem(o: SceneObject) {
  return { ...keys.object(o.sceneId, o.id), GSI1PK: `OBJ#${o.id}`, GSI1SK: 'OBJ', entity: 'SceneObject', ...o };
}

async function clampToMap(ctx: HandlerCtx, scene: Scene, x: number, y: number) {
  const map = await ctx.deps.db.get<MapDefinition>(keys.map(scene.campaignId, scene.mapId));
  if (!map) return { x, y };
  return { x: Math.min(Math.max(0, x), map.widthPx), y: Math.min(Math.max(0, y), map.heightPx) };
}

const handlers: { [K in CommandType]: Handler<K> } = {
  ...initiativeHandlers,
  pickupLoot,
  spawnEncounter,
  async moveToken(ctx, p) {
    requirePlayable(ctx);
    const sceneId = ctx.campaign.access.isGM ? await findObjectScene(ctx, p.objectId) : undefined;
    const { obj, scene, fog } = await loadObjectFor(ctx, p.objectId, sceneId);
    const isController = obj.assignedControllerSub === ctx.actor.sub;
    if (!ctx.campaign.access.isGM && !isController) throw forbidden('You can only move your own token.');
    if (p.expectedObjectRevision !== undefined && p.expectedObjectRevision !== obj.revision) {
      throw conflict('That token was moved by someone else. Its position has been refreshed.', { objectRevision: obj.revision });
    }
    const pos = await clampToMap(ctx, scene, p.x, p.y);
    const after: SceneObject = { ...obj, ...pos, revision: obj.revision + 1, updatedAt: ctx.deps.now().toISOString() };
    return {
      changes: [{ kind: 'object', before: obj, after, fog }],
      writes: [
        {
          Update: {
            Key: keys.object(scene.id, obj.id),
            UpdateExpression: 'SET x = :x, y = :y, revision = :next, updatedAt = :now',
            ConditionExpression: 'revision = :rev',
            ExpressionAttributeValues: { ':x': after.x, ':y': after.y, ':next': after.revision, ':rev': obj.revision, ':now': after.updatedAt },
          },
        },
      ],
      result: { objectRevision: after.revision },
    };
  },

  async spawnSceneObject(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const scene = await loadSceneFor(ctx, p.sceneId);
    if (scene.fogOpCount === undefined) throw notFound('Scene');
    const existing = await loadSceneObjects(ctx.deps, scene.id);
    if (existing.length >= MAX_OBJECTS_PER_SCENE) throw invalid(`A scene can hold at most ${MAX_OBJECTS_PER_SCENE} objects.`);
    if (p.assignedControllerSub) await requireMember(ctx, p.assignedControllerSub);
    const template = p.templateId ? await loadCreature(ctx.deps, scene.campaignId, p.templateId) : null;
    if (p.templateId && !template) throw notFound('Creature');
    const character = p.characterId ? await loadCharacter(ctx.deps, scene.campaignId, p.characterId) : null;
    if (p.characterId && !character) throw notFound('Character');
    const { fog } = await loadFog(ctx.deps, scene);
    const pos = await clampToMap(ctx, scene, p.x, p.y);
    const now = ctx.deps.now().toISOString();
    const label = p.label ?? template?.name ?? character?.name;
    const tint = p.tint ?? template?.tint;
    const sizeMeters = p.sizeMeters ?? template?.sizeMeters;
    const controller = p.assignedControllerSub ?? character?.ownerSub;
    const gmNotes = p.gmNotes ?? template?.notes;
    const obj: SceneObject = {
      id: ulid(),
      sceneId: scene.id,
      campaignId: scene.campaignId,
      objectType: p.objectType,
      ...pos,
      rotationRadians: 0,
      zIndex: existing.reduce((m, o) => Math.max(m, o.zIndex), 0) + 1,
      visibility: p.visibility,
      appearance: { ...(label ? { label } : {}), ...(tint ? { tint } : {}) },
      revision: 1,
      createdAt: now,
      updatedAt: now,
      ...(sizeMeters ? { sizeMeters } : {}),
      ...(p.allowedViewerIds?.length ? { allowedViewerIds: p.allowedViewerIds } : {}),
      ...(controller ? { assignedControllerSub: controller } : {}),
      ...(gmNotes ? { gmNotes } : {}),
      ...(character ? { characterId: character.id } : {}),
      ...(p.loot?.length ? { loot: p.loot } : {}),
      ...(template ? { gmStats: { hp: { current: template.hpMax, max: template.hpMax }, ...(template.ac !== undefined ? { ac: template.ac } : {}), initiativeMod: template.initiativeMod, templateId: template.id } } : {}),
    };
    return { changes: [{ kind: 'object', after: obj, fog }], writes: [{ Put: { Item: objectItem(obj), ConditionExpression: 'attribute_not_exists(PK)' } }], result: { objectId: obj.id } };
  },

  async updateSceneObject(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const { obj, fog } = await loadObjectFor(ctx, p.objectId, await findObjectScene(ctx, p.objectId));
    if (p.patch.assignedControllerSub) await requireMember(ctx, p.patch.assignedControllerSub);
    const after: SceneObject = { ...obj, revision: obj.revision + 1, updatedAt: ctx.deps.now().toISOString() };
    const { label, tint, assignedControllerSub, allowedViewerIds, characterId, gmStats, conditions, ...rest } = p.patch;
    Object.assign(after, rest);
    if (conditions) after.conditions = [...new Set(conditions)];
    if (gmStats) after.gmStats = { ...obj.gmStats, ...gmStats };
    if (characterId === null) delete after.characterId;
    else if (characterId) {
      if (!(await loadCharacter(ctx.deps, obj.campaignId, characterId))) throw notFound('Character');
      after.characterId = characterId;
    }
    if (label !== undefined || tint !== undefined) after.appearance = { ...obj.appearance, ...(label !== undefined ? { label } : {}), ...(tint !== undefined ? { tint } : {}) };
    if (assignedControllerSub === null) delete after.assignedControllerSub;
    else if (assignedControllerSub) after.assignedControllerSub = assignedControllerSub;
    if (allowedViewerIds) after.allowedViewerIds = allowedViewerIds;
    return {
      changes: [{ kind: 'object', before: obj, after, fog }],
      writes: [{ Put: { Item: objectItem(after), ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': obj.revision } } }],
    };
  },

  async removeSceneObject(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const { obj, fog } = await loadObjectFor(ctx, p.objectId, await findObjectScene(ctx, p.objectId));
    return { changes: [{ kind: 'object', before: obj, fog }], writes: [{ Delete: { Key: keys.object(obj.sceneId, obj.id) } }] };
  },

  async transferSceneObject(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const { obj, scene: source, fog: sourceFog } = await loadObjectFor(ctx, p.objectId, await findObjectScene(ctx, p.objectId));
    if (p.targetSceneId === source.id) throw invalid('That token is already in this scene.');
    const target = await loadSceneFor(ctx, p.targetSceneId);
    const [targetObjects, { fog: targetFog }, targetMap] = await Promise.all([
      loadSceneObjects(ctx.deps, target.id),
      loadFog(ctx.deps, target),
      ctx.deps.db.get<MapDefinition>(keys.map(target.campaignId, target.mapId)),
    ]);
    if (targetObjects.length >= MAX_OBJECTS_PER_SCENE) throw invalid(`A scene can hold at most ${MAX_OBJECTS_PER_SCENE} objects.`);
    const fallback = targetMap ? { x: targetMap.widthPx / 2, y: targetMap.heightPx / 2 } : { x: 0, y: 0 };
    const pos = await clampToMap(ctx, target, p.x ?? fallback.x, p.y ?? fallback.y);
    const after: SceneObject = {
      ...obj,
      ...pos,
      sceneId: target.id,
      zIndex: targetObjects.reduce((m, o) => Math.max(m, o.zIndex), 0) + 1,
      revision: obj.revision + 1,
      updatedAt: ctx.deps.now().toISOString(),
    };
    return {
      // Leaves the source scene and appears in the target; each audience sees whichever side it may see.
      changes: [
        { kind: 'object', before: obj, fog: sourceFog },
        { kind: 'object', after, fog: targetFog },
      ],
      writes: [
        { Delete: { Key: keys.object(source.id, obj.id), ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': obj.revision } } },
        { Put: { Item: objectItem(after), ConditionExpression: 'attribute_not_exists(PK)' } },
      ],
      result: { objectId: obj.id, sceneId: target.id, x: after.x, y: after.y },
    };
  },

  async updateFog(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const scene = await loadSceneFor(ctx, p.sceneId);
    if (scene.fogOpCount >= FOG_LIMITS.maxOpsPerScene) throw invalid('This scene has too many fog edits. Reset the fog to continue.');
    const [{ fog: fogBefore }, objects] = await Promise.all([loadFog(ctx.deps, scene), loadSceneObjects(ctx.deps, scene.id)]);
    const seq = scene.fogOpCount + 1;
    const fogAfter: FogState = { ...fogBefore, ops: [...fogBefore.ops, p.op] };
    return {
      changes: [{ kind: 'fog', sceneId: scene.id, seq, op: p.op, objects, fogBefore, fogAfter }],
      writes: [
        {
          Update: {
            Key: keys.scene(scene.id),
            UpdateExpression: 'SET fogOpCount = :seq, updatedAt = :now',
            ConditionExpression: 'fogOpCount = :prev',
            ExpressionAttributeValues: { ':seq': seq, ':prev': scene.fogOpCount, ':now': ctx.deps.now().toISOString() },
          },
        },
        { Put: { Item: { ...keys.fogOp(scene.id, seq), entity: 'FogOp', sceneId: scene.id, seq, op: p.op, createdAt: ctx.deps.now().toISOString() } } },
      ],
    };
  },

  async resetFog(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const scene = await loadSceneFor(ctx, p.sceneId);
    const [{ fog: fogBefore }, objects] = await Promise.all([loadFog(ctx.deps, scene), loadSceneObjects(ctx.deps, scene.id)]);
    // Old fog-op items are cleared lazily below the transaction limit; reset is recorded by bumping a generation.
    const ops = await ctx.deps.db.queryPrefix<{ seq: number }>(`SCENE#${scene.id}`, 'FOG#');
    if (ops.length > 90) {
      for (const o of ops.slice(0, ops.length - 90)) await ctx.deps.db.delete(keys.fogOp(scene.id, o.seq));
    }
    const remaining = ops.slice(-90);
    return {
      changes: [{ kind: 'fogReset', sceneId: scene.id, initial: p.initial, objects, fogBefore, fogAfter: { initial: p.initial, ops: [] } }],
      writes: [
        ...remaining.map((o) => ({ Delete: { Key: keys.fogOp(scene.id, o.seq) } })),
        {
          Update: {
            Key: keys.scene(scene.id),
            UpdateExpression: 'SET fogOpCount = :zero, fogInitial = :init, updatedAt = :now',
            ExpressionAttributeValues: { ':zero': 0, ':init': p.initial, ':now': ctx.deps.now().toISOString() },
          },
        },
      ],
    };
  },

  async switchActiveScene(ctx, p) {
    requireGM(ctx);
    if (ctx.session.status === 'ENDED') throw conflict('This session has ended.');
    const scene = await loadSceneFor(ctx, p.sceneId);
    const next: GameSession = { ...ctx.session, activeSceneId: scene.id };
    return {
      changes: [{ kind: 'activeScene', sceneId: scene.id }],
      writes: [{ Update: { Key: keys.session(ctx.session.id), UpdateExpression: 'SET activeSceneId = :s', ExpressionAttributeValues: { ':s': scene.id } } }],
      projectionSession: next,
    };
  },

  async presenterFocus(ctx, p) {
    requireGM(ctx);
    await loadSceneFor(ctx, p.sceneId);
    return { changes: [{ kind: 'focus', focus: p }], writes: [] };
  },

  async sendChat(ctx, p) {
    await rateLimit(ctx.deps, `chat:${ctx.actor.sub}`, 40, 60);
    if (ctx.session.status === 'ENDED') throw conflict('This session has ended.');
    const message = baseMessage(ctx, p.body, 'TEXT');
    if (p.recipientSubs) {
      const recipients = new Set(p.recipientSubs.filter((s) => s !== ctx.actor.sub));
      if (!recipients.size) throw invalid('Choose who to whisper to.');
      const members = await listMembers(ctx.deps, ctx.session.campaignId);
      const bySub = new Map(members.map((m) => [m.userSub, m]));
      for (const sub of recipients) if (!bySub.has(sub)) throw invalid('You can only whisper to members of this campaign.');
      if (!ctx.campaign.access.isGM && !ctx.campaign.campaign.settings.playerWhispers) {
        const gmSubs = new Set([ctx.campaign.campaign.ownerSub, ...ctx.campaign.delegations.filter((d) => !d.revokedAt).map((d) => d.delegateSub)]);
        if ([...recipients].some((s) => !gmSubs.has(s))) throw forbidden('Players can only whisper to the GM in this campaign.');
      }
      message.scope = 'WHISPER';
      message.recipientSubs = [ctx.actor.sub, ...recipients];
    }
    return { changes: [{ kind: 'chat', message }], writes: [{ Put: { Item: chatItem(message) } }], result: { messageId: message.id } };
  },

  async rollDice(ctx, p) {
    await rateLimit(ctx.deps, `dice:${ctx.actor.sub}`, 60, 60);
    if (ctx.session.status === 'ENDED') throw conflict('This session has ended.');
    if (p.visibility === 'GM' && !ctx.campaign.access.isGM && !ctx.campaign.campaign.settings.allowSecretRolls) throw forbidden('Secret rolls are disabled in this campaign.');
    let parsed;
    try {
      parsed = parseDice(p.expression);
    } catch (e) {
      if (e instanceof DiceError) throw invalid(e.message);
      throw e;
    }
    const result = rollDice(parsed, (n) => randomInt(n));
    const detail = describeRoll(result);
    const message = baseMessage(ctx, `${p.label ? `${p.label}: ` : ''}${result.expression} = ${result.total}`, 'ROLL');
    message.roll = { expression: result.expression, total: result.total, detail, visibility: p.visibility, ...(p.label ? { label: p.label } : {}) };
    if (p.visibility !== 'PUBLIC') {
      message.scope = 'WHISPER';
      const gmSubs = [ctx.campaign.campaign.ownerSub];
      message.recipientSubs = p.visibility === 'SELF' ? [ctx.actor.sub] : [...new Set([ctx.actor.sub, ...gmSubs])];
    }
    return { changes: [{ kind: 'chat', message }], writes: [{ Put: { Item: chatItem(message) } }], result: { total: result.total, detail } };
  },
};

export function baseMessage(ctx: HandlerCtx, body: string, kind: ChatMessage['kind']): ChatMessage {
  return {
    id: ulid(),
    campaignId: ctx.session.campaignId,
    sessionId: ctx.session.id,
    senderSub: ctx.actor.sub,
    senderName: ctx.campaign.access.member?.displayName ?? ctx.actor.displayName,
    scope: 'TABLE',
    body,
    kind,
    createdAt: ctx.deps.now().toISOString(),
  };
}

export function chatItem(m: ChatMessage) {
  return { ...keys.chat(m.campaignId, m.id), entity: 'Chat', ...m };
}

async function requireMember(ctx: HandlerCtx, sub: string) {
  const m = await ctx.deps.db.get<CampaignMember>(keys.member(ctx.session.campaignId, sub));
  if (!m || m.status !== 'ACTIVE') throw invalid('That player is not a member of this campaign.');
}

/** GMs may address objects on any scene of the campaign; find it via the active scene first. */
export async function findObjectScene(ctx: HandlerCtx, objectId: string): Promise<string | undefined> {
  if (ctx.session.activeSceneId) {
    const o = await ctx.deps.db.get<SceneObject>(keys.object(ctx.session.activeSceneId, objectId));
    if (o) return o.sceneId;
  }
  const found = await ctx.deps.db.query<SceneObject>({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `OBJ#${objectId}` },
  });
  return found[0]?.campaignId === ctx.session.campaignId ? found[0].sceneId : undefined;
}

export async function executeCommand(deps: Deps, actor: Actor, raw: unknown): Promise<CommandResult> {
  const env = CommandEnvelope.safeParse(raw);
  if (!env.success) throw invalid('Malformed command.', { issues: env.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const { commandId, sessionId, type } = env.data;
  const parsed = CommandPayloads[type].safeParse(env.data.payload);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'Invalid command.', { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })) });

  const session = await loadSession(deps, sessionId);
  const campaign = await loadCampaign(deps, actor, session.campaignId, session);
  if (campaign.campaign.status !== 'ACTIVE') throw conflict('This campaign is archived.');

  const prior = await deps.db.get<{ revision: number; ts: string; result: unknown; actorSub?: string }>(keys.command(sessionId, commandId));
  if (prior) {
    if (prior.actorSub && prior.actorSub !== actor.sub) throw conflict('Duplicate command id.');
    return { ok: true, commandId, newRevision: prior.revision, serverTime: prior.ts, duplicate: true, ...(prior.result != null ? { result: prior.result } : {}) };
  }

  const handler = handlers[type] as Handler<typeof type>;
  const out = await handler({ deps, actor, session, campaign }, parsed.data as never);
  try {
    const { revision, ts } = await commit(deps, session, actor, out.changes, out.writes, {
      commandId,
      result: out.result,
      ...(out.projectionSession ? { projectionSession: out.projectionSession } : {}),
    });
    return { ok: true, commandId, newRevision: revision, serverTime: ts, ...(out.result !== undefined ? { result: out.result } : {}) };
  } catch (err) {
    if (isConditionalFailure(err)) {
      const dup = await deps.db.get<{ revision: number; ts: string; result: unknown }>(keys.command(sessionId, commandId));
      if (dup) return { ok: true, commandId, newRevision: dup.revision, serverTime: dup.ts, duplicate: true };
      throw new AppError('CONFLICT', 'Someone else changed this at the same moment. Please try again.');
    }
    throw err;
  }
}
