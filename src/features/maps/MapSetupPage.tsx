import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Crosshair, Hand, Maximize, Move, Ruler } from 'lucide-react';
import { toast } from 'sonner';
import { computeCalibration, distance, mapToScreen, type Point, CalibrationError } from '@shared/geometry/transform';
import { DEFAULT_GRID_COLOR, GRID_COLOR_PRESETS, gridSpacingPixels, shouldDrawGrid, type GridType, type MapGrid } from '@shared/geometry/grid';
import { hexGridPolygons, squareGridSegments } from '@shared/geometry/gridLines';
import { DISTANCE_UNITS, formatDistance, toMeters, UNIT_LABELS, type DistanceUnit } from '@shared/units';
import type { MapDefinition } from '@shared/model';
import { campaignApi, qk, useMapDetail } from '@/lib/api/hooks';
import { Badge, Button, ErrorNotice, Field, Input, Select, Spinner, cn } from '@/components/ui/primitives';
import { useViewport } from './useViewport';
import { isWallTool, useWallsEditor, WallsOverlay, WallsSection, type WallTool } from './WallsEditor';

type Tool = 'pan' | 'calibrate' | 'origin' | 'measure' | WallTool;

export default function MapSetupPage() {
  const { campaignId = '', mapId = '' } = useParams();
  const detail = useMapDetail(campaignId, mapId);
  if (detail.isLoading) return <Spinner label="Loading map" />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (!detail.data) return null;
  return <MapSetup key={detail.data.map.updatedAt} campaignId={campaignId} map={detail.data.map} imageUrl={detail.data.imageUrl} />;
}

