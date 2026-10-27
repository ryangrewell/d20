/**
 * Realtime transport abstraction. Production uses AppSync Events (managed
 * WebSockets with Cognito auth); local development uses the dev server hub.
 * Both enforce authorisation server-side on subscribe and publish.
 */
import { getRuntimeConfig } from '../config';
import { getAuthClient } from '../auth/authClient';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export class SubscribeDenied extends Error {}

export interface RealtimeTransport {
  subscribe(channel: string, onData: (event: unknown) => void): Promise<() => void>;
  publish(channel: string, event: unknown): void;
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  /** Fires after a dropped connection is re-established; subscribers must resync. */
  onReconnect(cb: () => void): () => void;
  close(): void;
}

class Emitter<T> {
  private fns = new Set<(v: T) => void>();
  on(fn: (v: T) => void) {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  }
  emit(v: T) {
    for (const fn of this.fns) fn(v);
  }
}

// ------------------------------------------------------------- local (dev)

class LocalWsTransport implements RealtimeTransport {
  private ws: WebSocket | null = null;
  private seq = 0;
  private subs = new Map<string, { channel: string; onData: (e: unknown) => void; resolve?: () => void; reject?: (e: Error) => void }>();
  private status = new Emitter<ConnectionStatus>();
  private reconnect = new Emitter<void>();
  private closed = false;
  private attempts = 0;
  private ready: Promise<void> | null = null;
  private everConnected = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(private url: string) {
    this.ready = this.open();
    window.addEventListener('online', this.onOnline);
  }

  private onOnline = () => {
    if (!this.ws || this.ws.readyState > 1) void this.open();
  };

  private async open(): Promise<void> {
    this.status.emit(this.everConnected ? 'reconnecting' : 'connecting');
    const token = await (await getAuthClient()).getIdToken();
    return new Promise((resolve) => {
      const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(token ?? '')}`);
      this.ws = ws;
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; id?: string; event?: unknown; reason?: string };
        if (msg.type === 'connection_ack') {
          const wasReconnect = this.everConnected;
          this.everConnected = true;
          this.attempts = 0;
          this.status.emit('connected');
          for (const [id, s] of this.subs) ws.send(JSON.stringify({ type: 'subscribe', id, channel: s.channel }));
          this.keepalive = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ka"}'), 25_000);
          resolve();
          if (wasReconnect) this.reconnect.emit();
          return;
        }
        const sub = msg.id ? this.subs.get(msg.id) : undefined;
        if (!sub) return;
        if (msg.type === 'subscribe_success') {
          sub.resolve?.();
          delete sub.resolve;
          delete sub.reject;
        } else if (msg.type === 'subscribe_error') {
          this.subs.delete(msg.id!);
          sub.reject?.(new SubscribeDenied(msg.reason ?? 'denied'));
        } else if (msg.type === 'data') sub.onData(msg.event);
      };
      ws.onclose = () => {
        if (this.keepalive) clearInterval(this.keepalive);
        if (this.closed) return;
        this.status.emit(navigator.onLine ? 'reconnecting' : 'offline');
        const delay = Math.min(10_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
        setTimeout(() => {
          if (!this.closed) this.ready = this.open();
        }, delay);
        resolve();
      };
    });
  }

  async subscribe(channel: string, onData: (e: unknown) => void) {
    await this.ready;
    const id = `s${++this.seq}`;
    await new Promise<void>((resolve, reject) => {
      this.subs.set(id, { channel, onData, resolve, reject });
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'subscribe', id, channel }));
    });
    return () => {
      this.subs.delete(id);
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'unsubscribe', id }));
    };
  }

  publish(channel: string, event: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'publish', id: `p${++this.seq}`, channel, events: [event] }));
  }

  onStatus(cb: (s: ConnectionStatus) => void) {
    return this.status.on(cb);
  }
  onReconnect(cb: () => void) {
    return this.reconnect.on(cb);
  }
  close() {
    this.closed = true;
    window.removeEventListener('online', this.onOnline);
    if (this.keepalive) clearInterval(this.keepalive);
    this.ws?.close();
  }
}

// ---------------------------------------------------------- AppSync Events

class AppSyncTransport implements RealtimeTransport {
  private status = new Emitter<ConnectionStatus>();
  private reconnect = new Emitter<void>();
  private channels: { close: () => void }[] = [];
  private hubStop: (() => void) | null = null;
  private wasDisrupted = false;

  constructor() {
    void this.watch();
  }

  private async watch() {
    const { Hub } = await import('aws-amplify/utils');
    const { CONNECTION_STATE_CHANGE, ConnectionState } = await import('aws-amplify/data');
    this.hubStop = Hub.listen('api', ({ payload }) => {
      if (payload.event !== CONNECTION_STATE_CHANGE) return;
      const state = (payload.data as { connectionState: string }).connectionState;
      if (state === ConnectionState.Connected) {
        this.status.emit('connected');
        if (this.wasDisrupted) this.reconnect.emit();
        this.wasDisrupted = false;
      } else if (state === ConnectionState.Connecting) this.status.emit('connecting');
      else {
        this.wasDisrupted = true;
        this.status.emit(state === ConnectionState.ConnectionDisrupted && !navigator.onLine ? 'offline' : 'reconnecting');
      }
    });
  }

  async subscribe(channel: string, onData: (e: unknown) => void) {
    const { events } = await import('aws-amplify/data');
    const ch = await events.connect(channel);
    const sub = ch.subscribe({
      next: (message: unknown) => onData(unwrapAppSyncEvent(message)),
      error: (err: unknown) => console.warn('[d20] realtime subscription error', channel.split('/').slice(0, 3).join('/'), err),
    }) as { ready?: Promise<unknown> };
    // Amplify resolves `ready` on subscribe_success and rejects on subscribe_error (e.g. our onSubscribe handler denying access).
    try {
      await sub.ready;
    } catch (err) {
      ch.close();
      throw new SubscribeDenied(String((err as Error)?.message ?? 'denied'));
    }
    this.channels.push(ch);
    this.status.emit('connected');
    return () => ch.close();
  }

  publish(channel: string, event: unknown) {
    void import('aws-amplify/data').then(({ events }) => events.post(channel, event as never).catch(() => undefined));
  }
  onStatus(cb: (s: ConnectionStatus) => void) {
    return this.status.on(cb);
  }
  onReconnect(cb: () => void) {
    return this.reconnect.on(cb);
  }
  close() {
    for (const c of this.channels) c.close();
    this.hubStop?.();
  }
}

/** Amplify delivers `{ id, type, event }` with `event` already parsed; tolerate raw or string payloads too. */
export function unwrapAppSyncEvent(message: unknown): unknown {
  const inner = message && typeof message === 'object' && 'event' in message ? (message as { event: unknown }).event : message;
  if (typeof inner !== 'string') return inner;
  try {
    return JSON.parse(inner);
  } catch {
    return null;
  }
}

export function createTransport(): RealtimeTransport {
  const cfg = getRuntimeConfig();
  return cfg.mode === 'local' ? new LocalWsTransport(cfg.wsUrl) : new AppSyncTransport();
}
