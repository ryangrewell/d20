/**
 * Turns a generated building into campaign maps. The server never trusts
 * client geometry: it regenerates the floorplan from the input + seed with the
 * same shared code, validates it, checks each uploaded floor image has the
 * footprint's proportions, and calibrates every map from its exact pixel width.
 */
import { ulid } from 'ulid';
import { z } from 'zod';
import { invalid } from '@shared/errors';
import { BUILDING_TYPES, FloorplanError, THEMES, THEME_GRID_COLORS, generateFloorplan, validateFloorplan, type Floorplan, type FloorplanInput } from '@shared/generator/floorplan';
import type { MapDefinition, Scene, SceneObject } from '@shared/model';
import { Id, plainText } from '@shared/schemas/common';
import { keys, type TxItem } from '../repo/db';
import { loadCampaign, requireActiveCampaign, requireGM, type Actor, type Deps } from '../context';
import { mapItem, sceneItem, verifyUploadedImage } from './maps';
import { floorplanToWalls, type MapWalls } from '@shared/lighting/walls';
import { objectItem } from './commands';

export const FloorplanInputSchema = z.object({
  name: plainText(60).pipe(z.string().min(1, 'Name the building')),
  buildingType: z.enum(BUILDING_TYPES),
  width: z.number().positive().max(1000),
  depth: z.number().positive().max(1000),
  unit: z.enum(['ft', 'm']),
  floors: z.number().int().min(1).max(4),
  basement: z.boolean(),
  density: z.enum(['sparse', 'normal', 'dense']),
  theme: z.enum(THEMES),
  seed: plainText(40).pipe(z.string().min(1)),
});

export const CreateFloorplanInput = z.object({
  input: FloorplanInputSchema,
  roomNames: z.record(z.string().max(20), plainText(60)).default({}),
  showLabels: z.boolean().default(true),
  fogInitial: z.enum(['covered', 'revealed']).default('revealed'),
  floors: z.array(z.object({ level: z.number().int().min(-1).max(3), assetId: Id })).min(1).max(5),
});

export type FloorplanRecord = {
  id: string;
  campaignId: string;
  name: string;
  input: FloorplanInput;
  roomNames: Record<string, string>;
  showLabels: boolean;
  floors: { level: number; name: string; mapId: string; sceneId: string }[];
  createdBy: string;
  createdAt: string;
};

const ASPECT_TOLERANCE = 0.01;

/** A generated floor's walls in map pixels, with the GM's room names applied. */
export function generatedWalls(fp: Floorplan, level: number, pxPerMeter: number, roomNames: Record<string, string>): MapWalls | null {
  const floor = fp.floors.find((f) => f.level === level);
  if (!floor) return null;
  const walls = floorplanToWalls(floor, pxPerMeter);
  return { ...walls, rooms: walls.rooms.map((r) => (roomNames[r.id] ? { ...r, name: roomNames[r.id] } : r)) };
}

export function regenerate(input: FloorplanInput): Floorplan {
  let fp: Floorplan;
  try {
    fp = generateFloorplan(input);
  } catch (e) {
    if (e instanceof FloorplanError) throw invalid(e.message);
    throw e;
  }
  const errs = validateFloorplan(fp);
  if (errs.length) throw invalid(`That floorplan is not valid: ${errs[0]}`);
  return fp;
}

