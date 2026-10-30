import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Hammer, ImagePlus, Layers, Pencil, Ruler, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { CampaignDashboardDto } from '@shared/dto';
import { MAP_CATEGORIES } from '@shared/schemas/api';
import { campaignApi, qk, useCampaignMutation } from '@/lib/api/hooks';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Input, Select } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];

export function MapsTab({ data }: { data: CampaignDashboardDto }) {
  const { campaign, maps, scenes } = data;
  const [uploading, setUploading] = useState(false);
  const [sceneFor, setSceneFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ kind: 'map' | 'scene'; id: string; name: string } | null>(null);
  const remove = useCampaignMutation(campaign.id, (mapId: string) => campaignApi.deleteMap(campaign.id, mapId));
  const confirmDelete = (m: { id: string; name: string }) => {
    const on = scenes.filter((s) => s.mapId === m.id);
    const what = on.length ? `\n\nThis also deletes ${on.length === 1 ? 'its scene' : `its ${on.length} scenes`} (${on.map((s) => s.name).join(', ')}) with ${on.length === 1 ? 'its' : 'their'} tokens and fog. Characters are not affected.` : '';
    if (!confirm(`Delete the map “${m.name}”?${what}\n\nThis can't be undone.`)) return;
    remove.mutate(m.id, { onSuccess: () => toast.success(`${m.name} deleted`), onError: (e) => toast.error((e as Error).message) });
  };

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">Maps</h2>
          <div className="flex gap-2">
            <Link to={`/campaigns/${campaign.id}/generator`}>
              <Button variant="outline">
                <Hammer className="h-4 w-4" aria-hidden /> Generate interior
              </Button>
            </Link>
            <Button onClick={() => setUploading(true)}>
              <Upload className="h-4 w-4" aria-hidden /> Upload map
            </Button>
          </div>
        </div>
        {maps.length === 0 ? (
          <EmptyState icon={<ImagePlus className="h-8 w-8" />} title="Upload your first map" action={<Button onClick={() => setUploading(true)}>Upload map</Button>}>
            PNG, JPEG or WebP up to 25 MB. You'll calibrate its real-world scale next.
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {maps.map((m) => (
              <Card key={m.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold">{m.name}</h3>
                    <p className="text-xs text-faint">
                      {m.widthPx} × {m.heightPx} px · {m.category}
                    </p>
                  </div>
                  {m.calibration ? (
                    <Badge tone="success">
                      <Ruler className="h-3 w-3" aria-hidden /> Calibrated
                    </Badge>
                  ) : (
                    <Badge>No scale</Badge>
                  )}
                </div>
                <div className="mt-4 flex gap-2">
                  <Link to={`/campaigns/${campaign.id}/maps/${m.id}`}>
                    <Button size="sm" variant="secondary">
                      <Ruler className="h-4 w-4" aria-hidden /> Scale &amp; grid
                    </Button>
                  </Link>
                  <Button size="sm" variant="outline" onClick={() => setSceneFor(m.id)}>
                    <Layers className="h-4 w-4" aria-hidden /> New scene
                  </Button>
                  <div className="ml-auto flex">
                    <Button size="icon" variant="ghost" aria-label={`Rename ${m.name}`} title="Rename" onClick={() => setRenaming({ kind: 'map', id: m.id, name: m.name })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label={`Delete ${m.name}`} title="Delete" disabled={remove.isPending} onClick={() => confirmDelete(m)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Scenes</h2>
        {scenes.length === 0 ? (
          <p className="text-sm text-muted">A scene places a map on the table with its own tokens and fog. Create one from a map above.</p>
        ) : (
          <div className="space-y-2">
            {scenes.map((s) => (
              <Card key={s.id} className="flex items-center justify-between p-3">
                <div>
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-2 text-xs text-faint">{maps.find((m) => m.id === s.mapId)?.name}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="hidden text-xs text-faint sm:inline">Switch scenes from the live table</span>
                  <Button size="icon" variant="ghost" aria-label={`Rename ${s.name}`} title="Rename" onClick={() => setRenaming({ kind: 'scene', id: s.id, name: s.name })}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <UploadMapDialog campaignId={campaign.id} open={uploading} onOpenChange={setUploading} />
      {renaming && <RenameDialog campaignId={campaign.id} target={renaming} onClose={() => setRenaming(null)} />}
      {sceneFor && <CreateSceneDialog campaignId={campaign.id} mapId={sceneFor} mapName={maps.find((m) => m.id === sceneFor)?.name ?? ''} onClose={() => setSceneFor(null)} />}
    </div>
  );
}

function RenameDialog({ campaignId, target, onClose }: { campaignId: string; target: { kind: 'map' | 'scene'; id: string; name: string }; onClose: () => void }) {
  const [name, setName] = useState(target.name);
  const save = useCampaignMutation(
    campaignId,
    (v: string): Promise<unknown> => (target.kind === 'map' ? campaignApi.updateMap(campaignId, target.id, { name: v }) : campaignApi.updateScene(campaignId, target.id, { name: v })),
    target.kind === 'map' ? [[...qk.map(campaignId, target.id)]] : [],
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Rename ${target.kind}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(name.trim(), { onSuccess: () => (toast.success(`${target.kind === 'map' ? 'Map' : 'Scene'} renamed`), onClose()) });
        }}
      >
        {save.error && <ErrorNotice error={save.error} />}
        <Field label="Name" htmlFor="renameInput">
          <Input id="renameInput" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || name.trim() === target.name} loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function putWithProgress(url: string, file: File, headers: Record<string, string>, onProgress: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(file);
  });
}

function UploadMapDialog({ campaignId, open, onOpenChange }: { campaignId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finalize = useCampaignMutation(campaignId, (v: { assetId: string }) => campaignApi.finalizeMap(campaignId, { assetId: v.assetId, name, category }));

  const choose = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!ACCEPT.includes(f.type)) return setError('Choose a PNG, JPEG or WebP image.');
    if (f.size > MAX_BYTES) return setError('That file is larger than 25 MB.');
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
  };

  const submit = async () => {
    if (!file || !name.trim()) return;
    setError(null);
    try {
      setProgress(0);
      const intent = await campaignApi.uploadIntent(campaignId, { fileName: file.name, contentType: file.type, bytes: file.size });
      await putWithProgress(intent.uploadUrl, file, intent.headers, setProgress);
      const map = await finalize.mutateAsync({ assetId: intent.assetId });
      toast.success(`${map.name} uploaded. Calibrate its scale next.`);
      onOpenChange(false);
      setFile(null);
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Upload a map" description="City, region, building or dungeon. You'll set its real-world scale next.">
      <div className="space-y-4">
        {error && <ErrorNotice error={new Error(error)} />}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files[0]);
          }}
          className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted hover:border-accent/60 hover:text-text"
        >
          <ImagePlus className="mb-2 h-8 w-8 text-accent" aria-hidden />
          {file ? (
            <span className="text-text">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </span>
          ) : (
            <span>Drop an image here or click to choose (PNG, JPEG, WebP · max 25 MB)</span>
          )}
        </button>
        <input ref={fileRef} type="file" accept={ACCEPT.join(',')} className="sr-only" aria-label="Map image file" onChange={(e) => choose(e.target.files?.[0])} />
        <Field label="Map name" htmlFor="mapName">
          <Input id="mapName" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Type" htmlFor="mapCategory">
          <Select id="mapCategory" value={category} onChange={(e) => setCategory(e.target.value)}>
            {MAP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c[0]!.toUpperCase() + c.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        {progress !== null && (
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!file || !name.trim()} loading={progress !== null}>
            Upload
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CreateSceneDialog({ campaignId, mapId, mapName, onClose }: { campaignId: string; mapId: string; mapName: string; onClose: () => void }) {
  const [name, setName] = useState(mapName);
  const [fog, setFog] = useState<'revealed' | 'covered'>('revealed');
  const create = useCampaignMutation(campaignId, () => campaignApi.createScene(campaignId, { mapId, name, fogInitial: fog }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New scene" description={`Place ${mapName} on the table with its own tokens and fog.`}>
      <div className="space-y-4">
        {create.error && <ErrorNotice error={create.error} />}
        <Field label="Scene name" htmlFor="sceneName">
          <Input id="sceneName" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        </Field>
        <Field label="Fog of war" htmlFor="fog" hint="You can reveal or conceal areas during play.">
          <Select id="fog" value={fog} onChange={(e) => setFog(e.target.value as 'revealed' | 'covered')}>
            <option value="revealed">Start fully visible</option>
            <option value="covered">Start covered in fog</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!name.trim()}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: () => {
                  toast.success('Scene created. Open a session to put it on the table.');
                  onClose();
                },
              })
            }
          >
            Create scene
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
