import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { DirectStream } from '@/lib/providers/types';

const SECRET = 'vidnest-catalog-test-secret-at-least-32-characters';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="French",LANGUAGE="fr",URI="subs.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x800,AUDIO="a",SUBTITLES="s"',
  'video.m3u8',
].join('\n');
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
const MEDIA_BYTES = new Uint8Array(1024);
MEDIA_BYTES[0] = MEDIA_BYTES[188] = MEDIA_BYTES[376] = 0x47;
let GET: typeof import('@/app/api/vidnest/route').GET;

function muxedAudio(languages: string[]): Uint8Array {
  const tables = [
    [0, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0],
    [2, 0, 0, 0, 1, 0xc1, 0, 0, 0xe1, 1, 0xf0, 0, ...languages.flatMap((language, index) =>
      [0x0f, 0xe1, index + 1, 0xf0, 6, 0x0a, 4, ...Array.from(language, (character) => character.charCodeAt(0)), 0])],
  ];
  const bytes = new Uint8Array(188 * 3).fill(255);
  tables.forEach((table, index) => {
    const length = table.length + 1;
    table[1] = 0xb0 | (length >> 8); table[2] = length & 255;
    let crc = 0xffffffff;
    for (const byte of table) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    }
    bytes.set([0x47, 0x40 | index, 0, 0x10, 0, ...table,
      (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255], index * 188);
  });
  bytes.set([0x47, 0x1f, 0xff, 0x10], 376);
  return bytes;
}

function playbackResponse(url: unknown): Response {
  const path = new URL(String(url)).pathname;
  if (path.endsWith('/segment.ts')) return new Response(MEDIA_BYTES, { headers: { 'Content-Type': 'video/mp2t' } });
  return new Response(path.endsWith('/video.m3u8') ? MEDIA : MASTER);
}

function request(params = 'tmdbId=27205&type=movie&metadata=1', init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://app.example/api/vidnest?${params}`, init);
}

function resolved(streams: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ streams, ...extra }), { headers: { 'Content-Type': 'application/json' } });
}

function isResolver(url: unknown): boolean {
  return new URL(String(url)).pathname === '/api/resolve';
}

async function catalog(response: Response): Promise<DirectStream[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return (await response.json() as { streams: DirectStream[] }).streams;
}

function payload(path: string): { url: string; headers: Record<string, string> } {
  const url = new URL(path, 'https://app.example');
  expect(url.origin).toBe('https://app.example');
  expect(url.pathname).toBe('/api/vidnest');
  const token = url.searchParams.get('token')!;
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { url: string; headers: Record<string, string> };
}

