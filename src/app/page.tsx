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

export default async function HomePage() {
  const { hero, heroTitles, continueWatching, rows, degraded, signedIn } = await getHomeData();

  // Honest empty states: no mock fallback, no fabricated rows.
  if (!hero) {
    return (
      <div className="px-4 py-16 md:px-8">
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
            description="Sync titles from the admin console to start populating Lumora."
            action={
              <Link href="/browse" className={buttonClasses({ variant: 'secondary' })}>
                Browse anyway
              </Link>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 pb-8">
      {/* Rotating hero: auto-advances through the top trending titles so the
          banner shows fresh movies/series on every visit. */}
      {heroTitles.length > 1 ? (
        <HeroCarousel>{heroTitles.map((t) => <Hero key={t.id} title={t} />)}</HeroCarousel>
      ) : (
        <Hero title={hero} />
      )}

      <div className="flex flex-col gap-10">
        {/* Continue watching: server-side row for signed-in viewers; guests get
            a browser-local row instead (localStorage) — one or the other, never
            another user's history. */}
        {signedIn ? (
          <ContinueWatchingRow entries={continueWatching} />
        ) : (
          <GuestContinueWatchingRow />
        )}
        {/* Ad (Spec Section 11): one leaderboard below the fold — after the first
            content rows, before the rest. Low density by design. */}
        {rows.length > 1 ? <ConsentGate><AdSlot slot="homeLeaderboard" /></ConsentGate> : null}
        {rows.map((row) => (
          <MediaRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}
