import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Skull, Trash2, Zap } from 'lucide-react';
import { QuickEncounterDialog } from './QuickEncounterDialog';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import type { CreatureTemplate, EncounterTemplate, SpriteSource } from '@shared/model';
import { Picture } from '@/features/sprites/Picture';
import { SpriteBuilder } from '@/features/sprites/SpriteBuilder';
import { creatureApi, encounterApi, qk, useCreatures, useEncounters } from '@/lib/api/hooks';
import { Button, Card, EmptyState, ErrorNotice, Field, Input, Spinner, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';

export function CreaturesTab({ data }: { data: CampaignDashboardDto }) {
  const cid = data.campaign.id;
  const list = useCreatures(cid);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CreatureTemplate | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Reusable monsters and NPCs. Place them from the table's GM tools; their stats stay hidden from players.</p>
        <Button onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" aria-hidden /> New creature
        </Button>
      </div>
      {list.isLoading && <Spinner />}
      {list.error && <ErrorNotice error={list.error} />}
      {list.data?.length === 0 && (
        <EmptyState icon={<Skull className="h-8 w-8" />} title="Your bestiary is empty">
          Add a creature once (name, HP, AC, initiative, notes) and spawn copies of it during play.
        </EmptyState>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.map((t) => (
          <Card key={t.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {t.imageAssetId ? <Picture campaignId={cid} assetId={t.imageAssetId} className="h-10 w-10" alt="" /> : <span className="h-3 w-3 rounded-full" style={{ background: t.tint }} aria-hidden />}
                <h3 className="font-semibold">{t.name}</h3>
              </div>
              <div className="flex">
                <Button size="icon" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${t.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete ${t.name} from the library? Creatures already on maps are unaffected.`)) return;
                    await creatureApi.remove(cid, t.id).catch((e: Error) => toast.error(e.message));
                    void qc.invalidateQueries({ queryKey: qk.creatures(cid) });
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="mt-1 text-xs text-muted">
              HP {t.hpMax} · AC {t.ac ?? '—'} · Init {t.initiativeMod >= 0 ? `+${t.initiativeMod}` : t.initiativeMod}
            </p>
            {t.notes && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-faint">{t.notes}</p>}
          </Card>
        ))}
      </div>
      {editing && <CreatureDialog campaignId={cid} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <EncountersSection data={data} />
    </div>
  );
}

function CreatureDialog({ campaignId, template, onClose }: { campaignId: string; template: CreatureTemplate | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: template?.name ?? '',
    tint: template?.tint ?? '#b23a48',
    hpMax: String(template?.hpMax ?? 10),
    ac: template?.ac !== undefined ? String(template.ac) : '',
    initiativeMod: String(template?.initiativeMod ?? 0),
    sizeFt: template?.sizeMeters ? String(Math.round((template.sizeMeters / 0.3048) * 10) / 10) : '',
    notes: template?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [picture, setPicture] = useState<{ imageAssetId?: string; sprite?: SpriteSource }>({ ...(template?.imageAssetId ? { imageAssetId: template.imageAssetId } : {}), ...(template?.sprite ? { sprite: template.sprite } : {}) });
  const [picking, setPicking] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    const input = {
      name: form.name.trim(),
      tint: form.tint,
      hpMax: Math.max(1, Math.round(Number(form.hpMax) || 1)),
      initiativeMod: Math.round(Number(form.initiativeMod) || 0),
      notes: form.notes,
      ...(form.ac !== '' ? { ac: Math.round(Number(form.ac)) } : {}),
      ...(form.sizeFt !== '' && Number(form.sizeFt) > 0 ? { sizeMeters: Number(form.sizeFt) * 0.3048 } : {}),
      ...(picture.imageAssetId ? { imageAssetId: picture.imageAssetId, ...(picture.sprite ? { sprite: picture.sprite } : {}) } : template?.imageAssetId ? { imageAssetId: null, sprite: null } : {}),
    };
    try {
      if (template) await creatureApi.update(campaignId, template.id, input);
      else await creatureApi.create(campaignId, input);
      void qc.invalidateQueries({ queryKey: qk.creatures(campaignId) });
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={template ? `Edit ${template.name}` : 'New creature'} wide>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-3 sm:col-span-2">
          <Picture campaignId={campaignId} assetId={picture.imageAssetId} className="h-16 w-16" alt="" />
          <Button type="button" size="sm" variant="outline" onClick={() => setPicking(true)}>
            {picture.imageAssetId ? 'Change picture' : 'Add picture'}
          </Button>
          {picture.imageAssetId && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setPicture({})}>
              Remove
            </Button>
          )}
          {picking && <SpriteBuilder campaignId={campaignId} initial={picture.sprite} title="Creature picture" onClose={() => setPicking(false)} onSaved={(imageAssetId, sprite) => setPicture({ imageAssetId, sprite })} />}
        </div>
        <Field label="Name" htmlFor="crName">
          <Input id="crName" autoFocus value={form.name} maxLength={60} onChange={set('name')} />
        </Field>
        <Field label="Token colour" htmlFor="crTint">
          <input id="crTint" type="color" className="h-10 w-full rounded-lg border border-border bg-surface" value={form.tint} onChange={set('tint')} />
        </Field>
        <Field label="Max HP" htmlFor="crHp">
          <Input id="crHp" type="number" min={1} value={form.hpMax} onChange={set('hpMax')} />
        </Field>
        <Field label="Armour class" htmlFor="crAc">
          <Input id="crAc" type="number" min={0} value={form.ac} onChange={set('ac')} />
        </Field>
        <Field label="Initiative modifier" htmlFor="crInit">
          <Input id="crInit" type="number" value={form.initiativeMod} onChange={set('initiativeMod')} />
        </Field>
        <Field label="Size (ft, optional)" htmlFor="crSize" hint="Defaults to one grid square.">
          <Input id="crSize" type="number" min={0} step="any" value={form.sizeFt} onChange={set('sizeFt')} />
        </Field>
        <Field label="Notes / stat block (GM only)" htmlFor="crNotes" className="sm:col-span-2">
          <Textarea id="crNotes" value={form.notes} onChange={set('notes')} />
        </Field>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!form.name.trim()} loading={busy}>
            Save creature
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function EncountersSection({ data }: { data: CampaignDashboardDto }) {
  const campaignId = data.campaign.id;
  const [quick, setQuick] = useState(false);
  const encounters = useEncounters(campaignId);
  const creatures = useCreatures(campaignId);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EncounterTemplate | 'new' | null>(null);
  const nameOf = (id: string) => creatures.data?.find((c) => c.id === id)?.name ?? 'Missing creature';
  return (
    <section className="space-y-3 pt-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">Encounters</h2>
          <p className="text-sm text-muted">Groups of library creatures you can drop onto the map in one click, hidden until you reveal them.</p>
        </div>
        <div className="flex gap-2">
          {data.campaign.status === 'ACTIVE' && (
            <Button onClick={() => setQuick(true)}>
              <Zap className="h-4 w-4" aria-hidden /> Quick encounter
            </Button>
          )}
          <Button variant="outline" disabled={!creatures.data?.length} onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden /> New encounter
          </Button>
        </div>
      </div>
      {quick && <QuickEncounterDialog campaign={data.campaign} isOwner={data.access.isOwner} onClose={() => setQuick(false)} onCreated={(e) => toast.success(`${e.name} saved. Place it from the table's GM tools.`)} />}
      {encounters.data?.length === 0 && <p className="text-sm text-faint">{creatures.data?.length ? 'No encounters yet.' : 'Use Quick encounter to make one in a few clicks, or add creatures and group them yourself.'}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {encounters.data?.map((e) => (
          <Card key={e.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold">{e.name}</h3>
              <div className="flex">
                <Button size="icon" variant="ghost" aria-label={`Edit ${e.name}`} onClick={() => setEditing(e)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${e.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete the ${e.name} encounter?`)) return;
                    await encounterApi.remove(campaignId, e.id).catch((err: Error) => toast.error(err.message));
                    void qc.invalidateQueries({ queryKey: qk.encounters(campaignId) });
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="mt-1 text-xs text-muted">{e.groups.map((g) => `${g.count} × ${nameOf(g.creatureId)}`).join(', ')}</p>
            {e.notes && <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-faint">{e.notes}</p>}
          </Card>
        ))}
      </div>
      {editing && creatures.data && <EncounterDialog campaignId={campaignId} encounter={editing === 'new' ? null : editing} creatures={creatures.data} onClose={() => setEditing(null)} />}
    </section>
  );
}

function EncounterDialog({ campaignId, encounter, creatures, onClose }: { campaignId: string; encounter: EncounterTemplate | null; creatures: CreatureTemplate[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(encounter?.name ?? '');
  const [notes, setNotes] = useState(encounter?.notes ?? '');
  const [groups, setGroups] = useState(encounter?.groups ?? [{ creatureId: creatures[0]!.id, count: 1 }]);
  const [busy, setBusy] = useState(false);
  const total = groups.reduce((n, g) => n + g.count, 0);
  const save = async () => {
    setBusy(true);
    try {
      const input = { name: name.trim(), notes, groups };
      if (encounter) await encounterApi.update(campaignId, encounter.id, input);
      else await encounterApi.create(campaignId, input);
      void qc.invalidateQueries({ queryKey: qk.encounters(campaignId) });
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={encounter ? `Edit ${encounter.name}` : 'New encounter'} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="encName">
          <Input id="encName" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-medium">Creatures ({total}/30)</p>
          {groups.map((g, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input aria-label="Count" type="number" min={1} max={30} className="w-20" value={g.count} onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, count: Math.max(1, Math.round(Number(e.target.value) || 1)) } : x)))} />
              <span className="text-muted">×</span>
              <select aria-label="Creature" className="h-10 flex-1 rounded-lg border border-border bg-surface px-3 text-sm" value={g.creatureId} onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, creatureId: e.target.value } : x)))}>
                {creatures.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Button type="button" size="icon" variant="ghost" aria-label="Remove group" disabled={groups.length === 1} onClick={() => setGroups(groups.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => setGroups([...groups, { creatureId: creatures[0]!.id, count: 1 }])}>
            <Plus className="h-4 w-4" aria-hidden /> Add creature
          </Button>
        </div>
        <Field label="GM notes" htmlFor="encNotes">
          <Textarea id="encNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || total > 30} loading={busy}>
            Save encounter
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
