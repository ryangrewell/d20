import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  History,
  Undo2,
  BookOpen,
  Brush,
  Crosshair,
  EyeOff,
  Hand,
  Hourglass,
  Layers,
  Maximize,
  MessageSquare,
  MonitorPlay,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Radio,
  Ruler,
  Shield,
  UserRound,
  Square,
  SquareDashed,
  Video,
  Wand2,
  Eraser,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Camera } from '@shared/geometry/transform';
import { useCampaign, campaignApi } from '@/lib/api/hooks';
import { Badge, Button, Spinner, cn } from '@/components/ui/primitives';
import { SyncEngine } from './sync';
import { setTable, useTable, type Tool } from './store';
import { TabletopCanvas } from './TabletopCanvas';
import { ChatPanel } from './panels/ChatPanel';
import { GMPanel } from './panels/GMPanel';
import { CharacterPanel } from './panels/CharacterPanel';
import { InitiativeTracker } from './panels/InitiativeTracker';
import { LootCard } from './panels/LootCard';
import { JournalView } from '@/features/journal/JournalView';
import { CheckpointsDialog } from './panels/CheckpointsDialog';

export default function TabletopPage({ display = false }: { display?: boolean }) {
  const { campaignId = '', sessionId = '' } = useParams();
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  useEffect(() => {
    const e = new SyncEngine(sessionId, display ? 'shared' : 'auto');
    setEngine(e);
    void e.start();
    return () => e.dispose();
  }, [sessionId, display]);

  const status = useTable((s) => s.status);
  const error = useTable((s) => s.error);
  const snap = useTable((s) => s.snapshot);
  if (!engine) return null;

  if (status === 'denied') {
    return (
      <FullMessage title="This table isn't available">
        <p>{error ?? 'You no longer have access to this session.'}</p>
        <Link to="/dashboard" className="mt-6 inline-block">
          <Button variant="outline">Back to campaigns</Button>
        </Link>
      </FullMessage>
    );
  }
  if (!snap) {
    return <FullMessage title="Opening the table">{status === 'error' ? <p className="text-danger">{error} · retrying…</p> : <Spinner label="Loading the scene" />}</FullMessage>;
  }
  if (display) return <SharedDisplay engine={engine} />;
  return <Table engine={engine} campaignId={campaignId} sessionId={sessionId} />;
}

function FullMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-atmosphere px-4 text-center">
      <div>
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <div className="mt-3 text-muted">{children}</div>
      </div>
    </div>
  );
}

function ConnectionBadge() {
  const status = useTable((s) => s.status);
  const map = { connected: ['success', 'Connected'], connecting: ['info', 'Connecting'], reconnecting: ['accent', 'Reconnecting'], offline: ['danger', 'Offline'], loading: ['info', 'Loading'], error: ['danger', 'Error'], denied: ['danger', 'No access'] } as const;
  const [tone, label] = map[status];
  return (
    <Badge tone={tone} aria-live="polite">
      <Radio className="h-3 w-3" aria-hidden /> {label}
    </Badge>
  );
}

function SharedDisplay({ engine }: { engine: SyncEngine }) {
  const camRef = useRef<{ fit: () => void; get: () => Camera; set: (c: Camera) => void } | null>(null);
  const snap = useTable((s) => s.snapshot)!;
  return (
    <div className="relative h-full overflow-hidden bg-black">
      {snap.scene ? <TabletopCanvas engine={engine} onCamera={() => undefined} cameraRef={camRef} /> : <FullMessage title={snap.campaign.title}>No scene is on the table yet.</FullMessage>}
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 opacity-60">
        <span className="rounded bg-black/60 px-2 py-1 text-xs">Player view · {snap.scene?.scene.name}</span>
        <ConnectionBadge />
      </div>
      <button className="absolute bottom-3 right-3 rounded bg-black/60 px-2 py-1 text-xs text-muted hover:text-text" onClick={() => void document.documentElement.requestFullscreen?.()}>
        Full screen
      </button>
    </div>
  );
}

