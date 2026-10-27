import { ulid } from 'ulid';
import type { z } from 'zod';
import { forbidden, notFound } from '@shared/errors';
import { PLAYER_COLORS } from '@shared/permissions';
import type { Campaign, CampaignMember, GameSession, MapDefinition, Scene, UserProfile } from '@shared/model';
import type { CreateCampaignInput, UpdateCampaignInput, UpdateProfileInput } from '@shared/schemas/api';
import { keys } from '../repo/db';
import { loadCampaign, requireActiveCampaign, requireOwner, type Actor, type Deps } from '../context';
import { rotateLiveEpochs } from './sessions';

export function memberItem(m: CampaignMember) {
  return { ...keys.member(m.campaignId, m.userSub), GSI1PK: `USER#${m.userSub}`, GSI1SK: `CAMP#${m.campaignId}`, entity: 'Member', ...m };
}

export async function createCampaign(deps: Deps, actor: Actor, input: z.output<typeof CreateCampaignInput>): Promise<Campaign> {
  const now = deps.now().toISOString();
  const campaign: Campaign = {
    id: ulid(),
    ownerSub: actor.sub,
    title: input.title,
    description: input.description,
    systemId: input.systemId,
    systemVersion: '1',
    status: 'ACTIVE',
    settings: input.settings,
    createdAt: now,
    updatedAt: now,
  };
  const owner: CampaignMember = { campaignId: campaign.id, userSub: actor.sub, role: 'OWNER', status: 'ACTIVE', displayName: actor.displayName, color: PLAYER_COLORS[0]!, joinedAt: now };
  await deps.db.transact([
    { Put: { Item: { ...keys.campaign(campaign.id), entity: 'Campaign', ...campaign }, ConditionExpression: 'attribute_not_exists(PK)' } },
    { Put: { Item: memberItem(owner) } },
  ]);
  return campaign;
}

export async function listMyCampaigns(deps: Deps, actor: Actor) {
  const memberships = await deps.db.queryPrefix<CampaignMember>(`USER#${actor.sub}`, 'CAMP#', { index: 'GSI1' });
  const active = memberships.filter((m) => m.status === 'ACTIVE');
  const campaigns = await deps.db.batchGet<Campaign>(active.map((m) => keys.campaign(m.campaignId)));
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  return active
    .map((m) => ({ campaign: byId.get(m.campaignId), role: m.role }))
    .filter((x): x is { campaign: Campaign; role: CampaignMember['role'] } => !!x.campaign)
    .sort((a, b) => b.campaign.updatedAt.localeCompare(a.campaign.updatedAt));
}

export async function getCampaignDashboard(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  const [members, sessions] = await Promise.all([
    listMembers(deps, campaignId),
    deps.db.queryPrefix<GameSession>(`CAMP#${campaignId}`, 'SESSION#', { index: 'GSI1', forward: false }),
  ]);
  const isGM = ctx.access.isGM;
  const [maps, scenes] = isGM
    ? await Promise.all([deps.db.queryPrefix<MapDefinition>(`CAMP#${campaignId}`, 'MAP#'), deps.db.queryPrefix<Scene>(`CAMP#${campaignId}`, 'SCENE#', { index: 'GSI1' })])
    : [[], []];
  return {
    campaign: ctx.campaign,
    access: { isOwner: ctx.access.isOwner, isGM, role: ctx.access.member!.role },
    members: members.map(({ campaignId: _c, ...m }) => m),
    sessions: sessions.map(({ gmNotes: _n, ...s }) => s),
    maps,
    scenes: scenes.map((s) => ({ id: s.id, name: s.name, mapId: s.mapId, parentSceneId: s.parentSceneId, updatedAt: s.updatedAt })),
  };
}

export async function listMembers(deps: Deps, campaignId: string) {
  const members = await deps.db.queryPrefix<CampaignMember>(`CAMP#${campaignId}`, 'MEMBER#');
  return members.filter((m) => m.status === 'ACTIVE');
}

export async function updateCampaign(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof UpdateCampaignInput>) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireOwner(ctx);
  requireActiveCampaign(ctx);
  const next: Campaign = {
    ...ctx.campaign,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    settings: { ...ctx.campaign.settings, ...stripUndefined(input.settings ?? {}) },
    updatedAt: deps.now().toISOString(),
  };
  if (input.settings && 'meetingUrl' in input.settings && !input.settings.meetingUrl) delete next.settings.meetingUrl;
  await deps.db.put({ ...keys.campaign(campaignId), entity: 'Campaign', ...next });
  return next;
}

export async function archiveCampaign(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireOwner(ctx);
  return deps.db.update<Campaign>({
    Key: keys.campaign(campaignId),
    UpdateExpression: 'SET #s = :s, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'ARCHIVED', ':now': deps.now().toISOString() },
  });
}

export async function removeMember(deps: Deps, actor: Actor, campaignId: string, userSub: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  const canManage = ctx.access.isOwner || !!ctx.access.delegation?.permissions.members || actor.isPlatformAdmin;
  if (!canManage) throw forbidden();
  if (userSub === ctx.campaign.ownerSub) throw forbidden('The campaign owner cannot be removed.');
  const member = await deps.db.get<CampaignMember>(keys.member(campaignId, userSub));
  if (!member || member.status !== 'ACTIVE') throw notFound('Member');
  await deps.db.update({
    Key: keys.member(campaignId, userSub),
    UpdateExpression: 'SET #s = :removed',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':removed': 'REMOVED' },
  });
  // Existing realtime subscriptions are bound to the old epoch; rotating it cuts the removed member off.
  await rotateLiveEpochs(deps, campaignId, 'member-removed');
}

export async function updateMyProfile(deps: Deps, actor: Actor, input: z.output<typeof UpdateProfileInput>) {
  const profile = await deps.db.update<UserProfile>({
    Key: keys.profile(actor.sub),
    UpdateExpression: 'SET displayName = :n, updatedAt = :now',
    ExpressionAttributeValues: { ':n': input.displayName, ':now': deps.now().toISOString() },
  });
  // Keep denormalised member display names current.
  const memberships = await deps.db.queryPrefix<CampaignMember>(`USER#${actor.sub}`, 'CAMP#', { index: 'GSI1' });
  await Promise.all(
    memberships.map((m) =>
      deps.db.update({ Key: keys.member(m.campaignId, actor.sub), UpdateExpression: 'SET displayName = :n', ExpressionAttributeValues: { ':n': input.displayName } }),
    ),
  );
  return profile;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
