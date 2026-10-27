/**
 * GM undo for recent map commands. Each undoable command stores an inverse
 * record (object states before/after, fog op) in the same transaction. Undo
 * applies it only if nothing has touched those objects since, so it never
 * clobbers a later change by another player.
 */
import { monotonicFactory } from 'ulid';
import { conflict, forbidden } from '@shared/errors';
import type { Scene, SceneObject } from '@shared/model';
import type { CommandType } from '@shared/schemas/commands';
import { keys, type TxItem } from '../repo/db';
import type { Change } from '../realtime/fanout';
import type { Actor, Deps } from '../context';
import { objectItem, requireGM, type Handler, type HandlerOutput } from './commands';
import { loadFog } from './sessions';

const UNDO_TTL_SECONDS = 24 * 3600;
// Monotonic so records made in the same millisecond still sort in creation order.
const undoId = monotonicFactory();

type UndoRecord = {
  id: string;
  sessionId: string;
  actorSub: string;
  label: string;
  objects: { before?: SceneObject; after?: SceneObject }[];
  fog?: { sceneId: string; seq: number };
  createdAt: string;
};

const LABELS: Partial<Record<CommandType, string>> = {
  moveToken: 'Move',
  spawnSceneObject: 'Place',
  updateSceneObject: 'Edit',
  removeSceneObject: 'Remove',
  transferSceneObject: 'Move to scene',
  spawnEncounter: 'Place encounter',
  updateFog: 'Fog',
};

export function isUndoable(type: CommandType): boolean {
  return type in LABELS;
}

/** Builds the inverse record write for a GM's undoable command, or nothing. */
export function undoWrite(deps: Deps, actor: Actor, sessionId: string, type: CommandType, out: HandlerOutput): TxItem | null {
  const objects: UndoRecord['objects'] = [];
  let fog: UndoRecord['fog'];
  for (const c of out.changes) {
    if (c.kind === 'object') objects.push({ ...(c.before ? { before: c.before } : {}), ...(c.after ? { after: c.after } : {}) });
    if (c.kind === 'fog') fog = { sceneId: c.sceneId, seq: c.seq };
  }
  if (!objects.length && !fog) return null;
  const first = objects[0]?.after ?? objects[0]?.before;
  const name = first?.appearance.label;
  const record: UndoRecord = {
    id: undoId(),
    sessionId,
    actorSub: actor.sub,
    label: `${LABELS[type]}${type === 'spawnEncounter' ? '' : name ? ` ${name}` : ''}`,
    objects,
    ...(fog ? { fog } : {}),
    createdAt: deps.now().toISOString(),
  };
  return { Put: { Item: { ...keys.undo(sessionId, record.id), entity: 'Undo', ...record, ttl: Math.floor(deps.now().getTime() / 1000) + UNDO_TTL_SECONDS } } };
}

/** Same game state as the command left it (revision/timestamps differ after earlier undos). */
function sameState(cur: SceneObject, expected: SceneObject): boolean {
  const strip = ({ revision: _r, updatedAt: _u, ...rest }: SceneObject) => rest;
  return JSON.stringify(sortKeys(strip(cur))) === JSON.stringify(sortKeys(strip(expected)));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

export const undoLast: Handler<'undoLast'> = async (ctx) => {
  requireGM(ctx);
  if (ctx.session.status === 'ENDED') throw conflict('This session has ended.');
  const { deps } = ctx;
  const recent = await deps.db.queryPrefix<UndoRecord>(`SESSION#${ctx.session.id}`, 'UNDO#', { forward: false, limit: 25 });
  const rec = recent.find((r) => r.actorSub === ctx.actor.sub);
  if (!rec) throw conflict('Nothing to undo.');

  const writes: TxItem[] = [];
  const changes: Change[] = [];
  const fogCache = new Map<string, Awaited<ReturnType<typeof loadFog>>['fog']>();
  const fogFor = async (sceneId: string) => {
    if (!fogCache.has(sceneId)) {
      const scene = await deps.db.get<Scene>(keys.scene(sceneId));
      if (!scene || scene.campaignId !== ctx.session.campaignId) throw forbidden();
      fogCache.set(sceneId, (await loadFog(deps, scene)).fog);
    }
    return fogCache.get(sceneId)!;
  };
  const now = deps.now().toISOString();
  const changedSince = (o: SceneObject) => conflict(`Can't undo: ${o.appearance.label || 'that token'} has changed since.`);

  for (const { before, after } of rec.objects) {
    if (after) {
      const cur = await deps.db.get<SceneObject>(keys.object(after.sceneId, after.id));
      if (!cur || !sameState(cur, after)) throw changedSince(after);
      // Guard on the revision we just read so a concurrent change aborts the undo.
      const guard = { ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': cur.revision } };
      const sameKey = before && before.sceneId === after.sceneId;
      if (before) {
        const restored: SceneObject = { ...before, revision: cur.revision + 1, updatedAt: now };
        writes.push({ Put: { Item: objectItem(restored), ...(sameKey ? guard : { ConditionExpression: 'attribute_not_exists(PK)' }) } });
        if (!sameKey) {
          writes.push({ Delete: { Key: keys.object(after.sceneId, after.id), ...guard } });
          changes.push({ kind: 'object', before: cur, fog: await fogFor(after.sceneId) });
          changes.push({ kind: 'object', after: restored, fog: await fogFor(before.sceneId) });
        } else {
          changes.push({ kind: 'object', before: cur, after: restored, fog: await fogFor(after.sceneId) });
        }
      } else {
        writes.push({ Delete: { Key: keys.object(after.sceneId, after.id), ...guard } });
        changes.push({ kind: 'object', before: cur, fog: await fogFor(after.sceneId) });
      }
    } else if (before) {
      // Undo a removal: the object must still be gone.
      if (await deps.db.get<SceneObject>(keys.object(before.sceneId, before.id))) throw changedSince(before);
      const restored: SceneObject = { ...before, revision: before.revision + 1, updatedAt: now };
      writes.push({ Put: { Item: objectItem(restored), ConditionExpression: 'attribute_not_exists(PK)' } });
      changes.push({ kind: 'object', after: restored, fog: await fogFor(before.sceneId) });
    }
  }

  if (rec.fog) {
    const scene = await deps.db.get<Scene>(keys.scene(rec.fog.sceneId));
    if (!scene || scene.fogOpCount !== rec.fog.seq) throw conflict("Can't undo: the fog has changed since.");
    writes.push({ Delete: { Key: keys.fogOp(scene.id, rec.fog.seq) } });
    writes.push({
      Update: {
        Key: keys.scene(scene.id),
        UpdateExpression: 'SET fogOpCount = :prev, updatedAt = :now',
        ConditionExpression: 'fogOpCount = :seq',
        ExpressionAttributeValues: { ':prev': rec.fog.seq - 1, ':seq': rec.fog.seq, ':now': now },
      },
    });
    changes.push({ kind: 'sceneRefresh', sceneId: scene.id, reason: 'undo' });
  }

  writes.push({ Delete: { Key: keys.undo(ctx.session.id, rec.id), ConditionExpression: 'attribute_exists(PK)' } });
  return { changes, writes, result: { label: rec.label } };
};
