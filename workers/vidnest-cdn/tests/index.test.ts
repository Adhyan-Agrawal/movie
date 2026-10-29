import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleRequest,
  type EdgeCache,
  type Env,
  type WorkerExecutionContext,
  type WorkerServices,
} from '../src/index';

const SECRET = 'vidnest-worker-test-secret-at-least-32-characters';
const CONTEXT = 'vidnest-proxy:aes-256-gcm:v1';
const ENV: Env = {
  VIDNEST_API_SECRET: SECRET,
  VIDNEST_ORIGIN_URL: 'https://origin.example',
};

type Payload = { expiresAt: number; headers: Record<string, string>; url: string };

function capability(payload: Payload, secret = SECRET): string {
  const nonce = randomBytes(12);
  const key = createHmac('sha256', secret).update(CONTEXT).digest();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return ['v1', nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

function validPayload(url = 'https://third-party.example/video/segment.ts'): Payload {
  return {
    expiresAt: Date.now() + 60_000,
    headers: {
      origin: 'https://player.example',
      referer: 'https://player.example/watch',
    },
    url,
  };
}

function edgeRequest(token: string, init?: RequestInit, path = '/media'): Request {
  const url = new URL(path, 'https://edge.example');
  url.searchParams.set('token', token);
  return new Request(url, init);
}

class MemoryCache implements EdgeCache {
  readonly entries = new Map<string, Response>();
  matches = 0;
  puts = 0;

  async match(request: Request): Promise<Response | undefined> {
    this.matches++;
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.puts++;
    const body = await response.arrayBuffer();
    this.entries.set(request.url, new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }));
  }
}

class TestContext implements WorkerExecutionContext {
  readonly pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
}

