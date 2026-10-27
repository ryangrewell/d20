import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldPlus } from 'lucide-react';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import type { GMDelegation } from '@shared/model';
import { api } from '@/lib/api/client';
import { qk } from '@/lib/api/hooks';
import { Badge, Button, Field, Input, Select } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';

type Status = 'ACTIVE' | 'SCHEDULED' | 'ENDED' | 'REVOKED';

export function delegationStatus(d: GMDelegation, sessions: CampaignDashboardDto['sessions'], now = new Date()): Status {
  if (d.revokedAt) return 'REVOKED';
  if (d.scope.kind === 'TIME_WINDOW') return new Date(d.scope.endsAt) <= now ? 'ENDED' : new Date(d.scope.startsAt) > now ? 'SCHEDULED' : 'ACTIVE';
  const covered = (n: number, id: string) => (d.scope.kind === 'SESSIONS' ? d.scope.sessionIds.includes(id) : n >= (d.scope as { fromSessionNumber: number }).fromSessionNumber && n < (d.scope as { fromSessionNumber: number; count: number }).fromSessionNumber + (d.scope as { count: number }).count);
  const mine = sessions.filter((s) => covered(s.number, s.id));
  if (mine.some((s) => s.status === 'LIVE' || s.status === 'PAUSED')) return 'ACTIVE';
  if (d.scope.kind === 'NEXT_N_SESSIONS') {
    const last = d.scope.fromSessionNumber + d.scope.count - 1;
    return mine.filter((s) => s.status === 'ENDED').length >= d.scope.count || sessions.some((s) => s.number > last) ? 'ENDED' : 'SCHEDULED';
  }
  return mine.every((s) => s.status === 'ENDED') ? 'ENDED' : 'SCHEDULED';
}

export function describeScope(d: GMDelegation, sessions: CampaignDashboardDto['sessions']): string {
  switch (d.scope.kind) {
    case 'SESSIONS':
      return d.scope.sessionIds.map((id) => sessions.find((s) => s.id === id)?.title ?? 'a session').join(', ');
    case 'NEXT_N_SESSIONS':
      return d.scope.count === 1 ? `Session ${d.scope.fromSessionNumber}` : `Sessions ${d.scope.fromSessionNumber}–${d.scope.fromSessionNumber + d.scope.count - 1}`;
    case 'TIME_WINDOW':
      return `${new Date(d.scope.startsAt).toLocaleString()} – ${new Date(d.scope.endsAt).toLocaleString()}`;
  }
}

const TONE: Record<Status, 'success' | 'info' | 'neutral' | 'danger'> = { ACTIVE: 'success', SCHEDULED: 'info', ENDED: 'neutral', REVOKED: 'danger' };

