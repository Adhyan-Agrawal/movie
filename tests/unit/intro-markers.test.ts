import { describe, expect, it, vi } from 'vitest';
import {
  createIntroResolver,
  introCatalogPath,
  normalizeIntroDbResponse,
  parseIntroCatalogRequest,
  type IntroCatalogRequest,
} from '@/features/player/intro-markers';

const episode: IntroCatalogRequest = { type: 'tv', imdbId: 'tt0944947', season: 1, episode: 1 };

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

function providerPayload(input: IntroCatalogRequest = episode, intro: ReturnType<typeof segment> | null = segment(), noIntro = false) {
  return {
    imdb_id: input.imdbId,
    media_type: 'tv',
    is_movie: false,
    season: input.season,
    episode: input.episode,
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

describe('intro marker request and DTO normalization', () => {
  it('accepts canonical TV coordinates including season zero and builds only a relative same-origin path', () => {
    const parsed = parseIntroCatalogRequest(new URLSearchParams('type=tv&imdbId=tt0944947&season=0&episode=1'));
    expect(parsed).toEqual({ type: 'tv', imdbId: 'tt0944947', season: 0, episode: 1 });
    expect(introCatalogPath(parsed!)).toBe('/api/intro?type=tv&imdbId=tt0944947&season=0&episode=1');
  });

  it.each([
    'type=movie&imdbId=tt0944947&season=1&episode=1',
    'type=tv&imdbId=0944947&season=1&episode=1',
    'type=tv&imdbId=TT0944947&season=1&episode=1',
    'type=tv&imdbId=tt123456&season=1&episode=1',
    'type=tv&imdbId=tt0944947&season=-1&episode=1',
    'type=tv&imdbId=tt0944947&season=01&episode=1',
    'type=tv&imdbId=tt0944947&season=1000&episode=1',
    'type=tv&imdbId=tt0944947&season=1&episode=0',
    'type=tv&imdbId=tt0944947&season=1&episode=1000',
    'type=tv&imdbId=tt0944947&season=1.5&episode=2',
    'type=tv&imdbId=tt0944947&season=1&episode=2&target=https%3A%2F%2Fevil.test',
    'type=tv&type=tv&imdbId=tt0944947&season=1&episode=2',
  ])('rejects non-canonical or user-directed input: %s', (query) => {
    expect(parseIntroCatalogRequest(new URLSearchParams(query))).toBeNull();
  });

  it('preserves zero and fractional seconds but rejects reversed and non-finite markers', () => {
    expect(normalizeIntroDbResponse(providerPayload(episode, segment(0, 31.75)), episode)).toEqual({
      status: 'positive',
      intro: { startSeconds: 0, endSeconds: 31.75 },
    });
    expect(normalizeIntroDbResponse(providerPayload(episode, segment(60, 30)), episode).status).toBe('unavailable');
    expect(normalizeIntroDbResponse(providerPayload(episode, segment(0, Number.POSITIVE_INFINITY)), episode).status).toBe('unavailable');
  });

  it('distinguishes explicit no-intro, unknown, identity mismatch, and malformed provider schemas', () => {
    expect(normalizeIntroDbResponse(providerPayload(episode, null, true), episode)).toEqual({ status: 'no_intro', intro: null });
    expect(normalizeIntroDbResponse(providerPayload(episode, null, false), episode)).toEqual({ status: 'unknown', intro: null });
    expect(normalizeIntroDbResponse({ ...providerPayload(), episode: 2 }, episode).status).toBe('unavailable');
    expect(normalizeIntroDbResponse({ ...providerPayload(), raw_url: 'https://provider.test/private' }, episode).status).toBe('unavailable');
    expect(normalizeIntroDbResponse({ ...providerPayload(), no_intro: true }, episode).status).toBe('unavailable');
  });

  it('accepts optional segment timestamps but rejects inconsistent seconds and milliseconds', () => {
    const mixed = { ...providerPayload(), outro: segment(90, 100) };
    delete (mixed.outro as Partial<ReturnType<typeof segment>>).updated_at;
    expect(normalizeIntroDbResponse(mixed, episode)).toEqual({
      status: 'positive', intro: { startSeconds: 2.5, endSeconds: 58 },
    });

    const inconsistent = providerPayload();
    inconsistent.intro!.end_ms += 10;
    expect(normalizeIntroDbResponse(inconsistent, episode).status).toBe('unavailable');
  });
});

describe('IntroDB resolver cache policy', () => {
  it('uses only the fixed provider endpoint and isolates canonical episodes in its bounded cache', async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const inputEpisode: IntroCatalogRequest = {
        type: 'tv',
        imdbId: url.searchParams.get('imdb_id')!,
        season: Number(url.searchParams.get('season')),
        episode: Number(url.searchParams.get('episode')),
      };
      expect(url.origin + url.pathname).toBe('https://api.introdb.app/segments');
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit' });
      expect(init?.headers).toEqual({ Accept: 'application/json', 'Accept-Encoding': 'identity' });
      return jsonResponse(providerPayload(inputEpisode));
    });
    const resolver = createIntroResolver({ fetchImpl });

    await resolver.resolve(episode);
    await resolver.resolve({ ...episode });
    await resolver.resolve({ ...episode, episode: 2 });
    await resolver.resolve({ ...episode, imdbId: 'tt2861424' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('caches marker results, leaves uncertainty uncached, and briefly backs off provider failures', async () => {
    const calls = new Map<number, number>();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const number = Number(url.searchParams.get('episode'));
      calls.set(number, (calls.get(number) ?? 0) + 1);
      if (number === 1) return jsonResponse(providerPayload({ ...episode, episode: number }));
      if (number === 2) return jsonResponse(providerPayload({ ...episode, episode: number }, null, true));
      if (number === 3) return jsonResponse(providerPayload({ ...episode, episode: number }, null, false));
      if (number === 4) return jsonResponse({ malformed: true });
      return jsonResponse({ error: 'rate limited', reset_at: 'later' }, 429);
    });
    const resolver = createIntroResolver({ fetchImpl });

    for (const number of [1, 2, 3, 4, 5]) {
      await resolver.resolve({ ...episode, episode: number });
      await resolver.resolve({ ...episode, episode: number });
    }
    expect(calls).toEqual(new Map([[1, 1], [2, 1], [3, 2], [4, 1], [5, 1]]));
  });

  it('expires explicit no-intro sooner than a positive marker', async () => {
    let time = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const number = Number(new URL(String(input)).searchParams.get('episode'));
      const requestData = { ...episode, episode: number };
      return jsonResponse(providerPayload(requestData, number === 2 ? null : segment(), number === 2));
    });
    const resolver = createIntroResolver({ fetchImpl, now: () => time });
    await resolver.resolve(episode);
    await resolver.resolve({ ...episode, episode: 2 });

    time = 2 * 60 * 1000 + 1;
    await resolver.resolve(episode);
    await resolver.resolve({ ...episode, episode: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    time = 10 * 60 * 1000 + 1;
    await resolver.resolve(episode);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('bounds the positive cache and evicts the oldest canonical episode', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const number = Number(new URL(String(input)).searchParams.get('episode'));
      const requestData = { ...episode, episode: number };
      return jsonResponse(providerPayload(requestData));
    });
    const resolver = createIntroResolver({ fetchImpl });
    for (let number = 1; number <= 129; number += 1) {
      await resolver.resolve({ ...episode, episode: number });
    }
    await resolver.resolve(episode);
    expect(fetchImpl).toHaveBeenCalledTimes(130);
  });

  it('backs off an oversized response briefly and retries after the failure window', async () => {
    let time = 0;
    const fetchImpl = vi.fn(async () => new Response(' '.repeat(64 * 1024 + 1), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const resolver = createIntroResolver({ fetchImpl, now: () => time });
    await expect(resolver.resolve(episode)).resolves.toMatchObject({ status: 'unavailable', intro: null });
    await resolver.resolve(episode);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time = 5_001;
    await resolver.resolve(episode);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
