import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { getHomeData } from '@/features/catalog/data';
import { Hero } from '@/features/catalog/components/Hero';
import { HeroCarousel } from '@/features/catalog/components/HeroCarousel';
import { ContinueWatchingRow, MediaRow } from '@/features/catalog/components/MediaRow';
import { GuestContinueWatchingRow } from '@/features/catalog/components/GuestContinueWatchingRow';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';
import { DiscoveryNav } from '@/features/catalog/components/DiscoveryNav';

export default async function HomePage() {
  const { hero, heroTitles, continueWatching, rows, collections, forYou, degraded, signedIn } = await getHomeData();

  // Honest empty states: no mock fallback, no fabricated rows.
  if (!hero) {
    return (
      <div className="flex flex-col gap-8 py-16">
        {signedIn ? <ContinueWatchingRow entries={continueWatching} /> : <GuestContinueWatchingRow />}
        {forYou ? <MediaRow row={forYou} /> : null}
        <div className="px-4 md:px-8">
        {degraded ? (
          <EmptyState
            icon="⚠"
            tone="warning"
            title="The catalog is unavailable right now"
            description="We couldn’t load titles from the catalog. Please try again shortly."
          />
        ) : (
          <EmptyState
            title="The catalog is empty"
            description="No titles are available from the catalog right now."
            action={
              <Link href="/browse" className={buttonClasses({ variant: 'secondary' })}>
                Browse anyway
              </Link>
            }
          />
        )}
        </div>
      </div>
    );
  }

  return (
    <div className="discovery-home flex flex-col gap-8 pb-12 md:gap-10">
      {/* Rotating hero: auto-advances through the top trending titles so the
          banner shows fresh movies/series on every visit. */}
      {heroTitles.length > 1 ? (
        <HeroCarousel>{heroTitles.map((t, index) => <Hero key={t.id} title={t} priority={index === 0} />)}</HeroCarousel>
      ) : (
        <Hero title={hero} />
      )}

      <div className="flex flex-col gap-4 px-4 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-content-muted">Your world of movies and series.</p>
          <div className="flex gap-4 text-sm font-semibold">
            <Link href="/movies" className="min-h-11 content-center hover:text-primary">Movies</Link>
            <Link href="/tv" className="min-h-11 content-center hover:text-primary">Series</Link>
            <Link href="/account/watchlist" className="min-h-11 content-center hover:text-primary">My watchlist</Link>
          </div>
        </div>
        <DiscoveryNav collections={collections ?? []} />
      </div>
      <div className="flex flex-col gap-10">
        {/* Continue watching: server-side row for signed-in viewers; guests get
            a browser-local row instead (localStorage) — one or the other, never
            another user's history. */}
        {signedIn ? (
          <ContinueWatchingRow entries={continueWatching} />
        ) : (
          <GuestContinueWatchingRow />
        )}
        {/* Personalized row (Spec Section 13): titles matched to this viewer's
            taste — shown only when there's enough history to recommend from. */}
        {forYou ? <MediaRow row={forYou} /> : null}
        {/* Ad (Spec Section 11): one leaderboard below the fold — after the first
            content rows, before the rest. Low density by design. */}
        {rows.map((row, index) => (
          <div key={row.id} className="flex flex-col gap-10">
            <MediaRow row={row} />
            {index === 0 && rows.length > 1 ? <ConsentGate><AdSlot slot="homeLeaderboard" /></ConsentGate> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
