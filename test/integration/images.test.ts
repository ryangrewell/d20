import { beforeAll, describe, expect, it } from 'vitest';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;

const recipe = { v: 1, body: 'male', skin: 'green', parts: [{ item: 'heads_orc_male' }, { item: 'legs_pants', colors: { color: 'black' } }] };

d('character and creature pictures', () => {
  let h: Harness;
  let gm: TestUser, alice: TestUser, bob: TestUser, mallory: TestUser;
  let campaignId: string, sessionId: string, sceneId: string;

  const ok = async (r: Promise<{ status: number; body: any }>) => {
    const res = await r;
    if (res.status >= 300) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  /** Uploads a PNG as `who` and returns its asset id. */
  const upload = async (who: TestUser, w = 64, hgt = 64) => {
    const png = await makePng(w, hgt);
    const intent = await ok(who.call('POST', `/campaigns/${campaignId}/images/upload-intent`, { contentType: 'image/png', bytes: png.length }));
    await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: new Blob([Buffer.from(png)]) });
    return (await ok(who.call('POST', `/campaigns/${campaignId}/images`, { assetId: intent.assetId }))).assetId as string;
  };

  beforeAll(async () => {
    h = await createHarness();
    [gm, alice, bob, mallory] = await Promise.all([h.user('gm'), h.user('alice'), h.user('bob'), h.user('mallory')]);
    campaignId = (await gm.call('POST', '/campaigns', { title: 'Pictures' })).body.id;
    const { token } = (await gm.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
    await bob.call('POST', '/invites/accept', { token });
    const png = await makePng(400, 300);
    const intent = (await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    const map = (await gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: intent.assetId, name: 'Field' })).body;
    sceneId = (await gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId: map.id, name: 'Field', fogInitial: 'revealed' })).body.id;
    sessionId = (await gm.call('POST', `/campaigns/${campaignId}/sessions`, {})).body.id;
    await gm.command(sessionId, 'switchActiveScene', { sceneId });
    await gm.call('POST', `/sessions/${sessionId}/transition`, { action: 'start' });
  });

  it('lets any member upload a picture and every member view it', async () => {
    const assetId = await upload(alice);
    const link = await ok(bob.call('GET', `/campaigns/${campaignId}/images/${assetId}`));
    expect(link.url).toMatch(/^https?:\/\//);
    expect((await fetch(link.url)).status).toBe(200);
    expect((await mallory.call('GET', `/campaigns/${campaignId}/images/${assetId}`)).status).toBe(404);
    expect((await mallory.call('POST', `/campaigns/${campaignId}/images/upload-intent`, { contentType: 'image/png', bytes: 100 })).status).toBe(404);
  });

  it('refuses files that are too big, too large in pixels, or not what they claim', async () => {
    expect((await alice.call('POST', `/campaigns/${campaignId}/images/upload-intent`, { contentType: 'image/png', bytes: 3 * 1024 * 1024 })).status).toBe(400);
    const png = await makePng(2000, 40);
    const intent = await ok(alice.call('POST', `/campaigns/${campaignId}/images/upload-intent`, { contentType: 'image/png', bytes: png.length }));
    await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: new Blob([Buffer.from(png)]) });
    const r = await alice.call('POST', `/campaigns/${campaignId}/images`, { assetId: intent.assetId });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/1024/);
    // Only the uploader can finish an upload.
    const other = await ok(alice.call('POST', `/campaigns/${campaignId}/images/upload-intent`, { contentType: 'image/png', bytes: 100 }));
    expect((await bob.call('POST', `/campaigns/${campaignId}/images`, { assetId: other.assetId })).status).toBe(404);
  });

  it('puts a picture and sprite on a character, for its owner or the GM only', async () => {
    const hero = await ok(alice.call('POST', `/campaigns/${campaignId}/characters`, { name: 'Grok' }));
    const assetId = await upload(alice);
    // Other players can't even see someone else's character exists.
    expect((await bob.call('PATCH', `/campaigns/${campaignId}/characters/${hero.id}`, { expectedRevision: hero.revision, imageAssetId: assetId })).status).toBe(404);
    const saved = await ok(alice.call('PATCH', `/campaigns/${campaignId}/characters/${hero.id}`, { expectedRevision: hero.revision, imageAssetId: assetId, sprite: { kind: 'lpc', recipe } }));
    expect(saved).toMatchObject({ imageAssetId: assetId, sprite: { kind: 'lpc', recipe } });
    // A picture from another campaign, or one never finished, can't be attached.
    const elsewhere = (await gm.call('POST', '/campaigns', { title: 'Other' })).body.id;
    const pending = await ok(alice.call('POST', `/campaigns/${campaignId}/images/upload-intent`, { contentType: 'image/png', bytes: 100 }));
    for (const bad of [pending.assetId, elsewhere]) {
      expect((await alice.call('PATCH', `/campaigns/${campaignId}/characters/${hero.id}`, { expectedRevision: saved.revision, imageAssetId: bad })).status).toBe(400);
    }
  });

  it("shows a character's picture on its tokens, and updates them live when it changes", async () => {
    const hero = await ok(alice.call('POST', `/campaigns/${campaignId}/characters`, { name: 'Ivy' }));
    const first = await upload(alice);
    const withPic = await ok(alice.call('PATCH', `/campaigns/${campaignId}/characters/${hero.id}`, { expectedRevision: hero.revision, imageAssetId: first }));
    const token = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'PC', x: 50, y: 50, characterId: hero.id }))).result.objectId;
    const seen = async (u: TestUser) => (await u.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects.find((o: { id: string }) => o.id === token);
    expect((await seen(bob)).appearance.imageAssetId).toBe(first);

    h.published.length = 0;
    const second = await upload(alice);
    await ok(alice.call('PATCH', `/campaigns/${campaignId}/characters/${hero.id}`, { expectedRevision: withPic.revision, imageAssetId: second }));
    expect((await seen(bob)).appearance.imageAssetId).toBe(second);
    const bobItems = h.published.filter((p) => p.channel.endsWith(`/user/${bob.sub}`)).flatMap((p) => p.event.items);
    expect(bobItems.some((i) => i.type === 'SCENE_OBJECT_UPSERTED' && (i.object as { appearance: { imageAssetId?: string } }).appearance.imageAssetId === second)).toBe(true);
  });

  it('gives creatures pictures that their tokens and encounters copy, and lets the GM set any token picture', async () => {
    const pic = await upload(gm);
    const wolf = await ok(gm.call('POST', `/campaigns/${campaignId}/creatures`, { name: 'Wolf', hpMax: 11, imageAssetId: pic, sprite: { kind: 'animal', id: 'wolf_grey' } }));
    expect(wolf).toMatchObject({ imageAssetId: pic, sprite: { kind: 'animal', id: 'wolf_grey' } });
    const single = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 90, y: 90, templateId: wolf.id }))).result.objectId;
    const enc = await ok(gm.call('POST', `/campaigns/${campaignId}/encounters`, { name: 'Pack', groups: [{ creatureId: wolf.id, count: 2 }] }));
    const pack = (await ok(gm.command(sessionId, 'spawnEncounter', { encounterId: enc.id, sceneId, x: 200, y: 200 }))).result.objectIds as string[];
    const objs = (await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects as { id: string; appearance: { imageAssetId?: string } }[];
    for (const id of [single, ...pack]) expect(objs.find((o) => o.id === id)?.appearance.imageAssetId).toBe(pic);

    const npcPic = await upload(gm);
    const npc = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'NPC', x: 300, y: 100, label: 'Innkeeper' }))).result.objectId;
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: npc, patch: { imageAssetId: npcPic } }));
    expect((await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene.objects.find((o: { id: string }) => o.id === npc).appearance.imageAssetId).toBe(npcPic);
    expect((await alice.command(sessionId, 'updateSceneObject', { objectId: npc, patch: { imageAssetId: null } })).status).toBe(403);
  });
});
