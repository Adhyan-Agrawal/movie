import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { listAllGenres } from '@/features/catalog/queries';
import type { TitleFilters } from '@/features/catalog/queries';
import { BrowseResults, parseTitleFilters, type SearchParamsRecord } from '@/features/catalog/components/BrowseResults';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';

export const metadata: Metadata = {
  title: 'TV',
  description: 'Browse series on Lumora by genre, decade, rating, and sort.',
};

export default async function TvPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const sp = await searchParams;
  const genres = await listAllGenres();
  const filters: TitleFilters = { ...parseTitleFilters(sp), type: 'tv' };

  return (
    <Container>
      <PageHeader title="TV" description="Series and limited runs, filtered your way." />
      <BrowseResults filters={filters} sp={sp} basePath="/tv" genres={genres} lockType="tv" />
      {/* Ad (Spec Section 11): one leaderboard below the results — below the fold. */}
      <ConsentGate><AdSlot slot="browseLeaderboard" /></ConsentGate>
    </Container>
  );
}
