import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { publicEnv } from '@/lib/env';

/** Global footer with legal + discovery links (Section 15/16). */
export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border bg-surface/40 px-4 py-10 text-sm text-content-muted md:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <nav aria-label="Browse" className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Browse</h2>
            <Link href="/browse" className="hover:text-content">All titles</Link>
            <Link href="/movies" className="hover:text-content">Movies</Link>
            <Link href="/tv" className="hover:text-content">TV</Link>
            <Link href="/search" className="hover:text-content">Search</Link>
          </nav>
          <nav aria-label="Account" className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Account</h2>
            <Link href="/account" className="hover:text-content">Overview</Link>
            <Link href="/account/watchlist" className="hover:text-content">Watchlist</Link>
            <Link href="/account/settings" className="hover:text-content">Settings</Link>
          </nav>
          <nav aria-label="Legal" className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-subtle">Legal</h2>
            <Link href="/legal/privacy" className="hover:text-content">Privacy</Link>
            <Link href="/legal/terms" className="hover:text-content">Terms</Link>
            <Link href="/legal/cookies" className="hover:text-content">Cookies</Link>
          </nav>
          <div className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-content-subtle">
              <Logo size={16} />
              {publicEnv.NEXT_PUBLIC_APP_NAME}
            </h2>
            <p className="text-xs leading-relaxed text-content-subtle">
              A calm, premium place to discover and watch. Playback may be delivered through clearly labeled
              external providers.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start justify-between gap-2 border-t border-border pt-6 text-xs text-content-subtle sm:flex-row sm:items-center">
          <span>
            © {year} {publicEnv.NEXT_PUBLIC_APP_NAME}. All rights reserved.
          </span>
          <span>Content shown is authorized sample data.</span>
        </div>
      </div>
    </footer>
  );
}
