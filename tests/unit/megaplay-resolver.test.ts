import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMegaPlayResolver } from '@/features/megaplay/resolver';

const API_KEY = 'injected-tmdb-key';
const AES_KEY_TEXT = 'i?LMTAx0Q6,:}50U';
const AES_IV_TEXT = "W0;27ToaUpl_P%'c";

type Version = 'sub' | 'dub';
type FixtureValue = unknown | Response | Error;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

function tmdbTv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Example Anime',
    original_name: 'Example Anime',
    first_air_date: '2020-01-04',
    genres: [{ id: 16, name: 'Animation' }],
    seasons: [{
      season_number: 1,
      name: 'Season 1',
      air_date: '2020-01-04',
      episode_count: 26,
    }],
    ...overrides,
  };
}

function anime(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    type: 'ANIME',
    format: 'TV',
    episodes: 26,
    seasonYear: 2020,
    startDate: { year: 2020 },
    title: { english: 'Example Anime', romaji: 'Example Anime', native: 'Example Anime' },
    synonyms: [],
    ...overrides,
  };
}

function anilistPage(media: unknown[] = [anime()], hasNextPage = false): Record<string, unknown> {
  return {
    data: {
      Page: {
        pageInfo: { hasNextPage },
        media,
      },
    },
  };
}

function fixtureResponse(value: FixtureValue, fallback: unknown): Response {
  const selected = value === undefined ? fallback : value;
  if (selected instanceof Error) throw selected;
  return selected instanceof Response ? selected : json(selected);
}

function fixtureFetch({
  tmdb,
  anilist,
  pages = {},
  sources = {},
}: {
  tmdb?: FixtureValue;
  anilist?: FixtureValue;
  pages?: Partial<Record<Version, FixtureValue>>;
  sources?: Partial<Record<Version, FixtureValue>>;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode: error');
    expect(init?.redirect).toBe('manual');
    const url = new URL(String(input));
    if (url.hostname === 'api.themoviedb.org') return fixtureResponse(tmdb, tmdbTv());
    if (url.hostname === 'graphql.anilist.co') return fixtureResponse(anilist, anilistPage());
    if (url.hostname !== 'megaplay.buzz') throw new Error('Unexpected test endpoint.');

    const page = /^\/stream\/ani\/\d+\/\d+\/(sub|dub)$/.exec(url.pathname);
    if (page) {
      const version = page[1] as Version;
      const value = pages[version];
      if (value instanceof Error) throw value;
      if (value instanceof Response) return value;
      return new Response(typeof value === 'string' ? value : `<div data-id="${version === 'sub' ? '201' : '202'}"></div>`);
    }
    if (url.pathname === '/stream/getSourcesNew') {
      const version = url.searchParams.get('type') as Version;
      return fixtureResponse(sources[version], {
        sources: { file: `https://video.cdn-provider.net/${version}/master.m3u8` },
        tracks: [],
      });
    }
    throw new Error('Unexpected test request.');
  });
}

function paddedBytes(value: string, length: number): Uint8Array {
  const result = new Uint8Array(length);
  result.set(new TextEncoder().encode(value).subarray(0, length));
  return result;
}

