import type { Metadata } from 'next';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { SearchClient } from '@/features/catalog/components/SearchClient';
import { listAllGenres } from '@/features/catalog/queries';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search movies and shows across Lumora.',
  // Search result pages should not be indexed (Section 16).
  robots: { index: false, follow: true },
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = sp.q;
  const initialQuery = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const genres = await listAllGenres();

  return (
    <Container>
      <PageHeader title="Search" description="Find movies and shows across Lumora." />
      {/* Ad (Spec Section 11): one banner above the search results, consent-gated. */}
      <ConsentGate>
        <AdSlot slot="searchLeaderboard" />
      </ConsentGate>
      <SearchClient initialQuery={initialQuery} genres={genres} />
    </Container>
  );
}
