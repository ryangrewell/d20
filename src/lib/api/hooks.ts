import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CampaignDashboardDto, CampaignListItem, InviteDto, InvitePreviewDto, MeDto } from '@shared/dto';
import type { Campaign, Character, ChatMessage, CreatureTemplate, EncounterTemplate, GameSession, InventoryItem, JournalEntry, MapDefinition, Scene } from '@shared/model';
import { api } from './client';

export const qk = {
  me: ['me'] as const,
  campaigns: ['campaigns'] as const,
  campaign: (id: string) => ['campaign', id] as const,
  invites: (id: string) => ['invites', id] as const,
  map: (cid: string, mid: string) => ['map', cid, mid] as const,
  characters: (cid: string) => ['characters', cid] as const,
  character: (cid: string, id: string) => ['character', cid, id] as const,
  creatures: (cid: string) => ['creatures', cid] as const,
  encounters: (cid: string) => ['encounters', cid] as const,
  journal: (cid: string) => ['journal', cid] as const,
};

export type CharacterList = { characters: Character[]; others: { id: string; name: string; ownerSub: string }[]; system: { id: string; version: string } };
export type CharacterDetail = { character: Character; items: InventoryItem[]; derived: Record<string, number | string>; canEdit: boolean };

export const useCharacters = (cid: string, enabled = true) => useQuery({ queryKey: qk.characters(cid), queryFn: () => api<CharacterList>(`/campaigns/${cid}/characters`), enabled: enabled && !!cid });
export const useCharacter = (cid: string, id: string | undefined) =>
  useQuery({ queryKey: qk.character(cid, id ?? ''), queryFn: () => api<CharacterDetail>(`/campaigns/${cid}/characters/${id}`), enabled: !!cid && !!id });
export const useCreatures = (cid: string, enabled = true) => useQuery({ queryKey: qk.creatures(cid), queryFn: () => api<CreatureTemplate[]>(`/campaigns/${cid}/creatures`), enabled: enabled && !!cid });

export const characterApi = {
  create: (cid: string, input: { name: string; ownerSub?: string }) => api<Character>(`/campaigns/${cid}/characters`, { body: input }),
  import: (cid: string, data: unknown, ownerSub?: string) => api<Character>(`/campaigns/${cid}/characters/import`, { body: { data, ...(ownerSub ? { ownerSub } : {}) } }),
  update: (cid: string, id: string, input: Record<string, unknown>) => api<Character>(`/campaigns/${cid}/characters/${id}`, { method: 'PATCH', body: input }),
  remove: (cid: string, id: string) => api(`/campaigns/${cid}/characters/${id}`, { method: 'DELETE' }),
  export: (cid: string, id: string) => api<Record<string, unknown>>(`/campaigns/${cid}/characters/${id}/export`),
  addItem: (cid: string, id: string, input: Record<string, unknown>) => api<InventoryItem>(`/campaigns/${cid}/characters/${id}/items`, { body: input }),
  updateItem: (cid: string, id: string, itemId: string, input: Record<string, unknown>) => api<InventoryItem>(`/campaigns/${cid}/characters/${id}/items/${itemId}`, { method: 'PATCH', body: input }),
  removeItem: (cid: string, id: string, itemId: string) => api(`/campaigns/${cid}/characters/${id}/items/${itemId}`, { method: 'DELETE' }),
};

export const useEncounters = (cid: string, enabled = true) => useQuery({ queryKey: qk.encounters(cid), queryFn: () => api<EncounterTemplate[]>(`/campaigns/${cid}/encounters`), enabled: enabled && !!cid });
export const useJournal = (cid: string) => useQuery({ queryKey: qk.journal(cid), queryFn: () => api<JournalEntry[]>(`/campaigns/${cid}/journal`), enabled: !!cid });

export const encounterApi = {
  create: (cid: string, input: Record<string, unknown>) => api<EncounterTemplate>(`/campaigns/${cid}/encounters`, { body: input }),
  update: (cid: string, id: string, input: Record<string, unknown>) => api<EncounterTemplate>(`/campaigns/${cid}/encounters/${id}`, { method: 'PATCH', body: input }),
  remove: (cid: string, id: string) => api(`/campaigns/${cid}/encounters/${id}`, { method: 'DELETE' }),
};

