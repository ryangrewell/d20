/**
 * Generic character sheet. Renders whatever sections the campaign's
 * game-system adapter declares, so new systems need no new UI code.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dices, Download, Minus, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { getAdapter } from '@shared/game-systems/registry';
import type { FieldDef, ListItemField } from '@shared/game-systems/core';
import type { InventoryItem, ItemState, SpriteSource } from '@shared/model';
import { Picture } from '@/features/sprites/Picture';
import { SpriteBuilder } from '@/features/sprites/SpriteBuilder';
import { ApiError } from '@/lib/api/client';
import { characterApi, qk, useCharacter, type CharacterDetail } from '@/lib/api/hooks';
import { Badge, Button, ErrorNotice, Input, Select, Spinner, Textarea, cn } from '@/components/ui/primitives';

type Draft = { name: string; sheet: Record<string, unknown>; conditions: string[]; gmNotes: string };

export type RollFn = (expression: string, label: string) => void;

export function CharacterSheet({
  campaignId,
  characterId,
  compact = false,
  isGM = false,
  members = [],
  onRoll,
}: {
  campaignId: string;
  characterId: string;
  compact?: boolean;
  isGM?: boolean;
  members?: { userSub: string; displayName: string }[];
  onRoll?: RollFn;
}) {
  const { data, isLoading, error, refetch } = useCharacter(campaignId, characterId);
  if (isLoading) return <Spinner label="Loading character" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;
  if (!data) return null;
  return <SheetEditor key={data.character.id} campaignId={campaignId} detail={data} compact={compact} isGM={isGM} members={members} {...(onRoll ? { onRoll } : {})} />;
}

function SheetEditor({ campaignId, detail, compact, isGM, members, onRoll }: { campaignId: string; detail: CharacterDetail; compact: boolean; isGM: boolean; members: { userSub: string; displayName: string }[]; onRoll?: RollFn }) {
  const qc = useQueryClient();
  const c = detail.character;
  const adapter = getAdapter(c.systemId);
  const fromServer = (): Draft => ({ name: c.name, sheet: structuredClone(c.sheet), conditions: [...c.conditions], gmNotes: c.gmNotes ?? '' });
  const [draft, setDraft] = useState<Draft>(fromServer);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const editable = detail.canEdit;

  const setPicture = async (imageAssetId: string, sprite: SpriteSource) => {
    await characterApi.update(campaignId, c.id, { expectedRevision: c.revision, imageAssetId, sprite });
    await qc.invalidateQueries({ queryKey: qk.character(campaignId, c.id) });
    void qc.invalidateQueries({ queryKey: qk.characters(campaignId) });
    toast.success('Picture updated');
  };

  // Adopt server changes (e.g. the GM edited, or loot arrived) unless the user is mid-edit.
  useEffect(() => {
    if (!dirty) setDraft(fromServer());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.revision]);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const setField = (key: string, value: unknown) => set({ sheet: { ...draft.sheet, [key]: value } });

  const save = async () => {
    setSaving(true);
    try {
      await characterApi.update(campaignId, c.id, {
        expectedRevision: c.revision,
        name: draft.name,
        sheet: draft.sheet,
        conditions: draft.conditions,
        ...(isGM && draft.gmNotes !== (c.gmNotes ?? '') ? { gmNotes: draft.gmNotes } : {}),
      });
      setDirty(false);
      await qc.invalidateQueries({ queryKey: qk.character(campaignId, c.id) });
      void qc.invalidateQueries({ queryKey: qk.characters(campaignId) });
      toast.success('Character saved');
    } catch (e) {
      toast.error((e as Error).message);
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        setDirty(false);
        void qc.invalidateQueries({ queryKey: qk.character(campaignId, c.id) });
      }
    } finally {
      setSaving(false);
    }
  };

  const derived = detail.derived;
  const hp = draft.sheet.hp as { current: number; max: number } | undefined;

  return (
    <div className={cn('space-y-5', compact && 'text-sm')}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="shrink-0 rounded-lg focus-visible:outline-2 disabled:cursor-default"
          aria-label={editable ? 'Change picture' : 'Character picture'}
          title={editable ? 'Change picture' : undefined}
          disabled={!editable}
          onClick={() => setPicking(true)}
        >
          <Picture campaignId={campaignId} assetId={c.imageAssetId} className={compact ? 'h-12 w-12' : 'h-20 w-20'} alt={c.name} />
        </button>
        {picking && <SpriteBuilder campaignId={campaignId} initial={c.sprite} title={`Picture for ${c.name}`} onClose={() => setPicking(false)} onSaved={setPicture} />}
        <Input aria-label="Character name" value={draft.name} disabled={!editable} onChange={(e) => set({ name: e.target.value })} className={cn('min-w-0 flex-1 font-display font-semibold', compact ? 'h-9' : 'h-11 text-lg')} />
        {editable && (
          <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={saving}>
            <Save className="h-4 w-4" aria-hidden /> {dirty ? 'Save' : 'Saved'}
          </Button>
        )}
      </div>

      {compact && hp && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="HP" value={`${hp.current}/${hp.max}`} />
          <Stat label="AC" value={String(draft.sheet.ac ?? '—')} />
          <Stat label="Init" value={fmtMod(Number(derived.initiativeMod ?? 0))} />
        </div>
      )}

      <Conditions value={draft.conditions} options={adapter.conditionDefinitions} editable={editable} onChange={(conditions) => set({ conditions })} />

      {adapter.sections.map((section) => (
        <section key={section.id}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{section.title}</h3>
          <div className={cn(section.layout === 'grid' ? (compact ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-2 gap-3 sm:grid-cols-3') : 'space-y-2')}>
            {section.fields.map((f) => (
              <FieldInput key={f.key} field={f} value={draft.sheet[f.key]} derivedMod={derived[`${f.key}Mod`]} editable={editable} onChange={(v) => setField(f.key, v)} {...(onRoll ? { onRoll } : {})} />
            ))}
          </div>
        </section>
      ))}

      <Inventory campaignId={campaignId} characterId={c.id} items={detail.items} editable={editable} isGM={isGM} />

      {isGM && (
        <section className="space-y-2 rounded-lg border border-accent/30 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-accent">GM only</h3>
          {members.length > 0 && (
            <label className="flex items-center gap-2 text-xs">
              Owner
              <Select
                className="h-8 text-xs"
                value={c.ownerSub}
                onChange={async (e) => {
                  try {
                    await characterApi.update(campaignId, c.id, { expectedRevision: c.revision, ownerSub: e.target.value });
                    void qc.invalidateQueries({ queryKey: qk.character(campaignId, c.id) });
                    void qc.invalidateQueries({ queryKey: qk.characters(campaignId) });
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
              >
                {members.map((m) => (
                  <option key={m.userSub} value={m.userSub}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <Textarea aria-label="GM notes" placeholder="Private notes about this character" value={draft.gmNotes} onChange={(e) => set({ gmNotes: e.target.value })} className="min-h-16 text-xs" />
        </section>
      )}

      {!compact && (
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            const data = await characterApi.export(campaignId, c.id);
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${c.name.replace(/[^\w-]+/g, '_') || 'character'}.d20.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="h-4 w-4" aria-hidden /> Export as JSON
        </Button>
      )}
    </div>
  );
}

const fmtMod = (n: number) => (n >= 0 ? `+${n}` : String(n));

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-faint">{label}</div>
      <div className="font-display text-lg font-bold">{value}</div>
    </div>
  );
}

function FieldInput({ field, value, derivedMod, editable, onChange, onRoll }: { field: FieldDef; value: unknown; derivedMod: unknown; editable: boolean; onChange: (v: unknown) => void; onRoll?: RollFn }) {
  const id = `f-${field.key}`;
  const label = (
    <label htmlFor={id} className="mb-1 block text-xs text-muted" title={field.hint}>
      {field.label}
    </label>
  );
  switch (field.kind) {
    case 'number':
      return (
        <div>
          {label}
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="number"
              className="h-9"
              disabled={!editable}
              value={typeof value === 'number' ? value : ''}
              min={field.min}
              max={field.max}
              onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            />
            {typeof derivedMod === 'number' && <Badge tone="accent">{fmtMod(derivedMod)}</Badge>}
          </div>
        </div>
      );
    case 'text':
      return (
        <div>
          {label}
          <Input id={id} className="h-9" disabled={!editable} value={typeof value === 'string' ? value : ''} maxLength={field.max ?? 200} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'textarea':
      return (
        <div className="col-span-full">
          {label}
          <Textarea id={id} disabled={!editable} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'resource': {
      const v = (value as { current: number; max: number } | undefined) ?? { current: 0, max: 0 };
      return (
        <div>
          {label}
          <div className="flex items-center gap-1">
            <Button size="icon" variant="secondary" className="h-9 w-8" disabled={!editable} aria-label={`Decrease ${field.label}`} onClick={() => onChange({ ...v, current: v.current - 1 })}>
              <Minus className="h-3 w-3" />
            </Button>
            <Input id={id} type="number" className="h-9 text-center" disabled={!editable} value={v.current} onChange={(e) => onChange({ ...v, current: Number(e.target.value) })} aria-label={`${field.label} current`} />
            <span className="text-faint">/</span>
            <Input type="number" className="h-9 text-center" disabled={!editable} value={v.max} onChange={(e) => onChange({ ...v, max: Math.max(0, Number(e.target.value)) })} aria-label={`${field.label} max`} />
            <Button size="icon" variant="secondary" className="h-9 w-8" disabled={!editable} aria-label={`Increase ${field.label}`} onClick={() => onChange({ ...v, current: v.current + 1 })}>
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>
      );
    }
    case 'list':
      return <ListField field={field} value={Array.isArray(value) ? (value as Record<string, unknown>[]) : []} editable={editable} onChange={onChange} {...(onRoll ? { onRoll } : {})} />;
  }
}

function ListField({ field, value, editable, onChange, onRoll }: { field: Extract<FieldDef, { kind: 'list' }>; value: Record<string, unknown>[]; editable: boolean; onChange: (v: unknown) => void; onRoll?: RollFn }) {
  const update = (i: number, key: string, v: unknown) => onChange(value.map((row, j) => (j === i ? { ...row, [key]: v } : row)));
  const cell = (row: Record<string, unknown>, f: ListItemField, i: number) => {
    const v = row[f.key];
    const nameLabel = String(row.name ?? row.label ?? field.label);
    return (
      <div key={f.key} className="flex min-w-0 items-center gap-1">
        <Input
          aria-label={`${f.label} (${nameLabel})`}
          placeholder={f.label}
          className="h-8 min-w-0 text-xs"
          type={f.kind === 'number' ? 'number' : 'text'}
          disabled={!editable}
          value={v === undefined || v === null ? '' : String(v)}
          onChange={(e) => update(i, f.key, f.kind === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
        />
        {f.kind === 'dice' && onRoll && typeof v === 'string' && v.trim() && (
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={`Roll ${f.label} for ${nameLabel}`} title={`Roll ${v}`} onClick={() => onRoll(v, `${nameLabel} ${f.label.toLowerCase()}`)}>
            <Dices className="h-4 w-4 text-accent" />
          </Button>
        )}
      </div>
    );
  };
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-faint">{field.label}</p>
      {value.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div className="grid min-w-0 flex-1 gap-1.5" style={{ gridTemplateColumns: `repeat(${field.itemFields.length}, minmax(0, 1fr))` }}>
            {field.itemFields.map((f) => cell(row, f, i))}
          </div>
          {editable && (
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Remove row" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ))}
      {editable && value.length < (field.maxItems ?? 50) && (
        <Button size="sm" variant="ghost" onClick={() => onChange([...value, {}])}>
          <Plus className="h-4 w-4" aria-hidden /> Add
        </Button>
      )}
    </div>
  );
}

export function Conditions({ value, options, editable, onChange }: { value: string[]; options: string[]; editable: boolean; onChange: (v: string[]) => void }) {
  const remaining = useMemo(() => options.filter((o) => !value.includes(o)), [options, value]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Conditions</span>
      {value.length === 0 && <span className="text-xs text-faint">None</span>}
      {value.map((cond) => (
        <Badge key={cond} tone="info" className="gap-1">
          {cond}
          {editable && (
            <button aria-label={`Remove ${cond}`} onClick={() => onChange(value.filter((v) => v !== cond))}>
              <X className="h-3 w-3" />
            </button>
          )}
        </Badge>
      ))}
      {editable && remaining.length > 0 && (
        <select
          aria-label="Add condition"
          className="h-6 rounded border border-border bg-surface px-1 text-xs"
          value=""
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
        >
          <option value="">+ Add</option>
          {remaining.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function Inventory({ campaignId, characterId, items, editable, isGM }: { campaignId: string; characterId: string; items: InventoryItem[]; editable: boolean; isGM: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const refresh = () => qc.invalidateQueries({ queryKey: qk.character(campaignId, characterId) });
  const run = async (p: Promise<unknown>) => {
    try {
      await p;
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const sorted = [...items].sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Inventory</h3>
      {sorted.length === 0 && <p className="text-xs text-faint">Nothing carried yet.</p>}
      <ul className="space-y-1">
        {sorted.map((i) => (
          // Names wrap instead of truncating; in narrow panels the controls drop to their own line.
          <li key={i.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-2 px-2 py-1.5 text-xs">
            <div className="min-w-[9rem] flex-1">
              <span className="break-words font-medium">{i.name}</span>
              {i.tags.includes('loot') && <span className="ml-1 text-faint">· loot</span>}
              {isGM && i.gmNote && <span className="ml-1 text-accent">· GM note</span>}
              {i.description && <p className="line-clamp-2 break-words text-faint">{i.description}</p>}
            </div>
            {editable ? (
              <div className="ml-auto flex items-center gap-1">
                <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`Use one ${i.name}`} onClick={() => void run(characterApi.updateItem(campaignId, characterId, i.id, { quantity: Math.max(0, i.quantity - 1) }))}>
                  <Minus className="h-3 w-3" />
                </Button>
                <span className="w-6 text-center tabular-nums">{i.quantity}</span>
                <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`Add one ${i.name}`} onClick={() => void run(characterApi.updateItem(campaignId, characterId, i.id, { quantity: i.quantity + 1 }))}>
                  <Plus className="h-3 w-3" />
                </Button>
                <select
                  aria-label={`${i.name} state`}
                  className="h-6 rounded border border-border bg-surface px-1"
                  value={i.state}
                  onChange={(e) => void run(characterApi.updateItem(campaignId, characterId, i.id, { state: e.target.value as ItemState }))}
                >
                  <option value="EQUIPPED">Equipped</option>
                  <option value="CARRIED">Carried</option>
                  <option value="STASHED">Stashed</option>
                </select>
                <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`Remove ${i.name}`} onClick={() => void run(characterApi.removeItem(campaignId, characterId, i.id))}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <span className="tabular-nums">×{i.quantity}</span>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void run(characterApi.addItem(campaignId, characterId, { name: name.trim(), quantity: Math.max(0, Number(qty) || 1) }));
            setName('');
            setQty('1');
          }}
        >
          <Input aria-label="New item name" placeholder={isGM ? 'Grant an item…' : 'Add an item…'} className="h-8 text-xs" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="New item quantity" type="number" min={0} className="h-8 w-16 text-xs" value={qty} onChange={(e) => setQty(e.target.value)} />
          <Button size="sm" type="submit" variant="secondary" disabled={!name.trim()}>
            Add
          </Button>
        </form>
      )}
    </section>
  );
}
