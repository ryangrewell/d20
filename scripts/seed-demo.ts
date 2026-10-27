/**
 * LOCAL DEVELOPMENT ONLY. Seeds demo accounts and a ready-to-play campaign
 * through the running dev server's public API (npm run dev must be running).
 *
 *   GM:      gm@d20.local      / d20-demo-pass
 *   Player:  player@d20.local  / d20-demo-pass
 *   Player:  player2@d20.local / d20-demo-pass
 *
 * These credentials exist only in the local dev auth emulator.
 */
import { deflateSync } from 'node:zlib';

const API = process.env.D20_API ?? 'http://localhost:8787/api';
const PASSWORD = 'd20-demo-pass';

async function call<T = Record<string, unknown>>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${path}: ${json.error?.message ?? res.status}`);
  return json;
}

async function account(email: string, displayName: string): Promise<{ token: string; sub: string }> {
  try {
    await call('/dev/auth/sign-up', { body: { email, password: PASSWORD, displayName } });
    const { code } = await call<{ code: string }>(`/dev/auth/last-code?email=${encodeURIComponent(email)}`);
    await call('/dev/auth/confirm', { body: { email, code } });
  } catch (e) {
    if (!String((e as Error).message).includes('already exists')) throw e;
  }
  const r = await call<{ idToken: string; user: { sub: string } }>('/dev/auth/sign-in', { body: { email, password: PASSWORD } });
  return { token: r.idToken, sub: r.user.sub };
}

/** A procedurally drawn dungeon floor: 1500x1000 px where 50 px = 5 ft. */
function dungeonPng(): Uint8Array {
  const W = 1500;
  const H = 1000;
  const px = Buffer.alloc((W * 3 + 1) * H);
  const rooms = [
    [100, 100, 400, 300],
    [600, 100, 350, 250],
    [1050, 150, 350, 400],
    [150, 550, 500, 350],
    [750, 500, 250, 400],
  ];
  const halls = [
    [500, 220, 100, 60],
    [950, 200, 100, 60],
    [350, 400, 60, 150],
    [650, 650, 100, 60],
    [1000, 700, 200, 60],
    [1170, 550, 60, 200],
  ];
  const inside = (x: number, y: number, list: number[][]) => list.some(([rx, ry, rw, rh]) => x >= rx! && x < rx! + rw! && y >= ry! && y < ry! + rh!);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    px[row] = 0;
    for (let x = 0; x < W; x++) {
      const floor = inside(x, y, rooms) || inside(x, y, halls);
      const n = ((x * 7919 + y * 104729) % 23) - 11;
      let r = 28 + n * 0.3;
      let g = 25 + n * 0.3;
      let b = 32 + n * 0.3;
      if (floor) {
        const tile = x % 50 === 0 || y % 50 === 0;
        r = tile ? 120 : 168 + n;
        g = tile ? 108 : 154 + n;
        b = tile ? 92 : 128 + n;
      }
      // Scale bar: 200 px = 20 ft along the bottom.
      if (y >= 960 && y < 968 && x >= 1250 && x < 1450) [r, g, b] = (x - 1250) % 100 < 50 ? [230, 220, 200] : [40, 36, 30];
      const o = row + 1 + x * 3;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const v of buf) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
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
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]));
}

async function main() {
  const gm = await account('gm@d20.local', 'Game Master');
  const p1 = await account('player@d20.local', 'Aria');
  const p2 = await account('player2@d20.local', 'Bram');

  const campaign = await call<{ id: string }>('/campaigns', { token: gm.token, body: { title: 'The Sunken Crypt', description: 'A demo campaign seeded for local development.' } });
  const inv = await call<{ token: string }>(`/campaigns/${campaign.id}/invites`, { token: gm.token, body: {} });
  await call('/invites/accept', { token: p1.token, body: { token: inv.token } });
  await call('/invites/accept', { token: p2.token, body: { token: inv.token } });

  const png = dungeonPng();
  const intent = await call<{ assetId: string; uploadUrl: string }>(`/campaigns/${campaign.id}/maps/upload-intent`, { token: gm.token, body: { fileName: 'crypt.png', contentType: 'image/png', bytes: png.length } });
  const put = await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
  if (!put.ok) throw new Error(`upload failed ${put.status}`);
  const map = await call<{ id: string }>(`/campaigns/${campaign.id}/maps`, { token: gm.token, body: { assetId: intent.assetId, name: 'Sunken Crypt', category: 'dungeon' } });
  // Scale bar: 200 px = 20 ft. 5-ft square grid aligned to the tiles.
  await call(`/campaigns/${campaign.id}/maps/${map.id}`, {
    token: gm.token,
    method: 'PATCH',
    body: {
      calibration: { a: { x: 1250, y: 964 }, b: { x: 1450, y: 964 }, enteredDistance: 20, enteredUnit: 'ft', pixelsPerMeter: 200 / (20 * 0.3048) },
      grid: { type: 'square', intervalMeters: 1.524, displayInterval: 5, displayUnit: 'ft', originX: 0, originY: 0, rotationRadians: 0, snapEnabled: true, showEnabled: true, opacity: 0.25 },
    },
  });
  const scene = await call<{ id: string }>(`/campaigns/${campaign.id}/scenes`, { token: gm.token, body: { mapId: map.id, name: 'Crypt entrance', fogInitial: 'covered' } });
  const session = await call<{ id: string }>(`/campaigns/${campaign.id}/sessions`, { token: gm.token, body: { title: 'Into the crypt' } });
  const cmd = (type: string, payload: unknown) => call('/commands', { token: gm.token, body: { commandId: crypto.randomUUID(), sessionId: session.id, type, payload } });
  await cmd('switchActiveScene', { sceneId: scene.id });
  await call(`/sessions/${session.id}/transition`, { token: gm.token, body: { action: 'start' } });
  await cmd('updateFog', { sceneId: scene.id, op: { mode: 'reveal', shape: { kind: 'rect', x: 100, y: 100, w: 400, h: 300 } } });
  await cmd('spawnSceneObject', { sceneId: scene.id, objectType: 'PC', x: 225, y: 225, label: 'Aria', tint: '#29a3a3', assignedControllerSub: p1.sub });
  await cmd('spawnSceneObject', { sceneId: scene.id, objectType: 'PC', x: 325, y: 275, label: 'Bram', tint: '#f3a712', assignedControllerSub: p2.sub });
  await cmd('spawnSceneObject', { sceneId: scene.id, objectType: 'CREATURE', x: 775, y: 225, label: 'Skeleton', tint: '#d9d4c7', visibility: 'VISIBLE_TO_ALL' });
  await cmd('spawnSceneObject', { sceneId: scene.id, objectType: 'CREATURE', x: 1225, y: 375, label: 'Wight', tint: '#5b4a8a', visibility: 'GM_ONLY', gmNotes: 'Waits until the party opens the sarcophagus.' });
  await cmd('spawnSceneObject', { sceneId: scene.id, objectType: 'LOOT', x: 875, y: 825, label: 'Reliquary', tint: '#a07b2c', visibility: 'GM_ONLY' });

  console.log(`\nSeeded "The Sunken Crypt".`);
  console.log(`  GM:      gm@d20.local / ${PASSWORD}`);
  console.log(`  Players: player@d20.local, player2@d20.local / ${PASSWORD}`);
  console.log(`  Table:   http://localhost:5173/campaigns/${campaign.id}/sessions/${session.id}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
