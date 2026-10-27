import type { DiscoveryCollection, DiscoveryFilters, MediaRow, Title, TitleType } from './types';

export const DISCOVERY_GENRES = ['Action', 'Comedy', 'Horror', 'Thriller', 'Romance', 'Science Fiction', 'Animation', 'Family', 'Documentary'] as const;
export const DISCOVERY_LANGUAGES = [
  { value: 'hi', label: 'Hindi' }, { value: 'ta|te|ml|kn', label: 'Tamil, Telugu, Malayalam & Kannada' },
  { value: 'ko', label: 'Korean' }, { value: 'ja', label: 'Japanese' },
  { value: 'en', label: 'English' }, { value: 'fr', label: 'French' }, { value: 'es', label: 'Spanish' },
] as const;

export function discoveryHref(filters: DiscoveryFilters, basePath = '/browse'): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.size ? `${basePath}?${params}` : basePath;
}

function collection(id: string, label: string, filters: DiscoveryFilters): DiscoveryCollection {
  return { id, label, filters, href: discoveryHref(filters) };
}

export const DISCOVERY_COLLECTIONS: DiscoveryCollection[] = [
  ...DISCOVERY_GENRES.map((genre) => collection(`genre-${genre.toLowerCase().replaceAll(' ', '-')}`, genre === 'Science Fiction' ? 'Sci-Fi' : genre, { genre, sort: 'trending' })),
  collection('hindi-cinema', 'Hindi cinema', { type: 'movie', originalLanguage: 'hi', sort: 'trending' }),
  collection('south-indian-cinema', 'South Indian cinema', { type: 'movie', originalLanguage: 'ta|te|ml|kn', country: 'IN', sort: 'trending' }),
  collection('korean', 'Korean stories', { originalLanguage: 'ko', sort: 'trending' }),
  collection('japanese', 'Japanese stories', { originalLanguage: 'ja', sort: 'trending' }),
  collection('french', 'French-language cinema', { type: 'movie', originalLanguage: 'fr', sort: 'trending' }),
  collection('spanish', 'Spanish-language cinema', { type: 'movie', originalLanguage: 'es', sort: 'trending' }),
  collection('world-cinema', 'World cinema', { type: 'movie', originalLanguage: 'fr|es|de|it|pt|zh|ar|fa', sort: 'trending' }),
];

export const DISCOVERY_SHELVES: DiscoveryCollection[] = [
  collection('newest', 'New & recent', { sort: 'newest' }),
  collection('top-rated', 'Top rated', { sort: 'score' }),
  collection('movies', 'Movie night', { type: 'movie', sort: 'trending' }),
  collection('tv', 'Series to get into', { type: 'tv', sort: 'trending' }),
  ...DISCOVERY_COLLECTIONS,
];

export function normalizeLanguageFilter(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const codes = value.toLowerCase().split('|');
  return codes.length <= 8 && codes.every((code) => /^[a-z]{2}$/.test(code)) ? [...new Set(codes)].join('|') : undefined;
}

export function normalizeCountryFilter(value: string | undefined): string | undefined {
  return value && /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : undefined;
}

export function parseDiscoveryFilters(sp: Record<string, string | string[] | undefined>): Pick<DiscoveryFilters, 'originalLanguage' | 'country'> {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const originalLanguage = normalizeLanguageFilter(first(sp.originalLanguage));
  const country = normalizeCountryFilter(first(sp.country));
  return { ...(originalLanguage ? { originalLanguage } : {}), ...(country ? { country } : {}) };
}

export function providerGenre(genre: string, type: TitleType): string {
  if (type === 'tv' && genre.toLowerCase() === 'action') return 'Action & Adventure';
  if (type === 'tv' && ['science fiction', 'sci-fi'].includes(genre.toLowerCase())) return 'Sci-Fi & Fantasy';
  return genre.toLowerCase() === 'sci-fi' ? 'Science Fiction' : genre;
}

export function matchesDiscovery(title: Title, filters: DiscoveryFilters): boolean {
  const language = normalizeLanguageFilter(filters.originalLanguage);
  const country = normalizeCountryFilter(filters.country);
  if ((filters.originalLanguage && !language) || (filters.country && !country)) return false;
  return (!filters.type || title.type === filters.type)
    && (!filters.genre || title.genres.some((genre) => genre.toLowerCase() === filters.genre!.toLowerCase() || genre.toLowerCase() === providerGenre(filters.genre!, title.type).toLowerCase()))
    && (!language || Boolean(title.originalLanguage && language.split('|').includes(title.originalLanguage.toLowerCase())))
    && (!country || Boolean(title.originCountries?.some((value) => normalizeCountryFilter(value) === country)));
}

export function collectionRow(definition: DiscoveryCollection, titles: Title[]): MediaRow | null {
  const unique = [...new Map(titles.filter((title) => matchesDiscovery(title, definition.filters)).map((title) => [title.id, title])).values()].slice(0, 12);
  if (!unique.length) return null;
  return {
    id: definition.id, collectionId: definition.id, heading: definition.label, href: definition.href, filters: definition.filters, titles: unique,
    ...(definition.id === 'hindi-cinema' ? { reason: 'Bollywood and other Hindi-language films' } : {}),
    ...(definition.id === 'south-indian-cinema' ? { reason: 'Tamil, Telugu, Malayalam and Kannada films from India' } : {}),
    ...(definition.id === 'world-cinema' ? { reason: 'A selection of French, Spanish, German, Italian, Portuguese, Chinese, Arabic and Persian-language films' } : {}),
  };
}

/** Bounded workers preserve display order and stop launching reads at the budget. */
export async function loadDiscoveryRows(read: (filters: DiscoveryFilters & { limit: number }) => Promise<Title[]>, budgetMs = 6000): Promise<MediaRow[]> {
  const deadline = Date.now() + budgetMs;
  const rows: Array<MediaRow | null> = Array(DISCOVERY_SHELVES.length).fill(null);
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < DISCOVERY_SHELVES.length && Date.now() < deadline) {
      const index = cursor++;
      const definition = DISCOVERY_SHELVES[index]!;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const titles = await Promise.race([
          read({ ...definition.filters, limit: 12 }),
          new Promise<Title[]>((resolve) => { timeout = setTimeout(() => resolve([]), Math.max(0, deadline - Date.now())); }),
        ]);
        rows[index] = collectionRow(definition, titles);
      } catch { /* Optional collections disappear on read failure. */ }
      finally { clearTimeout(timeout); }
    }
  }));
  return rows.filter((row): row is MediaRow => row !== null);
}
