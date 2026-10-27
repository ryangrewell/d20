import { useEffect, useRef, useState } from 'react';
import { Dices, Flag, Lock, Send } from 'lucide-react';
import { ReportDialog, type ReportTarget } from '@/features/reports/ReportDialog';
import { toast } from 'sonner';
import { Button, Select, cn } from '@/components/ui/primitives';
import { setTable, useTable } from '../store';
import type { SyncEngine } from '../sync';

const QUICK = ['1d20', '2d6', '1d8', '1d4', '1d12', '1d100'];

export function ChatPanel({ engine }: { engine: SyncEngine }) {
  const chat = useTable((s) => s.chat);
  const chatHasMore = useTable((s) => s.chatHasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stickToBottom = useRef(true);
  const snap = useTable((s) => s.snapshot);
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [rollVis, setRollVis] = useState<'PUBLIC' | 'GM' | 'SELF'>('PUBLIC');
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const me = snap?.me;
  const members = snap?.members ?? [];
  const settings = snap?.campaign.settings;
  const canWhisperTo = members.filter((m) => m.userSub !== me?.sub && (me?.isGM || settings?.playerWhispers || m.role === 'OWNER'));

  useEffect(() => {
    if (stickToBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    stickToBottom.current = true;
    setTable({ unread: 0 });
  }, [chat.length]);

  const loadOlder = async () => {
    const el = listRef.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    setLoadingOlder(true);
    stickToBottom.current = false;
    try {
      await engine.loadOlderChat();
      // Keep the reader's place after prepending.
      requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - fromBottom));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      const diceMatch = /^\/(?:r|roll)\s+(.+)$/i.exec(body);
      if (diceMatch) await engine.command('rollDice', { expression: diceMatch[1]!, visibility: rollVis });
      else await engine.command('sendChat', { body, ...(to ? { recipientSubs: [to] } : {}) });
      setText('');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const roll = (expression: string) => engine.command('rollDice', { expression, visibility: rollVis }).catch((e: Error) => toast.error(e.message));
  const nameOf = (sub: string) => members.find((m) => m.userSub === sub)?.displayName ?? 'someone';
  const colorOf = (sub: string) => members.find((m) => m.userSub === sub)?.color ?? '#a59fb6';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={listRef} className="scrollbar-thin flex-1 space-y-2 overflow-y-auto p-3" aria-live="polite" aria-label="Chat and dice log">
        {chatHasMore && (
          <div className="text-center">
            <Button size="sm" variant="ghost" loading={loadingOlder} onClick={() => void loadOlder()}>
              Load older messages
            </Button>
          </div>
        )}
        {chat.length === 0 && <p className="py-8 text-center text-xs text-faint">No messages yet. Say hello, or roll with /r 1d20.</p>}
        {chat.map((m) => {
          const whisper = m.scope === 'WHISPER';
          const others = (m.recipientSubs ?? []).filter((s) => s !== m.senderSub);
          return (
            <div key={m.id} className={cn('group rounded-lg px-3 py-2 text-sm', whisper ? 'border border-[#a86cc1]/40 bg-[#a86cc1]/10' : 'bg-surface-2')}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold" style={{ color: colorOf(m.senderSub) }}>
                  {m.senderName}
                </span>
                {m.senderSub !== me?.sub && m.kind === 'TEXT' && snap && (
                  <button
                    className="ml-auto text-faint opacity-0 transition hover:text-danger focus:opacity-100 group-hover:opacity-100"
                    aria-label={`Report message from ${m.senderName}`}
                    title="Report"
                    onClick={() => setReporting({ targetType: 'MESSAGE', targetId: m.id, campaignId: snap.campaign.id, label: `message from ${m.senderName}` })}
                  >
                    <Flag className="h-3 w-3" />
                  </button>
                )}
                <time className="shrink-0 text-[10px] text-faint" dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
              {whisper && (
                <p className="flex items-center gap-1 text-[11px] text-[#c9a0dc]">
                  <Lock className="h-3 w-3" aria-hidden />
                  {m.kind === 'ROLL' ? (m.roll?.visibility === 'SELF' ? 'Private roll' : 'Secret roll to GM') : `Whisper${others.length ? ` to ${others.map(nameOf).join(', ')}` : ''}`}
                </p>
              )}
              {m.kind === 'SYSTEM' ? (
                <p className="mt-0.5 text-xs italic text-muted">{m.body}</p>
              ) : m.kind === 'ROLL' && m.roll ? (
                <div className="mt-1">
                  <div className="flex items-center gap-2">
                    <Dices className="h-4 w-4 text-accent" aria-hidden />
                    <span className="text-muted">{m.roll.label ? `${m.roll.label} · ` : ''}{m.roll.expression}</span>
                    <span className="ml-auto font-display text-xl font-bold text-accent">{m.roll.total}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-faint">{m.roll.detail.replace(/~~(\d+)~~/g, '($1)')}</p>
                </div>
              ) : (
                <p className="mt-0.5 whitespace-pre-wrap break-words">{m.body}</p>
              )}
            </div>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-border p-3">
        <div className="flex flex-wrap gap-1">
          {QUICK.map((q) => (
            <Button key={q} size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={() => void roll(q)}>
              {q}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select aria-label="Message recipient" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-xs">
            <option value="">To: everyone</option>
            {canWhisperTo.map((m) => (
              <option key={m.userSub} value={m.userSub}>
                Whisper {m.displayName}
              </option>
            ))}
          </Select>
          <Select aria-label="Roll visibility" value={rollVis} onChange={(e) => setRollVis(e.target.value as typeof rollVis)} className="h-8 text-xs">
            <option value="PUBLIC">Rolls: public</option>
            {(me?.isGM || settings?.allowSecretRolls) && <option value="GM">Rolls: to GM</option>}
            <option value="SELF">Rolls: only me</option>
          </Select>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            aria-label="Message"
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            placeholder={to ? 'Whisper…' : 'Message, or /r 2d6+3'}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm focus:border-accent focus:outline-none"
          />
          <Button size="icon" type="submit" aria-label="Send" loading={busy}>
            {!busy && <Send className="h-4 w-4" aria-hidden />}
          </Button>
        </form>
      </div>
      {reporting && <ReportDialog target={reporting} onClose={() => setReporting(null)} />}
    </div>
  );
}
