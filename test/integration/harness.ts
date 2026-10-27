/**
 * In-process API harness against DynamoDB Local + MinIO (docker compose).
 * Each run uses a fresh table so tests are isolated and repeatable.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@server/config';
import { createDeps } from '@server/bootstrap';
import { createVerifier, mintDevToken } from '@server/auth/verify';
import { createApp } from '@server/http/app';
import { ensureLocalTable } from '@server/repo/schema';
import type { Publisher } from '@server/realtime/publisher';

export const DYNAMO = process.env.D20_DYNAMO_ENDPOINT ?? 'http://localhost:8000';
export const S3 = process.env.D20_S3_ENDPOINT ?? 'http://localhost:9100';

export async function infraAvailable(): Promise<boolean> {
  try {
    const r = await fetch(DYNAMO, { signal: AbortSignal.timeout(1500) });
    return r.status > 0;
  } catch {
    return false;
  }
}

export type Published = { channel: string; event: { items: { type: string; [k: string]: unknown }[]; [k: string]: unknown } };

export async function createHarness() {
  const table = `d20-test-${randomUUID().slice(0, 8)}`;
  const config = loadConfig({ D20_TABLE: table, D20_BUCKET: 'd20-test-media', D20_DYNAMO_ENDPOINT: DYNAMO, D20_S3_ENDPOINT: S3, D20_DEV_JWT_SECRET: 'test-secret' });
  await ensureLocalTable(DYNAMO, config.region, table);
  const published: Published[] = [];
  const publisher: Publisher = {
    publish: async (channel, events) => {
      for (const e of events) published.push({ channel, event: e as Published['event'] });
    },
  };
  const deps = createDeps({ config, publisher });
  deps.log = process.env.D20_TEST_LOG ? deps.log : () => undefined;
  await deps.blobs.ensureLocalBucket(['*']).catch(() => undefined);
  const app = createApp(deps, createVerifier(config.auth));
  const secret = (config.auth as { secret: string }).secret;

  async function user(name: string, groups: string[] = []) {
    const sub = randomUUID();
    const token = await mintDevToken(secret, { sub, name, email: `${name}@test.dev`, groups });
    const call = async <T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await app.request(`/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as T };
    };
    const command = (sessionId: string, type: string, payload: unknown, commandId: string = randomUUID()) => call('POST', '/commands', { commandId, sessionId, type, payload });
    return { sub, name, token, call, command };
  }

  return { deps, app, user, published, table };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
export type TestUser = Awaited<ReturnType<Harness['user']>>;

/** A tiny valid PNG of the given size (solid colour, uncompressed-ish via zlib). */
export async function makePng(width: number, height: number): Promise<Uint8Array> {
  const { deflateSync } = await import('node:zlib');
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}
