import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackResponse } from '../../mobile/src/lib/types';

const mock = vi.hoisted(() => ({
  getSession: vi.fn(), getUser: vi.fn(), from: vi.fn(), publicFrom: vi.fn(), fetch: vi.fn(), publicOptions: null as any,
}));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabaseConfigured: true, supabase: {
  auth: { getSession: mock.getSession, getUser: mock.getUser }, from: mock.from,
} }));
// The installed SDK's import condition resolves to ESM, not its directory's CJS main.
vi.mock('../../mobile/node_modules/@supabase/supabase-js/dist/index.mjs', () => ({ createClient: (_url: string, _key: string, options: unknown) => {
  mock.publicOptions = options; return { from: mock.publicFrom };
} }));

import { fetchEpisodeNavigation, fetchHome, fetchStreamCatalog, fetchSubtitleCatalog, getPlaybackContext, listTitles, PLAYBACK_AUTH_TIMEOUT_MS,
  PLAYBACK_CATALOG_TIMEOUT_MS, PLAYBACK_CONTEXT_TIMEOUT_MS, PLAYBACK_REQUEST_TIMEOUT_MS, reportProgress, resolvePlayback,
  resolvePlaybackDetails, sameOriginPlaybackUrl } from '../../mobile/src/lib/api';
