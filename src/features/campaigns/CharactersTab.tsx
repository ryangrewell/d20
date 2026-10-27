import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, Plus, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import { characterApi, qk, useCharacters } from '@/lib/api/hooks';
import { useAuth } from '@/app/auth';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';

export function CharactersTab({ data }: { data: CampaignDashboardDto }) {
  const { campaign, access, members } = data;
  const { user } = useAuth();
  const list = useCharacters(campaign.id);
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const nameOf = (sub: string) => members.find((m) => m.userSub === sub)?.displayName ?? 'Former member';
  const canCreate = campaign.status === 'ACTIVE' && (access.isGM || access.role === 'PLAYER');

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 500_000) throw new Error('That file is too large to be a character.');
      const parsed = JSON.parse(await file.text()) as unknown;
      const c = await characterApi.import(campaign.id, parsed);
      void qc.invalidateQueries({ queryKey: qk.characters(campaign.id) });
      toast.success(`Imported ${c.name}`);
      navigate(`/campaigns/${campaign.id}/characters/${c.id}`);
    } catch (e) {
      toast.error(e instanceof SyntaxError ? 'That file is not valid JSON.' : (e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      {canCreate && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <FileUp className="h-4 w-4" aria-hidden /> Import JSON
          </Button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" aria-label="Character JSON file" onChange={(e) => void importFile(e.target.files?.[0])} />
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New character
          </Button>
        </div>
      )}
      {list.isLoading && <Spinner label="Loading characters" />}
      {list.error && <ErrorNotice error={list.error} />}
      {list.data && list.data.characters.length === 0 && (
        <EmptyState icon={<UserRound className="h-8 w-8" />} title={access.isGM ? 'No characters yet' : 'Create your character'}>
          {access.isGM ? 'Players create their own characters, or you can create one for them.' : 'Your sheet holds stats, conditions, attacks and inventory. Only you and the GM can see it.'}
        </EmptyState>
      )}
      {list.data && list.data.characters.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.data.characters.map((c) => {
            const hp = c.sheet.hp as { current: number; max: number } | undefined;
            return (
              <Link key={c.id} to={`/campaigns/${campaign.id}/characters/${c.id}`}>
                <Card className="h-full p-4 transition hover:border-accent/60">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-display text-lg font-semibold">{c.name}</h3>
                    {c.ownerSub === user?.sub ? <Badge tone="accent">Yours</Badge> : <Badge>{nameOf(c.ownerSub)}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {[c.sheet.role, c.sheet.level !== undefined ? `Level ${String(c.sheet.level)}` : null].filter(Boolean).join(' · ') || 'No class set'}
                  </p>
                  {hp && (
                    <p className="mt-2 text-xs text-faint">
                      HP {hp.current}/{hp.max} · AC {String(c.sheet.ac ?? '—')}
                    </p>
                  )}
                  {c.conditions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {c.conditions.map((x) => (
                        <Badge key={x} tone="info">
                          {x}
                        </Badge>
                      ))}
                    </div>
                  )}
                </Card>
              </Link>
            );
          })}
        </div>
      )}
      {list.data && list.data.others.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-muted">Other adventurers</h3>
          <ul className="flex flex-wrap gap-2 text-sm">
            {list.data.others.map((o) => (
              <li key={o.id} className="rounded-full border border-border px-3 py-1">
                {o.name} <span className="text-faint">· {nameOf(o.ownerSub)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {creating && <CreateCharacterDialog data={data} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateCharacterDialog({ data, onClose }: { data: CampaignDashboardDto; onClose: () => void }) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [owner, setOwner] = useState(user?.sub ?? '');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const submit = async () => {
    setBusy(true);
    try {
      const c = await characterApi.create(data.campaign.id, { name: name.trim(), ...(owner && owner !== user?.sub ? { ownerSub: owner } : {}) });
      void qc.invalidateQueries({ queryKey: qk.characters(data.campaign.id) });
      navigate(`/campaigns/${data.campaign.id}/characters/${c.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New character" description="You can fill in the sheet next.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" htmlFor="charName">
          <Input id="charName" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        {data.access.isGM && (
          <Field label="Played by" htmlFor="charOwner">
            <Select id="charOwner" value={owner} onChange={(e) => setOwner(e.target.value)}>
              {data.members
                .filter((m) => m.role !== 'SPECTATOR')
                .map((m) => (
                  <option key={m.userSub} value={m.userSub}>
                    {m.displayName}
                    {m.userSub === user?.sub ? ' (you, e.g. an NPC)' : ''}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim()} loading={busy}>
            Create character
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
