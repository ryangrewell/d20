/**
 * Characters and inventory. A sheet is readable and editable by its owner and
 * the GM only; other players see a name. GM edits to someone else's sheet are
 * audited. Changes notify the campaign's live session so open tables refresh.
 */
import { ulid } from 'ulid';
import type { z } from 'zod';
import { AppError, conflict, forbidden, invalid, notFound } from '@shared/errors';
import { getAdapter } from '@shared/game-systems/registry';
import type { CampaignMember, Character, GameSession, InventoryItem } from '@shared/model';
import type { CreateCharacterInput, ImportCharacterInput, ItemInput, UpdateCharacterInput } from '@shared/schemas/characters';
import { isConditionalFailure, keys, type TxItem } from '../repo/db';
import { loadCampaign, requireActiveCampaign, type Actor, type CampaignContext, type Deps } from '../context';
import { commit } from './commit';

const MAX_CHARACTERS_PER_OWNER = 20;
const MAX_ITEMS = 500;

export type CharacterSummary = { id: string; name: string; ownerSub: string };

function charItem(c: Character) {
  return { ...keys.character(c.campaignId, c.id), entity: 'Character', ...c };
}
function itemItem(i: InventoryItem) {
  return { ...keys.item(i.characterId, i.id), entity: 'Item', ...i };
}

/** GM, or a delegated GM allowed to edit characters. */
function canEditAny(ctx: CampaignContext) {
  return ctx.access.isOwner || (ctx.access.isGM && !!ctx.access.delegation?.permissions.characters);
}
function canReadAny(ctx: CampaignContext) {
  return ctx.access.isGM;
}

function forViewer(c: Character, gm: boolean): Character {
  if (gm) return c;
  const { gmNotes: _g, ...rest } = c;
  return rest;
}
function itemForViewer(i: InventoryItem, gm: boolean): InventoryItem {
  if (gm) return i;
  const { gmNote: _g, ...rest } = i;
  return rest;
}

export async function loadCharacter(deps: Deps, campaignId: string, id: string): Promise<Character | null> {
  return deps.db.get<Character>(keys.character(campaignId, id));
}

async function requireReadable(deps: Deps, actor: Actor, campaignId: string, id: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  const c = await loadCharacter(deps, campaignId, id);
  // Not-found for other players' sheets: they may not even confirm a sheet exists by id.
  if (!c || (c.ownerSub !== actor.sub && !canReadAny(ctx))) throw notFound('Character');
  return { ctx, c };
}

async function requireEditable(deps: Deps, actor: Actor, campaignId: string, id: string) {
  const r = await requireReadable(deps, actor, campaignId, id);
  if (r.c.ownerSub !== actor.sub && !canEditAny(r.ctx)) throw forbidden('Only the owner or the GM can edit this character.');
  requireActiveCampaign(r.ctx);
  return r;
}

/** Publish an id-only CHARACTER_UPDATED to the owner and GM on the live session, if any. */
export async function notifyCharacter(deps: Deps, actor: Actor, campaignId: string, c: Pick<Character, 'id' | 'ownerSub'>) {
  const campaign = await deps.db.get<{ activeSessionId?: string }>(keys.campaign(campaignId));
  if (!campaign?.activeSessionId) return;
  const session = await deps.db.get<GameSession>(keys.session(campaign.activeSessionId));
  if (!session || session.status === 'ENDED') return;
  await commit(deps, session, actor, [{ kind: 'character', characterId: c.id, ownerSub: c.ownerSub }], []).catch((e) =>
    deps.log('warn', 'character notify failed', { message: (e as Error).message }),
  );
}

export async function listCharacters(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  const all = await deps.db.queryPrefix<Character>(`CAMP#${campaignId}`, 'CHAR#');
  const gm = canReadAny(ctx);
  const mine = all.filter((c) => gm || c.ownerSub === actor.sub).map((c) => forViewer(c, gm));
  const others: CharacterSummary[] = gm ? [] : all.filter((c) => c.ownerSub !== actor.sub).map((c) => ({ id: c.id, name: c.name, ownerSub: c.ownerSub }));
  return { characters: mine, others, system: { id: ctx.campaign.systemId, version: ctx.campaign.systemVersion } };
}

export async function getCharacter(deps: Deps, actor: Actor, campaignId: string, id: string) {
  const { ctx, c } = await requireReadable(deps, actor, campaignId, id);
  const gm = canReadAny(ctx);
  const items = await deps.db.queryPrefix<InventoryItem>(`CHAR#${id}`, 'ITEM#');
  const adapter = getAdapter(c.systemId);
  return { character: forViewer(c, gm), items: items.map((i) => itemForViewer(i, gm)), derived: adapter.deriveDisplayStats(c.sheet), canEdit: c.ownerSub === actor.sub || canEditAny(ctx) };
}

