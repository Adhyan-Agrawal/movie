import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  search: vi.fn(),
  withOptions: vi.fn(),
}));

vi.mock('wyzie-lib', () => ({
  configure: mocks.configure,
  searchSubtitles: mocks.search,
  withDownloadOptions: mocks.withOptions,
  WyzieError: class WyzieError extends Error { constructor(readonly status: number) { super('provider error'); } },
}));

let GET: typeof import('@/app/api/subtitles/route').GET;
const request = (query: string) => new NextRequest(`https://app.example/api/subtitles?${query}`);

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  mocks.configure.mockReset(); mocks.search.mockReset(); mocks.withOptions.mockReset();
  vi.unstubAllGlobals();
  GET = (await import('@/app/api/subtitles/route')).GET;
});

describe('Wyzie subtitle route', () => {
  it('degrades to an empty private catalog without exposing client configuration', async () => {
    const response = await GET(request('tmdbId=27205&type=movie'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ tracks: [], configured: false });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('returns encrypted same-origin tracks and converts only a selected subtitle to VTT', async () => {
    vi.stubEnv('WYZIE_API_KEY', 'wyzie-route-test-key-at-least-32-characters');
    mocks.search.mockResolvedValue([{
      id: 'en-one', url: 'https://sub.wyzie.io/c/private-download-token', language: 'en', display: 'English',
      isHearingImpaired: false, release: 'WEB-DL',
    }]);
    mocks.withOptions.mockReturnValue('https://sub.wyzie.io/c/private-download-token?to=vtt');
    const download = vi.fn().mockResolvedValue(new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n', {
      headers: { 'Content-Type': 'text/vtt' },
    }));
    vi.stubGlobal('fetch', download);

    const catalog = await GET(request('tmdbId=27205&type=movie'));
    const body = await catalog.json() as { tracks: Array<{ url: string }> };
    expect(body.tracks).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('sub.wyzie.io');
    expect(JSON.stringify(body)).not.toContain('private-download-token');
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ tmdb_id: 27205, source: 'all' }));
    expect(download).not.toHaveBeenCalled();

    const subtitle = await GET(request(new URL(body.tracks[0]!.url, 'https://app.example').searchParams.toString()));
    expect(subtitle.status).toBe(200);
    expect(subtitle.headers.get('content-type')).toContain('text/vtt');
    expect(await subtitle.text()).toContain('WEBVTT');
    expect(mocks.withOptions).toHaveBeenCalledWith('https://sub.wyzie.io/c/private-download-token', { to: 'vtt' });
    expect(download).toHaveBeenCalledTimes(1);
    const repeated = await GET(request(new URL(body.tracks[0]!.url, 'https://app.example').searchParams.toString()));
    expect(repeated.status).toBe(200);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid TV coordinates and tampered download tokens', async () => {
    vi.stubEnv('WYZIE_API_KEY', 'wyzie-route-test-key-at-least-32-characters');
    expect((await GET(request('tmdbId=1&type=tv&season=1'))).status).toBe(400);
    expect((await GET(request('token=tampered'))).status).toBe(403);
  });
});
