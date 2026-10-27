/**
 * Journal and handouts. GMs write entries and choose who can read them;
 * players see what has been shared with them. Bodies are plain text.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Eye, EyeOff, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { JournalEntry, JournalVisibility } from '@shared/model';
import { journalApi, qk, useJournal } from '@/lib/api/hooks';
import { Badge, Button, EmptyState, ErrorNotice, Field, Input, Select, Spinner, Textarea, cn } from '@/components/ui/primitives';

type Member = { userSub: string; displayName: string; role: string };

export function JournalView({ campaignId, isGM, members, compact = false }: { campaignId: string; isGM: boolean; members: Member[]; compact?: boolean }) {
  const { data, isLoading, error } = useJournal(campaignId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<JournalEntry | 'new' | null>(null);
  const players = members.filter((m) => m.role !== 'OWNER');

  if (isLoading) return <Spinner label="Loading journal" />;
  if (error) return <ErrorNotice error={error} />;
  if (editing) return <JournalEditor campaignId={campaignId} entry={editing === 'new' ? null : editing} players={players} onDone={() => setEditing(null)} />;

  const entries = data ?? [];
  return (
    <div className={cn('space-y-3', compact && 'text-sm')}>
      {isGM && (
        <div className="flex justify-end">
          <Button size={compact ? 'sm' : 'md'} onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden /> New entry
          </Button>
        </div>
      )}
      {entries.length === 0 && (
        <EmptyState icon={<BookOpen className="h-8 w-8" />} title={isGM ? 'Your journal is empty' : 'Nothing shared yet'}>
          {isGM ? 'Write session notes, lore and handouts. Keep them private or share them with everyone or chosen players.' : 'Handouts and notes the GM shares with you will appear here.'}
        </EmptyState>
      )}
      <ul className="space-y-2">
        {entries.map((e) => {
          const open = openId === e.id;
          return (
            <li key={e.id} className="rounded-lg border border-border bg-surface/60">
              <button className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={open} onClick={() => setOpenId(open ? null : e.id)}>
                <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                {isGM && <VisibilityBadge entry={e} members={members} />}
                <time className="shrink-0 text-[11px] text-faint" dateTime={e.updatedAt}>
                  {new Date(e.updatedAt).toLocaleDateString()}
                </time>
              </button>
              {open && (
                <div className="border-t border-border px-3 py-2">
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{e.body || <span className="text-faint">No text.</span>}</p>
                  {isGM && (
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(e)}>
                        <Pencil className="h-4 w-4" aria-hidden /> Edit
                      </Button>
                      {e.visibility !== 'ALL' && <ShareButton campaignId={campaignId} entry={e} />}
                      <DeleteButton campaignId={campaignId} entry={e} />
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function VisibilityBadge({ entry, members }: { entry: JournalEntry; members: Member[] }) {
  if (entry.visibility === 'ALL')
    return (
      <Badge tone="success">
        <Eye className="h-3 w-3" aria-hidden /> Shared
      </Badge>
    );
  if (entry.visibility === 'GM_ONLY')
    return (
      <Badge>
        <EyeOff className="h-3 w-3" aria-hidden /> GM only
      </Badge>
    );
  const names = (entry.allowedViewerIds ?? []).map((s) => members.find((m) => m.userSub === s)?.displayName ?? '?');
  return (
    <Badge tone="info" title={names.join(', ')}>
      <Users className="h-3 w-3" aria-hidden /> {names.length === 1 ? names[0] : `${names.length} players`}
    </Badge>
  );
}

function ShareButton({ campaignId, entry }: { campaignId: string; entry: JournalEntry }) {
  const qc = useQueryClient();
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await journalApi.update(campaignId, entry.id, { title: entry.title, body: entry.body, visibility: 'ALL' });
          void qc.invalidateQueries({ queryKey: qk.journal(campaignId) });
          toast.success('Shared with everyone');
        } catch (e) {
          toast.error((e as Error).message);
        }
      }}
    >
      <Eye className="h-4 w-4" aria-hidden /> Share with everyone
    </Button>
  );
}

function DeleteButton({ campaignId, entry }: { campaignId: string; entry: JournalEntry }) {
  const qc = useQueryClient();
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        if (!confirm(`Delete “${entry.title}”?`)) return;
        await journalApi.remove(campaignId, entry.id).catch((e: Error) => toast.error(e.message));
        void qc.invalidateQueries({ queryKey: qk.journal(campaignId) });
      }}
    >
      <Trash2 className="h-4 w-4" aria-hidden /> Delete
    </Button>
  );
}

function JournalEditor({ campaignId, entry, players, onDone }: { campaignId: string; entry: JournalEntry | null; players: Member[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [visibility, setVisibility] = useState<JournalVisibility>(entry?.visibility ?? 'GM_ONLY');
  const [viewers, setViewers] = useState<string[]>(entry?.allowedViewerIds ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const input = { title: title.trim(), body, visibility, ...(visibility === 'SELECTED_PLAYERS' ? { allowedViewerIds: viewers } : {}) };
      if (entry) await journalApi.update(campaignId, entry.id, input);
      else await journalApi.create(campaignId, input);
      void qc.invalidateQueries({ queryKey: qk.journal(campaignId) });
      toast.success(visibility === 'GM_ONLY' ? 'Saved (GM only)' : 'Saved and shared');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Title" htmlFor="jTitle">
        <Input id="jTitle" autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Text" htmlFor="jBody" hint="Plain text. Line breaks are kept.">
        <Textarea id="jBody" className="min-h-48" value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Field label="Who can read this" htmlFor="jVis">
        <Select id="jVis" value={visibility} onChange={(e) => setVisibility(e.target.value as JournalVisibility)}>
          <option value="GM_ONLY">Only me (GM)</option>
          <option value="ALL">Everyone in the campaign</option>
          <option value="SELECTED_PLAYERS" disabled={!players.length}>
            Chosen players…
          </option>
        </Select>
      </Field>
      {visibility === 'SELECTED_PLAYERS' && (
        <fieldset className="space-y-1">
          <legend className="sr-only">Players</legend>
          {players.map((m) => (
            <label key={m.userSub} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-[var(--color-accent)]"
                checked={viewers.includes(m.userSub)}
                onChange={(e) => setViewers(e.target.checked ? [...viewers, m.userSub] : viewers.filter((s) => s !== m.userSub))}
              />
              {m.displayName}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim() || (visibility === 'SELECTED_PLAYERS' && !viewers.length)} loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
