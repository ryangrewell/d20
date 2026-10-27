import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { z } from 'zod';
import { AppError, notFound } from '@shared/errors';
import { PLAYER_COLORS } from '@shared/permissions';
import type { Campaign, CampaignInvite, CampaignMember } from '@shared/model';
import type { CreateInviteInput } from '@shared/schemas/api';
import { isConditionalFailure, keys } from '../repo/db';
import { loadCampaign, requireActiveCampaign, type Actor, type Deps } from '../context';
import { memberItem, listMembers } from './campaigns';
import { rateLimit } from './rateLimit';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type PublicInvite = Omit<CampaignInvite, 'tokenHash'> & { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'USED_UP' };

function inviteStatus(inv: CampaignInvite, now: Date): PublicInvite['status'] {
  if (inv.revokedAt) return 'REVOKED';
  if (inv.expiresAt && new Date(inv.expiresAt) <= now) return 'EXPIRED';
  if (inv.maxUses !== undefined && inv.useCount >= inv.maxUses) return 'USED_UP';
  return 'ACTIVE';
}

function toPublic(inv: CampaignInvite, now: Date): PublicInvite {
  const { tokenHash: _t, ...rest } = inv;
  return { ...rest, status: inviteStatus(inv, now) };
}

async function requireInviteManager(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  if (!ctx.access.isOwner && !ctx.access.delegation?.permissions.members) throw new AppError('FORBIDDEN', 'Only the GM can manage invitations.');
  requireActiveCampaign(ctx);
  return ctx;
}

/** Returns the raw token exactly once; only its SHA-256 hash is stored. */
export async function createInvite(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof CreateInviteInput>) {
  await requireInviteManager(deps, actor, campaignId);
  await rateLimit(deps, `invite-create:${actor.sub}`, 30, 3600);
  const token = randomBytes(24).toString('base64url');
  const now = deps.now();
  const invite: CampaignInvite = {
    id: ulid(),
    campaignId,
    tokenHash: hashToken(token),
    createdBy: actor.sub,
    role: input.role,
    useCount: 0,
    createdAt: now.toISOString(),
    ...(input.expiresInHours ? { expiresAt: new Date(now.getTime() + input.expiresInHours * 3600_000).toISOString() } : {}),
    ...(input.maxUses ? { maxUses: input.maxUses } : {}),
  };
  await deps.db.put({ ...keys.invite(campaignId, invite.id), GSI1PK: `INVITEHASH#${invite.tokenHash}`, GSI1SK: 'INVITE', entity: 'Invite', ...invite });
  return { invite: toPublic(invite, now), token };
}

export async function listInvites(deps: Deps, actor: Actor, campaignId: string) {
  await requireInviteManager(deps, actor, campaignId);
  const invites = await deps.db.queryPrefix<CampaignInvite>(`CAMP#${campaignId}`, 'INVITE#', { forward: false });
  const now = deps.now();
  return invites.map((i) => toPublic(i, now));
}

export async function revokeInvite(deps: Deps, actor: Actor, campaignId: string, inviteId: string) {
  await requireInviteManager(deps, actor, campaignId);
  try {
    await deps.db.update({
      Key: keys.invite(campaignId, inviteId),
      UpdateExpression: 'SET revokedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':now': deps.now().toISOString() },
    });
  } catch (err) {
    if (isConditionalFailure(err)) throw notFound('Invitation');
    throw err;
  }
}

async function findByToken(deps: Deps, token: string): Promise<CampaignInvite | null> {
  const [inv] = await deps.db.query<CampaignInvite>({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `INVITEHASH#${hashToken(token)}` },
  });
  return inv ?? null;
}

const INVALID = () => new AppError('NOT_FOUND', 'This invitation link is invalid, expired, or has been revoked.');

/** Minimal preview for a signed-in user holding the link. Reveals no private campaign content. */
export async function previewInvite(deps: Deps, actor: Actor, token: string) {
  await rateLimit(deps, `invite-preview:${actor.sub}`, 60, 3600);
  const inv = await findByToken(deps, token);
  if (!inv || inviteStatus(inv, deps.now()) !== 'ACTIVE') throw INVALID();
  const campaign = await deps.db.get<Campaign>(keys.campaign(inv.campaignId));
  if (!campaign || campaign.status !== 'ACTIVE') throw INVALID();
  const owner = await deps.db.get<CampaignMember>(keys.member(campaign.id, campaign.ownerSub));
  const existing = await deps.db.get<CampaignMember>(keys.member(campaign.id, actor.sub));
  return { campaignId: campaign.id, title: campaign.title, gmName: owner?.displayName ?? 'Your GM', role: inv.role, alreadyMember: existing?.status === 'ACTIVE' };
}

/** Atomically consumes one use and creates the membership. Double redemption and over-use are rejected. */
export async function acceptInvite(deps: Deps, actor: Actor, token: string) {
  await rateLimit(deps, `invite-accept:${actor.sub}`, 20, 3600);
  const inv = await findByToken(deps, token);
  const now = deps.now();
  if (!inv) throw INVALID();
  // Members re-opening their old link go straight to the campaign, even if the link is used up.
  const existing = await deps.db.get<CampaignMember>(keys.member(inv.campaignId, actor.sub));
  if (existing?.status === 'ACTIVE') return { campaignId: inv.campaignId, alreadyMember: true };
  if (inviteStatus(inv, now) !== 'ACTIVE') throw INVALID();
  const campaign = await deps.db.get<Campaign>(keys.campaign(inv.campaignId));
  if (!campaign || campaign.status !== 'ACTIVE') throw INVALID();

  if (existing?.status === 'REMOVED') throw new AppError('FORBIDDEN', 'You were removed from this campaign. Ask the GM to add you back.');

  const members = await listMembers(deps, campaign.id);
  const used = new Set(members.map((m) => m.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[members.length % PLAYER_COLORS.length]!;
  const member: CampaignMember = { campaignId: campaign.id, userSub: actor.sub, role: inv.role, status: 'ACTIVE', displayName: actor.displayName, color, joinedAt: now.toISOString() };

  try {
    await deps.db.transact([
      {
        Update: {
          Key: keys.invite(inv.campaignId, inv.id),
          UpdateExpression: 'SET useCount = useCount + :one',
          ConditionExpression: 'attribute_not_exists(revokedAt) AND (attribute_not_exists(maxUses) OR useCount < maxUses) AND (attribute_not_exists(expiresAt) OR expiresAt > :now)',
          ExpressionAttributeValues: { ':one': 1, ':now': now.toISOString() },
        },
      },
      { Put: { Item: memberItem(member), ConditionExpression: 'attribute_not_exists(PK)' } },
    ]);
  } catch (err) {
    if (isConditionalFailure(err)) {
      const again = await deps.db.get<CampaignMember>(keys.member(campaign.id, actor.sub));
      if (again?.status === 'ACTIVE') return { campaignId: campaign.id, alreadyMember: true };
      throw INVALID();
    }
    throw err;
  }
  return { campaignId: campaign.id, alreadyMember: false };
}
