/**
 * Channel authorisation for subscribe and publish. Shared by the local
 * WebSocket hub and the AppSync Events Lambda handlers so both enforce the
 * same rules. Paths are parsed strictly; anything unexpected is denied.
 */
import { parseChannel, type ChannelRef } from '@shared/events';
import { isAccountUsable, resolveAccess } from '@shared/permissions';
import type { CampaignMember, GMDelegation, GameSession, UserProfile } from '@shared/model';
import { keys } from '../repo/db';
import type { Deps } from '../context';

export type ChannelDecision =
  | { ok: true; channel: ChannelRef; member: CampaignMember; isGM: boolean }
  | { ok: false; reason: string };

export async function authorizeChannel(deps: Deps, sub: string, path: string, op: 'subscribe' | 'publish'): Promise<ChannelDecision> {
  const channel = parseChannel(path);
  if (!channel) return { ok: false, reason: 'bad-channel' };
  // Only presence accepts client publishes; durable game channels are server-published.
  if (op === 'publish' && channel.ns !== 'presence') return { ok: false, reason: 'publish-denied' };

  const [session, profile] = await Promise.all([deps.db.get<GameSession>(keys.session(channel.sessionId)), deps.db.get<UserProfile>(keys.profile(sub))]);
  if (!session || !isAccountUsable(profile, deps.now())) return { ok: false, reason: 'denied' };
  if (session.status === 'ENDED') return { ok: false, reason: 'ended' };
  if (channel.epoch !== session.accessEpoch) return { ok: false, reason: 'stale-epoch' };

  const [member, delegations] = await Promise.all([
    deps.db.get<CampaignMember>(keys.member(session.campaignId, sub)),
    deps.db.queryPrefix<GMDelegation>(`CAMP#${session.campaignId}`, 'DELEG#'),
  ]);
  const access = resolveAccess(member, delegations, session, deps.now());
  if (!access.canView || !access.member) return { ok: false, reason: 'denied' };

  if (channel.ns === 'game') {
    if (channel.audience === 'gm' && !access.isGM) return { ok: false, reason: 'denied' };
    if (channel.audience === 'shared' && !access.isGM) return { ok: false, reason: 'denied' };
    if (channel.audience === 'user' && channel.sub !== sub) return { ok: false, reason: 'denied' };
  } else if (!access.isGM && session.status !== 'LIVE' && session.status !== 'PAUSED') {
    return { ok: false, reason: 'not-live' };
  }
  return { ok: true, channel, member: access.member, isGM: access.isGM };
}
