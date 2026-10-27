import { beforeAll, describe, expect, it } from 'vitest';
import { keys } from '@server/repo/db';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;

d('undo, checkpoints and event catch-up', () => {
  let h: Harness;
  let gm: TestUser, alice: TestUser;
  let campaignId: string, sessionId: string, sceneId: string, otherSceneId: string;

  const objects = async (u: TestUser, scene?: string) => (await u.call('GET', `/sessions/${sessionId}/snapshot${scene ? `?scene=${scene}` : ''}`)).body.scene.objects as { id: string; x: number; appearance: { label?: string }; visibility: string }[];
  const labels = async (u: TestUser, scene?: string) => (await objects(u, scene)).map((o) => o.appearance.label).sort();

  beforeAll(async () => {
    h = await createHarness();
    [gm, alice] = await Promise.all([h.user('gm'), h.user('alice')]);
    campaignId = (await gm.call('POST', '/campaigns', { title: 'Reliability' })).body.id;
    const { token } = (await gm.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
    const png = await makePng(400, 400);
    const intent = (await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'm.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    const map = (await gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: intent.assetId, name: 'Room' })).body;
    sceneId = (await gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId: map.id, name: 'Room', fogInitial: 'revealed' })).body.id;
    otherSceneId = (await gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId: map.id, name: 'Cellar', fogInitial: 'revealed' })).body.id;
    sessionId = (await gm.call('POST', `/campaigns/${campaignId}/sessions`, {})).body.id;
    await gm.command(sessionId, 'switchActiveScene', { sceneId });
    await gm.call('POST', `/sessions/${sessionId}/transition`, { action: 'start' });
  });

  it('undoes place, move, edit, remove, transfer and fog in reverse order', async () => {
    const id = (await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'NPC', x: 50, y: 50, label: 'Guard' })).body.result.objectId;
    await gm.command(sessionId, 'moveToken', { objectId: id, x: 200, y: 200 });
    await gm.command(sessionId, 'updateSceneObject', { objectId: id, patch: { label: 'Captain' } });
    await gm.command(sessionId, 'updateFog', { sceneId, op: { mode: 'conceal', shape: { kind: 'rect', x: 0, y: 0, w: 100, h: 100 } } });
    await gm.command(sessionId, 'transferSceneObject', { objectId: id, targetSceneId: otherSceneId });
    await gm.command(sessionId, 'removeSceneObject', { objectId: id });

    const undo = async () => (await gm.command(sessionId, 'undoLast', {})).body;
    expect((await undo()).result.label).toBe('Remove Captain');
    expect(await labels(gm, otherSceneId)).toEqual(['Captain']);
    expect((await undo()).result.label).toBe('Move to scene Captain');
    expect(await labels(gm, otherSceneId)).toEqual([]);
    expect(await labels(gm)).toEqual(['Captain']);
    h.published.length = 0;
    expect((await undo()).result.label).toBe('Fog');
    expect((await h.deps.db.get<{ fogOpCount: number }>(keys.scene(sceneId)))!.fogOpCount).toBe(0);
    expect(h.published.some((p) => p.channel.endsWith(`/user/${alice.sub}`) && p.event.items.some((i) => i.type === 'SCENE_REFRESH'))).toBe(true);
    expect((await undo()).result.label).toBe('Edit Captain');
    expect(await labels(gm)).toEqual(['Guard']);
    expect((await undo()).result.label).toBe('Move Guard');
    expect((await objects(gm))[0]!.x).toBe(50);
    expect((await undo()).result.label).toBe('Place Guard');
    expect(await labels(gm)).toEqual([]);
    expect((await gm.command(sessionId, 'undoLast', {})).status).toBe(409);
  });

  it('refuses to undo over someone else’s later change, and players cannot undo', async () => {
    const id = (await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'PC', x: 10, y: 10, label: 'Hero', assignedControllerSub: alice.sub })).body.result.objectId;
    await alice.command(sessionId, 'moveToken', { objectId: id, x: 300, y: 300 });
    const r = await gm.command(sessionId, 'undoLast', {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('has changed since');
    expect((await alice.command(sessionId, 'undoLast', {})).status).toBe(403);
    await gm.command(sessionId, 'removeSceneObject', { objectId: id });
  });

  it('saves and restores scene checkpoints (tokens and fog)', async () => {
    await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 100, y: 100, label: 'Wolf' });
    await gm.command(sessionId, 'updateFog', { sceneId, op: { mode: 'conceal', shape: { kind: 'rect', x: 300, y: 300, w: 50, h: 50 } } });
    expect((await alice.call('POST', `/campaigns/${campaignId}/scenes/${sceneId}/checkpoints`, { label: 'x' })).status).toBe(403);
    const cp = await gm.call('POST', `/campaigns/${campaignId}/scenes/${sceneId}/checkpoints`, { label: 'Before the fight' });
    expect(cp.status).toBe(201);
    expect(cp.body).toMatchObject({ label: 'Before the fight', objectCount: 1, fogOpCount: 1 });

    // Change everything, then restore.
    const wolf = (await objects(gm)).find((o) => o.appearance.label === 'Wolf')!;
    await gm.command(sessionId, 'removeSceneObject', { objectId: wolf.id });
    await gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 50, y: 50, label: 'Bear' });
    await gm.command(sessionId, 'resetFog', { sceneId, initial: 'covered' });

    expect((await alice.command(sessionId, 'restoreCheckpoint', { sceneId, checkpointId: cp.body.id })).status).toBe(403);
    h.published.length = 0;
    const r = await gm.command(sessionId, 'restoreCheckpoint', { sceneId, checkpointId: cp.body.id });
    expect(r.status).toBe(200);
    expect(await labels(gm)).toEqual(['Wolf']);
    const snap = (await gm.call('GET', `/sessions/${sessionId}/snapshot`)).body.scene;
    expect(snap.fog).toMatchObject({ initial: 'revealed', ops: [{ mode: 'conceal' }] });
    expect(snap.objects[0].id).toBe(wolf.id);
    expect(await labels(alice)).toEqual(['Wolf']);
    expect(h.published.some((p) => p.event.items.some((i) => i.type === 'SCENE_REFRESH'))).toBe(true);
    const list = (await gm.call('GET', `/campaigns/${campaignId}/scenes/${sceneId}/checkpoints`)).body;
    expect(list.map((c: { label: string }) => c.label)).toEqual(['Before the fight']);
  });

  it('lets a client recover events whose live publish failed', async () => {
    const base = (await alice.call('GET', `/sessions/${sessionId}/snapshot`)).body.revision;
    h.control.failPublish = (ch) => ch.endsWith(`/user/${alice.sub}`);
    await gm.command(sessionId, 'sendChat', { body: 'Did you get this?' });
    h.control.failPublish = () => false;
    expect(h.published.some((p) => p.channel.endsWith(`/user/${alice.sub}`) && JSON.stringify(p.event).includes('Did you get this?'))).toBe(false);
    const caught = (await alice.call('GET', `/sessions/${sessionId}/events?since=${base}`)).body;
    expect(JSON.stringify(caught.events)).toContain('Did you get this?');
  });
});
