import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
let GET: typeof import('@/app/api/vidnest/route').GET;

const API_SECRET = 'vidnest-test-secret-that-is-at-least-32-characters';
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

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

function proxyPaths(playlist: string): string[] {
  return playlist.match(/\/api\/vidnest\?token=[A-Za-z0-9._%-]+/g) ?? [];
}

async function followProxyPaths(playlist: string, fetchMock: ReturnType<typeof installFetch>) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  for (const path of proxyPaths(playlist)) {
    const request = new NextRequest(new URL(path, 'http://localhost'));
    expect(request.nextUrl.searchParams.get('token')).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/octet-stream' } }));
    const response = await GET(request);
    expect(response.status).toBe(200);
    const call = fetchMock.mock.calls.at(-1)!;
    requests.push({ url: String(call[0]), headers: new Headers((call[1] as RequestInit).headers) });
    await response.body?.cancel();
  }
  return requests;
}

function encryptedFixture(value: unknown, secret = API_SECRET, context = 'vidnest-proxy:aes-256-gcm:v1'): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHmac('sha256', secret).update(context).digest(), nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return ['v1', nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

function chunkedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

beforeEach(async () => {
  vi.resetModules();
  GET = (await import('@/app/api/vidnest/route')).GET;
  vi.stubEnv('VIDNEST_API_SECRET', API_SECRET);
  vi.stubEnv('VIDNEST_API_URL', 'https://resolver.example');
  vi.stubEnv('VIDNEST_CDN_BASE_URL', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Vidnest proxy transport', () => {
  it('uses a validated optional CDN endpoint while keeping Worker-to-origin child URLs same-origin', async () => {
    vi.stubEnv('VIDNEST_CDN_BASE_URL', 'https://vidnest-edge.example/media');
    const fetchMock = installFetch('https://third-party.example/master.m3u8', new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n', {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }), {
      origin: 'https://player.example',
      referer: 'https://player.example/watch',
    });

    const response = await GET(playbackRequest());
    const playlist = await response.text();
    const edgeLine = playlist.split(/\r?\n/).find((line) => line.startsWith('https://vidnest-edge.example/'));
    expect(edgeLine).toBeDefined();
    const edgeUrl = new URL(edgeLine!);
    expect(edgeUrl.pathname).toBe('/media');
    expect(edgeUrl.searchParams.get('token')).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(playlist).not.toMatch(/third-party\.example|player\.example|referer|origin/);

    fetchMock.mockResolvedValueOnce(new Response('#EXTM3U\n#EXTINF:6,\nnested.ts\n', {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }));
    const originResponse = await GET(new NextRequest(`https://app.example/api/vidnest?token=${encodeURIComponent(edgeUrl.searchParams.get('token')!)}`));
    const originPlaylist = await originResponse.text();
    expect(originPlaylist).toContain('/api/vidnest?token=');
    expect(originPlaylist).not.toContain('vidnest-edge.example');
  });

  it.each([
    'http://vidnest-edge.example/media',
    'https://user:password@vidnest-edge.example/media',
    'https://vidnest-edge.example/media?unsafe=1',
    'https://vidnest-edge.example/not-media',
    'https://localhost/media',
  ])('keeps the existing same-origin fallback for an invalid CDN URL: %s', async (cdnUrl) => {
    vi.stubEnv('VIDNEST_CDN_BASE_URL', cdnUrl);
    installFetch('https://third-party.example/master.m3u8', new Response('#EXTM3U\nsegment.ts\n', {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }));

    const response = await GET(playbackRequest());
    const playlist = await response.text();

    expect(playlist).toContain('/api/vidnest?token=');
    expect(playlist).not.toContain('vidnest-edge.example');
  });

  it('serves one fixed rendition to native clients while preserving alternate audio', async () => {
    const master = [
      '#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="a"', 'hd.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,AUDIO="a"', 'uhd.m3u8',
    ].join('\n');
    const token = encryptedFixture({ expiresAt: Date.now() + 60_000, url: 'https://cdn.example/master.m3u8', headers: {} });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(master, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })));
    const response = await GET(new NextRequest(`https://app.example/api/vidnest?token=${token}&rendition=1`));
    expect(response.status).toBe(200);
    const playlist = await response.text();
    expect(playlist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
    expect(playlist).toContain('RESOLUTION=3840x2160');
    expect(playlist).toContain('TYPE=AUDIO');
    expect(playlist).not.toContain('RESOLUTION=1280x720');
    expect((await GET(new NextRequest('https://app.example/api/vidnest?tmdbId=27205&type=movie&rendition=1'))).status).toBe(400);
  });

  it.each(['bytes=0-1', 'bytes=12-13'])('classifies opaque ranged HLS from a complete response (%s)', async (range) => {
    const upstreamUrl = 'https://cdn.example/opaque';
    const fetchMock = installFetch(upstreamUrl, responseAt(range === 'bytes=0-1' ? '#E' : 'F:', {
      status: 206,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-1/40' },
    }, upstreamUrl));
    fetchMock.mockResolvedValueOnce(responseAt('#EXTM3U\n#EXTINF:6,\nsegment.ts\n', {
      headers: { 'Content-Type': 'application/octet-stream' },
    }, upstreamUrl));

    const response = await GET(playbackRequest({ Range: range }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(response.headers.get('content-range')).toBeNull();
    const playlist = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Headers((fetchMock.mock.calls[2]![1] as RequestInit).headers).get('range')).toBeNull();
    expect((await followProxyPaths(playlist, fetchMock)).map((request) => request.url)).toEqual(['https://cdn.example/segment.ts']);
  });

  it('accepts mixed-case provider headers without widening the allowlist', async () => {
    const fetchMock = installFetch('https://cdn.example/master.m3u8', new Response('#EXTM3U\nsegment.ts\n'), {
      Referer: 'https://player.example/watch',
      ORIGIN: 'https://player.example',
      Authorization: 'Bearer private',
      Cookie: 'private=1',
    });

    const response = await GET(playbackRequest());

    expect(response.status).toBe(200);
    const headers = new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers);
    expect(headers.get('referer')).toBe('https://player.example/watch');
    expect(headers.get('origin')).toBe('https://player.example');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('corrects a valid MPEG-TS segment mislabeled as HTML without changing bytes', async () => {
    const segment = new Uint8Array(188 * 3);
    segment[0] = segment[188] = segment[376] = 0x47;
    installFetch('https://cdn.example/opaque', new Response(segment, {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    }));

    const response = await GET(playbackRequest());

    expect(response.headers.get('content-type')).toBe('video/mp2t');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(segment);
  });

  it('does not forward an encoded content length for an already-decoded media body', async () => {
    const media = new Uint8Array(128);
    installFetch('https://cdn.example/media', new Response(media, {
      headers: { 'Content-Type': 'video/mp4', 'Content-Encoding': 'gzip', 'Content-Length': '32' },
    }));

    const response = await GET(playbackRequest());

    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(media);
  });

  it('keeps ambiguous binary range bytes intact after classifying the complete resource', async () => {
    const media = new Uint8Array([2, 3, 4, 5]);
    const fetchMock = installFetch('https://cdn.example/opaque', new Response(media, {
      status: 206,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 2-5/10' },
    }));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(10), {
      headers: { 'Content-Type': 'application/octet-stream' },
    }));

    const response = await GET(playbackRequest({ Range: 'bytes=2-5' }));

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(media);
  });

  it('refetches ranged playlists in full before rewriting and returns 200', async () => {
    const upstreamUrl = 'https://cdn.example/master.m3u8';
    const fetchMock = installFetch(upstreamUrl, responseAt('#EXTM3U\n#EXTINF:', {
      status: 206,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Range': 'bytes 0-15/80' },
    }, upstreamUrl));
    fetchMock.mockResolvedValueOnce(responseAt('#EXTM3U\n#EXTINF:6,\nsegment.ts\n', {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }, upstreamUrl));

    const response = await GET(playbackRequest({ Range: 'bytes=0-15', 'If-Range': '"manifest-v1"' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    const playlist = await response.text();
    const fullFetchHeaders = new Headers((fetchMock.mock.calls[2]![1] as RequestInit).headers);
    expect(fullFetchHeaders.get('range')).toBeNull();
    expect(fullFetchHeaders.get('if-range')).toBeNull();
    expect((await followProxyPaths(playlist, fetchMock)).map((request) => request.url)).toEqual(['https://cdn.example/segment.ts']);
  });

  it('preserves an unsatisfiable media range and its length metadata', async () => {
    installFetch('https://cdn.example/media', new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */10' },
    }));

    const response = await GET(playbackRequest({ Range: 'bytes=10-' }));

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
  });

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
    vi.useFakeTimers();
    const issuedAt = new Date('2026-10-25T12:00:00Z').getTime();
    vi.setSystemTime(issuedAt);
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
    const fetchMock = installFetch('https://origin.example/opaque', upstream, {
      origin: 'https://player.example',
      referer: 'https://player.example/watch',
    });
    const response = await GET(playbackRequest());
    const rewritten = await response.text();
    const requests = await followProxyPaths(rewritten, fetchMock);

    expect(response.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(requests.map((request) => request.url)).toEqual([
      'https://redirected.example/final/keys/key.bin',
      'https://redirected.example/segments/one.ts',
    ]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.get('referer')).toBe('https://player.example/watch');
      expect(request.headers.get('origin')).toBe('https://player.example');
    }
    vi.setSystemTime(issuedAt + FOUR_HOURS_MS - 1);
    expect(await followProxyPaths(rewritten, fetchMock)).toHaveLength(2);
    vi.setSystemTime(issuedAt + FOUR_HOURS_MS);
    const before = fetchMock.mock.calls.length;
    for (const path of proxyPaths(rewritten)) expect((await GET(new NextRequest(new URL(path, 'http://localhost')))).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(before);
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
    const fetchMock = installFetch('https://cdn.example/live/opaque', upstream);

    const response = await GET(playbackRequest());
    const rewritten = await response.text();
    const [request] = await followProxyPaths(rewritten, fetchMock);

    expect(response.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(request?.url).toBe('https://cdn.example/live/segment.ts');
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

    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe(String(expected.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
  });
});

describe('VidNest authenticated encrypted capabilities', () => {
  async function issuedCapability() {
    const fetchMock = installFetch('https://cdn.example/master.m3u8', new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts'), {
      referer: 'https://player.example/watch', origin: 'https://player.example',
    });
    const response = await GET(playbackRequest());
    const path = proxyPaths(await response.text())[0]!;
    return { fetchMock, path, token: new URL(path, 'http://localhost').searchParams.get('token')! };
  }

  it('uses distinct random nonces and never puts URLs or provider headers in the public payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    installFetch('https://cdn.example/master.m3u8', new Response('#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXTINF:6,\nsegment.ts'), {
      referer: 'https://player.example/watch', origin: 'https://player.example',
    });
    const response = await GET(playbackRequest());
    const playlist = await response.text();
    const tokens = proxyPaths(playlist).map((path) => new URL(path, 'http://localhost').searchParams.get('token')!);
    expect(tokens).toHaveLength(2);
    expect(tokens[0] === tokens[1]).toBe(false);
    expect(tokens[0]!.split('.')[1] === tokens[1]!.split('.')[1]).toBe(false);
    expect(playlist).not.toMatch(/cdn\.example|player\.example|"headers"/);
    for (const token of tokens) {
      expect(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(token)).toBe(true);
      const ciphertext = Buffer.from(token.split('.')[2]!, 'base64url');
      for (const privateValue of ['https://cdn.example/segment.ts', 'https://player.example/watch', '"headers"', '"expiresAt"']) {
        expect(ciphertext.includes(Buffer.from(privateValue))).toBe(false);
      }
      expect(() => JSON.parse(ciphertext.toString('utf8'))).toThrow();
    }
  });

  it.each([1, 2, 3])('rejects tampering with encrypted token component %i before contacting upstream', async (index) => {
    const { fetchMock, token } = await issuedCapability();
    const parts = token.split('.');
    const changed = Buffer.from(parts[index]!, 'base64url'); changed[0] = changed[0]! ^ 1;
    parts[index] = changed.toString('base64url');
    const before = fetchMock.mock.calls.length;
    const response = await GET(new NextRequest(`http://localhost/api/vidnest?token=${parts.join('.')}`));
    expect(response.status).toBe(403);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(before);
  });

  it('rejects secret rotation and a different HMAC/AAD context without exposing a decrypt helper', async () => {
    const { fetchMock, path } = await issuedCapability();
    const before = fetchMock.mock.calls.length;
    vi.stubEnv('VIDNEST_API_SECRET', 'rotated-vidnest-test-secret-at-least-32-characters');
    expect((await GET(new NextRequest(new URL(path, 'http://localhost')))).status).toBe(403);
    vi.stubEnv('VIDNEST_API_SECRET', API_SECRET);
    const token = encryptedFixture({ expiresAt: Date.now() + 60_000, url: 'https://cdn.example/segment.ts', headers: {} }, API_SECRET, 'another-capability-context');
    expect((await GET(new NextRequest(`http://localhost/api/vidnest?token=${token}`))).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(before);
  });

  it('rejects unknown versions, malformed encodings, wrong nonce/tag sizes, and legacy signed plaintext', async () => {
    const value = { expiresAt: Date.now() + 60_000, url: 'https://cdn.example/segment.ts', headers: {} };
    const token = encryptedFixture(value);
    const parts = token.split('.');
    const replace = (index: number, value: string) => parts.map((part, position) => position === index ? value : part).join('.');
    const tag = parts[3]!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const noncanonicalTag = tag.slice(0, -1) + alphabet[(alphabet.indexOf(tag.at(-1)!) + 1) % 64];
    const plaintext = Buffer.from(JSON.stringify(value)).toString('base64url');
    const oldKey = createHmac('sha256', API_SECRET).update('vidnest-proxy').digest();
    const legacy = `${plaintext}.${createHmac('sha256', oldKey).update(plaintext).digest('base64url')}`;
    const invalid = [replace(0, 'v2'), `${token}.extra`, parts.slice(0, 3).join('.'), replace(1, '*'),
      replace(1, Buffer.alloc(11).toString('base64url')), replace(2, ''), replace(3, Buffer.alloc(15).toString('base64url')),
      replace(3, noncanonicalTag), legacy];
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const token of invalid) expect((await GET(new NextRequest(`http://localhost/api/vidnest?token=${encodeURIComponent(token)}`))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'HTTP URL', patch: { url: 'http://cdn.example/segment.ts' } },
    { name: 'embedded URL credentials', patch: { url: 'https://user:password@cdn.example/segment.ts' } },
    { name: 'newline URL', patch: { url: 'https://cdn.example/segment.ts\n' } },
    { name: 'expired', patch: { expiresAt: 0 } },
    { name: 'non-numeric expiry', patch: { expiresAt: 'tomorrow' } },
    { name: 'fractional expiry', patch: { expiresAt: 1.5 } },
    { name: 'absent headers', patch: { headers: null } },
    { name: 'array headers', patch: { headers: [] } },
    { name: 'cookie header', patch: { headers: { cookie: 'private=1' } } },
    { name: 'HTTP referer', patch: { headers: { referer: 'http://player.example' } } },
    { name: 'newline origin', patch: { headers: { origin: 'https://player.example\r\nCookie: private' } } },
    { name: 'object header', patch: { headers: { referer: {} } } },
    { name: 'header URL credentials', patch: { headers: { origin: 'https://user:password@player.example' } } },
  ])('rejects authenticated but invalid decrypted payload: $name', async ({ patch }) => {
    const token = encryptedFixture({ expiresAt: Date.now() + 60_000, url: 'https://cdn.example/segment.ts', headers: {}, ...patch });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new NextRequest(`http://localhost/api/vidnest?token=${token}`));
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects lifetimes longer than four hours and non-object authenticated payloads', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    for (const value of [null, [], 'not-a-capability', {
      expiresAt: Date.now() + FOUR_HOURS_MS + 1, url: 'https://cdn.example/segment.ts', headers: {},
    }]) {
      const response = await GET(new NextRequest(`http://localhost/api/vidnest?token=${encryptedFixture(value)}`));
      expect(response.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
