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
