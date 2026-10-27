import { useState } from 'react';
import { Gem, X } from 'lucide-react';
import { toast } from 'sonner';
import { useCharacters } from '@/lib/api/hooks';
import { Button, Select } from '@/components/ui/primitives';
import { setTable, useTable } from '../store';
import type { SyncEngine } from '../sync';

/** Shown when a loot pile is selected: lets a player take items into a character's inventory. */
export function LootCard({ engine }: { engine: SyncEngine }) {
  const obj = useTable((s) => (s.selectedId ? s.objects[s.selectedId] : undefined));
  const campaignId = useTable((s) => s.snapshot?.campaign.id ?? '');
  const isGM = useTable((s) => s.snapshot?.viewMode === 'gm');
  const me = useTable((s) => s.snapshot?.me.sub);
  const chars = useCharacters(campaignId, !!obj && obj.objectType === 'LOOT');
  const mine = (chars.data?.characters ?? []).filter((c) => isGM || c.ownerSub === me);
  const [charId, setCharId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  if (!obj || obj.objectType !== 'LOOT') return null;
  const target = charId || mine[0]?.id || '';
  const take = async (entryId: string, quantity: number) => {
    setBusy(entryId);
    try {
      await engine.command('pickupLoot', { objectId: obj.id, entryId, characterId: target, quantity });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="absolute bottom-20 left-3 z-10 w-72 rounded-xl border border-border bg-surface/95 p-3 shadow-xl backdrop-blur" role="dialog" aria-label="Loot">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Gem className="h-4 w-4 text-accent" aria-hidden /> {obj.appearance.label || 'Loot'}
        </h3>
        <button aria-label="Close" className="text-muted hover:text-text" onClick={() => setTable({ selectedId: null })}>
          <X className="h-4 w-4" />
        </button>
      </div>
      {!obj.loot?.length ? (
        <p className="text-xs text-faint">{isGM ? 'Empty. Add contents in GM tools.' : 'Nothing left here.'}</p>
      ) : mine.length === 0 ? (
        <p className="text-xs text-faint">Create a character to pick up items.</p>
      ) : (
        <>
          {mine.length > 1 && (
            <Select aria-label="Character receiving loot" className="mb-2 h-8 text-xs" value={target} onChange={(e) => setCharId(e.target.value)}>
              {mine.map((c) => (
                <option key={c.id} value={c.id}>
                  To {c.name}
                </option>
              ))}
            </Select>
          )}
          <ul className="space-y-1">
            {obj.loot.map((e) => (
              <li key={e.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate" title={e.description}>
                  {e.name} <span className="text-faint">×{e.quantity}</span>
                </span>
                <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" loading={busy === e.id} onClick={() => void take(e.id, 1)}>
                  Take 1
                </Button>
                {e.quantity > 1 && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={!!busy} onClick={() => void take(e.id, e.quantity)}>
                    All
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
