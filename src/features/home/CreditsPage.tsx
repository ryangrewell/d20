import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SpriteManifest } from '@shared/sprites/compose';
import { Logo } from '@/components/layout/AppLayout';
import { ErrorNotice, Spinner } from '@/components/ui/primitives';
import { loadManifest } from '@/features/sprites/render';

/** Attribution for the pixel art in the sprite builder, generated from the sprite manifest. */
export function CreditsPage() {
  const [m, setM] = useState<SpriteManifest | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    loadManifest().then(setM, setError);
  }, []);
  // One entry per distinct set of authors, with every licence and source they were credited under.
  const byAuthors = new Map<string, { authors: string[]; licenses: Set<string>; urls: Set<string> }>();
  for (const c of m?.credits ?? []) {
    const key = [...c.authors].sort().join(', ');
    const e = byAuthors.get(key) ?? { authors: c.authors, licenses: new Set<string>(), urls: new Set<string>() };
    c.licenses.forEach((l) => e.licenses.add(l));
    c.urls.forEach((u) => e.urls.add(u));
    byAuthors.set(key, e);
  }
  const entries = [...byAuthors.values()].sort((a, b) => a.authors.join().localeCompare(b.authors.join()));
  return (
    <div className="min-h-full bg-atmosphere">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Logo />
        <h1 className="mt-10 font-display text-3xl font-bold">Art credits</h1>
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted">
          <p>
            The sprite builder's characters, creatures and animals are pixel art from the{' '}
            <a className="text-accent underline" href="https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator" target="_blank" rel="noreferrer">
              Liberated Pixel Cup (LPC)
            </a>{' '}
            community and{' '}
            <a className="text-accent underline" href="https://opengameart.org" target="_blank" rel="noreferrer">
              OpenGameArt
            </a>
            , used under the licences listed below. Sprites made from this art stay under those same licences. Thank you to every artist.
          </p>
          {error && <ErrorNotice error={error} />}
          {!m && !error && <Spinner label="Loading credits" />}
          <ul className="space-y-3">
            {entries.map((e) => (
              <li key={e.authors.join()} className="rounded-lg border border-border bg-surface/60 p-3">
                <p className="font-medium text-text">{e.authors.join(', ') || 'Unknown author'}</p>
                <p className="text-xs">{[...e.licenses].join(' · ')}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                  {[...e.urls].map((u) => (
                    <a key={u} className="break-all text-accent underline" href={u} target="_blank" rel="noreferrer">
                      {u.replace(/^https?:\/\/(www\.)?/, '')}
                    </a>
                  ))}
                </p>
              </li>
            ))}
          </ul>
          <p>
            <Link to="/legal" className="text-accent underline">
              Terms, privacy &amp; other credits
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