function services(fetchMock: ReturnType<typeof vi.fn>, cache = new MemoryCache()): WorkerServices {
  return { cache, fetch: fetchMock as unknown as typeof fetch };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VidNest CDN Worker authorization and caching', () => {
  it('reuses one canonical media cache entry across capabilities with random nonces', async () => {
    const payload = validPayload();
    const firstToken = capability(payload);
    const secondToken = capability(payload);
    expect(firstToken).not.toBe(secondToken);
    const media = new Uint8Array([0x47, 1, 2, 3]);
    const fetchMock = vi.fn(async (input: Request) => {
      expect(input.url).toContain('/api/vidnest?token=v1.');
      expect(input.url).not.toContain('third-party.example');
      expect(input.headers.get('origin')).toBeNull();
      expect(input.headers.get('referer')).toBeNull();
      return new Response(media, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Length': String(media.byteLength),
          'Content-Type': 'video/mp2t',
        },
      });
    });
    const cache = new MemoryCache();
    const firstContext = new TestContext();
    const first = await handleRequest(edgeRequest(firstToken), ENV, firstContext, services(fetchMock, cache));
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(media);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    await firstContext.flush();

    const secondContext = new TestContext();
    const second = await handleRequest(edgeRequest(secondToken), ENV, secondContext, services(fetchMock, cache));
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(media);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.puts).toBe(1);
    expect(cache.entries.size).toBe(1);
    expect([...cache.entries.values()][0]!.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('denies expired and tampered capabilities before any cache lookup or origin fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
    const expired = capability({ ...validPayload(), expiresAt: Date.now() - 1 });
    const valid = capability(validPayload());
    const parts = valid.split('.');
    const changed = Buffer.from(parts[2]!, 'base64url');
    changed[0] = changed[0]! ^ 1;
    parts[2] = changed.toString('base64url');
    const cache = new MemoryCache();
    const fetchMock = vi.fn();

    for (const token of [expired, parts.join('.')]) {
      const response = await handleRequest(edgeRequest(token), ENV, new TestContext(), services(fetchMock, cache));
      expect(response.status).toBe(403);
    }
    expect(cache.matches).toBe(0);
    expect(cache.puts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks expiry again before serving an existing canonical cache entry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
    const payload = { ...validPayload(), expiresAt: Date.now() + 1_000 };
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), {
      headers: { 'Content-Length': '1', 'Content-Type': 'video/mp2t' },
    }));
    const cache = new MemoryCache();
    const context = new TestContext();
    const first = await handleRequest(edgeRequest(capability(payload)), ENV, context, services(fetchMock, cache));
    await first.arrayBuffer();
    await context.flush();
    expect(cache.matches).toBe(1);

    vi.setSystemTime(Date.now() + 1_001);
    const expired = await handleRequest(edgeRequest(capability(payload)), ENV, new TestContext(), services(fetchMock, cache));
    expect(expired.status).toBe(403);
    expect(cache.matches).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache keys, Set-Cookie responses, errors, or unbounded media', async () => {
    const cases = [
      {
        payload: validPayload('https://third-party.example/keys/content.key'),
        response: () => new Response(new Uint8Array(16), {
          headers: { 'Content-Length': '16', 'Content-Type': 'application/octet-stream' },
        }),
      },
      {
        payload: validPayload(),
        response: () => new Response(new Uint8Array([1]), {
          headers: { 'Content-Length': '1', 'Content-Type': 'video/mp2t', 'Set-Cookie': 'private=1' },
        }),
      },
      { payload: validPayload(), response: () => new Response('private failure detail', { status: 502 }) },
      { payload: validPayload(), response: () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp2t' } }) },
    ];

    for (const item of cases) {
      const cache = new MemoryCache();
      const fetchMock = vi.fn(async () => item.response());
      const response = await handleRequest(edgeRequest(capability(item.payload)), ENV, new TestContext(), services(fetchMock, cache));
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(cache.puts).toBe(0);
      if (!response.ok) expect(await response.text()).not.toContain('private failure detail');
      else await response.body?.cancel();
    }
  });

  it('caches bounded subtitle sidecars longer than manifests without making client caching bypass expiry', async () => {
    const body = 'WEBVTT\n\n00:00.000 --> 00:01.000\nCaption\n';
    const payload = validPayload('https://third-party.example/subtitles/en.vtt');
    const fetchMock = vi.fn(async () => new Response(body, {
      headers: { 'Content-Length': String(new TextEncoder().encode(body).byteLength), 'Content-Type': 'text/vtt' },
    }));
    const cache = new MemoryCache();
    const context = new TestContext();

    const response = await handleRequest(edgeRequest(capability(payload)), ENV, context, services(fetchMock, cache));
    expect(await response.text()).toBe(body);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await context.flush();
    expect([...cache.entries.values()][0]!.headers.get('cache-control')).toBe('public, max-age=3600');
  });
});

