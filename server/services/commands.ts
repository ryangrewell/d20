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
import { isConditionalFailure, keys, type TxItem } from '../repo/db';
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
import { isUndoable, undoLast, undoWrite } from './undo';
import { restoreCheckpoint } from './checkpoints';
import { lightingGuards, lightingOn, lightingRace, lightingUpdate, sceneGeometry } from './lighting';
import { isPartyToken } from '@shared/lighting/light';

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

type Moved = { id: string; from: { x: number; y: number }; to: { x: number; y: number } };
const unlit = (fog: FogState) => ({ changes: [] as Change[], writes: [] as TxItem[], fog });

/** Recomputes torchlight and room reveal for a scene after its party tokens changed. */
async function relight(ctx: HandlerCtx, scene: Scene, fogBefore: FogState, objectsAfter: SceneObject[], moved?: Moved) {
  if (!lightingOn(scene)) return unlit(fogBefore);
  const lu = await lightingUpdate(ctx.deps, scene, fogBefore, objectsAfter, moved ? { moved } : {});
  return { changes: lu.change ? [lu.change] : [], writes: lu.write ? [lu.write] : [], fog: lu.fogAfter };
}

const replaced = (objects: SceneObject[], next: SceneObject) => objects.map((o) => (o.id === next.id ? next : o));

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
  undoLast,
  restoreCheckpoint,
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
    const lit = lightingOn(scene) && isPartyToken(obj) ? await relight(ctx, scene, fog, replaced(await loadSceneObjects(ctx.deps, scene.id), after), { id: obj.id, from: { x: obj.x, y: obj.y }, to: pos }) : unlit(fog);
    return {
      changes: [{ kind: 'object', before: obj, after, fog: lit.fog }, ...lit.changes],
      writes: [
        ...lit.writes,
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
    const { fog } = await loadFog(ctx.deps, scene, { objects: existing });
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
      ...(p.portal ? { portal: await requirePortalTarget(ctx, p.portal.targetSceneId) } : {}),
      ...(template ? { gmStats: { hp: { current: template.hpMax, max: template.hpMax }, ...(template.ac !== undefined ? { ac: template.ac } : {}), initiativeMod: template.initiativeMod, templateId: template.id } } : {}),
    };
    const lit = isPartyToken(obj) ? await relight(ctx, scene, fog, [...existing, obj]) : unlit(fog);
    return {
      changes: [{ kind: 'object', after: obj, fog: lit.fog }, ...lit.changes],
      writes: [{ Put: { Item: objectItem(obj), ConditionExpression: 'attribute_not_exists(PK)' } }, ...lit.writes],
      result: { objectId: obj.id },
    };
  },

  async updateSceneObject(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const { obj, scene, fog } = await loadObjectFor(ctx, p.objectId, await findObjectScene(ctx, p.objectId));
    if (p.patch.assignedControllerSub) await requireMember(ctx, p.patch.assignedControllerSub);
    const after: SceneObject = { ...obj, revision: obj.revision + 1, updatedAt: ctx.deps.now().toISOString() };
    const { label, tint, assignedControllerSub, allowedViewerIds, characterId, gmStats, conditions, portal, lightRadiusMeters, ...rest } = p.patch;
    Object.assign(after, rest);
    if (portal === null) delete after.portal;
    else if (portal) after.portal = await requirePortalTarget(ctx, portal.targetSceneId);
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
    if (lightRadiusMeters === null || lightRadiusMeters === 0) delete after.lightRadiusMeters;
    else if (lightRadiusMeters !== undefined) after.lightRadiusMeters = lightRadiusMeters;
    if (after.lightRadiusMeters) {
      if (!isPartyToken(after)) throw invalid('Only party tokens can carry light.');
      if (!(await sceneGeometry(ctx.deps, scene)).ppm) throw invalid("Set the map's scale before giving tokens light.");
    }
    // Light, visibility or party membership changes can change what players see.
    const lightingFields = lightRadiusMeters !== undefined || 'visibility' in rest || 'objectType' in rest || assignedControllerSub !== undefined;
    const affectsLight = lightingFields && (isPartyToken(obj) || isPartyToken(after));
    const lit = affectsLight && lightingOn(scene) ? await relight(ctx, scene, fog, replaced(await loadSceneObjects(ctx.deps, scene.id), after)) : unlit(fog);
    return {
      changes: [{ kind: 'object', before: obj, after, fog: lit.fog }, ...lit.changes],
      // If the GM changes the scene's lighting at the same moment, re-run against the new setting.
      writes: [{ Put: { Item: objectItem(after), ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': obj.revision } } }, ...lit.writes, ...(affectsLight ? lightingGuards(scene, []) : [])],
    };
  },

  async removeSceneObject(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const { obj, scene, fog } = await loadObjectFor(ctx, p.objectId, await findObjectScene(ctx, p.objectId));
    const lit = isPartyToken(obj) && obj.lightRadiusMeters ? await relight(ctx, scene, fog, (await loadSceneObjects(ctx.deps, scene.id)).filter((o) => o.id !== obj.id)) : unlit(fog);
    return { changes: [{ kind: 'object', before: obj, fog: lit.fog }, ...lit.changes], writes: [{ Delete: { Key: keys.object(obj.sceneId, obj.id) } }, ...lit.writes] };
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
    const party = isPartyToken(obj);
    const leaving = party && obj.lightRadiusMeters ? await relight(ctx, source, sourceFog, (await loadSceneObjects(ctx.deps, source.id)).filter((o) => o.id !== obj.id)) : unlit(sourceFog);
    const arriving = party ? await relight(ctx, target, targetFog, [...targetObjects, after]) : unlit(targetFog);
    return {
      // Leaves the source scene and appears in the target; each audience sees whichever side it may see.
      changes: [{ kind: 'object', before: obj, fog: leaving.fog }, ...leaving.changes, { kind: 'object', after, fog: arriving.fog }, ...arriving.changes],
      writes: [
        { Delete: { Key: keys.object(source.id, obj.id), ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': obj.revision } } },
        { Put: { Item: objectItem(after), ConditionExpression: 'attribute_not_exists(PK)' } },
        ...leaving.writes,
        ...arriving.writes,
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
    const objects = await loadSceneObjects(ctx.deps, scene.id);
    const { fog: fogBefore } = await loadFog(ctx.deps, scene, { objects });
    // Reset also clears the explored layer; rooms the party stands in (room reveal) are re-revealed at once.
    const lu = await lightingUpdate(ctx.deps, { ...scene, fogInitial: p.initial }, { ...fogBefore, initial: p.initial, ops: [] }, objects, { clearExplored: true });
    // Old fog-op items are cleared lazily below the transaction limit; reset is recorded by bumping a generation.
    const ops = await ctx.deps.db.queryPrefix<{ seq: number }>(`SCENE#${scene.id}`, 'FOG#');
    if (ops.length > 90) {
      for (const o of ops.slice(0, ops.length - 90)) await ctx.deps.db.delete(keys.fogOp(scene.id, o.seq));
    }
    const remaining = ops.slice(-90);
    return {
      changes: [
        { kind: 'fogReset', sceneId: scene.id, initial: p.initial, objects, fogBefore, fogAfter: lu.fogAfter },
        // Carries the new layers to clients; visibility changes were already covered by the reset above.
        ...(lu.change?.kind === 'fogLayers' ? [{ ...lu.change, objects: [] }] : []),
      ],
      writes: [
        ...(lu.write ? [lu.write] : []),
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

  async setSceneLighting(ctx, p) {
    requireGM(ctx);
    requirePlayable(ctx);
    const scene = await loadSceneFor(ctx, p.sceneId);
    const next: Scene = { ...scene, lighting: { torch: p.torch, roomReveal: p.roomReveal }, updatedAt: ctx.deps.now().toISOString() };
    const objects = await loadSceneObjects(ctx.deps, scene.id);
    const { fog: fogBefore } = await loadFog(ctx.deps, scene, { objects });
    // Switching on applies at once: current light is remembered, rooms the party stands in are revealed.
    const lu = await lightingUpdate(ctx.deps, next, fogBefore, objects);
    return {
      changes: [{ kind: 'scene', scene: next }, ...(lu.change ? [lu.change] : [])],
      writes: [
        { Update: { Key: keys.scene(scene.id), UpdateExpression: 'SET lighting = :l, updatedAt = :now', ExpressionAttributeValues: { ':l': next.lighting, ':now': next.updatedAt } } },
        ...(lu.write ? [lu.write] : []),
        // Party tokens changed by a concurrent command (light radius, visibility) make this re-run on fresh state.
        ...lightingGuards(scene, objects.filter(isPartyToken)).slice(1),
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

async function requirePortalTarget(ctx: HandlerCtx, targetSceneId: string) {
  const target = await ctx.deps.db.get<Scene>(keys.scene(targetSceneId));
  if (!target || target.campaignId !== ctx.session.campaignId) throw notFound('Scene');
  return { targetSceneId };
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

  // Two lit tokens moving at once can race on the explored layer; the loser re-runs once on fresh state.
  try {
    return await runCommand(deps, actor, session, campaign, commandId, type, parsed.data);
  } catch (err) {
    if (!(err instanceof ExploredRace)) throw err;
  }
  try {
    return await runCommand(deps, actor, session, campaign, commandId, type, parsed.data);
  } catch (err) {
    if (err instanceof ExploredRace) throw new AppError('CONFLICT', 'Someone else changed this at the same moment. Please try again.');
    throw err;
  }
}

class ExploredRace extends Error {}

async function runCommand(deps: Deps, actor: Actor, session: GameSession, campaign: CampaignContext, commandId: string, type: CommandType, payload: unknown): Promise<CommandResult> {
  const sessionId = session.id;
  const handler = handlers[type] as Handler<typeof type>;
  const out = await handler({ deps, actor, session, campaign }, payload as never);
  if (campaign.access.isGM && isUndoable(type)) {
    const undo = undoWrite(deps, actor, session.id, type, out);
    if (undo) out.writes.push(undo);
  }
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
      if (lightingRace(out.writes)) throw new ExploredRace();
      throw new AppError('CONFLICT', 'Someone else changed this at the same moment. Please try again.');
    }
    throw err;
  }
}
