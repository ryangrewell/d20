/**
 * Deterministic, geometry-first building-interior generator (spec section 6).
 *
 * All geometry is in meters with the origin at the building's top-left
 * corner; the front (street) wall is the bottom edge (y = depth). The outer
 * footprint is exactly the requested size; rooms tile it with no gaps or
 * overlaps. Same input + seed always produces the same floorplan, so the
 * server can regenerate and validate anything a client uploads.
 */
import { toMeters } from '../units';
import { createRng, type Rng } from './rng';

export const BUILDING_TYPES = ['residence', 'townhouse', 'tavern', 'inn', 'shop', 'warehouse', 'office', 'barracks', 'manor', 'school', 'temple', 'dungeon', 'generic'] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];
export const THEMES = ['medieval', 'fantasy', 'modern', 'industrial', 'scifi'] as const;
export type Theme = (typeof THEMES)[number];
export type Density = 'sparse' | 'normal' | 'dense';

export type FloorplanInput = {
  name: string;
  buildingType: BuildingType;
  width: number;
  depth: number;
  unit: 'ft' | 'm';
  floors: number;
  basement: boolean;
  density: Density;
  theme: Theme;
  seed: string;
};

export const LIMITS = { minFt: 20, maxFt: 300, minM: 6, maxM: 90, maxFloors: 4 };

export type Rect = { x: number; y: number; w: number; h: number };
export type RoomKind = 'room' | 'hall' | 'stairs';
export type Room = Rect & { id: string; name: string; kind: RoomKind };
export type Opening = { id: string; x: number; y: number; orientation: 'h' | 'v'; width: number };
export type Door = Opening & { between: [string, string] };
export type WindowOpening = Opening & { roomId: string };
export type Stairs = Rect & { direction: 'up' | 'down' | 'both' };
export type Floor = { level: number; name: string; rooms: Room[]; doors: Door[]; windows: WindowOpening[]; stairs: Stairs | null };
export type Floorplan = { version: 1; input: FloorplanInput; widthM: number; depthM: number; cellM: number; floors: Floor[] };

type Spec = { name: string; weight: number; kind?: RoomKind };
type Program = { ground: Spec[]; upper: Spec[]; basement: Spec[]; filler: { ground: Spec; upper: Spec; basement: Spec } };

const s = (name: string, weight: number, kind: RoomKind = 'room'): Spec => ({ name, weight, kind });
const STORAGE = s('Storage', 1);
const CELLAR = s('Cellar', 2);