describe('VidNest CDN Worker transport', () => {
  it('preserves Range, If-Range, 206 and 416 without caching partial responses', async () => {
    const token = capability(validPayload());
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (input: Request) => {
        expect(input.method).toBe('GET');
        expect(input.headers.get('range')).toBe('bytes=2-5');
        expect(input.headers.get('if-range')).toBe('"media-v1"');
        return new Response(new Uint8Array([2, 3, 4, 5]), {
          status: 206,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': '4',
            'Content-Range': 'bytes 2-5/10',
            'Content-Type': 'video/mp4',
          },
        });
      })
      .mockImplementationOnce(async () => new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */10' },
      }));
    const cache = new MemoryCache();
    const ranged = await handleRequest(edgeRequest(token, {
      headers: { Range: 'bytes=2-5', 'If-Range': '"media-v1"' },
    }), ENV, new TestContext(), services(fetchMock, cache));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(ranged.headers.get('access-control-allow-origin')).toBe('*');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([2, 3, 4, 5]));

    const unsatisfied = await handleRequest(edgeRequest(token, { headers: { Range: 'bytes=10-' } }), ENV, new TestContext(), services(fetchMock, cache));
    expect(unsatisfied.status).toBe(416);
    expect(unsatisfied.headers.get('content-range')).toBe('bytes */10');
    expect(cache.matches).toBe(0);
    expect(cache.puts).toBe(0);
  });

  it('rewrites every protected manifest URI to the edge without leaking origin or upstream details', async () => {
    const rootPayload = validPayload('https://third-party.example/private/master.m3u8');
    const segment = capability(validPayload('https://third-party.example/private/segment.ts'));
    const key = capability(validPayload('https://third-party.example/private/key.bin'));
    const playlist = [
      '#EXTM3U',
      `#EXT-X-KEY:METHOD=AES-128,URI="https://origin.example/api/vidnest?token=${encodeURIComponent(key)}"`,
      '#EXTINF:6,',
      `/api/vidnest?token=${encodeURIComponent(segment)}`,
      '',
    ].join('\n');
    const fetchMock = vi.fn(async () => new Response(playlist, {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Set-Cookie': 'private=1' },
    }));
    const cache = new MemoryCache();
    const response = await handleRequest(edgeRequest(capability(rootPayload)), ENV, new TestContext(), services(fetchMock, cache));
    const rewritten = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(rewritten.match(/\/media\?token=/g)).toHaveLength(2);
    expect(rewritten).not.toContain('origin.example');
    expect(rewritten).not.toContain('third-party.example');
    expect(rewritten).not.toContain('player.example');
    expect(rewritten).not.toContain('referer');
    expect(cache.puts).toBe(0); // Any Set-Cookie header makes the representation ineligible.
  });

  it('briefly caches rewritten manifests and uses the origin proxy only on a cache miss', async () => {
    const payload = validPayload('https://third-party.example/private/master.m3u8');
    const child = capability(validPayload('https://third-party.example/private/segment.ts'));
    const playlist = `#EXTM3U\n#EXTINF:6,\n/api/vidnest?token=${encodeURIComponent(child)}\n`;
    const fetchMock = vi.fn(async (input: Request) => {
      expect(new URL(input.url).origin).toBe('https://origin.example');
      return new Response(playlist, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    });
    const cache = new MemoryCache();
    const context = new TestContext();
    const first = await handleRequest(edgeRequest(capability(payload)), ENV, context, services(fetchMock, cache));
    const firstBody = await first.text();
    await context.flush();
    const second = await handleRequest(edgeRequest(capability(payload)), ENV, new TestContext(), services(fetchMock, cache));

    expect(await second.text()).toBe(firstBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...cache.entries.values()][0]!.headers.get('cache-control')).toBe('public, max-age=10');
  });

  it('supports token-only HEAD and tokenless OPTIONS while forwarding cancellation to origin', async () => {
    const token = capability(validPayload());
    const controller = new AbortController();
    let originSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: Request) => {
      expect(input.method).toBe('HEAD');
      originSignal = input.signal;
      return new Response(null, { headers: { 'Content-Length': '100', 'Content-Type': 'video/mp4' } });
    });
    const cache = new MemoryCache();
    const head = await handleRequest(edgeRequest(token, { method: 'HEAD', signal: controller.signal }), ENV, new TestContext(), services(fetchMock, cache));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('100');
    expect(await head.text()).toBe('');
    expect(originSignal?.aborted).toBe(false);
    controller.abort();
    expect(originSignal?.aborted).toBe(true);

    const options = await handleRequest(new Request('https://edge.example/media', { method: 'OPTIONS' }), ENV, new TestContext(), services(fetchMock, cache));
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
    const denied = await handleRequest(new Request('https://edge.example/media'), ENV, new TestContext(), services(fetchMock, cache));
    expect(denied.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects caller-controlled paths before cache access or manifest capability rewriting', async () => {
    const token = capability(validPayload('https://third-party.example/private/master.m3u8'));
    const cache = new MemoryCache();
    const fetchMock = vi.fn();

    for (const path of ['/other', '/media/', '//attacker.example']) {
      const response = await handleRequest(edgeRequest(token, undefined, path), ENV, new TestContext(), services(fetchMock, cache));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(token);
    }
    expect(cache.matches).toBe(0);
    expect(cache.puts).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