import { parseEpisodeNavigation } from '../../mobile/src/player/episode-navigation';
const origin = new URL(process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').origin;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mock.fetch);
  mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Android bounded public playback and identity failures', () => {
  const source = { id: 'direct', label: 'Direct', kind: 'hls', consentRequired: false, url: '/api/vidnest?stream=auto' };
  it.each(['reject', 'error', 'stall'])('public streams still load when optional account refresh %s', async (failure) => {
    vi.useFakeTimers();
    if (failure === 'reject') mock.getSession.mockRejectedValue(new Error('refresh failed'));
    else if (failure === 'error') mock.getSession.mockResolvedValue({ data: { session: null }, error: new Error('unverifiable account') });
    else mock.getSession.mockReturnValue(new Promise(() => {}));
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ sources: [source],
      entitlements: { resolved: true, adFree: false, maxProfiles: 1, status: 'free' } })));
    const result = resolvePlaybackDetails({ type: 'movie', tmdbId: '123' });
    await vi.advanceTimersByTimeAsync(PLAYBACK_AUTH_TIMEOUT_MS + 1);
    expect((await result).sources[0]?.url).toBe(`${origin}${source.url}`);
    expect((await result).entitlements).toBeUndefined();
    expect(mock.fetch).toHaveBeenCalledOnce();
    expect(mock.fetch.mock.calls[0]?.[1]).toMatchObject({ headers: {}, credentials: 'omit' });
    expect(mock.from).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['network', 'body'])('bounds an uncooperative %s and aborts without an implicit retry', async (failure) => {
    vi.useFakeTimers();
    mock.fetch.mockReturnValue(failure === 'network' ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) }));
    const request = resolvePlaybackDetails({ type: 'movie', tmdbId: '123' });
    await vi.advanceTimersByTimeAsync(PLAYBACK_REQUEST_TIMEOUT_MS + PLAYBACK_AUTH_TIMEOUT_MS + 1);
    expect(await request).toEqual({ sources: [] });
    expect(mock.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.fetch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start any transport on a pre-aborted playback request', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await resolvePlaybackDetails({ type: 'movie', tmdbId: '123' }, controller.signal)).toEqual({ sources: [] });
    expect(mock.getSession).not.toHaveBeenCalled(); expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('aborts a pending bridge immediately when its screen leaves', async () => {
    mock.fetch.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const request = resolvePlaybackDetails({ type: 'movie', tmdbId: '123' }, controller.signal);
    await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledOnce());
    controller.abort(); expect(await request).toEqual({ sources: [] });
    expect(mock.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
  it.each(['session', 'user', 'profile'])('stalled %s verification stays unavailable, never guest or title-only account history', async (stage) => {
    vi.useFakeTimers();
    mock.getSession.mockResolvedValue({ data: { session: { access_token: 'fixture' } }, error: null });
    mock.getUser.mockResolvedValue({ data: { user: { id: 'account' } }, error: null });
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockReturnThis(), maybeSingle: () => new Promise(() => {}) };
    mock.from.mockReturnValue(query);
    if (stage === 'session') mock.getSession.mockReturnValue(new Promise(() => {}));
    if (stage === 'user') mock.getUser.mockReturnValue(new Promise(() => {}));
    const context = getPlaybackContext('title', 'tv', undefined, 1, 2);
    await vi.advanceTimersByTimeAsync(PLAYBACK_CONTEXT_TIMEOUT_MS + 1);
    expect(await context).toMatchObject({ viewerKey: 'unavailable', resume: null });
    expect(mock.from.mock.calls.every(([table]) => table === 'profiles')).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Android catalog schema, deadlines and verified episode contract', () => {
  const url = `${origin}/api/vidnest?metadata=1`;
  it.each(['network', 'body'])('catalog %s cannot stall settings or enter an auth refresh', async (failure) => {
    vi.useFakeTimers(); mock.getSession.mockReturnValue(new Promise(() => {}));
    mock.fetch.mockReturnValue(failure === 'network' ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) }));
    const catalog = fetchStreamCatalog(url);
    const error = expect(catalog).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(PLAYBACK_CATALOG_TIMEOUT_MS + 1); await error;
    expect(mock.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(mock.getSession).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('sanitizes nulls, duplicate IDs, non-array fields and malformed quality/track objects', async () => {
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ streams: [null, [], { id: {}, url: '/api/vidnest' },
      { id: 'good', url: '/api/vidnest?token=fixture', qualities: [null, { id: '720', label: '720p', height: -1, width: 'bad' }],
        audioTracks: 'not-an-array', subtitles: [null, { id: 'vtt', label: 'English', language: 'en', url: '/api/subtitles' }] },
      { id: 'good', url: '/api/vidnest?token=duplicate', qualities: [], audioTracks: [], subtitles: [] },
    ], recommendedStreamId: 'missing', privateAccount: { email: 'never-expose@example.invalid' } })));
    const catalog = await fetchStreamCatalog(url);
    expect(catalog.streams).toHaveLength(1);
    expect(catalog.streams[0]).toMatchObject({ id: 'good', audioTracks: [], qualities: [{ id: '720', label: '720p' }] });
    expect(catalog.streams[0]?.qualities[0]).not.toHaveProperty('height');
    expect(catalog).not.toHaveProperty('privateAccount'); expect(catalog.recommendedStreamId).toBeUndefined();
  });
  it('rejects followed foreign responses and oversized catalog body headers before parsing', async () => {
    mock.fetch.mockResolvedValue({ ok: true, url: 'https://unexpected.example/options', json: vi.fn() });
    await expect(fetchStreamCatalog(url)).rejects.toThrow();
    const json = vi.fn();
    mock.fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'content-length': String(2 * 1024 * 1024) }), json });
    await expect(fetchStreamCatalog(url)).rejects.toThrow(); expect(json).not.toHaveBeenCalled();
  });
  const next = { seasonNumber: 2, episodeNumber: 1, name: 'New season', href: '/watch/tv/show?season=2&episode=1' };
  it('accepts only the optional TV navigation URL and consumes its redacted contract without authentication', async () => {
    mock.fetch.mockImplementation(async () => new Response(JSON.stringify({ sources: [], episodeNavigationUrl: '/api/episode-navigation?type=tv&tmdbId=123&season=1&episode=10' })));
    expect((await resolvePlaybackDetails({ type: 'movie', tmdbId: '123' })).episodeNavigationUrl).toBeUndefined();
    const tv = await resolvePlaybackDetails({ type: 'tv', tmdbId: '123', season: 1, episode: 10 });
    expect(tv.episodeNavigationUrl).toBe(`${origin}/api/episode-navigation?type=tv&tmdbId=123&season=1&episode=10`);
    mock.getSession.mockClear(); mock.fetch.mockResolvedValue(new Response(JSON.stringify({ previous: null, next })));
    expect(await fetchEpisodeNavigation(tv.episodeNavigationUrl!)).toEqual({ previous: null, next });
    expect(mock.getSession).not.toHaveBeenCalled();
  });
  it.each([
    { previous: null, next: { ...next, href: 'https://evil.example/watch/tv/show?season=2&episode=1' } },
    { previous: null, next: { ...next, href: '/watch/tv/show?season=2&episode=2' } },
    { previous: null, next: { ...next, provider: 'not-a-public-field' } },
    { previous: null, next, account: 'private' },
  ])('rejects forged/foreign/unredacted episode targets rather than guessing links', (body) => {
    expect(parseEpisodeNavigation(body, origin)).toBeNull();
  });
  it('rejects foreign lookup URLs before fetch and malformed reply envelopes', async () => {
    await expect(fetchEpisodeNavigation('https://evil.example/api/episode-navigation')).rejects.toThrow();
    expect(mock.fetch).not.toHaveBeenCalled();
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ previous: [], next: null })));
    await expect(fetchEpisodeNavigation(`${origin}/api/episode-navigation`)).rejects.toThrow();
  });
});