const PROGRAMS: Record<BuildingType, Program> = {
  tavern: {
    ground: [s('Common room', 5), s('Kitchen', 2), s('Pantry', 1), s('Office', 1), s('Privy', 0.6)],
    upper: [s('Hall', 1.2, 'hall'), s("Owner's room", 1.4)],
    basement: [CELLAR, s('Brewing room', 1.5)],
    filler: { ground: STORAGE, upper: s('Guest room', 1), basement: STORAGE },
  },
  inn: {
    ground: [s('Dining room', 4), s('Reception', 1.5), s('Kitchen', 2), s('Laundry', 1)],
    upper: [s('Hall', 1.2, 'hall'), s('Linen room', 0.6)],
    basement: [CELLAR],
    filler: { ground: STORAGE, upper: s('Guest room', 1), basement: STORAGE },
  },
  residence: {
    ground: [s('Living room', 3), s('Kitchen', 2), s('Dining room', 1.5), s('Bath', 0.8)],
    upper: [s('Hall', 1, 'hall'), s('Bath', 0.8)],
    basement: [CELLAR],
    filler: { ground: s('Bedroom', 1.5), upper: s('Bedroom', 1.5), basement: STORAGE },
  },
  townhouse: {
    ground: [s('Parlor', 2), s('Kitchen', 1.5), s('Dining room', 1.5)],
    upper: [s('Study', 1), s('Bath', 0.8)],
    basement: [CELLAR],
    filler: { ground: STORAGE, upper: s('Bedroom', 1.5), basement: STORAGE },
  },
  shop: {
    ground: [s('Shop floor', 4), s('Workshop', 2), s('Storeroom', 1.5), s('Office', 1)],
    upper: [s('Living quarters', 2), s('Bedroom', 1.2)],
    basement: [s('Vault', 1), CELLAR],
    filler: { ground: STORAGE, upper: STORAGE, basement: STORAGE },
  },
  warehouse: {
    ground: [s('Loading floor', 6), s('Office', 1)],
    upper: [s('Storage loft', 3)],
    basement: [CELLAR],
    filler: { ground: s('Storage bay', 3), upper: s('Storage bay', 2), basement: STORAGE },
  },
  office: {
    ground: [s('Lobby', 2), s('Meeting room', 2), s('Records', 1)],
    upper: [s('Hall', 1.2, 'hall'), s('Meeting room', 1.5)],
    basement: [s('Archive', 2)],
    filler: { ground: s('Office', 1), upper: s('Office', 1), basement: STORAGE },
  },
  barracks: {
    ground: [s('Mess hall', 3), s('Armory', 1.5), s('Quartermaster', 1)],
    upper: [s('Hall', 1.2, 'hall'), s("Captain's quarters", 1.5)],
    basement: [s('Stockade', 1.5)],
    filler: { ground: s('Bunk room', 2), upper: s('Bunk room', 2), basement: STORAGE },
  },
  manor: {
    ground: [s('Great hall', 4), s('Dining hall', 2.5), s('Kitchen', 2), s('Library', 2), s('Parlor', 2), s('Study', 1), s("Servants' quarters", 1)],
    upper: [s('Gallery', 1.5, 'hall'), s('Master bedroom', 2.5), s('Bath', 1)],
    basement: [s('Wine cellar', 2)],
    filler: { ground: STORAGE, upper: s('Bedroom', 1.5), basement: STORAGE },
  },
  school: {
    ground: [s('Entrance hall', 2, 'hall'), s('Library', 2), s("Headmaster's office", 1)],
    upper: [s('Hall', 1.2, 'hall')],
    basement: [STORAGE],
    filler: { ground: s('Classroom', 2), upper: s('Classroom', 2), basement: STORAGE },
  },
  temple: {
    ground: [s('Nave', 6), s('Sanctuary', 2), s('Vestry', 1)],
    upper: [s("Priests' quarters", 2)],
    basement: [s('Crypt', 3), s('Ossuary', 1)],
    filler: { ground: s('Shrine', 1), upper: s('Cell', 1), basement: s('Tomb', 1) },
  },
  dungeon: {
    ground: [s('Guard room', 2), s('Torture chamber', 1.5), s('Storeroom', 1)],
    upper: [s('Guard post', 1.5)],
    basement: [s('Oubliette', 1)],
    filler: { ground: s('Cell', 1), upper: s('Cell', 1), basement: s('Cell', 1) },
  },
  generic: {
    ground: [s('Room', 1)],
    upper: [s('Room', 1)],
    basement: [s('Room', 1)],
    filler: { ground: s('Room', 1), upper: s('Room', 1), basement: s('Room', 1) },
  },
};

const TARGET_ROOM_M2: Record<Density, number> = { sparse: 45, normal: 28, dense: 16 };
const FLOOR_NAMES: Record<number, string> = { [-1]: 'Basement', 0: 'Ground floor', 1: 'First floor', 2: 'Second floor', 3: 'Third floor' };
const EPS = 1e-6;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export class FloorplanError extends Error {}

export function validateInput(input: FloorplanInput): string | null {
  const [min, max] = input.unit === 'ft' ? [LIMITS.minFt, LIMITS.maxFt] : [LIMITS.minM, LIMITS.maxM];
  if (!(input.width >= min && input.width <= max && input.depth >= min && input.depth <= max)) return `Width and depth must be between ${min} and ${max} ${input.unit}.`;
  if (!Number.isInteger(input.floors) || input.floors < 1 || input.floors > LIMITS.maxFloors) return `Use 1 to ${LIMITS.maxFloors} floors.`;
  if (!input.seed.trim()) return 'Enter a seed.';
  return null;
}

