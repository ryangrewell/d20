import type { ChatMessage } from '@shared/model';
import type { Deps } from '../context';

export function canRead(m: ChatMessage, sub: string): boolean {
  return m.scope === 'TABLE' || !!m.recipientSubs?.includes(sub);
}

/**
 * Recent messages the caller may read, oldest first. Whispers are filtered by
 * recipient list server-side; GMs do not see whispers they are not party to.
 */
export async function visibleMessages(deps: Deps, campaignId: string, sub: string, _isGM: boolean, limit = 60, before?: string) {
  const out: ChatMessage[] = [];
  let cursor = before;
  for (let page = 0; page < 5 && out.length < limit; page++) {
    const rows = await deps.db.query<ChatMessage>(
      {
        KeyConditionExpression: cursor ? 'PK = :pk AND SK < :sk' : 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CHAT#${campaignId}`, ':sk': cursor ? `MSG#${cursor}` : 'MSG#' },
        ScanIndexForward: false,
        Limit: 100,
      },
      { all: false, limit: 100 },
    );
    if (!rows.length) break;
    for (const m of rows) if (canRead(m, sub) && out.length < limit) out.push(m);
    cursor = rows.at(-1)!.id;
    if (rows.length < 100) break;
  }
  return out.reverse();
}
