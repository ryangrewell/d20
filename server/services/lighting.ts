/**
 * Fog automation on the server: current torchlight from party tokens and the "explored"
 * layer (remembered light, rooms walked into). The server decides what is lit, the same
 * way it decides what is fogged, so nothing in the dark reaches players.
 */
import type { Point } from '@shared/geometry/transform';
import type { FogShape, FogState } from '@shared/fog';
import { createExplored, decodeExplored, encodeExplored, markPolygon, type ExploredGrid } from '@shared/lighting/explored';
import { isPartyToken, lightPolygon, partyLights } from '@shared/lighting/light';
import { encodePolygon } from '@shared/lighting/wire';
import { roomsContaining, wallSegments, type MapWalls, type Segment } from '@shared/lighting/walls';
import type { MapDefinition, Scene, SceneObject } from '@shared/model';
import { keys, type TxItem } from '../repo/db';
import type { Deps } from '../context';
import type { Change } from '../realtime/fanout';
import { loadMapWalls } from './mapWalls';

const MAX_PATH_SAMPLES = 40;

/** Light shapes as they travel to clients. */
export const encodeLights = (lights: FogShape[] | undefined) => (lights ?? []).flatMap((l) => (l.kind === 'polygon' ? [encodePolygon(l.points)] : []));

export type ExploredRecord = { encoded: string; version: number };
export type SceneGeometry = {
  map: MapDefinition | null;
  walls: MapWalls | null;
  segments: Segment[];
  ppm?: number;
};

export const lightingOn = (scene: Scene) => !!scene.lighting && (scene.lighting.torch !== 'off' || scene.lighting.roomReveal);
const torchOn = (scene: Scene) => !!scene.lighting && scene.lighting.torch !== 'off';

export async function loadExploredRecord(deps: Deps, sceneId: string): Promise<{ grid: ExploredGrid | null; version: number }> {
  const rec = await deps.db.get<ExploredRecord>(keys.explored(sceneId));
  return rec ? { grid: decodeExplored(rec.encoded), version: rec.version } : { grid: null, version: 0 };
}

export async function sceneGeometry(deps: Deps, scene: Scene): Promise<SceneGeometry> {
  const map = await deps.db.get<MapDefinition>(keys.map(scene.campaignId, scene.mapId));
  const walls = map ? await loadMapWalls(deps, map) : null;
  return {
    map,
    walls,
    segments: walls ? wallSegments(walls) : [],
    ...(map?.calibration ? { ppm: map.calibration.pixelsPerMeter } : {}),
  };
}

function currentLights(scene: Scene, geo: SceneGeometry, objects: SceneObject[]): FogShape[] | undefined {
  if (!torchOn(scene) || !geo.ppm) return undefined;
  return partyLights(objects, geo.ppm, geo.segments);
}

/** The automatic layers for a scene: explored (stored) and current lights (computed). */
export async function loadLayers(deps: Deps, scene: Scene, objects?: SceneObject[]): Promise<Pick<FogState, 'explored' | 'lights'>> {
  const { grid } = await loadExploredRecord(deps, scene.id);
  if (!torchOn(scene)) return grid ? { explored: grid } : {};
  const [geo, objs] = await Promise.all([sceneGeometry(deps, scene), objects ? Promise.resolve(objects) : deps.db.queryPrefix<SceneObject>(`SCENE#${scene.id}`, 'OBJ#')]);
  const lights = currentLights(scene, geo, objs);
  return { ...(grid ? { explored: grid } : {}), ...(lights ? { lights } : {}) };
}

const visibleParty = (o: SceneObject) => isPartyToken(o) && o.visibility === 'VISIBLE_TO_ALL';