export function generateFloorplan(input: FloorplanInput): Floorplan {
  const err = validateInput(input);
  if (err) throw new FloorplanError(err);
  const W = r4(toMeters(input.width, input.unit));
  const D = r4(toMeters(input.depth, input.unit));
  const cell = input.unit === 'ft' ? 1.524 : 1.5;
  // Walls on whole grid squares so they line up with the table grid.
  const snap = cell;
  const minDim = input.unit === 'ft' ? 3.048 : 3;
  const doorW = input.unit === 'ft' ? 0.9144 : 1;
  const rng = createRng(`${input.seed}|${input.buildingType}|${input.width}x${input.depth}${input.unit}|${input.floors}|${input.basement}|${input.density}`);

  const levels = [...(input.basement ? [-1] : []), ...Array.from({ length: input.floors }, (_, i) => i)];
  const multi = levels.length > 1;
  const program = PROGRAMS[input.buildingType];

  // A stair core in the same place on every floor keeps stairs aligned between levels.
  const stripAlongLeft = W >= D;
  const sw = minDim;
  const sl = Math.min(cell * 3, stripAlongLeft ? D : W);
  let stairCore: { stairwell: Rect; landing: Rect | null; rest: Rect } | null = null;
  if (multi) {
    if (stripAlongLeft) {
      const landingH = D - sl;
      stairCore = {
        stairwell: { x: 0, y: 0, w: sw, h: landingH >= minDim ? sl : D },
        landing: landingH >= minDim ? { x: 0, y: sl, w: sw, h: r4(landingH) } : null,
        rest: { x: sw, y: 0, w: r4(W - sw), h: D },
      };
    } else {
      const landingW = W - sl;
      stairCore = {
        stairwell: { x: 0, y: 0, w: landingW >= minDim ? sl : W, h: sw },
        landing: landingW >= minDim ? { x: sl, y: 0, w: r4(landingW), h: sw } : null,
        rest: { x: 0, y: sw, w: W, h: r4(D - sw) },
      };
    }
  }

  const floors: Floor[] = levels.map((level) => {
    const kind = level < 0 ? 'basement' : level === 0 ? 'ground' : 'upper';
    const area = stairCore ? stairCore.rest.w * stairCore.rest.h : W * D;
    const specs = buildProgram(program, kind, area, input.density, rng);
    const parts = partition(stairCore ? stairCore.rest : { x: 0, y: 0, w: W, h: D }, specs, { snap, minDim, rng });
    const rooms: Room[] = [];
    let n = 0;
    const id = () => `f${level}r${n++}`;
    if (stairCore) {
      rooms.push({ ...stairCore.stairwell, id: id(), name: 'Stairs', kind: 'stairs' });
      if (stairCore.landing) rooms.push({ ...stairCore.landing, id: id(), name: kind === 'ground' ? 'Entry hall' : 'Landing', kind: 'hall' });
    }
    for (const p of parts) rooms.push({ x: r4(p.x), y: r4(p.y), w: r4(p.w), h: r4(p.h), id: id(), name: p.spec.name, kind: p.spec.kind ?? 'room' });
    const weights = new Map(parts.map((p, i) => [rooms[rooms.length - parts.length + i]!.id, p.spec.weight]));

    const stairs: Stairs | null = stairCore
      ? (() => {
          const sr = stairCore.stairwell;
          const inset = 0.15;
          const lo = levels[0]!;
          const hi = levels[levels.length - 1]!;
          return { x: r4(sr.x + inset), y: r4(sr.y + inset), w: r4(sr.w - inset * 2), h: r4(sr.h - inset * 2), direction: level === lo ? 'up' : level === hi ? 'down' : 'both' };
        })()
      : null;

    // Entry: ground floors are entered from the street (bottom wall); other floors from the stairs.
    const frontRooms = rooms.filter((r) => Math.abs(r.y + r.h - D) < EPS && r.kind !== 'stairs');
    const entrance = kind === 'ground' ? frontRooms.sort((a, b) => (weights.get(b.id) ?? 1.2) - (weights.get(a.id) ?? 1.2) || a.x - b.x)[0]! : rooms.find((r) => r.kind === 'stairs')!;
    const doors = placeDoors(rooms, entrance, { doorW, rng, level });
    if (kind === 'ground') {
      const ex = r4(entrance.x + entrance.w / 2);
      doors.push({ id: `f${level}dX`, x: ex, y: D, orientation: 'h', width: doorW * 1.3, between: [entrance.id, 'outside'] });
    }
    const windows = input.buildingType === 'dungeon' || kind === 'basement' ? [] : placeWindows(rooms, doors, { W, D, cell, level });
    return { level, name: FLOOR_NAMES[level] ?? `Floor ${level}`, rooms, doors, windows, stairs };
  });

  return { version: 1, input, widthM: W, depthM: D, cellM: cell, floors };
}

