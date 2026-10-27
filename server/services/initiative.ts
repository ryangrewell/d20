/**
 * Initiative / turn tracker, stored on the session. Rolls happen on the
 * server. Entries for hidden tokens are marked hidden and stripped for
 * players. A version counter guards concurrent edits.
 */
import { randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import { conflict, forbidden, notFound } from '@shared/errors';
import { getAdapter } from '@shared/game-systems/registry';
import type { InitiativeEntry, InitiativeState } from '@shared/model';
import { keys, type TxItem } from '../repo/db';
import { findObjectScene, loadObjectFor, requireGM, requirePlayable, type Handler, type HandlerCtx, type HandlerOutput } from './commands';
import { loadCharacter } from './characters';

type Versioned = InitiativeState & { version?: number };

const EMPTY: Versioned = { active: false, round: 0, entries: [], version: 0 };

function current(ctx: HandlerCtx): Versioned {
  return (ctx.session.initiative as Versioned | undefined) ?? EMPTY;
}

function sorted(entries: InitiativeEntry[]): InitiativeEntry[] {
  return [...entries].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Persist + broadcast a new tracker state, guarded by the previous version. */
function save(ctx: HandlerCtx, prev: Versioned, next: InitiativeState, extra: Partial<HandlerOutput> = {}): HandlerOutput {
  const version = (prev.version ?? 0) + 1;
  const stored: Versioned = { ...next, version };
  const write: TxItem = {
    Update: {
      Key: keys.session(ctx.session.id),
      UpdateExpression: 'SET initiative = :next',
      ConditionExpression: 'attribute_not_exists(initiative) OR initiative.version = :v',
      ExpressionAttributeValues: { ':next': stored, ':v': prev.version ?? 0 },
    },
  };
  const { version: _v, ...publicState } = stored;
  return { changes: [{ kind: 'initiative', state: publicState }], writes: [write], ...extra };
}

export const initiativeHandlers: {
  rollInitiative: Handler<'rollInitiative'>;
  setInitiativeEntry: Handler<'setInitiativeEntry'>;
  removeInitiativeEntry: Handler<'removeInitiativeEntry'>;
  advanceTurn: Handler<'advanceTurn'>;
  endCombat: Handler<'endCombat'>;
} = {
  async rollInitiative(ctx, p) {
    requirePlayable(ctx);
    const prev = current(ctx);
    const entries = [...prev.entries];
    const rolls: { label: string; total: number; mod: number }[] = [];
    for (const objectId of new Set(p.objectIds)) {
      const sceneId = ctx.campaign.access.isGM ? await findObjectScene(ctx, objectId) : undefined;
      const { obj } = await loadObjectFor(ctx, objectId, sceneId);
      if (!ctx.campaign.access.isGM && obj.assignedControllerSub !== ctx.actor.sub) throw forbidden('You can only roll initiative for your own token.');
      let mod = obj.gmStats?.initiativeMod ?? 0;
      if (obj.characterId) {
        const c = await loadCharacter(ctx.deps, obj.campaignId, obj.characterId);
        if (c) mod = getAdapter(c.systemId).initiativeModifier(c.sheet);
      }
      const total = randomInt(20) + 1 + mod;
      const label = obj.appearance.label || 'Token';
      rolls.push({ label, total, mod });
      const hidden = obj.visibility !== 'VISIBLE_TO_ALL';
      const existing = entries.findIndex((e) => e.objectId === obj.id);
      const entry: InitiativeEntry = { id: existing >= 0 ? entries[existing]!.id : ulid(), label, value: total, objectId: obj.id, hidden, ...(obj.characterId ? { characterId: obj.characterId } : {}) };
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
    }
    const ordered = sorted(entries);
    const next: InitiativeState = { active: true, round: prev.round || 1, entries: ordered, ...(prev.currentId && ordered.some((e) => e.id === prev.currentId) ? { currentId: prev.currentId } : ordered[0] ? { currentId: ordered[0].id } : {}) };
    return save(ctx, prev, next, { result: { rolls } });
  },

  async setInitiativeEntry(ctx, p) {
    requireGM(ctx);
    const prev = current(ctx);
    const entries = [...prev.entries];
    const idx = p.entryId ? entries.findIndex((e) => e.id === p.entryId) : -1;
    if (p.entryId && idx < 0) throw notFound('Combatant');
    const entry: InitiativeEntry = { ...(idx >= 0 ? entries[idx]! : { id: ulid() }), label: p.label, value: p.value, hidden: p.hidden };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    const ordered = sorted(entries);
    return save(ctx, prev, { active: true, round: prev.round || 1, entries: ordered, currentId: prev.currentId ?? ordered[0]!.id });
  },

  async removeInitiativeEntry(ctx, p) {
    requireGM(ctx);
    const prev = current(ctx);
    const idx = prev.entries.findIndex((e) => e.id === p.entryId);
    if (idx < 0) throw notFound('Combatant');
    const entries = prev.entries.filter((e) => e.id !== p.entryId);
    let currentId = prev.currentId;
    if (currentId === p.entryId) currentId = entries.length ? entries[idx % entries.length]!.id : undefined;
    return save(ctx, prev, { active: entries.length > 0 && prev.active, round: prev.round, entries, ...(currentId ? { currentId } : {}) });
  },

  async advanceTurn(ctx, p) {
    requirePlayable(ctx);
    const prev = current(ctx);
    if (!prev.active || !prev.entries.length) throw conflict('Combat has not started.');
    const idx = Math.max(0, prev.entries.findIndex((e) => e.id === prev.currentId));
    const cur = prev.entries[idx]!;
    if (!ctx.campaign.access.isGM) {
      // A player may end their own turn, nothing else.
      const sceneId = cur.objectId ? await findObjectScene(ctx, cur.objectId) : undefined;
      const owned = cur.objectId && sceneId ? (await loadObjectFor(ctx, cur.objectId, sceneId).catch(() => null))?.obj.assignedControllerSub === ctx.actor.sub : false;
      if (p.direction !== 'next' || !owned) throw forbidden('Only the GM can change turns, or you can end your own turn.');
    }
    const n = prev.entries.length;
    const step = p.direction === 'next' ? 1 : -1;
    const nextIdx = (idx + step + n) % n;
    let round = prev.round || 1;
    if (step === 1 && nextIdx === 0) round += 1;
    if (step === -1 && idx === 0) round = Math.max(1, round - 1);
    return save(ctx, prev, { ...prev, round, currentId: prev.entries[nextIdx]!.id });
  },

  async endCombat(ctx) {
    requireGM(ctx);
    const prev = current(ctx);
    return save(ctx, prev, { active: false, round: 0, entries: [] });
  },
};
