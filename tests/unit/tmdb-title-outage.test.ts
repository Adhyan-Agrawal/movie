import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ serverEnv: () => ({ TMDB_API_BASE_URL: 'https://tmdb.fixture/3', TMDB_API_KEY: 'synthetic-test-only' }) }));
import { clearTmdbPublicDataCache, getTmdbTitle } from '@/features/catalog/tmdb-catalog';

const fetchMock = vi.fn<typeof fetch>();
const movie = { id: 1, title: 'Known film', overview: 'Known synopsis.', release_date: null, genres: [] };

beforeEach(() => {
  clearTmdbPublicDataCache();
  fetchMock.mockReset().mockImplementation(async () => Response.json(movie));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { clearTmdbPublicDataCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('TMDB title payload boundaries', () => {
  it('preserves a known title with a nullable synopsis without inventing details', async () => {
    fetchMock.mockImplementation(async () => Response.json({ ...movie, overview: null, runtime: null, vote_average: null }));
    expect(await getTmdbTitle('movie', 'known-film-1')).toMatchObject({ name: 'Known film', synopsis: '', genres: [] });
    expect(await getTmdbTitle('movie', 'known-film-1')).not.toHaveProperty('runtimeMinutes');
    expect(await getTmdbTitle('movie', 'known-film-1')).not.toHaveProperty('score');
  });

  it('skips malformed nullable optional rows and preserves real genres and country data', async () => {
    fetchMock.mockImplementation(async () => Response.json({
      ...movie, genres: [null, { id: 18, name: 'Drama' }, { id: 99, name: null }],
      production_countries: [null, { iso_3166_1: 'IN' }],
      credits: { cast: [null] }, videos: { results: [null] }, release_dates: { results: [null] },
    }));
    expect(await getTmdbTitle('movie', 'known-film-1')).toMatchObject({ genres: ['Drama'], originCountries: ['IN'] });
  });

  it.each([null, {}, { success: false, status_code: 7 }, { ...movie, id: 2 }, { ...movie, title: 7 }])(
    'rejects an invalid or error payload instead of caching it as empty/not-found: %j', async (payload) => {
      fetchMock.mockImplementationOnce(async () => Response.json(payload));
      await expect(getTmdbTitle('movie', 'known-film-1')).rejects.toThrow(/TMDB/);
      await expect(getTmdbTitle('movie', 'known-film-1')).resolves.toMatchObject({ name: 'Known film' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('distinguishes a provider-confirmed missing title from a temporary error', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ success: false, status_code: 34 }, { status: 404 }));
    await expect(getTmdbTitle('movie', 'known-film-1')).resolves.toBeNull();
    await expect(getTmdbTitle('movie', 'known-film-1')).resolves.toMatchObject({ name: 'Known film' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the main-owned 6-second TMDB deadline and Workers-compatible manual redirect mode', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await getTmdbTitle('movie', 'known-film-1');
    expect(timeout).toHaveBeenCalledWith(6_000);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  });
});
