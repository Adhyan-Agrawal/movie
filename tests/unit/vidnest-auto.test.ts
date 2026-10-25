import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { DirectStream } from '@/lib/providers/types';

const SECRET = 'vidnest-auto-test-secret-at-least-32-characters';
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
const BYTES = new Uint8Array(1024);
BYTES[0] = BYTES[188] = BYTES[376] = 0x47;
let GET: typeof import('@/app/api/vidnest/route').GET;
let OPTIONS: typeof import('@/app/api/vidnest/route').OPTIONS;
type Catalog = { streams: DirectStream[]; recommendedStreamId?: string };

function request(stream = 'auto', init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://app.example/api/vidnest?tmdbId=27205&type=movie&${stream === 'metadata' ? 'metadata=1' : `stream=${stream}`}`, init);
}

function resolution(names: string[]) {
  return new Response(JSON.stringify({ streams: names.map((name) => ({
    url: `https://cdn.example/${name}/master.m3u8`,
    headers: { Referer: 'https://player.example/watch', ORIGIN: 'https://player.example', Cookie: 'private' },
  })) }));
}

function master(language = 'en', height = 720) {
  return [
    '#EXTM3U',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${language}",LANGUAGE="${language}"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=${Math.round(height * 16 / 9)}x${height},CODECS="avc1.42e01e",AUDIO="a"`,
    'video.m3u8', '',
  ].join('\n');
}

function proxyRequest(path: string): NextRequest {
  const url = new URL(path, 'https://app.example');
  expect(url.origin).toBe('https://app.example');
  expect(url.pathname).toBe('/api/vidnest');
  expect(url.searchParams.get('token')).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  return new NextRequest(url);
}

beforeEach(async () => {
  vi.resetModules();
  const route = await import('@/app/api/vidnest/route');
  GET = route.GET;
  OPTIONS = route.OPTIONS;
  vi.stubEnv('VIDNEST_API_SECRET', SECRET);
  vi.stubEnv('VIDNEST_API_URL', 'https://resolver.example');
});

function expectReceiverCors(response: Response) {
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
  expect(response.headers.get('access-control-allow-headers')).toBe('Range');
  expect(response.headers.get('access-control-expose-headers'))
    .toBe('Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag, X-Vidnest-Stream-Id');
  expect(response.headers.has('access-control-allow-credentials')).toBe(false);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}