export async function createFloorplan(deps: Deps, actor: Actor, campaignId: string, body: z.output<typeof CreateFloorplanInput>) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  requireActiveCampaign(ctx);
  const fp = regenerate(body.input);
  const levels = fp.floors.map((f) => f.level).sort();
  const given = body.floors.map((f) => f.level).sort();
  if (JSON.stringify(levels) !== JSON.stringify(given)) throw invalid('Upload one image per floor of this building.');

  const now = deps.now().toISOString();
  const unitLabel = body.input.unit;
  const created: { floor: Floorplan['floors'][number]; map: MapDefinition; scene: Scene }[] = [];
  const writes: TxItem[] = [];
  for (const floor of fp.floors) {
    const upload = body.floors.find((f) => f.level === floor.level)!;
    const { asset, width, height, ready } = await verifyUploadedImage(deps, campaignId, upload.assetId);
    // The image must have the footprint's proportions; otherwise the calibration would be wrong.
    if (Math.abs(height / width - fp.depthM / fp.widthM) > ASPECT_TOLERANCE * (fp.depthM / fp.widthM)) throw invalid(`The ${floor.name} image does not match the building's proportions.`);
    const map: MapDefinition = {
      id: ulid(),
      campaignId,
      assetId: asset.id,
      name: `${body.input.name} · ${floor.name}`,
      category: floor.level < 0 ? 'dungeon' : 'building',
      widthPx: width,
      heightPx: height,
      calibration: { a: { x: 0, y: 0 }, b: { x: width, y: 0 }, enteredDistance: body.input.width, enteredUnit: unitLabel, pixelsPerMeter: width / fp.widthM },
      grid: { type: 'square', intervalMeters: fp.cellM, displayInterval: unitLabel === 'ft' ? 5 : 1.5, displayUnit: unitLabel, originX: 0, originY: 0, rotationRadians: 0, snapEnabled: true, showEnabled: true, opacity: 0.7, color: THEME_GRID_COLORS[body.input.theme] },
      ...((w) => (w ? { walls: w } : {}))(generatedWalls(fp, floor.level, width / fp.widthM, body.roomNames)),
      createdAt: now,
      updatedAt: now,
    };
    const scene: Scene = { id: ulid(), campaignId, mapId: map.id, name: `${body.input.name} · ${floor.name}`, fogInitial: body.fogInitial, fogOpCount: 0, createdAt: now, updatedAt: now };
    writes.push(ready, { Put: { Item: mapItem(map) } }, { Put: { Item: sceneItem(scene) } });
    created.push({ floor, map, scene });
  }

  // GM-only stair pins on each floor link to the floor above and below.
  const ordered = [...created].sort((a, b) => a.floor.level - b.floor.level);
  ordered.forEach((c, i) => {
    const s = c.floor.stairs;
    if (!s) return;
    const ppm = c.map.calibration!.pixelsPerMeter;
    const links = [
      { target: ordered[i + 1], dir: 'up', dy: -0.25 },
      { target: ordered[i - 1], dir: 'down', dy: 0.25 },
    ].filter((l) => l.target);
    for (const l of links) {
      const obj: SceneObject = {
        id: ulid(),
        sceneId: c.scene.id,
        campaignId,
        objectType: 'PIN',
        x: (s.x + s.w / 2) * ppm,
        y: (s.y + s.h / 2 + s.h * l.dy) * ppm,
        rotationRadians: 0,
        zIndex: 1,
        visibility: 'GM_ONLY',
        appearance: { label: `Stairs ${l.dir} to ${l.target!.floor.name}`, tint: '#a86cc1' },
        portal: { targetSceneId: l.target!.scene.id },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      writes.push({ Put: { Item: objectItem(obj) } });
    }
  });

  const record: FloorplanRecord = {
    id: ulid(),
    campaignId,
    name: body.input.name,
    input: body.input,
    roomNames: body.roomNames,
    showLabels: body.showLabels,
    floors: ordered.map((c) => ({ level: c.floor.level, name: c.floor.name, mapId: c.map.id, sceneId: c.scene.id })),
    createdBy: actor.sub,
    createdAt: now,
  };
  writes.push({ Put: { Item: { ...keys.floorplan(campaignId, record.id), entity: 'Floorplan', ...record } } });
  await deps.db.transact(writes);
  return record;
}

export async function listFloorplans(deps: Deps, actor: Actor, campaignId: string) {
  const ctx = await loadCampaign(deps, actor, campaignId);
  requireGM(ctx);
  return deps.db.queryPrefix<FloorplanRecord>(`CAMP#${campaignId}`, 'FLOORPLAN#', { forward: false });
}
