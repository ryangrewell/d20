/**
 * Picture picker for characters, creatures and tokens: build a pixel sprite piece by piece from
 * LPC parts (or start from a preset, or randomize a race), pick an animal, or upload a photo.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dices, ImagePlus, PawPrint, Shirt, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { BODY_TYPES, type BodyType, type SpriteManifest, type SpriteRecipe } from '@shared/sprites/compose';
import { SPRITE_PRESETS } from '@shared/sprites/presets';
import { RACES, randomRecipe } from '@shared/sprites/random';
import type { SpriteSource } from '@shared/model';
import { uploadPicture } from '@/lib/api/images';
import { Button, Field, Select, Spinner, cn } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/dialog';
import { canvasToPng, loadManifest, portraitFromFile, renderSprite } from './render';

type Tab = 'build' | 'presets' | 'animals' | 'upload';
type Parts = Record<string, { item: string; colors?: Record<string, string> }>;

const STARTER: SpriteRecipe = SPRITE_PRESETS[0]!.recipe;

/** Category → chosen part, the shape the Build tab edits. */
function toParts(m: SpriteManifest, r: SpriteRecipe): Parts {
  const out: Parts = {};
  for (const p of r.parts) {
    const cat = m.categories.find((c) => c.items.some((i) => i.id === p.item));
    if (cat) out[cat.id] = p;
  }
  return out;
}

function toRecipe(m: SpriteManifest, body: BodyType, skin: string, parts: Parts): SpriteRecipe {
  return { v: 1, body, skin, parts: m.categories.flatMap((c) => (parts[c.id] ? [parts[c.id]!] : [])) };
}

/** Swatch colour for a palette: its middle shade. */
const swatch = (shades: string[] | undefined) => shades?.[Math.floor(shades.length / 2)] ?? '#888';