async function encryptedPayload(value: unknown): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    paddedBytes(AES_KEY_TEXT, 32),
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: paddedBytes(AES_IV_TEXT, 16) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  ));
  return Buffer.from(ciphertext).toString('base64url');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('embedded MegaPlay resolver', () => {
  it('contains no hardcoded TMDB key and stays inert when the server key is absent', async () => {
    const source = await readFile(new URL('../../src/features/megaplay/resolver.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('1865f43a0549ca50d341dd9ab8b29f49');
    expect(source).not.toMatch(/\b[0-9a-f]{32}\b/i);
    expect(source).not.toContain('console.');

    const fetchImpl = vi.fn<FetchImplementation>();
    const resolver = createMegaPlayResolver({ fetchImpl, tmdbApiKey: '' });
    await expect(resolver({ tmdbId: '123', mediaType: 'tv', season: 1, episode: 1 })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns separate normalized sub and dub streams, including a valid encrypted payload', async () => {
    const encrypted = await encryptedPayload({
      sources: [{ file: 'https://video.cdn-provider.net/dub/master.m3u8' }],
    });
    const fetchImpl = fixtureFetch({
      sources: {
        sub: {
          sources: { file: 'https://video.cdn-provider.net/sub/master.m3u8' },
          tracks: [
            { kind: 'captions', file: 'https://subs.cdn-provider.net/en.vtt', label: 'English' },
            { kind: 'captions', file: 'https://subs.cdn-provider.net/es.vtt', label: 'Spanish' },
            { kind: 'captions', file: 'https://127.0.0.1/private.vtt', label: 'English' },
          ],
        },
        dub: {
          enc: encrypted,
          tracks: [{
            kind: 'captions',
            file: 'https://subs.cdn-provider.net/pt-br.vtt',
            label: 'Portuguese (Brazil)',
          }],
        },
      },
    });
    const resolver = createMegaPlayResolver({ fetchImpl, tmdbApiKey: API_KEY });

    const streams = await resolver({ tmdbId: '123', mediaType: 'tv', season: 1, episode: 2 });

    expect(streams).toEqual([
      {
        url: 'https://video.cdn-provider.net/sub/master.m3u8',
        type: 'hls',
        headers: { origin: 'https://megaplay.buzz', referer: 'https://megaplay.buzz/' },
        subtitles: [
          {
            url: 'https://subs.cdn-provider.net/en.vtt',
            language: 'en',
            label: 'English',
            kind: 'captions',
          },
          {
            url: 'https://subs.cdn-provider.net/es.vtt',
            language: 'es',
            label: 'Spanish',
            kind: 'captions',
          },
        ],
        audioLanguage: 'ja',
      },
      {
        url: 'https://video.cdn-provider.net/dub/master.m3u8',
        type: 'hls',
        headers: { origin: 'https://megaplay.buzz', referer: 'https://megaplay.buzz/' },
        subtitles: [{
          url: 'https://subs.cdn-provider.net/pt-br.vtt',
          language: 'pt-BR',
          label: 'Portuguese (Brazil)',
          kind: 'captions',
        }],
        audioLanguage: 'en',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(new URL(String(input)).protocol).toBe('https:');
      expect(['api.themoviedb.org', 'graphql.anilist.co', 'megaplay.buzz'])
        .toContain(new URL(String(input)).hostname);
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const tmdbUrl = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(tmdbUrl.searchParams.get('api_key')).toBe(API_KEY);
    const anilistInit = fetchImpl.mock.calls[1]![1]!;
    expect(JSON.parse(String(anilistInit.body))).toMatchObject({
      variables: { search: 'Example Anime', perPage: 10 },
    });
  });

  it('supports successful manual responses through the required Cloudflare global fetch receiver', async () => {
    const fixture = fixtureFetch();
    const fetchImpl = vi.fn(function platformFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return fixture(input, init);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const streams = await createMegaPlayResolver({ tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
    });
    expect(streams.map((stream) => stream.audioLanguage)).toEqual(['ja', 'en']);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it.each(['tmdb', 'anilist', 'page', 'sources'] as const)(
    'rejects and cancels every manual redirect at the %s stage without following Location',
    async (stage) => {
      for (const status of [301, 302, 303, 307, 308]) {
        const cancel = vi.fn();
        const redirect = new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status, headers: { Location: 'https://127.0.0.1/private' },
        });
        const fetchImpl = fixtureFetch({
          ...(stage === 'tmdb' ? { tmdb: redirect } : {}),
          ...(stage === 'anilist' ? { anilist: redirect } : {}),
          ...(stage === 'page' ? { pages: { sub: redirect } } : {}),
          ...(stage === 'sources' ? { sources: { sub: redirect } } : {}),
        });
        const streams = await createMegaPlayResolver({ fetchImpl, tmdbApiKey: API_KEY })({
          tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
        });
        expect(streams.map((stream) => stream.audioLanguage)).toEqual(
          stage === 'tmdb' || stage === 'anilist' ? [] : ['en'],
        );
        expect(fetchImpl).toHaveBeenCalledTimes({ tmdb: 1, anilist: 2, page: 5, sources: 6 }[stage]);
        expect(fetchImpl.mock.calls.every(([input]) => new URL(String(input)).hostname !== '127.0.0.1')).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('resolves an animated TMDB movie with the server TMDB_API_KEY', async () => {
    vi.stubEnv('TMDB_API_KEY', API_KEY);
    const fetchImpl = fixtureFetch({
      tmdb: {
        title: 'Example Anime Film',
        original_title: 'Example Anime Film',
        release_date: '2023-08-04',
        genres: [{ id: 16, name: 'Animation' }],
      },
      anilist: anilistPage([anime({
        id: 909,
        format: 'MOVIE',
        episodes: 1,
        seasonYear: 2023,
        startDate: { year: 2023 },
        title: { english: 'Example Anime Film', romaji: null, native: null },
      })]),
    });
    const resolver = createMegaPlayResolver({ fetchImpl });

    const streams = await resolver({ tmdbId: '456', mediaType: 'movie' });

    expect(streams).toHaveLength(2);
    expect(fetchImpl.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((path) => path.startsWith('/stream/ani/')))
      .toEqual(['/stream/ani/909/1/sub', '/stream/ani/909/1/dub']);
  });

  it('rejects a TMDB title that is not animation before consulting AniList', async () => {
    const fetchImpl = fixtureFetch({ tmdb: tmdbTv({ genres: [{ id: 18, name: 'Drama' }] }) });
    const resolver = createMegaPlayResolver({ fetchImpl, tmdbApiKey: API_KEY });

    await expect(resolver({ tmdbId: '123', mediaType: 'tv', season: 1, episode: 1 })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('selects only the exact AniList anime matching TMDB title, year, format, and season', async () => {
    const metadata = tmdbTv({
      seasons: [{
        season_number: 2,
        name: 'Season 2',
        air_date: '2022-04-01',
        episode_count: 12,
      }],
    });
    const exact = anime({
      id: 555,
      episodes: 12,
      seasonYear: 2022,
      startDate: { year: 2022 },
      title: { english: 'Example Anime Season 2', romaji: null, native: null },
    });
    const fetchImpl = fixtureFetch({
      tmdb: metadata,
      anilist: anilistPage([
        anime({ id: 1, seasonYear: 2021, title: { english: 'Example Anime Season 2' } }),
        anime({ id: 2, format: 'MOVIE', seasonYear: 2022, title: { english: 'Example Anime Season 2' } }),
        anime({ id: 3, seasonYear: 2022, title: { english: 'Example Anime Season 1' } }),
        anime({ id: 4, type: 'MANGA', seasonYear: 2022, title: { english: 'Example Anime Season 2' } }),
        exact,
      ]),
    });
    const resolver = createMegaPlayResolver({ fetchImpl, tmdbApiKey: API_KEY });

    const streams = await resolver({ tmdbId: '123', mediaType: 'tv', season: 2, episode: 3 });

    expect(streams).toHaveLength(2);
    const pagePaths = fetchImpl.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((path) => path.startsWith('/stream/ani/'));
    expect(pagePaths).toEqual(['/stream/ani/555/3/sub', '/stream/ani/555/3/dub']);
  });

  it('returns no streams when exact AniList matching is ambiguous', async () => {
    const fetchImpl = fixtureFetch({
      anilist: anilistPage([anime({ id: 101 }), anime({ id: 102 })]),
    });
    const resolver = createMegaPlayResolver({ fetchImpl, tmdbApiKey: API_KEY });

    await expect(resolver({ tmdbId: '123', mediaType: 'tv', season: 1, episode: 1 })).resolves.toEqual([]);
    expect(fetchImpl.mock.calls.some(([input]) => new URL(String(input)).hostname === 'megaplay.buzz')).toBe(false);
  });

  it('rejects out-of-range episodes using both TMDB and AniList counts', async () => {
    const tmdbBound = fixtureFetch({
      tmdb: tmdbTv({
        seasons: [{ season_number: 1, name: 'Season 1', air_date: '2020-01-04', episode_count: 12 }],
      }),
    });
    await expect(createMegaPlayResolver({ fetchImpl: tmdbBound, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 13,
    })).resolves.toEqual([]);
    expect(tmdbBound).toHaveBeenCalledTimes(1);

    const anilistBound = fixtureFetch({ anilist: anilistPage([anime({ episodes: 12 })]) });
    await expect(createMegaPlayResolver({ fetchImpl: anilistBound, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 13,
    })).resolves.toEqual([]);
    expect(anilistBound.mock.calls.some(([input]) => new URL(String(input)).hostname === 'megaplay.buzz')).toBe(false);
  });

  it('enforces response, AniList result, URL, track, and subtitle bounds', async () => {
    const oversized = fixtureFetch({
      tmdb: new Response('{}', { headers: { 'Content-Length': String(256 * 1024 + 1) } }),
    });
    await expect(createMegaPlayResolver({ fetchImpl: oversized, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
    })).resolves.toEqual([]);

    for (const anilist of [
      anilistPage([anime()], true),
      anilistPage(Array.from({ length: 11 }, (_, index) => anime({ id: index + 1 }))),
    ]) {
      const bounded = fixtureFetch({ anilist });
      await expect(createMegaPlayResolver({ fetchImpl: bounded, tmdbApiKey: API_KEY })({
        tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
      })).resolves.toEqual([]);
      expect(bounded.mock.calls.some(([input]) => new URL(String(input)).hostname === 'megaplay.buzz')).toBe(false);
    }

    const tracks = Array.from({ length: 60 }, (_, index) => ({
      kind: 'captions',
      file: `https://subs.cdn-provider.net/${index}.vtt`,
      label: index % 2 ? 'English' : 'Spanish',
    }));
    const capped = fixtureFetch({
      pages: { dub: new Response(null, { status: 404 }) },
      sources: {
        sub: {
          sources: { file: 'https://video.cdn-provider.net/sub/master.m3u8' },
          tracks,
        },
      },
    });
    const streams = await createMegaPlayResolver({ fetchImpl: capped, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
    });
    expect(streams).toHaveLength(1);
    expect(streams[0]?.subtitles).toHaveLength(24);

    const tooLongUrl = `https://video.cdn-provider.net/${'a'.repeat(4_096)}.m3u8`;
    const boundedUrl = fixtureFetch({
      sources: {
        sub: { sources: { file: tooLongUrl } },
        dub: { sources: { file: tooLongUrl } },
      },
    });
    await expect(createMegaPlayResolver({ fetchImpl: boundedUrl, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
    })).resolves.toEqual([]);
  });

  it('blocks redirects, hostile final response URLs, credentials, and IP-literal media URLs', async () => {
    const redirected = fixtureFetch({
      tmdb: new Response(null, {
        status: 302,
        headers: { Location: 'https://127.0.0.1/metadata' },
      }),
    });
    await expect(createMegaPlayResolver({ fetchImpl: redirected, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
    })).resolves.toEqual([]);
    expect(redirected).toHaveBeenCalledTimes(1);
    expect(redirected.mock.calls[0]?.[1]?.redirect).toBe('manual');

    const hostileFinal = json(tmdbTv());
    Object.defineProperty(hostileFinal, 'url', { value: 'https://127.0.0.1/metadata' });
    const hostileResponse = fixtureFetch({ tmdb: hostileFinal });
    await expect(createMegaPlayResolver({ fetchImpl: hostileResponse, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
    })).resolves.toEqual([]);

    const unsafeMedia = fixtureFetch({
      sources: {
        sub: {
          sources: { file: 'https://127.0.0.1/master.m3u8' },
          tracks: [{ kind: 'captions', file: 'https://192.168.1.2/sub.vtt', label: 'English' }],
        },
        dub: { sources: { file: 'https://user:password@video.cdn-provider.net/master.m3u8' } },
      },
    });
    await expect(createMegaPlayResolver({ fetchImpl: unsafeMedia, tmdbApiKey: API_KEY })({
      tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
    })).resolves.toEqual([]);
  });

  it('rejects malformed AES-CBC encoding, padding, and decrypted JSON schemas', async () => {
    const malformed = [
      'not*base64url',
      Buffer.alloc(16).toString('base64url'),
      await encryptedPayload({ file: 42 }),
    ];
    for (const enc of malformed) {
      const fetchImpl = fixtureFetch({
        pages: { dub: new Response(null, { status: 404 }) },
        sources: { sub: { enc } },
      });
      await expect(createMegaPlayResolver({ fetchImpl, tmdbApiKey: API_KEY })({
        tmdbId: '123', mediaType: 'tv', season: 1, episode: 1,
      })).resolves.toEqual([]);
    }
  });

  it('propagates both the total timeout and a caller abort to in-flight fetches', async () => {
    vi.useFakeTimers();
    let timeoutSignal: AbortSignal | undefined;
    const timedFetch = vi.fn<FetchImplementation>(async (_input, init) => {
      timeoutSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    const timed = createMegaPlayResolver({
      fetchImpl: timedFetch,
      tmdbApiKey: API_KEY,
      totalTimeoutMs: 50,
    })({ tmdbId: '123', mediaType: 'tv', season: 1, episode: 1 });
    const timedExpectation = expect(timed).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(51);
    await timedExpectation;
    expect(timeoutSignal?.aborted).toBe(true);

    let callerSignal: AbortSignal | undefined;
    const callerFetch = vi.fn<FetchImplementation>(async (_input, init) => {
      callerSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const aborted = createMegaPlayResolver({
      fetchImpl: callerFetch,
      tmdbApiKey: API_KEY,
      totalTimeoutMs: 5_000,
    })({ tmdbId: '123', mediaType: 'tv', season: 1, episode: 1, signal: controller.signal });
    const abortExpectation = expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await abortExpectation;
    expect(callerSignal?.aborted).toBe(true);
  });

  it('runs at most the sub and dub chains in parallel and isolates one chain failure', async () => {
    let activeProviderRequests = 0;
    let maxProviderRequests = 0;
    let pageStarts = 0;
    let releasePages!: () => void;
    const pagesStarted = new Promise<void>((resolve) => { releasePages = resolve; });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === 'api.themoviedb.org') return json(tmdbTv());
      if (url.hostname === 'graphql.anilist.co') return json(anilistPage());
      const page = /^\/stream\/ani\/\d+\/\d+\/(sub|dub)$/.exec(url.pathname);
      if (page) {
        activeProviderRequests += 1;
        maxProviderRequests = Math.max(maxProviderRequests, activeProviderRequests);
        pageStarts += 1;
        if (pageStarts === 2) releasePages();
        await pagesStarted;
        activeProviderRequests -= 1;
        if (page[1] === 'dub') throw new Error('Dub is unavailable.');
        return new Response('<div data-id="201"></div>');
      }
      if (url.pathname === '/stream/getSourcesNew') {
        return json({ sources: { file: 'https://video.cdn-provider.net/sub/master.m3u8' }, tracks: [] });
      }
      throw new Error('Unexpected test request.');
    });
    const resolver = createMegaPlayResolver({ fetchImpl, tmdbApiKey: API_KEY, totalTimeoutMs: 1_000 });

    await expect(resolver({ tmdbId: '123', mediaType: 'tv', season: 1, episode: 1 })).resolves.toEqual([{
      url: 'https://video.cdn-provider.net/sub/master.m3u8',
      type: 'hls',
      headers: { origin: 'https://megaplay.buzz', referer: 'https://megaplay.buzz/' },
      audioLanguage: 'ja',
    }]);
    expect(pageStarts).toBe(2);
    expect(maxProviderRequests).toBe(2);
  });
});
