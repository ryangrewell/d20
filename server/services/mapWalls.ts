/** Walls for a map: drawn by the GM, or derived from the interior generator's floorplan. */
import type { MapWalls } from '@shared/lighting/walls';
import type { MapDefinition } from '@shared/model';
import { keys } from '../repo/db';
import type { Deps } from '../context';
import { generatedWalls, regenerate, type FloorplanRecord } from './floorplans';

/**
 * The map's walls. Maps generated before walls were stored get them from their floorplan
 * record (regenerated exactly from its seed) and saved once.
 */
export async function loadMapWalls(deps: Deps, map: MapDefinition): Promise<MapWalls | null> {
  if (map.walls) return map.walls;
  const ppm = map.calibration?.pixelsPerMeter;
  if (!ppm) return null;
  const records = await deps.db.queryPrefix<FloorplanRecord>(`CAMP#${map.campaignId}`, 'FLOORPLAN#');
  for (const rec of records) {
    const floor = rec.floors.find((f) => f.mapId === map.id);
    if (!floor) continue;
    const walls = generatedWalls(regenerate(rec.input), floor.level, ppm, rec.roomNames);
    if (!walls) return null;
    await deps.db.update({ Key: keys.map(map.campaignId, map.id), UpdateExpression: 'SET walls = :w', ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeValues: { ':w': walls } });
    return walls;
  }
  return null;
}
