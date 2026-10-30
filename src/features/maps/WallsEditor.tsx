/**
 * Walls & rooms for uploaded maps: the GM outlines rooms (rectangles or click-by-click shapes)
 * and marks doorways in their walls. Rooms drive room reveal; outlines block torchlight.
 * Generated maps get theirs from the interior generator and show them read-only.
 */
import { useState } from 'react';
import { DoorOpen, Eraser, Pentagon, Square, Trash2 } from 'lucide-react';
import { distToSegmentSq } from '@shared/fog';
import type { Point } from '@shared/geometry/transform';
import { roomsContaining, snapToRooms, type MapWalls, type Segment, type WallRoom } from '@shared/lighting/walls';
import { Button, Input, cn } from '@/components/ui/primitives';

export type WallTool = 'room-rect' | 'room-shape' | 'doorway' | 'erase';
export const isWallTool = (t: string): t is WallTool => ['room-rect', 'room-shape', 'doorway', 'erase'].includes(t);

/** How close (in screen pixels) a click must be to snap onto a wall or close a shape. */
const SNAP_SCREEN_PX = 12;
const MIN_ROOM_PX = 4;

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const edgesOf = (r: WallRoom): Segment[] => r.points.map((a, i) => ({ a, b: r.points[(i + 1) % r.points.length]! }));

function project(p: Point, e: Segment): Point {
  const dx = e.b.x - e.a.x;
  const dy = e.b.y - e.a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / len2));
  return { x: e.a.x + t * dx, y: e.a.y + t * dy };
}

function nearestEdge(walls: MapWalls, p: Point, tol: number): Segment | null {
  let best: Segment | null = null;
  let bestD = tol * tol;
  for (const r of walls.rooms) {
    for (const e of edgesOf(r)) {
      const d = distToSegmentSq(p, e.a, e.b);
      if (d <= bestD) [best, bestD] = [e, d];
    }
  }
  return best;
}

/** Editor state and pointer handling; `zoom` converts the screen snap distance into map pixels. */
export function useWallsEditor(initial: MapWalls | undefined, bounds: { w: number; h: number }) {
  const [walls, setWalls] = useState<MapWalls>(initial ? { rooms: initial.rooms, doorways: initial.doorways } : { rooms: [], doorways: [] });
  const [dirty, setDirty] = useState(false);
  const [rect, setRect] = useState<[Point, Point] | null>(null);
  const [shape, setShape] = useState<Point[]>([]);
  const [doorStart, setDoorStart] = useState<{ p: Point; edge: Segment } | null>(null);
  const clamp = (p: Point): Point => ({ x: Math.min(Math.max(0, p.x), bounds.w), y: Math.min(Math.max(0, p.y), bounds.h) });
  const change = (next: MapWalls) => {
    setWalls(next);
    setDirty(true);
  };
  const addRoom = (points: Point[]) => change({ ...walls, rooms: [...walls.rooms, { id: newId(), name: `Room ${walls.rooms.length + 1}`, points }] });

  const closeShape = (pts: Point[]) => {
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 0.5);
    if (clean.length >= 3) addRoom(clean);
    setShape([]);
  };

  return {
    walls,
    dirty,
    draft: { rect, shape, doorStart: doorStart?.p ?? null },
    reset: (w: MapWalls | undefined) => {
      setWalls(w ? { rooms: w.rooms, doorways: w.doorways } : { rooms: [], doorways: [] });
      setDirty(false);
    },
    markSaved: () => setDirty(false),
    rename: (id: string, name: string) => change({ ...walls, rooms: walls.rooms.map((r) => (r.id === id ? { ...r, name } : r)) }),
    removeRoom: (id: string) => change({ ...walls, rooms: walls.rooms.filter((r) => r.id !== id) }),
    clearDraft: () => {
      setRect(null);
      setShape([]);
      setDoorStart(null);
    },
    down(tool: WallTool, raw: Point, zoom: number) {
      const tol = SNAP_SCREEN_PX / zoom;
      // New room corners line up with existing ones so neighbouring walls meet.
      const p = tool === 'room-rect' || tool === 'room-shape' ? clamp(snapToRooms(walls, raw, tol)) : clamp(raw);
      if (tool === 'room-rect') setRect([p, p]);
      if (tool === 'room-shape') {
        if (shape.length >= 3 && Math.hypot(p.x - shape[0]!.x, p.y - shape[0]!.y) <= tol) closeShape(shape);
        else setShape([...shape, p]);
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
    },
  };
}

