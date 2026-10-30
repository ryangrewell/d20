/** GM-only encounter templates: named groups of creature-library entries placed together. */
import { ulid } from 'ulid';
import type { z } from 'zod';
import { invalid, notFound } from '@shared/errors';
import type { CreatureTemplate, EncounterTemplate, MapDefinition, Scene, SceneObject } from '@shared/model';
import type { EncounterInput, QuickEncounterInput } from '@shared/schemas/characters';
import { MAX_QUICK_ENEMIES } from '@shared/quickEncounter';
import { keys, type TxItem } from '../repo/db';
import { loadCampaign, requireActiveCampaign, requireGM, type Actor, type Deps } from '../context';
import type { Change } from '../realtime/fanout';
import { objectItem, requireGM as requireGMCommand, requirePlayable, type Handler } from './commands';
import { loadFog, loadSceneObjects } from './sessions';
import { requireImage } from './images';

const MAX_SPAWN = 30;

async function gm(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  return ctx;
}

async function validateGroups(deps: Deps, campaignId: string, groups: EncounterTemplate['groups']) {
  const total = groups.reduce((n, g) => n + g.count, 0);
  if (total > MAX_SPAWN) throw invalid(`An encounter can place at most ${MAX_SPAWN} creatures.`);
  const found = await deps.db.batchGet<CreatureTemplate>([...new Set(groups.map((g) => g.creatureId))].map((id) => keys.creature(campaignId, id)));
  if (found.length !== new Set(groups.map((g) => g.creatureId)).size) throw invalid('One of those creatures is no longer in the library.');
}

export async function listEncounters(deps: Deps, actor: Actor, campaignId: string) {
  await gm(deps, actor, campaignId);
  return (await deps.db.queryPrefix<EncounterTemplate>(`CAMP#${campaignId}`, 'ENCOUNTER#')).sort((a, b) => a.name.localeCompare(b.name));
}

export async function createEncounter(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof EncounterInput>) {
  requireActiveCampaign(await gm(deps, actor, campaignId));
  await validateGroups(deps, campaignId, input.groups);
  const now = deps.now().toISOString();
  const e: EncounterTemplate = { id: ulid(), campaignId, ...input, createdAt: now, updatedAt: now };
  await deps.db.put({ ...keys.encounter(campaignId, e.id), entity: 'Encounter', ...e });
  return e;
}

/** Saves Quick Encounter's new creatures and the encounter together, so a failure leaves nothing half-made. */
export async function createQuickEncounter(deps: Deps, actor: Actor, campaignId: string, input: z.output<typeof QuickEncounterInput>) {
  requireActiveCampaign(await gm(deps, actor, campaignId));
  if (input.groups.reduce((n, g) => n + g.count, 0) > MAX_QUICK_ENEMIES) throw invalid(`Quick encounters have at most ${MAX_QUICK_ENEMIES} enemies.`);
  const reused = input.groups.flatMap((g) => ('creatureId' in g ? [{ creatureId: g.creatureId, count: g.count }] : []));
  if (reused.length) await validateGroups(deps, campaignId, reused);
  const now = deps.now().toISOString();
  const created: CreatureTemplate[] = [];
  for (const g of input.groups) if ('creature' in g && g.creature.imageAssetId) await requireImage(deps, campaignId, g.creature.imageAssetId);
  const groups = input.groups.map((g) => {
    if ('creatureId' in g) return { creatureId: g.creatureId, count: g.count };
    const { imageAssetId, sprite, ...stats } = g.creature;
    const t: CreatureTemplate = { id: ulid(), campaignId, ...stats, ...(imageAssetId ? { imageAssetId } : {}), ...(sprite ? { sprite } : {}), createdAt: now, updatedAt: now };
    created.push(t);
    return { creatureId: t.id, count: g.count };
  });
  const encounter: EncounterTemplate = { id: ulid(), campaignId, name: input.name, notes: '', groups, createdAt: now, updatedAt: now };
  await deps.db.transact([
    ...created.map((t): TxItem => ({ Put: { Item: { ...keys.creature(campaignId, t.id), entity: 'Creature', ...t } } })),
    { Put: { Item: { ...keys.encounter(campaignId, encounter.id), entity: 'Encounter', ...encounter } } },
  ]);
  return { encounter, creatures: created };
}