function buildProgram(p: Program, kind: 'ground' | 'upper' | 'basement', areaM2: number, density: Density, rng: Rng): Spec[] {
  const required = [...p[kind]];
  const count = Math.max(2, Math.min(18, Math.round(areaM2 / TARGET_ROOM_M2[density])));
  let list = required.length > count ? [...required].sort((a, b) => b.weight - a.weight).slice(0, count) : required;
  while (list.length < count) list = [...list, p.filler[kind]];
  return rng.shuffle([...list]);
}

type Part = Rect & { spec: Spec };

/** Weighted binary space partition; every resulting room respects the minimum dimension. */
function partition(rect: Rect, specs: Spec[], o: { snap: number; minDim: number; rng: Rng }): Part[] {
  if (specs.length === 1) return [{ ...rect, spec: specs[0]! }];
  const total = specs.reduce((t, x) => t + x.weight, 0);
  const canSplitX = rect.w >= 2 * o.minDim - EPS;
  const canSplitY = rect.h >= 2 * o.minDim - EPS;
  if (!canSplitX && !canSplitY) {
    // Too small for more rooms: keep the heaviest.
    const keep = [...specs].sort((a, b) => b.weight - a.weight)[0]!;
    return [{ ...rect, spec: keep }];
  }
  let splitY = rect.h > rect.w * 1.2 ? true : rect.w > rect.h * 1.2 ? false : o.rng.chance(0.5);
  if (splitY && !canSplitY) splitY = false;
  if (!splitY && !canSplitX) splitY = true;

  let k = 1;
  let best = Infinity;
  let cum = 0;
  for (let i = 1; i < specs.length; i++) {
    cum += specs[i - 1]!.weight;
    const d = Math.abs(cum / total - 0.5);
    if (d < best) {
      best = d;
      k = i;
    }
  }
  const left = specs.slice(0, k);
  const right = specs.slice(k);
  const ratio = left.reduce((t, x) => t + x.weight, 0) / total + (o.rng.next() - 0.5) * 0.1;
  const len = splitY ? rect.h : rect.w;
  const pos = Math.min(len - o.minDim, Math.max(o.minDim, Math.round((len * ratio) / o.snap) * o.snap));
  const a: Rect = splitY ? { x: rect.x, y: rect.y, w: rect.w, h: r4(pos) } : { x: rect.x, y: rect.y, w: r4(pos), h: rect.h };
  const b: Rect = splitY ? { x: rect.x, y: r4(rect.y + pos), w: rect.w, h: r4(rect.h - pos) } : { x: r4(rect.x + pos), y: rect.y, w: r4(rect.w - pos), h: rect.h };
  return [...partition(a, left, o), ...partition(b, right, o)];
}

type Edge = { orientation: 'h' | 'v'; at: number; from: number; to: number };

