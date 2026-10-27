/**
 * Local stand-in for AppSync Events: a WebSocket hub with the same channel
 * paths and the same authorisation function. Used only in development and
 * integration tests.
 */
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Deps } from '../context';
import type { TokenVerifier } from '../auth/verify';
import type { Publisher } from './publisher';
import { authorizeChannel } from './authorize';
import { PresenceLimiter, sanitizePresence } from './presence';

type Sub = { id: string; channel: string; ws: WebSocket };

export class LocalHub implements Publisher {
  private subs = new Set<Sub>();
  private limiter = new PresenceLimiter();
  readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private deps: Deps,
    private verify: TokenVerifier,
  ) {
    this.wss.on('connection', (ws, req) => void this.onConnection(ws, req));
  }

  async publish(channel: string, events: unknown[]) {
    for (const s of this.subs) {
      if (s.channel !== channel || s.ws.readyState !== s.ws.OPEN) continue;
      for (const event of events) s.ws.send(JSON.stringify({ type: 'data', id: s.id, event }));
    }
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let sub: string;
    try {
      sub = (await this.verify(url.searchParams.get('token') ?? '')).sub;
    } catch {
      ws.close(4401, 'unauthenticated');
      return;
    }
    const mine = new Set<Sub>();
    ws.send(JSON.stringify({ type: 'connection_ack' }));
    ws.on('message', async (data) => {
      let msg: { type?: string; id?: string; channel?: string; events?: unknown[] };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'ka') return;
      if (msg.type === 'subscribe' && typeof msg.id === 'string' && typeof msg.channel === 'string') {
        const decision = await authorizeChannel(this.deps, sub, msg.channel, 'subscribe');
        if (!decision.ok) {
          ws.send(JSON.stringify({ type: 'subscribe_error', id: msg.id, reason: decision.reason }));
          return;
        }
        const s = { id: msg.id, channel: msg.channel, ws };
        this.subs.add(s);
        mine.add(s);
        ws.send(JSON.stringify({ type: 'subscribe_success', id: msg.id }));
        return;
      }
      if (msg.type === 'unsubscribe' && typeof msg.id === 'string') {
        for (const s of mine) {
          if (s.id !== msg.id) continue;
          this.subs.delete(s);
          mine.delete(s);
        }
        return;
      }
      if (msg.type === 'publish' && typeof msg.channel === 'string' && Array.isArray(msg.events)) {
        if (!this.limiter.allow(sub)) return;
        const decision = await authorizeChannel(this.deps, sub, msg.channel, 'publish');
        if (!decision.ok) {
          ws.send(JSON.stringify({ type: 'publish_error', id: msg.id, reason: decision.reason }));
          return;
        }
        const clean = msg.events.slice(0, 5).map((e) => sanitizePresence(e, decision.member)).filter(Boolean);
        if (clean.length) await this.publish(msg.channel, clean);
      }
    });
    ws.on('close', () => {
      for (const s of mine) this.subs.delete(s);
    });
  }
}
