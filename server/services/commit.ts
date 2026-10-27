/**
 * The single path by which durable session changes are persisted and
 * broadcast: allocate revision -> transactional write (state + event +
 * idempotency record) -> publish audience projections.
 */
import { ulid } from 'ulid';
import { delegationIsEffective } from '@shared/permissions';
import type { CampaignMember, GMDelegation, GameSession } from '@shared/model';
import { isConditionalFailure, keys, type TxItem } from '../repo/db';
import { buildBundles, bundlesForStorage, type Change, type SessionAudience } from '../realtime/fanout';
import type { Actor, Deps } from '../context';
import { rekeyExpiredDelegations } from './delegations';

export type TransactItem = TxItem;

export async function sessionAudience(deps: Deps, session: Pick<GameSession, 'id' | 'number' | 'campaignId'>): Promise<SessionAudience> {
  const [members, delegations] = await Promise.all([
    deps.db.queryPrefix<CampaignMember>(`CAMP#${session.campaignId}`, 'MEMBER#'),
    deps.db.queryPrefix<GMDelegation>(`CAMP#${session.campaignId}`, 'DELEG#'),
  ]);
  const now = deps.now();
  const gmSubs: string[] = [];
  const playerSubs: string[] = [];
  for (const m of members) {
    if (m.status !== 'ACTIVE') continue;
    const delegated = delegations.some((d) => d.delegateSub === m.userSub && d.permissions.scenes && delegationIsEffective(d, session, now));
    (m.role === 'OWNER' || delegated ? gmSubs : playerSubs).push(m.userSub);
  }
  return { gmSubs, playerSubs };
}

export class DuplicateCommand extends Error {}

export async function commit(
  deps: Deps,
  session: GameSession,
  actor: Actor | null,
  changes: Change[],
  writes: TransactItem[],
  opts: { commandId?: string; result?: unknown; projectionSession?: GameSession } = {},
): Promise<{ revision: number; ts: string }> {
  const ts = deps.now().toISOString();
  // Expired delegations rotate the access epoch before anything is published.
  await rekeyExpiredDelegations(deps, session.campaignId);
  const bumped = await deps.db.update<GameSession>({
    Key: keys.session(session.id),
    UpdateExpression: 'ADD revision :one SET updatedAt = :now',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':one': 1, ':now': ts },
  });
  const revision = bumped!.revision;
  const projection = { ...(opts.projectionSession ?? bumped!), revision, accessEpoch: bumped!.accessEpoch };
  const audience = await sessionAudience(deps, session);
  const eventId = ulid();
  const actorStamp = actor ? { sub: actor.sub, displayName: actor.displayName } : undefined;
  const bundles = buildBundles(projection, audience, changes, { eventId, revision, ts, ...(actorStamp ? { actor: actorStamp } : {}) });
  const ttl = Math.floor(deps.now().getTime() / 1000) + deps.config.eventRetentionDays * 86400;

  const items: TransactItem[] = [
    ...writes,
    { Put: { Item: { ...keys.event(session.id, revision), entity: 'Event', eventId, revision, ts, actorSub: actor?.sub, audiences: bundlesForStorage(bundles), ttl } } },
  ];
  if (opts.commandId) {
    items.push({
      Put: {
        Item: { ...keys.command(session.id, opts.commandId), entity: 'Command', revision, ts, result: opts.result ?? null, actorSub: actor?.sub, ttl: Math.floor(Date.now() / 1000) + 86400 },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
  }
  try {
    await deps.db.transact(items);
  } catch (err) {
    // A revision number is skipped on failure; revisions are monotonic, not contiguous.
    if (isConditionalFailure(err)) throw err;
    throw err;
  }

  // One quick retry; if it still fails, clients recover via their periodic catch-up from the event log.
  const publishOnce = (b: (typeof bundles)[number]) => deps.publisher.publish(b.channel, [b.event]);
  const results = await Promise.allSettled(
    bundles.map((b) => publishOnce(b).catch(() => new Promise<void>((resolve, reject) => setTimeout(() => publishOnce(b).then(resolve, reject), 250)))),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') deps.log('warn', 'event publish failed after retry; clients will catch up from the event log', { channel: bundles[i]!.channel.split('/').slice(0, 4).join('/'), revision });
  });
  return { revision, ts };
}
