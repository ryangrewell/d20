import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Campaign, EncounterTemplate, EnemyBaseline } from '@shared/model';
import {
  DIFFICULTIES,
  DIFFICULTY_LABEL,
  ENEMY_TINTS,
  MAX_QUICK_ENEMIES,
  MIXES,
  MIX_LABEL,
  TOUGHNESS_LABEL,
  planGroups,
  scaleStats,
  type Difficulty,
  type Mix,
  type Toughness,
} from '@shared/quickEncounter';
import { campaignApi, encounterApi, qk, useCreatures } from '@/lib/api/hooks';
import { Button, Field, Input, Select, cn } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';

type Step = 'baseline' | 'fight' | 'names' | 'review';
/** One row per planned group. `creatureId` set = reuse a library creature; otherwise a new one named `name`. */
type Row = { toughness: Toughness; count: number; creatureId: string; name: string; hp: string; ac: string; init: string };

const int = (v: string) => (v.trim() === '' || !/^-?\d+$/.test(v.trim()) ? undefined : Number(v.trim()));

/**
 * Quick Encounter: shape the fight, name the groups, check the numbers, save.
 * Stats scale from the campaign's typical enemy, so it works for any rules system.
 */
export function QuickEncounterDialog({
  campaign,
  isOwner,
  onClose,
  onCreated,
}: {
  campaign: Campaign;
  isOwner: boolean;
  onClose: () => void;
  onCreated: (encounter: EncounterTemplate) => void;
}) {
  const qc = useQueryClient();
  const library = useCreatures(campaign.id);
  const [baseline, setBaseline] = useState<EnemyBaseline | undefined>(campaign.settings.enemyBaseline);
  const [step, setStep] = useState<Step>(baseline ? 'fight' : 'baseline');
  const [difficulty, setDifficulty] = useState<Difficulty>('moderate');
  const [mix, setMix] = useState<Mix>('leader');
  const [count, setCount] = useState('4');
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const n = Math.max(1, Math.min(MAX_QUICK_ENEMIES, int(count) ?? 1));
  const plan = useMemo(() => planGroups(difficulty, mix, n), [difficulty, mix, n]);
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const creatureOf = (id: string) => library.data?.find((c) => c.id === id);

  const toNames = () => {
    setRows(plan.map((g) => ({ toughness: g.toughness, count: g.count, creatureId: '', name: '', hp: '', ac: '', init: '' })));
    setStep('names');
  };
  const toReview = () => {
    // Fill stats for new creatures from the typical enemy; reused ones keep their library numbers.
    setRows((rs) =>
      rs.map((r) => {
        const s = scaleStats(baseline!, r.toughness);
        return { ...r, hp: String(s.hpMax), ac: s.ac !== undefined ? String(s.ac) : '', init: String(s.initiativeMod) };
      }),
    );
    if (!name) setName(`${DIFFICULTY_LABEL[difficulty]} encounter`);
    setStep('review');
  };

  const total = rows.reduce((t, r) => t + (int(String(r.count)) ?? 0), 0);
  const reviewOk = !!name.trim() && total >= 1 && total <= MAX_QUICK_ENEMIES && rows.every((r) => r.count >= 1 && (r.creatureId || (int(r.hp) ?? 0) >= 1));

  const create = async () => {
    setBusy(true);
    // Prefer colors no existing creature uses, so new groups are easy to tell apart on the map.
    const used = new Set(library.data?.map((c) => c.tint));
    const palette = [...ENEMY_TINTS.filter((t) => !used.has(t)), ...ENEMY_TINTS.filter((t) => used.has(t))];
    let k = 0;
    const nextTint = () => palette[k++ % palette.length]!;
    const groups = rows.map((r) =>
      r.creatureId
        ? { count: r.count, creatureId: r.creatureId }
        : {
            count: r.count,
            creature: { name: r.name.trim(), hpMax: int(r.hp)!, ...(int(r.ac) !== undefined ? { ac: int(r.ac) } : {}), initiativeMod: int(r.init) ?? 0, tint: nextTint() },
          },
    );
    try {
      const res = await encounterApi.quick(campaign.id, { name: name.trim(), groups });
      void qc.invalidateQueries({ queryKey: qk.creatures(campaign.id) });
      void qc.invalidateQueries({ queryKey: qk.encounters(campaign.id) });
      onCreated(res.encounter);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Quick encounter" description={DESCRIPTIONS[step]} wide>
      {step === 'baseline' && (
        <BaselineStep
          isOwner={isOwner}
          onDone={async (b) => {
            if (isOwner) {
              try {
                await campaignApi.update(campaign.id, { settings: { enemyBaseline: b } });
                void qc.invalidateQueries({ queryKey: qk.campaign(campaign.id) });
              } catch (e) {
                toast.error((e as Error).message);
                return;
              }
            }
            setBaseline(b);
            setStep('fight');
          }}
          onCancel={onClose}
        />
      )}

      {step === 'fight' && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            toNames();
          }}
        >
          <Choice label="Difficulty" value={difficulty} options={DIFFICULTIES.map((d) => [d, DIFFICULTY_LABEL[d]])} onChange={setDifficulty} />
          <Choice label="Mix" value={mix} options={MIXES.map((m) => [m, MIX_LABEL[m]])} onChange={setMix} />
          <Field label="How many enemies" htmlFor="qeCount" hint={`1 to ${MAX_QUICK_ENEMIES}.`}>
            <Input id="qeCount" type="number" min={1} max={MAX_QUICK_ENEMIES} value={count} onChange={(e) => setCount(e.target.value)} className="w-28" />
          </Field>
          <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
            You'll get {plan.map((g) => `${g.count} ${TOUGHNESS_LABEL[g.toughness].toLowerCase()}`).join(', ')}.
          </p>
          <Footer onBack={onClose} backLabel="Cancel" next="Next: name them" />
        </form>
      )}

      {step === 'names' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            toReview();
          }}
        >
          {rows.map((r, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <p className="mb-2 text-sm font-medium">
                {r.count} × {TOUGHNESS_LABEL[r.toughness]}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input aria-label={`Name for ${TOUGHNESS_LABEL[r.toughness]}`} placeholder="Name, e.g. Dock thug" value={r.name} disabled={!!r.creatureId} onChange={(e) => update(i, { name: e.target.value })} />
                {(library.data?.length ?? 0) > 0 && (
                  <Select aria-label={`Or pick a creature for ${TOUGHNESS_LABEL[r.toughness]}`} value={r.creatureId} onChange={(e) => update(i, { creatureId: e.target.value })}>
                    <option value="">…or pick one of your creatures</option>
                    {library.data!.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            </div>
          ))}
          <Footer onBack={() => setStep('fight')} next="Next: check numbers" disabled={!rows.every((r) => r.creatureId || r.name.trim())} />
        </form>
      )}

      {step === 'review' && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label="Encounter name" htmlFor="qeName">
            <Input id="qeName" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">Enemy</th>
                  <th className="py-1 pr-2 font-medium">Count</th>
                  <th className="py-1 pr-2 font-medium">HP</th>
                  <th className="py-1 pr-2 font-medium">AC</th>
                  <th className="py-1 font-medium">Init</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const lib = r.creatureId ? creatureOf(r.creatureId) : undefined;
                  const label = lib?.name ?? r.name.trim();
                  return (
                    <tr key={i} className="border-t border-border">
                      <td className="py-2 pr-2">
                        <span className="font-medium">{label}</span>
                        <span className="block text-xs text-faint">{lib ? 'from your creatures' : `new · ${TOUGHNESS_LABEL[r.toughness].toLowerCase()}`}</span>
                      </td>
                      <td className="py-2 pr-2">
                        <Input aria-label={`${label} count`} type="number" min={1} max={MAX_QUICK_ENEMIES} className="h-8 w-16" value={r.count} onChange={(e) => update(i, { count: Math.max(0, int(e.target.value) ?? 0) })} />
                      </td>
                      {lib ? (
                        <td colSpan={3} className="py-2 text-xs text-muted">
                          HP {lib.hpMax} · AC {lib.ac ?? '—'} · Init {fmt(lib.initiativeMod)}
                        </td>
                      ) : (
                        <>
                          <td className="py-2 pr-2">
                            <Input aria-label={`${label} HP`} inputMode="numeric" className="h-8 w-20" value={r.hp} onChange={(e) => update(i, { hp: e.target.value })} />
                          </td>
                          <td className="py-2 pr-2">
                            <Input aria-label={`${label} AC`} inputMode="numeric" className="h-8 w-16" placeholder="—" value={r.ac} onChange={(e) => update(i, { ac: e.target.value })} />
                          </td>
                          <td className="py-2">
                            <Input aria-label={`${label} initiative`} inputMode="numeric" className="h-8 w-16" value={r.init} onChange={(e) => update(i, { init: e.target.value })} />
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > MAX_QUICK_ENEMIES && <p className="text-xs text-danger">That's {total}; the most is {MAX_QUICK_ENEMIES}.</p>}
          <p className="text-xs text-faint">New enemies are saved to your creatures. They're placed hidden, so players see nothing until you reveal them.</p>
          <Footer onBack={() => setStep('names')} next="Create encounter" disabled={!reviewOk} busy={busy} />
        </form>
      )}
    </Dialog>
  );
}

const DESCRIPTIONS: Record<Step, string> = {
  baseline: 'First, what does an ordinary enemy look like in your game? Everything else scales from this.',
  fight: 'Pick the shape of the fight.',
  names: 'Name each group, or reuse a creature you already have.',
  review: 'Check the numbers. Everything here is editable.',
};

const fmt = (n: number) => (n >= 0 ? `+${n}` : String(n));

function BaselineStep({ isOwner, onDone, onCancel }: { isOwner: boolean; onDone: (b: EnemyBaseline) => void | Promise<void>; onCancel: () => void }) {
  const [hp, setHp] = useState('');
  const [ac, setAc] = useState('');
  const [init, setInit] = useState('0');
  const [busy, setBusy] = useState(false);
  const ok = (int(hp) ?? 0) >= 1 && (ac.trim() === '' || int(ac) !== undefined) && int(init) !== undefined;
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onDone({ hp: int(hp)!, ...(int(ac) !== undefined ? { ac: int(ac) } : {}), initiativeMod: int(init)! });
        setBusy(false);
      }}
    >
      <EnemyBaselineFields hp={hp} ac={ac} init={init} onChange={(v) => (setHp(v.hp), setAc(v.ac), setInit(v.init))} />
      <p className="text-xs text-faint">{isOwner ? 'Saved to the campaign settings, where you can change it later.' : 'Only the campaign owner can save this; it is used for this encounter.'}</p>
      <Footer onBack={onCancel} backLabel="Cancel" next="Next" disabled={!ok} busy={busy} />
    </form>
  );
}

