/**
 * Client sync engine.
 *
 * Connect sequence (spec 11.3): subscribe to authorised channels first while
 * buffering, load the authoritative snapshot (revision N), then apply buffered
 * events newer than N in order, de-duplicated by event id. Any reconnect,
 * scene change, or access change repeats the sequence.
 */
import { toast } from 'sonner';
import type { SessionSnapshotDto } from '@shared/dto';
import type { DurableEvent, DurableEventBody, PresenceEvent } from '@shared/events';
import type { CommandResult, CommandType, CommandInput } from '@shared/schemas/commands';
import type { CursorPacket } from '@shared/model';
import { api, ApiError } from '@/lib/api/client';
import { createTransport, SubscribeDenied, type RealtimeTransport } from '@/lib/realtime/transport';
import { queryClient } from '@/lib/queryClient';
import { chatApi } from '@/lib/api/hooks';
import { getTable, initialTableState, setTable, type TableObject } from './store';

const CURSOR_TTL_MS = 8000;
/** How often a client reconciles against the server event log in case a live update was lost. */
const CATCH_UP_MS = 20_000;
/** Revisions are allocated before their write lands, so re-scan a small window behind the head. */
const CATCH_UP_OVERLAP = 25;

export class SyncEngine {
  private transport: RealtimeTransport;
  private unsubs: (() => void)[] = [];
  private seen = new Set<string>();
  private buffer: DurableEvent[] | null = null;
  private resyncing = false;
  private resyncQueued = false;
  private disposed = false;
  private cursorSeq = 0;
  private lastCursorSent = 0;
  private pendingCursor: CursorPacket | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private sweep: ReturnType<typeof setInterval>;
  private presenceChannel: string | null = null;
  private stops: (() => void)[] = [];
  private snapshotRevision = 0;
  private catchUpBase = 0;
  private catchUpTimer: ReturnType<typeof setInterval> | null = null;
  private catchingUp = false;

