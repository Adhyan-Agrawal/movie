import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true, tmdbConfigured: false },
  viewer: 'anonymous',
  server: vi.fn(), publicClient: vi.fn(), personal: vi.fn(), tmdb: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/lib/supabase/public', () => ({ getSupabasePublicClient: mocks.publicClient }));
vi.mock('next/cache', () => ({ unstable_noStore: vi.fn() }));
vi.mock('@/features/playback/progress-queries', () => ({ getContinueWatching: mocks.personal, isSignedIn: mocks.personal }));
vi.mock('@/features/catalog/personalization', () => ({ getForYouRow: mocks.personal }));
vi.mock('@/features/catalog/tmdb-catalog', () => ({ listTmdbTitles: mocks.tmdb, searchTmdbTitles: mocks.tmdb, getTmdbTitle: mocks.tmdb }));

const movieId = '00000000-0000-4000-8000-000000000001';
const tvId = '00000000-0000-4000-8000-000000000002';
const titleRows = [
  { id: movieId, slug: 'public-film', type: 'movie', name: 'Public film' },
  { id: tvId, slug: 'public-series', type: 'tv', name: 'Public series' },
  { id: 'draft-id', slug: 'draft', type: 'tv', name: 'Draft secret', status: 'draft' },
  { id: 'private-id', slug: 'private', type: 'tv', name: 'Private secret', visibility: 'private' },
  { id: 'future-id', slug: 'future', type: 'tv', name: 'Future secret', published_at: '2099-01-01T00:00:00Z' },
  { id: 'archived-id', slug: 'archived', type: 'tv', name: 'Archived secret', status: 'archived' },
].map((row) => ({
  status: 'published', visibility: 'public', published_at: null, original_name: null,
  original_language: 'en', synopsis: '', release_year: 2026, runtime_minutes: null,
  maturity: 'PG', poster_url: null, backdrop_url: 'https://image.example/public.jpg',
  trailer_url: null, editorial_score: 75, featured: false, tmdb_id: null, imdb_id: null,
  title_genres: [{ genres: { name: 'Drama' } }], account_id: 'never-project-this', ...row,
}));

// A deterministic RLS fixture: editor reads see drafts, anonymous/member reads do not.
// The real route, service and repository run unchanged above this fake DB boundary.
function database(viewer: string) {
  const publicIds = new Set(titleRows.filter((row) => row.status === 'published' && row.visibility === 'public'
    && (!row.published_at || Date.parse(row.published_at) <= Date.now())).map((row) => row.id));
  return { from(table: string) {
    let rows: Record<string, unknown>[] = table === 'titles' ? titleRows : table === 'seasons'
      ? titleRows.map((row) => ({ id: `season-${row.id}`, title_id: row.id, season_number: 1, name: row.name,
        overview: '', air_date: null, episode_count: 1, private_notes: 'never-project-this' }))
      : table === 'episodes' ? titleRows.map((row) => ({ id: `episode-${row.id}`, title_id: row.id,
        season_id: `season-${row.id}`, season_number: 1, episode_number: 1, name: row.name,
        overview: '', air_date: null, runtime_minutes: null, still_url: null }))
      : table === 'title_people' ? titleRows.map((row) => ({ title_id: row.id, credit_type: 'cast', credit_order: 0,
        character: row.name, people: { id: `person-${row.id}`, name: 'Actor', profile_url: null } })) : [];
    if (viewer !== 'editor') rows = rows.filter((row) => publicIds.has(String(table === 'titles' ? row.id : row.title_id)));
    let start = 0;
    let end = Infinity;
    const query = {
      select: () => query,
      eq(key: string, value: unknown) {
        rows = key === 'title_genres.genres.name'
          ? rows.filter(() => value === 'Drama') : rows.filter((row) => row[key] === value);
        return query;
      },
      in(key: string, values: unknown[]) { rows = rows.filter((row) => values.includes(row[key])); return query; },
      gte(key: string, value: number) { rows = rows.filter((row) => Number(row[key]) >= value); return query; },
      lte(key: string, value: number) { rows = rows.filter((row) => Number(row[key]) <= value); return query; },
      or() { rows = rows.filter((row) => !row.published_at || Date.parse(String(row.published_at)) <= Date.now()); return query; },
      order: () => query,
      range(a: number, b: number) { start = a; end = b + 1; return query; },
      limit(n: number) { end = n; return query; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: rows.slice(start, end), count: rows.length, error: null }).then(resolve); },
    };
    return query;
  } };
}

