import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ features: { tmdbConfigured: true }, home: vi.fn(), list: vi.fn(), title: vi.fn(), seasons: vi.fn(), cast: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/features/catalog/data', () => ({ getPublicHomeData: mocks.home }));
vi.mock('@/features/catalog/queries', () => ({ getTitleBySlug: mocks.title, listTitlesPage: mocks.list, listSeasonsForTitle: mocks.seasons, listCastForTitle: mocks.cast }));

import { GET } from '@/app/api/catalog/route';
import { withPublicCatalogCache } from '@/features/catalog/edge-cache';

let entries: Map<string, Response>;
let cache: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
const title = { id: 'tmdb:movie:27205', type: 'movie', slug: 'tmdb-27205', name: 'Public fixture', synopsis: '', genres: [], releaseYear: 2010, maturity: 'PG-13' };
function request(query = '', options: RequestInit = {}) { return new NextRequest(`https://app.fixture/api/catalog${query ? '?' + query : ''}`, options); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-10T12:00:00Z');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fixture');
  entries = new Map();
  cache = {
    match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, response: Response) => { entries.set(key.url, response.clone()); }),
  };
  vi.stubGlobal('caches', { default: cache });
  mocks.features.tmdbConfigured = true;
  mocks.list.mockResolvedValue({ titles: [title], total: 1 });
  mocks.title.mockResolvedValue(title);
  mocks.seasons.mockResolvedValue([]);
  mocks.cast.mockResolvedValue([]);
  mocks.home.mockResolvedValue({ hero: title, heroTitles: [title], rows: [{ titles: [title] }], continueWatching: [], forYou: null, signedIn: false, degraded: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('anonymous public catalogue edge cache', () => {
  it('returns a real cache hit without another data lookup and normalizes query order', async () => {
    const first = await GET(request('type=movie&page=1&limit=24'));
    expect(first.headers.get('X-Lumora-Data-Cache')).toBe('MISS');
    const second = await GET(request('limit=24&type=movie&page=1'));
    expect(second.headers.get('X-Lumora-Data-Cache')).toBe('HIT');
    expect(await second.json()).toEqual(await first.json());
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(second.headers.get('X-Lumora-Public-Catalog')).toBeNull();
    expect(second.headers.get('X-Lumora-Catalog-Until')).toBeNull();
  });

  it('keeps every consumed filter and page separate', async () => {
    for (const query of ['type=movie', 'type=tv', 'type=movie&page=2', 'type=movie&query=other', 'type=movie&genre=Drama', 'type=movie&originalLanguage=hi', 'type=movie&country=IN']) {
      await GET(request(query));
    }
    expect(mocks.list).toHaveBeenCalledTimes(7);
    expect(entries.size).toBe(7);
  });

  it.each([{ headers: { cookie: 'synthetic-session' } }, { headers: { authorization: 'Bearer synthetic-token' } }, { headers: { range: 'bytes=0-10' } },
    { cache: 'no-store' as const }, { cache: 'reload' as const }, { headers: { 'cache-control': 'no-cache' } }])('bypasses cache reads and writes for nonanonymous or explicitly fresh requests %j', async (options) => {
    await GET(request('type=movie', options));
    await GET(request('type=movie', options));
    expect(cache.match).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it.each(['type=movie&unknown=1', 'type=movie&type=tv', 'type=movie&token=synthetic'])('does not create arbitrary or ambiguous cache keys for %s', async (query) => {
    await GET(request(query));
    expect(cache.match).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
  });

  it('does not cache DB-owned, empty, malformed, missing or failed catalogue results', async () => {
    mocks.features.tmdbConfigured = false;
    mocks.list.mockResolvedValue({ titles: [{ ...title, id: '00000000-0000-4000-8000-000000000001' }], total: 1 });
    expect((await GET(request('type=movie'))).headers.get('cache-control')).toContain('no-store');
    mocks.features.tmdbConfigured = true;
    mocks.list.mockResolvedValue({ titles: [], total: 0 });
    expect((await GET(request('type=movie'))).headers.get('cache-control')).toContain('no-store');
    expect((await GET(request('limit=101'))).status).toBe(400);
    mocks.title.mockResolvedValue(null);
    expect((await GET(request('type=movie&slug=tmdb-27205'))).status).toBe(404);
    mocks.list.mockRejectedValue(new Error('synthetic private backend detail'));
    const failed = await GET(request('type=movie'));
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('private');
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('caches only an anonymous nondegraded public home payload', async () => {
    await GET(request('view=home')); await GET(request('view=home'));
    expect(mocks.home).toHaveBeenCalledTimes(1);
    entries.clear();
    mocks.home.mockResolvedValue({ hero: title, heroTitles: [title], rows: [], continueWatching: [{ account: 'synthetic-private' }], forYou: null, signedIn: true, degraded: false });
    expect((await GET(request('view=home'))).headers.get('cache-control')).toContain('no-store');
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it('caches canonical public title metadata but not stored or legacy title URLs', async () => {
    await GET(request('type=movie&slug=tmdb-27205')); await GET(request('type=movie&slug=tmdb-27205'));
    expect(mocks.title).toHaveBeenCalledTimes(1);
    await GET(request('type=movie&slug=legacy-film-27205'));
    mocks.title.mockResolvedValue({ ...title, id: '00000000-0000-4000-8000-000000000001' });
    expect((await GET(request('type=movie&slug=owned-film'))).headers.get('cache-control')).toContain('no-store');
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it('expires settled values at 60 seconds and never crosses UTC midnight', async () => {
    await GET(request('type=movie'));
    vi.setSystemTime('2026-11-10T12:01:00Z');
    await GET(request('type=movie'));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    entries.clear(); cache.put.mockClear();
    vi.setSystemTime('2026-11-10T23:59:59.500Z');
    await GET(request('type=movie'));
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('returns origin data if edge storage is missing or fails', async () => {
    cache.match.mockRejectedValue(new Error('synthetic edge failure'));
    cache.put.mockRejectedValue(new Error('synthetic edge failure'));
    expect((await GET(request('type=movie'))).status).toBe(200);
    vi.stubGlobal('caches', undefined);
    expect((await GET(request('type=movie'))).status).toBe(200);
  });

  it('never stores cookie-setting responses or bodies exceeding the 512 KiB budget', async () => {
    const cookie = await withPublicCatalogCache(request(), async () => Response.json({ value: 'synthetic' }, { headers: { 'Cache-Control': 'public', 'Set-Cookie': 'synthetic-cookie' } }));
    expect(cookie.headers.get('cache-control')).toContain('no-store');
    const oversized = await withPublicCatalogCache(request(), async () => Response.json({ value: 'x'.repeat(512 * 1024) }, { headers: { 'Cache-Control': 'public' } }));
    expect(oversized.headers.get('cache-control')).toContain('no-store');
    await oversized.arrayBuffer();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
