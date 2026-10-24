import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/vidnest/route';

const API_SECRET = 'vidnest-test-secret-that-is-at-least-32-characters';
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

type TokenPayload = {
  expiresAt: number;
  headers: Record<string, string>;
  url: string;
};

function playbackRequest(headers?: HeadersInit): NextRequest {
  return new NextRequest('http://localhost/api/vidnest?tmdbId=27205&type=movie', { headers });
}

function responseAt(body: BodyInit, init: ResponseInit, url: string): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function installFetch(upstreamUrl: string, upstreamResponse: Response, streamHeaders: Record<string, string> = {}) {
  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    streams: [{
      url: upstreamUrl,
      headers: streamHeaders,
    }],
  }), { headers: { 'Content-Type': 'application/json' } }));
  fetchMock.mockResolvedValueOnce(upstreamResponse);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function decodeProxyPaths(playlist: string): TokenPayload[] {
  const paths = playlist.match(/\/api\/vidnest\?token=[A-Za-z0-9._%-]+/g) ?? [];
  return paths.map((path) => {
    const token = new URL(path, 'http://localhost').searchParams.get('token');
    if (!token) throw new Error('Expected a signed proxy token.');
    const encoded = token.split('.')[0];
    if (!encoded) throw new Error('Expected an encoded proxy payload.');
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
  });
}

function chunkedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.stubEnv('VIDNEST_API_SECRET', API_SECRET);
  vi.stubEnv('VIDNEST_API_URL', 'https://resolver.example');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Vidnest proxy transport', () => {
  it('forwards range validators and preserves a 206 response with media metadata', async () => {
    const media = new Uint8Array([2, 3, 4, 5]);
    const upstream = responseAt(media, {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(media.byteLength),
        'Content-Range': 'bytes 2-5/10',
        'Content-Type': 'video/mp4',
        ETag: '"media-v1"',
        'Last-Modified': 'Sat, 24 Oct 2026 16:00:00 GMT',
      },
    }, 'https://cdn.example/media');
    const fetchMock = installFetch('https://origin.example/media', upstream, {
      authorization: 'Bearer must-not-be-forwarded',
      origin: 'https://player.example',
      referer: 'https://player.example/watch',
    });

    const response = await GET(playbackRequest({ Range: 'bytes=2-5', 'If-Range': '"media-v1"' }));

    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(media);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response.headers.get('etag')).toBe('"media-v1"');
    expect(response.headers.get('last-modified')).toBe('Sat, 24 Oct 2026 16:00:00 GMT');

    const upstreamInit = fetchMock.mock.calls[1]![1] as RequestInit;
    const headers = new Headers(upstreamInit.headers);
    expect(headers.get('range')).toBe('bytes=2-5');
    expect(headers.get('if-range')).toBe('"media-v1"');
    expect(headers.get('origin')).toBe('https://player.example');
    expect(headers.get('referer')).toBe('https://player.example/watch');
    expect(headers.get('authorization')).toBeNull();
  });

  it('uses the redirected response URL for same-origin playlist children with four-hour tokens', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
      '#EXTINF:6,',
      '../segments/one.ts',
      '',
    ].join('\n');
    const upstream = responseAt(playlist, {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }, 'https://redirected.example/final/master');
    installFetch('https://origin.example/opaque', upstream, {
      origin: 'https://player.example',
      referer: 'https://player.example/watch',
    });
    const before = Date.now();

    const response = await GET(playbackRequest());
    const rewritten = await response.text();
    const payloads = decodeProxyPaths(rewritten);
    const after = Date.now();

    expect(response.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(payloads.map((payload) => payload.url)).toEqual([
      'https://redirected.example/final/keys/key.bin',
      'https://redirected.example/segments/one.ts',
    ]);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.expiresAt).toBeGreaterThanOrEqual(before + FOUR_HOURS_MS);
      expect(payload.expiresAt).toBeLessThanOrEqual(after + FOUR_HOURS_MS);
      expect(payload.headers).toEqual({
        referer: 'https://player.example/watch',
        origin: 'https://player.example',
      });
    }
  });

  it('detects a chunked extensionless HLS body by its EXTM3U signature', async () => {
    const encoder = new TextEncoder();
    const upstream = responseAt(chunkedBody([
      encoder.encode('#EX'),
      encoder.encode('TM3U\n#EXTINF:6,\n'),
      encoder.encode('segment.ts\n'),
    ]), {
      headers: { 'Content-Type': 'application/octet-stream' },
    }, 'https://cdn.example/live/opaque');
    installFetch('https://cdn.example/live/opaque', upstream);

    const response = await GET(playbackRequest());
    const rewritten = await response.text();
    const [payload] = decodeProxyPaths(rewritten);

    expect(response.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(payload?.url).toBe('https://cdn.example/live/segment.ts');
  });

  it('replays probed bytes without corrupting an extensionless non-playlist stream', async () => {
    const first = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const second = new Uint8Array([109, 112, 52, 50, 1, 2, 3, 4]);
    const expected = new Uint8Array([...first, ...second]);
    const upstream = responseAt(chunkedBody([first, second]), {
      headers: {
        'Content-Length': String(expected.byteLength),
        'Content-Type': 'application/octet-stream',
      },
    }, 'https://cdn.example/media/opaque');
    installFetch('https://cdn.example/media/opaque', upstream);

    const response = await GET(playbackRequest());

    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(expected.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
  });
});