describe('Android optional playback bridge', () => {
  it('keeps the sources-array wrapper working when all new contracts are absent', async () => {
    const source = { id: 'direct', label: 'Direct', kind: 'hls', consentRequired: false, url: '/api/vidnest?stream=auto' };
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ sources: [source] })));
    expect(await resolvePlayback({ type: 'movie', tmdbId: '123' })).toEqual([{ ...source, url: `${origin}${source.url}` }]);
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ sources: [source] })));
    const details = await resolvePlaybackDetails({ type: 'movie', tmdbId: '123' });
    expect(details.entitlements).toBeUndefined();
    expect(details.adPolicy).toBeUndefined();
  });
  it('accepts same-origin catalogs, exposes optional policy and sends bearer only to the bridge', async () => {
    mock.getSession.mockResolvedValue({ data: { session: { access_token: 'fixture-token' } }, error: null });
    const response = { sources: [{ id: 'direct', label: 'Direct', kind: 'hls', consentRequired: false,
      url: '/api/vidnest?stream=auto', streamCatalogUrl: '/api/vidnest?metadata=1' }],
      subtitleCatalogUrl: '/api/subtitles?tmdbId=123&type=movie',
      adPolicy: { enabled: false, firstBreakSeconds: 900, intervalSeconds: 900, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 },
      entitlements: { resolved: true, adFree: true, maxProfiles: 4, status: 'active', planId: 'plan-fixture',
        planName: 'Premium', accessUntil: '2027-01-01T00:00:00Z' } } satisfies PlaybackResponse;
    mock.fetch.mockResolvedValue(new Response(JSON.stringify(response)));
    const result = await resolvePlaybackDetails({ type: 'movie', tmdbId: '123' });
    expect(result.sources[0]?.streamCatalogUrl).toBe(`${origin}/api/vidnest?metadata=1`);
    expect(result.subtitleCatalogUrl).toBe(`${origin}/api/subtitles?tmdbId=123&type=movie`);
    expect(result.adPolicy).toEqual(response.adPolicy);
    expect(result.entitlements).toEqual(response.entitlements);
    expect(result).not.toHaveProperty('entitlement');
    expect(mock.fetch.mock.calls[0]?.[1]).toEqual({ headers: { Authorization: 'Bearer fixture-token' }, signal: expect.any(AbortSignal),
      credentials: 'omit', redirect: 'error' });
  });
  it('preserves unresolved commerce without manufacturing an active or ad-free entitlement', async () => {
    const response = { sources: [], entitlements: { resolved: false, adFree: false, maxProfiles: 1, status: 'unavailable' },
      adPolicy: { enabled: false, firstBreakSeconds: 900, intervalSeconds: 900, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5 } } satisfies PlaybackResponse;
    mock.fetch.mockResolvedValue(new Response(JSON.stringify(response)));
    const result = await resolvePlaybackDetails({ type: 'tv', tmdbId: '123', season: 2, episode: 3 });
    expect(result.entitlements).toEqual(response.entitlements);
    expect(result.adPolicy?.enabled).toBe(false);
    const url = new URL(mock.fetch.mock.calls[0]![0]);
    expect(url.searchParams.get('season')).toBe('2');
    expect(url.searchParams.get('episode')).toBe('3');
  });
  it('rejects external/credentialed catalogs and sidecars', async () => {
    expect(sameOriginPlaybackUrl('https://evil.test/api/vidnest?token=x')).toBeNull();
    expect(sameOriginPlaybackUrl(`${origin.replace('://', '://username:password@')}/api/vidnest`)).toBeNull();
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ streams: [
      { id: 'bad', url: 'https://evil.test/hls', qualities: [], audioTracks: [], subtitles: [] },
      { id: 'good', url: '/api/vidnest?token=fixture', qualities: [], audioTracks: [], subtitles: [
        { id: 'bad', label: 'Bad', language: 'en', url: 'https://evil.test/subtitle' },
      ] },
    ] })));
    const result = await fetchStreamCatalog(`${origin}/api/vidnest?metadata=1`);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]?.subtitles[0]?.url).toBeUndefined();
  });
  it('does not request catalogs on unsafe URLs and handles missing subtitle contracts', async () => {
    expect(await fetchStreamCatalog('https://evil.test/options')).toEqual({ streams: [] });
    expect(mock.fetch).not.toHaveBeenCalled();
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ configured: false })));
    expect(await fetchSubtitleCatalog(`${origin}/api/subtitles?tmdbId=123&type=movie`)).toEqual([]);
  });
  it('failed playback network returns an empty safe source result', async () => {
    mock.fetch.mockRejectedValue(new Error('offline'));
    expect(await resolvePlaybackDetails({ type: 'movie', tmdbId: '123' })).toEqual({ sources: [] });
  });
});

