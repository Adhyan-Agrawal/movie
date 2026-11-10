import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requestIp } from '@/lib/request-ip';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), alternate: vi.fn(), search: vi.fn(), configure: vi.fn(), fetch: vi.fn() }));
vi.mock('@/features/vidnest/resolver', () => ({ inspectVidnest: mocks.inspect }));
vi.mock('@/features/megaplay/resolver', () => ({ resolveMegaPlayStreams: mocks.alternate }));
vi.mock('wyzie-lib', () => ({
  configure: mocks.configure,
  searchSubtitles: mocks.search,
  withDownloadOptions: (url: string) => `${url}?to=vtt`,
  WyzieError: class extends Error {},
}));

const SITE_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'synthetic-runtime-secret-at-least-32-characters';
const IP = '203.0.113.10';
const SECOND_IP = '203.0.113.11';
const HEADER = 'x-nf-client-connection-ip';
const MEDIA = '#EXTM3U\n#EXTINF:6,\nsegment.ts\n';
const BYTES = new Uint8Array(1024);
BYTES[0] = BYTES[188] = BYTES[376] = 0x47;

function request(path: string, headers: HeadersInit = {}) {
  return new NextRequest(new URL(path, 'https://app.example'), { headers });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-10T12:00:00Z');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('SITE_ID', SITE_ID);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
  vi.stubEnv('VIDNEST_API_SECRET', SECRET);
  vi.stubEnv('VIDNEST_API_URL', '');
  vi.stubEnv('WYZIE_API_KEY', SECRET);
  vi.stubEnv('WYZIE_SUBTITLE_TOKEN_SECRET', '');
  mocks.inspect.mockResolvedValue({ streams: [{ url: 'https://media.example/stream.m3u8', type: 'hls' }] });
  mocks.alternate.mockResolvedValue([]);
  mocks.search.mockResolvedValue([{ id: 'en', url: 'https://sub.wyzie.io/c/synthetic', language: 'en', display: 'English' }]);
  mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin === 'https://media.example') return new Response(url.pathname.endsWith('.m3u8') ? MEDIA : BYTES);
    if (url.origin === 'https://sub.wyzie.io') return new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic\n\n');
    throw new Error('Unexpected network request in synthetic portability test');
  });
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Netlify connecting IP', () => {
  it.each([
    [IP, IP],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:203.0.113.10', '::ffff:cb00:710a'],
  ])('accepts and canonicalizes one address %s', (value, expected) => {
    expect(requestIp(new Headers({ [HEADER]: value }))).toBe(expected);
  });

  it.each(['', 'unknown', `${IP}, ${SECOND_IP}`, `${IP}:443`, '203.000.113.10', '[2001:db8::1]', 'fe80::1%eth0', '2001:db8::1/64', '203.0.113.10 extra', 'a'.repeat(46)])('rejects malformed or multiple address %s', (value) => {
    expect(requestIp(new Headers({ [HEADER]: value }))).toBeNull();
  });

  it('ignores forwarding and Cloudflare headers, and requires Functions runtime metadata', () => {
    expect(requestIp(new Headers({ 'x-forwarded-for': IP, 'x-real-ip': IP, 'cf-connecting-ip': IP, 'client-ip': IP }))).toBeNull();
    vi.stubEnv('SITE_ID', '');
    vi.stubEnv('NETLIFY', 'true');
    expect(requestIp(new Headers({ [HEADER]: IP }))).toBeNull();
  });
});

