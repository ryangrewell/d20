/**
 * Platform administration (spec section 13). Every operation re-checks admin
 * rights live against the identity provider and is audited. Admin views show
 * summaries only; private campaign content, notes and whispers are never
 * exposed here.
 *
 * Scale note: user/campaign listings walk the USERS index and memberships.
 * That is fine for hundreds of users; add dedicated indexes before thousands.
 */
import { ulid } from 'ulid';
import { z } from 'zod';
import { AppError, conflict, forbidden, invalid, notFound } from '@shared/errors';
import type { Campaign, CampaignMember, ChatMessage, MapAsset, UserProfile } from '@shared/model';
import { Id, IsoDate, UserSub, plainText } from '@shared/schemas/common';
import { keys } from '../repo/db';
import type { Actor, Deps } from '../context';
import { audit, listAudit } from './audit';
import { rotateLiveEpochs } from './sessions';
import { rateLimit } from './rateLimit';
import { canRead } from './chat';

type Profile = UserProfile & { email?: string };

export async function requireAdmin(deps: Deps, actor: Actor) {
  if (await deps.directory.isAdmin(actor.sub).catch(() => false)) return;
  await audit(deps, { actorSub: actor.sub, action: 'ADMIN_ACCESS_DENIED', targetType: 'USER', targetId: actor.sub, outcome: 'DENIED' });
  throw new AppError('FORBIDDEN', 'Administrator access required.');
}

