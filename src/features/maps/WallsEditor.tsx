/**
 * Walls & rooms for uploaded maps: the GM outlines rooms or buildings (rectangles or click-by-click
 * shapes), draws open wall lines (fences, barricades) and marks doorways. Every outline and line
 * blocks torchlight; rooms reveal when a character walks in, buildings never do.
 * Generated maps get theirs from the interior generator and show them read-only.
 */
import { useState } from 'react';
import { DoorOpen, Eraser, Fence, Pentagon, Square, Trash2 } from 'lucide-react';
import { distToSegmentSq } from '@shared/fog';
import type { Point } from '@shared/geometry/transform';
import { roomsContaining, snapToRooms, type MapWalls, type Segment, type WallRoom } from '@shared/lighting/walls';
import { Button, Input, cn } from '@/components/ui/primitives';

export type WallTool = 'room-rect' | 'room-shape' | 'wall-line' | 'doorway' | 'erase';
export const isWallTool = (t: string): t is WallTool => ['room-rect', 'room-shape', 'wall-line', 'doorway', 'erase'].includes(t);
type AreaKind = NonNullable<WallRoom['kind']>;

/** How close (in screen pixels) a click must be to snap onto a wall or close a shape. */
const SNAP_SCREEN_PX = 12;
const MIN_ROOM_PX = 4;

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const edgesOf = (r: WallRoom): Segment[] => r.points.map((a, i) => ({ a, b: r.points[(i + 1) % r.points.length]! }));
const lineEdges = (pts: Point[]): Segment[] => pts.slice(1).map((b, i) => ({ a: pts[i]!, b }));
const near = (p: Point, q: Point, tol: number) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;

function project(p: Point, e: Segment): Point {
  const dx = e.b.x - e.a.x;
  const dy = e.b.y - e.a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / len2));
  return { x: e.a.x + t * dx, y: e.a.y + t * dy };
}

/** The wall a doorway can go in: room walls and wall lines (buildings are entered by switching scenes). */
function nearestEdge(walls: MapWalls, p: Point, tol: number): Segment | null {
  let best: Segment | null = null;
  let bestD = tol * tol;
  const candidates = [...walls.rooms.filter((r) => r.kind !== 'building').flatMap(edgesOf), ...(walls.lines ?? []).flatMap(lineEdges)];
  for (const e of candidates) {
    const d = distToSegmentSq(p, e.a, e.b);
    if (d <= bestD) [best, bestD] = [e, d];
  }
  return best;
}

const editable = (w: MapWalls | undefined): MapWalls => ({ rooms: w?.rooms ?? [], doorways: w?.doorways ?? [], lines: w?.lines ?? [] });

