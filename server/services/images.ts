/**
 * Character, creature and token pictures: uploaded portraits and sprites made in the builder.
 * Any campaign member can upload one; the server checks the real file type and size before
 * it can be attached, and hands out short-lived links only to campaign members.
 */
import { ulid } from 'ulid';
import type { z } from 'zod';
import { invalid, notFound } from '@shared/errors';
import { sniffImage } from '@shared/image';
import type { MapAsset } from '@shared/model';
import type { FinalizeImageInput, ImageUploadIntentInput } from '@shared/schemas/api';
import { keys } from '../repo/db';
import { loadCampaign, requireActiveCampaign, type Actor, type Deps } from '../context';
import { rateLimit } from './rateLimit';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 1024;
const LINK_SECONDS = 3600;

export async function uploadImageIntent(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof ImageUploadIntentInput>) {
  requireActiveCampaign(await loadCampaign(deps, actor, campaignId));
  if (input.bytes > MAX_IMAGE_BYTES) throw invalid('Pictures can be at most 2 MB.');
  await rateLimit(deps, `image-upload:${actor.sub}`, 120, 3600);
  const id = ulid();
  const ext = input.contentType === 'image/png' ? 'png' : input.contentType === 'image/webp' ? 'webp' : 'jpg';
  const asset: MapAsset = {
    id,
    campaignId,
    kind: 'image',
    s3Key: `campaigns/${campaignId}/images/${id}.${ext}`,
    contentType: input.contentType,
    bytes: input.bytes,
    widthPx: 0,
    heightPx: 0,
    status: 'PENDING',
    uploadedBy: actor.sub,
    createdAt: deps.now().toISOString(),
  };
  await deps.db.put({ ...keys.asset(campaignId, id), entity: 'Asset', ...asset });
  return { assetId: id, uploadUrl: await deps.blobs.presignPut(asset.s3Key, input.contentType, input.bytes), headers: { 'Content-Type': input.contentType } };
}

/** Checks the uploaded file's real type, size and dimensions; only its uploader can finish it. */
export async function finalizeImage(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof FinalizeImageInput>) {
  await loadCampaign(deps, actor, campaignId);
  const asset = await deps.db.get<MapAsset>(keys.asset(campaignId, input.assetId));
  if (!asset || asset.kind !== 'image' || asset.uploadedBy !== actor.sub) throw notFound('Upload');
  if (asset.status === 'READY') return { assetId: asset.id, width: asset.widthPx, height: asset.heightPx };
  const head = await deps.blobs.head(asset.s3Key);
  if (!head) throw invalid('The upload did not complete. Please try again.');
  if (head.bytes > MAX_IMAGE_BYTES) throw invalid('Pictures can be at most 2 MB.');
  const sniffed = sniffImage(await deps.blobs.readHead(asset.s3Key));
  if (!sniffed) throw invalid('That file is not a PNG, JPEG, or WebP image.');
  if (sniffed.contentType !== asset.contentType) throw invalid('The file contents do not match its type.');
  if (sniffed.width < 8 || sniffed.height < 8) throw invalid('That picture is too small.');
  if (sniffed.width > MAX_IMAGE_SIDE || sniffed.height > MAX_IMAGE_SIDE) throw invalid(`Pictures can be at most ${MAX_IMAGE_SIDE} × ${MAX_IMAGE_SIDE} pixels.`);
  await deps.db.update({
    Key: keys.asset(campaignId, asset.id),
    UpdateExpression: 'SET #s = :ready, widthPx = :w, heightPx = :h, bytes = :b',
    ConditionExpression: '#s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':ready': 'READY', ':pending': 'PENDING', ':w': sniffed.width, ':h': sniffed.height, ':b': head.bytes },
  });
  return { assetId: asset.id, width: sniffed.width, height: sniffed.height };
}

/** A short-lived link to a picture, for campaign members. */
export async function imageLink(deps: Deps, actor: Actor, campaignId: string, assetId: string) {
  await loadCampaign(deps, actor, campaignId);
  const asset = await readyImage(deps, campaignId, assetId);
  if (!asset) throw notFound('Picture');
  return { url: await deps.blobs.presignGet(asset.s3Key, LINK_SECONDS), expiresAt: new Date(deps.now().getTime() + LINK_SECONDS * 1000).toISOString() };
}

async function readyImage(deps: Deps, campaignId: string, assetId: string) {
  const asset = await deps.db.get<MapAsset>(keys.asset(campaignId, assetId));
  return asset && asset.kind === 'image' && asset.status === 'READY' ? asset : null;
}

/** Throws unless `assetId` is a finished picture in this campaign. */
export async function requireImage(deps: Deps, campaignId: string, assetId: string) {
  if (!(await readyImage(deps, campaignId, assetId))) throw invalid('That picture is not available. Upload it again.');
}
