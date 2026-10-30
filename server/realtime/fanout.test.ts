import { describe, expect, it } from 'vitest';
import type { FogState } from '@shared/fog';
import { buildBundles, type Change } from './fanout';

const session = { id: 's', accessEpoch: 1, activeSceneId: 'scene' };
const fog: FogState = { initial: 'covered', ops: [] };
const layers = (explored: string): Change => ({ kind: 'fogLayers', sceneId: 'scene', objects: [], fogBefore: fog, fogAfter: fog, explored, lights: ['abc'] });
const meta = { eventId: 'e', revision: 1, ts: '' };
const players = Array.from({ length: 8 }, (_, i) => `p${i}`);

describe('fog layer events', () => {
  it('carry the layers to every viewer when small', () => {
    const bundles = buildBundles(session, { gmSubs: ['g'], playerSubs: players }, [layers('x'.repeat(2000))], meta);
    expect(bundles.filter((b) => b.event.items.some((i) => i.type === 'FOG_LAYERS'))).toHaveLength(10);
  });

  it('fall back to a scene reload when storing them for every viewer would be too big', () => {
    const bundles = buildBundles(session, { gmSubs: ['g'], playerSubs: players }, [layers('x'.repeat(60_000))], meta);
    expect(JSON.stringify(bundles).length).toBeLessThan(300_000);
    for (const b of bundles.filter((x) => x.audience.kind !== 'gmPersonal')) expect(b.event.items).toEqual([{ type: 'SCENE_REFRESH', sceneId: 'scene', reason: 'lighting' }]);
  });
});
