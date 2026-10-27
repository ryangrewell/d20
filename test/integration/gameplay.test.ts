import { beforeAll, describe, expect, it } from 'vitest';
import { keys } from '@server/repo/db';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;

d('characters, inventory, loot, creatures and initiative', () => {
  let h: Harness;
  let gm: TestUser, alice: TestUser, bob: TestUser;
  let campaignId: string, sessionId: string, sceneId: string;
  let aliceChar: { id: string; revision: number };
  let bobChar: { id: string };

  beforeAll(async () => {
    h = await createHarness();
    [gm, alice, bob] = await Promise.all([h.user('gm'), h.user('alice'), h.user('bob')]);
    campaignId = (await gm.call('POST', '/campaigns', { title: 'Gameplay' })).body.id;
    const { token } = (await gm.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
    await bob.call('POST', '/invites/accept', { token });
    const png = await makePng(400, 300);
    const intent = (await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    const map = (await gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: intent.assetId, name: 'Hall' })).body;
    sceneId = (await gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId: map.id, name: 'Hall', fogInitial: 'revealed' })).body.id;
    sessionId = (await gm.call('POST', `/campaigns/${campaignId}/sessions`, {})).body.id;
    await gm.command(sessionId, 'switchActiveScene', { sceneId });
    await gm.call('POST', `/sessions/${sessionId}/transition`, { action: 'start' });
  });

  it('lets players create and edit only their own sheets', async () => {
    const created = await alice.call('POST', `/campaigns/${campaignId}/characters`, { name: 'Aria', sheet: { dex: 16, hp: { current: 12, max: 12 } } });
    expect(created.status).toBe(201);
    aliceChar = created.body;
    expect(created.body.ownerSub).toBe(alice.sub);
    bobChar = (await bob.call('POST', `/campaigns/${campaignId}/characters`, { name: 'Bram' })).body;

    // Bob sees Aria's name only, never her sheet.
    const bobList = (await bob.call('GET', `/campaigns/${campaignId}/characters`)).body;
    expect(bobList.characters.map((c: { name: string }) => c.name)).toEqual(['Bram']);
    expect(bobList.others).toEqual([{ id: aliceChar.id, name: 'Aria', ownerSub: alice.sub }]);
    expect((await bob.call('GET', `/campaigns/${campaignId}/characters/${aliceChar.id}`)).status).toBe(404);
    expect((await bob.call('PATCH', `/campaigns/${campaignId}/characters/${aliceChar.id}`, { expectedRevision: 1, name: 'Hacked' })).status).toBe(404);

    // A player cannot create a character for someone else, or set GM notes.
    expect((await alice.call('POST', `/campaigns/${campaignId}/characters`, { name: 'Puppet', ownerSub: bob.sub })).status).toBe(403);
    expect((await alice.call('PATCH', `/campaigns/${campaignId}/characters/${aliceChar.id}`, { expectedRevision: 1, gmNotes: 'x' })).status).toBe(403);

    // Invalid sheet data is rejected; stale revisions conflict.
    expect((await alice.call('PATCH', `/campaigns/${campaignId}/characters/${aliceChar.id}`, { expectedRevision: 1, sheet: { str: 99 } })).status).toBe(400);
    const ok = await alice.call('PATCH', `/campaigns/${campaignId}/characters/${aliceChar.id}`, { expectedRevision: 1, sheet: { dex: 18, hp: { current: 9, max: 12 } }, conditions: ['Prone'] });
    expect(ok.status).toBe(200);
    expect((await alice.call('PATCH', `/campaigns/${campaignId}/characters/${aliceChar.id}`, { expectedRevision: 1, name: 'Old' })).status).toBe(409);
    aliceChar = ok.body;
  });

  it('lets the GM edit any sheet with an audit trail and private notes', async () => {
    h.published.length = 0;
    const r = await gm.call('PATCH', `/campaigns/${campaignId}/characters/${aliceChar.id}`, { expectedRevision: aliceChar.revision, gmNotes: 'Secretly cursed' });
    expect(r.status).toBe(200);
    const audit = await h.deps.db.queryPrefix<{ actorSub: string; fields: string[] }>(`CHAR#${aliceChar.id}`, 'AUDIT#');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorSub: gm.sub, fields: ['gmNotes'] });
    const aliceView = await alice.call('GET', `/campaigns/${campaignId}/characters/${aliceChar.id}`);
    expect(JSON.stringify(aliceView.body)).not.toContain('Secretly cursed');
    expect(aliceView.body.derived.dexMod).toBe(4);
    // The live table is told (id only) — Alice and the GM, not Bob.
    const notices = h.published.filter((p) => p.event.items.some((i) => i.type === 'CHARACTER_UPDATED'));
    expect(notices.some((p) => p.channel.endsWith('/gm'))).toBe(true);
    expect(notices.some((p) => p.channel.endsWith(`/user/${alice.sub}`))).toBe(true);
    expect(notices.some((p) => p.channel.endsWith(`/user/${bob.sub}`))).toBe(false);
  });

  it('manages inventory and exports/imports characters', async () => {
    const item = await alice.call('POST', `/campaigns/${campaignId}/characters/${aliceChar.id}/items`, { name: 'Rope', quantity: 1, state: 'CARRIED' });
    expect(item.status).toBe(201);
    expect((await alice.call('PATCH', `/campaigns/${campaignId}/characters/${aliceChar.id}/items/${item.body.id}`, { quantity: 2 })).body.quantity).toBe(2);
    expect((await bob.call('POST', `/campaigns/${campaignId}/characters/${aliceChar.id}/items`, { name: 'Gift' })).status).toBe(404);
    const exported = (await alice.call('GET', `/campaigns/${campaignId}/characters/${aliceChar.id}/export`)).body;
    expect(exported).toMatchObject({ format: 'd20.character', version: 1, name: 'Aria' });
    expect(JSON.stringify(exported)).not.toContain('Secretly cursed');
    const imported = await bob.call('POST', `/campaigns/${campaignId}/characters/import`, { data: { ...exported, name: 'Aria (copy)' } });
    expect(imported.status).toBe(201);
    expect(imported.body.ownerSub).toBe(bob.sub);
    const detail = (await bob.call('GET', `/campaigns/${campaignId}/characters/${imported.body.id}`)).body;
    expect(detail.items.map((i: { name: string; quantity: number }) => `${i.name}x${i.quantity}`)).toEqual(['Ropex2']);
  });

  it('lets exactly one of two racing players take the last loot item (negative test 10, J4)', async () => {
    const chest = await gm.command(sessionId, 'spawnSceneObject', {
      sceneId,
      objectType: 'LOOT',
      x: 50,
      y: 50,
      label: 'Chest',
      visibility: 'VISIBLE_TO_ALL',
      loot: [
        { id: 'gem', name: 'Ruby', quantity: 1 },
        { id: 'gold', name: 'Gold coins', quantity: 10 },
      ],
    });
    const chestId = chest.body.result.objectId as string;
    const [a, b] = await Promise.all([
      alice.command(sessionId, 'pickupLoot', { objectId: chestId, entryId: 'gem', characterId: aliceChar.id, quantity: 1 }),
      bob.command(sessionId, 'pickupLoot', { objectId: chestId, entryId: 'gem', characterId: bobChar.id, quantity: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? { u: alice, c: aliceChar.id } : { u: bob, c: bobChar.id };
    const loser = a.status === 200 ? { u: bob, c: bobChar.id } : { u: alice, c: aliceChar.id };
    const rubies = async (u: TestUser, c: string) => (await u.call('GET', `/campaigns/${campaignId}/characters/${c}`)).body.items.filter((i: { name: string }) => i.name === 'Ruby').length;
    expect(await rubies(winner.u, winner.c)).toBe(1);
    expect(await rubies(loser.u, loser.c)).toBe(0);

    // Can't pick up for someone else's character; partial pickup decrements; last pickup removes the pile.
    expect((await bob.command(sessionId, 'pickupLoot', { objectId: chestId, entryId: 'gold', characterId: aliceChar.id, quantity: 1 })).status).toBe(403);
    expect((await alice.command(sessionId, 'pickupLoot', { objectId: chestId, entryId: 'gold', characterId: aliceChar.id, quantity: 4 })).body.result.remaining).toEqual([{ id: 'gold', name: 'Gold coins', quantity: 6 }]);
    expect((await alice.command(sessionId, 'pickupLoot', { objectId: chestId, entryId: 'gold', characterId: aliceChar.id, quantity: 6 })).status).toBe(200);
    expect(await h.deps.db.get(keys.object(sceneId, chestId))).toBeNull();
    const gold = (await alice.call('GET', `/campaigns/${campaignId}/characters/${aliceChar.id}`)).body.items.find((i: { name: string }) => i.name === 'Gold coins');
    expect(gold.quantity).toBe(10);
    // Hidden loot cannot be targeted by players.
    const secret = await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'LOOT', x: 60, y: 60, visibility: 'GM_ONLY', loot: [{ id: 'x', name: 'Secret', quantity: 1 }] });
    expect((await alice.command(sessionId, 'pickupLoot', { objectId: secret.body.result.objectId, entryId: 'x', characterId: aliceChar.id, quantity: 1 })).status).toBe(404);
  });

  it('keeps creature-library stats GM-only', async () => {
    expect((await alice.call('GET', `/campaigns/${campaignId}/creatures`)).status).toBe(403);
    const t = await gm.call('POST', `/campaigns/${campaignId}/creatures`, { name: 'Ogre', hpMax: 59, ac: 11, initiativeMod: -1, notes: 'Hates bells' });
    expect(t.status).toBe(201);
    const spawned = await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 200, y: 150, templateId: t.body.id, visibility: 'VISIBLE_TO_ALL' });
    const id = spawned.body.result.objectId;
    const gmObj = (await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects.find((o: { id: string }) => o.id === id);
    expect(gmObj).toMatchObject({ appearance: { label: 'Ogre' }, gmStats: { hp: { current: 59, max: 59 }, ac: 11 }, gmNotes: 'Hates bells' });
    const playerObj = (await alice.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects.find((o: { id: string }) => o.id === id);
    expect(playerObj.appearance.label).toBe('Ogre');
    expect(playerObj.gmStats).toBeUndefined();
    expect(JSON.stringify(h.published.filter((p) => !p.channel.endsWith('/gm')))).not.toContain('Hates bells');
    await gm.command(sessionId, 'updateSceneObject', { objectId: id, patch: { gmStats: { hp: { current: 30, max: 59 } }, conditions: ['Prone'] } });
    const after = (await alice.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects.find((o: { id: string }) => o.id === id);
    expect(after.conditions).toEqual(['Prone']);
  });

  it('runs initiative on the server with hidden combatants stripped for players', async () => {
    const pc = (await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'PC', x: 10, y: 10, characterId: aliceChar.id })).body.result.objectId;
    const lurker = (await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 300, y: 10, label: 'Lurker', visibility: 'GM_ONLY' })).body.result.objectId;
    // Players can roll only for their own token.
    expect((await bob.command(sessionId, 'rollInitiative', { objectIds: [pc] })).status).toBe(403);
    const own = await alice.command(sessionId, 'rollInitiative', { objectIds: [pc] });
    expect(own.status).toBe(200);
    const aliceRoll = own.body.result.rolls[0];
    expect(aliceRoll.mod).toBe(4); // dex 18 from her sheet
    expect(aliceRoll.total).toBeGreaterThanOrEqual(5);
    expect(aliceRoll.total).toBeLessThanOrEqual(24);
    expect((await gm.command(sessionId, 'rollInitiative', { objectIds: [lurker] })).status).toBe(200);
    await gm.command(sessionId, 'setInitiativeEntry', { label: 'Lair action', value: 20, hidden: false });

    const gmInit = (await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.session.initiative;
    expect(gmInit.entries).toHaveLength(3);
    const playerInit = (await alice.call('GET', `/sessions/${sessionId}/snapshot`)).body.session.initiative;
    expect(playerInit.entries.map((e: { label: string }) => e.label).sort()).toEqual(['Aria', 'Lair action']);
    expect(JSON.stringify(playerInit)).not.toContain('Lurker');
    expect(JSON.stringify(h.published.filter((p) => !p.channel.endsWith('/gm') && p.event.items.some((i) => i.type === 'INITIATIVE_UPDATED')))).not.toContain('Lurker');

    // Turn order: players can't advance someone else's turn; GM can; round increments on wrap.
    const order = gmInit.entries.map((e: { id: string }) => e.id);
    const currentIsAlice = gmInit.entries.find((e: { id: string }) => e.id === gmInit.currentId).objectId === pc;
    if (!currentIsAlice) expect((await alice.command(sessionId, 'advanceTurn', { direction: 'next' })).status).toBe(403);
    for (let i = 0; i < order.length; i++) await gm.command(sessionId, 'advanceTurn', { direction: 'next' });
    const wrapped = (await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.session.initiative;
    expect(wrapped.round).toBe(2);
    expect(wrapped.currentId).toBe(gmInit.currentId);
    expect((await alice.command(sessionId, 'endCombat', {})).status).toBe(403);
    await gm.command(sessionId, 'endCombat', {});
    expect((await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.session.initiative).toMatchObject({ active: false, entries: [] });
  });
});
