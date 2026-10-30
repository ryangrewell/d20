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

test('GM prepares another scene privately, then moves the players there', async ({ browser }) => {
  const api = await request.newContext({ baseURL: 'http://localhost:8787' });
  const id = Date.now().toString(36);
  const gm = await account(api, `gm-v-${id}@e2e.local`, 'GM');
  const pl = await account(api, `pl-v-${id}@e2e.local`, `Wren ${id}`);
  const campaign = await gm.call('POST', '/campaigns', { title: `Prep ${id}` });
  const inv = await gm.call('POST', `/campaigns/${campaign.id}/invites`, {});
  await pl.call('POST', '/invites/accept', { token: inv.token });
  const sceneOf = async (name: string) => {
    const img = png(400, 300);
    const intent = await gm.call('POST', `/campaigns/${campaign.id}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: img.length });
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([new Uint8Array(img)]) });
    const map = await gm.call('POST', `/campaigns/${campaign.id}/maps`, { assetId: intent.assetId, name });
    return gm.call('POST', `/campaigns/${campaign.id}/scenes`, { mapId: map.id, name, fogInitial: 'revealed' });
  };
  const hall = await sceneOf('Hall');
  const cellar = await sceneOf('Cellar');
  const session = await gm.call('POST', `/campaigns/${campaign.id}/sessions`, {});
  await gm.cmd(session.id, 'switchActiveScene', { sceneId: hall.id });
  await gm.call('POST', `/sessions/${session.id}/transition`, { action: 'start' });
  const rat = (await gm.cmd(session.id, 'spawnSceneObject', { sceneId: cellar.id, objectType: 'CREATURE', x: 100, y: 100, label: 'Rat', visibility: 'VISIBLE_TO_ALL' })).result.objectId as string;

  const p = await (await browser.newContext()).newPage();
  const g = await (await browser.newContext()).newPage();
  const tableUrl = `/campaigns/${campaign.id}/sessions/${session.id}`;
  await signedInPage(p, pl.token, tableUrl);
  await signedInPage(g, gm.token, tableUrl);
  await expect(p.getByText('Connected')).toBeVisible();
  const sceneName = async (page: Page) => (await table(page))?.snapshot?.scene?.scene.name;

  // Opening Cellar from the sidebar is private: the player stays in the Hall.
  await g.getByRole('complementary', { name: 'Scenes' }).getByRole('button', { name: /^Cellar/ }).click();
  await expect(g.getByText('Only you can see')).toBeVisible();
  await expect.poll(() => sceneName(g)).toBe('Cellar');
  expect(await sceneName(p)).toBe('Hall');

  // GM rearranges the Cellar; the GM's view updates live, the player sees nothing of it.
  await gm.cmd(session.id, 'moveToken', { objectId: rat, x: 250, y: 120 });
  await expect.poll(async () => (await table(g))?.objects[rat]?.x).toBe(250);
  expect((await table(p))?.objects[rat]).toBeUndefined();
  expect(await sceneName(p)).toBe('Hall');

  // Moving the players brings them to the prepared scene, token already in place.
  await g.getByRole('button', { name: 'Move players here' }).click();
  await expect.poll(() => sceneName(p)).toBe('Cellar');
  await expect.poll(async () => (await table(p))?.objects[rat]?.x).toBe(250);
  await expect(g.getByText('Only you can see')).toBeHidden();
});

test('a player standing on loot can still grab their token, and can pick the loot from a list', async ({ browser }) => {
  const api = await request.newContext({ baseURL: 'http://localhost:8787' });
  const id = Date.now().toString(36);
  const gm = await account(api, `gm-s-${id}@e2e.local`, 'GM');
  const pl = await account(api, `pl-s-${id}@e2e.local`, `Ash ${id}`);
  const campaign = await gm.call('POST', '/campaigns', { title: `Stack ${id}` });
  const inv = await gm.call('POST', `/campaigns/${campaign.id}/invites`, {});
  await pl.call('POST', '/invites/accept', { token: inv.token });
  const img = png(600, 400);
  const intent = await gm.call('POST', `/campaigns/${campaign.id}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: img.length });
  await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([new Uint8Array(img)]) });
  const map = await gm.call('POST', `/campaigns/${campaign.id}/maps`, { assetId: intent.assetId, name: 'Room' });
  const scene = await gm.call('POST', `/campaigns/${campaign.id}/scenes`, { mapId: map.id, name: 'Room', fogInitial: 'revealed' });
  const session = await gm.call('POST', `/campaigns/${campaign.id}/sessions`, {});
  await gm.cmd(session.id, 'switchActiveScene', { sceneId: scene.id });
  await gm.call('POST', `/sessions/${session.id}/transition`, { action: 'start' });
  const me = (await gm.cmd(session.id, 'spawnSceneObject', { sceneId: scene.id, objectType: 'PC', x: 300, y: 200, label: 'Ash', assignedControllerSub: pl.sub })).result.objectId as string;
  // The chest is placed after (so drawn on top of) the player's token, at the same spot.
  await gm.cmd(session.id, 'spawnSceneObject', { sceneId: scene.id, objectType: 'LOOT', x: 300, y: 200, label: 'Chest', visibility: 'VISIBLE_TO_ALL', loot: [{ id: 'c', name: 'Copper key', quantity: 1 }] });

  const p = await (await browser.newContext()).newPage();
  await signedInPage(p, pl.token, `/campaigns/${campaign.id}/sessions/${session.id}`);
  await expect(p.getByText('Connected')).toBeVisible();
  await expect.poll(async () => Object.keys((await table(p))?.objects ?? {}).length).toBe(2);
  // Wait for the map to finish fitting the screen so the click lands on the tokens.
  const clientOf = () => p.evaluate((pt) => JSON.stringify((window as any).__d20.mapToClient(pt)), { x: 300, y: 200 });
  let prev = '';
  await expect.poll(async () => { const now = await clientOf(); const settled = now === prev; prev = now; return settled; }, { intervals: [300] }).toBe(true);
  const at = JSON.parse(prev);

  // A plain click on the pile opens the picker; choosing the chest opens its loot card.
  await p.mouse.click(at.x, at.y);
  const menu = p.getByRole('menu', { name: 'Tokens here' });
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await menu.getByRole('menuitem', { name: /Chest/ }).click();
  await expect(menu).toBeHidden();
  await expect(p.getByRole('dialog', { name: 'Loot' }).getByRole('heading', { name: 'Chest' })).toBeVisible();

  // Dragging from the pile moves the player's own token, not the chest on top of it.
  const to = await p.evaluate((pt) => (window as any).__d20.mapToClient(pt), { x: 450, y: 250 });
  await p.mouse.move(at.x, at.y);
  await p.mouse.down();
  await p.mouse.move(to.x, to.y, { steps: 8 });
  await p.mouse.up();
  await expect.poll(async () => Math.round((await table(p))?.objects[me]?.x ?? 0)).toBeGreaterThan(400);
  await expect(menu).toBeHidden();
});