/** Editor state and pointer handling; `zoom` converts the screen snap distance into map pixels. */
export function useWallsEditor(initial: MapWalls | undefined, bounds: { w: number; h: number }) {
  const [walls, setWalls] = useState<MapWalls>(() => editable(initial));
  const [kind, setKind] = useState<AreaKind>('room');
  const [line, setLine] = useState<Point[]>([]);
  const [dirty, setDirty] = useState(false);
  const [rect, setRect] = useState<[Point, Point] | null>(null);
  const [shape, setShape] = useState<Point[]>([]);
  const [doorStart, setDoorStart] = useState<{ p: Point; edge: Segment } | null>(null);
  const clamp = (p: Point): Point => ({ x: Math.min(Math.max(0, p.x), bounds.w), y: Math.min(Math.max(0, p.y), bounds.h) });
  const change = (next: MapWalls) => {
    setWalls(next);
    setDirty(true);
  };
  const addRoom = (points: Point[]) => {
    const n = walls.rooms.filter((r) => (r.kind ?? 'room') === kind).length + 1;
    const room: WallRoom = kind === 'building' ? { id: newId(), name: `Building ${n}`, kind, points } : { id: newId(), name: `Room ${n}`, points };
    change({ ...walls, rooms: [...walls.rooms, room] });
  };
  const finishLine = (pts: Point[]) => {
    const clean = pts.filter((p, i) => i === 0 || !near(p, pts[i - 1]!, 0.5));
    if (clean.length >= 2) change({ ...walls, lines: [...(walls.lines ?? []), clean] });
    setLine([]);
  };

  const closeShape = (pts: Point[]) => {
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 0.5);
    if (clean.length >= 3) addRoom(clean);
    setShape([]);
  };

  return {
    walls,
    dirty,
    kind,
    setKind,
    draft: { rect, shape, line, doorStart: doorStart?.p ?? null },
    reset: (w: MapWalls | undefined) => {
      setWalls(editable(w));
      setDirty(false);
    },
    markSaved: () => setDirty(false),
    rename: (id: string, name: string) => change({ ...walls, rooms: walls.rooms.map((r) => (r.id === id ? { ...r, name } : r)) }),
    removeRoom: (id: string) => change({ ...walls, rooms: walls.rooms.filter((r) => r.id !== id) }),
    clearDraft: () => {
      setRect(null);
      setShape([]);
      setLine([]);
      setDoorStart(null);
    },
    down(tool: WallTool, raw: Point, zoom: number) {
      const tol = SNAP_SCREEN_PX / zoom;
      // New room corners line up with existing ones so neighbouring walls meet.
      const p = tool === 'room-rect' || tool === 'room-shape' || tool === 'wall-line' ? clamp(snapToRooms(walls, raw, tol)) : clamp(raw);
      if (tool === 'room-rect') setRect([p, p]);
      if (tool === 'room-shape') {
        if (shape.length >= 3 && Math.hypot(p.x - shape[0]!.x, p.y - shape[0]!.y) <= tol) closeShape(shape);
        else setShape([...shape, p]);
      }
      if (tool === 'wall-line') {
        // Clicking the last point again ends the line.
        if (line.length >= 2 && near(p, line.at(-1)!, tol)) finishLine(line);
        else setLine([...line, p]);
      }
      if (tool === 'doorway') {
        if (!doorStart) {
          const edge = nearestEdge(walls, p, tol);
          if (edge) setDoorStart({ p: project(p, edge), edge });
        } else {
          // The doorway runs along the wall it started on.
          const end = project(p, doorStart.edge);
          if (Math.hypot(end.x - doorStart.p.x, end.y - doorStart.p.y) > 1) change({ ...walls, doorways: [...walls.doorways, { a: doorStart.p, b: end }] });
          setDoorStart(null);
        }
      }
      if (tool === 'erase') {
        const door = walls.doorways.findIndex((d) => distToSegmentSq(p, d.a, d.b) <= tol * tol);
        if (door >= 0) return change({ ...walls, doorways: walls.doorways.filter((_, i) => i !== door) });
        const hitLine = (walls.lines ?? []).findIndex((l) => lineEdges(l).some((e) => distToSegmentSq(p, e.a, e.b) <= tol * tol));
        if (hitLine >= 0) return change({ ...walls, lines: (walls.lines ?? []).filter((_, i) => i !== hitLine) });
        const hit = roomsContaining(walls, p).at(-1);
        if (hit) change({ ...walls, rooms: walls.rooms.filter((r) => r.id !== hit.id) });
      }
    },
    move(tool: WallTool, raw: Point, zoom: number) {
      if (tool === 'room-rect' && rect) setRect([rect[0], clamp(snapToRooms(walls, raw, SNAP_SCREEN_PX / zoom))]);
    },
    up(tool: WallTool) {
      if (tool !== 'room-rect' || !rect) return;
      const [a, b] = rect;
      setRect(null);
      if (Math.abs(b.x - a.x) < MIN_ROOM_PX || Math.abs(b.y - a.y) < MIN_ROOM_PX) return;
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      addRoom([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
    },
    doubleClick(tool: WallTool) {
      if (tool === 'room-shape' && shape.length >= 3) closeShape(shape);
      if (tool === 'wall-line') finishLine(line);
    },
  };
}

export type WallsEditor = ReturnType<typeof useWallsEditor>;

const TOOLS: { id: WallTool; label: string; icon: typeof Square; hint: string }[] = [
  { id: 'room-rect', label: 'Rectangle', icon: Square, hint: 'Drag across the area.' },
  { id: 'room-shape', label: 'Shape', icon: Pentagon, hint: 'Click each corner; click the first corner (or double-click) to finish.' },
  { id: 'wall-line', label: 'Wall line', icon: Fence, hint: 'For fences, walls and barricades: click each point; click the last point again (or double-click) to finish. Light stops at it.' },
  { id: 'doorway', label: 'Doorway', icon: DoorOpen, hint: 'Click two points along a room wall or wall line (a gate). Light passes through doorways.' },
  { id: 'erase', label: 'Delete', icon: Eraser, hint: 'Click a room, building, wall line or doorway to remove it.' },
];

const KINDS: { id: AreaKind; label: string; hint: string }[] = [
  { id: 'room', label: 'Room', hint: 'Reveals when a character walks in.' },
  { id: 'building', label: 'Building', hint: 'Blocks light from outside and never reveals. Switch scenes to go inside.' },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Sidebar section on the Scale & grid screen. */
export function WallsSection({ editor, tool, setTool, readOnly, saving, onSave }: { editor: WallsEditor; tool: string; setTool: (t: WallTool) => void; readOnly: boolean; saving: boolean; onSave: () => void }) {
  const { walls } = editor;
  const active = TOOLS.find((t) => t.id === tool);
  const buildings = walls.rooms.filter((r) => r.kind === 'building').length;
  const drawsArea = tool === 'room-rect' || tool === 'room-shape';
  return (
    <section className="space-y-3" aria-label="Walls and rooms">
      <h2 className="flex items-center gap-2 text-sm font-semibold">Walls &amp; rooms</h2>
      {readOnly ? (
        <p className="text-xs text-muted">Walls come from the generator: {walls.rooms.length} rooms and {walls.doorways.length} doorways.</p>
      ) : (
        <>
          <p className="text-xs text-muted">Outline rooms indoors, or buildings and wall lines outdoors. Torchlight stops at every wall; rooms also reveal when a character walks in.</p>
          <div className="grid grid-cols-2 gap-1.5">
            {TOOLS.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={tool === t.id ? 'secondary' : 'outline'}
                aria-pressed={tool === t.id}
                className="justify-start"
                onClick={() => {
                  editor.clearDraft();
                  setTool(t.id);
                }}
              >
                <t.icon className="h-4 w-4" aria-hidden /> {t.label}
              </Button>
            ))}
          </div>
          {drawsArea && (
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Area type">
              {KINDS.map((k) => (
                <button key={k.id} role="radio" aria-checked={editor.kind === k.id} className={cn('rounded-md py-1.5 text-xs', editor.kind === k.id ? 'bg-surface-3 text-text' : 'text-muted')} onClick={() => editor.setKind(k.id)}>
                  {k.label}
                </button>
              ))}
            </div>
          )}
          {active && (
            <p className="text-xs text-faint">
              {active.hint}
              {drawsArea && <> {KINDS.find((k) => k.id === editor.kind)!.hint}</>}
            </p>
          )}
          {walls.rooms.length > 0 && (
            <ul aria-label="Rooms and buildings" className="space-y-1">
              {walls.rooms.map((r) => (
                <li key={r.id} className="flex items-center gap-1.5">
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', r.kind === 'building' ? 'bg-[#7f9cc4]' : 'bg-[#f2c14e]')} title={r.kind === 'building' ? 'Building' : 'Room'} aria-hidden />
                  <Input aria-label={`Name of ${r.name ?? 'room'}`} className="h-7 text-xs" value={r.name ?? ''} maxLength={80} onChange={(e) => editor.rename(r.id, e.target.value)} />
                  <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Delete ${r.name ?? 'room'}`} onClick={() => editor.removeRoom(r.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-faint">
            {[plural(walls.rooms.length - buildings, 'room'), buildings && plural(buildings, 'building'), walls.lines?.length && plural(walls.lines.length, 'wall line'), plural(walls.doorways.length, 'doorway')].filter(Boolean).join(' · ')}
          </p>
          <Button className="w-full justify-center" variant={editor.dirty ? 'primary' : 'secondary'} disabled={!editor.dirty} loading={saving} onClick={onSave}>
            Save walls
          </Button>
        </>
      )}
    </section>
  );
}

const ROOM = '#f2c14e';
const BUILDING = '#7f9cc4';
const LINE = '#e0823d';

/** Rooms, buildings, wall lines, doorways and whatever is being drawn, in screen space. */
export function WallsOverlay({ editor, toScreen }: { editor: WallsEditor; toScreen: (p: Point) => Point }) {
  const pts = (ps: Point[]) => ps.map((p) => toScreen(p)).map((p) => `${p.x},${p.y}`).join(' ');
  const { rect, shape, line, doorStart } = editor.draft;
  const draftColor = editor.kind === 'building' ? BUILDING : ROOM;
  return (
    <g>
      {editor.walls.rooms.map((r) =>
        r.kind === 'building' ? (
          <polygon key={r.id} points={pts(r.points)} fill="rgba(127,156,196,0.22)" stroke={BUILDING} strokeWidth={2} />
        ) : (
          <polygon key={r.id} points={pts(r.points)} fill="rgba(242,193,78,0.10)" stroke={ROOM} strokeWidth={2} />
        ),
      )}
      {(editor.walls.lines ?? []).map((l, i) => (
        <polyline key={i} points={pts(l)} fill="none" stroke={LINE} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {editor.walls.doorways.map((d, i) => {
        const [a, b] = [toScreen(d.a), toScreen(d.b)];
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#46a758" strokeWidth={5} strokeDasharray="6 4" strokeLinecap="round" />;
      })}
      {rect && <polygon points={pts([rect[0], { x: rect[1].x, y: rect[0].y }, rect[1], { x: rect[0].x, y: rect[1].y }])} fill="none" stroke={draftColor} strokeDasharray="5 4" strokeWidth={2} />}
      {shape.length > 0 && (
        <>
          <polyline points={pts(shape)} fill="none" stroke={draftColor} strokeDasharray="5 4" strokeWidth={2} />
          {shape.map((p, i) => {
            const s = toScreen(p);
            return <circle key={i} cx={s.x} cy={s.y} r={i === 0 ? 6 : 3.5} className={cn(i === 0 && 'animate-pulse')} fill={draftColor} />;
          })}
        </>
      )}
      {line.length > 0 && (
        <>
          <polyline points={pts(line)} fill="none" stroke={LINE} strokeDasharray="5 4" strokeWidth={3} />
          {line.map((p, i) => {
            const s = toScreen(p);
            return <circle key={i} cx={s.x} cy={s.y} r={i === line.length - 1 ? 6 : 3.5} className={cn(i === line.length - 1 && 'animate-pulse')} fill={LINE} />;
          })}
        </>
      )}
      {doorStart && <circle cx={toScreen(doorStart).x} cy={toScreen(doorStart).y} r={5} fill="#46a758" />}
    </g>
  );
}
