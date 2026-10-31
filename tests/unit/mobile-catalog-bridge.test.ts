import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Title } from '../../mobile/src/lib/types';

const legacy = vi.hoisted(() => ({ fetchHome: vi.fn(), listTitles: vi.fn(), searchTitles: vi.fn(),
  getTitleBySlug: vi.fn(), listSeasons: vi.fn(), listCast: vi.fn() }));
vi.mock('../../mobile/src/lib/api', () => legacy);

const fetchMock = vi.fn<typeof fetch>();
const title: Title = { id: 'tmdb:movie:123', type: 'movie', slug: 'film-123', name: 'Film', synopsis: 'Synopsis',
  releaseYear: 2026, maturity: 'PG-13', genres: ['Drama'], originalLanguage: 'hi', originCountries: ['IN'], tmdbId: '123' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const bridge = () => import('../../mobile/src/lib/catalog-bridge');

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://catalog.example/');
  vi.stubGlobal('fetch', fetchMock);
  legacy.fetchHome.mockResolvedValue({ hero: [], rows: [] });
  legacy.listTitles.mockResolvedValue([]);
  legacy.searchTitles.mockResolvedValue([]);
  legacy.getTitleBySlug.mockResolvedValue(null);
  legacy.listSeasons.mockResolvedValue([]);
  legacy.listCast.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('public Android catalog bridge', () => {
  it('adapts rotating heroes and discovery metadata without personal or admin fields', async () => {
    const filters = { originalLanguage: 'hi', country: 'IN', admin: 'not-public' };
    fetchMock.mockResolvedValue(json({ hero: title, heroTitles: [title, { ...title, id: 'tmdb:tv:456', type: 'tv' }],
      rows: [{ id: 'hindi', collectionId: 'hindi-cinema', heading: 'Hindi cinema', href: '/browse?country=IN', filters,
        titles: [{ ...title, watchProgress: 30 }], accountId: 'not-public' }],
      collections: [{ id: 'hindi-cinema', label: 'Hindi cinema', href: '/browse?country=IN', filters }],
      signedIn: false, continueWatching: [], forYou: null, admin: 'not-public' }));
    const data = await (await bridge()).fetchHome();
    expect(data.hero).toHaveLength(2);
    expect(data.rows[0]).toEqual({ id: 'hindi', collectionId: 'hindi-cinema', heading: 'Hindi cinema',
      href: '/browse?country=IN', filters: { originalLanguage: 'hi', country: 'IN' }, titles: [title] });
    expect(Object.keys(data).sort()).toEqual(['collections', 'hero', 'rows']);
    expect(data.collections?.[0]?.filters).toEqual({ originalLanguage: 'hi', country: 'IN' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://catalog.example/api/catalog?view=home');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(init?.headers).toBeUndefined();
    expect(legacy.fetchHome).not.toHaveBeenCalled();
  });

  it.each([{ hero: title, heroTitles: [] }, { hero: null, heroTitles: [] }])('keeps a real single hero or honest empty catalog: %j', async (hero) => {
    fetchMock.mockResolvedValue(json({ ...hero, rows: [] }));
    expect((await (await bridge()).fetchHome()).hero).toEqual(hero.hero ? [title] : []);
  });

  it.each([{ signedIn: true }, { continueWatching: [{ title }] }, { forYou: { titles: [title] } }])('rejects cookie-dependent home fields: %j', async (personal) => {
    fetchMock.mockResolvedValue(json({ hero: title, rows: [], ...personal }));
    expect(await (await bridge()).fetchHome()).toEqual({ hero: [], rows: [] });
    expect(legacy.fetchHome).toHaveBeenCalledOnce();
  });

  it('never retains a home payload across refreshes', async () => {
    fetchMock.mockResolvedValueOnce(json({ hero: title, rows: [] })).mockResolvedValueOnce(json({ hero: null, rows: [] }));
    const api = await bridge();
    expect((await api.fetchHome()).hero).toEqual([title]);
    expect((await api.fetchHome()).hero).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes country, language OR, genre, query and paging without inventing discovery rules', async () => {
    fetchMock.mockResolvedValue(json({ titles: [title], total: 123, page: 2, pageSize: 30 }));
    const api = await bridge();
    expect(await api.listTitles({ type: 'movie', genre: 'Drama & Comedy', originalLanguage: 'ta|te|ml|kn',
      country: 'IN', sort: 'score', query: 'a & b', page: 2, pageSize: 30 })).toEqual([title]);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ type: 'movie', genre: 'Drama & Comedy',
      originalLanguage: 'ta|te|ml|kn', country: 'IN', sort: 'score', query: 'a & b', page: '2', limit: '30' });
    expect(legacy.listTitles).not.toHaveBeenCalled();
  });

  it.each(['trending', 'newest', 'oldest', 'az', 'score'] as const)('preserves supported public sort %s', async (sort) => {
    fetchMock.mockResolvedValue(json({ titles: [] }));
    await (await bridge()).listTitles({ sort });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('sort')).toBe(sort);
  });

  it('maps and bounds legacy pageSize to the public limit', async () => {
    fetchMock.mockImplementation(async () => json({ titles: [] }));
    const api = await bridge();
    await api.listTitles({ page: 0, pageSize: 1000 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('page=1&limit=100');
    await api.listTitles({ page: 1000, pageSize: 0 });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('page=100&limit=1');
  });

  it('searches via public query and does not issue an empty search', async () => {
    fetchMock.mockResolvedValue(json({ titles: [title] }));
    const api = await bridge();
    expect(await api.searchTitles('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await api.searchTitles('  Film  ')).toEqual([title]);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('query')).toBe('Film');
  });

  it('uses real legacy search instead of an unrelated trending fallback', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    legacy.searchTitles.mockResolvedValue([title]);
    expect(await (await bridge()).searchTitles('Film', 24)).toEqual([title]);
    expect(legacy.searchTitles).toHaveBeenCalledWith('Film', 24);
    expect(legacy.listTitles).not.toHaveBeenCalled();
  });

  it('does not pretend legacy DB data can answer country or combined query filters', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const api = await bridge();
    await expect(api.listTitles({ country: 'IN' })).rejects.toThrow('offline');
    await expect(api.listTitles({ query: 'Film', genre: 'Drama' })).rejects.toThrow('offline');
    expect(legacy.listTitles).not.toHaveBeenCalled();
    expect(legacy.searchTitles).not.toHaveBeenCalled();
  });

  it('deduplicates public row reads for 60 seconds and isolates filter cache keys', async () => {
    fetchMock.mockImplementation(async () => json({ titles: [title] }));
    const api = await bridge();
    await Promise.all([api.listTitles({ country: 'IN' }), api.listTitles({ country: 'IN' })]);
    await api.listTitles({ country: 'US' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_001);
    await api.listTitles({ country: 'IN' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('evicts failures immediately and never caches authenticated legacy fallback results', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(json({ titles: [title] }));
    legacy.listTitles.mockResolvedValue([{ ...title, name: 'Legacy' }]);
    const api = await bridge();
    expect((await api.listTitles())[0]?.name).toBe('Legacy');
    expect(await api.listTitles()).toEqual([title]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads virtual title, seasons and mobile-shaped cast in one public request', async () => {
    const tv = { ...title, id: 'tmdb:tv:456', type: 'tv' as const, slug: 'series-456' };
    const member = { personId: 'tmdb:person:789', name: 'Actor', character: 'Character', profileUrl: null };
    const episode = { id: 'tmdb:episode:12', seasonNumber: 1, episodeNumber: 1, name: 'Pilot', overview: '',
      airDate: null, runtimeMinutes: null, stillUrl: null };
    const season = { id: 'tmdb:season:11', seasonNumber: 1, name: null, overview: '', airDate: null, episodeCount: 1, episodes: [episode] };
    fetchMock.mockResolvedValue(json({ title: { ...tv, myRating: 8 }, seasons: [{ ...season, accountId: 'private' }],
      cast: [{ ...member, admin: 'private' }], watchlist: ['private'] }));
    const api = await bridge();
    expect(await api.getTitleDetails('tv', tv.slug)).toEqual({ title: tv, seasons: [season], cast: [member] });
    expect(await api.getTitleBySlug('tv', tv.slug)).toEqual(tv);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(legacy.getTitleBySlug).not.toHaveBeenCalled();
    expect(legacy.listSeasons).not.toHaveBeenCalled();
    expect(legacy.listCast).not.toHaveBeenCalled();
  });

  it('treats public 404 as authoritative rather than repeating legacy catalog reads', async () => {
    fetchMock.mockResolvedValue(json({ title: null }, 404));
    expect(await (await bridge()).getTitleDetails('movie', 'removed')).toEqual({ title: null, seasons: [], cast: [] });
    expect(legacy.getTitleBySlug).not.toHaveBeenCalled();
  });

  it('falls back to actual legacy detail on failure without retaining it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(json({ title, seasons: [], cast: [] }));
    legacy.getTitleBySlug.mockResolvedValue(title);
    const api = await bridge();
    expect(await api.getTitleDetails('movie', title.slug)).toEqual({ title, seasons: [], cast: [] });
    expect(legacy.listSeasons).not.toHaveBeenCalled();
    expect(legacy.listCast).toHaveBeenCalledWith(title.id);
    await api.getTitleDetails('movie', title.slug);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds shared public detail/row cache to 64 entries', async () => {
    fetchMock.mockImplementation(async () => json({ title, seasons: [], cast: [] }));
    const api = await bridge();
    for (let i = 0; i < 65; i++) await api.getTitleDetails('movie', `film-${i}`);
    await api.getTitleDetails('movie', 'film-0');
    expect(fetchMock).toHaveBeenCalledTimes(66);
  });

  it('enforces an 8s deadline even when fetch ignores cancellation', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const api = await bridge();
    const pending = api.fetchHome();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ hero: [], rows: [] });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds response-body reads and does not cache late public replies', async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise((resolve) => { finish = resolve; }) } as Response);
    const api = await bridge();
    const pending = api.listTitles();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual([]);
    finish({ titles: [title] });
    fetchMock.mockResolvedValueOnce(json({ titles: [] }));
    expect(await api.listTitles()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects embedded HTTP credentials before making a network request', async () => {
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', 'https://name:password@catalog.example');
    await (await bridge()).fetchHome();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the legacy production base when no environment override exists', async () => {
    vi.stubEnv('EXPO_PUBLIC_WEB_URL', undefined);
    fetchMock.mockResolvedValue(json({ hero: null, rows: [] }));
    await (await bridge()).fetchHome();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://hulkofyt.eu.org/api/catalog?view=home');
  });

  it('allows account operations only for persisted UUIDs, not virtual or guest ids', async () => {
    const api = await bridge();
    expect(api.isAccountCatalogId('00000000-0000-4000-8000-000000000000')).toBe(true);
    for (const id of ['tmdb:movie:123', 'tmdb:tv:456', 'tmdb:episode:12', 'film-123', '']) expect(api.isAccountCatalogId(id)).toBe(false);
  });
});
