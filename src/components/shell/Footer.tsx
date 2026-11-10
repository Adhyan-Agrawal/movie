import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { publicEnv } from '@/lib/env';
import { Container } from '@/components/ui/Container';

/** Global footer with legal + discovery links (Section 15/16). */
export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer border-t border-border text-sm text-content-muted">
      <Container>
        <div className="site-footer-top">
          <div>
            <Link href="/" aria-label="Lumora home" className="site-wordmark"><Logo size={25} /><span>lumora<span className="site-wordmark-period">.</span></span></Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-content-muted">For the love of a good story.</p>
          </div>
        <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3">
          <nav aria-label="Browse" className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Browse</h2>
            <Link href="/browse" className="site-footer-link">All titles</Link>
            <Link href="/movies" className="site-footer-link">Movies</Link>
            <Link href="/tv" className="site-footer-link">Series</Link>
            <Link href="/search" className="site-footer-link">Search</Link>
          </nav>
          <nav aria-label="Account" className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Account</h2>
            <Link href="/account" prefetch={false} className="site-footer-link">Overview</Link>
            <Link href="/account/watchlist" prefetch={false} className="site-footer-link">My watchlist</Link>
            <div>
              <Link href="/browse" prefetch={false} className="site-footer-link" aria-describedby="footer-watch-party-help">Find a title for Watch Party</Link>
              <p id="footer-watch-party-help" className="mt-1 max-w-xs text-xs leading-relaxed text-content-subtle">
                Open a title and use Watch Party in the player, where available.
              </p>
            </div>
            <Link href="/request" prefetch={false} className="site-footer-link">Request a title</Link>
            <Link href="/account/settings" prefetch={false} className="site-footer-link">Settings</Link>
          </nav>
          <nav aria-label="Legal" className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Legal</h2>
            <Link href="/legal/privacy" className="site-footer-link">Privacy</Link>
            <Link href="/legal/terms" className="site-footer-link">Terms</Link>
            <Link href="/legal/cookies" className="site-footer-link">Cookies</Link>
          </nav>
        </div>
        </div>
        <div className="site-footer-bottom">
          <span>
            © {year} {publicEnv.NEXT_PUBLIC_APP_NAME}. All rights reserved.
          </span>
          <span>Playback availability varies by title and provider.</span>
        </div>
      </Container>
    </footer>
  );
}
