/**
 * Delegated GM control (spec section 12). Only the campaign owner grants or
 * revokes; delegates can never extend or re-delegate. Effective access is
 * always computed server-side from authoritative time and session ordinals.
 */
import { ulid } from 'ulid';
import { z } from 'zod';
import { AppError, conflict, invalid, notFound } from '@shared/errors';
import type { CampaignMember, GMDelegation, GameSession } from '@shared/model';
import { Id, UserSub } from '@shared/schemas/common';
import { keys } from '../repo/db';
import { loadCampaign, requireActiveCampaign, type Actor, type Deps } from '../context';
import { audit } from './audit';
import { rotateLiveEpochs } from './sessions';

export const CreateDelegationInput = z.object({
  delegateSub: UserSub,
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('SESSIONS'), sessionIds: z.array(Id).min(1).max(20) }),
    z.object({ kind: z.literal('NEXT_N_SESSIONS'), count: z.number().int().min(1).max(20) }),
    z.object({ kind: z.literal('TIME_WINDOW'), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) }),
  ]),
  permissions: z.object({ members: z.boolean().default(false), characters: z.boolean().default(false) }).default({ members: false, characters: false }),
});

const MAX_WINDOW_MS = 90 * 86400_000;

async function ownerOnly(deps: Deps, actor: Actor, campaignId: string, attempted: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  if (!ctx.access.isOwner) {
    await audit(deps, { actorSub: actor.sub, action: 'DELEGATION_DENIED', targetType: 'CAMPAIGN', targetId: campaignId, campaignId, outcome: 'DENIED', metadata: { attempted } });
    throw new AppError('FORBIDDEN', 'Only the campaign owner can delegate GM control.');
  }
  return ctx;
}

export async function createDelegation(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof CreateDelegationInput>) {
  const ctx = await ownerOnly(deps, actor, campaignId, 'grant');
  requireActiveCampaign(ctx);
  if (input.delegateSub === actor.sub) throw invalid('You already have full GM control.');
  const member = await deps.db.get<CampaignMember>(keys.member(campaignId, input.delegateSub));
  if (!member || member.status !== 'ACTIVE') throw invalid('That person is not a member of this campaign.');

  const now = deps.now();
  let scope: GMDelegation['scope'];
  const sessions = await deps.db.queryPrefix<GameSession>(`CAMP#${campaignId}`, 'SESSION#', { index: 'GSI1' });
  if (input.scope.kind === 'SESSIONS') {
    const ids = [...new Set(input.scope.sessionIds)];
    const ok = ids.every((id) => sessions.some((s) => s.id === id && s.status !== 'ENDED'));
    if (!ok) throw invalid('Choose sessions from this campaign that have not ended.');
    scope = { kind: 'SESSIONS', sessionIds: ids };
  } else if (input.scope.kind === 'NEXT_N_SESSIONS') {
    // Stable ordinals: the current unfinished session if there is one, otherwise the next one created.
    const open = sessions.filter((s) => s.status !== 'ENDED').sort((a, b) => a.number - b.number)[0];
    const counter = await deps.db.get<{ value: number }>(keys.counter(campaignId, 'session'));
    scope = { kind: 'NEXT_N_SESSIONS', fromSessionNumber: open ? open.number : (counter?.value ?? 0) + 1, count: input.scope.count };
  } else {
    const start = new Date(input.scope.startsAt);
    const end = new Date(input.scope.endsAt);
    if (!(end > start)) throw invalid('The end time must be after the start time.');
    if (end <= now) throw invalid('That time window has already ended.');
    if (end.getTime() - start.getTime() > MAX_WINDOW_MS) throw invalid('A delegation can last at most 90 days.');
    scope = { kind: 'TIME_WINDOW', startsAt: start.toISOString(), endsAt: end.toISOString() };
  }
  const d: GMDelegation = { id: ulid(), campaignId, delegateSub: input.delegateSub, grantedBy: actor.sub, scope, permissions: { scenes: true, ...input.permissions }, createdAt: now.toISOString() };
  await deps.db.put({ ...keys.delegation(campaignId, d.id), entity: 'Delegation', ...d });
  await audit(deps, { actorSub: actor.sub, action: 'DELEGATION_GRANTED', targetType: 'DELEGATION', targetId: d.id, campaignId, outcome: 'SUCCESS', metadata: { delegateSub: d.delegateSub, scope: d.scope.kind } });
  // Everyone resubscribes so the delegate picks up the GM stream straight away.
  await rotateLiveEpochs(deps, campaignId, 'epoch-rotated');
  return d;
}

export async function listDelegations(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  const all = (await deps.db.queryPrefix<GMDelegation>(`CAMP#${campaignId}`, 'DELEG#')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return ctx.access.isOwner ? all : all.filter((d) => d.delegateSub === actor.sub);
}

export async function revokeDelegation(deps: Deps, actor: Actor, campaignId: string, id: string) {
  await ownerOnly(deps, actor, campaignId, 'revoke');
  const d = await deps.db.get<GMDelegation>(keys.delegation(campaignId, id));
  if (!d) throw notFound('Delegation');
  if (d.revokedAt) throw conflict('That delegation was already revoked.');
  await deps.db.update({ Key: keys.delegation(campaignId, id), UpdateExpression: 'SET revokedAt = :now', ConditionExpression: 'attribute_not_exists(revokedAt)', ExpressionAttributeValues: { ':now': deps.now().toISOString() } });
  await audit(deps, { actorSub: actor.sub, action: 'DELEGATION_REVOKED', targetType: 'DELEGATION', targetId: id, campaignId, outcome: 'SUCCESS', metadata: { delegateSub: d.delegateSub } });
  // Cut the delegate off the GM stream immediately.
  await rotateLiveEpochs(deps, campaignId, 'epoch-rotated');
}

/**
 * Time-window delegations end without any request. Before anything is
 * published, rotate the access epoch once per expired delegation so the former
 * delegate's GM subscription receives nothing after expiry.
 */
export async function rekeyExpiredDelegations(deps: Deps, campaignId: string): Promise<boolean> {
  const now = deps.now();
  const delegations = await deps.db.queryPrefix<GMDelegation & { rekeyedAt?: string }>(`CAMP#${campaignId}`, 'DELEG#');
  let rotated = false;
  for (const d of delegations) {
    if (d.revokedAt || d.rekeyedAt || d.scope.kind !== 'TIME_WINDOW' || new Date(d.scope.endsAt) > now) continue;
    try {
      await deps.db.update({ Key: keys.delegation(campaignId, d.id), UpdateExpression: 'SET rekeyedAt = :now', ConditionExpression: 'attribute_not_exists(rekeyedAt)', ExpressionAttributeValues: { ':now': now.toISOString() } });
    } catch {
      continue; // another request handled it
    }
    rotated = true;
    await audit(deps, { actorSub: 'system', action: 'DELEGATION_EXPIRED', targetType: 'DELEGATION', targetId: d.id, campaignId, outcome: 'SUCCESS', metadata: { delegateSub: d.delegateSub } });
  }
  if (rotated) await rotateLiveEpochs(deps, campaignId, 'epoch-rotated');
  return rotated;
}