export const journalApi = {
  create: (cid: string, input: Record<string, unknown>) => api<JournalEntry>(`/campaigns/${cid}/journal`, { body: input }),
  update: (cid: string, id: string, input: Record<string, unknown>) => api<JournalEntry>(`/campaigns/${cid}/journal/${id}`, { method: 'PATCH', body: input }),
  remove: (cid: string, id: string) => api(`/campaigns/${cid}/journal/${id}`, { method: 'DELETE' }),
};

export const chatApi = {
  older: (cid: string, before: string, limit = 50) => api<{ messages: ChatMessage[]; hasMore: boolean }>(`/campaigns/${cid}/chat?limit=${limit}&before=${before}`),
};

export const creatureApi = {
  create: (cid: string, input: Record<string, unknown>) => api<CreatureTemplate>(`/campaigns/${cid}/creatures`, { body: input }),
  update: (cid: string, id: string, input: Record<string, unknown>) => api<CreatureTemplate>(`/campaigns/${cid}/creatures/${id}`, { method: 'PATCH', body: input }),
  remove: (cid: string, id: string) => api(`/campaigns/${cid}/creatures/${id}`, { method: 'DELETE' }),
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api<MeDto>('/me') });
export const useCampaigns = () => useQuery({ queryKey: qk.campaigns, queryFn: () => api<CampaignListItem[]>('/campaigns') });
export const useCampaign = (id: string) => useQuery({ queryKey: qk.campaign(id), queryFn: () => api<CampaignDashboardDto>(`/campaigns/${id}`) });
export const useInvites = (id: string, enabled: boolean) => useQuery({ queryKey: qk.invites(id), queryFn: () => api<InviteDto[]>(`/campaigns/${id}/invites`), enabled });
export const useMapDetail = (cid: string, mid: string) =>
  useQuery({ queryKey: qk.map(cid, mid), queryFn: () => api<{ map: MapDefinition; imageUrl: string | null }>(`/campaigns/${cid}/maps/${mid}`), staleTime: 5 * 60_000 });

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; description?: string; settings?: { meetingUrl?: string } }) => api<Campaign>('/campaigns', { body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.campaigns }),
  });
}

export function useCampaignMutation<TInput, TOut = unknown>(campaignId: string, fn: (input: TInput) => Promise<TOut>, extraKeys: readonly unknown[][] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
      for (const k of extraKeys) void qc.invalidateQueries({ queryKey: k });
    },
  });
}

export const campaignApi = {
  update: (id: string, input: unknown) => api<Campaign>(`/campaigns/${id}`, { method: 'PATCH', body: input }),
  archive: (id: string) => api<Campaign>(`/campaigns/${id}/archive`, { body: {} }),
  removeMember: (id: string, sub: string) => api(`/campaigns/${id}/members/${sub}`, { method: 'DELETE' }),
  createInvite: (id: string, input: { maxUses?: number; expiresInHours?: number }) => api<{ invite: InviteDto; token: string }>(`/campaigns/${id}/invites`, { body: input }),
  revokeInvite: (id: string, inviteId: string) => api(`/campaigns/${id}/invites/${inviteId}/revoke`, { body: {} }),
  previewInvite: (token: string) => api<InvitePreviewDto>('/invites/preview', { body: { token } }),
  acceptInvite: (token: string) => api<{ campaignId: string; alreadyMember: boolean }>('/invites/accept', { body: { token } }),
  createSession: (id: string, input: { title?: string; meetingUrl?: string }) => api<GameSession>(`/campaigns/${id}/sessions`, { body: input }),
  transition: (sessionId: string, action: 'start' | 'pause' | 'resume' | 'end') => api<GameSession>(`/sessions/${sessionId}/transition`, { body: { action } }),
  uploadIntent: (id: string, input: { fileName: string; contentType: string; bytes: number }) =>
    api<{ assetId: string; uploadUrl: string; headers: Record<string, string> }>(`/campaigns/${id}/maps/upload-intent`, { body: input }),
  finalizeMap: (id: string, input: { assetId: string; name: string; category: string }) => api<MapDefinition>(`/campaigns/${id}/maps`, { body: input }),
  updateMap: (id: string, mapId: string, input: unknown) => api<MapDefinition>(`/campaigns/${id}/maps/${mapId}`, { method: 'PATCH', body: input }),
  createScene: (id: string, input: { mapId: string; name: string; fogInitial: 'covered' | 'revealed' }) => api<Scene>(`/campaigns/${id}/scenes`, { body: input }),
};
