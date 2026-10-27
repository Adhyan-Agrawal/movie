import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { listAllGenres } from '@/features/catalog/queries';
import { BrowseResults, parseTitleFilters, type SearchParamsRecord } from '@/features/catalog/components/BrowseResults';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';
import { DiscoveryNav } from '@/features/catalog/components/DiscoveryNav';
import { DiscoveryFilters } from '@/features/catalog/components/DiscoveryFilters';
import { parseDiscoveryFilters } from '@/features/catalog/discovery';

export const metadata: Metadata = {
  title: 'Browse',
  description: 'Filter the Lumora catalog by type, genre, decade, rating, and sort.',
};

export default async function BrowsePage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const sp = await searchParams;
  const genres = await listAllGenres();
  const filters = { ...parseTitleFilters(sp), ...parseDiscoveryFilters(sp) };

  return (
    <Container>
      <PageHeader title="Discover your next favorite" description="Big thrills, quiet romances and stories from around the world. Find your corner of Lumora." />
      <div className="mb-5"><DiscoveryNav genres={genres} /></div>
      <DiscoveryFilters />
      <BrowseResults filters={filters} sp={sp} basePath="/browse" genres={genres} />
      {/* Ad (Spec Section 11): one leaderboard below the results — below the fold. */}
      <ConsentGate><AdSlot slot="browseLeaderboard" /></ConsentGate>
    </Container>
  );
}