describe('VidNest receiver playback CORS', () => {
  it.each(['auto', '0'])('mints a private short Cast capability for %s instead of exposing an unsigned root', async (stream) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 25));
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['receiver']);
      return new Response(target.pathname.endsWith('master.m3u8') ? MEDIA : BYTES);
    }));
    const castRequest = request(stream);
    castRequest.nextUrl.searchParams.set('cast', '1');
    const minted = await GET(castRequest);
    expect(minted.status).toBe(200);
    expect(minted.headers.has('access-control-allow-origin')).toBe(false);
    const body = await minted.json() as { url: string };
    expect(JSON.stringify(body)).not.toContain('cdn.example');
    expect(JSON.stringify(body)).not.toContain('player.example');
    const playback = await GET(proxyRequest(body.url));
    expect(playback.status).toBe(200);
    expectReceiverCors(playback);
    await playback.text();
    vi.setSystemTime(Date.now() + 15 * 60 * 1000);
    expect((await GET(proxyRequest(body.url))).status).toBe(403);
  });

  it.each(['auto', '0'])('keeps unsigned root %s playback and catalog JSON same-origin', async (stream) => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['receiver']);
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('origin')).toBe('https://player.example');
      return new Response(target.pathname.endsWith('master.m3u8') ? MEDIA : BYTES);
    }));
    const response = await GET(request(stream, { headers: { Origin: 'https://receiver.example' } }));
    expect(response.status).toBe(200);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(await response.text()).toContain('/api/vidnest?token=');
    const metadata = await GET(request('metadata', { headers: { Origin: 'https://receiver.example' } }));
    expect(metadata.status).toBe(200);
    expect(metadata.headers.has('access-control-allow-origin')).toBe(false);
    expect(metadata.headers.has('access-control-allow-credentials')).toBe(false);
  });

  it('answers OPTIONS without gateway configuration, cookies, tokens, or upstream requests', async () => {
    vi.stubEnv('VIDNEST_API_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expectReceiverCors(response);
    expect(await response.text()).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows encrypted token playlists, segments, init data, keys, and nested subtitle VTT without receiver cookies', async () => {
    const playlist = [
      '#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="subs.m3u8"',
      '#EXTINF:6,', 'segment.ts',
    ].join('\n');
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['receiver']);
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('origin')).toBe('https://player.example');
      if (target.pathname.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvideo.m3u8');
      if (target.pathname.endsWith('video.m3u8')) return new Response(playlist);
      if (target.pathname.endsWith('subs.m3u8')) return new Response('#EXTM3U\n#EXTINF:6,\nfirst.vtt');
      if (target.pathname.endsWith('first.vtt')) return new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nCaption\n', { headers: { 'Content-Type': 'text/vtt' } });
      if (target.pathname.endsWith('key.bin')) return new Response(new Uint8Array(16), { headers: { 'Content-Type': 'application/octet-stream' } });
      if (target.pathname.endsWith('init.mp4')) return new Response(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), { headers: { 'Content-Type': 'video/mp4' } });
      return new Response(BYTES, { headers: { 'Content-Type': 'video/mp2t' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const root = await GET(request('0'));
    expect(root.headers.has('access-control-allow-origin')).toBe(false);
    const childPath = (await root.text()).split('\n').find((line) => line.startsWith('/api/vidnest?token='))!;
    const receiverRequest = (path: string) => new NextRequest(new URL(path, 'https://app.example'), { headers: { Origin: 'https://receiver.example' } });
    const child = await GET(receiverRequest(`${childPath}&metadata=1`));
    expectReceiverCors(child); // A token still denotes playback even with a metadata query parameter.
    const rewritten = await child.text();
    const paths = [...rewritten.matchAll(/URI="([^\"]+)"/g)].map((match) => match[1]!)
      .concat(rewritten.split('\n').filter((line) => line.startsWith('/api/vidnest?token=')));
    expect(paths).toHaveLength(4);
    for (const path of paths) {
      const response = await GET(receiverRequest(path));
      expect(response.status).toBe(200);
      expectReceiverCors(response);
      if (response.headers.get('content-type')?.includes('mpegurl')) {
        const vttPath = (await response.text()).split('\n').find((line) => line.startsWith('/api/vidnest?token='))!;
        const subtitle = await GET(receiverRequest(vttPath));
        expectReceiverCors(subtitle);
        expect(subtitle.headers.get('content-type')).toBe('text/vtt');
        expect(await subtitle.text()).toContain('WEBVTT');
      } else if (response.headers.get('content-type') === 'application/octet-stream') expect((await response.arrayBuffer()).byteLength).toBe(16);
      else await response.body?.cancel();
    }
  });

  it.each([206, 416])('exposes receiver Range headers for safe token status %i', async (status) => {
    const range = status === 206 ? 'bytes=0-1023' : 'bytes=5000-';
    const contentRange = status === 206 ? 'bytes 0-1023/5000' : 'bytes */5000';
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['receiver']);
      if (target.pathname.endsWith('master.m3u8')) return new Response(MEDIA);
      expect(new Headers(init?.headers).get('range')).toBe(range);
      expect(new Headers(init?.headers).get('cookie')).toBeNull();
      return new Response(status === 416 ? null : BYTES, { status, headers: {
        'Content-Type': 'video/mp2t', 'Content-Range': contentRange, 'Accept-Ranges': 'bytes',
        'Content-Length': String(BYTES.length), ETag: '"receiver-fixture"',
        'Access-Control-Allow-Credentials': 'true', 'Set-Cookie': 'upstream-only=1',
      } });
    }));
    const root = await GET(request('0'));
    const path = (await root.text()).split('\n').find((line) => line.startsWith('/api/vidnest?token='))!;
    const response = await GET(new NextRequest(new URL(path, 'https://app.example'), {
      headers: { Origin: 'https://receiver.example', Range: range },
    }));
    expect(response.status).toBe(status);
    expectReceiverCors(response);
    expect(response.headers.get('content-range')).toBe(contentRange);
    if (status === 206) {
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('content-length')).toBe(String(BYTES.length));
      expect(response.headers.get('etag')).toBe('"receiver-fixture"');
      expect((await response.arrayBuffer()).byteLength).toBe(BYTES.length);
    } else expect(await response.text()).toBe('');
  });

  it('does not broaden access for invalid encrypted tokens', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest('https://app.example/api/vidnest?token=invalid', {
      headers: { Origin: 'https://receiver.example' },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('VidNest automatic healthy startup', () => {
  it('returns the first verified healthy start while slow candidates remain pending and rejects fast HTML', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['bad', 'fast', 'slow']);
      if (target.pathname.startsWith('/bad/')) return new Response('<html>error</html>', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      if (target.pathname.startsWith('/slow/')) return new Promise<Response>(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(target.pathname.endsWith('master.m3u8') ? master('hi') : target.pathname.endsWith('video.m3u8') ? MEDIA : BYTES);
    });
    vi.stubGlobal('fetch', fetchMock);
    const auto = GET(request());
    let catalogDone = false;
    const metadata = GET(request('metadata')).then((response) => { catalogDone = true; return response; });
    await vi.advanceTimersByTimeAsync(91);
    const response = await auto;
    expect(response.status).toBe(200);
    expect(response.headers.get('x-vidnest-stream-id')).toBe('1');
    const path = (await response.text()).split('\n').find((line) => line.startsWith('/api/vidnest?token='))!;
    expect(catalogDone).toBe(false);
    await vi.advanceTimersByTimeAsync(3910);
    const body = await (await metadata).json() as Catalog;
    expect(body.recommendedStreamId).toBe('1');
    expect(body.streams.map((stream) => stream.startupLatencyMs)).toEqual([undefined, 90, undefined]);
    expect(fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/resolve')).toHaveLength(1);
    const child = GET(proxyRequest(path));
    await vi.advanceTimersByTimeAsync(31);
    expect((await child).status).toBe(200);
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('https://cdn.example/fast/video.m3u8');
  });

  it('measures arrival of verified media bytes, not just immediate response headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['body']);
      if (target.pathname.endsWith('master.m3u8')) return new Response(MEDIA);
      return new Response(new ReadableStream({ start(controller) {
        setTimeout(() => { controller.enqueue(BYTES); controller.close(); }, 250);
      } }), { headers: { 'Content-Type': 'video/mp2t' } });
    }));
    const auto = GET(request());
    let done = false;
    void auto.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await auto).status).toBe(200);
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.streams[0]!.startupLatencyMs).toBe(250);
  });

  it('singleflights auto and catalog requests including all startup data and reuses the cached winner', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['cached']);
      expect(new Headers(init?.headers).get('cookie')).toBeNull();
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      if (target.pathname.endsWith('master.m3u8')) return new Response(master());
      if (target.pathname.endsWith('video.m3u8')) return new Response(MEDIA);
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-1023');
      return new Response(BYTES);
    });
    vi.stubGlobal('fetch', fetchMock);
    const [first, second, metadata] = await Promise.all([GET(request()), GET(request()), GET(request('metadata'))]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = await metadata.json() as Catalog;
    expect(body.recommendedStreamId).toBe('0');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await GET(request())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const playback = await GET(proxyRequest(body.streams[0]!.url));
    expect(playback.status).toBe(200);
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('https://cdn.example/cached/master.m3u8');
    await playback.body?.cancel();
  });

  it('keeps all genuine options and snapshot identities when faster startup has different audio/quality', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['english', 'hindi']);
      const english = target.pathname.startsWith('/english/');
      await new Promise((resolve) => setTimeout(resolve, english ? 50 : 10));
      return new Response(target.pathname.endsWith('master.m3u8') ? master(english ? 'en' : 'hi', english ? 1080 : 720)
        : target.pathname.endsWith('video.m3u8') ? MEDIA : BYTES);
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = GET(request('metadata'));
    await vi.advanceTimersByTimeAsync(151);
    const body = await (await pending).json() as Catalog;
    expect(body.recommendedStreamId).toBe('1');
    expect(body.streams.map((stream) => stream.startupLatencyMs)).toEqual([150, 30]);
    expect(body.streams.map((stream) => stream.qualities[0]!.height)).toEqual([1080, 720]);
    expect(body.streams.map((stream) => stream.audioTracks[0]!.language)).toEqual(['en', 'hi']);
    expect((await GET(request())).headers.get('x-vidnest-stream-id')).toBe('1');
    const explicit = GET(request('0'));
    await vi.advanceTimersByTimeAsync(51);
    expect(await (await explicit).text()).toContain('LANGUAGE="en"');
    for (const [index, name] of ['english', 'hindi'].entries()) {
      const playback = GET(proxyRequest(body.streams[index]!.url));
      await vi.advanceTimersByTimeAsync(name === 'english' ? 51 : 11);
      expect((await playback).status).toBe(200);
      expect(fetchMock.mock.calls.at(-1)![0]).toBe(`https://cdn.example/${name}/master.m3u8`);
    }
  });

  it('never recommends an HTML/error/empty-media candidate or silently forces index zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['html', 'error', 'empty']);
      if (target.pathname.startsWith('/html/')) return new Response('<html>error</html>', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      if (target.pathname.endsWith('master.m3u8')) return new Response(MEDIA);
      return target.pathname.startsWith('/error/') ? new Response('private upstream failure', { status: 502 })
        : new Response('<html>not video</html>', { headers: { 'Content-Type': 'video/mp2t' } });
    }));
    const auto = await GET(request());
    expect(auto.status).toBe(502);
    expect(await auto.text()).not.toContain('private');
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.streams).toHaveLength(3);
    expect(body.recommendedStreamId).toBeUndefined();
    expect(body.streams.every((stream) => stream.startupLatencyMs === undefined)).toBe(true);
  });

  it('cancels a Range-ignoring media body after at most the bounded startup prefix', async () => {
    const cancel = vi.fn();
    const boundedBytes = new Uint8Array(256 * 1024);
    boundedBytes.set(BYTES);
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['bounded']);
      if (target.pathname.endsWith('master.m3u8')) return new Response(MEDIA);
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-262143');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(boundedBytes); }, cancel }), {
        headers: { 'Content-Length': '1000000000' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request())).status).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['AES-128', 'SAMPLE-AES'])('falls back to a playable %s manifest without benchmarking keys or inventing latency', async (method) => {
    const fetchMock = vi.fn(async (url: unknown) => new URL(String(url)).pathname === '/api/resolve'
      ? resolution(['encrypted']) : new Response(String(url).endsWith('secret.key') ? new Uint8Array(16)
        : `#EXTM3U\n#EXT-X-KEY:METHOD=${method},URI="secret.key"\n#EXTINF:6,\nsegment.ts`));
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-vidnest-stream-id')).toBe('0');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const playlist = await response.text();
    expect(playlist).toContain(`#EXT-X-KEY:METHOD=${method},URI="/api/vidnest?token=`);
    const keyPath = /URI="([^"]+)"/.exec(playlist)![1]!;
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.streams[0]!.startupLatencyMs).toBeUndefined();
    expect(body.recommendedStreamId).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('.key'))).toBe(false);
    expect((await GET(request())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const key = await GET(proxyRequest(keyPath));
    expect(key.status).toBe(200);
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('https://cdn.example/encrypted/secret.key');
    expect((await key.arrayBuffer()).byteLength).toBe(16);
  });

  it.each([
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="hvc1.1.6.L93"\nvideo.m3u8',
    '#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:100\nvideo.mp4',
    '#EXTM3U\n#EXT-X-PART:DURATION=0.5,URI="part.m4s"',
  ])('preserves non-probeable valid HLS without assigning latency or recommending it (%s)', async (playlist) => {
    const fetchMock = vi.fn(async (url: unknown) => new URL(String(url)).pathname === '/api/resolve'
      ? resolution(['compatible']) : new Response(playlist));
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('/api/vidnest?token=');
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
    expect(body.streams[0]!.startupLatencyMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back for unsupported binary media formats without measuring them as verified fast video', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['audio']);
      if (target.pathname.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXTINF:6,\nsegment.aac');
      return new Response(new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 0x00]), { headers: { 'Content-Type': 'audio/aac' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request())).status).toBe(200);
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
    expect(body.streams[0]!.startupLatencyMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reuses the captured master when its valid rendition is encrypted, without fetching keys or media', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['master']);
      return new Response(target.pathname.endsWith('master.m3u8') ? master()
        : '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts');
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('#EXT-X-STREAM-INF:');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([url]) => /key\.bin|segment\.ts/.test(String(url)))).toBe(false);
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
    expect(body.streams[0]!.startupLatencyMs).toBeUndefined();
  });

  it('does not fall back when startup data is a JSON error containing non-ASCII bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['error']);
      return new Response(target.pathname.endsWith('master.m3u8') ? MEDIA : JSON.stringify({ error: '\u00e9chec' }));
    }));
    expect((await GET(request())).status).toBe(502);
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
  });

  it('prefers a verified fast candidate over an already captured encrypted fallback', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['encrypted', 'fast']);
      if (target.pathname.startsWith('/encrypted/')) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(target.pathname.endsWith('master.m3u8') ? master() : target.pathname.endsWith('video.m3u8') ? MEDIA : BYTES);
    }));
    const pending = GET(request());
    let done = false;
    void pending.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(59);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await pending).headers.get('x-vidnest-stream-id')).toBe('1');
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBe('1');
    expect(body.streams.map((stream) => stream.startupLatencyMs)).toEqual([undefined, 60]);
  });

  it('uses the first captured valid manifest only after no healthy probe succeeds within the bound', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['slow', 'encrypted']);
      if (target.pathname.startsWith('/encrypted/')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts');
      }
      if (target.pathname.endsWith('master.m3u8')) return new Response(MEDIA);
      return new Promise<Response>(() => undefined);
    }));
    const pending = GET(request());
    let done = false;
    void pending.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('x-vidnest-stream-id')).toBe('0');
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
    expect(body.streams.every((stream) => stream.startupLatencyMs === undefined)).toBe(true);
  });

  it.each([
    '#EXTM3U', '<html>error</html>',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nhttps://private.internal/segment.ts',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://localhost/key.bin"\n#EXTINF:6,\nsegment.ts',
  ])('never uses signature-only, HTML, or unsafe private references as compatibility fallback (%s)', async (playlist) => {
    const fetchMock = vi.fn(async (url: unknown) => new URL(String(url)).pathname === '/api/resolve'
      ? resolution(['invalid']) : new Response(playlist, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request())).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
  });

  it('does not publish a healthy result arriving after the candidate deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['late']);
      if (target.pathname.endsWith('master.m3u8')) return new Response(MEDIA);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return new Response(BYTES);
    }));
    const pending = GET(request());
    await vi.advanceTimersByTimeAsync(4001);
    expect((await pending).status).toBe(200); // Manifest-only fallback, never a late measured recommendation.
    await vi.advanceTimersByTimeAsync(1000);
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
    expect(body.streams[0]!.startupLatencyMs).toBeUndefined();
  });

  it('probes fMP4 initialization and media byte ranges without fetching whole resources', async () => {
    const ranges: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['mp4']);
      if (target.pathname.endsWith('master.m3u8')) return new Response([
        '#EXTM3U', '#EXT-X-MAP:URI="video.mp4",BYTERANGE="800@0"', '#EXTINF:6,', '#EXT-X-BYTERANGE:2048@800', 'video.mp4',
      ].join('\n'));
      const range = new Headers(init?.headers).get('range')!;
      ranges.push(range);
      const offset = range === 'bytes=0-799' ? 0 : 800;
      const bytes = new Uint8Array(offset ? 1024 : 800);
      bytes.set(new TextEncoder().encode(offset ? 'moof' : 'ftyp'), 4);
      return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes ${offset}-${offset + bytes.length - 1}/5000` } });
    }));
    expect((await GET(request())).status).toBe(200);
    expect(ranges).toEqual(['bytes=0-799', 'bytes=800-2847']);
  });

  it('rejects unsafe startup redirects before requesting the insecure destination', async () => {
    const fetchMock = vi.fn(async (url: unknown) => new URL(String(url)).pathname === '/api/resolve'
      ? resolution(['redirect']) : new Response(null, { status: 302, headers: { Location: 'http://insecure.example/movie.m3u8' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request())).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('http:'))).toBe(false);
  });

  it.each(['https://localhost/master.m3u8', 'https://10.0.0.1/master.m3u8', 'https://[::1]/master.m3u8', 'https://8.8.8.8/master.m3u8'])(
    'never benchmarks private, loopback, or literal-IP resolver targets (%s)', async (target) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ streams: [{ url: target }] })));
      vi.stubGlobal('fetch', fetchMock);
      expect((await GET(request())).status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = await (await GET(request('metadata'))).json() as Catalog;
      expect(body.recommendedStreamId).toBeUndefined();
    },
  );

  it('validates every HTTPS redirect target before following it', async () => {
    const fetchMock = vi.fn(async (url: unknown) => new URL(String(url)).pathname === '/api/resolve'
      ? resolution(['redirect']) : new Response(null, { status: 307, headers: { Location: 'https://private.internal/master.m3u8' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(request())).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('private.internal'))).toBe(false);
  });

  it('rejects an incorrect ranged startup offset instead of timing unrelated bytes as healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return resolution(['offset']);
      if (target.pathname.endsWith('master.m3u8')) return new Response('#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:2048@800\nsegment.ts');
      return new Response(BYTES, { status: 206, headers: { 'Content-Range': 'bytes 0-1023/5000' } });
    }));
    expect((await GET(request())).status).toBe(502);
    const body = await (await GET(request('metadata'))).json() as Catalog;
    expect(body.recommendedStreamId).toBeUndefined();
  });
});