export type WallsEditor = ReturnType<typeof useWallsEditor>;

const TOOLS: { id: WallTool; label: string; icon: typeof Square; hint: string }[] = [
  { id: 'room-rect', label: 'Rectangle room', icon: Square, hint: 'Drag across a room.' },
  { id: 'room-shape', label: 'Shape room', icon: Pentagon, hint: 'Click each corner; click the first corner (or double-click) to finish.' },
  { id: 'doorway', label: 'Doorway', icon: DoorOpen, hint: 'Click two points along a wall. Light passes through doorways.' },
  { id: 'erase', label: 'Delete', icon: Eraser, hint: 'Click a room or a doorway to remove it.' },
];

/** Sidebar section on the Scale & grid screen. */
export function WallsSection({ editor, tool, setTool, readOnly, saving, onSave }: { editor: WallsEditor; tool: string; setTool: (t: WallTool) => void; readOnly: boolean; saving: boolean; onSave: () => void }) {
  const { walls } = editor;
  const active = TOOLS.find((t) => t.id === tool);
  return (
    <section className="space-y-3" aria-label="Walls and rooms">
      <h2 className="flex items-center gap-2 text-sm font-semibold">Walls &amp; rooms</h2>
      {readOnly ? (
        <p className="text-xs text-muted">Walls come from the generator: {walls.rooms.length} rooms and {walls.doorways.length} doorways.</p>
      ) : (
        <>
          <p className="text-xs text-muted">Outline rooms so they can reveal when a character walks in, and so torchlight stops at walls.</p>
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
          {active && <p className="text-xs text-faint">{active.hint}</p>}
          {walls.rooms.length > 0 && (
            <ul aria-label="Rooms" className="space-y-1">
              {walls.rooms.map((r) => (
                <li key={r.id} className="flex items-center gap-1.5">
                  <Input aria-label={`Name of ${r.name ?? 'room'}`} className="h-7 text-xs" value={r.name ?? ''} maxLength={80} onChange={(e) => editor.rename(r.id, e.target.value)} />
                  <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Delete ${r.name ?? 'room'}`} onClick={() => editor.removeRoom(r.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-faint">
            {walls.rooms.length} room{walls.rooms.length === 1 ? '' : 's'} · {walls.doorways.length} doorway{walls.doorways.length === 1 ? '' : 's'}
          </p>
          <Button className="w-full justify-center" variant={editor.dirty ? 'primary' : 'secondary'} disabled={!editor.dirty} loading={saving} onClick={onSave}>
            Save walls
          </Button>
        </>
      )}
    </section>
  );
}

/** Rooms, doorways and the shape being drawn, in screen space. */
export function WallsOverlay({ editor, toScreen }: { editor: WallsEditor; toScreen: (p: Point) => Point }) {
  const pts = (ps: Point[]) => ps.map((p) => toScreen(p)).map((p) => `${p.x},${p.y}`).join(' ');
  const { rect, shape, doorStart } = editor.draft;
  return (
    <g>
      {editor.walls.rooms.map((r) => (
        <polygon key={r.id} points={pts(r.points)} fill="rgba(242,193,78,0.10)" stroke="#f2c14e" strokeWidth={2} />
      ))}
      {editor.walls.doorways.map((d, i) => {
        const [a, b] = [toScreen(d.a), toScreen(d.b)];
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#46a758" strokeWidth={5} strokeDasharray="6 4" strokeLinecap="round" />;
      })}
      {rect && <polygon points={pts([rect[0], { x: rect[1].x, y: rect[0].y }, rect[1], { x: rect[0].x, y: rect[1].y }])} fill="rgba(242,193,78,0.18)" stroke="#f2c14e" strokeDasharray="5 4" strokeWidth={2} />}
      {shape.length > 0 && (
        <>
          <polyline points={pts(shape)} fill="none" stroke="#f2c14e" strokeDasharray="5 4" strokeWidth={2} />
          {shape.map((p, i) => {
            const s = toScreen(p);
            return <circle key={i} cx={s.x} cy={s.y} r={i === 0 ? 6 : 3.5} className={cn(i === 0 && 'animate-pulse')} fill="#f2c14e" />;
          })}
        </>
      )}
      {doorStart && <circle cx={toScreen(doorStart).x} cy={toScreen(doorStart).y} r={5} fill="#46a758" />}
    </g>
  );
}
