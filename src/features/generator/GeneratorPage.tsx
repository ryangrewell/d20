import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Dices, Download, FileUp, Hammer } from 'lucide-react';
import { toast } from 'sonner';
import { BUILDING_TYPES, FloorplanError, THEMES, generateFloorplan, validateFloorplan, type Floorplan, type FloorplanInput } from '@shared/generator/floorplan';
import { api } from '@/lib/api/client';
import { campaignApi, qk } from '@/lib/api/hooks';
import { Badge, Button, Card, Field, Input, Select, cn } from '@/components/ui/primitives';
import { floorToPng, renderFloor } from './render';

const ADJ = ['amber', 'broken', 'crooked', 'gilded', 'hollow', 'iron', 'mossy', 'quiet', 'rusty', 'silver', 'sunken', 'wild'];
const NOUN = ['anvil', 'crown', 'falcon', 'gate', 'lantern', 'oak', 'raven', 'stag', 'tower', 'well', 'wolf', 'wyrm'];
const randomSeed = () => `${ADJ[Math.floor(Math.random() * ADJ.length)]}-${NOUN[Math.floor(Math.random() * NOUN.length)]}-${Math.floor(Math.random() * 1000)}`;
const label = (s: string) => s[0]!.toUpperCase() + s.slice(1);

type FloorplanRecord = { id: string; name: string; input: FloorplanInput; roomNames: Record<string, string>; showLabels: boolean; floors: { level: number; name: string; sceneId: string }[]; createdAt: string };

