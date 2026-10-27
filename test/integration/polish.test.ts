import { beforeAll, describe, expect, it } from 'vitest';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;

d('encounters, journal and chat history', () => {
  let h: Harness;
  let gm: TestUser, alice: TestUser, bob: TestUser;
  let campaignId: string, sessionId: string, sceneId: string;

  beforeAll(async () => {
    h = await createHarness();
    [gm, alice, bob] = await Promise.all([h.user('gm'), h.user('alice'), h.user('bob')]);
    campaignId = (await gm.call('POST', '/campaigns', { title: 'Polish' })).body.id;
    const { token } = (await gm.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
    await bob.call('POST', '/invites/accept', { token });
    const png = await makePng(500, 500);
    const intent = (await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    const map = (await gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: intent.assetId, name: 'Field' })).body;
    sceneId = (await gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId: map.id, name: 'Field', fogInitial: 'revealed' })).body.id;
    sessionId = (await gm.call('POST', `/campaigns/${campaignId}/sessions`, {})).body.id;
    await gm.command(sessionId, 'switchActiveScene', { sceneId });
    await gm.call('POST', `/sessions/${sessionId}/transition`, { action: 'start' });
  });

  it('places an encounter as hidden, numbered creatures with library stats', async () => {
    const goblin = (await gm.call('POST', `/campaigns/${campaignId}/creatures`, { name: 'Goblin', hpMax: 7, ac: 15, initiativeMod: 2 })).body;
    const boss = (await gm.call('POST', `/campaigns/${campaignId}/creatures`, { name: 'Bugbear', hpMax: 27 })).body;
    expect((await alice.call('POST', `/campaigns/${campaignId}/encounters`, { name: 'x', groups: [{ creatureId: goblin.id, count: 1 }] })).status).toBe(403);
    expect((await gm.call('POST', `/campaigns/${campaignId}/encounters`, { name: 'Too many', groups: [{ creatureId: goblin.id, count: 31 }] })).status).toBe(400);
    const enc = await gm.call('POST', `/campaigns/${campaignId}/encounters`, { name: 'Ambush', notes: 'From the trees', groups: [{ creatureId: goblin.id, count: 3 }, { creatureId: boss.id, count: 1 }] });
    expect(enc.status).toBe(201);

    expect((await alice.command(sessionId, 'spawnEncounter', { encounterId: enc.body.id, sceneId, x: 250, y: 250 })).status).toBe(403);
    h.published.length = 0;
    const r = await gm.command(sessionId, 'spawnEncounter', { encounterId: enc.body.id, sceneId, x: 250, y: 250 });
    expect(r.status).toBe(200);
    expect(r.body.result.objectIds).toHaveLength(4);

    const gmObjs = (await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects;
    expect(gmObjs.map((o: { appearance: { label: string } }) => o.appearance.label).sort()).toEqual(['Bugbear', 'Goblin 1', 'Goblin 2', 'Goblin 3']);
    expect(gmObjs.find((o: { appearance: { label: string } }) => o.appearance.label === 'Goblin 2')).toMatchObject({ visibility: 'GM_ONLY', gmStats: { hp: { current: 7, max: 7 }, ac: 15 } });
    // Distinct positions, all on the map.
    expect(new Set(gmObjs.map((o: { x: number; y: number }) => `${o.x},${o.y}`)).size).toBe(4);
    // Hidden: nothing reached the players.
    expect((await alice.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects).toHaveLength(0);
    expect(JSON.stringify(h.published.filter((p) => !p.channel.endsWith('/gm')))).not.toContain('Goblin');
  });

  it('saves a quick encounter with new and reused creatures, and places it hidden', async () => {
    // Typical enemy lives in the campaign settings.
    const saved = await gm.call('PATCH', `/campaigns/${campaignId}`, { settings: { enemyBaseline: { hp: 20, ac: 13, initiativeMod: 1 } } });
    expect(saved.body.settings.enemyBaseline).toEqual({ hp: 20, ac: 13, initiativeMod: 1 });

    const goblin = (await gm.call('GET', `/campaigns/${campaignId}/creatures`)).body.find((c: { name: string }) => c.name === 'Goblin');
    const body = { name: 'Warehouse ambush', groups: [{ count: 3, creature: { name: 'Dock thug', hpMax: 8, ac: 12, initiativeMod: 1, tint: '#c8752a' } }, { count: 1, creatureId: goblin.id }] };
    expect((await alice.call('POST', `/campaigns/${campaignId}/quick-encounters`, body)).status).toBe(403);
    expect((await gm.call('POST', `/campaigns/${campaignId}/quick-encounters`, { ...body, groups: [{ count: 21, creatureId: goblin.id }] })).status).toBe(400);
    const r = await gm.call('POST', `/campaigns/${campaignId}/quick-encounters`, body);
    expect(r.status).toBe(201);
    expect(r.body.creatures).toHaveLength(1);
    const thug = r.body.creatures[0];
    expect(r.body.encounter.groups).toEqual([{ creatureId: thug.id, count: 3 }, { creatureId: goblin.id, count: 1 }]);
    expect((await gm.call('GET', `/campaigns/${campaignId}/creatures`)).body.map((c: { name: string }) => c.name)).toContain('Dock thug');

    const placed = await gm.command(sessionId, 'spawnEncounter', { encounterId: r.body.encounter.id, sceneId, x: 100, y: 100 });
    expect(placed.body.result.objectIds).toHaveLength(4);
    const objs = (await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects.filter((o: { appearance: { label: string } }) => o.appearance.label.startsWith('Dock thug'));
    expect(objs).toHaveLength(3);
    expect(objs.every((o: { visibility: string; gmStats: { hp: { max: number } } }) => o.visibility === 'GM_ONLY' && o.gmStats.hp.max === 8)).toBe(true);
    expect((await alice.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects).toHaveLength(0);
  });

  it('keeps journal entries private until shared, and notifies only readers', async () => {
    expect((await alice.call('POST', `/campaigns/${campaignId}/journal`, { title: 'Hack' })).status).toBe(403);
    const secret = (await gm.call('POST', `/campaigns/${campaignId}/journal`, { title: 'Villain plan', body: 'Burn the mill.' })).body;
    expect(secret.visibility).toBe('GM_ONLY');
    expect((await alice.call('GET', `/campaigns/${campaignId}/journal`)).body).toHaveLength(0);

    h.published.length = 0;
    await gm.call('PATCH', `/campaigns/${campaignId}/journal/${secret.id}`, { title: 'A letter', body: 'Meet me at dusk.', visibility: 'SELECTED_PLAYERS', allowedViewerIds: [alice.sub] });
    const aliceList = (await alice.call('GET', `/campaigns/${campaignId}/journal`)).body;
    expect(aliceList.map((e: { title: string }) => e.title)).toEqual(['A letter']);
    expect(aliceList[0].allowedViewerIds).toBeUndefined();
    expect((await bob.call('GET', `/campaigns/${campaignId}/journal`)).body).toHaveLength(0);
    const notices = h.published.filter((p) => p.event.items.some((i) => i.type === 'JOURNAL_UPDATED'));
    expect(notices.find((p) => p.channel.endsWith(`/user/${alice.sub}`))?.event.items[0]).toMatchObject({ title: 'A letter', shared: true });
    expect(notices.some((p) => p.channel.endsWith(`/user/${bob.sub}`))).toBe(false);
    expect(JSON.stringify(h.published)).not.toContain('Meet me at dusk');

    expect((await gm.call('PATCH', `/campaigns/${campaignId}/journal/${secret.id}`, { title: 'x', visibility: 'SELECTED_PLAYERS', allowedViewerIds: [] })).status).toBe(400);
    await gm.call('PATCH', `/campaigns/${campaignId}/journal/${secret.id}`, { title: 'A letter', body: 'Meet me at dusk.', visibility: 'ALL' });
    expect((await bob.call('GET', `/campaigns/${campaignId}/journal`)).body).toHaveLength(1);
  });

  it('pages back through chat without leaking whispers', async () => {
    for (let i = 1; i <= 7; i++) await alice.command(sessionId, 'sendChat', { body: `table ${i}` });
    await gm.command(sessionId, 'sendChat', { body: 'secret for alice', recipientSubs: [alice.sub] });
    for (let i = 8; i <= 9; i++) await alice.command(sessionId, 'sendChat', { body: `table ${i}` });

    const page1 = (await bob.call('GET', `/campaigns/${campaignId}/chat?limit=4`)).body;
    expect(page1.messages.map((m: { body: string }) => m.body)).toEqual(['table 6', 'table 7', 'table 8', 'table 9']);
    expect(page1.hasMore).toBe(true);
    const page2 = (await bob.call('GET', `/campaigns/${campaignId}/chat?limit=4&before=${page1.messages[0].id}`)).body;
    expect(page2.messages.map((m: { body: string }) => m.body)).toEqual(['table 2', 'table 3', 'table 4', 'table 5']);
    const page3 = (await bob.call('GET', `/campaigns/${campaignId}/chat?limit=4&before=${page2.messages[0].id}`)).body;
    expect(page3.messages.map((m: { body: string }) => m.body)).toEqual(['table 1']);
    expect(page3.hasMore).toBe(false);
    expect(JSON.stringify([page1, page2, page3])).not.toContain('secret for alice');
    const alicePage = (await alice.call('GET', `/campaigns/${campaignId}/chat?limit=4`)).body;
    expect(alicePage.messages.map((m: { body: string }) => m.body)).toContain('secret for alice');
    expect((await bob.call('GET', `/campaigns/${campaignId}/chat?before=not-an-id`)).status).toBe(400);
  });
});