export function sharedEdge(a: Rect, b: Rect): Edge | null {
  const vx = Math.abs(a.x + a.w - b.x) < EPS ? a.x + a.w : Math.abs(b.x + b.w - a.x) < EPS ? a.x : null;
  if (vx !== null) {
    const from = Math.max(a.y, b.y);
    const to = Math.min(a.y + a.h, b.y + b.h);
    return to - from > EPS ? { orientation: 'v', at: vx, from, to } : null;
  }
  const hy = Math.abs(a.y + a.h - b.y) < EPS ? a.y + a.h : Math.abs(b.y + b.h - a.y) < EPS ? a.y : null;
  if (hy !== null) {
    const from = Math.max(a.x, b.x);
    const to = Math.min(a.x + a.w, b.x + b.w);
    return to - from > EPS ? { orientation: 'h', at: hy, from, to } : null;
  }
  return null;
}

function placeDoors(rooms: Room[], root: Room, o: { doorW: number; rng: Rng; level: number }): Door[] {
  const need = o.doorW + 0.4;
  const adj = new Map<string, { other: Room; edge: Edge }[]>(rooms.map((r) => [r.id, []]));
  for (let i = 0; i < rooms.length; i++)
    for (let j = i + 1; j < rooms.length; j++) {
      const e = sharedEdge(rooms[i]!, rooms[j]!);
      if (e && e.to - e.from >= need) {
        adj.get(rooms[i]!.id)!.push({ other: rooms[j]!, edge: e });
        adj.get(rooms[j]!.id)!.push({ other: rooms[i]!, edge: e });
      }
    }
  const doors: Door[] = [];
  let n = 0;
  const add = (a: Room, b: Room, e: Edge) => {
    const slack = Math.max(0, (e.to - e.from - o.doorW) / 2 - 0.2);
    const c = Math.round(((e.from + e.to) / 2 + (o.rng.next() - 0.5) * 2 * slack) * 4) / 4;
    const center = Math.min(e.to - o.doorW / 2 - 0.1, Math.max(e.from + o.doorW / 2 + 0.1, c));
    doors.push({ id: `f${o.level}d${n++}`, orientation: e.orientation, x: r4(e.orientation === 'v' ? e.at : center), y: r4(e.orientation === 'v' ? center : e.at), width: o.doorW, between: [a.id, b.id] });
  };
  // Spanning tree from the entry guarantees every room is reachable.
  const seen = new Set([root.id]);
  const queue = [root];
  const treeEdges = new Set<string>();
  while (queue.length) {
    const r = queue.shift()!;
    for (const { other, edge } of o.rng.shuffle([...adj.get(r.id)!])) {
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      treeEdges.add([r.id, other.id].sort().join('|'));
      add(r, other, edge);
      queue.push(other);
    }
  }
  // A few extra doors make loops so rooms aren't all dead ends.
  for (const r of rooms)
    for (const { other, edge } of adj.get(r.id)!) {
      const key = [r.id, other.id].sort().join('|');
      if (r.id < other.id && !treeEdges.has(key) && r.kind !== 'stairs' && other.kind !== 'stairs' && o.rng.chance(0.2)) add(r, other, edge);
    }
  return doors;
}