async function resolveOwner(deps: Deps, actor: Actor, ctx: CampaignContext, requested?: string): Promise<string> {
  const ownerSub = requested && requested !== actor.sub ? requested : actor.sub;
  if (ownerSub !== actor.sub) {
    if (!canEditAny(ctx)) throw forbidden('Only the GM can create characters for other players.');
    const m = await deps.db.get<CampaignMember>(keys.member(ctx.campaign.id, ownerSub));
    if (!m || m.status !== 'ACTIVE') throw invalid('That player is not a member of this campaign.');
  }
  if (ctx.access.member?.role === 'SPECTATOR' && ownerSub === actor.sub && !ctx.access.isGM) throw forbidden('Spectators cannot create characters.');
  const existing = await deps.db.queryPrefix<Character>(`CAMP#${ctx.campaign.id}`, 'CHAR#');
  if (existing.filter((c) => c.ownerSub === ownerSub).length >= MAX_CHARACTERS_PER_OWNER) throw invalid(`A player can have at most ${MAX_CHARACTERS_PER_OWNER} characters per campaign.`);
  return ownerSub;
}

function validateSheet(systemId: string, sheet: unknown) {
  const r = getAdapter(systemId).validateCharacter(sheet);
  if (!r.ok) throw invalid(r.errors[0] ? `${r.errors[0].path || 'Sheet'}: ${r.errors[0].message}` : 'Invalid character sheet.', { issues: r.errors });
  return r.sheet;
}

export async function createCharacter(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof CreateCharacterInput>) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireActiveCampaign(ctx);
  const ownerSub = await resolveOwner(deps, actor, ctx, input.ownerSub);
  const adapter = getAdapter(ctx.campaign.systemId);
  const now = deps.now().toISOString();
  const c: Character = {
    id: ulid(),
    campaignId,
    ownerSub,
    name: input.name,
    systemId: adapter.id,
    systemVersion: adapter.version,
    sheet: validateSheet(adapter.id, { ...adapter.defaultSheet(), ...(input.sheet ?? {}) }),
    conditions: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  await deps.db.put(charItem(c), { expr: 'attribute_not_exists(PK)' });
  await notifyCharacter(deps, actor, campaignId, c);
  return c;
}

