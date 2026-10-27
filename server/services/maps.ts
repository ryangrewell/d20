import { ulid } from 'ulid';
import type { z } from 'zod';
import { AppError, invalid, notFound } from '@shared/errors';
import { sniffImage } from '@shared/image';
import type { MapAsset, MapDefinition, Scene } from '@shared/model';
import type { CreateSceneInput, FinalizeMapInput, UpdateMapInput, UpdateSceneInput, UploadMapIntentInput } from '@shared/schemas/api';
import { keys, type TxItem } from '../repo/db';
import { loadCampaign, requireActiveCampaign, requireGM, type Actor, type Deps } from '../context';
import { rateLimit } from './rateLimit';

export async function gmContext(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  requireActiveCampaign(ctx);
  return ctx;
}

/** Issues a short-lived presigned PUT scoped to a server-chosen key in this campaign's prefix. */
export async function uploadMapIntent(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof UploadMapIntentInput>) {
  await gmContext(deps, actor, campaignId);
  if (input.bytes > deps.config.maxMapUploadBytes) {
    throw invalid(`Maps can be at most ${Math.round(deps.config.maxMapUploadBytes / 1024 / 1024)} MB.`);
  }
  await rateLimit(deps, `upload:${actor.sub}`, 60, 3600);
  const id = ulid();
  const ext = input.contentType === 'image/png' ? 'png' : input.contentType === 'image/webp' ? 'webp' : 'jpg';
  const asset: MapAsset = {
    id,
    campaignId,
    s3Key: `campaigns/${campaignId}/maps/${id}.${ext}`,
    contentType: input.contentType,
    bytes: input.bytes,
    widthPx: 0,
    heightPx: 0,
    status: 'PENDING',
    uploadedBy: actor.sub,
    createdAt: deps.now().toISOString(),
  };
  await deps.db.put({ ...keys.asset(campaignId, id), entity: 'Asset', ...asset });
  const uploadUrl = await deps.blobs.presignPut(asset.s3Key, input.contentType, input.bytes);
  return { assetId: id, uploadUrl, headers: { 'Content-Type': input.contentType } };
}

/** Verifies an uploaded object's real signature, size and pixel dimensions and marks it READY. */
export async function verifyUploadedImage(deps: Deps, campaignId: string, assetId: string) {
  const asset = await deps.db.get<MapAsset>(keys.asset(campaignId, assetId));
  if (!asset) throw notFound('Upload');
  if (asset.status === 'READY') throw new AppError('CONFLICT', 'This upload was already processed.');
  const head = await deps.blobs.head(asset.s3Key);
  if (!head) throw invalid('The upload did not complete. Please try again.');
  if (head.bytes > deps.config.maxMapUploadBytes) throw invalid('That file is too large.');
  const sniffed = sniffImage(await deps.blobs.readHead(asset.s3Key));
  if (!sniffed) throw invalid('That file is not a PNG, JPEG, or WebP image.');
  if (sniffed.contentType !== asset.contentType) throw invalid('The file contents do not match its type.');
  if (sniffed.width < 16 || sniffed.height < 16) throw invalid('That image is too small to use as a map.');
  if (sniffed.width * sniffed.height > deps.config.maxMapPixelCount) throw invalid('That image has too many pixels. Try a smaller export.');
  const ready: TxItem = {
    Update: {
      Key: keys.asset(campaignId, asset.id),
      UpdateExpression: 'SET #s = :ready, widthPx = :w, heightPx = :h, bytes = :b',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':ready': 'READY', ':pending': 'PENDING', ':w': sniffed.width, ':h': sniffed.height, ':b': head.bytes },
    },
  };
  return { asset, width: sniffed.width, height: sniffed.height, ready };
}

export function mapItem(map: MapDefinition) {
  return { ...keys.map(map.campaignId, map.id), entity: 'Map', ...map };
}

