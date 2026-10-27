/**
 * Campaign journal and handouts. Entries are GM-authored; players can read
 * entries shared with everyone or with them specifically. Sharing notifies
 * only the readers on the live session.
 */
import { ulid } from 'ulid';
import type { z } from 'zod';
import { invalid, notFound } from '@shared/errors';
import type { CampaignMember, GameSession, JournalEntry } from '@shared/model';
import type { JournalInput } from '@shared/schemas/characters';
import { keys } from '../repo/db';
import { loadCampaign, requireActiveCampaign, requireGM, type Actor, type Deps } from '../context';
import { commit } from './commit';

export function canRead(e: JournalEntry, sub: string, isGM: boolean): boolean {
  if (isGM) return true;
  if (e.visibility === 'ALL') return true;
  return e.visibility === 'SELECTED_PLAYERS' && !!e.allowedViewerIds?.includes(sub);
}

function readers(e: JournalEntry): 'ALL' | 'GM_ONLY' | string[] {
  return e.visibility === 'ALL' ? 'ALL' : e.visibility === 'GM_ONLY' ? 'GM_ONLY' : (e.allowedViewerIds ?? []);
}

/** Strip the selected-player list for non-GM readers. */
function forViewer(e: JournalEntry, isGM: boolean): JournalEntry {
  if (isGM) return e;
  const { allowedViewerIds: _a, ...rest } = e;
  return rest;
}

async function notify(deps: Deps, actor: Actor, campaignId: string, entry: JournalEntry, before: JournalEntry | null) {
  const campaign = await deps.db.get<{ activeSessionId?: string }>(keys.campaign(campaignId));
  if (!campaign?.activeSessionId) return;
  const session = await deps.db.get<GameSession>(keys.session(campaign.activeSessionId));
  if (!session || session.status === 'ENDED') return;
  const wasReadable = (sub: string) => !!before && canRead(before, sub, false);
  const r = readers(entry);
  // "Newly shared" when at least the shared audience could not read it before.
  const newlyShared = r === 'ALL' ? !before || before.visibility !== 'ALL' : Array.isArray(r) ? r.some((s) => !wasReadable(s)) : false;
  await commit(deps, session, actor, [{ kind: 'journal', entryId: entry.id, title: entry.title, readers: r, newlyShared }], []).catch((e) =>
    deps.log('warn', 'journal notify failed', { message: (e as Error).message }),
  );
}

async function validateViewers(deps: Deps, campaignId: string, input: z.output<typeof JournalInput>) {
  if (input.visibility !== 'SELECTED_PLAYERS') return undefined;
  const ids = [...new Set(input.allowedViewerIds ?? [])];
  if (!ids.length) throw invalid('Choose at least one player to share with.');
  const members = await deps.db.batchGet<CampaignMember>(ids.map((s) => keys.member(campaignId, s)));
  if (members.filter((m) => m.status === 'ACTIVE').length !== ids.length) throw invalid('You can only share with members of this campaign.');
  return ids;
}

export async function listJournal(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  const all = await deps.db.queryPrefix<JournalEntry>(`CAMP#${campaignId}`, 'JOURNAL#');
  return all
    .filter((e) => canRead(e, actor.sub, ctx.access.isGM))
    .map((e) => forViewer(e, ctx.access.isGM))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createJournal(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof JournalInput>) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  requireActiveCampaign(ctx);
  const allowedViewerIds = await validateViewers(deps, campaignId, input);
  const now = deps.now().toISOString();
  const entry: JournalEntry = { id: ulid(), campaignId, title: input.title, body: input.body, visibility: input.visibility, ...(allowedViewerIds ? { allowedViewerIds } : {}), createdBy: actor.sub, createdAt: now, updatedAt: now };
  await deps.db.put({ ...keys.journal(campaignId, entry.id), entity: 'Journal', ...entry });
  await notify(deps, actor, campaignId, entry, null);
  return entry;
}

export async function updateJournal(deps: Deps, actor: Actor, campaignId: string, id: string, input: z.output<typeof JournalInput>) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  requireActiveCampaign(ctx);
  const before = await deps.db.get<JournalEntry>(keys.journal(campaignId, id));
  if (!before) throw notFound('Journal entry');
  const allowedViewerIds = await validateViewers(deps, campaignId, input);
  const next: JournalEntry = { ...before, title: input.title, body: input.body, visibility: input.visibility, updatedAt: deps.now().toISOString() };
  if (allowedViewerIds) next.allowedViewerIds = allowedViewerIds;
  else delete next.allowedViewerIds;
  await deps.db.put({ ...keys.journal(campaignId, id), entity: 'Journal', ...next });
  await notify(deps, actor, campaignId, next, before);
  return next;
}

export async function deleteJournal(deps: Deps, actor: Actor, campaignId: string, id: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  await deps.db.delete(keys.journal(campaignId, id));
}
