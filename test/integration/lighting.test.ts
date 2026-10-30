import { beforeAll, describe, expect, it } from 'vitest';
import { keys } from '../../server/repo/db';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;

const rect = (id: string, x: number, y: number, w: number, h: number) => ({ id, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });

d('walls on maps', () => {
  let h: Harness;
  let gm: TestUser, alice: TestUser;
  let campaignId: string;

  const upload = async (w: number, hgt: number) => {
    const png = await makePng(w, hgt);
    const intent = (await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'f.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    return intent.assetId as string;
  };

  beforeAll(async () => {
    h = await createHarness();
    [gm, alice] = await Promise.all([h.user('gm'), h.user('alice')]);
    campaignId = (await gm.call('POST', '/campaigns', { title: 'Walls' })).body.id;
    const { token } = (await gm.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
  });

  it('stores walls on an uploaded map, inside its bounds, GM only', async () => {
    const map = (await gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: await upload(600, 400), name: 'Hall' })).body;
    const walls = { rooms: [rect('a', 0, 0, 300, 400)], doorways: [{ a: { x: 300, y: 180 }, b: { x: 300, y: 220 } }] };
    expect((await alice.call('PATCH', `/campaigns/${campaignId}/maps/${map.id}`, { walls })).status).toBe(403);
    expect((await gm.call('PATCH', `/campaigns/${campaignId}/maps/${map.id}`, { walls: { rooms: [rect('x', 500, 300, 200, 200)], doorways: [] } })).status).toBe(400);
    expect((await gm.call('PATCH', `/campaigns/${campaignId}/maps/${map.id}`, { walls })).status).toBe(200);
    expect((await gm.call('GET', `/campaigns/${campaignId}/maps/${map.id}`)).body.map.walls).toEqual(walls);
    expect((await gm.call('PATCH', `/campaigns/${campaignId}/maps/${map.id}`, { walls: null })).status).toBe(200);
    expect((await gm.call('GET', `/campaigns/${campaignId}/maps/${map.id}`)).body.map.walls).toBeUndefined();
  });

  it('gives generated maps their walls, and backfills older ones', async () => {
    const input = { name: 'Inn', buildingType: 'inn', width: 60, depth: 40, unit: 'ft', floors: 1, basement: false, density: 'normal', theme: 'medieval', seed: 'walls' } as const;
    const r = await gm.call('POST', `/campaigns/${campaignId}/floorplans`, { input, floors: [{ level: 0, assetId: await upload(1200, 800) }] });
    expect(r.status).toBe(201);
    const mapId = r.body.floors[0].mapId as string;
    const first = (await gm.call('GET', `/campaigns/${campaignId}/maps/${mapId}`)).body.map;
    expect(first.walls.rooms.length).toBeGreaterThan(2);
    expect(first.walls.doorways.length).toBeGreaterThan(1);

    // Maps generated before walls existed have none stored; reading one fills them in once.
    await h.deps.db.update({ Key: keys.map(campaignId, mapId), UpdateExpression: 'REMOVE walls' });
    const again = (await gm.call('GET', `/campaigns/${campaignId}/maps/${mapId}`)).body.map;
    expect(again.walls).toEqual(first.walls);
    expect((await h.deps.db.get<{ walls?: unknown }>(keys.map(campaignId, mapId)))?.walls).toEqual(first.walls);
  });
});