  constructor(
    private sessionId: string,
    private view: 'auto' | 'shared',
  ) {
    setTable(initialTableState());
    this.transport = createTransport();
    this.stops.push(this.transport.onStatus((s) => getTable().status !== 'denied' && setTable({ status: s })));
    this.stops.push(this.transport.onReconnect(() => void this.resync('reconnected')));
    this.sweep = setInterval(() => this.expireEphemeral(), 1000);
    window.addEventListener('beforeunload', this.onUnload);
    // The Shared Display never polls: the event log is per-viewer and a GM's log includes GM-only items.
    if (view !== 'shared') {
      this.catchUpTimer = setInterval(() => void this.catchUp(), CATCH_UP_MS);
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  async start() {
    await this.resync('initial');
  }

  dispose() {
    this.disposed = true;
    this.sendPresence({ type: 'LEAVE' });
    window.removeEventListener('beforeunload', this.onUnload);
    clearInterval(this.sweep);
    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    for (const u of this.unsubs) u();
    for (const s of this.stops) s();
    this.transport.close();
  }

  private onUnload = () => this.sendPresence({ type: 'LEAVE' });
  private onVisible = () => document.visibilityState === 'visible' && void this.catchUp();

  /**
   * Pull-based safety net for lost live updates: fetch this viewer's events
   * from the log and apply any not yet seen (deduplicated by event id).
   */
  async catchUp() {
    if (this.disposed || this.catchingUp || this.resyncing || this.buffer) return;
    this.catchingUp = true;
    try {
      const r = await api<{ events: DurableEvent[]; revision: number; truncated: boolean }>(`/sessions/${this.sessionId}/events?since=${this.catchUpBase}`);
      if (this.disposed) return;
      if (r.truncated) return void this.resync('catch-up');
      const missed = r.events.filter((e) => e.revision > this.snapshotRevision && !this.seen.has(e.eventId));
      for (const e of missed) this.applyDurable(e);
      this.catchUpBase = Math.max(this.snapshotRevision, r.revision - CATCH_UP_OVERLAP, 0);
    } catch {
      // Network blips are fine; the next tick retries.
    } finally {
      this.catchingUp = false;
    }
  }

  /** Full resubscribe + snapshot. Coalesces concurrent requests. */
  async resync(reason: string) {
    if (this.disposed) return;
    if (this.resyncing) {
      this.resyncQueued = true;
      return;
    }
    this.resyncing = true;
    try {
      const path = `/sessions/${this.sessionId}/snapshot${this.view === 'shared' ? '?as=shared' : ''}`;
      // Fetch once to learn the authorised channels and epoch, subscribe, then fetch again for a consistent base.
      let snap = await api<SessionSnapshotDto>(path);
      if (this.disposed) return;
      const channelsChanged = JSON.stringify(snap.channels) !== JSON.stringify(getTable().snapshot?.channels);
      if (channelsChanged || reason === 'reconnected' || reason === 'access') {
        for (const u of this.unsubs) u();
        this.unsubs = [];
        this.buffer = [];
        for (const ch of snap.channels) {
          const isPresence = ch.startsWith('/presence/');
          if (isPresence) this.presenceChannel = ch;
          this.unsubs.push(await this.transport.subscribe(ch, (e) => (isPresence ? this.onPresence(e as PresenceEvent) : this.onDurable(e as DurableEvent))));
        }
        snap = await api<SessionSnapshotDto>(path);
        if (this.disposed) return;
      } else {
        this.buffer = [];
      }
      this.applySnapshot(snap);
      this.snapshotRevision = snap.revision;
      this.catchUpBase = Math.max(0, snap.revision - CATCH_UP_OVERLAP);
      const buffered = (this.buffer ?? []).filter((e) => e.revision > snap.revision).sort((a, b) => a.revision - b.revision);
      this.buffer = null;
      for (const e of buffered) this.applyDurable(e);
      if (getTable().status === 'loading' || getTable().status === 'error') setTable({ status: 'connected' });
    } catch (err) {
      if (this.disposed) return;
      if (err instanceof SubscribeDenied || (err instanceof ApiError && (err.status === 403 || err.status === 404))) {
        setTable({ status: 'denied', error: err instanceof ApiError ? err.message : 'You no longer have access to this session.' });
      } else {
        setTable({ status: 'error', error: (err as Error).message });
        setTimeout(() => void this.resync('retry'), 3000);
      }
    } finally {
      this.resyncing = false;
      if (this.resyncQueued) {
        this.resyncQueued = false;
        void this.resync('queued');
      }
    }
  }

  private applySnapshot(snap: SessionSnapshotDto) {
    const objects: Record<string, TableObject> = {};
    for (const o of snap.scene?.objects ?? []) objects[o.id] = o;
    const prev = getTable();
    const sceneChanged = prev.snapshot?.scene?.scene.id !== snap.scene?.scene.id;
    setTable({
      snapshot: snap,
      objects,
      fog: snap.scene?.fog ?? { initial: 'revealed', ops: [] },
      fogVersion: prev.fogVersion + 1,
      lastFogOp: null,
      chat: snap.chat.length || this.view === 'shared' ? snap.chat : prev.chat,
      // The snapshot carries the latest 60 visible messages; assume older ones may exist.
      chatHasMore: snap.chat.length >= 60,
      revision: snap.revision,
      error: null,
      ...(sceneChanged ? { selectedId: null, cursors: {} } : {}),
    });
    for (const m of snap.chat) this.seen.add(`chat:${m.id}`);
  }

  private onDurable(e: DurableEvent) {
    if (this.disposed || !e || !Array.isArray(e.items)) return;
    if (this.buffer) {
      this.buffer.push(e);
      return;
    }
    this.applyDurable(e);
  }

  private applyDurable(e: DurableEvent) {
    if (this.seen.has(e.eventId)) return;
    this.seen.add(e.eventId);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
    for (const item of e.items) this.applyItem(item);
    setTable((s) => ({ revision: Math.max(s.revision, e.revision) }));
  }

  private applyItem(item: DurableEventBody) {
    const s = getTable();
    const sceneId = s.snapshot?.scene?.scene.id;
    switch (item.type) {
      case 'SCENE_OBJECT_UPSERTED':
        if (item.object.sceneId !== sceneId) return;
        // Ignore stale echoes (e.g. our own optimistic move already ahead).
        if ((s.objects[item.object.id]?.revision ?? 0) > item.object.revision) return;
        setTable({ objects: { ...s.objects, [item.object.id]: item.object } });
        return;
      case 'SCENE_OBJECT_REMOVED': {
        if (item.sceneId !== sceneId) return;
        const { [item.objectId]: _gone, ...rest } = s.objects;
        setTable({ objects: rest, selectedId: s.selectedId === item.objectId ? null : s.selectedId });
        return;
      }
      case 'FOG_UPDATED':
        if (item.sceneId !== sceneId) return;
        setTable({ fog: { ...s.fog, ops: [...s.fog.ops, item.op] }, lastFogOp: item.op, fogVersion: s.fogVersion + 1 });
        return;
      case 'FOG_RESET':
        if (item.sceneId !== sceneId) return;
        setTable({ fog: { initial: item.initial, ops: [] }, lastFogOp: null, fogVersion: s.fogVersion + 1 });
        return;
      case 'ACTIVE_SCENE_CHANGED':
        if (!s.snapshot?.me.isGM || this.view === 'shared') toast.message('The GM changed the scene');
        void this.resync('scene');
        return;
      case 'SESSION_UPDATED': {
        const was = s.snapshot?.session.status;
        if (s.snapshot) setTable({ snapshot: { ...s.snapshot, session: { ...s.snapshot.session, ...item.session } } });
        if (was !== item.session.status) {
          if (item.session.status === 'ENDED') toast.message('The session has ended. Everything is saved.');
          // Players move between waiting and table views on status changes.
          void this.resync('status');
        }
        return;
      }
      case 'SCENE_UPDATED':
        if (s.snapshot?.scene && item.scene.id === sceneId) setTable({ snapshot: { ...s.snapshot, scene: { ...s.snapshot.scene, scene: item.scene } } });
        return;
      case 'CHAT_MESSAGE_CREATED':
        if (this.seen.has(`chat:${item.message.id}`)) return;
        this.seen.add(`chat:${item.message.id}`);
        setTable({ chat: [...s.chat.slice(-999), item.message], unread: s.unread + 1 });
        return;
      case 'PRESENTER_FOCUS':
        if (item.focus.sceneId === sceneId) setTable({ focus: { ...item.focus.center, zoom: item.focus.zoom, at: Date.now() } });
        return;
      case 'INITIATIVE_UPDATED':
        if (s.snapshot) setTable({ snapshot: { ...s.snapshot, session: { ...s.snapshot.session, initiative: item.initiative } } });
        return;
      case 'CHARACTER_UPDATED': {
        const cid = s.snapshot?.campaign.id;
        if (cid) {
          void queryClient.invalidateQueries({ queryKey: ['character', cid, item.characterId] });
          void queryClient.invalidateQueries({ queryKey: ['characters', cid] });
        }
        return;
      }
      case 'JOURNAL_UPDATED': {
        const cid = s.snapshot?.campaign.id;
        if (cid) void queryClient.invalidateQueries({ queryKey: ['journal', cid] });
        if (item.shared && s.snapshot?.viewMode !== 'gm') toast.message(`The GM shared “${item.title}”`, { description: 'Open the Journal tab to read it.' });
        return;
      }
      case 'SCENE_REFRESH':
        if (item.sceneId === sceneId) {
          if (item.reason === 'checkpoint' && s.snapshot?.viewMode !== 'gm') toast.message('The GM restored this scene to an earlier point.');
          void this.resync('refresh');
        }
        return;
      case 'ACCESS_CHANGED':
        void this.resync('access');
        return;
    }
  }

  // ---------------------------------------------------------------- presence

  private onPresence(e: PresenceEvent) {
    if (this.disposed) return;
    const s = getTable();
    if (!e?.actor || e.actor.sub === s.snapshot?.me.sub) return;
    if (e.type === 'LEAVE') {
      const { [e.actor.sub]: _gone, ...rest } = s.cursors;
      setTable({ cursors: rest });
      return;
    }
    const c = e.cursor;
    if (c.sceneId !== s.snapshot?.scene?.scene.id) return;
    const map = s.snapshot.scene.map;
    setTable({ cursors: { ...s.cursors, [e.actor.sub]: { sub: e.actor.sub, name: e.actor.displayName, color: e.actor.color, nx: c.nx, ny: c.ny, sceneId: c.sceneId, at: Date.now() } } });
    if (c.ping) this.addPing(c.nx * map.widthPx, c.ny * map.heightPx, e.actor.color);
  }

  addPing(x: number, y: number, color: string) {
    const ping = { id: Math.random(), x, y, color, at: Date.now() };
    setTable((s) => ({ pings: [...s.pings.slice(-10), ping] }));
  }

  private expireEphemeral() {
    const now = Date.now();
    const s = getTable();
    const cursors = Object.fromEntries(Object.entries(s.cursors).filter(([, c]) => now - c.at < CURSOR_TTL_MS));
    const pings = s.pings.filter((p) => now - p.at < 2500);
    if (Object.keys(cursors).length !== Object.keys(s.cursors).length || pings.length !== s.pings.length) setTable({ cursors, pings });
  }

  private sendPresence(body: unknown) {
    if (this.presenceChannel && this.view !== 'shared') this.transport.publish(this.presenceChannel, body);
  }

  /** Throttled to ~12 Hz with a trailing send so the final position always arrives. */
  sendCursor(nx: number, ny: number, ping = false) {
    const s = getTable();
    const sceneId = s.snapshot?.scene?.scene.id;
    if (!sceneId || s.hideMyCursor || this.view === 'shared') return;
    const packet: CursorPacket = { sceneId, nx, ny, seq: ++this.cursorSeq, ...(ping ? { ping: true } : {}) };
    const now = performance.now();
    const interval = 1000 / 12;
    if (ping || now - this.lastCursorSent >= interval) {
      this.lastCursorSent = now;
      this.pendingCursor = null;
      this.sendPresence({ type: 'CURSOR', cursor: packet });
      return;
    }
    this.pendingCursor = packet;
    if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        if (this.pendingCursor) {
          this.lastCursorSent = performance.now();
          this.sendPresence({ type: 'CURSOR', cursor: this.pendingCursor });
          this.pendingCursor = null;
        }
      }, interval - (now - this.lastCursorSent));
    }
  }

  leaveCursor() {
    this.sendPresence({ type: 'LEAVE' });
  }

  /** Prepends an older page of chat (visibility filtered by the server). */
  async loadOlderChat() {
    const s = getTable();
    const cid = s.snapshot?.campaign.id;
    const oldest = s.chat[0];
    if (!cid || !oldest) return;
    const page = await chatApi.older(cid, oldest.id);
    const known = new Set(getTable().chat.map((m) => m.id));
    setTable({ chat: [...page.messages.filter((m) => !known.has(m.id)), ...getTable().chat], chatHasMore: page.hasMore });
  }

  // ---------------------------------------------------------------- commands

  async command<T extends CommandType>(type: T, payload: CommandInput<T>['payload']): Promise<CommandResult> {
    return api<CommandResult>('/commands', { body: { commandId: crypto.randomUUID(), sessionId: this.sessionId, type, payload } });
  }

  /** Optimistic token move; reverts and explains if the server rejects it. */
  async moveToken(id: string, x: number, y: number) {
    const s = getTable();
    const prev = s.objects[id];
    if (!prev) return;
    setTable({ objects: { ...s.objects, [id]: { ...prev, x, y } } });
    try {
      const r = await this.command('moveToken', { objectId: id, x, y, expectedObjectRevision: prev.revision });
      const cur = getTable().objects[id];
      const rev = (r.result as { objectRevision?: number } | undefined)?.objectRevision;
      if (cur && rev && cur.revision < rev) setTable({ objects: { ...getTable().objects, [id]: { ...cur, revision: rev } } });
    } catch (e) {
      const cur = getTable().objects;
      if (cur[id]) setTable({ objects: { ...cur, [id]: prev } });
      toast.error((e as Error).message);
      if (e instanceof ApiError && e.code === 'CONFLICT') void this.resync('conflict');
    }
  }
}
