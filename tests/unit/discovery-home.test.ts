import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Title } from '@/features/catalog/types';

const mocks = vi.hoisted(() => ({ features: { tmdbConfigured: true, supabaseConfigured: false }, listTitles: vi.fn() }));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/features/catalog/queries', () => ({ listTitles: mocks.listTitles }));
import { getHomeData } from '@/features/catalog/data';
import { matchesDiscovery } from '@/features/catalog/discovery';

const fixtures: Title[] = [
  { id: 'movie-1', type: 'movie', slug: 'fixture-1', name: 'Fixture Hindi', synopsis: '', releaseYear: 2024, maturity: 'PG', genres: ['Comedy', 'Horror'], originalLanguage: 'hi', backdropUrl: 'https://image.tmdb.org/t/p/w1280/fixture.jpg' },
  { id: 'tv-2', type: 'tv', slug: 'fixture-2', name: 'Fixture Korean', synopsis: '', releaseYear: 2023, maturity: 'TV-14', genres: ['Drama'], originalLanguage: 'ko', backdropUrl: 'https://image.tmdb.org/t/p/w1280/fixture2.jpg' },
];

beforeEach(() => {
  mocks.features.tmdbConfigured = true;
  mocks.features.supabaseConfigured = false;
  mocks.listTitles.mockReset().mockImplementation(async (filters) => fixtures.filter((title) => matchesDiscovery(title, filters)));
});
afterEach(() => vi.restoreAllMocks());

describe('public home discovery payload', () => {
  it('works with TMDB configured and Supabase absent', async () => {
    const home = await getHomeData();
    expect(home.hero).not.toBeNull();
    expect(home.degraded).toBe(false);
    expect(home.signedIn).toBe(false);
    expect(home.continueWatching).toEqual([]);
    expect(home.forYou).toBeNull();
    expect(home.rows.map((row) => row.id)).toEqual(expect.arrayContaining(['trending', 'newest', 'top-rated', 'genre-horror', 'genre-comedy', 'hindi-cinema', 'korean']));
    expect(home.rows.every((row) => row.titles.length > 0)).toBe(true);
    expect(home.collections?.map((item) => item.id)).toContain('hindi-cinema');
    expect(home.collections?.map((item) => item.id)).not.toContain('japanese');
    expect(home.rows.every((row) => row.href && row.filters)).toBe(true);
    expect(home.rows.every((row) => row.collectionId === row.id)).toBe(true);
    expect(home.collections?.every((collection) => home.rows.some((row) => row.collectionId === collection.id && row.href === collection.href))).toBe(true);
  });

  it('uses available real shelves when trending fails, never fabricates a hero', async () => {
    mocks.listTitles.mockImplementation(async (filters) => !filters.genre && !filters.originalLanguage ? [] : fixtures.filter((title) => matchesDiscovery(title, filters)));
    const home = await getHomeData();
    expect(fixtures.map((title) => title.id)).toContain(home.hero?.id);
    expect(home.rows.some((row) => row.id === 'trending')).toBe(false);
    expect(new Set(home.heroTitles.map((title) => title.id)).size).toBe(home.heroTitles.length);
  });

  it('returns a fully empty honest catalog if no source exists', async () => {
    mocks.features.tmdbConfigured = false;
    const home = await getHomeData();
    expect(home.hero).toBeNull();
    expect(home.rows).toEqual([]);
    expect(home.collections).toEqual([]);
    expect(home.degraded).toBe(true);
    expect(mocks.listTitles).not.toHaveBeenCalled();
  });

  it('does not replace a configured but empty catalog with sample content', async () => {
    mocks.listTitles.mockResolvedValue([]);
    expect(await getHomeData()).toMatchObject({ hero: null, heroTitles: [], rows: [], collections: [], degraded: false });
  });
});