d('torchlight and room reveal', () => {
  let h: Harness;
  let gm: TestUser, alice: TestUser, bob: TestUser;
  let campaignId: string, sessionId: string, sceneId: string, mapId: string;
  let pc: string, ghoul: string;

  const upload = async (w: number, hgt: number) => {
    const png = await makePng(w, hgt);
    const intent = (await gm.call('POST', `/campaigns/${campaignId}/maps/upload-intent`, { fileName: 'f.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    return intent.assetId as string;
  };
  const ok = async (r: Promise<{ status: number; body: any }>) => {
    const res = await r;
    if (res.status >= 300) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const snap = async (u: TestUser) => (await u.call('GET', `/sessions/${sessionId}/snapshot`)).body;
  const aliceSees = async (id: string) => (await snap(alice)).scene.objects.some((o: { id: string }) => o.id === id);
  const lighting = (torch: 'off' | 'remember' | 'live', roomReveal: boolean) => ok(gm.command(sessionId, 'setSceneLighting', { sceneId, torch, roomReveal }));
  const move = (id: string, x: number, y: number, who: TestUser = gm) => ok(who.command(sessionId, 'moveToken', { objectId: id, x, y }));
  const aliceItems = () => h.published.filter((p) => p.channel.endsWith(`/user/${alice.sub}`)).flatMap((p) => p.event.items);

  /** Fresh scene per test: room A (0..300), room B (300..600), doorway at x=300, y 180..220; fog covered. */
  const freshScene = async () => {
    sceneId = (await ok(gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId, name: `S${Math.random()}`, fogInitial: 'covered' }))).id;
    await ok(gm.command(sessionId, 'switchActiveScene', { sceneId }));
    pc = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'PC', x: 150, y: 200, label: 'Alice', assignedControllerSub: alice.sub }))).result.objectId;
    ghoul = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 450, y: 100, label: 'Ghoul', visibility: 'VISIBLE_TO_ALL' }))).result.objectId;
  };

  beforeAll(async () => {
    h = await createHarness();
    [gm, alice, bob] = await Promise.all([h.user('gm'), h.user('alice'), h.user('bob')]);
    campaignId = (await gm.call('POST', '/campaigns', { title: 'Light' })).body.id;
    const { token } = (await gm.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
    await bob.call('POST', '/invites/accept', { token });
    mapId = (await ok(gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: await upload(600, 400), name: 'Two rooms' }))).id;
    await ok(
      gm.call('PATCH', `/campaigns/${campaignId}/maps/${mapId}`, {
        calibration: { a: { x: 0, y: 0 }, b: { x: 600, y: 0 }, enteredDistance: 60, enteredUnit: 'm', pixelsPerMeter: 10 },
        walls: { rooms: [rect('A', 0, 0, 300, 400), rect('B', 300, 0, 300, 400)], doorways: [{ a: { x: 300, y: 180 }, b: { x: 300, y: 220 } }] },
      }),
    );
    sessionId = (await ok(gm.call('POST', `/campaigns/${campaignId}/sessions`, {}))).id;
    await ok(gm.call('POST', `/sessions/${sessionId}/transition`, { action: 'start' }));
  });

  it('never sends walls or room names to players', async () => {
    await freshScene();
    expect((await snap(gm)).scene.map.walls.rooms).toHaveLength(2);
    expect((await snap(alice)).scene.map.walls).toBeUndefined();
  });

  it('keeps lighting controls GM-only and light on party tokens only', async () => {
    await freshScene();
    expect((await alice.command(sessionId, 'setSceneLighting', { sceneId, torch: 'live', roomReveal: false })).status).toBe(403);
    const bad = await gm.command(sessionId, 'updateSceneObject', { objectId: ghoul, patch: { lightRadiusMeters: 5 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Only party tokens can carry light.');
  });

  it('refuses light on an uncalibrated map', async () => {
    const plain = (await ok(gm.call('POST', `/campaigns/${campaignId}/maps`, { assetId: await upload(300, 300), name: 'Plain' }))).id;
    const s = (await ok(gm.call('POST', `/campaigns/${campaignId}/scenes`, { mapId: plain, name: 'Plain' }))).id;
    const p = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId: s, objectType: 'PC', x: 10, y: 10 }))).result.objectId;
    const r = await gm.command(sessionId, 'updateSceneObject', { objectId: p, patch: { lightRadiusMeters: 5 } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Set the map's scale/);
  });

  it('live torchlight shows only what is lit, and updates as the light moves', async () => {
    await freshScene();
    await lighting('live', false);
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 10 } }));
    const s = await snap(alice);
    expect(s.scene.fog.lights).toHaveLength(1);
    expect(await aliceSees(ghoul)).toBe(false);

    h.published.length = 0;
    await move(pc, 420, 110);
    const types = aliceItems().map((i) => `${i.type}:${(i.object as { id?: string })?.id ?? (i as { objectId?: string }).objectId ?? ''}`);
    expect(types).toContain('FOG_LAYERS:');
    expect(types).toContain(`SCENE_OBJECT_UPSERTED:${ghoul}`);
    expect(await aliceSees(ghoul)).toBe(true);

    h.published.length = 0;
    await move(pc, 150, 200);
    expect(aliceItems().some((i) => i.type === 'SCENE_OBJECT_REMOVED' && i.objectId === ghoul)).toBe(true);
    expect(await aliceSees(ghoul)).toBe(false);
  });

  it('switching torchlight on lights tokens that already carry light', async () => {
    await freshScene();
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 10 } }));
    h.published.length = 0;
    await lighting('live', false);
    expect(aliceItems().filter((i) => i.type === 'FOG_LAYERS').map((i) => (i.lights as unknown[]).length)).toEqual([1]);
    const gmItems = h.published.filter((p) => p.channel.endsWith('/gm')).flatMap((p) => p.event.items);
    expect(gmItems.some((i) => i.type === 'FOG_LAYERS')).toBe(true);
  });

  it('never loses light when the GM sets a radius and switches torchlight on at the same moment', async () => {
    for (let i = 0; i < 4; i++) {
      await freshScene();
      await Promise.all([gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 10 } }), gm.command(sessionId, 'setSceneLighting', { sceneId, torch: 'live', roomReveal: false })]);
      expect((await snap(alice)).scene.fog.lights).toHaveLength(1);
      const lastLayers = h.published.filter((p) => p.channel.endsWith(`/user/${alice.sub}`)).flatMap((p) => p.event.items).filter((x) => x.type === 'FOG_LAYERS').at(-1);
      expect((lastLayers?.lights as unknown[] | undefined)?.length).toBe(1);
    }
  });

  it('stops light at walls', async () => {
    await freshScene();
    await lighting('live', false);
    await move(pc, 250, 100);
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 30 } }));
    expect(await aliceSees(ghoul)).toBe(false);
  });

  it('remembers explored areas in remember mode', async () => {
    await freshScene();
    await lighting('remember', false);
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 10 } }));
    await move(pc, 420, 110);
    await move(pc, 150, 200);
    expect(await aliceSees(ghoul)).toBe(true);
    expect((await snap(alice)).scene.fog.explored).toEqual(expect.any(String));
  });

  it('lets torchlight clear fog the GM painted back over an explored area', async () => {
    await freshScene();
    await lighting('remember', false);
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 10 } }));
    await move(pc, 420, 110);
    await move(pc, 150, 200);
    expect(await aliceSees(ghoul)).toBe(true);
    // The GM paints fog back over room B: the ghoul disappears for players.
    await ok(gm.command(sessionId, 'updateFog', { sceneId, op: { mode: 'conceal', shape: { kind: 'rect', x: 300, y: 0, w: 300, h: 400 } } }));
    expect(await aliceSees(ghoul)).toBe(false);
    // Carrying the torch back through clears the fresh fog again, and it stays cleared.
    await move(pc, 420, 110);
    await move(pc, 150, 200);
    expect(await aliceSees(ghoul)).toBe(true);
  });

  it('remembers only the part of a move the light could actually see', async () => {
    await freshScene();
    await lighting('remember', false);
    const rat = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 340, y: 100, label: 'Rat', visibility: 'VISIBLE_TO_ALL' }))).result.objectId;
    await move(pc, 150, 100);
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 3 } }));
    // Dragged straight through the wall into room B: the strip behind the wall stays dark.
    await move(pc, 500, 100);
    expect(await aliceSees(rat)).toBe(false);
  });

  it('reveals a whole room when a party token walks in', async () => {
    await freshScene();
    await lighting('off', true);
    // Placing a creature never reveals anything.
    await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 100, y: 100, visibility: 'VISIBLE_TO_ALL' }));
    expect(await aliceSees(ghoul)).toBe(false);
    await move(pc, 310, 300);
    expect(await aliceSees(ghoul)).toBe(true);
  });

  it('reveals both rooms for a token standing on their shared wall', async () => {
    await freshScene();
    await lighting('off', true);
    const sneak = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'CREATURE', x: 100, y: 50, label: 'Sneak', visibility: 'VISIBLE_TO_ALL' }))).result.objectId;
    await move(pc, 300, 50);
    expect(await aliceSees(sneak)).toBe(true);
    expect(await aliceSees(ghoul)).toBe(true);
  });

  it('a hidden party token lights nothing', async () => {
    await freshScene();
    await lighting('live', false);
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 10 } }));
    expect((await snap(alice)).scene.fog.lights).toHaveLength(1);
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { visibility: 'GM_ONLY' } }));
    expect((await snap(alice)).scene.fog.lights).toHaveLength(0);
  });

  it("leaves the GM's fog undo working, and reset clears explored areas", async () => {
    await freshScene();
    await lighting('off', true);
    await move(pc, 310, 300);
    await ok(gm.command(sessionId, 'updateFog', { sceneId, op: { mode: 'reveal', shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 } } }));
    await move(pc, 150, 200, alice);
    expect((await gm.command(sessionId, 'undoLast', {})).status).toBe(200);
    expect(await aliceSees(ghoul)).toBe(true);
    await lighting('off', false);
    await ok(gm.command(sessionId, 'resetFog', { sceneId, initial: 'covered' }));
    expect((await snap(alice)).scene.fog.explored).toBeNull();
    expect(await aliceSees(ghoul)).toBe(false);
  });

  it('lets two lit tokens move at the same moment in remember mode', async () => {
    await freshScene();
    await lighting('remember', false);
    const bobPc = (await ok(gm.command(sessionId, 'spawnSceneObject', { sceneId, objectType: 'PC', x: 100, y: 300, label: 'Bob', assignedControllerSub: bob.sub }))).result.objectId;
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: pc, patch: { lightRadiusMeters: 5 } }));
    await ok(gm.command(sessionId, 'updateSceneObject', { objectId: bobPc, patch: { lightRadiusMeters: 5 } }));
    const [a, b] = await Promise.all([alice.command(sessionId, 'moveToken', { objectId: pc, x: 200, y: 100 }), bob.command(sessionId, 'moveToken', { objectId: bobPc, x: 200, y: 350 })]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});