async function request(query: string, viewer = 'anonymous') {
  mocks.viewer = viewer;
  const { GET } = await import('@/app/api/catalog/route');
  return GET(new NextRequest(`https://app.example/api/catalog?${query}`, {
    headers: viewer === 'anonymous' ? {} : { cookie: `session=${viewer}`, authorization: `Bearer ${viewer}` },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is disabled in this suite'); }));
  mocks.features.supabaseConfigured = true;
  mocks.features.tmdbConfigured = false;
  mocks.viewer = 'anonymous';
  mocks.server.mockImplementation(async () => database(mocks.viewer));
  mocks.publicClient.mockImplementation(() => database('anonymous'));
  mocks.personal.mockRejectedValue(new Error('Personal data must not be read'));
  mocks.tmdb.mockRejectedValue(new Error('TMDB fixture unavailable'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('public catalogue authorization and cache boundary', () => {
  it.each(['anonymous', 'member', 'editor'])('lists only public titles/counts for %s, without invoking the session client', async (viewer) => {
    const response = await request('limit=20', viewer);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
    const data = await response.json();
    expect(data.total).toBe(2);
    expect(data.titles.map((title: { id: string }) => title.id)).toEqual([movieId, tvId]);
    expect(JSON.stringify(data)).not.toContain('never-project-this');
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.publicClient).toHaveBeenCalled();
  });

  it('keeps editor-first and anonymous-first requests identical across list, home and detail', async () => {
    for (const query of ['limit=20', 'view=home', 'type=tv&slug=public-series']) {
      const editor = await (await request(query, 'editor')).text();
      const anonymous = await (await request(query)).text();
      const member = await (await request(query, 'member')).text();
      expect(editor).toBe(anonymous);
      expect(member).toBe(anonymous);
      expect(editor).not.toMatch(/Draft secret|Private secret|Future secret|Archived secret|never-project-this/);
    }
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.personal).not.toHaveBeenCalled();
  });

  it.each(['draft', 'private', 'future', 'archived'])('never publishes editor-readable %s detail', async (slug) => {
    const response = await request(`type=tv&slug=${slug}`, 'editor');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ title: null, seasons: [], cast: [] });
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it('projects public seasons, episodes and cast without raw administrative fields', async () => {
    const data = await (await request('type=tv&slug=public-series', 'editor')).json();
    expect(data.seasons).toHaveLength(1);
    expect(data.seasons[0].episodes).toHaveLength(1);
    expect(data.cast).toHaveLength(1);
    expect(JSON.stringify(data)).not.toMatch(/private_notes|account_id|never-project-this|secret/);
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it('does not read any Supabase catalogue or editor RLS fallback when the direct provider fails', async () => {
    mocks.features.tmdbConfigured = true;
    const response = await request('limit=20', 'editor');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.tmdb).toHaveBeenCalled();
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.publicClient).not.toHaveBeenCalled();
  });

  it('preserves session-scoped admin reads, including permitted drafts and private rows', async () => {
    mocks.viewer = 'editor';
    const { repoListTitlesPaged } = await import('@/features/catalog/repository');
    const editor = await repoListTitlesPaged({ page: 1, pageSize: 20 });
    expect(editor.total).toBe(titleRows.length);
    expect(editor.rows.some((title) => title.slug === 'draft')).toBe(true);
    mocks.viewer = 'member';
    expect((await repoListTitlesPaged({ page: 1, pageSize: 20 })).total).toBe(2);
    expect(mocks.server).toHaveBeenCalledTimes(2);
    expect(mocks.publicClient).not.toHaveBeenCalled();
  });

  it('does not advertise shared caching for malformed filters or dependency failures', async () => {
    const invalid = await request('limit=101');
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toContain('no-store');
    mocks.publicClient.mockImplementation(() => { throw new Error('PRIVATE database detail'); });
    const failed = await request('type=tv&slug=public-series');
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toContain('no-store');
    expect(await failed.text()).not.toContain('PRIVATE');
  });
});
