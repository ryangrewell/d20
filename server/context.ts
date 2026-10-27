import { AppError, forbidden, notFound } from '@shared/errors';
import { isAccountUsable, resolveAccess, type CampaignAccess } from '@shared/permissions';
import type { Campaign, CampaignMember, GMDelegation, GameSession, UserProfile } from '@shared/model';
import { keys, type Db } from './repo/db';
import type { Blobs } from './storage/blobs';
import type { Publisher } from './realtime/publisher';
import type { ServerConfig } from './config';
import { PLATFORM_ADMIN_GROUP, type VerifiedIdentity } from './auth/verify';

export type Deps = {
  db: Db;
  blobs: Blobs;
  publisher: Publisher;
  config: ServerConfig;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
};

export type Actor = {
  sub: string;
  displayName: string;
  isPlatformAdmin: boolean;
  profile: UserProfile;
};

/** Resolves the caller from a verified token. Creates the profile on first sign-in. */
export async function resolveActor(deps: Deps, id: VerifiedIdentity): Promise<Actor> {
  let profile = await deps.db.get<UserProfile>(keys.profile(id.sub));
  const now = deps.now().toISOString();
  if (!profile) {
    const displayName = (id.name || id.email?.split('@')[0] || 'Adventurer').slice(0, 40);
    profile = { sub: id.sub, displayName, status: 'ACTIVE', createdAt: now, updatedAt: now };
    try {
      await deps.db.put(
        { ...keys.profile(id.sub), GSI1PK: 'USERS', GSI1SK: `${now}#${id.sub}`, entity: 'Profile', ...profile, ...(id.email ? { email: id.email } : {}) },
        { expr: 'attribute_not_exists(PK)' },
      );
    } catch {
      profile = (await deps.db.get<UserProfile>(keys.profile(id.sub)))!;
    }
  }
  if (!isAccountUsable(profile, deps.now())) {
    throw new AppError('FORBIDDEN', profile.status === 'BLOCKED' ? 'This account has been blocked.' : 'This account is suspended.', { accountStatus: profile.status });
  }
  return { sub: id.sub, displayName: profile.displayName, isPlatformAdmin: id.groups.includes(PLATFORM_ADMIN_GROUP), profile };
}

export type CampaignContext = {
  campaign: Campaign;
  access: CampaignAccess;
  delegations: GMDelegation[];
};

/**
 * Loads a campaign and the caller's access. Non-members get NOT_FOUND so the
 * existence of private campaigns is not disclosed.
 */
export async function loadCampaign(deps: Deps, actor: Actor, campaignId: string, session: GameSession | null = null): Promise<CampaignContext> {
  const [campaign, member, delegations] = await Promise.all([
    deps.db.get<Campaign>(keys.campaign(campaignId)),
    deps.db.get<CampaignMember>(keys.member(campaignId, actor.sub)),
    deps.db.queryPrefix<GMDelegation>(`CAMP#${campaignId}`, 'DELEG#'),
  ]);
  if (!campaign) throw notFound('Campaign');
  const access = resolveAccess(member, delegations, session, deps.now());
  if (!access.canView) throw notFound('Campaign');
  return { campaign, access, delegations };
}

export function requireGM(ctx: CampaignContext) {
  if (!ctx.access.isGM) throw forbidden('Only the GM can do that.');
}

export function requireOwner(ctx: CampaignContext) {
  if (!ctx.access.isOwner) throw forbidden('Only the campaign owner can do that.');
}

export function requireActiveCampaign(ctx: CampaignContext) {
  if (ctx.campaign.status !== 'ACTIVE') throw new AppError('CONFLICT', 'This campaign is archived.');
}

export async function loadSession(deps: Deps, sessionId: string): Promise<GameSession> {
  const s = await deps.db.get<GameSession>(keys.session(sessionId));
  if (!s) throw notFound('Session');
  return s;
}
