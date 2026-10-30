import { Link } from 'react-router-dom';
import { Logo } from '@/components/layout/AppLayout';

export function LegalPage() {
  return (
    <div className="min-h-full bg-atmosphere">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Logo />
        <h1 className="mt-10 font-display text-3xl font-bold">Terms, privacy &amp; credits</h1>
        <div className="mt-6 space-y-6 text-sm leading-relaxed text-muted">
          <section>
            <h2 className="mb-2 text-base font-semibold text-text">Your content</h2>
            <p>
              Maps, images and text you upload remain yours and are visible only to members of the campaign you upload them to. Only upload material you have the right to
              use. Do not use d20 to redistribute copyrighted books, adventures or artwork.
            </p>
          </section>
          <section>
            <h2 className="mb-2 text-base font-semibold text-text">Privacy</h2>
            <p>
              We store your email, display name and campaign data to run the service. Private messages are delivered only to their recipients. Platform administrators
              do not routinely access private campaign content. You can request account deletion from your account page.
            </p>
          </section>
          <section>
            <h2 className="mb-2 text-base font-semibold text-text">Fog of war</h2>
            <p>
              Hidden creatures, GM notes and unrevealed objects are never sent to players. Uploaded map images themselves are shared with players in the scene, so do not
              put spoilers in a map image you intend to fog.
            </p>
          </section>
          <section>
            <h2 className="mb-2 text-base font-semibold text-text">Credits</h2>
            <p>
              d20 currently ships a generic, system-agnostic rules layer and does not include third-party rulebook content. Icons by Lucide (ISC license). Sprite builder
              art is by the Liberated Pixel Cup and OpenGameArt artists listed on the{' '}
              <Link to="/credits" className="text-accent underline">
                art credits
              </Link>{' '}
              page.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
