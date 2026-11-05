import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  features: { tmdbConfigured: true, supabaseConfigured: false },
  fetch: vi.fn(), auth: vi.fn(), service: vi.fn(), cookies: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  features: mocks.features,
  serverEnv: () => ({ TMDB_API_BASE_URL: 'https://tmdb.fixture/3', TMDB_API_KEY: 'unit-test-key' }),
}));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.auth }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));

import { clearTmdbPublicDataCache, getTmdbTitle } from '@/features/catalog/tmdb-catalog';
import { GET } from '@/app/api/episode-navigation/route';
import { parseEpisodeNavigation } from '@/features/player/episode-navigation';
import { clearEpisodeNavigationCache } from '@/features/player/episode-navigation-cache';

const origin = 'https://app.example';
const nulls = { previous: null, next: null };
const episode = (seasonNumber: number, episodeNumber: number, airDate = '2026-01-01') => ({
  id: 1000 + seasonNumber * 100 + episodeNumber,
  season_number: seasonNumber, episode_number: episodeNumber,
  name: `Known ${seasonNumber}/${episodeNumber}`, air_date: airDate,
});
const show = {
  id: 1399, name: 'Verified Series', overview: 'Known public synopsis.', genres: [],
  seasons: [0, 1, 3].map((number) => ({ id: 100 + number, season_number: number })),
  private_provider: 'must never enter the navigation DTO',
};
const season = (number: number) => ({
  id: 100 + number, season_number: number,
  episodes: [episode(number, 1), episode(number, 3)],
});
const target = (seasonNumber: number, episodeNumber: number) => ({
  seasonNumber, episodeNumber, name: `Known ${seasonNumber}/${episodeNumber}`,
  href: `/watch/tv/verified-series-1399?season=${seasonNumber}&episode=${episodeNumber}`,
});
const request = (seasonNumber = 1, episodeNumber = 1, signal?: AbortSignal) => new NextRequest(
  `${origin}/api/episode-navigation?type=tv&tmdbId=1399&season=${seasonNumber}&episode=${episodeNumber}`,
  signal ? { signal } : undefined,
);
const path = (input: string | URL | Request) => new URL(String(input)).pathname;
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.features.tmdbConfigured = true;
  clearTmdbPublicDataCache();
  clearEpisodeNavigationCache();
  mocks.fetch.mockImplementation(async (input: string | URL | Request) => {
    const number = /\/season\/(\d+)$/.exec(path(input))?.[1];
    return reply(number === undefined ? show : season(Number(number)));
  });
});
afterEach(() => {
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.service).not.toHaveBeenCalled();
  expect(mocks.cookies).not.toHaveBeenCalled();
  clearTmdbPublicDataCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('episode navigation with real guarded public TMDB reads', () => {
  it('reuses the title cache and emits the verified canonical slug, never the request alias or private metadata', async () => {
    const title = await getTmdbTitle('tv', 'old-alias-1399');
    expect(title?.slug).toBe('verified-series-1399');
    const result = await (await GET(request())).json();
    expect(result).toEqual({ previous: null, next: target(1, 3) });
    expect(parseEpisodeNavigation(result, origin)).toEqual(result);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await GET(request());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mocks.fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', next: { revalidate: 21_600 } });
      expect(new Headers(init.headers).has('cookie')).toBe(false);
      expect(new Headers(init.headers).has('authorization')).toBe(false);
    }
  });

  it('crosses only verified regular seasons and never consults specials at a regular boundary', async () => {
    expect(await (await GET(request(1, 3))).json()).toEqual({ previous: target(1, 1), next: target(3, 1) });
    expect(mocks.fetch.mock.calls.map(([input]) => path(input))).toEqual(['/3/tv/1399', '/3/tv/1399/season/1', '/3/tv/1399/season/3']);
  });

  it('keeps verified specials inside season zero, including the last-special boundary', async () => {
    expect(await (await GET(request(0, 1))).json()).toEqual({ previous: null, next: target(0, 3) });
    expect(await (await GET(request(0, 3))).json()).toEqual({ previous: target(0, 1), next: null });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('reevaluates individual future dates at UTC day boundaries even with cached metadata', async () => {
    vi.setSystemTime(new Date('2026-11-03T23:59:58Z'));
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => reply(path(input).endsWith('/season/1') ? {
      ...season(1), episodes: [episode(1, 1), episode(1, 3, '2026-11-04'), episode(1, 4, '2026-02-30')],
    } : { ...show, seasons: [{ id: 101, season_number: 1 }] }));
    expect(await (await GET(request())).json()).toEqual(nulls);
    vi.setSystemTime(new Date('2026-11-04T00:00:01Z'));
    expect(await (await GET(request())).json()).toEqual({ previous: null, next: target(1, 3) });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched season identifier even when the lower-level HTTP payload is otherwise valid', async () => {
    mocks.fetch.mockImplementation(async (input: string | URL | Request) => reply(path(input).endsWith('/season/1') ? { ...season(1), id: 999 } : show));
    expect(await (await GET(request())).json()).toEqual(nulls);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not contact public metadata or private services when TMDB is unconfigured', async () => {
    mocks.features.tmdbConfigured = false;
    expect(await (await GET(request())).json()).toEqual(nulls);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('turns real guarded-query HTTP failures into the exact safe null response', async () => {
    mocks.fetch.mockResolvedValue(new Response('private upstream failure', { status: 503 }));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(nulls);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts only the navigation waiter and does not launch a season read after a late public show response', async () => {
    let finish!: (value: Response) => void;
    mocks.fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = GET(request(1, 1, controller.signal));
    await Promise.resolve();
    await Promise.resolve();
    const upstreamSignal = mocks.fetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(upstreamSignal).toBeDefined();
    controller.abort();
    expect(await (await pending).json()).toEqual(nulls);
    expect(upstreamSignal.aborted).toBe(false);
    finish(reply(show));
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
