/** GM-owned creature library. Templates are never visible to players. */
import { ulid } from 'ulid';
import type { z } from 'zod';
import { notFound } from '@shared/errors';
import type { CreatureTemplate } from '@shared/model';
import type { CreatureInput } from '@shared/schemas/characters';
import { keys } from '../repo/db';
import { loadCampaign, requireActiveCampaign, requireGM, type Actor, type Deps } from '../context';

async function gm(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  return ctx;
}

export async function listCreatures(deps: Deps, actor: Actor, campaignId: string) {
  await gm(deps, actor, campaignId);
  const all = await deps.db.queryPrefix<CreatureTemplate>(`CAMP#${campaignId}`, 'CREATURE#');
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createCreature(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof CreatureInput>) {
  requireActiveCampaign(await gm(deps, actor, campaignId));
  const now = deps.now().toISOString();
  const t: CreatureTemplate = { id: ulid(), campaignId, ...input, createdAt: now, updatedAt: now };
  await deps.db.put({ ...keys.creature(campaignId, t.id), entity: 'Creature', ...t });
  return t;
}

export async function updateCreature(deps: Deps, actor: Actor, campaignId: string, id: string, input: z.output<typeof CreatureInput>) {
  requireActiveCampaign(await gm(deps, actor, campaignId));
  const t = await deps.db.get<CreatureTemplate>(keys.creature(campaignId, id));
  if (!t) throw notFound('Creature');
  const next: CreatureTemplate = { ...t, ...input, updatedAt: deps.now().toISOString() };
  await deps.db.put({ ...keys.creature(campaignId, id), entity: 'Creature', ...next });
  return next;
}

export async function deleteCreature(deps: Deps, actor: Actor, campaignId: string, id: string) {
  await gm(deps, actor, campaignId);
  await deps.db.delete(keys.creature(campaignId, id));
}

export async function loadCreature(deps: Deps, campaignId: string, id: string) {
  return deps.db.get<CreatureTemplate>(keys.creature(campaignId, id));
}