function Table({ engine, campaignId, sessionId }: { engine: SyncEngine; campaignId: string; sessionId: string }) {
  const snap = useTable((s) => s.snapshot)!;
  const tool = useTable((s) => s.tool);
  const unread = useTable((s) => s.unread);
  const showCursors = useTable((s) => s.showCursors);
  const hideMyCursor = useTable((s) => s.hideMyCursor);
  const followGM = useTable((s) => s.followGM);
  const fogBrush = useTable((s) => s.fogBrush);
  const navigate = useNavigate();
  const isGM = snap.viewMode === 'gm';
  const [panel, setPanel] = useState<'chat' | 'character' | 'journal' | 'gm'>(isGM ? 'gm' : 'chat');
  const [zoom, setZoom] = useState(1);
  const camRef = useRef<{ fit: () => void; get: () => Camera; set: (c: Camera) => void } | null>(null);
  const session = snap.session;
  const meetingUrl = session.meetingUrl ?? snap.campaign.settings.meetingUrl;

  const undo = useCallback(async () => {
    try {
      const r = await engine.command('undoLast', {});
      toast.success(`Undid: ${(r.result as { label?: string } | undefined)?.label ?? 'last change'}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [engine]);

  // Tool keyboard shortcuts (V select, H pan, M measure, P ping, Esc select).
  useEffect(() => {
    const keys: Record<string, Tool> = { v: 'select', h: 'pan', m: 'measure', p: 'ping', ...(isGM ? { r: 'fog-reveal' as Tool, c: 'fog-conceal' as Tool } : {}) };
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (isGM && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void undo();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === 'Escape') setTable({ tool: 'select', selectedId: null });
      const t = keys[e.key.toLowerCase()];
      if (t) setTable({ tool: t });
      if (isGM && (e.key === 'Delete' || e.key === 'Backspace')) {
        const id = useTable.getState().selectedId;
        if (id) {
          void engine.command('removeSceneObject', { objectId: id }).catch((err: Error) => toast.error(err.message));
          setTable({ selectedId: null });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isGM, engine, undo]);

  const tools: { id: Tool; label: string; key: string; icon: typeof Hand; gm?: boolean }[] = [
    { id: 'select', label: 'Select & move', key: 'V', icon: MousePointer2 },
    { id: 'pan', label: 'Pan', key: 'H', icon: Hand },
    { id: 'measure', label: 'Measure', key: 'M', icon: Ruler },
    { id: 'ping', label: 'Ping', key: 'P', icon: Crosshair },
    { id: 'fog-reveal', label: 'Reveal fog', key: 'R', icon: Wand2, gm: true },
    { id: 'fog-conceal', label: 'Conceal fog', key: 'C', icon: Eraser, gm: true },
  ];

  const transition = async (action: 'start' | 'pause' | 'resume' | 'end') => {
    try {
      await campaignApi.transition(sessionId, action);
      if (action === 'end') navigate(`/campaigns/${campaignId}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const focusEveryone = () => {
    const cam = camRef.current?.get();
    const s = useTable.getState();
    const r = document.querySelector('[role=application]')?.getBoundingClientRect();
    if (!cam || !s.snapshot?.scene || !r) return;
    const center = { x: cam.x + r.width / 2 / cam.zoom, y: cam.y + r.height / 2 / cam.zoom };
    void engine.command('presenterFocus', { sceneId: s.snapshot.scene.scene.id, center, zoom: cam.zoom }).then(() => toast.success('Everyone is looking here'), (e: Error) => toast.error(e.message));
  };

  const statusTone = { PLANNED: 'info', LIVE: 'success', PAUSED: 'accent', ENDED: 'neutral' } as const;

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <Link to={`/campaigns/${campaignId}`} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label="Back to campaign">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{snap.campaign.title}</p>
          <p className="truncate text-[11px] text-faint">
            {session.title} · {snap.scene?.scene.name ?? 'No scene'}
          </p>
        </div>
        <Badge tone={statusTone[session.status]}>{session.status.toLowerCase()}</Badge>
        <ConnectionBadge />
        <div className="ml-auto flex items-center gap-2">
          {isGM && session.status === 'PLANNED' && (
            <Button size="sm" onClick={() => void transition('start')}>
              <Play className="h-4 w-4" aria-hidden /> Start session
            </Button>
          )}
          {isGM && session.status === 'LIVE' && (
            <Button size="sm" variant="secondary" onClick={() => void transition('pause')}>
              <Pause className="h-4 w-4" aria-hidden /> Pause
            </Button>
          )}
          {isGM && session.status === 'PAUSED' && (
            <Button size="sm" onClick={() => void transition('resume')}>
              <Play className="h-4 w-4" aria-hidden /> Resume
            </Button>
          )}
          {isGM && session.status !== 'ENDED' && (
            <Button size="sm" variant="ghost" onClick={() => confirm('End this session? Everything is saved and can be continued next time.') && void transition('end')}>
              <Square className="h-4 w-4" aria-hidden /> End
            </Button>
          )}
          {isGM && (
            <a href={`/campaigns/${campaignId}/sessions/${sessionId}/display`} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="outline" title="Open a clean player view for screen sharing">
                <MonitorPlay className="h-4 w-4" aria-hidden /> Player display
              </Button>
            </a>
          )}
          {meetingUrl && (
            <a href={meetingUrl} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="secondary">
                <Video className="h-4 w-4" aria-hidden /> Join call
              </Button>
            </a>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {isGM && <ScenesSidebar campaignId={campaignId} engine={engine} />}

        <main className="relative min-w-0 flex-1 overflow-hidden">
          {snap.waiting ? (
            <FullMessage title="The table isn't open yet">
              <p className="flex items-center justify-center gap-2">
                <Hourglass className="h-4 w-4" aria-hidden /> Your GM will start the session soon. This page updates automatically.
              </p>
            </FullMessage>
          ) : !snap.scene ? (
            <FullMessage title={isGM ? 'Choose a scene' : 'Waiting for the GM'}>
              {isGM ? 'Pick a scene from the left to put it on the table.' : 'The GM has not put a map on the table yet.'}
            </FullMessage>
          ) : (
            <>
              <TabletopCanvas engine={engine} onCamera={(c) => setZoom(c.zoom)} cameraRef={camRef} />
              <InitiativeTracker engine={engine} />
              <LootCard engine={engine} />
              {isGM && snap.scene.scene.id !== snap.session.activeSceneId && <PrivateViewBanner engine={engine} sceneId={snap.scene.scene.id} sceneName={snap.scene.scene.name} campaignId={campaignId} />}
              {!snap.scene.map.calibration && isGM && snap.scene.scene.id === snap.session.activeSceneId && (
                <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-lg border border-accent/40 bg-surface/90 px-3 py-1.5 text-xs">
                  This map has no scale yet.{' '}
                  <Link className="text-accent underline" to={`/campaigns/${campaignId}/maps/${snap.scene.map.id}`}>
                    Calibrate it
                  </Link>{' '}
                  to enable grid and measuring.
                </div>
              )}
              <div className="scrollbar-thin absolute bottom-3 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-surface/95 p-1 shadow-xl backdrop-blur" role="toolbar" aria-label="Table tools">
                {tools
                  .filter((t) => !t.gm || isGM)
                  .map((t) => (
                    <Button key={t.id} size="icon" variant={tool === t.id ? 'secondary' : 'ghost'} aria-pressed={tool === t.id} aria-label={`${t.label} (${t.key})`} title={`${t.label} (${t.key})`} onClick={() => setTable({ tool: t.id })}>
                      <t.icon className="h-4 w-4" aria-hidden />
                    </Button>
                  ))}
                {isGM && (tool === 'fog-reveal' || tool === 'fog-conceal') && (
                  <>
                    <span className="mx-1 h-6 w-px bg-border" aria-hidden />
                    <Button size="icon" variant={fogBrush === 'rect' ? 'secondary' : 'ghost'} aria-label="Rectangle fog tool" title="Rectangle" onClick={() => setTable({ fogBrush: 'rect' })}>
                      <SquareDashed className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button size="icon" variant={fogBrush === 'brush' ? 'secondary' : 'ghost'} aria-label="Brush fog tool" title="Brush" onClick={() => setTable({ fogBrush: 'brush' })}>
                      <Brush className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => confirm('Reset fog for this scene?') && void engine.command('resetFog', { sceneId: snap.scene!.scene.id, initial: 'covered' }).catch((e: Error) => toast.error(e.message))}
                    >
                      Cover all
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void engine.command('resetFog', { sceneId: snap.scene!.scene.id, initial: 'revealed' }).catch((e: Error) => toast.error(e.message))}
                    >
                      Clear all
                    </Button>
                  </>
                )}
                <span className="mx-1 h-6 w-px bg-border" aria-hidden />
                {isGM && (
                  <Button size="icon" variant="ghost" aria-label="Undo last map change (Ctrl/Cmd+Z)" title="Undo (Ctrl/Cmd+Z)" onClick={() => void undo()}>
                    <Undo2 className="h-4 w-4" aria-hidden />
                  </Button>
                )}
                <Button size="icon" variant="ghost" aria-label="Fit map to screen" title="Fit map" onClick={() => camRef.current?.fit()}>
                  <Maximize className="h-4 w-4" aria-hidden />
                </Button>
                <span className="w-12 text-center text-xs tabular-nums text-muted">{Math.round(zoom * 100)}%</span>
                {isGM && (
                  <Button size="sm" variant="ghost" title="Move everyone's camera to your view" onClick={focusEveryone}>
                    <Shield className="h-4 w-4" aria-hidden /> Focus all
                  </Button>
                )}
              </div>
              <div className="absolute right-3 top-3 flex flex-col items-end gap-1 text-xs">
                <label className="flex items-center gap-1.5 rounded-md bg-surface/80 px-2 py-1">
                  <input type="checkbox" className="accent-[var(--color-accent)]" checked={showCursors} onChange={(e) => setTable({ showCursors: e.target.checked })} /> Show pointers
                </label>
                <label className="flex items-center gap-1.5 rounded-md bg-surface/80 px-2 py-1">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={hideMyCursor}
                    onChange={(e) => {
                      setTable({ hideMyCursor: e.target.checked });
                      if (e.target.checked) engine.leaveCursor();
                    }}
                  />{' '}
                  <EyeOff className="h-3 w-3" aria-hidden /> Hide my pointer
                </label>
                {!isGM && (
                  <label className="flex items-center gap-1.5 rounded-md bg-surface/80 px-2 py-1">
                    <input type="checkbox" className="accent-[var(--color-accent)]" checked={followGM} onChange={(e) => setTable({ followGM: e.target.checked })} /> Follow GM camera
                  </label>
                )}
              </div>
            </>
          )}
        </main>

        <aside className="flex w-80 shrink-0 flex-col xl:w-[22rem] border-l border-border bg-surface" aria-label="Side panel">
          <div className="flex border-b border-border" role="tablist">
            <button role="tab" aria-selected={panel === 'chat'} onClick={() => setPanel('chat')} className={cn('flex flex-1 items-center justify-center gap-2 py-2.5 text-sm', panel === 'chat' ? 'border-b-2 border-accent text-text' : 'text-muted')}>
              <MessageSquare className="h-4 w-4" aria-hidden /> Chat
              {unread > 0 && panel !== 'chat' && <Badge tone="accent">{unread}</Badge>}
            </button>
            <button role="tab" aria-selected={panel === 'character'} onClick={() => setPanel('character')} className={cn('flex flex-1 items-center justify-center gap-2 py-2.5 text-sm', panel === 'character' ? 'border-b-2 border-accent text-text' : 'text-muted')}>
              <UserRound className="h-4 w-4" aria-hidden /> {isGM ? 'Sheets' : 'Character'}
            </button>
            <button role="tab" aria-selected={panel === 'journal'} aria-label="Journal" title="Journal" onClick={() => setPanel('journal')} className={cn('flex items-center justify-center gap-2 px-3 py-2.5 text-sm', panel === 'journal' ? 'border-b-2 border-accent text-text' : 'text-muted')}>
              <BookOpen className="h-4 w-4" aria-hidden />
            </button>
            {isGM && (
              <button role="tab" aria-selected={panel === 'gm'} onClick={() => setPanel('gm')} className={cn('flex flex-1 items-center justify-center gap-2 py-2.5 text-sm', panel === 'gm' ? 'border-b-2 border-accent text-text' : 'text-muted')}>
                <Shield className="h-4 w-4" aria-hidden /> GM tools
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1">{panel === 'journal' ? (
              <div className="scrollbar-thin h-full overflow-y-auto p-3">
                <JournalView campaignId={snap.campaign.id} isGM={isGM} members={snap.members} compact />
              </div>
            ) : panel === 'character' ? <CharacterPanel engine={engine} /> : panel === 'gm' && isGM ? <GMPanel engine={engine} /> : <ChatPanel engine={engine} />}</div>
          <Players />
        </aside>
      </div>
    </div>
  );
}

function Players() {
  const members = useTable((s) => s.snapshot?.members ?? []);
  const cursors = useTable((s) => s.cursors);
  const me = useTable((s) => s.snapshot?.me.sub);
  return (
    <div className="border-t border-border p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">At the table</h3>
      <ul className="flex flex-wrap gap-1.5">
        {members.map((m) => {
          const active = m.userSub === me || !!cursors[m.userSub];
          return (
            <li key={m.userSub} className={cn('flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs', active ? 'border-border text-text' : 'border-transparent text-faint')}>
              <span className="h-2 w-2 rounded-full" style={{ background: m.color }} aria-hidden />
              {m.displayName}
              {m.role === 'OWNER' && <span className="text-[10px] text-accent">GM</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Shown to the GM while they look at a scene the players can't see. */
function PrivateViewBanner({ engine, sceneId, sceneName, campaignId }: { engine: SyncEngine; sceneId: string; sceneName: string; campaignId: string }) {
  const { data } = useCampaign(campaignId);
  const activeSceneId = useTable((s) => s.snapshot?.session.activeSceneId);
  const playersOn = data?.scenes.find((s) => s.id === activeSceneId)?.name;
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" className="absolute inset-x-0 top-20 z-10 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-center gap-2 rounded-lg border border-accent/50 bg-surface/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <EyeOff className="h-4 w-4 shrink-0 text-accent" aria-hidden />
      <span>
        Only you can see <b>{sceneName}</b>. {playersOn ? <>Players are on {playersOn}.</> : 'Players have no map yet.'}
      </span>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await engine.command('switchActiveScene', { sceneId });
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Users className="h-3.5 w-3.5" aria-hidden /> Move players here
      </Button>
      {activeSceneId && (
        <Button size="sm" variant="ghost" onClick={() => engine.viewScene(null)}>
          Back to players' scene
        </Button>
      )}
    </div>
  );
}

function ScenesSidebar({ campaignId, engine }: { campaignId: string; engine: SyncEngine }) {
  const { data, refetch } = useCampaign(campaignId);
  const activeSceneId = useTable((s) => s.snapshot?.session.activeSceneId);
  const shownSceneId = useTable((s) => s.snapshot?.scene?.scene.id);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  // Checkpoints follow whatever scene the GM is looking at, private or not.
  const activeScene = data?.scenes.find((s) => s.id === shownSceneId);
  // Local breadcrumb so the GM can hop back after following a doorway or stairs.
  const [history, setHistory] = useState<string[]>([]);
  const lastScene = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = lastScene.current;
    lastScene.current = activeSceneId;
    if (prev && activeSceneId && prev !== activeSceneId) setHistory((h) => [...h.filter((id) => id !== prev), prev].slice(-10));
  }, [activeSceneId]);
  const previousId = [...history].reverse().find((id) => id !== activeSceneId && data?.scenes.some((s) => s.id === id));
  const previous = data?.scenes.find((s) => s.id === previousId);
  if (collapsed)
    return (
      <button className="w-8 border-r border-border bg-surface text-muted hover:text-text" onClick={() => setCollapsed(false)} aria-label="Show scenes">
        <Layers className="mx-auto h-4 w-4" />
      </button>
    );
  return (
    <aside className="scrollbar-thin flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface" aria-label="Scenes">
      <div className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Scenes</h2>
        <button className="text-xs text-faint hover:text-text" onClick={() => setCollapsed(true)}>
          Hide
        </button>
      </div>
      {previous && (
        <button
          className="mx-2 mb-1 flex items-center gap-1 rounded-md px-2 py-1 text-left text-xs text-accent hover:bg-surface-2"
          onClick={() => {
            setHistory((h) => h.filter((id) => id !== previous.id));
            void engine.command('switchActiveScene', { sceneId: previous.id }).catch((e: Error) => toast.error(e.message));
          }}
        >
          <ArrowLeft className="h-3 w-3" aria-hidden /> Back to {previous.name}
        </button>
      )}
      <ul className="space-y-0.5 px-2">
        {(data?.scenes ?? []).map((s) => (
          <li key={s.id}>
            <button
              className={cn('flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm', s.id === shownSceneId ? 'bg-accent/15 text-accent' : 'text-text hover:bg-surface-2')}
              // Opens the scene for the GM only; "Move players here" on the banner puts it on everyone's table.
              // With no scene on the table yet there's nothing to keep private, so it goes straight on.
              onClick={() => (activeSceneId ? engine.viewScene(s.id) : void engine.command('switchActiveScene', { sceneId: s.id }).catch((e: Error) => toast.error(e.message)))}
              aria-current={s.id === shownSceneId}
              title={s.id === activeSceneId ? 'The players are here' : 'Open privately. Players stay where they are.'}
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.id === activeSceneId && (
                <span className="flex shrink-0 items-center gap-0.5 text-[10px] uppercase text-success">
                  <Users className="h-3 w-3" aria-hidden /> players
                </span>
              )}
            </button>
          </li>
        ))}
        {data?.scenes.length === 0 && <li className="px-2 text-xs text-faint">No scenes yet. Create one from a map below.</li>}
      </ul>
      {activeScene && (
        <button className="mx-2 mt-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted hover:bg-surface-2 hover:text-text" onClick={() => setCheckpointsOpen(true)}>
          <History className="h-3.5 w-3.5" aria-hidden /> Checkpoints for this scene…
        </button>
      )}
      {checkpointsOpen && activeScene && <CheckpointsDialog campaignId={campaignId} sceneId={activeScene.id} sceneName={activeScene.name} engine={engine} onClose={() => setCheckpointsOpen(false)} />}
      <h2 className="mt-4 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">Maps</h2>
      <ul className="space-y-0.5 px-2 pb-4">
        {(data?.maps ?? []).map((m) => (
          <li key={m.id} className="flex items-center justify-between rounded-md px-2 py-1 text-sm hover:bg-surface-2">
            <span className="truncate">{m.name}</span>
            <button
              className="rounded p-1 text-faint hover:text-accent"
              aria-label={`New scene from ${m.name}`}
              title="New scene from this map"
              disabled={creatingFor === m.id}
              onClick={async () => {
                setCreatingFor(m.id);
                try {
                  const scene = await campaignApi.createScene(campaignId, { mapId: m.id, name: m.name, fogInitial: 'revealed' });
                  await refetch();
                  if (activeSceneId) engine.viewScene(scene.id);
                  else await engine.command('switchActiveScene', { sceneId: scene.id });
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setCreatingFor(null);
                }
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        <li>
          <Link to={`/campaigns/${campaignId}`} className="block px-2 py-1 text-xs text-accent hover:underline">
            Upload a map…
          </Link>
        </li>
      </ul>
    </aside>
  );
}
