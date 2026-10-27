/**
 * Campaign permission resolution. Pure functions over server-loaded records;
 * the server is the only caller whose inputs are trusted. The client may use
 * the same functions purely to decide what UI to show.
 */
import type { CampaignMember, GMDelegation, GameSession, UserProfile } from './model';

export type CampaignAccess = {
  member: CampaignMember | null;
  isOwner: boolean;
  /** Owner, or holder of a delegation that is effective right now for this session. */
  isGM: boolean;
  isPlayer: boolean;
  canView: boolean;
  delegation?: GMDelegation;
};

export function isAccountUsable(profile: Pick<UserProfile, 'status' | 'suspendedUntil'> | null, now = new Date()): boolean {
  if (!profile) return false;
  if (profile.status === 'BLOCKED') return false;
  if (profile.status === 'SUSPENDED') {
    return !!profile.suspendedUntil && new Date(profile.suspendedUntil) <= now;
  }
  return true;
}

export function delegationIsEffective(d: GMDelegation, session: Pick<GameSession, 'id' | 'number'> | null, now = new Date()): boolean {
  if (d.revokedAt) return false;
  switch (d.scope.kind) {
    case 'SESSIONS':
      return !!session && d.scope.sessionIds.includes(session.id);
    case 'NEXT_N_SESSIONS':
      return !!session && session.number >= d.scope.fromSessionNumber && session.number < d.scope.fromSessionNumber + d.scope.count;
    case 'TIME_WINDOW':
      return new Date(d.scope.startsAt) <= now && now < new Date(d.scope.endsAt);
  }
}

export function resolveAccess(
  member: CampaignMember | null,
  delegations: GMDelegation[],
  session: Pick<GameSession, 'id' | 'number'> | null,
  now = new Date(),
): CampaignAccess {
  const active = member && member.status === 'ACTIVE' ? member : null;
  const isOwner = active?.role === 'OWNER';
  const delegation = active && !isOwner ? delegations.find((d) => d.delegateSub === active.userSub && d.permissions.scenes && delegationIsEffective(d, session, now)) : undefined;
  const isGM = isOwner || !!delegation;
  return {
    member: active,
    isOwner,
    isGM,
    isPlayer: active?.role === 'PLAYER',
    canView: !!active,
    ...(delegation ? { delegation } : {}),
  };
}

export const PLAYER_COLORS = ['#e4572e', '#29a3a3', '#f3a712', '#a86cc1', '#4c9f38', '#e56399', '#3d7dd8', '#c97b3a'];