export default function GeneratorPage() {
  const { campaignId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [input, setInput] = useState<FloorplanInput>({ name: 'The Broken Crown', buildingType: 'tavern', width: 60, depth: 40, unit: 'ft', floors: 2, basement: false, density: 'normal', theme: 'medieval', seed: randomSeed() });
  const [roomNames, setRoomNames] = useState<Record<string, string>>({});
  const [showLabels, setShowLabels] = useState(true);
  const [fogInitial, setFogInitial] = useState<'covered' | 'revealed'>('revealed');
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const saved = useQuery({ queryKey: ['floorplans', campaignId], queryFn: () => api<FloorplanRecord[]>(`/campaigns/${campaignId}/floorplans`) });

  const result = useMemo((): { fp: Floorplan; errors: string[] } | { error: string } => {
    try {
      const fp = generateFloorplan(input);
      return { fp, errors: validateFloorplan(fp) };
    } catch (e) {
      return { error: e instanceof FloorplanError ? e.message : 'Could not generate that building.' };
    }
  }, [input]);
  const fp = 'fp' in result ? result.fp : null;
  const floor = fp?.floors.find((f) => f.level === level) ?? fp?.floors.find((f) => f.level === 0) ?? fp?.floors[0];

  const set = <K extends keyof FloorplanInput>(k: K, v: FloorplanInput[K]) => setInput((i) => ({ ...i, [k]: v }));
  const regenerate = () => {
    set('seed', randomSeed());
    setRoomNames({});
  };

  const addToCampaign = async () => {
    if (!fp) return;
    try {
      const floors: { level: number; assetId: string }[] = [];
      for (const f of fp.floors) {
        setProgress(`Rendering ${f.name.toLowerCase()}…`);
        const png = await floorToPng(fp, f, { theme: input.theme, showLabels, roomNames });
        setProgress(`Uploading ${f.name.toLowerCase()}…`);
        const intent = await campaignApi.uploadIntent(campaignId, { fileName: `${input.name}-${f.name}.png`, contentType: 'image/png', bytes: png.size });
        const put = await fetch(intent.uploadUrl, { method: 'PUT', headers: intent.headers, body: png });
        if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
        floors.push({ level: f.level, assetId: intent.assetId });
      }
      setProgress('Creating maps and scenes…');
      const rec = await api<FloorplanRecord>(`/campaigns/${campaignId}/floorplans`, { body: { input, roomNames, showLabels, fogInitial, floors } });
      void qc.invalidateQueries({ queryKey: qk.campaign(campaignId) });
      void qc.invalidateQueries({ queryKey: ['floorplans', campaignId] });
      toast.success(`${rec.name} added: ${rec.floors.length} scene${rec.floors.length > 1 ? 's' : ''} ready to play`);
      navigate(`/campaigns/${campaignId}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const exportJson = () => {
    if (!fp) return;
    const data = { format: 'd20.floorplan', version: 1, input, roomNames, showLabels, geometry: fp };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${input.name.replace(/[^\w-]+/g, '_')}.floorplan.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file?: File) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as { format?: string; input?: FloorplanInput; roomNames?: Record<string, string>; showLabels?: boolean };
      if (data.format !== 'd20.floorplan' || !data.input) throw new Error('That is not a d20 floorplan file.');
      // Geometry is regenerated from the input and seed, never taken from the file.
      setInput(data.input);
      setRoomNames(data.roomNames ?? {});
      setShowLabels(data.showLabels ?? true);
      toast.success('Floorplan loaded');
    } catch (e) {
      toast.error(e instanceof SyntaxError ? 'That file is not valid JSON.' : (e as Error).message);
    }
  };

  const unitMax = input.unit === 'ft' ? 300 : 90;
  const unitMin = input.unit === 'ft' ? 20 : 6;

  return (
    <div className="-mx-4 -my-8 flex min-h-[calc(100vh-3.5rem)] flex-col lg:flex-row">
      <aside className="scrollbar-thin w-full shrink-0 space-y-4 overflow-y-auto border-border bg-surface p-5 lg:max-h-[calc(100vh-3.5rem)] lg:w-80 lg:border-r">
        <div>
          <Link to={`/campaigns/${campaignId}`} className="text-sm text-muted hover:text-text">
            ← Back to campaign
          </Link>
          <h1 className="mt-2 flex items-center gap-2 font-display text-xl font-bold">
            <Hammer className="h-5 w-5 text-accent" aria-hidden /> Interior generator
          </h1>
          <p className="text-xs text-muted">Exact-size floorplans with a calibrated grid, ready for the table.</p>
        </div>
        <Field label="Building name" htmlFor="gName">
          <Input id="gName" value={input.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Type" htmlFor="gType">
          <Select id="gType" value={input.buildingType} onChange={(e) => (set('buildingType', e.target.value as FloorplanInput['buildingType']), setRoomNames({}))}>
            {BUILDING_TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_1fr_80px] gap-2">
          <Field label="Width" htmlFor="gW">
            <Input id="gW" type="number" min={unitMin} max={unitMax} value={input.width} onChange={(e) => set('width', Number(e.target.value))} />
          </Field>
          <Field label="Depth" htmlFor="gD">
            <Input id="gD" type="number" min={unitMin} max={unitMax} value={input.depth} onChange={(e) => set('depth', Number(e.target.value))} />
          </Field>
          <Field label="Unit" htmlFor="gU">
            <Select id="gU" value={input.unit} onChange={(e) => set('unit', e.target.value as 'ft' | 'm')}>
              <option value="ft">ft</option>
              <option value="m">m</option>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Floors" htmlFor="gF">
            <Select id="gF" value={input.floors} onChange={(e) => set('floors', Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rooms" htmlFor="gDen">
            <Select id="gDen" value={input.density} onChange={(e) => set('density', e.target.value as FloorplanInput['density'])}>
              <option value="sparse">Fewer, larger</option>
              <option value="normal">Normal</option>
              <option value="dense">More, smaller</option>
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={input.basement} onChange={(e) => set('basement', e.target.checked)} /> Basement
        </label>
        <Field label="Style" htmlFor="gTheme">
          <Select id="gTheme" value={input.theme} onChange={(e) => set('theme', e.target.value as FloorplanInput['theme'])}>
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {t === 'scifi' ? 'Sci-fi' : label(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Seed" htmlFor="gSeed" hint="Same settings + seed always give the same building.">
          <div className="flex gap-2">
            <Input id="gSeed" value={input.seed} maxLength={40} onChange={(e) => (set('seed', e.target.value), setRoomNames({}))} />
            <Button type="button" variant="secondary" size="icon" aria-label="New random seed" title="Regenerate" onClick={regenerate}>
              <Dices className="h-4 w-4" />
            </Button>
          </div>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[var(--color-accent)]" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Show room names on the map
        </label>
        <Field label="Fog when added" htmlFor="gFog">
          <Select id="gFog" value={fogInitial} onChange={(e) => setFogInitial(e.target.value as 'covered' | 'revealed')}>
            <option value="revealed">Fully visible</option>
            <option value="covered">Covered in fog</option>
          </Select>
        </Field>
        <Button className="w-full justify-center" disabled={!fp || ('errors' in result && result.errors.length > 0) || !input.name.trim()} loading={progress !== null} onClick={() => void addToCampaign()}>
          {progress ?? 'Add to campaign'}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!fp} onClick={exportJson}>
            <Download className="h-4 w-4" aria-hidden /> Export
          </Button>
          <Button variant="ghost" size="sm" onClick={() => importRef.current?.click()}>
            <FileUp className="h-4 w-4" aria-hidden /> Import
          </Button>
          <input ref={importRef} type="file" accept=".json,application/json" className="sr-only" aria-label="Floorplan JSON file" onChange={(e) => void importJson(e.target.files?.[0])} />
        </div>
        {(saved.data?.length ?? 0) > 0 && (
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Saved buildings</h2>
            <ul className="space-y-1">
              {saved.data!.map((r) => (
                <li key={r.id}>
                  <button
                    className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-surface-2"
                    onClick={() => {
                      setInput(r.input);
                      setRoomNames(r.roomNames);
                      setShowLabels(r.showLabels);
                    }}
                  >
                    {r.name} <span className="text-xs text-faint">· {r.input.width}×{r.input.depth} {r.input.unit}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1 space-y-4 p-5">
        {'error' in result ? (
          <Card className="flex items-center gap-2 p-4 text-sm text-danger">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {result.error}
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div role="tablist" aria-label="Floors" className="flex gap-1 rounded-lg bg-surface-2 p-1">
                {result.fp.floors.map((f) => (
                  <button key={f.level} role="tab" aria-selected={floor?.level === f.level} onClick={() => setLevel(f.level)} className={cn('rounded-md px-3 py-1 text-sm', floor?.level === f.level ? 'bg-surface-3 text-text' : 'text-muted')}>
                    {f.name}
                  </button>
                ))}
              </div>
              {result.errors.length === 0 ? (
                <Badge tone="success">
                  <CheckCircle2 className="h-3 w-3" aria-hidden /> Valid · every room reachable
                </Badge>
              ) : (
                <Badge tone="danger" title={result.errors.join('\n')}>
                  <AlertTriangle className="h-3 w-3" aria-hidden /> {result.errors[0]}
                </Badge>
              )}
              <span className="text-xs text-faint">
                {input.width} × {input.depth} {input.unit} · {input.unit === 'ft' ? '5 ft' : '1.5 m'} grid
              </span>
            </div>
            {floor && <Preview fp={result.fp} level={floor.level} theme={input.theme} showLabels={showLabels} roomNames={roomNames} />}
            {floor && (
              <Card className="p-4">
                <h2 className="mb-2 text-sm font-semibold">Rooms on the {floor.name.toLowerCase()}</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {floor.rooms.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-xs text-muted">
                      <span className="w-20 shrink-0 tabular-nums">
                        {input.unit === 'ft' ? `${Math.round(r.w / 0.3048)}×${Math.round(r.h / 0.3048)} ft` : `${r.w.toFixed(1)}×${r.h.toFixed(1)} m`}
                      </span>
                      <Input
                        aria-label={`Name for ${r.name}`}
                        className="h-8 text-xs"
                        value={roomNames[r.id] ?? r.name}
                        maxLength={60}
                        onChange={(e) => setRoomNames((n) => ({ ...n, [r.id]: e.target.value }))}
                      />
                    </label>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Preview({ fp, level, theme, showLabels, roomNames }: { fp: Floorplan; level: number; theme: FloorplanInput['theme']; showLabels: boolean; roomNames: Record<string, string> }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const floor = fp.floors.find((f) => f.level === level);
    const canvas = canvasRef.current;
    if (!floor || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pxPerM = Math.min(width / fp.widthM, 560 / fp.depthM) * dpr;
    canvas.width = Math.round(fp.widthM * pxPerM);
    canvas.height = Math.round(fp.depthM * pxPerM);
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    renderFloor(canvas.getContext('2d')!, fp, floor, { pxPerM, theme, showLabels, roomNames });
  }, [fp, level, theme, showLabels, roomNames, width]);
  return (
    <div ref={wrapRef} className="w-full">
      <canvas ref={canvasRef} role="img" aria-label="Floorplan preview" className="rounded-lg shadow-2xl" />
    </div>
  );
}
