import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { listAllGenres } from '@/features/catalog/queries';
import type { TitleFilters } from '@/features/catalog/queries';
import { BrowseResults, parseTitleFilters, type SearchParamsRecord } from '@/features/catalog/components/BrowseResults';
import { AdSlot } from '@/features/ads/AdSlot';

export const metadata: Metadata = {
  title: 'Movies',
  description: 'Browse feature films on Lumora by genre, decade, rating, and sort.',
};

export default async function MoviesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const sp = await searchParams;
  const genres = await listAllGenres();
  const filters: TitleFilters = { ...parseTitleFilters(sp), type: 'movie' };

  return (
    <Container>
      <PageHeader title="Movies" description="Feature films, filtered your way." />
      <BrowseResults filters={filters} sp={sp} basePath="/movies" genres={genres} lockType="movie" />
      {/* Ad (Spec Section 11): one leaderboard below the results — below the fold. */}
      <AdSlot slot="browseLeaderboard" />
    </Container>
  );
}
