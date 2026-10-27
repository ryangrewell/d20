import { useState } from 'react';
import { ChevronLeft, ChevronRight, Dices, EyeOff, Plus, Swords, X } from 'lucide-react';
import { toast } from 'sonner';
import type { InitiativeState } from '@shared/model';
import { Button, cn } from '@/components/ui/primitives';
import { getTable, useTable } from '../store';
import type { SyncEngine } from '../sync';

const run = (p: Promise<unknown>) => p.catch((e: Error) => toast.error(e.message));

/** Turn-order strip over the map. Players see only revealed combatants. */
export function InitiativeTracker({ engine }: { engine: SyncEngine }) {
  const init = useTable((s) => s.snapshot?.session.initiative) as InitiativeState | undefined;
  const isGM = useTable((s) => s.snapshot?.viewMode === 'gm');
  const me = useTable((s) => s.snapshot?.me.sub);
  const objects = useTable((s) => s.objects);
  const selectedId = useTable((s) => s.selectedId);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('10');

  const myTokens = Object.values(objects).filter((o) => o.assignedControllerSub === me);
  const active = init?.active && init.entries.length > 0;
  const current = init?.entries.find((e) => e.id === init.currentId);
  const myTurn = !!current?.objectId && objects[current.objectId]?.assignedControllerSub === me;

  const rollFor = (ids: string[]) => ids.length && run(engine.command('rollInitiative', { objectIds: ids.slice(0, 50) }));
  const combatants = () => Object.values(getTable().objects).filter((o) => ['PC', 'NPC', 'CREATURE'].includes(o.objectType)).map((o) => o.id);

  if (!active) {
    if (isGM)
      return (
        <div className="absolute left-3 top-3 z-10 flex gap-1 rounded-lg border border-border bg-surface/90 p-1 backdrop-blur">
          <Button size="sm" variant="ghost" onClick={() => void rollFor(combatants())} title="Roll initiative for every creature, NPC and PC token on this map">
            <Swords className="h-4 w-4" aria-hidden /> Start combat
          </Button>
        </div>
      );
    return null;
  }

  return (
    <div className="absolute left-3 right-48 top-3 z-10 flex items-center gap-2 overflow-hidden" aria-label="Initiative order">
      <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface/95 p-1 backdrop-blur">
        <span className="px-2 text-xs font-semibold text-accent">Round {init!.round}</span>
        {isGM && (
          <>
            <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Previous turn" onClick={() => void run(engine.command('advanceTurn', { direction: 'prev' }))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Next turn" onClick={() => void run(engine.command('advanceTurn', { direction: 'next' }))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </>
        )}
        {!isGM && myTurn && (
          <Button size="sm" className="h-7" onClick={() => void run(engine.command('advanceTurn', { direction: 'next' }))}>
            End my turn
          </Button>
        )}
      </div>
      <ol className="scrollbar-thin flex min-w-0 gap-1 overflow-x-auto">
        {init!.entries.map((e) => (
          <li
            key={e.id}
            aria-current={e.id === init!.currentId ? 'step' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs backdrop-blur',
              e.id === init!.currentId ? 'border-accent bg-accent/20 text-text' : 'border-border bg-surface/90 text-muted',
            )}
          >
            <span className="font-display text-sm font-bold tabular-nums">{e.value}</span>
            <span className="max-w-28 truncate">{e.label}</span>
            {e.hidden && <EyeOff className="h-3 w-3 text-faint" aria-label="Hidden from players" />}
            {isGM && (
              <button aria-label={`Remove ${e.label}`} className="text-faint hover:text-text" onClick={() => void run(engine.command('removeInitiativeEntry', { entryId: e.id }))}>
                <X className="h-3 w-3" />
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface/95 p-1 backdrop-blur">
        {!isGM && myTokens.length > 0 && (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => void rollFor(myTokens.map((o) => o.id))}>
            <Dices className="h-4 w-4" aria-hidden /> Roll mine
          </Button>
        )}
        {isGM && (
          <>
            <Button size="sm" variant="ghost" className="h-7" disabled={!selectedId} title="Add the selected token" onClick={() => selectedId && void rollFor([selectedId])}>
              <Dices className="h-4 w-4" aria-hidden /> Selected
            </Button>
            {adding ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (!label.trim()) return;
                  void run(engine.command('setInitiativeEntry', { label: label.trim(), value: Math.round(Number(value) || 0), hidden: false }));
                  setLabel('');
                  setAdding(false);
                }}
              >
                <input aria-label="Combatant name" autoFocus placeholder="Name" value={label} onChange={(ev) => setLabel(ev.target.value)} className="h-7 w-24 rounded border border-border bg-surface px-1.5 text-xs" />
                <input aria-label="Initiative value" type="number" value={value} onChange={(ev) => setValue(ev.target.value)} className="h-7 w-12 rounded border border-border bg-surface px-1.5 text-xs" />
                <Button size="sm" className="h-7" type="submit">
                  Add
                </Button>
              </form>
            ) : (
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Add a combatant manually" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" />
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7" onClick={() => confirm('End combat and clear the initiative order?') && void run(engine.command('endCombat', {}))}>
              End
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
