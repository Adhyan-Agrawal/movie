import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Container } from '@/components/ui/Container';
import { PageHeader } from '@/components/ui/PageHeader';
import { listAllGenres } from '@/features/catalog/queries';
import type { TitleFilters } from '@/features/catalog/queries';
import { BrowseResults, parseTitleFilters, type SearchParamsRecord } from '@/features/catalog/components/BrowseResults';

/** Slugify a genre name the same way inbound slugs are expected (e.g. "Sci-Fi" -> "sci-fi"). */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Map a slug back to its canonical genre name, case-insensitively. */
async function resolveGenre(slug: string): Promise<string | null> {
  const target = slug.toLowerCase();
  const genres = await listAllGenres();
  return genres.find((g) => slugify(g) === target) ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const genre = await resolveGenre(slug);
  if (!genre) return { title: 'Genre' };
  return {
    title: genre,
    description: `Browse ${genre} movies and TV shows on Lumora.`,
  };
}

export default async function GenrePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParamsRecord>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const genre = await resolveGenre(slug);
  if (!genre) notFound();

  const genres = await listAllGenres();
  const filters: TitleFilters = { ...parseTitleFilters(sp), genre };

  return (
    <Container>
      <PageHeader title={genre} description={`${genre} movies and shows across the catalog.`} />
      <BrowseResults filters={filters} sp={sp} basePath={`/genre/${slug}`} genres={genres} lockGenre={genre} />
    </Container>
  );
}
