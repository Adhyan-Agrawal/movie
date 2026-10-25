import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Title } from '@/features/catalog/types';

const mocks = await vi.hoisted(async () => {
  const { default: Module } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const require = Module.createRequire(import.meta.url);
  // Use real server React.cache with a fresh dispatcher per simulated request.
  const react = require(join(dirname(require.resolve('react/package.json')), 'react.react-server.js')) as {
    cache: typeof import('react').cache;
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      A: { getCacheForType: (factory: () => unknown) => unknown } | null;
    };
  };
  return {
    react,
    features: { supabaseConfigured: true, tmdbConfigured: false },
    title: vi.fn(), seasons: vi.fn(), cast: vi.fn(),
    tmdbTitle: vi.fn(), tmdbSeasons: vi.fn(), tmdbCast: vi.fn(), tmdbList: vi.fn(),
    readConfig: vi.fn(),
    resolve: vi.fn(),
  };
});

vi.mock('react', () => ({ cache: mocks.react.cache }));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/features/catalog/repository', () => ({
  repoGetTitleBySlug: mocks.title,
  repoGetTitleById: mocks.title,
  repoListSeasonsForTitle: mocks.seasons,
  repoListCastForTitle: mocks.cast,
}));
vi.mock('@/features/catalog/tmdb-catalog', () => ({
  getTmdbTitle: mocks.tmdbTitle,
  tmdbSeasons: mocks.tmdbSeasons,
  tmdbCast: mocks.tmdbCast,
  listTmdbTitles: mocks.tmdbList,
  searchTmdbTitles: vi.fn(),
  listTmdbGenres: vi.fn(),
}));
vi.mock('@/lib/supabase/service', () => ({
  getSupabaseServiceClient: () => ({
    from: () => ({ select: () => ({ abortSignal: mocks.readConfig }) }),
  }),
}));
vi.mock('@/lib/providers/vidnest', () => ({
  createVidnestAdapter: (config: { id: string }) => ({
    resolve: (request: unknown) => mocks.resolve(config.id, request),
    normalizeError: () => ({ code: 'provider-error', recoverable: true }),
  }),
}));
vi.mock('@/lib/providers/vidsrc', () => ({
  createVidsrcAdapter: (config: { id: string }) => ({
    resolve: (request: unknown) => mocks.resolve(config.id, request),
    normalizeError: () => ({ code: 'provider-error', recoverable: true }),
  }),
}));

function newRequest() {
  const roots = new Map<() => unknown, unknown>();
  mocks.react.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = {
    getCacheForType(factory) {
      if (!roots.has(factory)) roots.set(factory, factory());
      return roots.get(factory);
    },
  };
}

