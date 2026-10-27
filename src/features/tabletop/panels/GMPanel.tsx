import { useState } from 'react';
import { ArrowRightLeft, Eye, EyeOff, Heart, Plus, Trash2, Users, X, Zap } from 'lucide-react';
import { QuickEncounterDialog } from '@/features/campaigns/QuickEncounterDialog';
import { toast } from 'sonner';
import type { SceneObject } from '@shared/model';
import { Button, Field, Input, Select, cn } from '@/components/ui/primitives';
import { useCampaign, useCharacters, useCreatures, useEncounters } from '@/lib/api/hooks';
import { getAdapter } from '@shared/game-systems/registry';
import { Conditions } from '@/features/characters/CharacterSheet';
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
  const campaignId = useTable((s) => s.snapshot?.campaign.id ?? '');
  const players = members.filter((m) => m.role !== 'OWNER');
  const creatures = useCreatures(campaignId);
  const characters = useCharacters(campaignId);
  const encounters = useEncounters(campaignId);
  const campaign = useCampaign(campaignId);
  const [quick, setQuick] = useState(false);

  return (
    <div className="scrollbar-thin h-full space-y-6 overflow-y-auto p-4">
      {selected ? (
        <Inspector key={`${selectedId}:${selected.revision}`} obj={selected} engine={engine} players={players} />
      ) : (
        <p className="rounded-lg bg-surface-2 p-3 text-xs text-muted">Select a token to edit it, or place new ones below.</p>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Place on map</h3>
          {campaign.data && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setQuick(true)}>
              <Zap className="h-3.5 w-3.5" aria-hidden /> Quick encounter
            </Button>
          )}
        </div>
        {quick && campaign.data && (
          <QuickEncounterDialog
            campaign={campaign.data.campaign}
            isOwner={campaign.data.access.isOwner}
            onClose={() => setQuick(false)}
            onCreated={(enc) => {
              // Straight into placement; hidden until the GM reveals them.
              setTable({ spawn: { objectType: 'CREATURE', label: enc.name, tint: '#b23a48', visibility: 'GM_ONLY', encounterId: enc.id }, tool: 'spawn' });
              toast.success(`Click the map to place ${enc.name}. Players won't see it until you reveal it.`);
            }}
          />
        )}
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
        {(encounters.data?.length ?? 0) > 0 && (
          <Field label="Place an encounter" htmlFor="spawnEncounter" hint="Every creature in the group, around where you click.">
            <Select
              id="spawnEncounter"
              className="h-8 text-xs"
              value={spawn.encounterId ?? ''}
              onChange={(e) => {
                const enc = encounters.data?.find((x) => x.id === e.target.value);
                setTable({ spawn: enc ? { objectType: 'CREATURE', label: enc.name, tint: '#b23a48', visibility: spawn.visibility, encounterId: enc.id } : { ...spawn, encounterId: undefined }, ...(enc ? { tool: 'spawn' as const } : {}) });
              }}
            >
              <option value="">Choose an encounter…</option>
              {encounters.data!.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.groups.reduce((n, g) => n + g.count, 0)})
                </option>
              ))}
            </Select>
          </Field>
        )}
        {(creatures.data?.length ?? 0) > 0 && (
          <Field label="From creature library" htmlFor="spawnTemplate">
            <Select
              id="spawnTemplate"
              className="h-8 text-xs"
              value={spawn.templateId ?? ''}
              onChange={(e) => {
                const t = creatures.data?.find((c) => c.id === e.target.value);
                setTable({ spawn: t ? { objectType: 'CREATURE', label: t.name, tint: t.tint, visibility: spawn.visibility, templateId: t.id } : { ...spawn, templateId: undefined }, ...(t ? { tool: 'spawn' as const } : {}) });
              }}
            >
              <option value="">Choose a creature…</option>
              {creatures.data!.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (HP {c.hpMax})
                </option>
              ))}
            </Select>
          </Field>
        )}
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
        {spawn.objectType === 'PC' && (characters.data?.characters.length ?? 0) > 0 && (
          <Field label="Character sheet" htmlFor="spawnChar" hint="Links the token to the sheet and its player.">
            <Select
              id="spawnChar"
              className="h-8 text-xs"
              value={spawn.characterId ?? ''}
              onChange={(e) => {
                const c = characters.data?.characters.find((x) => x.id === e.target.value);
                setTable({ spawn: c ? { ...spawn, characterId: c.id, label: c.name, assignedControllerSub: c.ownerSub } : { ...spawn, characterId: undefined } });
              }}
            >
              <option value="">None</option>
              {characters.data!.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
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
      <Conditions value={obj.conditions ?? []} options={getAdapter(useTable.getState().snapshot?.campaign.systemId ?? 'generic-d20').conditionDefinitions} editable onChange={(conditions) => void update({ conditions })} />
      {(obj.gmStats?.hp || obj.objectType === 'CREATURE' || obj.objectType === 'NPC') && <HitPoints obj={obj} update={update} />}
      {obj.objectType === 'LOOT' && <LootEditor obj={obj} update={update} />}
      {obj.objectType === 'PIN' && <PortalEditor obj={obj} engine={engine} update={update} />}
      <MoveToScene obj={obj} engine={engine} />
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

function MoveToScene({ obj, engine }: { obj: SceneObject; engine: SyncEngine }) {
  const campaignId = useTable((s) => s.snapshot?.campaign.id ?? '');
  const { data } = useCampaign(campaignId);
  const [busy, setBusy] = useState(false);
  const others = (data?.scenes ?? []).filter((s) => s.id !== obj.sceneId);
  if (!others.length) return null;
  return (
    <Field label="Move to scene" htmlFor="objMove" hint="Keeps the token's controller and look. It lands in the centre of that map.">
      <div className="flex items-center gap-2">
        <ArrowRightLeft className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <Select
          id="objMove"
          className="h-8 text-xs"
          value=""
          disabled={busy}
          onChange={async (e) => {
            const target = others.find((s) => s.id === e.target.value);
            if (!target) return;
            setBusy(true);
            try {
              await engine.command('transferSceneObject', { objectId: obj.id, targetSceneId: target.id });
              setTable({ selectedId: null });
              toast.success(`${obj.appearance.label || 'Token'} moved to ${target.name}`);
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Choose a scene…</option>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

function HitPoints({ obj, update }: { obj: SceneObject; update: (patch: Record<string, unknown>) => unknown }) {
  const hp = obj.gmStats?.hp ?? { current: 10, max: 10 };
  const [amount, setAmount] = useState('5');
  const setHp = (current: number, max = hp.max) => void update({ gmStats: { hp: { current, max } } });
  const n = Math.max(0, Math.round(Number(amount) || 0));
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1 text-xs text-muted">
        <Heart className="h-3 w-3" aria-hidden /> Hit points (GM only){obj.gmStats?.ac !== undefined ? ` · AC ${obj.gmStats.ac}` : ''}
      </p>
      <div className="flex items-center gap-1">
        <Input aria-label="Current HP" type="number" className="h-8 w-16 text-xs" defaultValue={hp.current} onBlur={(e) => Number(e.target.value) !== hp.current && setHp(Number(e.target.value))} />
        <span className="text-faint">/</span>
        <Input aria-label="Max HP" type="number" className="h-8 w-16 text-xs" defaultValue={hp.max} onBlur={(e) => Number(e.target.value) !== hp.max && setHp(hp.current, Math.max(0, Number(e.target.value)))} />
        <Input aria-label="Damage or healing amount" type="number" min={0} className="h-8 w-14 text-xs" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Button size="sm" variant="secondary" className="h-8 px-2 text-xs" onClick={() => setHp(hp.current - n)}>
          Hit
        </Button>
        <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setHp(Math.min(hp.max, hp.current + n))}>
          Heal
        </Button>
      </div>
    </div>
  );
}

function LootEditor({ obj, update }: { obj: SceneObject; update: (patch: Record<string, unknown>) => unknown }) {
  const loot = obj.loot ?? [];
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">Contents (players can pick these up)</p>
      {loot.length === 0 && <p className="text-xs text-faint">Empty.</p>}
      <ul className="space-y-1">
        {loot.map((e) => (
          <li key={e.id} className="flex items-center gap-2 rounded bg-surface-2 px-2 py-1 text-xs">
            <span className="flex-1 truncate">{e.name}</span>
            <span className="tabular-nums">×{e.quantity}</span>
            <button aria-label={`Remove ${e.name}`} className="text-faint hover:text-text" onClick={() => void update({ loot: loot.filter((x) => x.id !== e.id) })}>
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!name.trim()) return;
          void update({ loot: [...loot, { id: crypto.randomUUID().slice(0, 8), name: name.trim(), quantity: Math.max(1, Math.round(Number(qty) || 1)) }] });
          setName('');
          setQty('1');
        }}
      >
        <Input aria-label="Loot item name" placeholder="Add item…" className="h-8 text-xs" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="Loot item quantity" type="number" min={1} className="h-8 w-14 text-xs" value={qty} onChange={(e) => setQty(e.target.value)} />
        <Button size="icon" variant="secondary" className="h-8 w-8" type="submit" aria-label="Add loot item">
          <Plus className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

function PortalEditor({ obj, engine, update }: { obj: SceneObject; engine: SyncEngine; update: (patch: Record<string, unknown>) => unknown }) {
  const campaignId = useTable((s) => s.snapshot?.campaign.id ?? '');
  const { data } = useCampaign(campaignId);
  const scenes = (data?.scenes ?? []).filter((s) => s.id !== obj.sceneId);
  const target = obj.portal?.targetSceneId;
  return (
    <div className="space-y-1.5">
      <Field label="Links to scene" htmlFor="objPortal" hint="Doorways and stairs: jump the table to another scene.">
        <Select id="objPortal" className="h-8 text-xs" value={target ?? ''} onChange={(e) => void update({ portal: e.target.value ? { targetSceneId: e.target.value } : null })}>
          <option value="">Not a link</option>
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      {target && (
        <Button size="sm" className="w-full justify-center" onClick={() => void engine.command('switchActiveScene', { sceneId: target }).catch((e: Error) => toast.error(e.message))}>
          Go there with everyone
        </Button>
      )}
    </div>
  );
}