export async function updateCharacter(deps: Deps, actor: Actor, campaignId: string, id: string, input: z.output<typeof UpdateCharacterInput>) {
  const { ctx, c } = await requireEditable(deps, actor, campaignId, id);
  if (input.expectedRevision !== c.revision) throw conflict('This character was changed elsewhere. Reload to see the latest version.', { revision: c.revision });
  const gmOnly = canEditAny(ctx);
  if (input.gmNotes !== undefined && !gmOnly) throw forbidden('Only the GM can edit GM notes.');
  if (input.ownerSub !== undefined && input.ownerSub !== c.ownerSub) {
    if (!gmOnly) throw forbidden('Only the GM can reassign a character.');
    const m = await deps.db.get<CampaignMember>(keys.member(campaignId, input.ownerSub));
    if (!m || m.status !== 'ACTIVE') throw invalid('That player is not a member of this campaign.');
  }
  const adapter = getAdapter(c.systemId);
  const migrated = c.systemVersion === adapter.version ? c.sheet : adapter.migrate(c.systemVersion, c.sheet);
  const next: Character = {
    ...c,
    ...(input.name ? { name: input.name } : {}),
    ...(input.conditions ? { conditions: [...new Set(input.conditions)] } : {}),
    ...(input.ownerSub ? { ownerSub: input.ownerSub } : {}),
    ...(input.gmNotes !== undefined ? { gmNotes: input.gmNotes } : {}),
    sheet: input.sheet ? validateSheet(c.systemId, input.sheet) : migrated,
    systemVersion: adapter.version,
    revision: c.revision + 1,
    updatedAt: deps.now().toISOString(),
  };
  const writes: TxItem[] = [{ Put: { Item: charItem(next), ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': c.revision } } }];
  if (actor.sub !== c.ownerSub) {
    // Audit trail for GM edits to a player's sheet.
    const fields = (['name', 'sheet', 'conditions', 'ownerSub', 'gmNotes'] as const).filter((k) => input[k] !== undefined);
    writes.push({ Put: { Item: { ...keys.characterAudit(c.id, ulid()), entity: 'CharacterAudit', characterId: c.id, actorSub: actor.sub, fields, at: next.updatedAt } } });
  }
  try {
    await deps.db.transact(writes);
  } catch (err) {
    if (isConditionalFailure(err)) throw conflict('This character was changed elsewhere. Reload to see the latest version.');
    throw err;
  }
  await notifyCharacter(deps, actor, campaignId, next);
  if (input.ownerSub && input.ownerSub !== c.ownerSub) await notifyCharacter(deps, actor, campaignId, c);
  return forViewer(next, canReadAny(ctx));
}

export async function deleteCharacter(deps: Deps, actor: Actor, campaignId: string, id: string) {
  const { c } = await requireEditable(deps, actor, campaignId, id);
  const items = await deps.db.queryPrefix<InventoryItem>(`CHAR#${id}`, 'ITEM#');
  for (const i of items) await deps.db.delete(keys.item(id, i.id));
  await deps.db.delete(keys.character(campaignId, id));
  await notifyCharacter(deps, actor, campaignId, c);
}

// --------------------------------------------------------------- inventory

export async function addItem(deps: Deps, actor: Actor, campaignId: string, characterId: string, input: z.output<typeof ItemInput>) {
  const { ctx, c } = await requireEditable(deps, actor, campaignId, characterId);
  if (input.gmNote !== undefined && !canEditAny(ctx)) throw forbidden('Only the GM can add GM notes to items.');
  const count = (await deps.db.queryPrefix<InventoryItem>(`CHAR#${characterId}`, 'ITEM#')).length;
  if (count >= MAX_ITEMS) throw invalid(`A character can carry at most ${MAX_ITEMS} item entries.`);
  const now = deps.now().toISOString();
  const item: InventoryItem = { id: ulid(), characterId, campaignId, ...input, createdAt: now, updatedAt: now };
  await deps.db.put(itemItem(item));
  await notifyCharacter(deps, actor, campaignId, c);
  return itemForViewer(item, canReadAny(ctx));
}

export async function updateItem(deps: Deps, actor: Actor, campaignId: string, characterId: string, itemId: string, input: Partial<z.output<typeof ItemInput>>) {
  const { ctx, c } = await requireEditable(deps, actor, campaignId, characterId);
  if (input.gmNote !== undefined && !canEditAny(ctx)) throw forbidden('Only the GM can edit GM notes on items.');
  const item = await deps.db.get<InventoryItem>(keys.item(characterId, itemId));
  if (!item) throw notFound('Item');
  const next: InventoryItem = { ...item, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)), updatedAt: deps.now().toISOString() };
  await deps.db.put(itemItem(next));
  await notifyCharacter(deps, actor, campaignId, c);
  return itemForViewer(next, canReadAny(ctx));
}

export async function deleteItem(deps: Deps, actor: Actor, campaignId: string, characterId: string, itemId: string) {
  const { c } = await requireEditable(deps, actor, campaignId, characterId);
  await deps.db.delete(keys.item(characterId, itemId));
  await notifyCharacter(deps, actor, campaignId, c);
}

// ----------------------------------------------------------- import/export

export async function exportCharacter(deps: Deps, actor: Actor, campaignId: string, id: string) {
  const { c } = await requireReadable(deps, actor, campaignId, id);
  const items = await deps.db.queryPrefix<InventoryItem>(`CHAR#${id}`, 'ITEM#');
  return {
    format: 'd20.character' as const,
    version: 1 as const,
    name: c.name,
    systemId: c.systemId,
    systemVersion: c.systemVersion,
    sheet: c.sheet,
    conditions: c.conditions,
    items: items.map(({ name, description, quantity, weight, tags, charges, state }) => ({ name, description, quantity, weight, tags, charges, state })),
  };
}

export async function importCharacter(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof ImportCharacterInput>) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  if (input.data.systemId !== ctx.campaign.systemId) throw new AppError('INVALID_INPUT', `That character was made for ${input.data.systemId}; this campaign uses ${ctx.campaign.systemId}.`);
  const created = await createCharacter(deps, actor, campaignId, { name: input.data.name, ...(input.ownerSub ? { ownerSub: input.ownerSub } : {}), sheet: input.data.sheet });
  const now = deps.now().toISOString();
  for (const it of input.data.items) {
    const item: InventoryItem = { id: ulid(), characterId: created.id, campaignId, ...it, createdAt: now, updatedAt: now };
    await deps.db.put(itemItem(item));
  }
  if (input.data.conditions.length) {
    await deps.db.update({ Key: keys.character(campaignId, created.id), UpdateExpression: 'SET conditions = :c', ExpressionAttributeValues: { ':c': input.data.conditions } });
  }
  return created;
}