const title: Title = {
  id: 'fixture-title', type: 'tv', slug: 'fixture-1', name: 'Fixture',
  synopsis: 'Existing catalog data', releaseYear: 2020, maturity: 'TV-14', genres: [],
};
const request = { titleId: 'fixture-title', type: 'movie' as const, tmdbId: '1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  newRequest();
  mocks.features.supabaseConfigured = true;
  mocks.features.tmdbConfigured = false;
  mocks.title.mockResolvedValue(title);
  mocks.seasons.mockResolvedValue([{ id: 'season-1', episodeCount: 12, episodes: [] }]);
  mocks.cast.mockResolvedValue([]);
  mocks.readConfig.mockResolvedValue({ data: [], error: null });
  mocks.resolve.mockImplementation((id: string) => Promise.resolve([{ id, providerId: id, url: `/fixture/${id}` }]));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mocks.react.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('request-scoped catalog reads', () => {
  it('shares one in-flight title read between metadata and rendering', async () => {
    const { getTitleBySlug } = await import('@/features/catalog/queries');
    const metadata = getTitleBySlug('tv', 'fixture-1');
    const render = getTitleBySlug('tv', 'fixture-1');
    expect(metadata).toBe(render);
    await expect(render).resolves.toBe(title);
    expect(mocks.title).toHaveBeenCalledTimes(1);
  });

  it('deduplicates title IDs and seasons without dropping imported counts', async () => {
    const { getTitleById, listSeasonsForTitle } = await import('@/features/catalog/queries');
    await Promise.all([getTitleById(title.id), getTitleById(title.id)]);
    const [first, second] = await Promise.all([listSeasonsForTitle(title.id), listSeasonsForTitle(title.id)]);
    expect(mocks.title).toHaveBeenCalledTimes(1);
    expect(mocks.seasons).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first[0]?.episodeCount).toBe(12);
  });

  it('never reuses RLS catalog results across requests or different routes', async () => {
    const { getTitleBySlug } = await import('@/features/catalog/queries');
    await getTitleBySlug('tv', 'fixture-1');
    await getTitleBySlug('movie', 'fixture-1');
    newRequest();
    mocks.title.mockResolvedValue(null);
    await expect(getTitleBySlug('tv', 'fixture-1')).resolves.toBeNull();
    expect(mocks.title).toHaveBeenCalledTimes(3);
  });

  it('caps optional TMDB season and cast waits at 3 seconds and preserves the title', async () => {
    mocks.features.tmdbConfigured = true;
    mocks.tmdbTitle.mockResolvedValue(title);
    mocks.tmdbSeasons.mockReturnValue(new Promise(() => {}));
    mocks.tmdbCast.mockReturnValue(new Promise(() => {}));
    await import('@/features/catalog/tmdb-catalog');
    const queries = await import('@/features/catalog/queries');
    const titleRead = queries.getTitleBySlug('tv', title.slug);
    await vi.dynamicImportSettled();
    const seasonsRead = queries.listSeasonsForTitle('tmdb:tv:1');
    await vi.dynamicImportSettled();
    const castRead = queries.listCastForTitle('tmdb:tv:1');
    await vi.dynamicImportSettled();
    const result = Promise.all([
      titleRead,
      seasonsRead,
      queries.listSeasonsForTitle('tmdb:tv:1'),
      castRead,
    ]);
    const finished = vi.fn();
    void result.then(finished);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(2999);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([title, [], [], []]);
    expect(mocks.tmdbSeasons).toHaveBeenCalledTimes(1);
    expect(mocks.tmdbCast).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled public catalog listing at 8 seconds', async () => {
    mocks.features.tmdbConfigured = true;
    mocks.tmdbList.mockReturnValue(new Promise(() => {}));
    await import('@/features/catalog/tmdb-catalog');
    const { listTitles } = await import('@/features/catalog/queries');
    const result = listTitles({ limit: 60 });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(8000);
    await expect(result).resolves.toEqual([]);
    expect(mocks.tmdbList).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('public provider config cache', () => {
  beforeEach(() => vi.resetModules());

  it('deduplicates concurrent refreshes and respects the 60-second TTL', async () => {
    const { refreshProviderRegistry } = await import('@/lib/providers/registry');
    await Promise.all(Array.from({ length: 6 }, () => refreshProviderRegistry(false)));
    await vi.advanceTimersByTimeAsync(59_999);
    await refreshProviderRegistry(false);
    expect(mocks.readConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await refreshProviderRegistry(false);
    expect(mocks.readConfig).toHaveBeenCalledTimes(2);
  });

  it('explicit admin refreshes bypass the TTL', async () => {
    const { refreshProviderRegistry } = await import('@/lib/providers/registry');
    await refreshProviderRegistry(false);
    await refreshProviderRegistry();
    expect(mocks.readConfig).toHaveBeenCalledTimes(2);
  });

  it('retains disabled-provider overrides during failure and retries after 5 seconds', async () => {
    mocks.readConfig.mockResolvedValue({ data: [{ key: 'vidnest', name: 'Direct', enabled: false }], error: null });
    const { refreshProviderRegistry, getActiveProviderConfigs } = await import('@/lib/providers/registry');
    await refreshProviderRegistry(false);
    mocks.readConfig.mockResolvedValue({ data: null, error: { message: 'fixture offline' } });
    await vi.advanceTimersByTimeAsync(60_000);
    await refreshProviderRegistry(false);
    expect(getActiveProviderConfigs().find((config) => config.id === 'vidnest')?.enabled).toBe(false);
    await refreshProviderRegistry(false);
    expect(mocks.readConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    await refreshProviderRegistry(false);
    expect(mocks.readConfig).toHaveBeenCalledTimes(3);
  });

  it('aborts a stalled configuration request at 1.5 seconds', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mocks.readConfig.mockImplementation((signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
    }));
    const { refreshProviderRegistry } = await import('@/lib/providers/registry');
    const result = refreshProviderRegistry(false);
    await vi.advanceTimersByTimeAsync(1500);
    await result;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(1500);
    expect(mocks.readConfig.mock.calls[0]?.[0].aborted).toBe(true);
  });

  it('starts providers concurrently but preserves priority and fresh per-request URLs', async () => {
    let finishDirect!: (sources: unknown[]) => void;
    mocks.resolve.mockImplementation((id: string) => id === 'vidnest'
      ? new Promise((resolve) => { finishDirect = resolve; })
      : Promise.resolve([{ id, providerId: id, url: `/fixture/${id}` }]));
    const { resolvePlayback } = await import('@/lib/providers/registry');
    const result = resolvePlayback(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.resolve).toHaveBeenCalledTimes(6);
    finishDirect([{ id: 'direct', providerId: 'vidnest', url: '/fixture/fresh-1' }]);
    const first = await result;
    expect(first.sources.map((source) => source.providerId)).toEqual(first.attempted);
    expect(first.source?.url).toBe('/fixture/fresh-1');
    mocks.resolve.mockImplementation((id: string) => Promise.resolve([{ id, providerId: id, url: '/fixture/fresh-2' }]));
    const second = await resolvePlayback(request);
    expect(second.source?.url).toBe('/fixture/fresh-2');
    expect(mocks.readConfig).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(12);
  });
});
