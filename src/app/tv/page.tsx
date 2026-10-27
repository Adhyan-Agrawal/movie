import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { listAllGenres } from '@/features/catalog/queries';
import type { TitleFilters } from '@/features/catalog/queries';
import { BrowseResults, parseTitleFilters, type SearchParamsRecord } from '@/features/catalog/components/BrowseResults';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';
import { DiscoveryNav } from '@/features/catalog/components/DiscoveryNav';
import { DiscoveryFilters } from '@/features/catalog/components/DiscoveryFilters';
import { parseDiscoveryFilters } from '@/features/catalog/discovery';

export const metadata: Metadata = {
  title: 'TV',
  description: 'Browse series on Lumora by genre, decade, rating, and sort.',
};

export default async function TvPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const sp = await searchParams;
  const genres = await listAllGenres();
  const filters: TitleFilters = { ...parseTitleFilters(sp), ...parseDiscoveryFilters(sp), type: 'tv' };

  return (
    <Container>
      <PageHeader title="Your next great series" description="One more episode. Discover dramas, comedies and stories in every language." />
      <div className="mb-5"><DiscoveryNav type="tv" genres={genres} /></div>
      <DiscoveryFilters />
      <BrowseResults filters={filters} sp={sp} basePath="/tv" genres={genres} lockType="tv" />
      {/* Ad (Spec Section 11): one leaderboard below the results — below the fold. */}
      <ConsentGate><AdSlot slot="browseLeaderboard" /></ConsentGate>
    </Container>
  );
}