/** Verifies the uploaded object's real signature, size and pixel dimensions, then creates the map. */
export async function finalizeMap(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof FinalizeMapInput>) {
  await gmContext(deps, actor, campaignId);
  const { asset, width, height, ready } = await verifyUploadedImage(deps, campaignId, input.assetId);
  const now = deps.now().toISOString();
  const map: MapDefinition = {
    id: ulid(),
    campaignId,
    assetId: asset.id,
    name: input.name,
    category: input.category,
    widthPx: width,
    heightPx: height,
    grid: { type: 'none', intervalMeters: 1.524, displayInterval: 5, displayUnit: 'ft', originX: 0, originY: 0, rotationRadians: 0, snapEnabled: true, showEnabled: true, opacity: 0.35 },
    createdAt: now,
    updatedAt: now,
    ...(input.parentMapId ? { parentMapId: input.parentMapId } : {}),
  };
  await deps.db.transact([ready, { Put: { Item: mapItem(map) } }]);
  return map;
}

export async function getMap(deps: Deps, actor: Actor, campaignId: string, mapId: string) {
  await gmContext(deps, actor, campaignId);
  const map = await deps.db.get<MapDefinition>(keys.map(campaignId, mapId));
  if (!map) throw notFound('Map');
  const asset = await deps.db.get<MapAsset>(keys.asset(campaignId, map.assetId));
  return { map, imageUrl: asset ? await deps.blobs.presignGet(asset.s3Key, 3600) : null };
}

export async function updateMap(deps: Deps, actor: Actor, campaignId: string, mapId: string, input: z.output<typeof UpdateMapInput>) {
  await gmContext(deps, actor, campaignId);
  const map = await deps.db.get<MapDefinition>(keys.map(campaignId, mapId));
  if (!map) throw notFound('Map');
  const next: MapDefinition = {
    ...map,
    ...(input.name ? { name: input.name } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.grid ? { grid: input.grid } : {}),
    updatedAt: deps.now().toISOString(),
  };
  if (input.calibration === null) delete next.calibration;
  else if (input.calibration) {
    const c = input.calibration;
    const inBounds = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= map.widthPx && p.y <= map.heightPx;
    if (!inBounds(c.a) || !inBounds(c.b)) throw invalid('Calibration points must be on the map.');
    next.calibration = c;
  }
  if (next.grid.type !== 'none' && !next.calibration) throw invalid('Calibrate the map scale before enabling a grid.');
  await deps.db.put({ ...keys.map(campaignId, mapId), entity: 'Map', ...next });
  return next;
}

// ------------------------------------------------------------------ scenes

export function sceneItem(scene: Scene) {
  return { ...keys.scene(scene.id), GSI1PK: `CAMP#${scene.campaignId}`, GSI1SK: `SCENE#${scene.id}`, entity: 'Scene', ...scene };
}

export async function createScene(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof CreateSceneInput>) {
  await gmContext(deps, actor, campaignId);
  const map = await deps.db.get<MapDefinition>(keys.map(campaignId, input.mapId));
  if (!map) throw notFound('Map');
  const now = deps.now().toISOString();
  const scene: Scene = {
    id: ulid(),
    campaignId,
    mapId: map.id,
    name: input.name,
    fogInitial: input.fogInitial,
    fogOpCount: 0,
    createdAt: now,
    updatedAt: now,
    ...(input.parentSceneId ? { parentSceneId: input.parentSceneId } : {}),
  };
  await deps.db.put(sceneItem(scene));
  return scene;
}

export async function updateScene(deps: Deps, actor: Actor, campaignId: string, sceneId: string, input: z.output<typeof UpdateSceneInput>) {
  await gmContext(deps, actor, campaignId);
  const scene = await deps.db.get<Scene>(keys.scene(sceneId));
  if (!scene || scene.campaignId !== campaignId) throw notFound('Scene');
  const sets: string[] = ['updatedAt = :now'];
  const values: Record<string, unknown> = { ':now': deps.now().toISOString() };
  if (input.name) {
    sets.push('#n = :name');
    values[':name'] = input.name;
  }
  if (input.gmNotes !== undefined) {
    sets.push('gmNotes = :notes');
    values[':notes'] = input.gmNotes;
  }
  return deps.db.update<Scene>({
    Key: keys.scene(sceneId),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(input.name ? { ExpressionAttributeNames: { '#n': 'name' } } : {}),
    ExpressionAttributeValues: values,
  });
}
