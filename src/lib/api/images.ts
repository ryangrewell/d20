/** Character, creature and token pictures: upload once, then look up short-lived links by id. */
import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import { queryClient } from '../queryClient';

const LINK_FRESH_MS = 45 * 60_000;
const imageKey = (cid: string, assetId: string) => ['image', cid, assetId] as const;

/** Uploads a picture (presigned PUT, then the server checks it) and returns its asset id. */
export async function uploadPicture(campaignId: string, blob: Blob): Promise<string> {
  const contentType = blob.type as 'image/png' | 'image/jpeg' | 'image/webp';
  const intent = await api<{ assetId: string; uploadUrl: string; headers: Record<string, string> }>(`/campaigns/${campaignId}/images/upload-intent`, { body: { contentType, bytes: blob.size } });
  const put = await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: blob });
  if (!put.ok) throw new Error('The upload failed. Check your connection and try again.');
  return (await api<{ assetId: string }>(`/campaigns/${campaignId}/images`, { body: { assetId: intent.assetId } })).assetId;
}

const fetchLink = (cid: string, assetId: string) => () => api<{ url: string }>(`/campaigns/${cid}/images/${assetId}`).then((r) => r.url);

/** A link to a picture, refreshed before it expires. */
export function useImageUrl(campaignId: string, assetId: string | undefined) {
  return useQuery({ queryKey: imageKey(campaignId, assetId ?? ''), queryFn: fetchLink(campaignId, assetId ?? ''), enabled: !!campaignId && !!assetId, staleTime: LINK_FRESH_MS, refetchInterval: LINK_FRESH_MS });
}

/** Same lookup outside React (the map renderer), sharing the cache. */
export function getImageUrl(campaignId: string, assetId: string): Promise<string> {
  return queryClient.fetchQuery({ queryKey: imageKey(campaignId, assetId), queryFn: fetchLink(campaignId, assetId), staleTime: LINK_FRESH_MS });
}