describe('Node route rate-limit boundaries', () => {
  const playbackPath = '/api/vidnest?tmdbId=1&type=movie&metadata=1';
  const subtitlesPath = '/api/subtitles?tmdbId=1&type=movie';

  it.each<Record<string, string>>([{}, { 'cf-connecting-ip': IP }, { 'x-forwarded-for': IP, 'x-real-ip': IP }, { [HEADER]: `${IP}, ${SECOND_IP}` }])('fails production work closed when no trusted client IP exists: %j', async (headers) => {
    const playback = await import('@/app/api/vidnest/route');
    const subtitles = await import('@/app/api/subtitles/route');
    for (const result of [await playback.GET(request(playbackPath, headers)), await subtitles.GET(request(subtitlesPath, headers))]) {
      expect(result.status).toBe(503);
      expect(result.headers.get('cache-control')).toBe('private, no-store');
      expect(await result.text()).not.toContain(IP);
    }
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.alternate).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('enforces resolution limits per connection despite spoofed forwarding headers and preserves token bypass/expiry', async () => {
    const { GET } = await import('@/app/api/vidnest/route');
    const first = await GET(request(playbackPath, { [HEADER]: IP }));
    const { streams } = await first.json() as { streams: Array<{ url: string }> };
    expect(first.status).toBe(200);
    expect(streams).toHaveLength(1);
    for (let index = 1; index < 20; index++) {
      expect((await GET(request(playbackPath, { [HEADER]: IP, 'x-forwarded-for': `198.51.100.${index}`, 'cf-connecting-ip': `198.51.100.${index}` }))).status).toBe(200);
    }
    const blocked = await GET(request(playbackPath, { [HEADER]: IP, 'x-real-ip': SECOND_IP }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('cache-control')).toBe('private, no-store');
    expect((await GET(request(playbackPath, { [HEADER]: SECOND_IP }))).status).toBe(200);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.alternate).toHaveBeenCalledTimes(1);

    // Cast/media capability holders need no client IP or account cookie.
    vi.stubEnv('SITE_ID', '');
    const media = await GET(request(streams[0]!.url));
    expect(media.status).toBe(200);
    expect(media.headers.get('access-control-allow-origin')).toBe('*');
    expect(media.headers.get('cache-control')).toBe('private, no-store');
    expect(await media.text()).not.toContain('media.example');
    const beforeExpired = mocks.fetch.mock.calls.length;
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    expect((await GET(request(streams[0]!.url))).status).toBe(403);
    expect((await GET(request('/api/vidnest?token=invalid'))).status).toBe(403);
    expect(mocks.fetch).toHaveBeenCalledTimes(beforeExpired);
  });

  it('retains separate subtitle catalog/download limits and isolates different connecting clients', async () => {
    const { GET } = await import('@/app/api/subtitles/route');
    const first = await GET(request(subtitlesPath, { [HEADER]: IP }));
    const { tracks } = await first.json() as { tracks: Array<{ url: string }> };
    expect(tracks).toHaveLength(1);
    for (let index = 1; index < 30; index++) expect((await GET(request(subtitlesPath, { [HEADER]: IP, 'x-forwarded-for': `198.51.100.${index}` }))).status).toBe(200);
    expect((await GET(request(subtitlesPath, { [HEADER]: IP, 'x-real-ip': SECOND_IP }))).status).toBe(429);
    expect((await GET(request(subtitlesPath, { [HEADER]: SECOND_IP }))).status).toBe(200);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 120; index++) expect((await GET(request(tracks[0]!.url, { [HEADER]: IP }))).status).toBe(200);
    expect((await GET(request(tracks[0]!.url, { [HEADER]: IP, 'x-forwarded-for': SECOND_IP }))).status).toBe(429);
    const independent = await GET(request(tracks[0]!.url, { [HEADER]: SECOND_IP }));
    expect(independent.status).toBe(200);
    expect(independent.headers.get('access-control-allow-origin')).toBe('*');
    expect(independent.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not aggregate local requests with missing IP into an unknown-client bucket', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SITE_ID', '');
    const playback = await import('@/app/api/vidnest/route');
    const subtitles = await import('@/app/api/subtitles/route');
    for (let index = 0; index < 35; index++) {
      expect((await playback.GET(request(playbackPath))).status).toBe(200);
      expect((await subtitles.GET(request(subtitlesPath))).status).toBe(200);
    }
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it('never enables unconfigured playback or subtitles merely because Netlify metadata exists', async () => {
    vi.stubEnv('VIDNEST_API_SECRET', '');
    vi.stubEnv('WYZIE_API_KEY', '');
    const playback = await import('@/app/api/vidnest/route');
    const subtitles = await import('@/app/api/subtitles/route');
    expect((await playback.GET(request(playbackPath, { [HEADER]: IP }))).status).toBe(503);
    expect(await (await subtitles.GET(request(subtitlesPath, { [HEADER]: IP }))).json()).toEqual({ tracks: [], configured: false });
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
