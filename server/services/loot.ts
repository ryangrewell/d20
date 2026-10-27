/**
 * Atomic loot pickup. The loot object's revision guards the transaction, so
 * when two players grab the last item at once exactly one succeeds; the other
 * gets a conflict. The inventory write happens in the same transaction.
 */
import { ulid } from 'ulid';
import { conflict, forbidden, invalid, notFound } from '@shared/errors';
import type { InventoryItem, SceneObject } from '@shared/model';
import { keys, type TxItem } from '../repo/db';
import type { Change } from '../realtime/fanout';
import { baseMessage, chatItem, loadObjectFor, objectItem, requirePlayable, type Handler } from './commands';
import { loadCharacter } from './characters';

export const pickupLoot: Handler<'pickupLoot'> = async (ctx, p) => {
  requirePlayable(ctx);
  const { obj, fog } = await loadObjectFor(ctx, p.objectId);
  if (obj.objectType !== 'LOOT' || !obj.loot?.length) throw invalid('There is nothing to pick up there.');
  const entry = obj.loot.find((e) => e.id === p.entryId);
  if (!entry || entry.quantity <= 0) throw conflict('That item is no longer there.');
  if (p.quantity > entry.quantity) throw conflict(`Only ${entry.quantity} left.`);

  const character = await loadCharacter(ctx.deps, obj.campaignId, p.characterId);
  if (!character) throw notFound('Character');
  if (character.ownerSub !== ctx.actor.sub && !ctx.campaign.access.isGM) throw forbidden('You can only pick up items for your own character.');

  const remaining = obj.loot.map((e) => (e.id === entry.id ? { ...e, quantity: e.quantity - p.quantity } : e)).filter((e) => e.quantity > 0);
  const now = ctx.deps.now().toISOString();
  const after: SceneObject | undefined = remaining.length ? { ...obj, loot: remaining, revision: obj.revision + 1, updatedAt: now } : undefined;

  // Stack onto an existing plain item with the same name, otherwise add a new one.
  const items = await ctx.deps.db.queryPrefix<InventoryItem>(`CHAR#${character.id}`, 'ITEM#');
  const stack = items.find((i) => i.name.toLowerCase() === entry.name.toLowerCase() && !i.charges);
  const newItemId = ulid();
  const guard = { ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': obj.revision } };
  const writes: TxItem[] = [
    after ? { Put: { Item: objectItem(after), ...guard } } : { Delete: { Key: keys.object(obj.sceneId, obj.id), ...guard } },
    stack
      ? { Update: { Key: keys.item(character.id, stack.id), UpdateExpression: 'SET quantity = quantity + :q, updatedAt = :now', ExpressionAttributeValues: { ':q': p.quantity, ':now': now } } }
      : {
          Put: {
            Item: {
              ...keys.item(character.id, newItemId),
              entity: 'Item',
              id: newItemId,
              characterId: character.id,
              campaignId: character.campaignId,
              name: entry.name,
              description: entry.description ?? '',
              quantity: p.quantity,
              tags: ['loot'],
              state: 'CARRIED',
              createdAt: now,
              updatedAt: now,
            },
          },
        },
  ];
  const changes: Change[] = [
    { kind: 'object', before: obj, ...(after ? { after } : {}), fog },
    { kind: 'character', characterId: character.id, ownerSub: character.ownerSub },
  ];
  // Announce pickups of publicly visible loot to the table.
  if (obj.visibility === 'VISIBLE_TO_ALL') {
    const msg = baseMessage(ctx, `${character.name} picked up ${p.quantity > 1 ? `${p.quantity} × ` : ''}${entry.name}.`, 'SYSTEM');
    writes.push({ Put: { Item: chatItem(msg) } });
    changes.push({ kind: 'chat', message: msg });
  }
  return { changes, writes, result: { remaining: after?.loot ?? [] } };
};