/** Fraction of the way along from→to where it first passes through a wall (1 = never). */
function firstWallHit(from: Point, to: Point, walls: Segment[]): number {
  let best = 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (const w of walls) {
    const sx = w.b.x - w.a.x;
    const sy = w.b.y - w.a.y;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((w.a.x - from.x) * sy - (w.a.y - from.y) * sx) / den;
    const u = ((w.a.x - from.x) * dy - (w.a.y - from.y) * dx) / den;
    if (t > 0 && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}

/**
 * Where a moving light shone: along the move up to the first wall it passes through, then
 * the end. A token dragged through a wall doesn't light the rooms in between.
 */
function samplePath(from: Point, to: Point, step: number, walls: Segment[]): Point[] {
  const stop = firstWallHit(from, to, walls);
  const d = Math.hypot(to.x - from.x, to.y - from.y) * stop;
  const n = Math.min(MAX_PATH_SAMPLES, Math.max(1, Math.ceil(d / Math.max(1, step))));
  // Stay just short of the wall so the sample is on the near side.
  const reach = stop < 1 ? Math.max(0, stop - 1e-3) : 1;
  const pts = Array.from({ length: n + 1 }, (_, i) => ({ x: from.x + (to.x - from.x) * reach * (i / n), y: from.y + (to.y - from.y) * reach * (i / n) }));
  return stop < 1 ? [...pts, to] : pts;
}

export type LightingUpdate = {
  change: Change | null;
  write: TxItem | null;
  fogAfter: FogState;
};

/**
 * Recomputes lights and grows the explored layer after party tokens changed.
 * `moved` lets remember mode light the whole path of a move; `opts.clearExplored` starts over (fog reset).
 */
export async function lightingUpdate(
  deps: Deps,
  scene: Scene,
  fogBefore: FogState,
  objectsAfter: SceneObject[],
  opts: {
    moved?: { id: string; from: Point; to: Point };
    clearExplored?: boolean;
  } = {},
): Promise<LightingUpdate> {
  const geo = await sceneGeometry(deps, scene);
  const lights = currentLights(scene, geo, objectsAfter);
  const record = await loadExploredRecord(deps, scene.id);
  let grid: ExploredGrid | null = opts.clearExplored ? null : record.grid;
  let changed = false;
  // Exploring now comes after every GM fog op painted so far, so it clears fog painted before it.
  const stamp = fogBefore.ops.length + 1;
  const ensure = () => (grid ??= geo.map ? createExplored(geo.map.widthPx, geo.map.heightPx) : null);

  if (scene.lighting?.torch === 'remember' && geo.ppm) {
    for (const o of objectsAfter.filter((x) => visibleParty(x) && (x.lightRadiusMeters ?? 0) > 0)) {
      const r = o.lightRadiusMeters! * geo.ppm;
      const points = opts.moved?.id === o.id ? samplePath(opts.moved.from, opts.moved.to, r / 2, geo.segments) : [{ x: o.x, y: o.y }];
      const g = ensure();
      if (g) for (const p of points) changed = markPolygon(g, lightPolygon(p, r, geo.segments), stamp) || changed;
    }
  }
  if (scene.lighting?.roomReveal && geo.walls) {
    for (const o of objectsAfter.filter(visibleParty)) {
      for (const room of roomsContaining(geo.walls, { x: o.x, y: o.y })) {
        const g = ensure();
        if (g) changed = markPolygon(g, room.points, stamp) || changed;
      }
    }
  }

  const clearing = opts.clearExplored && !!record.grid;
  const fogAfter: FogState = {
    initial: fogBefore.initial,
    ops: fogBefore.ops,
    ...(grid ? { explored: grid } : {}),
    ...(lights ? { lights } : {}),
  };
  const lightsChanged = JSON.stringify(fogBefore.lights ?? []) !== JSON.stringify(lights ?? []);
  let write: TxItem | null = null;
  if (changed && grid) {
    const item = {
      ...keys.explored(scene.id),
      entity: 'Explored',
      sceneId: scene.id,
      encoded: encodeExplored(grid),
      version: record.version + 1,
    };
    write = record.version
      ? {
          Put: {
            Item: item,
            ConditionExpression: 'version = :v',
            ExpressionAttributeValues: { ':v': record.version },
          },
        }
      : {
          Put: { Item: item, ConditionExpression: 'attribute_not_exists(PK)' },
        };
  } else if (clearing) {
    write = { Delete: { Key: keys.explored(scene.id) } };
  }
  if (!changed && !clearing && !lightsChanged) return { change: null, write: null, fogAfter };
  return {
    change: {
      kind: 'fogLayers',
      sceneId: scene.id,
      objects: objectsAfter,
      fogBefore,
      fogAfter,
      explored: grid ? encodeExplored(grid) : null,
      lights: encodeLights(lights),
    },
    write,
    fogAfter,
  };
}

/**
 * Lighting reads tokens and scene settings that another command may change at the same moment.
 * These checks make such a race fail at commit, and the command then re-runs once on fresh state.
 */
export function lightingGuards(scene: Scene, partyTokens: SceneObject[]): TxItem[] {
  const l = scene.lighting;
  return [
    l
      ? { ConditionCheck: { Key: keys.scene(scene.id), ConditionExpression: 'lighting.torch = :t AND lighting.roomReveal = :r', ExpressionAttributeValues: { ':t': l.torch, ':r': l.roomReveal } } }
      : { ConditionCheck: { Key: keys.scene(scene.id), ConditionExpression: 'attribute_not_exists(lighting)' } },
    ...partyTokens.map((o): TxItem => ({ ConditionCheck: { Key: keys.object(scene.id, o.id), ConditionExpression: 'revision = :rev', ExpressionAttributeValues: { ':rev': o.revision } } })),
  ];
}

/** True when this transaction depends on lighting state, so a conditional failure is worth one retry. */
export const lightingRace = (writes: TxItem[]) =>
  writes.some((w) => ('Put' in w && w.Put.Item.SK === 'EXPLORED') || ('Delete' in w && w.Delete.Key.SK === 'EXPLORED') || 'ConditionCheck' in w);
