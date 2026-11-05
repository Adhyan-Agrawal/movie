import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ serverEnv: () => ({ TMDB_API_BASE_URL: 'https://api.themoviedb.org/3', TMDB_API_KEY: 'unit-test-only' }) }));
import { clearTmdbPublicDataCache, getTmdbTitle, listTmdbTitles, tmdbCast } from '@/features/catalog/tmdb-catalog';

const fixture = (id: number, language: string | undefined = 'hi') => ({ id, title: `Fixture ${id}`, name: `Fixture ${id}`, original_title: `Original ${id}`, original_language: language, overview: '', release_date: '2024-01-01', first_air_date: '2024-01-01', genre_ids: [35], vote_average: 8 });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  clearTmdbPublicDataCache();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/genre/')) return Response.json({ genres: [{ id: 35, name: 'Comedy' }, { id: 27, name: 'Horror' }, { id: 28, name: url.pathname.includes('/tv/') ? 'Action & Adventure' : 'Action' }] });
    return Response.json({ results: [fixture(1)], total_results: 1 });
  });
});
afterEach(() => { clearTmdbPublicDataCache(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('TMDB discovery filters and metadata', () => {
  it('maps actual language/original name but leaves missing country unknown', async () => {
    const result = await listTmdbTitles({ type: 'movie', originalLanguage: 'hi' });
    expect(result.titles[0]).toMatchObject({ originalLanguage: 'hi', originalName: 'Original 1' });
    expect(result.titles[0]).not.toHaveProperty('originCountries');
    const url = new URL(String(fetchMock.mock.calls.find(([url]) => String(url).includes('/discover/'))![0]));
    expect(url.searchParams.get('with_original_language')).toBe('hi');
    expect(url.searchParams.has('with_origin_country')).toBe(false);
  });

  it('maps reported countries and never falls back to English when unknown', async () => {
    fetchMock.mockImplementation(async (input) => String(input).includes('/genre/') ? Response.json({ genres: [] }) : Response.json({ results: [{ ...fixture(1, undefined), original_language: null, origin_country: ['KR'] }], total_results: 1 }));
    const result = await listTmdbTitles({ type: 'tv', country: 'kr' });
    expect(result.titles[0]?.originCountries).toEqual(['KR']);
    expect(result.titles[0]).not.toHaveProperty('originalLanguage');
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/discover/'))!;
    expect(new URL(String(call[0])).searchParams.get('with_origin_country')).toBe('KR');
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(call[1]).toMatchObject({ credentials: 'omit', redirect: 'manual', next: { revalidate: 3600 } });
    expect(call[1]?.next?.tags).toEqual(['tmdb-public', 'tmdb:discover:tv']);
  });

  it('queries each South Indian language separately, not an invalid TMDB pipe value', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/genre/')) return Response.json({ genres: [] });
      const language = url.searchParams.get('with_original_language')!;
      return Response.json({ results: [fixture(['ta', 'te', 'ml', 'kn'].indexOf(language) + 1, language)], total_results: 1 });
    });
    const result = await listTmdbTitles({ type: 'movie', originalLanguage: 'ta|te|ml|kn' });
    expect(result.titles.map((title) => title.originalLanguage)).toEqual(['ta', 'te', 'ml', 'kn']);
    expect(result.total).toBe(4);
  });

  it('does not silently drop an unavailable genre and return unrelated titles', async () => {
    const result = await listTmdbTitles({ type: 'tv', genre: 'Horror' });
    // This fixture advertises Horror; use a genuinely unknown genre for the guard.
    expect((await listTmdbTitles({ type: 'tv', genre: 'Not a genre' })).titles).toEqual([]);
    expect(result.total).toBe(1);
  });

  it('rejects invalid language/country filters without issuing reads', async () => {
    expect(await listTmdbTitles({ originalLanguage: 'hi,ta' })).toEqual({ titles: [], total: 0 });
    expect(await listTmdbTitles({ country: 'India' })).toEqual({ titles: [], total: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not pretend TV discover supports certification filters', async () => {
    expect(await listTmdbTitles({ type: 'tv', maturity: 'TV-14' })).toEqual({ titles: [], total: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    await listTmdbTitles({ type: 'movie', maturity: 'R' });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/discover/'))!;
    const url = new URL(String(call[0]));
    expect(url.searchParams.get('certification_country')).toBe('US');
    expect(url.searchParams.get('certification')).toBe('R');
  });

  it('coalesces duplicate in-flight public requests and bounds fetch concurrency', async () => {
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (input) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      const url = new URL(String(input));
      return url.pathname.includes('/genre/') ? Response.json({ genres: [] }) : Response.json({ results: [fixture(1, url.searchParams.get('with_original_language') ?? 'hi')], total_results: 1 });
    });
    await Promise.all([listTmdbTitles({ type: 'movie', originalLanguage: 'ta|te|ml|kn|hi|ko|ja|fr' }), listTmdbTitles({ type: 'movie', originalLanguage: 'ta|te|ml|kn|hi|ko|ja|fr' })]);
    expect(peak).toBeLessThanOrEqual(6);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/genre/'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/discover/'))).toHaveLength(8);
  });

  it('releases failed public reads rather than caching errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Fixture network failure'));
    await expect(listTmdbTitles({ type: 'movie' })).rejects.toThrow('Fixture network failure');
    expect((await listTmdbTitles({ type: 'movie' })).titles).toHaveLength(1);
  });

  it('reuses settled public reads until expiry, cutting six identical listings from 12 fetches to 2', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 6; i++) await listTmdbTitles({ type: 'movie', originalLanguage: 'hi' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/genre/'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/discover/'))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_600_000);
    await listTmdbTitles({ type: 'movie', originalLanguage: 'hi' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/genre/'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/discover/'))).toHaveLength(2);
  });

  it('expires valid empty discovery results on the shorter negative TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fetchMock.mockImplementation(async (input) => String(input).includes('/genre/')
      ? Response.json({ genres: [{ id: 35, name: 'Comedy' }] })
      : Response.json({ results: [], total_results: 0 }));

    await listTmdbTitles({ type: 'movie' });
    await vi.advanceTimersByTimeAsync(299_999);
    await listTmdbTitles({ type: 'movie' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/trending/'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await listTmdbTitles({ type: 'movie' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/trending/'))).toHaveLength(2);
  });

  it('passes genre aliases, top-rated vote floor and a released-only upper date', async () => {
    await listTmdbTitles({ type: 'tv', genre: 'Action', sort: 'score' });
    const url = new URL(String(fetchMock.mock.calls.find(([url]) => String(url).includes('/discover/'))![0]));
    expect(url.searchParams.get('with_genres')).toBe('28');
    expect(url.searchParams.get('sort_by')).toBe('vote_average.desc');
    expect(url.searchParams.get('vote_count.gte')).toBe('100');
    expect(url.searchParams.get('first_air_date.lte')).toBe(new Date().toISOString().slice(0, 10));
  });

  it('uses the public trending endpoint for unfiltered trending rows', async () => {
    await listTmdbTitles({ type: 'movie', sort: 'trending' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/trending/movie/week'))).toBe(true);
  });

  it('returns correct 12-card pages across TMDB 20-card boundaries', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/genre/')) return Response.json({ genres: [] });
      const page = Number(url.searchParams.get('page'));
      return Response.json({ results: Array.from({ length: 20 }, (_, index) => fixture((page - 1) * 20 + index + 1)), total_results: 100 });
    });
    const first = await listTmdbTitles({ type: 'movie' }, 1, 12);
    const second = await listTmdbTitles({ type: 'movie' }, 2, 12);
    expect(first.titles.map((title) => title.tmdbId)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
    expect(second.titles.map((title) => title.tmdbId)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 13)));
  });

  it('continues pagination after a mixed provider group is exhausted', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/genre/')) return Response.json({ genres: [] });
      const movie = url.pathname.includes('/movie/');
      const page = Number(url.searchParams.get('page'));
      return Response.json({ results: movie ? [fixture(1)] : Array.from({ length: 20 }, (_, index) => fixture((page - 1) * 20 + index + 1)), total_results: movie ? 1 : 100 });
    });
    const result = await listTmdbTitles({}, 2, 12);
    expect(result.titles).toHaveLength(12);
    expect(result.titles.every((title) => title.type === 'tv')).toBe(true);
    expect(result.titles[0]?.tmdbId).toBe('12');
  });

  it('maps detail production-country metadata without using normalizer defaults', async () => {
    fetchMock.mockImplementation(async () => Response.json({ id: 1, title: 'Fixture', original_title: 'Fixture', overview: 'A unit-test film.', release_date: '2024-01-01', runtime: 90, poster_path: '/fixture.jpg', backdrop_path: '/fixture-backdrop.jpg', original_language: null, genres: [], production_countries: [{ iso_3166_1: 'IN' }], release_dates: { results: [] } }));
    expect(await getTmdbTitle('movie', 'fixture-1')).toMatchObject({ originCountries: ['IN'] });
    expect(await getTmdbTitle('movie', 'fixture-1')).not.toHaveProperty('originalLanguage');
  });

  it('shares one appended title detail fetch with cast instead of calling a second credits endpoint', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== '/3/movie/1') throw new Error(`Unexpected TMDB path ${url.pathname}`);
      return Response.json({
        id: 1, imdb_id: null, title: 'Fixture', original_title: 'Fixture', overview: 'A unit-test film.',
        release_date: '2024-01-01', runtime: 90, poster_path: '/fixture.jpg', backdrop_path: '/fixture-backdrop.jpg',
        original_language: 'en', vote_average: 8, genres: [], release_dates: { results: [] },
        credits: { cast: [{ id: 7, name: 'Actor', character: 'Lead', known_for_department: 'Acting', profile_path: '/actor.jpg', order: 0 }] },
      });
    });
    const title = { id: 'tmdb:movie:1', type: 'movie' as const, slug: 'fixture-1', name: 'Fixture', synopsis: '', releaseYear: 2024, maturity: 'PG-13' as const, genres: [], tmdbId: '1' };
    const [detail, cast] = await Promise.all([getTmdbTitle('movie', 'fixture-1'), tmdbCast(title)]);
    expect(detail?.tmdbId).toBe('1');
    expect(cast[0]).toMatchObject({ personId: 'tmdb:person:7', profileUrl: 'https://image.tmdb.org/t/p/w185/actor.jpg' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/credits');
  });
});