async function allProfiles(deps: Deps) {
  return deps.db.query<Profile>({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :u', ExpressionAttributeValues: { ':u': 'USERS' }, ScanIndexForward: false });
}

async function membershipsOf(deps: Deps, sub: string) {
  return deps.db.queryPrefix<CampaignMember>(`USER#${sub}`, 'CAMP#', { index: 'GSI1' });
}

async function allCampaigns(deps: Deps, profiles: Profile[]) {
  const owned = new Set<string>();
  for (const p of profiles) for (const m of await membershipsOf(deps, p.sub)) if (m.role === 'OWNER') owned.add(m.campaignId);
  return deps.db.batchGet<Campaign>([...owned].map((id) => keys.campaign(id)));
}

const summary = (p: Profile) => ({ sub: p.sub, displayName: p.displayName, email: p.email ?? null, status: p.status, suspendedUntil: p.suspendedUntil ?? null, createdAt: p.createdAt, lastActiveAt: p.lastActiveAt ?? null });

export async function metrics(deps: Deps, actor: Actor) {
  await requireAdmin(deps, actor);
  const now = deps.now().getTime();
  const within = (iso: string | undefined, days: number) => !!iso && now - new Date(iso).getTime() <= days * 86400_000;
  const profiles = await allProfiles(deps);
  const campaigns = await allCampaigns(deps, profiles);
  let storageBytes = 0;
  let uploads = 0;
  for (const c of campaigns) {
    const assets = await deps.db.queryPrefix<MapAsset>(`CAMP#${c.id}`, 'ASSET#');
    for (const a of assets) {
      if (a.status !== 'READY') continue;
      storageBytes += a.bytes;
      uploads++;
    }
  }
  const openReports = (await deps.db.queryPrefix<{ status: string }>('REPORT', 'REPORT#')).filter((r) => r.status === 'OPEN').length;
  return {
    users: {
      total: profiles.length,
      new7: profiles.filter((p) => within(p.createdAt, 7)).length,
      new30: profiles.filter((p) => within(p.createdAt, 30)).length,
      active7: profiles.filter((p) => within(p.lastActiveAt, 7)).length,
      active30: profiles.filter((p) => within(p.lastActiveAt, 30)).length,
      suspended: profiles.filter((p) => p.status === 'SUSPENDED').length,
      blocked: profiles.filter((p) => p.status === 'BLOCKED').length,
    },
    campaigns: { total: campaigns.length, active30: campaigns.filter((c) => c.status === 'ACTIVE' && within(c.updatedAt, 30)).length, liveSessions: campaigns.filter((c) => !!c.activeSessionId).length },
    storage: { bytes: storageBytes, uploads },
    reports: { open: openReports },
    recentUsers: profiles.slice(0, 8).map(summary),
    recentAudit: await listAudit(deps, { limit: 10 }),
  };
}

export async function listUsers(deps: Deps, actor: Actor, query: string) {
  await requireAdmin(deps, actor);
  const q = query.trim().toLowerCase();
  const [profiles, admins] = await Promise.all([allProfiles(deps), deps.directory.listAdmins().catch(() => [] as string[])]);
  return profiles
    .filter((p) => !q || p.displayName.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q) || p.sub.toLowerCase() === q)
    .slice(0, 200)
    .map((p) => ({ ...summary(p), isAdmin: admins.includes(p.sub) }));
}

export async function getUser(deps: Deps, actor: Actor, sub: string) {
  await requireAdmin(deps, actor);
  const p = await deps.db.get<Profile>(keys.profile(sub));
  if (!p) throw notFound('User');
  const memberships = await membershipsOf(deps, sub);
  const campaigns = await deps.db.batchGet<Campaign>(memberships.map((m) => keys.campaign(m.campaignId)));
  const admins = await deps.directory.listAdmins().catch(() => [] as string[]);
  return {
    user: { ...summary(p), isAdmin: admins.includes(sub) },
    campaigns: memberships.map((m) => ({ campaignId: m.campaignId, title: campaigns.find((c) => c.id === m.campaignId)?.title ?? '(deleted)', role: m.role, status: m.status })),
    history: await listAudit(deps, { target: { type: 'USER', id: sub }, limit: 50 }),
  };
}

export const ModerationInput = z.object({ reason: plainText(1000).pipe(z.string().min(3, 'Give a reason (kept in the audit log).')) });
export const SuspendInput = ModerationInput.extend({ until: IsoDate });

async function cutOff(deps: Deps, sub: string) {
  // Rotate epochs everywhere this user is a member so open streams stop.
  for (const m of await membershipsOf(deps, sub)) await rotateLiveEpochs(deps, m.campaignId, 'epoch-rotated');
}

async function targetUser(deps: Deps, actor: Actor, sub: string) {
  if (sub === actor.sub) throw invalid('You cannot moderate your own account.');
  const p = await deps.db.get<Profile>(keys.profile(sub));
  if (!p) throw notFound('User');
  return p;
}

export async function suspendUser(deps: Deps, actor: Actor, sub: string, input: z.output<typeof SuspendInput>) {
  await requireAdmin(deps, actor);
  await targetUser(deps, actor, sub);
  if (new Date(input.until) <= deps.now()) throw invalid('Choose a date in the future.');
  await deps.db.update({ Key: keys.profile(sub), UpdateExpression: 'SET #s = :s, suspendedUntil = :u, updatedAt = :now', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'SUSPENDED', ':u': input.until, ':now': deps.now().toISOString() } });
  await cutOff(deps, sub);
  await audit(deps, { actorSub: actor.sub, action: 'USER_SUSPENDED', targetType: 'USER', targetId: sub, reason: input.reason, outcome: 'SUCCESS', metadata: { until: input.until } });
}

export async function blockUser(deps: Deps, actor: Actor, sub: string, input: z.output<typeof ModerationInput>) {
  await requireAdmin(deps, actor);
  await targetUser(deps, actor, sub);
  await deps.db.update({ Key: keys.profile(sub), UpdateExpression: 'SET #s = :s, updatedAt = :now REMOVE suspendedUntil', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'BLOCKED', ':now': deps.now().toISOString() } });
  await deps.directory.setSignInEnabled(sub, false);
  await cutOff(deps, sub);
  await audit(deps, { actorSub: actor.sub, action: 'USER_BLOCKED', targetType: 'USER', targetId: sub, reason: input.reason, outcome: 'SUCCESS' });
}