beforeEach(async () => {
  vi.resetModules();
  GET = (await import('@/app/api/vidnest/route')).GET;
  vi.stubEnv('VIDNEST_API_SECRET', SECRET);
  vi.stubEnv('VIDNEST_API_URL', 'https://resolver.example');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('VidNest stream catalog', () => {
  it('returns the actual stream count, sanitized metadata, allowed headers, and same-origin URLs', async () => {
    const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => isResolver(url) ? resolved([
      {
        url: 'https://cdn.example/master.m3u8?key=private',
        headers: { Referer: 'https://player.example/watch', ORIGIN: 'https://player.example', Cookie: 'private', Authorization: 'private' },
        subtitles: [
          { url: 'https://subs.example/en.vtt?key=private', label: 'English', language: 'en', default: true, headers: { ReFeReR: 'https://subs.example/watch', Cookie: 'private' } },
          { url: 'https://subs.example/fr.m3u8', label: 'French', language: 'fr', format: 'vtt' },
          { url: 'javascript:alert(1)', label: 'Unsafe', language: 'en' },
          { url: 'http://subs.example/unsafe.vtt', label: 'Unsafe', language: 'en' },
        ],
        profileId: 'personal-data-that-must-not-be-retained',
      },
      { url: 'https://cdn.example/second.m3u8' },
      { url: 'javascript:alert(1)' },
      { url: 'https://user:secret@cdn.example/private' },
      null,
    ]) : playbackResponse(url));
    vi.stubGlobal('fetch', fetchMock);

    const streams = await catalog(await GET(request()));

    expect(streams).toHaveLength(2);
    expect(streams.map((stream) => stream.id)).toEqual(['0', '1']);
    expect(streams.every((stream) => typeof stream.startupLatencyMs === 'number')).toBe(true);
    expect(streams[0]!.qualities).toEqual([{ id: '0', label: '800p', width: 1920, height: 800, bitrateKbps: 5000 }]);
    expect(streams[0]!.audioTracks).toEqual([{ id: '0', label: 'English', language: 'en', default: true }]);
    expect(streams[0]!.subtitles[0]).toEqual({ id: '0', label: 'French', language: 'fr', kind: 'subtitles' });
    expect(streams[0]!.subtitles).toHaveLength(3);
    expect(streams[0]!.subtitles[2]!.url).toBeUndefined();
    expect(payload(streams[0]!.url)).toEqual({
      url: 'https://cdn.example/master.m3u8?key=private',
      headers: { referer: 'https://player.example/watch', origin: 'https://player.example' },
      expiresAt: expect.any(Number),
    });
    expect(payload(streams[0]!.subtitles[1]!.url!).headers).toEqual({ referer: 'https://subs.example/watch', origin: 'https://player.example' });
    expect(JSON.stringify(streams)).not.toMatch(/cdn\.example|subs\.example|personal-data|"headers"|key=private/);
    for (const call of fetchMock.mock.calls.filter(([url]) => !isResolver(url))) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('authorization')).toBeNull();
    }
  });

  it('preserves shared gateway VTT sidecars and identified muxed audio, but never invents absent tracks', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => isResolver(url) ? resolved([
      { url: 'https://cdn.example/first.m3u8', audioLanguage: 'hi' },
      { url: 'https://cdn.example/second.m3u8' },
    ], { subtitles: [{ file: 'https://subs.example/en.vtt', label: 'English', lang: 'en' }] }) : new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts')));
    const streams = await catalog(await GET(request()));
    expect(streams[0]!.audioTracks).toEqual([{ id: 'muxed', label: 'hi', language: 'hi', default: true }]);
    expect(streams[1]!.audioTracks).toEqual([]);
    expect(streams.every((stream) => stream.qualities.length === 0)).toBe(true);
    expect(streams.every((stream) => stream.subtitles.length === 1 && stream.subtitles[0]!.url?.startsWith('/api/vidnest?token='))).toBe(true);
  });

  it('keeps actual streams when individual probes fail, are non-HLS, oversized, or stalled', async () => {
    vi.useFakeTimers();
    const urls = ['failed', 'html', 'oversized', 'stalled'];
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (isResolver(url)) return resolved(urls.map((name) => ({ url: `https://cdn.example/${name}` })));
      const name = new URL(String(url)).pathname.slice(1);
      if (name === 'failed') throw new Error('Upstream private details');
      if (name === 'html') return new Response('<html>unavailable</html>');
      if (name === 'oversized') return new Response('x'.repeat(1024 * 1024 + 1));
      return new Response(new ReadableStream({ cancel }));
    }));
    const responsePromise = GET(request());
    await vi.advanceTimersByTimeAsync(4001);
    const streams = await catalog(await responsePromise);
    expect(streams).toHaveLength(4);
    expect(cancel).toHaveBeenCalledOnce();
    for (const stream of streams) expect(stream).toMatchObject({ qualities: [], audioTracks: [], subtitles: [] });
  });

  it('caps declared manifest sizes and rejects HTTP error pages without reading their bodies', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (isResolver(url)) return resolved([{ url: 'https://cdn.example/large' }, { url: 'https://cdn.example/failed' }]);
      return new Response(new ReadableStream({ cancel }), String(url).endsWith('large')
        ? { headers: { 'Content-Length': String(1024 * 1024 + 1) } } : { status: 503 });
    }));
    const streams = await catalog(await GET(request()));
    expect(streams).toHaveLength(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(streams.every((stream) => stream.qualities.length === 0)).toBe(true);
  });

  it('probes concurrently with no more than four active manifest or first-media requests', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (isResolver(url)) return resolved(Array.from({ length: 11 }, (_, index) => ({ url: `https://cdn.example/${index}.m3u8` })));
      active++;
      maxActive = Math.max(active, maxActive);
      if (String(url).endsWith('/segment.ts')) expect(new Headers(init?.headers).get('range')).toBe('bytes=0-1023');
      await new Promise((resolve) => setTimeout(resolve, 100));
      active--;
      return playbackResponse(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const responsePromise = GET(request());
    await vi.advanceTimersByTimeAsync(901);
    const streams = await catalog(await responsePromise);
    expect(streams).toHaveLength(11);
    expect(streams.every((stream) => stream.startupLatencyMs === 300)).toBe(true);
    expect(maxActive).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(34); // Resolver plus master, media manifest, and first media bytes per stream.
  });

  it('deduplicates concurrent resolver/catalog requests and expires catalogs before resolver data', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => isResolver(url) ? resolved([{ url: 'https://cdn.example/master.m3u8' }]) : playbackResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    const responses = await Promise.all([GET(request()), GET(request())]);
    expect(await catalog(responses[0]!)).toEqual(await catalog(responses[1]!));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await GET(request('type=movie&tmdbId=27205&metadata=1&ignoredViewerId=personal', { headers: { Cookie: 'viewer=private', Authorization: 'viewer-private' } }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30001);
    await GET(request());
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(30001);
    await GET(request());
    expect(fetchMock).toHaveBeenCalledTimes(11);
    for (const call of fetchMock.mock.calls.filter(([url]) => isResolver(url))) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    }
  });

  it('bounds total catalog discovery time while retaining streams that could not be probed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: unknown) => isResolver(url)
      ? resolved(Array.from({ length: 13 }, (_, index) => ({ url: `https://cdn.example/${index}.m3u8` })))
      : new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const response = GET(request());
    await vi.advanceTimersByTimeAsync(12001);
    const streams = await catalog(await response);
    expect(streams).toHaveLength(13);
    expect(streams.every((stream) => stream.qualities.length === 0 && stream.audioTracks.length === 0 && stream.subtitles.length === 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(13); // Resolver plus twelve probes; final stream retained without probing.
  });

  it('starts stream zero immediately while catalog probes are still waiting', async () => {
    vi.useFakeTimers();
    let firstStreamFetches = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const fetchMock = vi.fn(async (url: unknown) => {
      if (isResolver(url)) return resolved([{ url: 'https://cdn.example/0.m3u8' }, { url: 'https://cdn.example/1.m3u8' }]);
      if (String(url).endsWith('/0.m3u8') && ++firstStreamFetches > 1) return new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts');
      signalStarted();
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchMock);
    const metadata = GET(request());
    await started;
    const playback = await GET(request('tmdbId=27205&type=movie&stream=0'));
    expect(playback.status).toBe(200);
    expect(await playback.text()).toContain('/api/vidnest?token=');
    expect(fetchMock.mock.calls.filter(([url]) => isResolver(url))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4001);
    expect(await catalog(await metadata)).toHaveLength(2);
  });

  it('allows actual stream indexes beyond the former eleven-source limit and returns 404 for nonexistent streams', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => isResolver(url)
      ? resolved(Array.from({ length: 13 }, (_, index) => ({ url: `https://cdn.example/${index}.m3u8` })))
      : new Response('#EXTM3U\nsegment.ts')));
    expect((await GET(request('tmdbId=27205&type=movie&stream=12'))).status).toBe(200);
    expect((await GET(request('tmdbId=27205&type=movie&stream=13'))).status).toBe(404);
  });

  it('evicts failed resolution promises so a subsequent request can retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('failure', { status: 502 }))
      .mockResolvedValueOnce(resolved([{ url: 'https://cdn.example/master.m3u8' }]))
      .mockResolvedValueOnce(new Response(MASTER))
      .mockResolvedValueOnce(new Response(MEDIA))
      .mockResolvedValueOnce(new Response(MEDIA_BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const failed = await GET(request());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('private');
    const streams = await catalog(await GET(request()));
    expect(streams).toHaveLength(1);
    expect(streams[0]!.startupLatencyMs).toEqual(expect.any(Number));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('reads legitimate child playlists larger than 256 KiB and catalogs real cross-source audio languages', async () => {
    const languages = ['hin', 'eng', 'und'];
    const largeMedia = MEDIA + '#padding\n'.repeat(33000);
    expect(largeMedia.length).toBeGreaterThan(256 * 1024);
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      if (isResolver(url)) return resolved(languages.map((_, index) => ({ url: `https://cdn.example/${index}/master.m3u8` })));
      const target = new URL(String(url));
      if (target.pathname.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.42e01e,mp4a.40.2"\nvideo.m3u8');
      if (target.pathname.endsWith('video.m3u8')) return new Response(largeMedia, { headers: { 'Content-Length': String(largeMedia.length) } });
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-262143');
      return new Response(muxedAudio([languages[Number(target.pathname.split('/')[1])]!]));
    }));
    const streams = await catalog(await GET(request()));
    expect(streams.map((stream) => stream.audioTracks)).toEqual([
      [{ id: 'decoded:hin:0', language: 'hin', label: 'Hindi', default: true }],
      [{ id: 'decoded:eng:0', language: 'eng', label: 'English', default: true }], [],
    ]);
    expect(streams.every((stream) => stream.startupLatencyMs !== undefined && stream.subtitles.length === 0)).toBe(true);
    expect(JSON.stringify(streams)).not.toMatch(/cdn\.example|"headers"/);
  });

  it('exposes multiple decoded languages only for separate audio elementary streams', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => isResolver(url)
      ? resolved([{ url: 'https://cdn.example/media.m3u8' }])
      : new Response(String(url).endsWith('.ts') ? muxedAudio(['eng', 'hin']) : MEDIA)));
    expect((await catalog(await GET(request())))[0]!.audioTracks).toEqual([
      { id: 'decoded:eng:0', language: 'eng', label: 'English', default: true },
      { id: 'decoded:hin:1', language: 'hin', label: 'Hindi' },
    ]);
  });

  it('still rejects child playlists over the 1 MiB hard cap without probing media', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (isResolver(url)) return resolved([{ url: 'https://cdn.example/master.m3u8' }]);
      return String(url).endsWith('master.m3u8')
        ? new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8')
        : new Response(MEDIA + '#padding\n'.repeat(120000));
    });
    vi.stubGlobal('fetch', fetchMock);
    const streams = await catalog(await GET(request()));
    expect(streams[0]!.audioTracks).toEqual([]);
    expect(streams[0]!.startupLatencyMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('decodes a complete PSI table ending between geometric rescans at EOF', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (isResolver(url)) return resolved([{ url: 'https://cdn.example/media.m3u8' }]);
      if (!String(url).endsWith('.ts')) return new Response(MEDIA);
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of muxedAudio(['hin'])) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      } }));
    }));
    expect((await catalog(await GET(request())))[0]!.audioTracks)
      .toEqual([{ id: 'decoded:hin:0', language: 'hin', label: 'Hindi', default: true }]);
  });

  it('preserves declared audio groups and gateway languages instead of adding decoded alternatives', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => isResolver(url)
      ? resolved([{ url: 'https://cdn.example/group.m3u8' }, { url: 'https://cdn.example/gateway.m3u8', audioLanguage: 'hi' }])
      : new Response(String(url).endsWith('group.m3u8') ? MASTER : String(url).endsWith('.ts') ? muxedAudio(['eng']) : MEDIA)));
    const streams = await catalog(await GET(request()));
    expect(streams[0]!.audioTracks).toEqual([{ id: '0', language: 'en', label: 'English', default: true }]);
    expect(streams[1]!.audioTracks).toEqual([{ id: 'muxed', language: 'hi', label: 'hi', default: true }]);
  });

  it('decodes audio through the targeted short-200 TS no-Range retry', async () => {
    const ranges: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      if (isResolver(url)) return resolved([{ url: 'https://cdn.example/media.m3u8' }]);
      if (!String(url).endsWith('.ts')) return new Response(MEDIA);
      const range = new Headers(init?.headers).get('range'); ranges.push(range);
      return new Response(range ? muxedAudio(['hin']).subarray(0, 254) : muxedAudio(['hin']), { status: 200 });
    }));
    const stream = (await catalog(await GET(request())))[0]!;
    expect(stream.audioTracks).toEqual([{ id: 'decoded:hin:0', language: 'hin', label: 'Hindi', default: true }]);
    expect(stream.startupLatencyMs).toEqual(expect.any(Number));
    expect(ranges).toEqual(['bytes=0-262143', null]);
  });

  it('includes arrival and decoding of a later PMT in startup latency and cancels after complete metadata', async () => {
    vi.useFakeTimers();
    const bytes = muxedAudio(['eng']);
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (isResolver(url)) return resolved([{ url: 'https://cdn.example/media.m3u8' }]);
      if (!String(url).endsWith('.ts')) return new Response(MEDIA);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(Buffer.concat([bytes.subarray(0, 188), bytes.subarray(376), bytes.subarray(376)])));
        setTimeout(() => controller.enqueue(bytes.subarray(188, 376)), 150);
      }, cancel }));
    }));
    let done = false;
    const pending = GET(request()).then((response) => { done = true; return response; });
    await vi.advanceTimersByTimeAsync(149); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const stream = (await catalog(await pending))[0]!;
    expect(stream.audioTracks[0]!.language).toBe('eng');
    expect(stream.startupLatencyMs).toBe(150);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds resolver time, deduplicates its timeout, and retries after timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const first = GET(request());
    const second = GET(request());
    await vi.advanceTimersByTimeAsync(10001);
    expect((await first).status).toBe(504);
    expect((await second).status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(resolved([]));
    expect(await catalog(await GET(request()))).toEqual([]);
  });

  it('caps resolver bodies and does not cache malformed responses', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)))
      .mockResolvedValueOnce(new Response('invalid-json'))
      .mockResolvedValueOnce(resolved([]));
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request())).status).toBe(502);
    expect((await GET(request())).status).toBe(502);
    expect(await catalog(await GET(request()))).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not serve a stale catalog after resolver data changes near its expiry', async () => {
    vi.useFakeTimers();
    let count = 1;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => isResolver(url)
      ? resolved(Array.from({ length: count }, (_, index) => ({ url: `https://cdn.example/${index}.m3u8` })))
      : new Response(MASTER)));
    await GET(request('tmdbId=27205&type=movie&stream=0'));
    await vi.advanceTimersByTimeAsync(50000);
    expect(await catalog(await GET(request()))).toHaveLength(1);
    count = 2;
    await vi.advanceTimersByTimeAsync(10001);
    expect(await catalog(await GET(request()))).toHaveLength(2);
  });

  it.each(['tmdbId=0&type=movie', 'tmdbId=27205&type=tv', 'tmdbId=27205&type=movie&stream=-1', 'tmdbId=27205&type=movie&stream=Infinity'])('rejects invalid catalog/playback parameters without network calls (%s)', async (params) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request(`${params}&metadata=1`))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
