import { useState } from 'react';
import { Eye, EyeOff, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { SceneObject } from '@shared/model';
import { Button, Field, Input, Select, cn } from '@/components/ui/primitives';
import { setTable, useTable, type SpawnTemplate } from '../store';
import type { SyncEngine } from '../sync';

const PRESETS: (SpawnTemplate & { name: string })[] = [
  { name: 'Hidden monster', objectType: 'CREATURE', label: 'Goblin', tint: '#b23a48', visibility: 'GM_ONLY' },
  { name: 'Visible monster', objectType: 'CREATURE', label: 'Wolf', tint: '#7a5c3e', visibility: 'VISIBLE_TO_ALL' },
  { name: 'NPC', objectType: 'NPC', label: 'Innkeeper', tint: '#3e6fb0', visibility: 'VISIBLE_TO_ALL' },
  { name: 'Loot', objectType: 'LOOT', label: 'Chest', tint: '#a07b2c', visibility: 'GM_ONLY' },
  { name: 'Map pin', objectType: 'PIN', label: 'Note', tint: '#a86cc1', visibility: 'GM_ONLY' },
];

export function GMPanel({ engine }: { engine: SyncEngine }) {
  const selectedId = useTable((s) => s.selectedId);
  const selected = useTable((s) => (s.selectedId ? (s.objects[s.selectedId] as SceneObject | undefined) : undefined));
  const spawn = useTable((s) => s.spawn);
  const tool = useTable((s) => s.tool);
  const members = useTable((s) => s.snapshot?.members ?? []);
  const players = members.filter((m) => m.role !== 'OWNER');

  return (
    <div className="scrollbar-thin h-full space-y-6 overflow-y-auto p-4">
      {selected ? (
        <Inspector key={`${selectedId}:${selected.revision}`} obj={selected} engine={engine} players={players} />
      ) : (
        <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">Select a token to edit it, or place new ones below.</p>
      )}

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Place on map</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className={cn('rounded-md border px-2 py-1.5 text-left text-xs', spawn.label === p.label && spawn.objectType === p.objectType ? 'border-accent bg-accent/10' : 'border-border hover:bg-surface-2')}
              onClick={() => setTable({ spawn: { ...p }, tool: 'spawn' })}
            >
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: p.tint }} aria-hidden />
              {p.name}
            </button>
          ))}
        </div>
        <Field label="Label" htmlFor="spawnLabel">
          <Input id="spawnLabel" className="h-8" value={spawn.label} maxLength={60} onChange={(e) => setTable({ spawn: { ...spawn, label: e.target.value } })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Type" htmlFor="spawnType">
            <Select id="spawnType" className="h-8 text-xs" value={spawn.objectType} onChange={(e) => setTable({ spawn: { ...spawn, objectType: e.target.value as SpawnTemplate['objectType'] } })}>
              {['CREATURE', 'NPC', 'PC', 'LOOT', 'PROP', 'PIN'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Colour" htmlFor="spawnTint">
            <input id="spawnTint" type="color" className="h-8 w-full rounded-md border border-border bg-surface" value={spawn.tint} onChange={(e) => setTable({ spawn: { ...spawn, tint: e.target.value } })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={spawn.visibility === 'GM_ONLY'} onChange={(e) => setTable({ spawn: { ...spawn, visibility: e.target.checked ? 'GM_ONLY' : 'VISIBLE_TO_ALL' } })} />
          Place hidden from players
        </label>
        {spawn.objectType === 'PC' && (
          <Field label="Controlled by" htmlFor="spawnCtrl">
            <Select id="spawnCtrl" className="h-8 text-xs" value={spawn.assignedControllerSub ?? ''} onChange={(e) => setTable({ spawn: { ...spawn, ...(e.target.value ? { assignedControllerSub: e.target.value } : { assignedControllerSub: undefined }) } })}>
              <option value="">Nobody (GM only)</option>
              {players.map((m) => (
                <option key={m.userSub} value={m.userSub}>
                  {m.displayName}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Button size="sm" variant={tool === 'spawn' ? 'primary' : 'secondary'} className="w-full justify-center" onClick={() => setTable({ tool: tool === 'spawn' ? 'select' : 'spawn' })}>
          {tool === 'spawn' ? 'Click the map to place · Esc to stop' : 'Place on map'}
        </Button>
      </section>
    </div>
  );
}

function Inspector({ obj, engine, players }: { obj: SceneObject; engine: SyncEngine; players: { userSub: string; displayName: string }[] }) {
  const [label, setLabel] = useState(obj.appearance.label ?? '');
  const [notes, setNotes] = useState(obj.gmNotes ?? '');
  const update = (patch: Record<string, unknown>) => engine.command('updateSceneObject', { objectId: obj.id, patch }).catch((e: Error) => toast.error(e.message));
  const hidden = obj.visibility === 'GM_ONLY';
  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Selected · {obj.objectType}</h3>
        <span className="text-[10px] text-faint">rev {obj.revision}</span>
      </div>
      <Field label="Label" htmlFor="objLabel">
        <Input id="objLabel" className="h-8" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== (obj.appearance.label ?? '') && void update({ label })} />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" variant={hidden ? 'primary' : 'secondary'} className="flex-1 justify-center" onClick={() => void update({ visibility: hidden ? 'VISIBLE_TO_ALL' : 'GM_ONLY' })}>
          {hidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
          {hidden ? 'Reveal' : 'Hide'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Remove token"
          onClick={() => {
            void engine.command('removeSceneObject', { objectId: obj.id }).catch((e: Error) => toast.error(e.message));
            setTable({ selectedId: null });
          }}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <Field label="Controlled by" htmlFor="objCtrl">
        <Select id="objCtrl" className="h-8 text-xs" value={obj.assignedControllerSub ?? ''} onChange={(e) => void update({ assignedControllerSub: e.target.value || null })}>
          <option value="">GM only</option>
          {players.map((m) => (
            <option key={m.userSub} value={m.userSub}>
              {m.displayName}
            </option>
          ))}
        </Select>
      </Field>
      {players.length > 0 && (
        <details className="text-xs">
          <summary className="flex cursor-pointer items-center gap-1 text-muted">
            <Users className="h-3 w-3" aria-hidden /> Show only to…
          </summary>
          <div className="mt-2 space-y-1">
            {players.map((m) => {
              const on = obj.visibility === 'SELECTED_PLAYERS' && obj.allowedViewerIds?.includes(m.userSub);
              return (
                <label key={m.userSub} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={!!on}
                    onChange={(e) => {
                      const cur = obj.visibility === 'SELECTED_PLAYERS' ? (obj.allowedViewerIds ?? []) : [];
                      const next = e.target.checked ? [...cur, m.userSub] : cur.filter((s) => s !== m.userSub);
                      void update(next.length ? { visibility: 'SELECTED_PLAYERS', allowedViewerIds: next } : { visibility: 'GM_ONLY', allowedViewerIds: [] });
                    }}
                  />
                  {m.displayName}
                </label>
              );
            })}
          </div>
        </details>
      )}
      <Field label="GM notes (private)" htmlFor="objNotes">
        <textarea
          id="objNotes"
          className="min-h-16 w-full rounded-lg border border-border bg-surface px-2 py-1 text-xs focus:border-accent focus:outline-none"
          value={notes}
          maxLength={4000}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (obj.gmNotes ?? '') && void update({ gmNotes: notes })}
        />
      </Field>
    </section>
  );
}