export async function unblockUser(deps: Deps, actor: Actor, sub: string, input: z.output<typeof ModerationInput>) {
  await requireAdmin(deps, actor);
  await targetUser(deps, actor, sub);
  await deps.db.update({ Key: keys.profile(sub), UpdateExpression: 'SET #s = :s, updatedAt = :now REMOVE suspendedUntil', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'ACTIVE', ':now': deps.now().toISOString() } });
  await deps.directory.setSignInEnabled(sub, true);
  await audit(deps, { actorSub: actor.sub, action: 'USER_UNBLOCKED', targetType: 'USER', targetId: sub, reason: input.reason, outcome: 'SUCCESS' });
}

export async function revokeAdmin(deps: Deps, actor: Actor, sub: string, input: z.output<typeof ModerationInput>) {
  await requireAdmin(deps, actor);
  const admins = await deps.directory.listAdmins();
  if (!admins.includes(sub)) throw notFound('Administrator');
  if (admins.length <= 1) throw conflict('You cannot remove the last platform administrator.');
  await deps.directory.removeAdmin(sub);
  await audit(deps, { actorSub: actor.sub, action: 'ADMIN_REVOKED', targetType: 'USER', targetId: sub, reason: input.reason, outcome: 'SUCCESS' });
}

export async function listCampaigns(deps: Deps, actor: Actor) {
  await requireAdmin(deps, actor);
  const profiles = await allProfiles(deps);
  const byId = new Map(profiles.map((p) => [p.sub, p]));
  const campaigns = await allCampaigns(deps, profiles);
  const out = [];
  for (const c of campaigns) {
    const members = (await deps.db.queryPrefix<CampaignMember>(`CAMP#${c.id}`, 'MEMBER#')).filter((m) => m.status === 'ACTIVE');
    out.push({ id: c.id, title: c.title, ownerSub: c.ownerSub, ownerName: byId.get(c.ownerSub)?.displayName ?? '?', systemId: c.systemId, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt, memberCount: members.length, live: !!c.activeSessionId });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function removeMemberOverride(deps: Deps, actor: Actor, campaignId: string, sub: string, input: z.output<typeof ModerationInput>) {
  await requireAdmin(deps, actor);
  const campaign = await deps.db.get<Campaign>(keys.campaign(campaignId));
  if (!campaign) throw notFound('Campaign');
  if (campaign.ownerSub === sub) throw forbidden('The campaign owner cannot be removed.');
  const m = await deps.db.get<CampaignMember>(keys.member(campaignId, sub));
  if (!m || m.status !== 'ACTIVE') throw notFound('Member');
  await deps.db.update({ Key: keys.member(campaignId, sub), UpdateExpression: 'SET #s = :r, removedAt = :now, removedByAdmin = :t', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':r': 'REMOVED', ':now': deps.now().toISOString(), ':t': true } });
  await rotateLiveEpochs(deps, campaignId, 'member-removed');
  await audit(deps, { actorSub: actor.sub, action: 'MEMBER_REMOVED_BY_ADMIN', targetType: 'CAMPAIGN', targetId: campaignId, campaignId, reason: input.reason, outcome: 'SUCCESS', metadata: { memberSub: sub } });
}

// ---------------------------------------------------------------- reports

export const CreateReportInput = z.object({
  targetType: z.enum(['USER', 'MESSAGE', 'CAMPAIGN']),
  targetId: z.string().min(1).max(64),
  campaignId: Id,
  reason: z.enum(['HARASSMENT', 'SPAM', 'INAPPROPRIATE_CONTENT', 'CHEATING', 'OTHER']),
  details: plainText(2000).default(''),
});

export const ResolveReportInput = z.object({
  disposition: z.enum(['NO_ACTION', 'WARNED', 'CONTENT_REMOVED', 'USER_SUSPENDED', 'USER_BLOCKED']),
  note: plainText(2000).default(''),
});

export type Report = {
  id: string;
  reporterSub: string;
  reporterName: string;
  targetType: 'USER' | 'MESSAGE' | 'CAMPAIGN';
  targetId: string;
  /** For user/message reports: the reported person. */
  subjectSub?: string;
  subjectName?: string;
  campaignId: string;
  campaignTitle: string;
  reason: string;
  details: string;
  /** The reported message as the reporter saw it (only for MESSAGE reports). */
  excerpt?: string;
  status: 'OPEN' | 'RESOLVED';
  disposition?: string;
  resolutionNote?: string;
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
};

export async function createReport(deps: Deps, actor: Actor, input: z.output<typeof CreateReportInput>) {
  await rateLimit(deps, `report:${actor.sub}`, 10, 3600);
  const campaign = await deps.db.get<Campaign>(keys.campaign(input.campaignId));
  const me = campaign ? await deps.db.get<CampaignMember>(keys.member(campaign.id, actor.sub)) : null;
  if (!campaign || me?.status !== 'ACTIVE') throw notFound('Campaign');
  let subjectSub: string | undefined;
  let excerpt: string | undefined;
  if (input.targetType === 'USER') {
    if (!UserSub.safeParse(input.targetId).success) throw invalid('Unknown user.');
    const target = await deps.db.get<CampaignMember>(keys.member(campaign.id, input.targetId));
    if (!target) throw notFound('User');
    subjectSub = input.targetId;
  } else if (input.targetType === 'MESSAGE') {
    const msg = await deps.db.get<ChatMessage>(keys.chat(campaign.id, input.targetId));
    // Reporters can only report messages they were allowed to read.
    if (!msg || !canRead(msg, actor.sub)) throw notFound('Message');
    subjectSub = msg.senderSub;
    excerpt = msg.body.slice(0, 500);
  }
  const subject = subjectSub ? await deps.db.get<Profile>(keys.profile(subjectSub)) : null;
  const report: Report = {
    id: ulid(),
    reporterSub: actor.sub,
    reporterName: actor.displayName,
    targetType: input.targetType,
    targetId: input.targetId,
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    reason: input.reason,
    details: input.details,
    status: 'OPEN',
    createdAt: deps.now().toISOString(),
    ...(subjectSub ? { subjectSub, subjectName: subject?.displayName ?? '?' } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
  };
  await deps.db.put({ PK: 'REPORT', SK: `REPORT#${report.id}`, entity: 'Report', ...report });
  return { id: report.id };
}

export async function listReports(deps: Deps, actor: Actor, status: 'OPEN' | 'RESOLVED' | 'ALL') {
  await requireAdmin(deps, actor);
  const all = await deps.db.queryPrefix<Report>('REPORT', 'REPORT#', { forward: false });
  return status === 'ALL' ? all : all.filter((r) => r.status === status);
}

export async function resolveReport(deps: Deps, actor: Actor, id: string, input: z.output<typeof ResolveReportInput>) {
  await requireAdmin(deps, actor);
  try {
    await deps.db.update({
      Key: { PK: 'REPORT', SK: `REPORT#${id}` },
      UpdateExpression: 'SET #s = :r, disposition = :d, resolutionNote = :n, resolvedBy = :by, resolvedAt = :at',
      ConditionExpression: '#s = :open',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':r': 'RESOLVED', ':open': 'OPEN', ':d': input.disposition, ':n': input.note, ':by': actor.sub, ':at': deps.now().toISOString() },
    });
  } catch {
    throw conflict('That report is not open.');
  }
  await audit(deps, { actorSub: actor.sub, action: 'REPORT_RESOLVED', targetType: 'REPORT', targetId: id, ...(input.note ? { reason: input.note } : {}), outcome: 'SUCCESS', metadata: { disposition: input.disposition } });
}
