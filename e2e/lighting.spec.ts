/**
 * Torchlight and room reveal through the UI: the GM draws rooms on an uploaded map,
 * switches on room reveal at the table, and a room clears for the player on entry.
 * Setup goes through the API; the behaviour under test goes through the UI.
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

const PASSWORD = 'e2e-test-password';

function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h, 120);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const t = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = t[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(type), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function account(api: APIRequestContext, email: string, name: string) {
  await api.post('/api/dev/auth/sign-up', { data: { email, password: PASSWORD, displayName: name } });
  const { code } = await (await api.get(`/api/dev/auth/last-code?email=${encodeURIComponent(email)}`)).json();
  await api.post('/api/dev/auth/confirm', { data: { email, code } });
  const r = await (await api.post('/api/dev/auth/sign-in', { data: { email, password: PASSWORD } })).json();
  const token = r.idToken as string;
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await api.fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
    const json = await res.json();
    if (!res.ok()) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json;
  };
  return { token, sub: r.user.sub as string, call, cmd: (sessionId: string, type: string, payload: unknown) => call('POST', '/commands', { commandId: crypto.randomUUID(), sessionId, type, payload }) };
}

async function signedInPage(page: Page, token: string, path: string) {
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('d20.dev.session', t), token);
  await page.goto(path);
}

test('GM draws rooms on an uploaded map, and a room reveals when a character walks in', async ({ browser }) => {
  const api = await request.newContext({ baseURL: 'http://localhost:8787' });
  const id = Date.now().toString(36);
  const gm = await account(api, `gm-l-${id}@e2e.local`, 'GM');
  const pl = await account(api, `pl-l-${id}@e2e.local`, `Ivy ${id}`);
  const campaign = await gm.call('POST', '/campaigns', { title: `Rooms ${id}` });
  const inv = await gm.call('POST', `/campaigns/${campaign.id}/invites`, {});
  await pl.call('POST', '/invites/accept', { token: inv.token });
  const img = png(600, 400);
  const intent = await gm.call('POST', `/campaigns/${campaign.id}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: img.length });
  await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([new Uint8Array(img)]) });
  const map = await gm.call('POST', `/campaigns/${campaign.id}/maps`, { assetId: intent.assetId, name: 'Two rooms' });
  await gm.call('PATCH', `/campaigns/${campaign.id}/maps/${map.id}`, { calibration: { a: { x: 0, y: 0 }, b: { x: 600, y: 0 }, enteredDistance: 60, enteredUnit: 'm', pixelsPerMeter: 10 } });

  // --- GM draws two rectangle rooms, a building and a wall line on Scale & grid, and saves.
  const g = await (await browser.newContext()).newPage();
  await signedInPage(g, gm.token, `/campaigns/${campaign.id}/maps/${map.id}`);
  await g.getByRole('button', { name: 'Rectangle' }).click();
  const at = (p: { x: number; y: number }) => g.evaluate((pt) => (window as any).__d20setup.mapToClient(pt), p);
  for (const [a, b] of [[{ x: 20, y: 20 }, { x: 280, y: 380 }], [{ x: 320, y: 20 }, { x: 580, y: 380 }]] as const) {
    const [s, e] = [await at(a), await at(b)];
    await g.mouse.move(s.x, s.y);
    await g.mouse.down();
    await g.mouse.move(e.x, e.y, { steps: 5 });
    await g.mouse.up();
  }
  await g.getByRole('radio', { name: 'Building' }).click();
  {
    const [s, e] = [await at({ x: 100, y: 300 }), await at({ x: 150, y: 350 })];
    await g.mouse.move(s.x, s.y);
    await g.mouse.down();
    await g.mouse.move(e.x, e.y, { steps: 5 });
    await g.mouse.up();
  }
  await g.getByRole('button', { name: 'Wall line' }).click();
  for (const pt of [{ x: 40, y: 390 }, { x: 200, y: 390 }]) {
    const c = await at(pt);
    await g.mouse.click(c.x, c.y);
  }
  const end = await at({ x: 200, y: 390 });
  await g.mouse.dblclick(end.x, end.y);
  await expect(g.getByRole('list', { name: 'Rooms and buildings' }).getByRole('listitem')).toHaveCount(3);
  await expect(g.getByText('2 rooms · 1 building · 1 wall line · 0 doorways')).toBeVisible();
  await g.getByRole('button', { name: 'Save walls' }).click();
  await expect
    .poll(async () => {
      const w = (await gm.call('GET', `/campaigns/${campaign.id}/maps/${map.id}`)).map.walls;
      return w && [w.rooms.length, w.rooms.filter((r: { kind?: string }) => r.kind === 'building').length, w.lines?.length];
    })
    .toEqual([3, 1, 1]);

  // --- Live table: PC between the rooms; the GM turns on room reveal from the GM tools.
  const scene = await gm.call('POST', `/campaigns/${campaign.id}/scenes`, { mapId: map.id, name: 'Two rooms', fogInitial: 'covered' });
  const session = await gm.call('POST', `/campaigns/${campaign.id}/sessions`, {});
  await gm.cmd(session.id, 'switchActiveScene', { sceneId: scene.id });
  await gm.call('POST', `/sessions/${session.id}/transition`, { action: 'start' });
  const pc = (await gm.cmd(session.id, 'spawnSceneObject', { sceneId: scene.id, objectType: 'PC', x: 300, y: 200, label: 'Ivy', assignedControllerSub: pl.sub })).result.objectId as string;
  const tableUrl = `/campaigns/${campaign.id}/sessions/${session.id}`;
  await signedInPage(g, gm.token, tableUrl);
  const p = await (await browser.newContext()).newPage();
  await signedInPage(p, pl.token, tableUrl);
  await expect(p.getByText('Connected')).toBeVisible();
  // The checkbox mirrors the scene setting, so it flips once the server confirms.
  const reveal = g.getByRole('checkbox', { name: 'Reveal rooms when a character walks in' });
  await reveal.click();
  await expect(reveal).toBeChecked();

  const fogged = (pt: { x: number; y: number }) => p.evaluate((q) => (window as any).__d20.isFoggedAt(q), pt);
  expect(await fogged({ x: 450, y: 200 })).toBe(true);
  await gm.cmd(session.id, 'moveToken', { objectId: pc, x: 450, y: 200 });
  await expect.poll(() => fogged({ x: 450, y: 100 })).toBe(false);
  expect(await fogged({ x: 150, y: 200 })).toBe(true);
});
