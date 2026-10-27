import { beforeAll, describe, expect, it } from 'vitest';
import { generateFloorplan } from '@shared/generator/floorplan';
import { fromMeters } from '@shared/units';
import { createHarness, infraAvailable, makePng, type Harness, type TestUser } from './harness';

const available = await infraAvailable();
const d = available ? describe : describe.skip;

const input = { name: 'Broken Crown', buildingType: 'tavern', width: 60, depth: 40, unit: 'ft', floors: 2, basement: true, density: 'normal', theme: 'medieval', seed: 'crown' } as const;

d('building interior generator (J8)', () => {
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
    campaignId = (await gm.call('POST', '/campaigns', { title: 'Generator' })).body.id;
    const { token } = (await gm.call('POST', `/campaigns/${campaignId}/invites`, {})).body;
    await alice.call('POST', '/invites/accept', { token });
  });

  it('rejects players, missing floors and images with the wrong proportions', async () => {
    const a = await upload(1200, 800);
    expect((await alice.call('POST', `/campaigns/${campaignId}/floorplans`, { input, floors: [{ level: 0, assetId: a }] })).status).toBe(403);
    expect((await gm.call('POST', `/campaigns/${campaignId}/floorplans`, { input, floors: [{ level: 0, assetId: a }] })).status).toBe(400);
    const [b0, b1, b2] = [await upload(1200, 800), await upload(1200, 900), await upload(1200, 800)];
    const bad = await gm.call('POST', `/campaigns/${campaignId}/floorplans`, { input, floors: [{ level: -1, assetId: b0 }, { level: 0, assetId: b1 }, { level: 1, assetId: b2 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('proportions');
    expect((await gm.call('POST', `/campaigns/${campaignId}/floorplans`, { input: { ...input, width: 5 }, floors: [{ level: 0, assetId: a }] })).status).toBe(400);
  });

  it('creates exactly calibrated maps, scenes and GM-only stair links for a 60x40 ft tavern', async () => {
    const floors = [{ level: -1, assetId: await upload(1200, 800) }, { level: 0, assetId: await upload(1200, 800) }, { level: 1, assetId: await upload(1200, 800) }];
    const r = await gm.call('POST', `/campaigns/${campaignId}/floorplans`, { input, roomNames: { f0r2: 'Taproom' }, floors });
    expect(r.status).toBe(201);
    expect(r.body.floors.map((f: { name: string }) => f.name)).toEqual(['Basement', 'Ground floor', 'First floor']);

    const dash = (await gm.call('GET', `/campaigns/${campaignId}`)).body;
    const fp = generateFloorplan(input);
    for (const f of r.body.floors) {
      const map = dash.maps.find((m: { id: string }) => m.id === f.mapId);
      // The ruler across the image reads exactly the requested 60 ft; the depth reads 40 ft.
      expect(fromMeters(map.widthPx / map.calibration.pixelsPerMeter, 'ft')).toBeCloseTo(60, 6);
      expect(fromMeters(map.heightPx / map.calibration.pixelsPerMeter, 'ft')).toBeCloseTo(40, 1);
      expect(map.grid).toMatchObject({ type: 'square', displayInterval: 5, displayUnit: 'ft', opacity: 0.7, color: '#3a2d22' });
      expect(map.grid.intervalMeters).toBeCloseTo(fp.cellM, 6);
    }
    expect(dash.scenes.filter((s: { name: string }) => s.name.startsWith('Broken Crown'))).toHaveLength(3);

    // Ground floor has a pin up and a pin down, each linking to the right scene; players see neither.
    const ground = r.body.floors.find((f: { level: number }) => f.level === 0);
    const session = (await gm.call('POST', `/campaigns/${campaignId}/sessions`, {})).body;
    await gm.command(session.id, 'switchActiveScene', { sceneId: ground.sceneId });
    await gm.call('POST', `/sessions/${session.id}/transition`, { action: 'start' });
    const pins = (await gm.call('GET', `/sessions/${session.id}/snapshot`)).body.scene.objects;
    const targets = pins.map((p: { portal: { targetSceneId: string } }) => p.portal.targetSceneId).sort();
    expect(targets).toEqual([r.body.floors[0].sceneId, r.body.floors[2].sceneId].sort());
    const playerView = (await alice.call('GET', `/sessions/${session.id}/snapshot`)).body.scene.objects;
    expect(playerView).toHaveLength(0);

    // Portals can't point into another campaign.
    const other = (await gm.call('POST', '/campaigns', { title: 'Other' })).body;
    const png = await makePng(100, 100);
    const intent = (await gm.call('POST', `/campaigns/${other.id}/maps/upload-intent`, { fileName: 'o.png', contentType: 'image/png', bytes: png.length })).body;
    await fetch(intent.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([Buffer.from(png)]) });
    const otherMap = (await gm.call('POST', `/campaigns/${other.id}/maps`, { assetId: intent.assetId, name: 'O' })).body;
    const otherScene = (await gm.call('POST', `/campaigns/${other.id}/scenes`, { mapId: otherMap.id, name: 'O' })).body;
    expect((await gm.command(session.id, 'updateSceneObject', { objectId: pins[0].id, patch: { portal: { targetSceneId: otherScene.id } } })).status).toBe(404);

    const list = (await gm.call('GET', `/campaigns/${campaignId}/floorplans`)).body;
    expect(list[0]).toMatchObject({ name: 'Broken Crown', roomNames: { f0r2: 'Taproom' }, input: { seed: 'crown' } });
  });
});
