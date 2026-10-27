/**
 * Immutable platform audit log. There is no update or delete path; records
 * carry no secrets, tokens or message bodies.
 */
import { monotonicFactory } from 'ulid';
import type { Deps } from '../context';

const nextId = monotonicFactory();

export type AuditAction =
  | 'USER_SUSPENDED'
  | 'USER_BLOCKED'
  | 'USER_UNBLOCKED'
  | 'ADMIN_REVOKED'
  | 'MEMBER_REMOVED_BY_ADMIN'
  | 'REPORT_RESOLVED'
  | 'DELEGATION_GRANTED'
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_DENIED'
  | 'ADMIN_ACCESS_DENIED';

export type AuditEvent = {
  id: string;
  at: string;
  actorSub: string;
  action: AuditAction;
  targetType: 'USER' | 'CAMPAIGN' | 'REPORT' | 'DELEGATION';
  targetId: string;
  campaignId?: string;
  reason?: string;
  outcome: 'SUCCESS' | 'DENIED';
  metadata?: Record<string, string | number | boolean>;
};

export async function audit(deps: Deps, e: Omit<AuditEvent, 'id' | 'at'>) {
  const at = deps.now().toISOString();
  const id = nextId();
  const event: AuditEvent = { id, at, ...e };
  await deps.db
    .put({ PK: 'AUDIT', SK: `${at}#${id}`, GSI1PK: `AUDIT#${e.targetType}#${e.targetId}`, GSI1SK: `${at}#${id}`, entity: 'Audit', ...event }, { expr: 'attribute_not_exists(PK)' })
    .catch((err) => deps.log('error', 'audit write failed', { action: e.action, message: (err as Error).message }));
  return event;
}

export async function listAudit(deps: Deps, opts: { before?: string; limit?: number; target?: { type: AuditEvent['targetType']; id: string } } = {}) {
  const limit = Math.min(100, opts.limit ?? 50);
  if (opts.target) {
    return deps.db.query<AuditEvent>(
      { IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `AUDIT#${opts.target.type}#${opts.target.id}` }, ScanIndexForward: false, Limit: limit },
      { limit, all: false },
    );
  }
  return deps.db.query<AuditEvent>(
    {
      KeyConditionExpression: opts.before ? 'PK = :pk AND SK < :b' : 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'AUDIT', ...(opts.before ? { ':b': opts.before } : {}) },
      ScanIndexForward: false,
      Limit: limit,
    },
    { limit, all: false },
  );
}