/** Owner: grant and revoke temporary GM control. Delegates: see their own grants. */
export function DelegationSection({ data }: { data: CampaignDashboardDto }) {
  const { campaign, access, members, sessions } = data;
  const qc = useQueryClient();
  const key = ['delegations', campaign.id];
  const list = useQuery({ queryKey: key, queryFn: () => api<GMDelegation[]>(`/campaigns/${campaign.id}/delegations`) });
  const [granting, setGranting] = useState(false);
  const nameOf = (sub: string) => members.find((m) => m.userSub === sub)?.displayName ?? 'Former member';
  const visible = (list.data ?? []).filter((d) => access.isOwner || delegationStatus(d, sessions) !== 'REVOKED');
  if (!access.isOwner && !visible.length) return null;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">GM delegation</h2>
        {access.isOwner && campaign.status === 'ACTIVE' && (
          <Button size="sm" variant="outline" onClick={() => setGranting(true)} disabled={members.length < 2}>
            <ShieldPlus className="h-4 w-4" aria-hidden /> Delegate GM control
          </Button>
        )}
      </div>
      {access.isOwner && !visible.length && <p className="text-sm text-muted">Let a player run sessions while you're away. They get GM tools for the scope you choose; you can revoke it any time.</p>}
      <ul className="space-y-2">
        {visible.map((d) => {
          const st = delegationStatus(d, sessions);
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
              <span className="font-medium">{nameOf(d.delegateSub)}</span>
              <Badge tone={TONE[st]}>{st.toLowerCase()}</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {describeScope(d, sessions)}
                {d.permissions.members ? ' · can manage players' : ''}
                {d.permissions.characters ? ' · can edit sheets' : ''}
              </span>
              {access.isOwner && st !== 'REVOKED' && st !== 'ENDED' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Revoke GM control for ${nameOf(d.delegateSub)}`}
                  onClick={async () => {
                    if (!confirm(`Revoke ${nameOf(d.delegateSub)}'s GM control now?`)) return;
                    try {
                      await api(`/campaigns/${campaign.id}/delegations/${d.id}/revoke`, { body: {} });
                      void qc.invalidateQueries({ queryKey: key });
                      void qc.invalidateQueries({ queryKey: qk.campaign(campaign.id) });
                      toast.success('GM control revoked');
                    } catch (e) {
                      toast.error((e as Error).message);
                    }
                  }}
                >
                  Revoke
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {granting && <GrantDialog data={data} onClose={() => setGranting(false)} onDone={() => void qc.invalidateQueries({ queryKey: key })} />}
    </section>
  );
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function GrantDialog({ data, onClose, onDone }: { data: CampaignDashboardDto; onClose: () => void; onDone: () => void }) {
  const players = data.members.filter((m) => m.role !== 'OWNER');
  const open = data.sessions.filter((s) => s.status !== 'ENDED');
  const [who, setWho] = useState(players[0]?.userSub ?? '');
  const [kind, setKind] = useState<'NEXT_N_SESSIONS' | 'SESSIONS' | 'TIME_WINDOW'>('NEXT_N_SESSIONS');
  const [count, setCount] = useState('1');
  const [picked, setPicked] = useState<string[]>([]);
  const [start, setStart] = useState(toLocalInput(new Date()));
  const [end, setEnd] = useState(toLocalInput(new Date(Date.now() + 4 * 3600_000)));
  const [members, setMembers] = useState(false);
  const [chars, setChars] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const scope =
      kind === 'NEXT_N_SESSIONS'
        ? { kind, count: Math.max(1, Math.min(20, Number(count) || 1)) }
        : kind === 'SESSIONS'
          ? { kind, sessionIds: picked }
          : { kind, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
    try {
      await api(`/campaigns/${data.campaign.id}/delegations`, { body: { delegateSub: who, scope, permissions: { members, characters: chars } } });
      toast.success('GM control delegated');
      onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Delegate GM control" description="They get GM tools (scenes, fog, monsters) for the scope you choose. Ownership never transfers." wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Player" htmlFor="dWho">
          <Select id="dWho" value={who} onChange={(e) => setWho(e.target.value)}>
            {players.map((m) => (
              <option key={m.userSub} value={m.userSub}>
                {m.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="For" htmlFor="dKind">
          <Select id="dKind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="NEXT_N_SESSIONS">The current / next session(s)</option>
            <option value="SESSIONS" disabled={!open.length}>
              Specific sessions
            </option>
            <option value="TIME_WINDOW">A time window</option>
          </Select>
        </Field>
        {kind === 'NEXT_N_SESSIONS' && (
          <Field label="Number of sessions" htmlFor="dCount" hint="Counts from the session in progress, or the next one you create.">
            <Input id="dCount" type="number" min={1} max={20} value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
        )}
        {kind === 'SESSIONS' && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm font-medium">Sessions</legend>
            {open.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-[var(--color-accent)]" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
                {s.title} <span className="text-xs text-faint">({s.status.toLowerCase()})</span>
              </label>
            ))}
          </fieldset>
        )}
        {kind === 'TIME_WINDOW' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts" htmlFor="dStart">
              <Input id="dStart" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Ends" htmlFor="dEnd">
              <Input id="dEnd" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        )}
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-medium">Also allow</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-[var(--color-accent)]" checked={members} onChange={(e) => setMembers(e.target.checked)} /> Managing players and invites
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-[var(--color-accent)]" checked={chars} onChange={(e) => setChars(e.target.checked)} /> Editing other players' character sheets
          </label>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!who || (kind === 'SESSIONS' && !picked.length)}>
            Delegate
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