export function SpriteBuilder({
  campaignId,
  initial,
  title = 'Choose a picture',
  onClose,
  onSaved,
}: {
  campaignId: string;
  initial?: SpriteSource | undefined;
  title?: string;
  onClose: () => void;
  onSaved: (assetId: string, source: SpriteSource) => void | Promise<void>;
}) {
  const [m, setM] = useState<SpriteManifest | null>(null);
  const [tab, setTab] = useState<Tab>(initial?.kind === 'animal' ? 'animals' : initial?.kind === 'upload' ? 'upload' : 'build');
  const start = initial?.kind === 'lpc' ? initial.recipe : STARTER;
  const [body, setBody] = useState<BodyType>(start.body);
  const [skin, setSkin] = useState(start.skin);
  const [parts, setParts] = useState<Parts>({});
  const [race, setRace] = useState(RACES[0]!.id);
  const [animal, setAnimal] = useState(initial?.kind === 'animal' ? initial.id : '');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadManifest()
      .then((man) => {
        setM(man);
        setParts(toParts(man, start));
      })
      .catch((e: Error) => toast.error(e.message));
    // The starting recipe is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recipe = useMemo(() => (m ? toRecipe(m, body, skin, parts) : null), [m, body, skin, parts]);
  const source: SpriteSource | null = tab === 'animals' ? (animal ? { kind: 'animal', id: animal } : null) : tab === 'upload' ? (photo ? { kind: 'upload' } : null) : recipe ? { kind: 'lpc', recipe } : null;

  // Live preview of whatever is selected.
  useEffect(() => {
    let alive = true;
    if (tab === 'upload') {
      const url = photo ? URL.createObjectURL(photo) : null;
      setPreview(url);
      return () => {
        alive = false;
        if (url) URL.revokeObjectURL(url);
      };
    }
    if (!source || source.kind === 'upload') return setPreview(null);
    void renderSprite(source)
      .then((c) => alive && setPreview(c.toDataURL()))
      .catch(() => alive && setPreview(null));
    return () => {
      alive = false;
    };
    // `source` is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, recipe, animal, photo]);

  const load = (r: SpriteRecipe) => {
    if (!m) return;
    setBody(r.body);
    setSkin(r.skin);
    setParts(toParts(m, r));
    setTab('build');
  };

  const save = async () => {
    if (!source) return;
    setBusy(true);
    try {
      const blob = source.kind === 'upload' ? photo! : await canvasToPng(await renderSprite(source));
      await onSaved(await uploadPicture(campaignId, blob), source);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: typeof Shirt }[] = [
    { id: 'build', label: 'Build', icon: Shirt },
    { id: 'presets', label: 'Presets', icon: Sparkles },
    { id: 'animals', label: 'Animals', icon: PawPrint },
    { id: 'upload', label: 'Upload photo', icon: ImagePlus },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description="Build a pixel sprite piece by piece, start from a preset, pick an animal, or upload a photo." wide>
      {!m ? (
        <Spinner label="Loading sprite parts" />
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex shrink-0 flex-col items-center gap-3 sm:w-48">
            <div className="grid h-48 w-48 place-items-center rounded-lg border border-border bg-[repeating-conic-gradient(#1c1b24_0_25%,#24232e_0_50%)] bg-[length:16px_16px]" aria-label="Preview">
              {preview ? <img src={preview} alt="Preview" className="max-h-full max-w-full" style={{ width: tab === 'upload' ? '100%' : 192, imageRendering: tab === 'upload' ? 'auto' : 'pixelated' }} /> : <span className="text-xs text-faint">Nothing chosen</span>}
            </div>
            <Button className="w-full justify-center" disabled={!source} loading={busy} onClick={() => void save()}>
              Use this picture
            </Button>
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <div role="tablist" aria-label="Picture source" className="flex flex-wrap gap-1">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={cn('flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs', tab === t.id ? 'border-accent bg-accent/10 text-text' : 'border-border text-muted hover:bg-surface-2')}
                  onClick={() => setTab(t.id)}
                >
                  <t.icon className="h-3.5 w-3.5" aria-hidden /> {t.label}
                </button>
              ))}
            </div>

            {tab === 'build' && (
              <div className="scrollbar-thin max-h-[55vh] space-y-3 overflow-y-auto pr-1">
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Race" htmlFor="sbRace" className="flex-1">
                    <Select id="sbRace" className="h-8 text-xs" value={race} onChange={(e) => setRace(e.target.value)}>
                      {RACES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button size="sm" variant="secondary" onClick={() => load(randomRecipe(m, race))}>
                    <Dices className="h-4 w-4" aria-hidden /> Randomize
                  </Button>
                </div>
                <div className="flex gap-1" role="radiogroup" aria-label="Body">
                  {BODY_TYPES.map((b) => (
                    <button key={b} role="radio" aria-checked={body === b} className={cn('rounded-md border px-3 py-1 text-xs capitalize', body === b ? 'border-accent bg-accent/10' : 'border-border text-muted')} onClick={() => setBody(b)}>
                      {b}
                    </button>
                  ))}
                </div>
                <Swatches label="Skin" palettes={m.palettes.body} value={skin} onChange={setSkin} />
                {m.categories.map((c) => {
                  const items = c.items.filter((i) => i.layers.some((l) => l.src[body]));
                  const chosen = parts[c.id];
                  const item = chosen && items.find((i) => i.id === chosen.item);
                  return (
                    <div key={c.id} className="rounded-md border border-border p-2">
                      <Field label={c.label} htmlFor={`sb-${c.id}`}>
                        <Select
                          id={`sb-${c.id}`}
                          className="h-8 text-xs"
                          value={item ? item.id : ''}
                          onChange={(e) => {
                            const next = { ...parts };
                            if (e.target.value) next[c.id] = { item: e.target.value };
                            else delete next[c.id];
                            setParts(next);
                          }}
                        >
                          <option value="">{c.id === 'body' ? 'Normal' : 'None'}</option>
                          {items.filter((i) => c.id !== 'body' || i.id !== 'body').map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {item?.channels
                        .filter((ch) => !ch.skin)
                        .map((ch) => (
                          <Swatches
                            key={ch.key}
                            label={ch.label ?? ch.key}
                            palettes={m.palettes[ch.material]}
                            value={chosen?.colors?.[ch.key] ?? ch.base ?? m.bases[ch.material]}
                            onChange={(v) => setParts({ ...parts, [c.id]: { item: item.id, colors: { ...chosen?.colors, [ch.key]: v } } })}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
            )}

            {tab === 'presets' && <PresetGrid onPick={load} />}

            {tab === 'animals' && (
              <Gallery
                items={m.animals.map((a) => ({ id: a.id, name: a.name, source: { kind: 'animal', id: a.id } as const }))}
                selected={animal}
                onPick={(id) => setAnimal(id)}
              />
            )}

            {tab === 'upload' && <PhotoPicker onPicked={setPhoto} />}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Swatches({ label, palettes, value, onChange }: { label: string; palettes: Record<string, string[]>; value: string; onChange: (v: string) => void }) {
  return (
    <fieldset className="mt-2">
      <legend className="mb-1 text-[11px] text-muted">{label}</legend>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
        {Object.entries(palettes).map(([name, shades]) => (
          <button
            key={name}
            role="radio"
            aria-checked={value === name}
            aria-label={`${label} ${name.replace(/_/g, ' ')}`}
            title={name.replace(/_/g, ' ')}
            className={cn('h-5 w-5 rounded-full border-2', value === name ? 'border-accent' : 'border-transparent')}
            style={{ background: swatch(shades) }}
            onClick={() => onChange(name)}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** Thumbnail grid; thumbnails render lazily in the browser. */
function Gallery({ items, selected, onPick }: { items: { id: string; name: string; source: Exclude<SpriteSource, { kind: 'upload' }>; group?: string }[]; selected?: string; onPick: (id: string) => void }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    for (const it of items) void renderSprite(it.source).then((c) => alive && setThumbs((t) => ({ ...t, [it.id]: c.toDataURL() })));
    return () => {
      alive = false;
    };
    // Items are static per gallery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const groups = [...new Set(items.map((i) => i.group ?? ''))];
  return (
    <div className="scrollbar-thin max-h-[55vh] space-y-3 overflow-y-auto pr-1">
      {groups.map((g) => (
        <section key={g}>
          {g && <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{g}</h4>}
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {items
              .filter((i) => (i.group ?? '') === g)
              .map((i) => (
                <button key={i.id} aria-label={i.name} aria-pressed={selected === i.id} className={cn('flex flex-col items-center rounded-md border p-1 text-[11px] hover:bg-surface-2', selected === i.id ? 'border-accent bg-accent/10' : 'border-border')} onClick={() => onPick(i.id)}>
                  {thumbs[i.id] ? <img src={thumbs[i.id]} alt="" className="h-14 w-14 object-contain" style={{ imageRendering: 'pixelated' }} /> : <span className="h-14 w-14" />}
                  <span className="w-full truncate text-center">{i.name}</span>
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PresetGrid({ onPick }: { onPick: (r: SpriteRecipe) => void }) {
  return <Gallery items={SPRITE_PRESETS.map((p) => ({ id: p.id, name: p.name, group: p.group, source: { kind: 'lpc', recipe: p.recipe } }))} onPick={(id) => onPick(SPRITE_PRESETS.find((p) => p.id === id)!.recipe)} />;
}

function PhotoPicker({ onPicked }: { onPicked: (b: Blob | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">A square crop from the centre is used, at most 256 × 256 pixels.</p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Photo file"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            onPicked(await portraitFromFile(f));
            setName(f.name);
          } catch {
            toast.error('That file could not be read as an image.');
            onPicked(null);
          }
        }}
      />
      <Button variant="outline" onClick={() => input.current?.click()}>
        <ImagePlus className="h-4 w-4" aria-hidden /> Choose a photo…
      </Button>
      {name && <p className="text-xs text-faint">{name}</p>}
    </div>
  );
}