describe('Android verified account and episode boundaries', () => {
  it('verified empty local session is guest; uncertain session never falls back to guest', async () => {
    expect((await getPlaybackContext('title', 'movie')).viewerKey).toBe('guest');
    mock.getSession.mockResolvedValue({ data: { session: null }, error: new Error('unavailable') });
    expect((await getPlaybackContext('title', 'movie')).viewerKey).toBe('unavailable');
  });
  it('invalid signed-in auth becomes unavailable, not guest history', async () => {
    mock.getSession.mockResolvedValue({ data: { session: { access_token: 'fixture' } }, error: null });
    mock.getUser.mockResolvedValue({ data: { user: null }, error: new Error('invalid token') });
    expect((await getPlaybackContext('title', 'movie')).viewerKey).toBe('unavailable');
    expect(mock.from).not.toHaveBeenCalled();
  });
  it('does not read a title-only TV resume when exact episode UUID is unavailable', async () => {
    mock.getSession.mockResolvedValue({ data: { session: { access_token: 'fixture' } }, error: null });
    mock.getUser.mockResolvedValue({ data: { user: { id: 'account' } }, error: null });
    const profileQuery = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'profile' }, error: null }) };
    mock.from.mockReturnValue(profileQuery);
    const result = await getPlaybackContext('non-uuid-show', 'tv', undefined, 1, 2);
    expect(result.viewerKey).toBe('account:account:profile:profile');
    expect(result.resume).toBeNull();
    expect(mock.from.mock.calls.map(([table]) => table)).toEqual(['profiles']);
  });
  it('rejects invalid progress numbers before any account or database access', async () => {
    expect(await reportProgress({ titleId: 'title', positionSeconds: NaN })).toEqual({ ok: false });
    expect(await reportProgress({ titleId: 'title', positionSeconds: -1 })).toEqual({ ok: false });
    expect(mock.getUser).not.toHaveBeenCalled();
    expect(mock.from).not.toHaveBeenCalled();
  });
});

describe('Android optional discovery metadata', () => {
  it('language OR filters use real stored language metadata and preserve it in title DTOs', async () => {
    const query = {
      select: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(),
      abortSignal: vi.fn().mockReturnThis(),
      then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: 'title', type: 'movie', slug: 'film', name: 'Film', original_language: 'ta' }], error: null }),
    };
    mock.publicFrom.mockReturnValue(query);
    const titles = await listTitles({ originalLanguage: 'ta|te|ml|kn' });
    expect(query.in).toHaveBeenCalledWith('original_language', ['ta', 'te', 'ml', 'kn']);
    expect(titles[0]?.originalLanguage).toBe('ta');
    expect(titles[0]?.originCountries).toBeUndefined();
    expect(mock.from).not.toHaveBeenCalled(); expect(mock.getSession).not.toHaveBeenCalled();
  });
  it('country fallback returns no fabricated metadata or catalog query', async () => {
    expect(await listTitles({ country: 'KR' })).toEqual([]);
    expect(mock.from).not.toHaveBeenCalled();
    expect(mock.publicFrom).not.toHaveBeenCalled();
  });
  it('uses a non-persistent anonymous client for public fallback reads even while private auth is stalled', async () => {
    mock.getSession.mockReturnValue(new Promise(() => {}));
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(),
      abortSignal: vi.fn().mockReturnThis(), then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }) };
    mock.publicFrom.mockReturnValue(query);
    expect(await listTitles()).toEqual([]);
    expect(await fetchHome()).toEqual({ hero: [], rows: [] });
    expect(mock.publicFrom).toHaveBeenCalledTimes(5);
    expect(mock.publicOptions.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'lumora:public-catalog' });
    expect(mock.getSession).not.toHaveBeenCalled(); expect(mock.getUser).not.toHaveBeenCalled(); expect(mock.from).not.toHaveBeenCalled();
    mock.fetch.mockResolvedValue(new Response('{}'));
    await mock.publicOptions.global.fetch('https://public.example/rest/v1/titles', { headers: { apikey: 'public-fixture' } });
    expect(mock.fetch).toHaveBeenCalledWith('https://public.example/rest/v1/titles', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  });
  it('aborts a stalled public fallback network read on its deadline', async () => {
    vi.useFakeTimers();
    const query = { select: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn().mockReturnThis(),
      abortSignal: vi.fn().mockReturnThis(), then: () => {} };
    mock.publicFrom.mockReturnValue(query);
    const result = listTitles(); const rejected = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(PLAYBACK_CATALOG_TIMEOUT_MS + 1); await rejected;
    expect(query.abortSignal.mock.calls[0]![0].aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(mock.getSession).not.toHaveBeenCalled();
  });
});
