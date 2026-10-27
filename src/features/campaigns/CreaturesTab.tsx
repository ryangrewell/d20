import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Skull, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import type { CreatureTemplate } from '@shared/model';
import { creatureApi, qk, useCreatures } from '@/lib/api/hooks';
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
                <span className="h-3 w-3 rounded-full" style={{ background: t.tint }} aria-hidden />
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
