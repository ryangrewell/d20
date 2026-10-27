/**
 * Phase 4 gameplay through the UI: character sheet with dice, loot pickup
 * into inventory, creature library spawn and the initiative tracker.
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

const table = (p: Page) => p.evaluate(() => (window as any).__d20?.getTable());

test('character sheet, dice, loot pickup and initiative through the UI', async ({ browser }) => {
  const api = await request.newContext({ baseURL: 'http://localhost:8787' });
  const id = Date.now().toString(36);
  const gm = await account(api, `gm-g-${id}@e2e.local`, 'GM');
  const pl = await account(api, `pl-g-${id}@e2e.local`, `Rook ${id}`);

  const campaign = await gm.call('POST', '/campaigns', { title: `Loot ${id}` });
  const inv = await gm.call('POST', `/campaigns/${campaign.id}/invites`, {});
  await pl.call('POST', '/invites/accept', { token: inv.token });
  const img = png(400, 300);
  const intent = await gm.call('POST', `/campaigns/${campaign.id}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: img.length });
  await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([new Uint8Array(img)]) });
  const map = await gm.call('POST', `/campaigns/${campaign.id}/maps`, { assetId: intent.assetId, name: 'Vault' });
  const scene = await gm.call('POST', `/campaigns/${campaign.id}/scenes`, { mapId: map.id, name: 'Vault', fogInitial: 'revealed' });
  const session = await gm.call('POST', `/campaigns/${campaign.id}/sessions`, {});
  await gm.cmd(session.id, 'switchActiveScene', { sceneId: scene.id });
  await gm.call('POST', `/sessions/${session.id}/transition`, { action: 'start' });
  const hero = await pl.call('POST', `/campaigns/${campaign.id}/characters`, { name: 'Rook', sheet: { dex: 14, attacks: [{ name: 'Dagger', roll: '1d20+4', damage: '1d4+2' }] } });
  await gm.cmd(session.id, 'spawnSceneObject', { sceneId: scene.id, objectType: 'PC', x: 100, y: 100, characterId: hero.id });
  const chest = await gm.cmd(session.id, 'spawnSceneObject', { sceneId: scene.id, objectType: 'LOOT', x: 200, y: 150, label: 'Chest', visibility: 'VISIBLE_TO_ALL', loot: [{ id: 'g', name: 'Silver ring', quantity: 1 }] });
  const ogre = await gm.call('POST', `/campaigns/${campaign.id}/creatures`, { name: 'Ogre', hpMax: 59, initiativeMod: -1 });
  await gm.cmd(session.id, 'spawnSceneObject', { sceneId: scene.id, objectType: 'CREATURE', x: 300, y: 150, templateId: ogre.id, visibility: 'GM_ONLY' });

  const plCtx = await browser.newContext();
  const gmCtx = await browser.newContext();
  const p = await plCtx.newPage();
  const g = await gmCtx.newPage();
  const tableUrl = `/campaigns/${campaign.id}/sessions/${session.id}`;
  await signedInPage(p, pl.token, tableUrl);
  await signedInPage(g, gm.token, tableUrl);
  await expect(p.getByText('Connected')).toBeVisible();

  // Character tab shows the sheet; rolling the dagger posts a server roll to chat.
  await p.getByRole('tab', { name: 'Character' }).click();
  await expect(p.getByRole('textbox', { name: 'Character name' })).toHaveValue('Rook');
  await p.getByRole('button', { name: /Roll To hit \/ check for Dagger/ }).click();
  await p.getByRole('tab', { name: 'Chat' }).click();
  await expect(p.getByText('Dagger to hit / check · 1d20+4', { exact: false })).toBeVisible();

  // Select the chest and take the ring; it lands in the inventory and the chest disappears for everyone.
  await p.evaluate((cid) => (window as any).__d20.setTable({ selectedId: cid }), chest.result.objectId);
  await expect(p.getByRole('dialog', { name: 'Loot' })).toBeVisible();
  await p.getByRole('button', { name: 'Take 1' }).click();
  await expect.poll(async () => Object.keys((await table(g)).objects).includes(chest.result.objectId)).toBe(false);
  await p.getByRole('tab', { name: 'Character' }).click();
  await expect(p.getByText('Silver ring')).toBeVisible();

  // GM starts combat; the player sees their own entry but never the hidden ogre.
  await g.getByRole('button', { name: 'Start combat' }).click();
  await expect(g.getByText('Round 1')).toBeVisible();
  await expect(g.getByRole('listitem').filter({ hasText: 'Ogre' })).toBeVisible();
  await expect(p.getByText('Round 1')).toBeVisible();
  const playerEntries = (await table(p)).snapshot.session.initiative.entries.map((e: { label: string }) => e.label);
  expect(playerEntries).toEqual(['Rook']);
  await expect(p.getByLabel('Initiative order').getByText('Ogre')).toHaveCount(0);

  // GM places a two-ogre encounter from GM tools; both land hidden, the player sees neither.
  const enc = await gm.call('POST', `/campaigns/${campaign.id}/encounters`, { name: 'Ogre pair', groups: [{ creatureId: ogre.id, count: 2 }] });
  await g.reload();
  await g.getByRole('tab', { name: 'GM tools' }).click();
  await g.getByLabel('Place an encounter').selectOption(enc.id);
  const box = (await g.getByRole('application').boundingBox())!;
  await g.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await expect.poll(async () => Object.values((await table(g)).objects).map((o: any) => o.appearance.label)).toEqual(expect.arrayContaining(['Ogre 1', 'Ogre 2']));
  expect(Object.values((await table(p)).objects).map((o: any) => o.appearance.label)).not.toContain('Ogre 1');

  // Ctrl/Cmd+Z undoes the whole encounter placement.
  await g.getByRole('application').click({ position: { x: 5, y: 5 }, button: 'right' });
  await g.keyboard.press('ControlOrMeta+z');
  await expect(g.getByText('Undid: Place encounter')).toBeVisible();
  await expect.poll(async () => Object.values((await table(g)).objects).map((o: any) => o.appearance.label)).not.toContain('Ogre 1');

  // GM shares a private journal entry from the table; the player is notified and can read it.
  await gm.call('POST', `/campaigns/${campaign.id}/journal`, { title: 'Torn map', body: 'X marks the crypt.' });
  await g.getByRole('tab', { name: 'Journal' }).click();
  await g.getByRole('button', { name: /Torn map/ }).click();
  await g.getByRole('button', { name: 'Share with everyone' }).click();
  await expect(p.getByText('The GM shared “Torn map”')).toBeVisible();
  await p.getByRole('tab', { name: 'Journal' }).click();
  await p.getByRole('button', { name: /Torn map/ }).click();
  await expect(p.getByText('X marks the crypt.')).toBeVisible();

  await plCtx.close();
  await gmCtx.close();
  await api.dispose();
});