function MapSetup({ campaignId, map, imageUrl }: { campaignId: string; map: MapDefinition; imageUrl: string | null }) {
  const qc = useQueryClient();
  const vp = useViewport(map.widthPx, map.heightPx);
  const [tool, setTool] = useState<Tool>(map.calibration ? 'measure' : 'calibrate');
  const [a, setA] = useState<Point | null>(map.calibration?.a ?? null);
  const [b, setB] = useState<Point | null>(map.calibration?.b ?? null);
  const [dist, setDist] = useState(String(map.calibration?.enteredDistance ?? ''));
  const [unit, setUnit] = useState<DistanceUnit>(map.calibration?.enteredUnit ?? 'ft');
  const [grid, setGrid] = useState<MapGrid>(map.grid.type === 'none' && !map.calibration ? { ...map.grid, type: 'square' } : map.grid);
  const [measure, setMeasure] = useState<[Point, Point] | null>(null);
  const [drag, setDrag] = useState<{ kind: 'pan' | 'line'; last: Point } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingWalls, setSavingWalls] = useState(false);
  const [imgError, setImgError] = useState(false);
  const walls = useWallsEditor(map.walls, { w: map.widthPx, h: map.heightPx });

  const calibration = useMemo(() => {
    if (!a || !b) return null;
    try {
      return computeCalibration(a, b, Number(dist), unit);
    } catch (e) {
      return e instanceof CalibrationError ? e : null;
    }
  }, [a, b, dist, unit]);
  const ppm = calibration && !(calibration instanceof CalibrationError) ? calibration.pixelsPerMeter : null;
  const spacing = ppm ? gridSpacingPixels(grid, ppm) : 0;
  const cam = vp.camera;

  const view = { x: cam.x, y: cam.y, w: vp.size.w / cam.zoom, h: vp.size.h / cam.zoom };
  const drawGrid = ppm && grid.type !== 'none' && grid.showEnabled && shouldDrawGrid(spacing, cam.zoom);
  const segments = drawGrid && grid.type === 'square' ? squareGridSegments(grid, spacing, view) : [];
  const hexes = drawGrid && grid.type === 'hex' ? hexGridPolygons(grid, spacing, view) : [];

  const onPointerDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = vp.toMap(e.clientX, e.clientY);
    if (tool === 'pan' || e.button === 1 || e.button === 2) return setDrag({ kind: 'pan', last: { x: e.clientX, y: e.clientY } });
    if (isWallTool(tool)) return walls.down(tool, p, cam.zoom);
    if (tool === 'calibrate') {
      setA(p);
      setB(p);
      setDrag({ kind: 'line', last: p });
    } else if (tool === 'measure') {
      setMeasure([p, p]);
      setDrag({ kind: 'line', last: p });
    } else if (tool === 'origin') {
      setGrid((g) => ({ ...g, originX: Math.round(p.x * 100) / 100, originY: Math.round(p.y * 100) / 100 }));
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (isWallTool(tool) && !drag) return walls.move(tool, vp.toMap(e.clientX, e.clientY));
    if (!drag) return;
    if (drag.kind === 'pan') {
      vp.pan(e.clientX - drag.last.x, e.clientY - drag.last.y);
      setDrag({ kind: 'pan', last: { x: e.clientX, y: e.clientY } });
      return;
    }
    let p = vp.toMap(e.clientX, e.clientY);
    p = { x: Math.min(Math.max(0, p.x), map.widthPx), y: Math.min(Math.max(0, p.y), map.heightPx) };
    if (e.shiftKey && tool === 'calibrate' && a) {
      // Shift constrains to horizontal/vertical for clean reference lines.
      p = Math.abs(p.x - a.x) > Math.abs(p.y - a.y) ? { x: p.x, y: a.y } : { x: a.x, y: p.y };
    }
    if (tool === 'calibrate') setB(p);
    if (tool === 'measure') setMeasure((m) => (m ? [m[0], p] : m));
  };
  const onPointerUp = () => {
    if (isWallTool(tool) && !drag) walls.up(tool);
    setDrag(null);
  };

  const saveWalls = async () => {
    setSavingWalls(true);
    try {
      const w = walls.walls;
      await campaignApi.updateMap(campaignId, map.id, { walls: w.rooms.length || w.doorways.length ? w : null });
      walls.markSaved();
      toast.success('Walls saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingWalls(false);
    }
  };

  // Development-only hook so end-to-end tests can aim at map coordinates.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __d20setup?: unknown }).__d20setup = {
      mapToClient: (p: Point) => {
        const r = vp.ref.current?.getBoundingClientRect();
        const s = mapToScreen(p, vp.camera);
        return r ? { x: r.left + s.x, y: r.top + s.y } : null;
      },
    };
  });

  const save = async () => {
    if (!ppm || !a || !b || calibration instanceof CalibrationError || !calibration) return;
    setSaving(true);
    try {
      await campaignApi.updateMap(campaignId, map.id, { calibration, grid });
      toast.success('Scale and grid saved');
      await qc.invalidateQueries({ queryKey: qk.map(campaignId, map.id) });
      void qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toScreen = (p: Point) => mapToScreen(p, cam);
  const lineA = a && toScreen(a);
  const lineB = b && toScreen(b);
  const refPx = a && b ? distance(a, b) : 0;
  const tools: { id: Tool; label: string; icon: typeof Hand; disabled?: boolean }[] = [
    { id: 'calibrate', label: 'Draw reference line', icon: Ruler },
    { id: 'origin', label: 'Set grid origin', icon: Crosshair, disabled: !ppm },
    { id: 'measure', label: 'Measure', icon: Move, disabled: !ppm },
    { id: 'pan', label: 'Pan', icon: Hand },
  ];

  return (
    <div className="-mx-4 -my-8 flex h-[calc(100vh-3.5rem)] flex-col lg:flex-row">
      <aside className="scrollbar-thin w-full shrink-0 space-y-5 overflow-y-auto border-border bg-surface p-5 lg:w-80 lg:border-r">
        <div>
          <Link to={`/campaigns/${campaignId}`} className="text-sm text-muted hover:text-text">
            ← Back to campaign
          </Link>
          <h1 className="mt-2 font-display text-xl font-bold">{map.name}</h1>
          <p className="text-xs text-faint">
            {map.widthPx} × {map.heightPx} native pixels
          </p>
        </div>

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Badge tone={ppm ? 'success' : 'accent'}>1</Badge> Calibrate scale
          </h2>
          <p className="text-xs text-muted">Drag a line between two points whose real distance you know (a scale bar, a wall, a road). Hold Shift to keep it straight.</p>
          <div className="grid grid-cols-[1fr_110px] gap-2">
            <Field label="Real distance" htmlFor="dist">
              <Input id="dist" inputMode="decimal" value={dist} onChange={(e) => setDist(e.target.value)} placeholder="e.g. 1" />
            </Field>
            <Field label="Unit" htmlFor="unit">
              <Select id="unit" value={unit} onChange={(e) => setUnit(e.target.value as DistanceUnit)}>
                {DISTANCE_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABELS[u].plural}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-xs text-faint">Reference line: {refPx ? `${refPx.toFixed(1)} px` : 'not drawn yet'}</p>
          {calibration instanceof CalibrationError && <p className="text-xs text-danger">{calibration.message}</p>}
          {ppm && (
            <p className="text-xs text-success">
              Scale: {(ppm * toMeters(1, unit)).toFixed(3)} px per {UNIT_LABELS[unit].singular}
            </p>
          )}
        </section>

        <section className={cn('space-y-3', !ppm && 'pointer-events-none opacity-50')} aria-disabled={!ppm}>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Badge tone="accent">2</Badge> Grid
          </h2>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Grid type">
            {(['square', 'hex', 'none'] as GridType[]).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={grid.type === t}
                className={cn('rounded-md py-1.5 text-xs capitalize', grid.type === t ? 'bg-surface-3 text-text' : 'text-muted')}
                onClick={() => setGrid((g) => ({ ...g, type: t }))}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-[1fr_110px] gap-2">
            <Field label="Grid interval" htmlFor="interval">
              <Input
                id="interval"
                inputMode="decimal"
                value={grid.displayInterval}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v > 0) setGrid((g) => ({ ...g, displayInterval: v, intervalMeters: toMeters(v, g.displayUnit) }));
                }}
              />
            </Field>
            <Field label="Unit" htmlFor="gridUnit">
              <Select id="gridUnit" value={grid.displayUnit} onChange={(e) => setGrid((g) => ({ ...g, displayUnit: e.target.value as DistanceUnit, intervalMeters: toMeters(g.displayInterval, e.target.value as DistanceUnit) }))}>
                {DISTANCE_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABELS[u].plural}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {ppm && grid.type !== 'none' && (
            <p className="text-xs text-faint">
              One cell = {spacing.toFixed(2)} native px
              {spacing < 4 && (
                <span className="mt-1 flex items-center gap-1 text-accent">
                  <AlertTriangle className="h-3 w-3" aria-hidden /> Very dense; it will hide when zoomed out.
                </span>
              )}
            </p>
          )}
          <Field label={`Grid opacity (${Math.round(grid.opacity * 100)}%)`} htmlFor="opacity">
            <input id="opacity" type="range" min={0.05} max={1} step={0.05} value={grid.opacity} onChange={(e) => setGrid((g) => ({ ...g, opacity: Number(e.target.value) }))} className="w-full accent-[var(--color-accent)]" />
          </Field>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Grid color</legend>
            <div className="flex flex-wrap items-center gap-2">
              {GRID_COLOR_PRESETS.map((c) => {
                const on = (grid.color ?? DEFAULT_GRID_COLOR).toLowerCase() === c;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Grid color ${c}`}
                    aria-pressed={on}
                    onClick={() => setGrid((g) => ({ ...g, color: c }))}
                    className={`h-7 w-7 rounded-full border-2 ${on ? 'border-accent ring-2 ring-accent/40' : 'border-border'}`}
                    style={{ backgroundColor: c }}
                  />
                );
              })}
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="color" aria-label="Custom grid color" value={grid.color ?? DEFAULT_GRID_COLOR} onChange={(e) => setGrid((g) => ({ ...g, color: e.target.value }))} className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent" />
                Custom
              </label>
            </div>
          </fieldset>
          <Field label={`Rotation (${((grid.rotationRadians * 180) / Math.PI).toFixed(1)}°)`} htmlFor="rotation">
            <input id="rotation" type="range" min={-45} max={45} step={0.5} value={(grid.rotationRadians * 180) / Math.PI} onChange={(e) => setGrid((g) => ({ ...g, rotationRadians: (Number(e.target.value) * Math.PI) / 180 }))} className="w-full accent-[var(--color-accent)]" />
          </Field>
          <p className="text-xs text-muted">Use “Set grid origin” and click a printed grid corner to align with a map that already has a grid.</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={grid.snapEnabled} onChange={(e) => setGrid((g) => ({ ...g, snapEnabled: e.target.checked }))} className="accent-[var(--color-accent)]" /> Snap tokens to grid
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={grid.showEnabled} onChange={(e) => setGrid((g) => ({ ...g, showEnabled: e.target.checked }))} className="accent-[var(--color-accent)]" /> Show grid
          </label>
        </section>

        <Button className="w-full justify-center" disabled={!ppm} loading={saving} onClick={save}>
          Save scale &amp; grid
        </Button>
        <p className="text-xs text-faint">Two-point calibration assumes a uniform, top-down map. Perspective or stretched images can't measure accurately everywhere.</p>

        <WallsSection editor={walls} tool={tool} setTool={setTool} readOnly={!!map.walls?.generated} saving={savingWalls} onSave={() => void saveWalls()} />
      </aside>

      <div className="relative flex-1">
        <div className="absolute left-3 top-3 z-10 flex gap-1 rounded-lg border border-border bg-surface/90 p-1 backdrop-blur" role="toolbar" aria-label="Map tools">
          {tools.map((t) => (
            <Button key={t.id} size="icon" variant={tool === t.id ? 'secondary' : 'ghost'} title={t.label} aria-label={t.label} aria-pressed={tool === t.id} disabled={t.disabled} onClick={() => setTool(t.id)}>
              <t.icon className="h-4 w-4" aria-hidden />
            </Button>
          ))}
          <Button size="icon" variant="ghost" title="Fit map" aria-label="Fit map" onClick={vp.fit}>
            <Maximize className="h-4 w-4" aria-hidden />
          </Button>
          <span className="self-center px-2 text-xs tabular-nums text-muted">{Math.round(cam.zoom * 100)}%</span>
        </div>
        {measure && ppm && (
          <div className="absolute right-3 top-3 z-10 rounded-lg border border-border bg-surface/90 px-3 py-2 text-sm backdrop-blur" aria-live="polite">
            Measured: <strong>{formatDistance(distance(measure[0], measure[1]) / ppm, grid.displayUnit)}</strong>
          </div>
        )}
        <div
          ref={vp.ref}
          className={cn('h-full w-full touch-none overflow-hidden bg-[#0b0a0f]', tool === 'pan' ? 'cursor-grab' : 'cursor-crosshair')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => isWallTool(tool) && walls.doubleClick(tool)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {imageUrl && !imgError ? (
            <img
              src={imageUrl}
              alt={map.name}
              draggable={false}
              onError={() => setImgError(true)}
              className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
              style={{ width: map.widthPx, height: map.heightPx, transformOrigin: '0 0', transform: `translate(${-cam.x * cam.zoom}px, ${-cam.y * cam.zoom}px) scale(${cam.zoom})`, imageRendering: cam.zoom > 2 ? 'pixelated' : 'auto' }}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted">The map image could not be loaded.</div>
          )}
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <g transform={`translate(${-cam.x * cam.zoom} ${-cam.y * cam.zoom}) scale(${cam.zoom})`} stroke={grid.color ?? DEFAULT_GRID_COLOR} strokeOpacity={grid.opacity} fill="none">
              {segments.map(([p, q], i) => (
                <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} vectorEffect="non-scaling-stroke" strokeWidth={1} />
              ))}
              {hexes.map((poly, i) => (
                <polygon key={i} points={poly.map((p) => `${p.x},${p.y}`).join(' ')} vectorEffect="non-scaling-stroke" strokeWidth={1} />
              ))}
            </g>
            {lineA && lineB && (
              <g>
                <line x1={lineA.x} y1={lineA.y} x2={lineB.x} y2={lineB.y} stroke="#c9a24a" strokeWidth={3} strokeLinecap="round" />
                <circle cx={lineA.x} cy={lineA.y} r={6} fill="#c9a24a" stroke="#1a1408" strokeWidth={2} />
                <circle cx={lineB.x} cy={lineB.y} r={6} fill="#c9a24a" stroke="#1a1408" strokeWidth={2} />
              </g>
            )}
            {measure && (
              <g>
                <line x1={toScreen(measure[0]).x} y1={toScreen(measure[0]).y} x2={toScreen(measure[1]).x} y2={toScreen(measure[1]).y} stroke="#3e8ed0" strokeWidth={2} strokeDasharray="6 4" />
              </g>
            )}
            <WallsOverlay editor={walls} toScreen={toScreen} />
            {ppm && grid.type !== 'none' && (
              <circle cx={toScreen({ x: grid.originX, y: grid.originY }).x} cy={toScreen({ x: grid.originX, y: grid.originY }).y} r={5} fill="none" stroke="#e5484d" strokeWidth={2} />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}

