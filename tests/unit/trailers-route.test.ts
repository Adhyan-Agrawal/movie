import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ movie: vi.fn(), show: vi.fn(), resolve: vi.fn(), auth: vi.fn(), service: vi.fn(), cookies: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/features/catalog/tmdb-catalog', () => ({ getTmdbMovieMetadata: mocks.movie, getTmdbShowMetadata: mocks.show }));
vi.mock('@/features/trailers/resolver', () => ({ resolveTrailer: mocks.resolve }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.auth }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
import * as route from '@/app/api/trailer/route';

const NOW = Date.UTC(2026, 10, 4, 12);
const info = () => ({ url: `https://imdb-video.media-imdb.com/qa-720p.mp4?Expires=${NOW / 1000 + 600}`, previewUrl: `https://imdb-video.media-imdb.com/qa-480p.mp4?Expires=${NOW / 1000 + 600}`, mime: 'video/mp4', name: 'Synthetic QA trailer', expiresAt: NOW + 120_000 });
const request = (query = 'imdbId=tt9000001', init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`https://app.example/api/trailer?${query}`, init);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.resetAllMocks();
  mocks.resolve.mockResolvedValue(info());
  mocks.movie.mockResolvedValue({ id: 900001, imdb_id: 'tt9000001' });
  mocks.show.mockResolvedValue({ id: 900002, external_ids: { imdb_id: 'tt9000002' } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('public GET /api/trailer', () => {
  it('returns only plain trailer metadata, bounded cache headers, and direct MP4 URLs', async () => {
    const response = await route.GET(request()); const body = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(['trailer']);
    expect(Object.keys(body.trailer).sort()).toEqual(['expiresAt', 'mime', 'name', 'previewUrl', 'url']);
    expect(new URL(body.trailer.url).origin).toBe('https://imdb-video.media-imdb.com');
    expect(response.headers.get('cache-control')).toBe('public, max-age=120, s-maxage=120');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.movie).not.toHaveBeenCalled(); expect(mocks.show).not.toHaveBeenCalled();
  });

  it('caps edge and browser metadata caching at five minutes', async () => {
    mocks.resolve.mockResolvedValue({ ...info(), expiresAt: NOW + 3_600_000 });
    expect((await route.GET(request())).headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
  });

  it.each(['missing', 'error'])('returns an uncached null for %s lookup', async (kind) => {
    if (kind === 'error') mocks.resolve.mockRejectedValueOnce(new Error('Synthetic private diagnostic')); else mocks.resolve.mockResolvedValueOnce(null);
    const response = await route.GET(request());
    expect(await response.json()).toEqual({ trailer: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    '', 'imdbId=', 'imdbId=tt1', 'imdbId=TT9000001', 'imdbId=tt9000001%0A',
    'tmdbId=900001', 'type=movie', 'tmdbId=0&type=movie', 'tmdbId=01&type=movie',
    'tmdbId=1e3&type=movie', 'tmdbId=12345678901&type=movie', 'tmdbId=900001&type=anime',
    'imdbId=tt9000001&imdbId=tt9000002', 'tmdbId=900001&tmdbId=900002&type=movie',
    'tmdbId=900001&type=movie&type=tv', 'imdbId=tt9000001&url=https://private.invalid',
  ])('rejects missing, malformed, duplicate, or arbitrary query input #%# before any read', async (query) => {
    const response = await route.GET(request(query));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ trailer: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.movie).not.toHaveBeenCalled(); expect(mocks.show).not.toHaveBeenCalled();
  });

  it('rejects simultaneous or conflicting IMDb and TMDB lookup identities', async () => {
    for (const query of ['imdbId=tt9000001&tmdbId=900002&type=movie', 'imdbId=tt9000001&tmdbId=invalid&type=movie']) {
      expect((await route.GET(request(query))).status).toBe(400);
    }
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('resolves a movie IMDb ID only from matching validated TMDB metadata', async () => {
    const response = await route.GET(request('tmdbId=900001&type=movie'));
    expect(response.status).toBe(200); expect(mocks.movie).toHaveBeenCalledWith('900001');
    expect(mocks.resolve.mock.calls[0][0]).toBe('tt9000001'); expect(mocks.show).not.toHaveBeenCalled();
  });

  it('resolves a TV IMDb ID from validated external_ids without Supabase', async () => {
    await route.GET(request('tmdbId=900002&type=tv'));
    expect(mocks.show).toHaveBeenCalledWith('900002'); expect(mocks.movie).not.toHaveBeenCalled();
    expect(mocks.resolve.mock.calls[0][0]).toBe('tt9000002');
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { id: 900002, imdb_id: 'tt9000001' }, { id: '900001', imdb_id: 'tt9000001' }, { id: 900001, imdb_id: 'bad' }, { id: 900001, external_ids: [] }])('fails closed on missing or mismatched TMDB metadata #%#', async (metadata) => {
    mocks.movie.mockResolvedValueOnce(metadata);
    const response = await route.GET(request('tmdbId=900001&type=movie'));
    expect(await response.json()).toEqual({ trailer: null }); expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('does not read Supabase/cookies or forward viewer credentials into trailer resolution', async () => {
    const response = await route.GET(request('imdbId=tt9000001', { headers: { Cookie: 'qa=synthetic', Authorization: 'Bearer synthetic', 'X-Api-Key': 'synthetic', Referer: 'https://private.invalid/' } }));
    expect(response.status).toBe(200);
    expect(mocks.resolve.mock.calls[0].length).toBe(2);
    expect(mocks.resolve.mock.calls[0][0]).toBe('tt9000001');
    expect(mocks.resolve.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it('does no metadata reads for an already aborted lookup', async () => {
    const caller = new AbortController(); caller.abort();
    const response = await route.GET(request('tmdbId=900001&type=movie', { signal: caller.signal }));
    expect(mocks.movie).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
    expect((await response.json()).trailer === null).toBe(true);
  });

  it('exposes no mutation method or MP4 proxy API', () => {
    expect((route as Record<string, unknown>).POST).toBeUndefined();
    expect((route as Record<string, unknown>).PUT).toBeUndefined();
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
