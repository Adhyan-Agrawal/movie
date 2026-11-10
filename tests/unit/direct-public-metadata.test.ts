import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Title } from '@/features/catalog/types';
import type { Person, PersonCredit } from '@/features/people/types';

const mocks = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const require = createRequire(import.meta.url);
  const react = require(join(dirname(require.resolve('react/package.json')), 'react.react-server.js')) as {
    cache: typeof import('react').cache;
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      A: { getCacheForType: (factory: () => unknown) => unknown } | null;
    };
  };
  return {
    react, features: { tmdbConfigured: true, supabaseConfigured: true },
    title: vi.fn(), person: vi.fn(), credits: vi.fn(), search: vi.fn(),
    publicClient: vi.fn(), serverClient: vi.fn(), serviceClient: vi.fn(),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('react', () => ({ cache: mocks.react.cache }));
vi.mock('@/lib/env', () => ({
  features: mocks.features,
  serverEnv: () => ({ TMDB_API_BASE_URL: 'https://tmdb.fixture/3', TMDB_API_KEY: 'synthetic-test-only' }),
  publicEnv: { NEXT_PUBLIC_APP_URL: 'https://app.fixture', NEXT_PUBLIC_APP_NAME: 'Lumora' },
}));
vi.mock('@/features/catalog/repository', () => ({
  repoGetTitleById: mocks.title, repoGetTitleBySlug: mocks.title, repoGetPerson: mocks.person,
  repoListPersonCredits: mocks.credits, repoSearchPeople: mocks.search,
}));
vi.mock('@/lib/supabase/public', () => ({ getSupabasePublicClient: mocks.publicClient }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.serverClient }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.serviceClient }));
vi.mock('next/image', () => ({ default: 'img' }));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/ui/Container', () => ({ Container: 'main' }));
vi.mock('@/components/ui/EmptyState', () => ({ EmptyState: 'empty-state' }));
vi.mock('@/components/ui/Button', () => ({ buttonClasses: () => 'button' }));
vi.mock('@/components/ui/Icon', () => ({ Icon: 'svg' }));
vi.mock('@/components/ui/SectionReveal', () => ({ SectionReveal: 'div' }));
vi.mock('@/features/catalog/components/MediaCard', () => ({ MediaCard: 'media-card' }));

import { clearTmdbPublicDataCache, getTmdbPerson, getTmdbTitle, getTmdbTitleById, tmdbCast } from '@/features/catalog/tmdb-catalog';
import { getTitleById, getTitleBySlug, listTitles, listTitlesPage, listAllGenres } from '@/features/catalog/queries';
import { getPerson, getPersonCredits, isPersonId, searchPeople } from '@/features/people/queries';
import PersonPage, { generateMetadata } from '@/app/person/[id]/page';

const fetchMock = vi.fn<typeof fetch>();
const uuid = '00000000-0000-4000-8000-000000000001';
const movie = {
  id: 100, title: 'Actual film', original_title: 'Original film', overview: 'An actual synopsis.',
  release_date: '2024-01-01', runtime: 107, vote_average: 7.8, original_language: 'hi',
  poster_path: '/film.jpg', backdrop_path: '/film-backdrop.jpg', imdb_id: 'tt1234567',
  genres: [{ id: 18, name: 'Drama' }], production_countries: [{ iso_3166_1: 'IN' }],
  release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] },
  credits: { cast: [{ id: 7, name: 'Actual person', character: 'Lead', known_for_department: 'Acting', profile_path: '/actor.jpg' }] },
  videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, key: 'abc12345678' }] },
};
const series = {
  id: 200, name: 'Actual series', original_name: 'Original series', overview: 'An actual series synopsis.',
  first_air_date: '2023-02-01', episode_run_time: [42], vote_average: 8.1, original_language: 'ko',
  genres: [{ id: 18, name: 'Drama' }], origin_country: ['KR'],
  content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
  external_ids: { imdb_id: 'tt7654321' },
};
const person = {
  id: 7, name: 'Actual person', known_for_department: 'Acting', profile_path: '/actor.jpg',
  biography: 'PRIVATE biography is not a card field',
  combined_credits: {
    cast: [{ id: 100, media_type: 'movie', title: 'Actual film', release_date: '2024-01-01', poster_path: '/film.jpg', vote_average: 7.8, character: 'Lead', overview: 'PRIVATE long synopsis', order: 2 }],
    crew: [{ id: 200, media_type: 'tv', name: 'Actual series', first_air_date: '2023-02-01', job: 'Director', department: 'PRIVATE department' }],
  },
};
const legacyTitle: Title = {
  id: uuid, type: 'movie', slug: 'database-owned-100', name: 'Editorial film', synopsis: 'Editorial synopsis',
  maturity: 'PG', releaseYear: 2020, score: 99, featured: true, genres: ['Editorial genre'], tmdbId: '100',
};
const legacyPerson: Person = { id: uuid, name: 'Database person', knownFor: 'Editorial blurb', profileUrl: null };
const legacyCredits: PersonCredit[] = [{ title: legacyTitle, creditType: 'crew', character: null, job: 'Director', creditOrder: 4 }];

