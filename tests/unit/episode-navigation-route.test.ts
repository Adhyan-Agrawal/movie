import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  features: { tmdbConfigured: true, supabaseConfigured: false },
  show: vi.fn(),
  season: vi.fn(),
  auth: vi.fn(),
  service: vi.fn(),
  cookies: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/features/catalog/tmdb-catalog', () => ({ getTmdbShowMetadata: mocks.show, getTmdbSeasonMetadata: mocks.season }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.auth }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));

import * as route from '@/app/api/episode-navigation/route';
import { clearEpisodeNavigationCache } from '@/features/player/episode-navigation-cache';

const nulls = { previous: null, next: null };
const summary = (seasonNumber: number) => ({ id: 100 + seasonNumber, season_number: seasonNumber, episode_count: 99, air_date: '2026-01-01' });
const show = (seasons = [0, 1, 2]) => ({ id: 1399, name: 'Verified Series', seasons: seasons.map(summary) });
const episode = (seasonNumber: number, episodeNumber: number, airDate: string | null = '2026-01-01') => ({
  id: 1000 + seasonNumber * 100 + episodeNumber,
  season_number: seasonNumber,
  episode_number: episodeNumber,
  name: `Real episode ${seasonNumber}/${episodeNumber}`,
  air_date: airDate,
});
const season = (seasonNumber: number, episodes: unknown[] = [episode(seasonNumber, 1), episode(seasonNumber, 2)]) => ({
  id: 100 + seasonNumber, season_number: seasonNumber, episodes,
});
const target = (seasonNumber: number, episodeNumber: number) => ({
  seasonNumber, episodeNumber, name: `Real episode ${seasonNumber}/${episodeNumber}`,
  href: `/watch/tv/verified-series-1399?season=${seasonNumber}&episode=${episodeNumber}`,
});
const request = (seasonNumber = 1, episodeNumber = 1, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(
  `https://app.example/api/episode-navigation?type=tv&tmdbId=1399&season=${seasonNumber}&episode=${episodeNumber}`, init,
);
const body = async (seasonNumber = 1, episodeNumber = 1) => (await route.GET(request(seasonNumber, episodeNumber))).json();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  vi.resetAllMocks();
  clearEpisodeNavigationCache();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.features.tmdbConfigured = true;
  mocks.features.supabaseConfigured = false;
  mocks.show.mockResolvedValue(show());
  mocks.season.mockImplementation(async (_tmdbId: string, seasonNumber: number) => season(seasonNumber));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('GET /api/episode-navigation', () => {
  it('returns a first-episode boundary without mixing regular episodes with specials', async () => {
    const response = await route.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, must-revalidate');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.json()).toEqual({ previous: null, next: target(1, 2) });
    expect(mocks.show).toHaveBeenCalledWith('1399');
    expect(mocks.season).toHaveBeenCalledTimes(1);
    expect(mocks.season).toHaveBeenCalledWith('1399', 1);
  });

  it('returns the last episode with no fabricated next episode', async () => {
    expect(await body(2, 2)).toEqual({ previous: target(2, 1), next: null });
    expect(mocks.season).toHaveBeenCalledTimes(1);
  });

  it('crosses both regular-season boundaries using fetched episode metadata, not counts', async () => {
    mocks.show.mockResolvedValue(show([2, 0, 1, 3]));
    mocks.season.mockImplementation(async (_tmdbId: string, number: number) => season(number,
      number === 2 ? [episode(2, 7)] : [episode(number, 2), episode(number, 9)],
    ));
    expect(await body(2, 7)).toEqual({ previous: target(1, 9), next: target(3, 2) });
    expect(mocks.season.mock.calls.map((call) => call[1]).sort()).toEqual([1, 2, 3]);
  });

  it('uses actual episode numbers across missing gaps and ignores provider ordering', async () => {
    mocks.show.mockResolvedValue(show([1]));
    mocks.season.mockResolvedValue(season(1, [episode(1, 9), episode(1, 1), episode(1, 4)]));
    expect(await body(1, 4)).toEqual({ previous: target(1, 1), next: target(1, 9) });
  });

  it('uses listed regular seasons even when a numeric season is absent', async () => {
    mocks.show.mockResolvedValue(show([1, 3]));
    expect(await body(1, 2)).toEqual({ previous: target(1, 1), next: target(3, 1) });
    expect(mocks.season.mock.calls.map((call) => call[1])).toEqual([1, 3]);
  });

  it('evaluates individual air dates, not the season date, count, or first-air-date', async () => {
    mocks.show.mockResolvedValue({ ...show([1]), first_air_date: '2020-01-01' });
    mocks.season.mockResolvedValue({ ...season(1, [
      episode(1, 1, '2026-11-01'), episode(1, 2, '2026-11-03'),
      episode(1, 3, '2026-11-04'), episode(1, 4, null),
      episode(1, 5, '2026-02-30'), episode(1, 6, '2026-11-02'),
    ]), air_date: '2020-01-01', episode_count: 999 });
    expect(await body(1, 2)).toEqual({ previous: target(1, 1), next: target(1, 6) });
  });

  it('never emits unavailable placeholder episodes or invents their labels', async () => {
    mocks.show.mockResolvedValue(show([1]));
    mocks.season.mockResolvedValue(season(1, [episode(1, 1),
      { ...episode(1, 2), name: null }, { ...episode(1, 3), name: '' },
      { ...episode(1, 4), id: 0 }, { ...episode(1, 5), season_number: 2 },
      { ...episode(1, 6), episode_number: 1000 }, episode(1, 8),
    ]));
    expect(await body()).toEqual({ previous: null, next: target(1, 8) });
  });

  it('advances specials only inside season zero and never fetches regular seasons', async () => {
    mocks.season.mockResolvedValue(season(0, [episode(0, 1), episode(0, 3)]));
    expect(await body(0, 1)).toEqual({ previous: null, next: target(0, 3) });
    expect(await body(0, 3)).toEqual({ previous: target(0, 1), next: null });
    expect(mocks.season.mock.calls.every((call) => call[1] === 0)).toBe(true);
  });

  it.each([null, [], {}, { ...show(), id: 9 }, { ...show(), name: '' }, { ...show(), name: 'x'.repeat(201) },
    { ...show(), seasons: null }, { ...show(), seasons: [summary(1), summary(1)] },
  ])('fails closed when the exact show metadata is absent or malformed %j', async (metadata) => {
    mocks.show.mockResolvedValue(metadata);
    expect(await body()).toEqual(nulls);
    expect(mocks.season).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { ...season(1), season_number: 2 }, { ...season(1), id: 109 },
    { ...season(1), episodes: {} }, { ...season(1), episodes: [episode(1, 1), episode(1, 1)] },
  ])('fails closed when exact season metadata is absent, mismatched, or ambiguous %j', async (metadata) => {
    mocks.season.mockResolvedValue(metadata);
    expect(await body()).toEqual(nulls);
  });

  it('returns nulls for an unverified, future, or invalid current episode', async () => {
    expect(await body(1, 8)).toEqual(nulls);
    mocks.season.mockResolvedValue(season(1, [episode(1, 1, '2026-11-04'), episode(1, 2)]));
    expect(await body()).toEqual(nulls);
    mocks.season.mockResolvedValue(season(1, [{ ...episode(1, 1), id: 0 }, episode(1, 2)]));
    expect(await body()).toEqual(nulls);
  });

  it('keeps a verified same-season neighbor when a cross-season lookup fails', async () => {
    mocks.season.mockImplementation(async (_tmdbId: string, number: number) => {
      if (number === 2) throw new Error('PRIVATE provider outage');
      return season(number);
    });
    const response = await route.GET(request(1, 2));
    expect(await response.json()).toEqual({ previous: target(1, 1), next: null });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await body(1, 2);
    expect(mocks.show).toHaveBeenCalledTimes(2);
  });

  it('returns nulls for an unknown or unavailable adjacent season without skipping across it', async () => {
    mocks.show.mockResolvedValue(show([1, 2, 3]));
    mocks.season.mockImplementation(async (_tmdbId: string, number: number) => number === 2 ? null : season(number));
    expect(await body(1, 2)).toEqual({ previous: target(1, 1), next: null });
    expect(mocks.season.mock.calls.map((call) => call[1])).toEqual([1, 2]);
  });

  it('returns only safe nulls for lookup errors and never leaks diagnostics', async () => {
    mocks.show.mockRejectedValue(new Error('PRIVATE-token secret upstream URL'));
    const response = await route.GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(nulls);
  });

  it('eliminates repeated validated navigation reads until the 300s source TTL, including back navigation', async () => {
    const first = await body(1, 1);
    await body(1, 2);
    const reads = { show: mocks.show.mock.calls.length, season: mocks.season.mock.calls.length };
    expect(await body(1, 1)).toEqual(first);
    expect(await body(1, 1)).toEqual(first);
    expect(mocks.show).toHaveBeenCalledTimes(reads.show);
    expect(mocks.season).toHaveBeenCalledTimes(reads.season);
    await vi.advanceTimersByTimeAsync(250_000);
    const cached = await route.GET(request());
    expect(cached.headers.get('cache-control')).toBe('public, max-age=50, s-maxage=50, must-revalidate');
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await body()).toEqual(first);
    expect(mocks.show).toHaveBeenCalledTimes(reads.show + 1);
    expect(mocks.season).toHaveBeenCalledTimes(reads.season + 1);
  });

  it('does not negative-cache malformed, missing, or failed metadata and recovers immediately', async () => {
    mocks.show.mockRejectedValueOnce(new Error('Unknown network state')).mockResolvedValueOnce({ ...show(), id: 1 });
    for (let index = 0; index < 2; index++) {
      const response = await route.GET(request());
      expect(await response.json()).toEqual(nulls);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(await body()).toEqual({ previous: null, next: target(1, 2) });
    expect(mocks.show).toHaveBeenCalledTimes(3);
  });

  it('does not publish a cached boundary when verification crosses UTC midnight', async () => {
    vi.setSystemTime(new Date('2026-11-03T23:59:59Z'));
    mocks.show.mockResolvedValue(show([1]));
    const metadata = season(1, [episode(1, 1), episode(1, 2), episode(1, 3, '2026-11-04')]);
    let finish!: (value: typeof metadata) => void;
    mocks.season.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(metadata);
    const pending = route.GET(request(1, 2));
    await vi.advanceTimersByTimeAsync(2000);
    finish(metadata);
    const response = await pending;
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await body(1, 2)).toEqual({ previous: target(1, 1), next: target(1, 3) });
    expect(mocks.show).toHaveBeenCalledTimes(2);
  });

  it('caches only the strict public DTO regardless of viewer cookies, without reading identity or media', async () => {
    const response = await route.GET(request(1, 1, { headers: { cookie: 'account=private-a', authorization: 'Bearer private-a' } }));
    const result = await response.json();
    expect(await (await route.GET(request(1, 1, { headers: { cookie: 'account=private-b' } }))).json()).toEqual(result);
    expect(result).toEqual({ previous: null, next: target(1, 2) });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(mocks.show).toHaveBeenCalledOnce();
    for (const spy of [mocks.auth, mocks.service, mocks.cookies, mocks.fetch]) expect(spy).not.toHaveBeenCalled();
  });

  it('does not share pending request-owned promises or cache an abandoned late result', async () => {
    let finish!: (value: ReturnType<typeof show>) => void;
    mocks.show.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const abandoned = route.GET(request(1, 1, { signal: controller.signal }));
    const live = await body();
    controller.abort();
    expect(await (await abandoned).json()).toEqual(nulls);
    finish({ ...show(), name: 'Obsolete show' });
    await Promise.resolve();
    expect(await body()).toEqual(live);
    expect(mocks.show).toHaveBeenCalledTimes(2);
  });

  it('applies a bounded total deadline even if an existing guarded read never settles', async () => {
    mocks.show.mockImplementation(() => new Promise(() => {}));
    const pending = route.GET(request());
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await (await pending).json()).toEqual(nulls);
    expect(mocks.season).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a caller without canceling shared metadata or starting obsolete season reads', async () => {
    let finishShow!: (value: ReturnType<typeof show>) => void;
    mocks.show.mockImplementation(() => new Promise((resolve) => { finishShow = resolve; }));
    const controller = new AbortController();
    const pending = route.GET(request(1, 1, { signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    expect(await (await pending).json()).toEqual(nulls);
    finishShow(show());
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.season).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does no metadata, auth, Supabase, or direct fetch work when unconfigured or already canceled', async () => {
    mocks.features.tmdbConfigured = false;
    expect(await body()).toEqual(nulls);
    mocks.features.tmdbConfigured = true;
    const controller = new AbortController();
    controller.abort();
    expect(await (await route.GET(request(1, 1, { signal: controller.signal }))).json()).toEqual(nulls);
    for (const spy of [mocks.show, mocks.season, mocks.auth, mocks.service, mocks.cookies, mocks.fetch]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('exposes GET only and rejects missing, movie, duplicate, invalid, or arbitrary input before reads', async () => {
    expect((route as Record<string, unknown>).POST).toBeUndefined();
    for (const query of [
      '', 'type=movie&tmdbId=1399&season=1&episode=1', 'type=tv&season=1&episode=1',
      'type=tv&tmdbId=1399&season=1000&episode=1', 'type=tv&tmdbId=1399&season=1&episode=0',
      'type=tv&tmdbId=1399&season=1e0&episode=1', 'type=tv&tmdbId=1399&season=1&episode=1&season=2',
      'type=tv&tmdbId=1399&season=1&episode=1&url=https://private.example',
    ]) {
      const response = await route.GET(new NextRequest(`https://app.example/api/episode-navigation?${query}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(nulls);
    }
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.season).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
