import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectionRow, DISCOVERY_COLLECTIONS, DISCOVERY_GENRES, DISCOVERY_SHELVES, discoveryHref, loadDiscoveryRows, matchesDiscovery, parseDiscoveryFilters } from '@/features/catalog/discovery';
import type { DiscoveryFilters, Title } from '@/features/catalog/types';

const title = (fields: Partial<Title> = {}): Title => ({ id: 'movie-1', type: 'movie', slug: 'fixture-1', name: 'Fixture', synopsis: '', releaseYear: 2024, maturity: 'PG', genres: ['Comedy'], ...fields });
afterEach(() => vi.useRealTimers());

describe('verified discovery collections', () => {
  it('provides the requested nine genres and language collections', () => {
    expect(DISCOVERY_GENRES).toEqual(['Action', 'Comedy', 'Horror', 'Thriller', 'Romance', 'Science Fiction', 'Animation', 'Family', 'Documentary']);
    expect(DISCOVERY_COLLECTIONS.map((item) => item.id)).toEqual(expect.arrayContaining(['hindi-cinema', 'south-indian-cinema', 'korean', 'japanese', 'french', 'spanish', 'world-cinema']));
  });

  it('labels Hindi language films honestly, not all Indian films as Bollywood', () => {
    const hindi = DISCOVERY_COLLECTIONS.find((item) => item.id === 'hindi-cinema')!;
    const row = collectionRow(hindi, [title({ originalLanguage: 'hi' }), title({ id: 'tamil', originalLanguage: 'ta', originCountries: ['IN'] }), title({ id: 'unknown', originCountries: ['IN'] })]);
    expect(row?.heading).toBe('Hindi cinema');
    expect(row?.titles.map((item) => item.id)).toEqual(['movie-1']);
    expect(row?.reason).toContain('other Hindi-language films');
  });

  it('groups the four South Indian languages only with verified Indian origin', () => {
    const south = DISCOVERY_COLLECTIONS.find((item) => item.id === 'south-indian-cinema')!;
    const candidates = ['ta', 'te', 'ml', 'kn', 'hi', undefined].map((originalLanguage, index) => title({ id: String(index), originCountries: ['IN'], ...(originalLanguage ? { originalLanguage } : {}) }));
    candidates.push(title({ id: 'unknown-country', originalLanguage: 'ta' }), title({ id: 'other-country', originalLanguage: 'ta', originCountries: ['US'] }));
    expect(collectionRow(south, candidates)?.titles.map((item) => item.id)).toEqual(['0', '1', '2', '3']);
  });

  it('does not infer a country from original language', () => {
    expect(matchesDiscovery(title({ originalLanguage: 'ko' }), { country: 'KR' })).toBe(false);
    expect(matchesDiscovery(title({ originalLanguage: 'ko', originCountries: ['US'] }), { country: 'KR' })).toBe(false);
    expect(matchesDiscovery(title({ originalLanguage: 'ko', originCountries: ['KR'] }), { country: 'KR' })).toBe(true);
  });

  it('maps Action and Sci-Fi TV taxonomy without tagging unrelated genres', () => {
    expect(matchesDiscovery(title({ type: 'tv', genres: ['Action & Adventure'] }), { genre: 'Action' })).toBe(true);
    expect(matchesDiscovery(title({ type: 'tv', genres: ['Action'] }), { genre: 'Action' })).toBe(true);
    expect(matchesDiscovery(title({ type: 'tv', genres: ['Sci-Fi & Fantasy'] }), { genre: 'Science Fiction' })).toBe(true);
    expect(matchesDiscovery(title({ genres: ['Drama'] }), { genre: 'Horror' })).toBe(false);
  });

  it('normalizes filter case and rejects invalid metadata dimensions', () => {
    const korean = title({ originalLanguage: 'ko', originCountries: ['KR'] });
    expect(matchesDiscovery(korean, { originalLanguage: 'KO', country: 'kr' })).toBe(true);
    expect(matchesDiscovery(korean, { originalLanguage: 'ko,ja' })).toBe(false);
    expect(matchesDiscovery(korean, { country: 'Korea' })).toBe(false);
    expect(matchesDiscovery(title(), { originalLanguage: 'en' })).toBe(false);
  });

  it('describes world cinema as an explicit language selection, not inferred geography', () => {
    const world = DISCOVERY_COLLECTIONS.find((item) => item.id === 'world-cinema')!;
    const row = collectionRow(world, [title({ originalLanguage: 'fr' }), title({ id: 'unknown', originCountries: ['FR'] }), title({ id: 'english', originalLanguage: 'en' })]);
    expect(row?.titles.map((item) => item.id)).toEqual(['movie-1']);
    expect(row?.reason).toContain('A selection');
    expect(world.filters).not.toHaveProperty('country');
  });

  it('keeps unique stable collection IDs and matching full-list links', () => {
    expect(new Set(DISCOVERY_SHELVES.map((item) => item.id)).size).toBe(DISCOVERY_SHELVES.length);
    const comedy = DISCOVERY_COLLECTIONS.find((item) => item.filters.genre === 'Comedy')!;
    const row = collectionRow(comedy, [title()]);
    expect(row?.collectionId).toBe(comedy.id);
    expect(row?.href).toBe(discoveryHref(comedy.filters));
  });

  it('omits empty rows, deduplicates and caps shelves', () => {
    const comedy = DISCOVERY_COLLECTIONS.find((item) => item.filters.genre === 'Comedy')!;
    expect(collectionRow(comedy, [title({ genres: ['Horror'] })])).toBeNull();
    expect(collectionRow(comedy, [title(), title()])?.titles).toHaveLength(1);
    expect(collectionRow(comedy, Array.from({ length: 20 }, (_, index) => title({ id: String(index) })))?.titles).toHaveLength(12);
  });

  it('serializes complete collection filters and validates URL metadata dimensions', () => {
    const href = discoveryHref({ type: 'movie', originalLanguage: 'ta|te|ml|kn', country: 'IN', sort: 'score' }, '/movies');
    const query = new URL(href, 'https://example.test').searchParams;
    expect(query.get('originalLanguage')).toBe('ta|te|ml|kn');
    expect(query.get('sort')).toBe('score');
    expect(parseDiscoveryFilters({ originalLanguage: ['HI', 'ko'], country: 'in' })).toEqual({ originalLanguage: 'hi', country: 'IN' });
    expect(parseDiscoveryFilters({ originalLanguage: 'hi|ta|hi', country: 'India' })).toEqual({ originalLanguage: 'hi|ta' });
    expect(parseDiscoveryFilters({ originalLanguage: 'hi,ta', country: '<script>' })).toEqual({});
  });

  it('loads collections with four bounded workers, not serial waterfalls', async () => {
    let active = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return [title()];
    });
    const rows = await loadDiscoveryRows(read);
    expect(peak).toBe(4);
    expect(read).toHaveBeenCalledTimes(DISCOVERY_SHELVES.length);
    expect(read.mock.calls.every((call) => (call as unknown as [{ limit: number }])[0].limit === 12)).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(['newest', 'top-rated', 'movies', 'genre-comedy']);
  });

  it('returns on the overall budget and does not launch categories after it', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<Title[]>(() => {}));
    const loading = loadDiscoveryRows(read, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await loading).toEqual([]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('isolates optional shelf failures without publishing empty rows', async () => {
    const read = vi.fn(async (filters: DiscoveryFilters) => {
      if (filters.genre === 'Comedy') throw new Error('Fixture read failed');
      return [title()];
    });
    const rows = await loadDiscoveryRows(read);
    expect(rows.map((row) => row.id)).toEqual(['newest', 'top-rated', 'movies']);
    expect(rows.every((row) => row.titles.length > 0)).toBe(true);
  });
});
