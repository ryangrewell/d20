import { Link } from 'react-router-dom';
import { Compass, Eye, Map, MousePointer2, Ruler, Users } from 'lucide-react';
import { useAuth } from '@/app/auth';
import { Button } from '@/components/ui/primitives';
import { Logo } from '@/components/layout/AppLayout';

const FEATURES = [
  { icon: Ruler, title: 'True-scale maps', body: 'Calibrate any map from a known distance. City miles and tavern feet both measure correctly at every zoom.' },
  { icon: Eye, title: 'Secrets stay secret', body: 'Hidden monsters, GM notes and whispers never reach a player’s browser. Fog is enforced on the server.' },
  { icon: MousePointer2, title: 'Point together', body: 'See everyone’s cursor on the map, ping locations, and pull the whole table’s camera to the action.' },
  { icon: Users, title: 'Your call, your app', body: 'Keep using Zoom or Teams for voice. d20 holds the map, the tokens, the dice and the chat.' },
  { icon: Map, title: 'Persistent campaigns', body: 'Every move, fog reveal and roll is saved as it happens. Pick up next week exactly where you left off.' },
  { icon: Compass, title: 'Any d20 system', body: 'A system-agnostic table with flexible dice, so your homebrew and favourite rules fit right in.' },
];

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="min-h-full bg-atmosphere">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Logo />
        <div className="flex gap-2">
          {user ? (
            <Link to="/dashboard">
              <Button>Open your campaigns</Button>
            </Link>
          ) : (
            <>
              <Link to="/sign-in">
                <Button variant="ghost">Sign in</Button>
              </Link>
              <Link to="/sign-up">
                <Button>Get started</Button>
              </Link>
            </>
          )}
        </div>
      </header>
      <section className="mx-auto max-w-4xl px-4 pb-16 pt-20 text-center">
        <p className="text-sm font-medium uppercase tracking-[0.25em] text-accent">Virtual tabletop</p>
        <h1 className="mt-4 font-display text-4xl font-bold leading-tight tracking-wide sm:text-6xl">Run the table. Keep the secrets.</h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted">
          A shared, true-to-scale battle map for your group. The GM controls what players see; players move, point, roll and chat in real time.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link to={user ? '/dashboard' : '/sign-up'}>
            <Button size="lg">{user ? 'Go to dashboard' : 'Create a free account'}</Button>
          </Link>
          {!user && (
            <Link to="/sign-in">
              <Button size="lg" variant="outline">
                I have an invite
              </Button>
            </Link>
          )}
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-xl border border-border bg-surface/60 p-6">
            <f.icon className="h-6 w-6 text-accent" aria-hidden />
            <h2 className="mt-4 font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-muted">{f.body}</p>
          </div>
        ))}
      </section>
      <footer className="border-t border-border/60 py-8 text-center text-xs text-faint">
        <Link to="/legal" className="hover:text-muted">
          Terms, privacy &amp; credits
        </Link>
      </footer>
    </div>
  );
}