export async function updateEncounter(deps: Deps, actor: Actor, campaignId: string, id: string, input: z.output<typeof EncounterInput>) {
  requireActiveCampaign(await gm(deps, actor, campaignId));
  const e = await deps.db.get<EncounterTemplate>(keys.encounter(campaignId, id));
  if (!e) throw notFound('Encounter');
  await validateGroups(deps, campaignId, input.groups);
  const next: EncounterTemplate = { ...e, ...input, updatedAt: deps.now().toISOString() };
  await deps.db.put({ ...keys.encounter(campaignId, id), entity: 'Encounter', ...next });
  return next;
}

export async function deleteEncounter(deps: Deps, actor: Actor, campaignId: string, id: string) {
  await gm(deps, actor, campaignId);
  await deps.db.delete(keys.encounter(campaignId, id));
}

/** Places every creature in a compact grid around the click, each a full copy of its library entry. */
export const spawnEncounter: Handler<'spawnEncounter'> = async (ctx, p) => {
  requireGMCommand(ctx);
  requirePlayable(ctx);
  const { deps } = ctx;
  const campaignId = ctx.session.campaignId;
  const encounter = await deps.db.get<EncounterTemplate>(keys.encounter(campaignId, p.encounterId));
  if (!encounter) throw notFound('Encounter');
  const scene = await deps.db.get<Scene>(keys.scene(p.sceneId));
  if (!scene || scene.campaignId !== campaignId) throw notFound('Scene');
  const templates = new Map(
    (await deps.db.batchGet<CreatureTemplate>([...new Set(encounter.groups.map((g) => g.creatureId))].map((id) => keys.creature(campaignId, id)))).map((t) => [t.id, t]),
  );
  const list = encounter.groups.flatMap((g) => (templates.has(g.creatureId) ? Array.from({ length: g.count }, (_, i) => ({ t: templates.get(g.creatureId)!, n: g.count > 1 ? i + 1 : 0 })) : []));
  if (!list.length) throw invalid('None of this encounter’s creatures are in the library any more.');
  const existing = await loadSceneObjects(deps, scene.id);
  if (existing.length + list.length > 500) throw invalid('This scene is too full for that encounter.');

  const map = await deps.db.get<MapDefinition>(keys.map(campaignId, scene.mapId));
  const ppm = map?.calibration?.pixelsPerMeter;
  const spacing = ppm ? (map!.grid.type !== 'none' ? map!.grid.intervalMeters : 1.524) * ppm * 1.1 : map ? Math.max(map.widthPx, map.heightPx) / 25 : 50;
  const cols = Math.ceil(Math.sqrt(list.length));
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max);
  const { fog } = await loadFog(deps, scene);
  const now = deps.now().toISOString();
  let z = existing.reduce((m, o) => Math.max(m, o.zIndex), 0);

  const objects: SceneObject[] = list.map(({ t, n }, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = p.x + (col - (cols - 1) / 2) * spacing;
    const y = p.y + (row - (Math.ceil(list.length / cols) - 1) / 2) * spacing;
    return {
      id: ulid(),
      sceneId: scene.id,
      campaignId,
      objectType: 'CREATURE',
      x: map ? clamp(x, map.widthPx) : x,
      y: map ? clamp(y, map.heightPx) : y,
      rotationRadians: 0,
      zIndex: ++z,
      visibility: p.visibility,
      appearance: { label: n ? `${t.name} ${n}` : t.name, tint: t.tint, ...(t.imageAssetId ? { imageAssetId: t.imageAssetId } : {}) },
      revision: 1,
      createdAt: now,
      updatedAt: now,
      ...(t.sizeMeters ? { sizeMeters: t.sizeMeters } : {}),
      ...(t.notes ? { gmNotes: t.notes } : {}),
      gmStats: { hp: { current: t.hpMax, max: t.hpMax }, ...(t.ac !== undefined ? { ac: t.ac } : {}), initiativeMod: t.initiativeMod, templateId: t.id },
    };
  });
  const changes: Change[] = objects.map((o) => ({ kind: 'object', after: o, fog }));
  const writes: TxItem[] = objects.map((o) => ({ Put: { Item: objectItem(o), ConditionExpression: 'attribute_not_exists(PK)' } }));
  return { changes, writes, result: { objectIds: objects.map((o) => o.id) } };
};
