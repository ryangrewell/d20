import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useCharacters } from '@/lib/api/hooks';
import { Select, Spinner } from '@/components/ui/primitives';
import { CharacterSheet } from '@/features/characters/CharacterSheet';
import { useTable } from '../store';
import type { SyncEngine } from '../sync';

/** The player's sheet beside the map; attack/damage dice roll straight into chat. */
export function CharacterPanel({ engine }: { engine: SyncEngine }) {
  const campaignId = useTable((s) => s.snapshot?.campaign.id ?? '');
  const isGM = useTable((s) => s.snapshot?.viewMode === 'gm');
  const members = useTable((s) => s.snapshot?.members ?? []);
  const { data, isLoading } = useCharacters(campaignId);
  const [selected, setSelected] = useState('');
  if (isLoading) return <div className="p-4"><Spinner /></div>;
  const list = data?.characters ?? [];
  if (!list.length)
    return (
      <p className="p-4 text-sm text-muted">
        No characters yet.{' '}
        <Link to={`/campaigns/${campaignId}`} className="text-accent underline" target="_blank">
          Create one
        </Link>{' '}
        on the campaign page.
      </p>
    );
  const id = list.some((c) => c.id === selected) ? selected : list[0]!.id;
  const nameOf = (sub: string) => members.find((m) => m.userSub === sub)?.displayName;
  return (
    <div className="scrollbar-thin h-full space-y-3 overflow-y-auto p-3">
      {list.length > 1 && (
        <Select aria-label="Character" className="h-8 text-xs" value={id} onChange={(e) => setSelected(e.target.value)}>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {isGM && nameOf(c.ownerSub) ? ` · ${nameOf(c.ownerSub)}` : ''}
            </option>
          ))}
        </Select>
      )}
      <CharacterSheet
        key={id}
        campaignId={campaignId}
        characterId={id}
        compact
        isGM={isGM}
        onRoll={(expression, label) => void engine.command('rollDice', { expression, label, visibility: 'PUBLIC' }).catch((e: Error) => toast.error(e.message))}
      />
    </div>
  );
}