function placeWindows(rooms: Room[], doors: Door[], o: { W: number; D: number; cell: number; level: number }): WindowOpening[] {
  const out: WindowOpening[] = [];
  let n = 0;
  const spacing = o.cell * 3;
  const nearDoor = (x: number, y: number) => doors.some((d) => d.between.includes('outside') && Math.hypot(d.x - x, d.y - y) < 1.5);
  for (const r of rooms) {
    if (r.kind === 'stairs') continue;
    const edges: { orientation: 'h' | 'v'; at: number; from: number; to: number }[] = [];
    if (Math.abs(r.y) < EPS) edges.push({ orientation: 'h', at: 0, from: r.x, to: r.x + r.w });
    if (Math.abs(r.y + r.h - o.D) < EPS) edges.push({ orientation: 'h', at: o.D, from: r.x, to: r.x + r.w });
    if (Math.abs(r.x) < EPS) edges.push({ orientation: 'v', at: 0, from: r.y, to: r.y + r.h });
    if (Math.abs(r.x + r.w - o.W) < EPS) edges.push({ orientation: 'v', at: o.W, from: r.y, to: r.y + r.h });
    for (const e of edges) {
      const count = Math.floor((e.to - e.from) / spacing);
      for (let i = 0; i < count; i++) {
        const c = e.from + (e.to - e.from) * ((i + 0.5) / count);
        const x = e.orientation === 'h' ? c : e.at;
        const y = e.orientation === 'h' ? e.at : c;
        if (!nearDoor(x, y)) out.push({ id: `f${o.level}w${n++}`, x: r4(x), y: r4(y), orientation: e.orientation, width: r4(o.cell * 0.8), roomId: r.id });
      }
    }
  }
  return out;
}

/** Structural checks from spec 6.3. Returns human-readable problems (empty = valid). */
export function validateFloorplan(fp: Floorplan): string[] {
  const errs: string[] = [];
  const { widthM: W, depthM: D } = fp;
  const stairPos = fp.floors.map((f) => (f.stairs ? `${f.stairs.x},${f.stairs.y},${f.stairs.w},${f.stairs.h}` : null));
  if (fp.floors.length > 1 && stairPos.some((p) => p === null)) errs.push('Every floor of a multi-floor building needs stairs.');
  if (new Set(stairPos).size > 1) errs.push('Stairs do not line up between floors.');
  for (const f of fp.floors) {
    let area = 0;
    for (const r of f.rooms) {
      area += r.w * r.h;
      if (r.x < -EPS || r.y < -EPS || r.x + r.w > W + 1e-3 || r.y + r.h > D + 1e-3) errs.push(`${f.name}: ${r.name} extends outside the building.`);
      if (r.w < 1.4 || r.h < 1.4) errs.push(`${f.name}: ${r.name} is too small.`);
    }
    for (let i = 0; i < f.rooms.length; i++)
      for (let j = i + 1; j < f.rooms.length; j++) {
        const a = f.rooms[i]!;
        const b = f.rooms[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 1e-3 && oy > 1e-3) errs.push(`${f.name}: ${a.name} overlaps ${b.name}.`);
      }
    if (Math.abs(area - W * D) > W * D * 1e-4) errs.push(`${f.name}: rooms do not fill the footprint.`);
    const byId = new Map(f.rooms.map((r) => [r.id, r]));
    const graph = new Map<string, string[]>([['outside', []], ...f.rooms.map((r) => [r.id, []] as [string, string[]])]);
    for (const d of f.doors) {
      const [a, b] = d.between;
      const ra = byId.get(a);
      const rb = b === 'outside' ? null : byId.get(b);
      if (!ra || (b !== 'outside' && !rb)) {
        errs.push(`${f.name}: a door refers to a missing room.`);
        continue;
      }
      if (rb) {
        const e = sharedEdge(ra, rb);
        const along = d.orientation === 'v' ? d.y : d.x;
        if (!e || e.orientation !== d.orientation || Math.abs((d.orientation === 'v' ? d.x : d.y) - e.at) > 1e-3 || along - d.width / 2 < e.from - 1e-3 || along + d.width / 2 > e.to + 1e-3)
          errs.push(`${f.name}: a door between ${ra.name} and ${rb.name} is not on their shared wall.`);
      }
      graph.get(a)!.push(b);
      graph.get(b)!.push(a);
    }
    const start = f.level === 0 ? 'outside' : f.rooms.find((r) => r.kind === 'stairs')?.id ?? f.rooms[0]!.id;
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      for (const nb of graph.get(q.shift()!)!) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        q.push(nb);
      }
    }
    const unreachable = f.rooms.filter((r) => !seen.has(r.id));
    if (unreachable.length) errs.push(`${f.name}: ${unreachable.map((r) => r.name).join(', ')} cannot be reached.`);
  }
  return errs;
}
