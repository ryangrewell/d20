/**
 * Manual scene checkpoints. A checkpoint is a JSON snapshot of a scene's
 * tokens and fog stored in S3 (large state stays out of DynamoDB), indexed
 * by a small DynamoDB record. Restoring replaces the scene's tokens and fog
 * with the snapshot and tells viewers to refetch.
 *
 * Restore writes in batches and is not a single transaction: a failure part
 * way leaves a mix, which re-running the restore repairs.
 */
import { ulid } from 'ulid';
import { invalid, notFound } from '@shared/errors';
import type { FogOpRecord, Scene, SceneObject } from '@shared/model';
import { keys } from '../repo/db';
import { loadCampaign, requireActiveCampaign, requireGM, type Actor, type Deps } from '../context';
import type { ExploredRecord } from './lighting';
import { objectItem, requireGM as requireGMCommand, type Handler } from './commands';
import { loadSceneObjects } from './sessions';

const MAX_CHECKPOINTS_PER_SCENE = 50;

export type CheckpointRecord = { id: string; sceneId: string; campaignId: string; label: string; objectCount: number; fogOpCount: number; s3Key: string; createdBy: string; createdAt: string };
/** `explored` (encoded automatic-reveal layer) is absent in checkpoints saved before torchlight existed. */
type CheckpointData = { version: 1; fogInitial: Scene['fogInitial']; objects: SceneObject[]; fogOps: FogOpRecord[]; explored?: string | null };

async function sceneFor(deps: Deps, actor: Actor, campaignId: string, sceneId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  const scene = await deps.db.get<Scene>(keys.scene(sceneId));
  if (!scene || scene.campaignId !== campaignId) throw notFound('Scene');
  return { ctx, scene };
}

export async function listCheckpoints(deps: Deps, actor: Actor, campaignId: string, sceneId: string) {
  await sceneFor(deps, actor, campaignId, sceneId);
  return deps.db.queryPrefix<CheckpointRecord>(`SCENE#${sceneId}`, 'CHECKPOINT#', { forward: false });
}

export async function createCheckpoint(deps: Deps, actor: Actor, campaignId: string, sceneId: string, label: string) {
  const { ctx, scene } = await sceneFor(deps, actor, campaignId, sceneId);
  requireActiveCampaign(ctx);
  const existing = await deps.db.queryPrefix<CheckpointRecord>(`SCENE#${sceneId}`, 'CHECKPOINT#');
  if (existing.length >= MAX_CHECKPOINTS_PER_SCENE) throw invalid(`A scene can keep at most ${MAX_CHECKPOINTS_PER_SCENE} checkpoints. Delete an old one first.`);
  const [objects, fogOps, explored] = await Promise.all([loadSceneObjects(deps, sceneId), deps.db.queryPrefix<FogOpRecord>(`SCENE#${sceneId}`, 'FOG#'), deps.db.get<ExploredRecord>(keys.explored(sceneId))]);
  const id = ulid();
  const s3Key = `campaigns/${campaignId}/checkpoints/${sceneId}/${id}.json`;
  const data: CheckpointData = { version: 1, fogInitial: scene.fogInitial, objects, fogOps, explored: explored?.encoded ?? null };
  await deps.blobs.putBytes(s3Key, new TextEncoder().encode(JSON.stringify(data)), 'application/json');
  const now = deps.now();
  const record: CheckpointRecord = {
    id,
    sceneId,
    campaignId,
    label: label.trim() || `Checkpoint ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
    objectCount: objects.length,
    fogOpCount: fogOps.length,
    s3Key,
    createdBy: actor.sub,
    createdAt: now.toISOString(),
  };
  await deps.db.put({ ...keys.checkpoint(sceneId, id), entity: 'Checkpoint', ...record });
  return record;
}

export async function deleteCheckpoint(deps: Deps, actor: Actor, campaignId: string, sceneId: string, id: string) {
  await sceneFor(deps, actor, campaignId, sceneId);
  await deps.db.delete(keys.checkpoint(sceneId, id));
}

export const restoreCheckpoint: Handler<'restoreCheckpoint'> = async (ctx, p) => {
  requireGMCommand(ctx);
  const { deps } = ctx;
  const scene = await deps.db.get<Scene>(keys.scene(p.sceneId));
  if (!scene || scene.campaignId !== ctx.session.campaignId) throw notFound('Scene');
  const record = await deps.db.get<CheckpointRecord>(keys.checkpoint(p.sceneId, p.checkpointId));
  if (!record) throw notFound('Checkpoint');
  const data = await deps.blobs.getJson<CheckpointData>(record.s3Key);
  if (data.version !== 1) throw invalid('That checkpoint was saved by an incompatible version.');

  const [current, currentFog] = await Promise.all([loadSceneObjects(deps, scene.id), deps.db.queryPrefix<FogOpRecord>(`SCENE#${scene.id}`, 'FOG#')]);
  const currentRev = new Map(current.map((o) => [o.id, o.revision]));
  const keep = new Set(data.objects.map((o) => o.id));
  const now = deps.now().toISOString();
  const exploredVersion = (await deps.db.get<ExploredRecord>(keys.explored(scene.id)))?.version ?? 0;
  await deps.db.batchWrite([
    ...current.filter((o) => !keep.has(o.id)).map((o) => ({ delete: keys.object(scene.id, o.id) })),
    // Bump revisions past anything clients hold so restored state wins.
    ...data.objects.map((o) => ({ put: objectItem({ ...o, sceneId: scene.id, revision: Math.max(o.revision, currentRev.get(o.id) ?? 0) + 1, updatedAt: now }) })),
    ...currentFog.map((f) => ({ delete: keys.fogOp(scene.id, f.seq) })),
    // Explored area goes back to what it was; a new version keeps concurrent writers honest.
    data.explored ? { put: { ...keys.explored(scene.id), entity: 'Explored', sceneId: scene.id, encoded: data.explored, version: exploredVersion + 1 } } : { delete: keys.explored(scene.id) },
  ]);
  // Fog ops are re-sequenced 1..n so the scene's counter stays authoritative.
  const ops = data.fogOps.sort((a, b) => a.seq - b.seq);
  await deps.db.batchWrite(ops.map((f, i) => ({ put: { ...keys.fogOp(scene.id, i + 1), entity: 'FogOp', sceneId: scene.id, seq: i + 1, op: f.op, createdAt: f.createdAt } })));
  return {
    changes: [{ kind: 'sceneRefresh', sceneId: scene.id, reason: 'checkpoint' }],
    writes: [
      {
        Update: {
          Key: keys.scene(scene.id),
          UpdateExpression: 'SET fogOpCount = :n, fogInitial = :init, updatedAt = :now',
          ExpressionAttributeValues: { ':n': ops.length, ':init': data.fogInitial, ':now': now },
        },
      },
    ],
    result: { label: record.label, objects: data.objects.length, fogOps: ops.length },
  };
};