function newRequest() {
  const roots = new Map<() => unknown, unknown>();
  mocks.react.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = {
    getCacheForType(factory) {
      if (!roots.has(factory)) roots.set(factory, factory());
      return roots.get(factory);
    },
  };
}

function publicOnly() {
  for (const fn of [mocks.title, mocks.person, mocks.credits, mocks.publicClient, mocks.serverClient, mocks.serviceClient]) expect(fn).not.toHaveBeenCalled();
}

type Element = { type: unknown; props: Record<string, unknown> };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  const children = typeof element.type === 'function' ? element.type(element.props) : element.props.children;
  return [element, ...elements(children)];
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTmdbPublicDataCache();
  newRequest();
  mocks.features.tmdbConfigured = true;
  mocks.features.supabaseConfigured = true;
  mocks.title.mockResolvedValue(legacyTitle);
  mocks.person.mockResolvedValue(legacyPerson);
  mocks.credits.mockResolvedValue(legacyCredits);
  mocks.search.mockResolvedValue([legacyPerson]);
  for (const fn of [mocks.publicClient, mocks.serverClient, mocks.serviceClient]) fn.mockImplementation(() => { throw new Error('Supabase is forbidden for public virtual reads'); });
  fetchMock.mockReset().mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/3/movie/100') return Response.json(movie);
    if (path === '/3/tv/200') return Response.json(series);
    if (path === '/3/person/7') return Response.json(person);
    throw new Error(`Unexpected fixture path: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  clearTmdbPublicDataCache();
  mocks.react.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('canonical direct public title identities', () => {
  it('serves canonical provider URLs with zero database reads on success and failure', async () => {
    expect(await getTitleBySlug('movie', 'tmdb-100')).toMatchObject({ id: 'tmdb:movie:100', slug: 'tmdb-100' });
    publicOnly();
    clearTmdbPublicDataCache(); newRequest();
    fetchMock.mockRejectedValue(new Error('Synthetic provider unavailable'));
    await expect(getTitleBySlug('tv', 'tmdb-200')).rejects.toThrow();
    publicOnly();
  });

  it('never turns public provider outages into database lists, searches or genre replicas', async () => {
    fetchMock.mockRejectedValue(new Error('Synthetic provider unavailable'));
    await expect(listTitles({ type: 'movie', limit: 20 })).rejects.toThrow();
    await expect(listTitles({ query: 'Actual film', limit: 20 })).rejects.toThrow();
    await expect(listTitlesPage({ type: 'tv' }, 1, 20)).rejects.toThrow();
    expect(await listAllGenres()).toEqual([]);
    publicOnly();
  });

  it('preserves owned pretty URLs and only falls back for the exact shipped provider title', async () => {
    expect(await getTitleBySlug('movie', 'database-owned-100')).toEqual(legacyTitle);
    expect(fetchMock).not.toHaveBeenCalled();
    mocks.title.mockResolvedValue(null);
    expect(await getTitleBySlug('movie', 'actual-film-100')).toMatchObject({ id: 'tmdb:movie:100', slug: 'tmdb-100' });
    expect(await getTitleBySlug('movie', 'private-title-100')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['tmdb-0', 'tmdb-01', 'tmdb-10000000000', 'tmdb-private'])('does no I/O for invalid reserved provider URL %s', async (slug) => {
    expect(await getTitleBySlug('movie', slug)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); publicOnly();
  });

  it('uses the actual movie and TV detail mapper, with no Supabase reads even when configured', async () => {
    expect(await getTitleById('tmdb:movie:100')).toMatchObject({
      id: 'tmdb:movie:100', name: 'Actual film', slug: 'tmdb-100', originalName: 'Original film',
      synopsis: movie.overview, releaseYear: 2024, runtimeMinutes: 107, maturity: 'R', score: 78,
      genres: ['Drama'], originalLanguage: 'hi', originCountries: ['IN'], imdbId: 'tt1234567',
      trailerUrl: 'https://www.youtube.com/watch?v=abc12345678',
    });
    expect(await getTitleById('tmdb:tv:200')).toMatchObject({
      id: 'tmdb:tv:200', type: 'tv', name: 'Actual series', slug: 'tmdb-200', runtimeMinutes: 42,
      maturity: 'TV-MA', score: 81, originalLanguage: 'ko', originCountries: ['KR'], imdbId: 'tt7654321',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    publicOnly();
  });

  it('works without Supabase and shares one request with slug metadata and appended cast', async () => {
    mocks.features.supabaseConfigured = false;
    const read = getTitleById('tmdb:movie:100');
    expect(getTitleById('tmdb:movie:100')).toBe(read);
    const [title, slugTitle] = await Promise.all([read, getTmdbTitle('movie', 'actual-film-100')]);
    expect(title).toEqual(slugTitle);
    expect((await tmdbCast(title!))[0]?.personId).toBe('tmdb:person:7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    publicOnly();
  });

  it.each(['tmdb:movie:0', 'tmdb:movie:01', 'tmdb:tv:-1', 'tmdb:tv:1.5', 'tmdb:movie:10000000000', 'tmdb:movie:1:extra', 'tmdb:person:7', 'tmdb:movie:100\n', 'tmdb:tv:200\r\n', 'tmdb:movie:1/credits', 'tmdb:movie:1?x=1'])('rejects malformed virtual identity %j before any I/O', async (id) => {
    expect(await getTitleById(id)).toBeNull();
    expect(await getTmdbTitleById(id)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    publicOnly();
  });

  it.each(['TMDB:movie:100', ' tmdb:movie:100', 'database-owned-100', '100'])('does not infer a canonical provider identity from %j', async (id) => {
    expect(await getTmdbTitleById(id)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fall back to Supabase when TMDB is unavailable or disabled', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Fixture upstream failure'));
    await expect(getTitleById('tmdb:movie:100')).rejects.toThrow('Fixture upstream failure');
    newRequest();
    expect((await getTitleById('tmdb:movie:100'))?.name).toBe('Actual film');
    clearTmdbPublicDataCache();
    newRequest();
    mocks.features.tmdbConfigured = false;
    expect(await getTitleById('tmdb:movie:100')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    publicOnly();
  });

  it('distinguishes provider-confirmed missing titles from invalid success payloads', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    expect(await getTitleById('tmdb:movie:100')).toBeNull();
    newRequest();
    fetchMock.mockResolvedValueOnce(Response.json({ ...movie, id: 101 }));
    await expect(getTitleById('tmdb:movie:100')).rejects.toThrow('invalid payload');
    newRequest();
    expect((await getTitleById('tmdb:movie:100'))?.id).toBe('tmdb:movie:100');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    publicOnly();
  });

  it('keeps UUID-owned editorial data and numeric-suffix slugs in the original repository branch', async () => {
    const read = getTitleById(uuid);
    expect(getTitleById(uuid)).toBe(read);
    expect(await read).toBe(legacyTitle);
    expect(mocks.title).toHaveBeenCalledExactlyOnceWith(uuid);
    expect(fetchMock).not.toHaveBeenCalled();
    newRequest();
    mocks.title.mockResolvedValue(null);
    expect(await getTitleById(uuid)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('one bounded direct person response', () => {
  it('shares metadata, page, profile and compact cast/crew credits within an RSC request', async () => {
    const params = Promise.resolve({ id: 'tmdb:person:7' });
    const [metadata, page, profile, credits] = await Promise.all([generateMetadata({ params }), PersonPage({ params }), getPerson('tmdb:person:7'), getPersonCredits('tmdb:person:7')]);
    expect(metadata).toMatchObject({ title: 'Actual person', alternates: { canonical: 'https://app.fixture/person/tmdb:person:7' } });
    expect(profile).toEqual({ id: 'tmdb:person:7', name: 'Actual person', knownFor: 'Acting', profileUrl: 'https://image.tmdb.org/t/p/w185/actor.jpg' });
    expect(credits).toEqual([
      { title: { id: 'tmdb:movie:100', type: 'movie', slug: 'tmdb-100', name: 'Actual film', synopsis: '', releaseYear: 2024, maturity: 'PG-13', genres: [], posterUrl: 'https://image.tmdb.org/t/p/w500/film.jpg', score: 78, tmdbId: '100' }, creditType: 'cast', character: 'Lead', job: null, creditOrder: 2 },
      { title: { id: 'tmdb:tv:200', type: 'tv', slug: 'tmdb-200', name: 'Actual series', synopsis: '', releaseYear: 2023, maturity: 'TV-14', genres: [], tmdbId: '200' }, creditType: 'crew', character: null, job: 'Director', creditOrder: 0 },
    ]);
    const nodes = elements(page);
    expect(nodes.some((node) => node.type === 'a' && node.props.href === '/title/movie/tmdb-100')).toBe(true);
    expect(nodes.filter((node) => node.type === 'media-card').every((node) => node.props.showMaturity === false)).toBe(true);
    expect(JSON.stringify(credits)).not.toContain('PRIVATE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/3/person/7');
    expect(new URL(String(url)).searchParams.get('append_to_response')).toBe('combined_credits');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', headers: { accept: 'application/json' }, next: { revalidate: 21_600, tags: ['tmdb-public', 'tmdb:person:7'] } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    publicOnly();
  });

  it.each(['tmdb:person:0', 'tmdb:person:07', 'tmdb:person:-7', 'tmdb:person:7.0', 'tmdb:person:10000000000', 'tmdb:person:7:credits', 'tmdb:person:7\n', 'tmdb:person:7\r\n', 'tmdb:person:7/credits', 'tmdb:movie:7', 'TMDB:person:7', ' tmdb:person:7', '7'])('rejects malformed person identity %j in query and route guards', async (id) => {
    expect(isPersonId(id)).toBe(false);
    expect(await getPerson(id)).toBeNull();
    expect(await getPersonCredits(id)).toEqual([]);
    expect(await getTmdbPerson(id)).toBeNull();
    expect(await generateMetadata({ params: Promise.resolve({ id }) })).toMatchObject({ robots: { index: false, follow: false } });
    await expect(PersonPage({ params: Promise.resolve({ id }) })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(fetchMock).not.toHaveBeenCalled();
    publicOnly();
  });

  it('bounds names, roles and results, deduplicates exact roles, and skips invalid/adult/non-title credits', async () => {
    const cast = Array.from({ length: 90 }, (_, index) => ({ ...person.combined_credits.cast[0], id: index + 1, title: 'T'.repeat(2000), character: '\u0000Lead\n' + 'C'.repeat(1000) }));
    const crew = Array.from({ length: 90 }, (_, index) => ({ ...person.combined_credits.crew[0], id: index + 1, name: 'N'.repeat(2000), job: 'J'.repeat(1000) }));
    fetchMock.mockResolvedValueOnce(Response.json({ ...person, name: 'P'.repeat(2000), known_for_department: 'K'.repeat(1000), combined_credits: { cast: [null, { ...cast[0], id: 0 }, { ...cast[0], id: '1' }, { ...cast[0], media_type: 'person' }, { ...cast[0], adult: true }, cast[0], cast[0], ...cast], crew } }));
    const result = await getTmdbPerson('tmdb:person:7');
    expect(result?.person.name).toHaveLength(200);
    expect(result?.person.knownFor).toHaveLength(80);
    expect(result?.credits).toHaveLength(120);
    expect(result?.credits.filter((credit) => credit.creditType === 'cast')).toHaveLength(60);
    expect(result?.credits.filter((credit) => credit.creditType === 'crew')).toHaveLength(60);
    for (const credit of result!.credits) {
      expect(credit.title.name.length).toBeLessThanOrEqual(200);
      expect(credit.character?.length ?? 0).toBeLessThanOrEqual(160);
      expect(credit.job?.length ?? 0).toBeLessThanOrEqual(80);
      expect(credit.character ?? '').not.toMatch(/\p{Cc}/u);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    publicOnly();
  });

  it('keeps valid dual roles without retaining arbitrary URLs, ratings or detail fields', async () => {
    const lead = person.combined_credits.cast[0]!;
    fetchMock.mockResolvedValueOnce(Response.json({ ...person, profile_path: 'https://private.fixture/actor', combined_credits: { cast: [lead, lead, { ...lead, character: 'Second role', poster_path: 'https://private.fixture/poster', vote_average: 11 }], crew: person.combined_credits.crew } }));
    const result = await getTmdbPerson('tmdb:person:7');
    expect(result?.person.profileUrl).toBeNull();
    expect(result?.credits.filter((credit) => credit.title.id === 'tmdb:movie:100')).toHaveLength(2);
    const second = result?.credits[1]?.title;
    expect(second).not.toHaveProperty('posterUrl');
    expect(second).not.toHaveProperty('score');
    expect(second).not.toHaveProperty('trailerUrl');
    expect(second).not.toHaveProperty('backdropUrl');
    publicOnly();
  });

  it.each([null, {}, { ...person, id: 8 }, { ...person, name: 7 }, { ...person, name: '\u0000 ' }, { ...person, combined_credits: undefined }, { ...person, combined_credits: { cast: [], crew: null } }])('rejects invalid person/append payloads and retries on the next request: %j', async (payload) => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    await expect(getPerson('tmdb:person:7')).rejects.toThrow('invalid payload');
    await expect(getPersonCredits('tmdb:person:7')).rejects.toThrow('invalid payload');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    newRequest();
    expect((await getPerson('tmdb:person:7'))?.name).toBe('Actual person');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    publicOnly();
  });

  it.each([401, 429, 503, 302])('propagates HTTP %i without anonymous DB fallback or a persistent error cache', async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status }));
    await expect(generateMetadata({ params: Promise.resolve({ id: 'tmdb:person:7' }) })).rejects.toThrow(`responded ${status}`);
    await expect(PersonPage({ params: Promise.resolve({ id: 'tmdb:person:7' }) })).rejects.toThrow(`responded ${status}`);
    newRequest();
    expect((await getPersonCredits('tmdb:person:7'))).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    publicOnly();
  });

  it('distinguishes a missing person from a real person with an empty filmography', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    expect(await getPerson('tmdb:person:7')).toBeNull();
    expect(await getPersonCredits('tmdb:person:7')).toEqual([]);
    newRequest();
    fetchMock.mockResolvedValueOnce(Response.json({ ...person, combined_credits: { cast: [], crew: [] } }));
    expect((await getPerson('tmdb:person:7'))?.name).toBe('Actual person');
    const nodes = elements(await PersonPage({ params: Promise.resolve({ id: 'tmdb:person:7' }) }));
    expect(nodes.find((node) => node.type === 'empty-state')?.props.description).toContain('available from TMDB');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    publicOnly();
  });

  it.each(['content-length', 'stream'])('enforces the 1 MiB person response bound for %s and releases failed reads', async (mode) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(mode === 'stream' ? 1_048_577 : 1)); }, cancel });
    fetchMock.mockResolvedValueOnce(new Response(body, mode === 'content-length' ? { headers: { 'content-length': '1048577' } } : undefined));
    await expect(getTmdbPerson('tmdb:person:7')).rejects.toThrow('byte limit');
    expect(cancel).toHaveBeenCalledTimes(1);
    newRequest();
    expect((await getPerson('tmdb:person:7'))?.name).toBe('Actual person');
    publicOnly();
  });
});

describe('request and settled cache boundaries', () => {
  it('coalesces only public Node I/O across renders without reading private repositories', async () => {
    const pending: Array<(value: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const first = getTmdbTitleById('tmdb:movie:100');
    newRequest();
    const second = getTmdbTitleById('tmdb:movie:100');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pending.forEach((resolve) => resolve(Response.json(movie)));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    newRequest();
    expect((await getTitleById('tmdb:movie:100'))?.name).toBe('Actual film');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    publicOnly();
  });

  it('shares only settled public person data between requests and expires its stale failure allowance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    expect((await getPerson('tmdb:person:7'))?.name).toBe('Actual person');
    newRequest();
    mocks.features.supabaseConfigured = false;
    expect(await getPersonCredits('tmdb:person:7')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(21_600_000);
    newRequest();
    fetchMock.mockRejectedValue(new Error('Fixture upstream offline'));
    expect((await getPerson('tmdb:person:7'))?.name).toBe('Actual person');
    newRequest();
    expect(await getPersonCredits('tmdb:person:7')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(86_400_001);
    newRequest();
    await expect(getPerson('tmdb:person:7')).rejects.toThrow('Fixture upstream offline');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    publicOnly();
  });

  it('keeps the existing six-second provider deadline and recovers after an aborted person request', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('Fixture aborted')), { once: true });
    }));
    const read = getTmdbPerson('tmdb:person:7');
    const rejected = expect(read).rejects.toThrow('Fixture aborted');
    await vi.advanceTimersByTimeAsync(6_000);
    await rejected;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(6_000);
    newRequest();
    expect((await getPerson('tmdb:person:7'))?.name).toBe('Actual person');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    publicOnly();
  });

  it('preserves UUID person metadata/page reuse, editorial credits, request isolation and DB error behavior', async () => {
    const params = Promise.resolve({ id: uuid });
    const [metadata, page] = await Promise.all([generateMetadata({ params }), PersonPage({ params })]);
    expect(metadata.title).toBe('Database person');
    expect(elements(page).find((node) => node.type === 'media-card')?.props.title).toBe(legacyTitle);
    expect(mocks.person).toHaveBeenCalledExactlyOnceWith(uuid);
    expect(mocks.credits).toHaveBeenCalledExactlyOnceWith(uuid);
    expect(fetchMock).not.toHaveBeenCalled();
    newRequest();
    mocks.person.mockRejectedValue(new Error('Fixture RLS read failure'));
    mocks.credits.mockRejectedValue(new Error('Fixture publication read failure'));
    mocks.title.mockRejectedValue(new Error('Fixture title read failure'));
    expect(await getPerson(uuid)).toBeNull();
    expect(await getPersonCredits(uuid)).toEqual([]);
    expect(await getTitleById(uuid)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it('preserves existing DB-only search and unavailable UUID results without fetching TMDB', async () => {
    expect(await searchPeople('  Database  ', 3)).toEqual([legacyPerson]);
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith('Database', 3);
    mocks.features.supabaseConfigured = false;
    expect(await getPerson(uuid)).toBeNull();
    expect(await getPersonCredits(uuid)).toEqual([]);
    expect(await getTitleById(uuid)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
