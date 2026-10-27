import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { centerOn, distance, fitCamera, normalize, panBy, screenToMap, zoomAt, type Camera, type Point } from '@shared/geometry/transform';
import { gridSpacingPixels, snapToGrid } from '@shared/geometry/grid';
import { formatDistance } from '@shared/units';
import type { FogOp } from '@shared/fog';
import { TabletopRenderer } from './renderer/TabletopRenderer';
import { getTable, setTable, useTable, type TableObject } from './store';
import type { SyncEngine } from './sync';

type Drag =
  | { kind: 'pan'; last: Point }
  | { kind: 'token'; id: string; offset: Point; start: Point; moved: boolean }
  | { kind: 'measure'; a: Point; b: Point }
  | { kind: 'fogRect'; a: Point; b: Point }
  | { kind: 'fogBrush'; points: Point[] };

export function TabletopCanvas({ engine, onCamera, cameraRef }: { engine: SyncEngine; onCamera: (c: Camera) => void; cameraRef: React.MutableRefObject<{ fit: () => void; get: () => Camera; set: (c: Camera) => void } | null> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TabletopRenderer | null>(null);
  const [ready, setReady] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const spaceRef = useRef(false);

  const snap = useTable((s) => s.snapshot);
  const sceneId = snap?.scene?.scene.id;
  const map = snap?.scene?.map;
  const imageUrl = snap?.scene?.imageUrl ?? null;
  const isGM = snap?.viewMode === 'gm';

  // ------------------------------------------------------------ lifecycle
  useEffect(() => {
    const r = new TabletopRenderer();
    rendererRef.current = r;
    let alive = true;
    void r.init(hostRef.current!).then(() => alive && setReady(true));
    return () => {
      alive = false;
      r.destroy();
      rendererRef.current = null;
    };
  }, []);

  const applyCamera = (c: Camera) => {
    rendererRef.current?.setCamera(c);
    onCamera(c);
    const s = getTable();
    rendererRef.current?.setCursors(Object.values(s.cursors), s.showCursors);
    redrawOverlay();
  };

  useEffect(() => {
    if (import.meta.env.DEV) {
      const hook = (window as unknown as { __d20?: Record<string, unknown> }).__d20;
      if (hook) hook.mapToClient = (p: Point) => {
        const cam = rendererRef.current?.getCamera();
        const rect = hostRef.current?.getBoundingClientRect();
        return cam && rect ? { x: rect.left + (p.x - cam.x) * cam.zoom, y: rect.top + (p.y - cam.y) * cam.zoom } : null;
      };
    }
    cameraRef.current = {
      fit: () => {
        const r = rendererRef.current;
        if (r && map) applyCamera(fitCamera(map.widthPx, map.heightPx, r.size.w, r.size.h));
      },
      get: () => rendererRef.current?.getCamera() ?? { x: 0, y: 0, zoom: 1 },
      set: applyCamera,
    };
  });

  // Load map when the scene changes; keep camera across reconnects of the same scene.
  useEffect(() => {
    const r = rendererRef.current;
    if (!ready || !r || !map) return;
    let cancelled = false;
    void r
      .setMap(map, imageUrl)
      .catch(() => toast.error('The map image failed to load. Try refreshing.'))
      .then(() => {
        if (cancelled) return;
        const s = getTable();
        r.setFog(s.fog, isGM);
        r.setObjects(Object.values(s.objects), { selectedId: s.selectedId, mySub: s.snapshot?.me.sub ?? '' });
        applyCamera(fitCamera(map.widthPx, map.heightPx, r.size.w, r.size.h));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sceneId, map?.id, map?.updatedAt]);

  // Store -> renderer bindings.
  useEffect(() => {
    if (!ready) return;
    let lastFogVersion = -1;
    return useTable.subscribe((s, prev) => {
      const r = rendererRef.current;
      if (!r) return;
      if (s.objects !== prev.objects || s.selectedId !== prev.selectedId) r.setObjects(Object.values(s.objects), { selectedId: s.selectedId, mySub: s.snapshot?.me.sub ?? '' });
      if (s.fogVersion !== prev.fogVersion && s.fogVersion !== lastFogVersion) {
        lastFogVersion = s.fogVersion;
        if (s.lastFogOp && s.fog.ops.length === prev.fog.ops.length + 1 && s.fog.initial === prev.fog.initial) r.appendFogOp(s.lastFogOp);
        else r.setFog(s.fog, s.snapshot?.viewMode === 'gm');
      }
      if (s.cursors !== prev.cursors || s.showCursors !== prev.showCursors) r.setCursors(Object.values(s.cursors), s.showCursors);
      if (s.pings !== prev.pings) r.setPings(s.pings);
      if (s.focus && s.focus !== prev.focus && (s.followGM || s.snapshot?.viewMode !== 'player')) {
        applyCamera(centerOn(s.focus, s.focus.zoom, r.size.w, r.size.h));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // --------------------------------------------------------- interaction
  const toMap = (e: { clientX: number; clientY: number }): Point => {
    const rect = hostRef.current!.getBoundingClientRect();
    return screenToMap({ x: e.clientX - rect.left, y: e.clientY - rect.top }, rendererRef.current!.getCamera());
  };

  const ppm = map?.calibration?.pixelsPerMeter;
  const unit = map?.grid.displayUnit ?? 'ft';

  function redrawOverlay() {
    const r = rendererRef.current;
    const d = dragRef.current;
    if (!r) return;
    const s = getTable();
    const mode = s.tool === 'fog-conceal' ? 'conceal' : 'reveal';
    r.setOverlay({
      ruler: d?.kind === 'measure' ? { a: d.a, b: d.b, label: ppm ? formatDistance(distance(d.a, d.b) / ppm, unit) : 'Map not calibrated' } : null,
      fogRect: d?.kind === 'fogRect' ? { a: d.a, b: d.b, mode } : null,
      fogBrush: d?.kind === 'fogBrush' ? { points: d.points, radius: s.fogBrushRadius / r.getCamera().zoom, mode } : null,
    });
  }

  const canMove = (o: TableObject) => isGM || o.assignedControllerSub === snap?.me.sub;
  const snapPoint = (p: Point): Point => {
    if (!map?.calibration || map.grid.type === 'none') return p;
    return snapToGrid(p, map.grid, gridSpacingPixels(map.grid, map.calibration.pixelsPerMeter));
  };
  const clampToMap = (p: Point): Point => (map ? { x: Math.min(Math.max(0, p.x), map.widthPx), y: Math.min(Math.max(0, p.y), map.heightPx) } : p);

  const onPointerDown = (e: React.PointerEvent) => {
    const r = rendererRef.current;
    if (!r || !map || snap?.viewMode === 'preview') {
      if (r) dragRef.current = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
      return;
    }
    hostRef.current!.setPointerCapture(e.pointerId);
    const p = toMap(e);
    const s = getTable();
    if (e.button === 1 || e.button === 2 || spaceRef.current || s.tool === 'pan') {
      dragRef.current = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
      return;
    }
    switch (s.tool) {
      case 'select': {
        const hit = r.hitTest(p, Object.values(s.objects));
        setTable({ selectedId: hit?.id ?? null });
        if (hit && canMove(hit)) dragRef.current = { kind: 'token', id: hit.id, offset: { x: hit.x - p.x, y: hit.y - p.y }, start: { x: hit.x, y: hit.y }, moved: false };
        else dragRef.current = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
        return;
      }
      case 'measure':
        dragRef.current = { kind: 'measure', a: p, b: p };
        return;
      case 'ping': {
        const n = normalize(p, map.widthPx, map.heightPx);
        engine.sendCursor(n.x, n.y, true);
        engine.addPing(p.x, p.y, snap?.me.color ?? '#ffffff');
        return;
      }
      case 'fog-reveal':
      case 'fog-conceal':
        dragRef.current = s.fogBrush === 'rect' ? { kind: 'fogRect', a: clampToMap(p), b: clampToMap(p) } : { kind: 'fogBrush', points: [p] };
        redrawOverlay();
        return;
      case 'spawn': {
        const at = snapPoint(clampToMap(p));
        const t = s.spawn;
        void engine
          .command('spawnSceneObject', {
            sceneId: sceneId!,
            objectType: t.objectType,
            x: at.x,
            y: at.y,
            visibility: t.visibility,
            ...(t.label ? { label: t.label } : {}),
            ...(t.templateId ? { templateId: t.templateId } : { tint: t.tint }),
            ...(t.characterId ? { characterId: t.characterId } : {}),
            ...(t.assignedControllerSub ? { assignedControllerSub: t.assignedControllerSub } : {}),
          })
          .catch((err: Error) => toast.error(err.message));
        return;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const r = rendererRef.current;
    if (!r || !map) return;
    const p = toMap(e);
    if (p.x >= 0 && p.y >= 0 && p.x <= map.widthPx && p.y <= map.heightPx) {
      const n = normalize(p, map.widthPx, map.heightPx);
      engine.sendCursor(n.x, n.y);
    }
    const d = dragRef.current;
    if (!d) return;
    switch (d.kind) {
      case 'pan':
        applyCamera(panBy(r.getCamera(), e.clientX - d.last.x, e.clientY - d.last.y));
        d.last = { x: e.clientX, y: e.clientY };
        return;
      case 'token': {
        const pos = clampToMap({ x: p.x + d.offset.x, y: p.y + d.offset.y });
        d.moved = d.moved || distance(pos, d.start) > 2 / r.getCamera().zoom;
        r.moveTokenView(d.id, pos.x, pos.y);
        return;
      }
      case 'measure':
        d.b = p;
        redrawOverlay();
        return;
      case 'fogRect':
        d.b = clampToMap(p);
        redrawOverlay();
        return;
      case 'fogBrush': {
        const last = d.points[d.points.length - 1]!;
        if (distance(last, p) > 4 / r.getCamera().zoom && d.points.length < 400) d.points.push(p);
        redrawOverlay();
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const r = rendererRef.current;
    const d = dragRef.current;
    dragRef.current = null;
    if (!r || !d) return;
    if (d.kind === 'token') {
      if (!d.moved) return r.refresh();
      const p = toMap(e);
      const pos = snapPoint(clampToMap({ x: p.x + d.offset.x, y: p.y + d.offset.y }));
      void engine.moveToken(d.id, pos.x, pos.y);
      return;
    }
    if (d.kind === 'fogRect' || d.kind === 'fogBrush') {
      const mode = getTable().tool === 'fog-conceal' ? 'conceal' : 'reveal';
      let op: FogOp | null = null;
      if (d.kind === 'fogRect') {
        const x = Math.min(d.a.x, d.b.x);
        const y = Math.min(d.a.y, d.b.y);
        const w = Math.abs(d.b.x - d.a.x);
        const h = Math.abs(d.b.y - d.a.y);
        if (w > 1 && h > 1) op = { mode, shape: { kind: 'rect', x, y, w, h } };
      } else {
        op = { mode, shape: { kind: 'brush', radius: getTable().fogBrushRadius / r.getCamera().zoom, points: d.points } };
      }
      redrawOverlay();
      if (op) void engine.command('updateFog', { sceneId: sceneId!, op }).catch((err: Error) => toast.error(err.message));
      return;
    }
    if (d.kind === 'measure') {
      // Keep the last measurement visible briefly.
      setTimeout(redrawOverlay, 1500);
      dragRef.current = null;
      r.setOverlay({ ruler: { a: d.a, b: d.b, label: ppm ? formatDistance(distance(d.a, d.b) / ppm, unit) : 'Map not calibrated' } });
    }
  };

  // Wheel zoom around pointer.
  useEffect(() => {
    const el = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = rendererRef.current;
      if (!r) return;
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) applyCamera(zoomAt(r.getCamera(), anchor, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      else applyCamera(panBy(r.getCamera(), -e.deltaX, -e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard: space-drag pans; Delete removes selection (GM).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const tool = useTable((s) => s.tool);
  const cursorClass = tool === 'pan' ? 'cursor-grab' : tool === 'select' ? 'cursor-default' : 'cursor-crosshair';

  return (
    <div
      ref={hostRef}
      className={`absolute inset-0 touch-none select-none ${cursorClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => engine.leaveCursor()}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label="Tabletop map. Use the toolbar to choose a tool; scroll to zoom, right-drag or space-drag to pan."
    />
  );
}
