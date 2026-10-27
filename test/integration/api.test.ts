import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeChannel } from '@server/realtime/authorize';
import { sanitizePresence } from '@server/realtime/presence';
import { keys } from '@server/repo/db';
import { channelPath } from '@shared/events';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;
if (!available) console.warn('[integration] DynamoDB Local not reachable; run `npm run dev:infra` to enable integration tests.');

d('campaign lifecycle, tabletop and security', () => {
  let h: Harness;
  let gm: TestUser, alice: TestUser, bob: TestUser, mallory: TestUser;
  let campaignId: string, sessionId: string, sceneId: string, mapId: string;
  let hiddenId: string, aliceTokenId: string;

  beforeAll(async () => {
    h = await createHarness();
    [gm, alice, bob, mallory] = await Promise.all([h.user('gm'), h.user('alice'), h.user('bob'), h.user('mallory')]);
  });

  it('creates a campaign and admits players by invite', async () => {
    const c = await gm.call('POST', '/campaigns', { title: 'Shadows of Riverton', description: 'A test' });
    expect(c.status).toBe(201);
    campaignId = c.body.id;

    const inv = await gm.call('POST', `/campaigns/${campaignId}/invites`, { maxUses: 2 });
    expect(inv.status).toBe(201);
    expect(inv.body.invite.tokenHash).toBeUndefined();
    const token = inv.body.token as string;

    expect((await alice.call('POST', '/invites/accept', { token })).status).toBe(200);
    expect((await bob.call('POST', '/invites/accept', { token })).status).toBe(200);
    // Max uses reached: a third account is rejected.
    expect((await mallory.call('POST', '/invites/accept', { token })).status).toBe(404);
    // Re-accepting as an existing member does not consume a use.
    const again = await alice.call('POST', '/invites/accept', { token });
    expect(again.body.alreadyMember).toBe(true);

    const dash = await alice.call('GET', `/campaigns/${campaignId}`);
    expect(dash.status).toBe(200);
    expect(dash.body.access.isGM).toBe(false);
    expect(dash.body.members).toHaveLength(3);
  });

  it('answers CORS preflight without credentials', async () => {
    const res = await h.app.request('/api/campaigns', { method: 'OPTIONS', headers: { origin: 'https://d20.ryangrewell.com', 'access-control-request-method': 'GET' } });
    expect(res.status).toBe(204);
  });

  it('hides private campaigns from non-members (J1)', async () => {
    const r = await mallory.call('GET', `/campaigns/${campaignId}`);
    expect(r.status).toBe(404);
    const list = await mallory.call('GET', '/campaigns');
    expect(list.body).toHaveLength(0);
  });

  it('redeems a single-use invite at most once under concurrency (negative test 9)', async () => {
    const inv = await gm.call('POST', `/campaigns/${campaignId}/invites`, { maxUses: 1 });
    const users = await Promise.all([1, 2, 3, 4].map((i) => h.user(`racer${i}`)));
    const results = await Promise.all(users.map((u) => u.call('POST', '/invites/accept', { token: inv.body.token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    // Revoked invite fails cleanly.
    const inv2 = await gm.call('POST', `/campaigns/${campaignId}/invites`, {});
    await gm.call('POST', `/campaigns/${campaignId}/invites/${inv2.body.invite.id}/revoke`);
    expect((await mallory.call('POST', '/invites/accept', { token: inv2.body.token })).status).toBe(404);
  });

  it('uploads, validates and calibrates a map', async () => {
    const png = await makePng(400, 300);
    const intent = await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'city.png', contentType: 'image/png', bytes: png.length });
    expect(intent.status).toBe(200);
    const put = await fetch(intent.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    expect(put.ok).toBe(true);
    const fin = await gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: intent.body.assetId, name: 'Riverton', category: 'city' });
    expect(fin.status).toBe(201);
    expect(fin.body.widthPx).toBe(400);
    mapId = fin.body.id;

    // A player cannot upload into this campaign (negative test 5).
    const bad = await alice.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'x.png', contentType: 'image/png', bytes: 100 });
    expect(bad.status).toBe(403);
    const outsider = await mallory.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'x.png', contentType: 'image/png', bytes: 100 });
    expect(outsider.status).toBe(404);

    // Grid without calibration is rejected; with calibration it is accepted.
    const noCal = await gm.call('PATCH', `/campaigns/${campaignId}/maps/${mapId}`, {
      grid: { type: 'square', intervalMeters: 30.48, displayInterval: 100, displayUnit: 'ft', originX: 0, originY: 0, rotationRadians: 0, snapEnabled: true, showEnabled: true, opacity: 0.3 },
    });
    expect(noCal.status).toBe(400);
    const cal = await gm.call('PATCH', `/campaigns/${campaignId}/maps/${mapId}`, {
      calibration: { a: { x: 0, y: 10 }, b: { x: 400, y: 10 }, enteredDistance: 1, enteredUnit: 'mi', pixelsPerMeter: 400 / 1609.344 },
      grid: { type: 'square', intervalMeters: 30.48, displayInterval: 100, displayUnit: 'ft', originX: 0, originY: 0, rotationRadians: 0, snapEnabled: true, showEnabled: true, opacity: 0.3 },
    });
    expect(cal.status).toBe(200);
    expect(cal.body.calibration.pixelsPerMeter).toBeCloseTo(0.24855, 4);
  });

  it('rejects uploads whose bytes are not the declared image type', async () => {
    const intent = await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'evil.png', contentType: 'image/png', bytes: 30 });
    await fetch(intent.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: '<svg onload=alert(1)>xxxxxxxx' });
    const fin = await gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: intent.body.assetId, name: 'Evil' });
    expect(fin.status).toBe(400);
  });

  it('runs a live session with GM-only projections (J3)', async () => {
    const scene = await gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId, name: 'Riverton streets', fogInitial: 'revealed' });
    expect(scene.status).toBe(201);
    sceneId = scene.body.id;
    const s = await gm.call('POST', `/campaigns/${campaignId}/sessions`, { title: 'Night one' });
    sessionId = s.body.id;
    expect((await gm.command(sessionId, 'switchActiveScene', { sceneId })).status).toBe(200);

    // Players see a waiting screen before the session starts.
    const waiting = await alice.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(waiting.body.waiting).toBe(true);
    expect(waiting.body.scene).toBeNull();
    expect((await gm.call('POST', `/sessions/${sessionId}/transition`, { action: 'start' })).status).toBe(200);

    const hidden = await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 100, y: 100, label: 'Lurking Ghoul', visibility: 'GM_ONLY', gmNotes: 'Ambush!' });
    hiddenId = hidden.body.result.objectId;
    const pc = await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'PC', x: 50, y: 50, label: 'Alice', assignedControllerSub: alice.sub });
    aliceTokenId = pc.body.result.objectId;
    await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'NPC', x: 200, y: 150, label: 'Shopkeeper', gmNotes: 'Secretly a spy' });

    const gmSnap = await gm.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(gmSnap.body.scene.objects).toHaveLength(3);
    const aSnap = await alice.call('GET', `/sessions/${sessionId}/snapshot`);
    const raw = JSON.stringify(aSnap.body);
    expect(aSnap.body.scene.objects).toHaveLength(2);
    expect(raw).not.toContain('Lurking Ghoul');
    expect(raw).not.toContain(hiddenId);
    expect(raw).not.toContain('Secretly a spy');
    expect(raw).not.toContain('gmNotes');

    // Nothing about the hidden creature was published on a player-readable channel.
    const playerPublished = h.published.filter((p) => !p.channel.endsWith('/gm'));
    expect(JSON.stringify(playerPublished)).not.toContain(hiddenId);
    expect(JSON.stringify(h.published.filter((p) => p.channel.endsWith('/gm')))).toContain(hiddenId);
  });

  it('enforces token ownership and GM-only commands (negative tests 1, 2)', async () => {
    expect((await alice.command(sessionId, 'switchActiveScene', { sceneId })).status).toBe(403);
    // Guessing a hidden ID does not disclose it.
    expect((await alice.command(sessionId, 'moveToken', { objectId: hiddenId, x: 1, y: 1 })).status).toBe(404);
    expect((await alice.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 1, y: 1 })).status).toBe(403);
    // Bob cannot move Alice's token; Alice can.
    expect((await bob.command(sessionId, 'moveToken', { objectId: aliceTokenId, x: 70, y: 70 })).status).toBe(403);
    const moved = await alice.command(sessionId, 'moveToken', { objectId: aliceTokenId, x: 70.25, y: 80.5 });
    expect(moved.status).toBe(200);
    // Outsiders get nothing.
    expect((await mallory.command(sessionId, 'moveToken', { objectId: aliceTokenId, x: 0, y: 0 })).status).toBe(404);
    // Off-map positions are clamped to map bounds.
    await alice.command(sessionId, 'moveToken', { objectId: aliceTokenId, x: 99999, y: -5 });
    const snap = await alice.call('GET', `/sessions/${sessionId}/snapshot`);
    const tok = snap.body.scene.objects.find((o: { id: string }) => o.id === aliceTokenId);
    expect(tok).toMatchObject({ x: 400, y: 0 });
  });

  it('treats command ids as idempotency keys', async () => {
    const commandId = crypto.randomUUID();
    const a = await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'LOOT', x: 10, y: 10, label: 'Chest' }, commandId);
    const b = await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'LOOT', x: 10, y: 10, label: 'Chest' }, commandId);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.newRevision).toBe(a.body.newRevision);
    const snap = await gm.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(snap.body.scene.objects.filter((o: { appearance: { label?: string } }) => o.appearance.label === 'Chest')).toHaveLength(1);
  });

  it('hides tokens under fog and reveals them when fog is cleared', async () => {
    h.published.length = 0;
    await gm.command(sessionId, 'updateFog', { sceneId, op: { mode: 'conceal', shape: { kind: 'rect', x: 150, y: 100, w: 100, h: 100 } } });
    const snap = await bob.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(snap.body.scene.objects.map((o: { appearance: { label?: string } }) => o.appearance.label)).not.toContain('Shopkeeper');
    const bobEvents = h.published.filter((p) => p.channel.endsWith(`/user/${bob.sub}`));
    expect(bobEvents[0]!.event.items.map((i) => i.type)).toEqual(['FOG_UPDATED', 'SCENE_OBJECT_REMOVED']);
    // PC tokens stay visible under fog.
    await gm.command(sessionId, 'updateFog', { sceneId, op: { mode: 'conceal', shape: { kind: 'rect', x: 0, y: 0, w: 400, h: 300 } } });
    const s2 = await bob.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(s2.body.scene.objects.map((o: { id: string }) => o.id)).toContain(aliceTokenId);
    await gm.command(sessionId, 'resetFog', { sceneId, initial: 'revealed' });
    const s3 = await bob.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(s3.body.scene.objects.map((o: { appearance: { label?: string } }) => o.appearance.label)).toContain('Shopkeeper');
  });

  it('moves a token to another scene as one GM action', async () => {
    const other = await gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId, name: 'Cellar', fogInitial: 'revealed' });
    const spawned = await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'NPC', x: 30, y: 30, label: 'Courier', assignedControllerSub: alice.sub });
    const courierId = spawned.body.result.objectId as string;

    expect((await alice.command(sessionId, 'transferSceneObject', { objectId: courierId, targetSceneId: other.body.id })).status).toBe(403);
    expect((await gm.command(sessionId, 'transferSceneObject', { objectId: courierId, targetSceneId: sceneId })).status).toBe(400);
    expect((await gm.command(sessionId, 'transferSceneObject', { objectId: courierId, targetSceneId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' })).status).toBe(404);

    h.published.length = 0;
    const moved = await gm.command(sessionId, 'transferSceneObject', { objectId: courierId, targetSceneId: other.body.id });
    expect(moved.status).toBe(200);
    // Lands at the centre of the 400x300 map, same id and controller.
    expect(moved.body.result).toMatchObject({ objectId: courierId, sceneId: other.body.id, x: 200, y: 150 });

    // Players on the active scene see it leave; the inactive destination scene is not leaked to them.
    const aliceItems = h.published.filter((p) => p.channel.endsWith(`/user/${alice.sub}`)).flatMap((p) => p.event.items);
    expect(aliceItems).toEqual([{ type: 'SCENE_OBJECT_REMOVED', sceneId, objectId: courierId }]);

    const src = await gm.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(src.body.scene.objects.map((o: { id: string }) => o.id)).not.toContain(courierId);
    const dst = await gm.call('GET', `/sessions/${sessionId}/snapshot?scene=${other.body.id}`);
    expect(dst.body.scene.objects.find((o: { id: string }) => o.id === courierId)).toMatchObject({ assignedControllerSub: alice.sub, appearance: { label: 'Courier' } });

    // Once the GM switches scenes, the controlling player sees it there.
    await gm.command(sessionId, 'switchActiveScene', { sceneId: other.body.id });
    const aliceView = await alice.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(aliceView.body.scene.objects.map((o: { id: string }) => o.id)).toContain(courierId);
    await gm.command(sessionId, 'switchActiveScene', { sceneId });
  });

  it('delivers whispers only to recipients (J4, negative test 6)', async () => {
    h.published.length = 0;
    const w = await gm.command(sessionId, 'sendChat', { body: 'The amulet is cursed.', recipientSubs: [alice.sub] });
    expect(w.status).toBe(200);
    const bobView = await bob.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(JSON.stringify(bobView.body.chat)).not.toContain('cursed');
    const aliceView = await alice.call('GET', `/sessions/${sessionId}/snapshot`);
    expect(JSON.stringify(aliceView.body.chat)).toContain('cursed');
    const leaked = h.published.filter((p) => JSON.stringify(p.event).includes('cursed') && !p.channel.endsWith(`/user/${alice.sub}`) && !p.channel.endsWith(`/user/${gm.sub}`));
    expect(leaked).toHaveLength(0);
    const events = await bob.call('GET', `/sessions/${sessionId}/events?since=0`);
    expect(JSON.stringify(events.body)).not.toContain('cursed');
  });

  it('rolls dice on the server and rejects abusive expressions', async () => {
    const r = await alice.command(sessionId, 'rollDice', { expression: '4d6kh3+2' });
    expect(r.status).toBe(200);
    expect(r.body.result.total).toBeGreaterThanOrEqual(5);
    expect(r.body.result.total).toBeLessThanOrEqual(20);
    expect((await alice.command(sessionId, 'rollDice', { expression: '1000000d6' })).status).toBe(400);
  });

  it('authorises realtime channels per campaign, role and epoch (negative tests 3, 4)', async () => {
    const epoch = 1;
    const otherCampaign = await mallory.call('POST', '/campaigns', { title: 'Mallory campaign' });
    const malSession = await mallory.call('POST', `/campaigns/${otherCampaign.body.id}/sessions`, {});
    await mallory.call('POST', `/sessions/${malSession.body.id}/transition`, { action: 'start' });

    const can = (u: TestUser, path: string, op: 'subscribe' | 'publish' = 'subscribe') => authorizeChannel(h.deps, u.sub, path, op).then((d) => d.ok);
    expect(await can(alice, channelPath({ ns: 'game', sessionId, epoch, audience: 'user', sub: alice.sub }))).toBe(true);
    expect(await can(alice, channelPath({ ns: 'game', sessionId, epoch, audience: 'user', sub: bob.sub }))).toBe(false);
    expect(await can(alice, channelPath({ ns: 'game', sessionId, epoch, audience: 'gm' }))).toBe(false);
    expect(await can(gm, channelPath({ ns: 'game', sessionId, epoch, audience: 'gm' }))).toBe(true);
    expect(await can(alice, channelPath({ ns: 'presence', sessionId, epoch }), 'publish')).toBe(true);
    expect(await can(alice, channelPath({ ns: 'game', sessionId, epoch, audience: 'user', sub: alice.sub }), 'publish')).toBe(false);
    // Cross-campaign: Alice cannot reach Mallory's session, even with a guessed path.
    expect(await can(alice, channelPath({ ns: 'presence', sessionId: malSession.body.id, epoch }))).toBe(false);
    expect(await can(mallory, channelPath({ ns: 'presence', sessionId, epoch }))).toBe(false);
    expect(await can(alice, '/game/../gm')).toBe(false);

    // Presence packets cannot spoof identity.
    const member = { campaignId, userSub: alice.sub, role: 'PLAYER' as const, status: 'ACTIVE' as const, displayName: 'alice', color: '#29a3a3', joinedAt: '' };
    const spoof = sanitizePresence({ type: 'CURSOR', actor: { sub: gm.sub, displayName: 'GM', role: 'GM' }, cursor: { sceneId, nx: 0.5, ny: 0.5, seq: 1 } }, member);
    expect(spoof).toMatchObject({ actor: { sub: alice.sub, displayName: 'alice' } });
    expect(sanitizePresence({ type: 'CURSOR', cursor: { sceneId, nx: 50, ny: 0.5, seq: 1 } }, member)).toBeNull();
  });

  it('cuts off a removed member immediately (epoch rotation)', async () => {
    const before = channelPath({ ns: 'game', sessionId, epoch: 1, audience: 'user', sub: bob.sub });
    expect((await authorizeChannel(h.deps, bob.sub, before, 'subscribe')).ok).toBe(true);
    expect((await gm.call('DELETE', `/campaigns/${campaignId}/members/${bob.sub}`)).status).toBe(200);
    // Old epoch is dead for everyone; the new epoch rejects Bob.
    expect((await authorizeChannel(h.deps, bob.sub, before, 'subscribe')).ok).toBe(false);
    expect((await authorizeChannel(h.deps, bob.sub, channelPath({ ns: 'game', sessionId, epoch: 2, audience: 'user', sub: bob.sub }), 'subscribe')).ok).toBe(false);
    expect((await authorizeChannel(h.deps, alice.sub, channelPath({ ns: 'game', sessionId, epoch: 2, audience: 'user', sub: alice.sub }), 'subscribe')).ok).toBe(true);
    expect((await bob.command(sessionId, 'rollDice', { expression: '1d20' })).status).toBe(404);
    expect((await bob.call('GET', `/sessions/${sessionId}/snapshot`)).status).toBe(404);
  });

  it('lets a removed player back in only through a link made after the removal', async () => {
    // Bob was removed in the previous test. A fresh link from the GM brings him back.
    const link = await gm.call('POST', `/campaigns/${campaignId}/invites`, { role: 'PLAYER' });
    expect((await bob.call('POST', '/invites/preview', { token: link.body.token })).body.blockedReason).toBeNull();
    expect((await bob.call('POST', '/invites/accept', { token: link.body.token })).body).toEqual({ campaignId, alreadyMember: false });
    expect((await bob.call('GET', `/campaigns/${campaignId}`)).status).toBe(200);

    // Removed again: that same (unlimited) link is now older than the removal and no longer works.
    await new Promise((r) => setTimeout(r, 5));
    expect((await gm.call('DELETE', `/campaigns/${campaignId}/members/${bob.sub}`)).status).toBe(200);
    expect((await bob.call('POST', '/invites/preview', { token: link.body.token })).body.blockedReason).toMatch(/new invite link/);
    expect((await bob.call('POST', '/invites/accept', { token: link.body.token })).status).toBe(403);
    expect((await bob.call('GET', `/campaigns/${campaignId}`)).status).toBe(404);
  });

  it('denies a blocked account even with a valid token (negative test 8)', async () => {
    await h.deps.db.update({ Key: keys.profile(alice.sub), UpdateExpression: 'SET #s = :b', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':b': 'BLOCKED' } });
    expect((await alice.call('GET', `/campaigns/${campaignId}`)).status).toBe(403);
    expect((await authorizeChannel(h.deps, alice.sub, channelPath({ ns: 'presence', sessionId, epoch: 2 }), 'subscribe')).ok).toBe(false);
    await h.deps.db.update({ Key: keys.profile(alice.sub), UpdateExpression: 'SET #s = :a', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':a': 'ACTIVE' } });
  });

  it('preserves state across sessions (J5)', async () => {
    await gm.call('POST', `/sessions/${sessionId}/transition`, { action: 'end' });
    const next = await gm.call('POST', `/campaigns/${campaignId}/sessions`, {});
    expect(next.body.number).toBe(2);
    expect(next.body.activeSceneId).toBe(sceneId);
    await gm.call('POST', `/sessions/${next.body.id}/transition`, { action: 'start' });
    const snap = await alice.call('GET', `/sessions/${next.body.id}/snapshot`);
    const tok = snap.body.scene.objects.find((o: { id: string }) => o.id === aliceTokenId);
    expect(tok).toMatchObject({ x: 400, y: 0 });
    expect(snap.body.chat.some((m: { body: string }) => m.body.includes('cursed'))).toBe(true);
  });
});