/** Shared by Quick Encounter, the new-campaign form and campaign settings. */
export function EnemyBaselineFields({ hp, ac, init, disabled, onChange }: { hp: string; ac: string; init: string; disabled?: boolean; onChange: (v: { hp: string; ac: string; init: string }) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Field label="HP" htmlFor="baseHp">
        <Input id="baseHp" inputMode="numeric" disabled={disabled} placeholder="e.g. 15" value={hp} onChange={(e) => onChange({ hp: e.target.value, ac, init })} />
      </Field>
      <Field label="AC / defense" htmlFor="baseAc" hint="Optional">
        <Input id="baseAc" inputMode="numeric" disabled={disabled} placeholder="—" value={ac} onChange={(e) => onChange({ hp, ac: e.target.value, init })} />
      </Field>
      <Field label="Initiative bonus" htmlFor="baseInit">
        <Input id="baseInit" inputMode="numeric" disabled={disabled} value={init} onChange={(e) => onChange({ hp, ac, init: e.target.value })} />
      </Field>
    </div>
  );
}

/** Reads the three baseline text fields; `null` = left blank, `'invalid'` = something typed that isn't a whole number. */
export function parseBaseline(v: { hp: string; ac: string; init: string }): EnemyBaseline | null | 'invalid' {
  if (!v.hp.trim() && !v.ac.trim()) return null;
  const hp = int(v.hp);
  const ac = v.ac.trim() ? int(v.ac) : undefined;
  const init = v.init.trim() ? int(v.init) : 0;
  if (hp === undefined || hp < 1 || (v.ac.trim() && ac === undefined) || init === undefined) return 'invalid';
  return { hp, ...(ac !== undefined ? { ac } : {}), initiativeMod: init };
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={cn('rounded-md border px-3 py-1.5 text-sm', value === v ? 'border-accent bg-accent/10 text-text' : 'border-border text-muted hover:bg-surface-2')}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Footer({ onBack, backLabel = 'Back', next, disabled, busy }: { onBack: () => void; backLabel?: string; next: string; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="ghost" onClick={onBack}>
        {backLabel}
      </Button>
      <Button type="submit" disabled={disabled} loading={busy}>
        {next}
      </Button>
    </div>
  );
}

