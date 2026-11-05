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
import { Container } from '@/components/ui/Container';
import { Icon } from '@/components/ui/Icon';
import { features } from '@/lib/env';
import { SectionReveal } from '@/components/ui/SectionReveal';

export default async function HomePage() {
  const { hero, heroTitles, continueWatching, rows, collections, forYou, degraded, signedIn } = await getHomeData();

  // Honest empty states: no mock fallback, no fabricated rows.
  if (!hero) {
    return (
      <div className="flex flex-col gap-8 py-16">
        {signedIn ? <ContinueWatchingRow entries={continueWatching} /> : <GuestContinueWatchingRow accountsAvailable={features.supabaseConfigured} />}
        {forYou ? <MediaRow row={forYou} /> : null}
        <Container>
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
        </Container>
      </div>
    );
  }

  return (
    <div className="discovery-home">
      {heroTitles.length > 1 ? (
        <HeroCarousel>{heroTitles.map((t, index) => <Hero key={t.id} title={t} priority={index === 0} />)}</HeroCarousel>
      ) : (
        <Hero title={hero} />
      )}

      <Container className="home-discovery-intro">
        <div className="home-intro-heading">
          <div><p className="site-eyebrow">The collection</p><h2 className="home-intro-title">A world of stories.<br /><span>Find yours.</span></h2></div>
          <Link href="/account/watchlist" prefetch={false} className="home-watchlist-link"><Icon name="bookmark" width="18" height="18" />My watchlist<Icon name="arrow-right" width="18" height="18" /></Link>
        </div>
        <DiscoveryNav collections={collections ?? []} />
      </Container>
      <div className="home-shelves">
        {/* Continue watching: server-side row for signed-in viewers; guests get
            a browser-local row instead (localStorage) — one or the other, never
            another user's history. */}
        {signedIn ? (
          <ContinueWatchingRow entries={continueWatching} />
        ) : (
          <GuestContinueWatchingRow accountsAvailable={features.supabaseConfigured} />
        )}
        {/* Personalized row (Spec Section 13): titles matched to this viewer's
            taste — shown only when there's enough history to recommend from. */}
        {forYou ? <SectionReveal><MediaRow row={forYou} variant="landscape" /></SectionReveal> : null}
        {/* Ad (Spec Section 11): one leaderboard below the fold — after the first
            content rows, before the rest. Low density by design. */}
        {rows.map((row, index) => (
          <div key={row.id} className="home-shelf-group">
            <SectionReveal><MediaRow row={row} number={index + 1} variant={index % 4 === 2 ? 'landscape' : 'poster'} /></SectionReveal>
            {index === 0 && rows.length > 1 ? <ConsentGate><AdSlot slot="homeLeaderboard" /></ConsentGate> : null}
          </div>
        ))}
      </div>
      <Container><SectionReveal className="home-closing"><p className="site-eyebrow">Keep exploring</p><h2>There is always<br />another story.</h2><Link href="/browse" prefetch={false} className="home-closing-link">Explore the full catalog<Icon name="arrow-right" /></Link></SectionReveal></Container>
    </div>
  );
}
