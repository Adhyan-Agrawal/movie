import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const upstream = vi.fn();
const request = (query: string) => new NextRequest(`https://app.example/api/intro?${query}`);

function segment(start = 2.5, end = 58) {
  return {
    start_sec: start,
    end_sec: end,
    start_ms: start * 1000,
    end_ms: end * 1000,
    confidence: 0.92,
    submission_count: 14,
    updated_at: '2026-09-12T21:03:17.409Z',
  };
}

function payload(intro: ReturnType<typeof segment> | null = segment(), noIntro = false) {
  return {
    imdb_id: 'tt0944947',
    media_type: 'tv',
    is_movie: false,
    season: 0,
    episode: 1,
    intro,
    recap: null,
    outro: null,
    post_credits: null,
    no_intro: noIntro,
    no_recap: false,
    no_outro: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let route: typeof import('@/app/api/intro/route');

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  upstream.mockReset();
  vi.stubGlobal('fetch', upstream);
  route = await import('@/app/api/intro/route');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET /api/intro', () => {
  it('is GET-only and rejects invalid or user-directed requests before any network call', async () => {
    expect((route as unknown as Record<string, unknown>).POST).toBeUndefined();
    for (const query of [
      'type=movie&imdbId=tt0944947&season=0&episode=1',
      'type=tv&imdbId=not-imdb&season=0&episode=1',
      'type=tv&imdbId=tt0944947&season=-1&episode=1',
      'type=tv&imdbId=tt0944947&season=0&episode=0',
      'type=tv&imdbId=tt0944947&season=0&episode=1&url=https%3A%2F%2Fevil.test',
    ]) {
      const response = await route.GET(request(query));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ intro: null });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('returns only the normalized fractional marker and caches a verified hit', async () => {
    upstream.mockResolvedValue(jsonResponse(payload(segment(0, 31.75))));
    const query = 'type=tv&imdbId=tt0944947&season=0&episode=1';
    const first = await route.GET(request(query));
    const second = await route.GET(request(query));
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const firstBody = await first.json();
    expect(firstBody).toEqual({ intro: { startSeconds: 0, endSeconds: 31.75 } });
    expect(await second.json()).toEqual({ intro: { startSeconds: 0, endSeconds: 31.75 } });
    expect(upstream).toHaveBeenCalledTimes(1);
    const providerUrl = new URL(String(upstream.mock.calls[0]![0]));
    expect(providerUrl.href).toBe('https://api.introdb.app/segments?imdb_id=tt0944947&season=0&episode=1');
    const serialized = JSON.stringify(firstBody);
    for (const secret of ['imdb_id', 'start_sec', 'start_ms', 'confidence', 'submission_count', 'updated_at', 'api.introdb.app']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('caches explicit no-intro but does not cache an unknown null result', async () => {
    upstream.mockResolvedValue(jsonResponse(payload(null, true)));
    const query = 'type=tv&imdbId=tt0944947&season=0&episode=1';
    expect(await (await route.GET(request(query))).json()).toEqual({ intro: null });
    expect(await (await route.GET(request(query))).json()).toEqual({ intro: null });
    expect(upstream).toHaveBeenCalledTimes(1);

    vi.resetModules();
    route = await import('@/app/api/intro/route');
    upstream.mockReset().mockResolvedValue(jsonResponse(payload(null, false)));
    expect(await (await route.GET(request(query))).json()).toEqual({ intro: null });
    expect(await (await route.GET(request(query))).json()).toEqual({ intro: null });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['rate limiting', () => jsonResponse({ error: 'rate limited', limit: 10 }, 429)],
    ['malformed schema', () => jsonResponse({ ...payload(), intro: { start_sec: 1, end_sec: 2 } })],
    ['reversed marker', () => jsonResponse(payload(segment(60, 30)))],
    ['non-finite marker', () => new Response(JSON.stringify(payload()).replace('58', '1e400'), { headers: { 'Content-Type': 'application/json' } })],
    ['oversized body', () => new Response(' '.repeat(64 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })],
  ])('degrades %s to safe public null, backs off briefly, then retries', async (_label, response) => {
    vi.useFakeTimers();
    upstream.mockImplementation(async () => response());
    const query = 'type=tv&imdbId=tt0944947&season=0&episode=1';
    const first = await route.GET(request(query));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ intro: null });
    expect(await (await route.GET(request(query))).json()).toEqual({ intro: null });
    expect(upstream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await (await route.GET(request(query))).json()).toEqual({ intro: null });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('enforces one four-second total timeout and returns public uncertainty', async () => {
    vi.useFakeTimers();
    upstream.mockImplementation(async (_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const pending = route.GET(request('type=tv&imdbId=tt0944947&season=0&episode=1'));
    await vi.advanceTimersByTimeAsync(3_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).json()).toEqual({ intro: null });
    const retry = route.GET(request('type=tv&imdbId=tt0944947&season=0&episode=1'));
    expect(await (await retry).json()).toEqual({ intro: null });
    expect(upstream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    const afterBackoff = route.GET(request('type=tv&imdbId=tt0944947&season=0&episode=1'));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await (await afterBackoff).json()).toEqual({ intro: null });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
