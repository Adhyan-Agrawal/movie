import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackResponse } from '../../mobile/src/lib/types';

const mock = vi.hoisted(() => ({
  getSession: vi.fn(), getUser: vi.fn(), from: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabase: {
  auth: { getSession: mock.getSession, getUser: mock.getUser }, from: mock.from,
} }));

import { fetchStreamCatalog, fetchSubtitleCatalog, getPlaybackContext, listTitles, reportProgress, resolvePlayback, resolvePlaybackDetails, sameOriginPlaybackUrl } from '../../mobile/src/lib/api';
const origin = new URL(process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').origin;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mock.fetch);
  mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
});
afterEach(() => vi.unstubAllGlobals());

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
    expect(mock.fetch.mock.calls[0]?.[1]).toEqual({ headers: { Authorization: 'Bearer fixture-token' } });
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
      limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'profile' }, error: null }) };
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
      then: (resolve: (value: unknown) => void) => resolve({ data: [{ id: 'title', type: 'movie', slug: 'film', name: 'Film', original_language: 'ta' }], error: null }),
    };
    mock.from.mockReturnValue(query);
    const titles = await listTitles({ originalLanguage: 'ta|te|ml|kn' });
    expect(query.in).toHaveBeenCalledWith('original_language', ['ta', 'te', 'ml', 'kn']);
    expect(titles[0]?.originalLanguage).toBe('ta');
    expect(titles[0]?.originCountries).toBeUndefined();
  });
  it('country fallback returns no fabricated metadata or catalog query', async () => {
    expect(await listTitles({ country: 'KR' })).toEqual([]);
    expect(mock.from).not.toHaveBeenCalled();
  });
});
