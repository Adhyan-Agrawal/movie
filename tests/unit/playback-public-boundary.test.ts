import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true, tmdbConfigured: true },
  publicClient: vi.fn(), server: vi.fn(), service: vi.fn(), sign: vi.fn(), resolve: vi.fn(), commerce: vi.fn(),
  rows: {} as Record<string, Row[]>,
  errors: {} as Record<string, string>,
  throwLookup: '',
  gate: null as { table: string; promise: Promise<void> } | null,
  events: [] as string[],
  queries: [] as Array<{ scope: string; table: string; filters: Array<[string, unknown]> }>,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/supabase/public', () => ({ getSupabasePublicClient: mocks.publicClient }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('@/lib/providers/registry', () => ({ resolvePlayback: mocks.resolve, getActiveProviderConfigs: () => [] }));
vi.mock('@/features/commerce/queries', () => ({ getPlaybackCommerceContext: mocks.commerce }));

import { GET } from '@/app/api/playback/route';
import { findEpisodeId, resolveNativeSources } from '@/features/playback/native-sources';

const titleId = '00000000-0000-4000-8000-000000000001';
const episodeId = '00000000-0000-4000-8000-000000000002';
const otherTitleId = '00000000-0000-4000-8000-000000000003';
const otherEpisodeId = '00000000-0000-4000-8000-000000000004';
const unknownId = '00000000-0000-4000-8000-000000000099';
const original = `media/${titleId}/title/original.mp4`;

function source(fields: Row = {}): Row {
  return { id: 'source-id', title_id: titleId, episode_id: null, enabled: true, kind: 'mp4',
    reference: original, url: null, label: 'Private operator label', consent_required: false, priority: 100, ...fields };
}

// Deliberately exposes all rows: explicit public predicates must work even if
// a permissive policy returns drafts. The session factory is a separate trap.
function database(scope: string) {
  return { from(table: string) {
    const record = { scope, table, filters: [] as Array<[string, unknown]> };
    mocks.queries.push(record);
    let rows = [...(mocks.rows[table] ?? [])];
    const query = {
      select: () => query,
      eq(key: string, value: unknown) { record.filters.push([key, value]); rows = rows.filter((row) => row[key] === value); return query; },
      is(key: string, value: unknown) { return query.eq(key, value); },
      or(expression: string) {
        record.filters.push(['or', expression]);
        if (expression.startsWith('published_at.is.null,published_at.lte.')) {
          const cutoff = Date.parse(expression.slice('published_at.is.null,published_at.lte.'.length));
          rows = rows.filter((row) => row.published_at === null || Date.parse(String(row.published_at)) <= cutoff);
        } else {
          const match = /^episode_id\.eq\.([0-9a-f-]{36}),episode_id\.is\.null$/i.exec(expression);
          if (!match) throw new Error('Unexpected query expression');
          rows = rows.filter((row) => row.episode_id === null || row.episode_id === match[1]);
        }
        return query;
      },
      order(key: string) { rows.sort((a, b) => Number(b[key]) - Number(a[key])); return query; },
      async maybeSingle() {
        if (mocks.gate?.table === table) await mocks.gate.promise;
        if (mocks.throwLookup === table) throw new Error('PRIVATE lookup detail');
        mocks.events.push(`${scope}:${table}`);
        return { data: rows[0] ?? null, error: mocks.errors[table] ? { message: mocks.errors[table] } : null };
      },
      then(resolve: (result: { data: Row[]; error: { message: string } | null }) => unknown) {
        mocks.events.push(`${scope}:${table}`);
        return Promise.resolve({ data: rows, error: mocks.errors[table] ? { message: mocks.errors[table] } : null }).then(resolve);
      },
    };
    return query;
  } };
}

function request(query: string, viewer = 'anonymous') {
  return GET(new NextRequest(`https://app.example/api/playback?${query}`, {
    headers: viewer === 'anonymous' ? {} : { cookie: `session=${viewer}`, authorization: `Bearer ${viewer}` },
  }));
}

function expectNoPrivilegedAccess() {
  expect(mocks.service).not.toHaveBeenCalled();
  expect(mocks.sign).not.toHaveBeenCalled();
  expect(mocks.queries.some((query) => query.scope === 'service')).toBe(false);
  expect(mocks.server).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is disabled in this suite'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.features.supabaseConfigured = true;
  mocks.features.tmdbConfigured = true;
  mocks.rows = {
    titles: [{ id: titleId, type: 'tv', status: 'published', visibility: 'public', published_at: null }],
    seasons: [{ id: 'season-id', title_id: titleId, season_number: 1 }],
    episodes: [
      { id: episodeId, title_id: titleId, season_id: 'season-id', season_number: 1, episode_number: 1 },
      { id: otherEpisodeId, title_id: otherTitleId, season_id: 'other-season', season_number: 1, episode_number: 2 },
    ],
    media_sources: [source()],
  };
  mocks.errors = {};
  mocks.throwLookup = '';
  mocks.gate = null;
  mocks.events.length = 0;
  mocks.queries.length = 0;
  mocks.publicClient.mockImplementation(() => database('public'));
  mocks.server.mockImplementation(() => { throw new Error('Session client must not authorize public playback'); });
  mocks.sign.mockImplementation(async (reference: string) => {
    mocks.events.push('sign');
    return { data: { signedUrl: `https://storage.example/authorized/${encodeURIComponent(reference)}` }, error: null };
  });
  mocks.service.mockImplementation(() => {
    mocks.events.push('service');
    return { ...database('service'), storage: { from: (bucket: string) => {
      expect(bucket).toBe('media');
      return { createSignedUrl: mocks.sign };
    } } };
  });
  mocks.resolve.mockImplementation(async (input: { tmdbId?: string; imdbId?: string }) => ({
    sources: input.tmdbId || input.imdbId ? [{ id: 'provider-secret', label: 'Provider secret',
      providerId: 'provider-secret', kind: 'embed', url: 'https://player.example/watch', consentRequired: true }] : [],
  }));
  mocks.commerce.mockResolvedValue({ ads: { enabled: false }, entitlements: { resolved: false, adFree: false } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('public playback authorization before privileged native signing', () => {
  it.each(['anonymous', 'editor'])('denies private, draft, archived and future titles for %s, even with external fallback IDs', async (viewer) => {
    for (const fields of [{ visibility: 'private' }, { status: 'draft' }, { status: 'archived' }, { published_at: '2999-01-01T00:00:00Z' }]) {
      mocks.rows.titles = [{ id: titleId, type: 'tv', status: 'published', visibility: 'public', published_at: null, ...fields }];
      const response = await request(`type=tv&titleId=${titleId}&tmdbId=1396&season=1&episode=1`, viewer);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({ sources: [], error: 'not-found' });
      expectNoPrivilegedAccess();
    }
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.commerce).not.toHaveBeenCalled();
  });

  it.each(['anonymous', 'editor'])('denies a cross-title episode for %s instead of falling back to title-level assets', async (viewer) => {
    // Independent FKs permit a malformed source row; it must not grant ownership.
    mocks.rows.media_sources!.push(source({ id: 'cross-title', episode_id: otherEpisodeId, reference: 'private-episode.mp4' }));
    const response = await request(`type=tv&titleId=${titleId}&episodeId=${otherEpisodeId}&tmdbId=1396`, viewer);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ sources: [], error: 'not-found' });
    expectNoPrivilegedAccess();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.commerce).not.toHaveBeenCalled();
  });

  it.each([`titleId=${unknownId}`, `titleId=${titleId}&episodeId=${unknownId}`])('denies well-formed but nonexistent identities: %s', async (ids) => {
    const response = await request(`type=tv&tmdbId=1396&${ids}`, 'editor');
    expect(response.status).toBe(404);
    expectNoPrivilegedAccess();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    'type=movie&titleId=not-a-uuid', 'type=tv&tmdbId=1396&titleId=',
    `type=tv&titleId=${titleId}&episodeId=`,
    `type=tv&titleId=${titleId}&episodeId=${encodeURIComponent(`${episodeId},enabled.eq.true`)}`,
    `type=tv&tmdbId=1396&episodeId=${episodeId}`,
    `type=movie&titleId=${titleId}&episodeId=${episodeId}`,
    `type=tv&titleId=${titleId}&titleId=${unknownId}`,
    `type=tv&titleId=${titleId}&episodeId=${episodeId}&episodeId=${otherEpisodeId}`,
  ])('rejects malformed, unbound or ambiguous local IDs without any lookup: %s', async (query) => {
    const response = await request(query);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expectNoPrivilegedAccess();
    expect(mocks.publicClient).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.commerce).not.toHaveBeenCalled();
  });

  it('rejects a local title with a mismatched media type before signing', async () => {
    expect((await request(`type=movie&titleId=${titleId}`)).status).toBe(404);
    expectNoPrivilegedAccess();
  });

  it.each(['anonymous', 'editor'])('preserves published native playback for %s with sanitized MP4, DASH and HLS sources', async (viewer) => {
    mocks.rows.titles![0]!.type = 'movie';
    mocks.rows.titles![0]!.published_at = '2020-01-01T00:00:00Z';
    mocks.rows.media_sources!.push(source({ id: 'dash', kind: 'dash', reference: 'registered/movie.mpd' }),
      source({ id: 'hls', kind: 'hls', reference: 'hls/public-film/master.m3u8' }),
      source({ id: 'disabled', enabled: false, reference: 'disabled.mp4' }),
      source({ id: 'other-title', title_id: otherTitleId, reference: 'private-other.mp4' }),
      source({ id: 'episode-only', episode_id: episodeId, reference: 'episode-only.mp4' }));
    const response = await request(`type=movie&titleId=${titleId}`, viewer);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body.sources.map((row: Row) => row.kind)).toEqual(['mp4', 'dash', 'hls']);
    expect(body.sources[2].url).toBe('https://app.example/api/media/hls/public-film/master.m3u8');
    expect(JSON.stringify(body)).not.toMatch(/source-id|Private operator|providerId|reference|private-other|episode-only|disabled\.mp4/);
    expect(mocks.sign.mock.calls).toEqual([[original, 14_400], ['registered/movie.mpd', 14_400]]);
    expect(mocks.events.slice(0, 3)).toEqual(['public:titles', 'service', 'service:media_sources']);
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it('allows only the owned episode and title-level sources after both public checks complete', async () => {
    mocks.rows.media_sources!.push(source({ id: 'episode', episode_id: episodeId, reference: 'owned-episode.mp4', priority: 200 }),
      source({ id: 'other-episode', episode_id: otherEpisodeId, reference: 'other-episode.mp4' }));
    const result = await resolveNativeSources(titleId, episodeId);
    expect(result.map((row) => row.id)).toEqual(['native:episode', 'native:source-id']);
    expect(mocks.events.slice(0, 4)).toEqual(['public:titles', 'public:episodes', 'service', 'service:media_sources']);
    expect(mocks.sign.mock.calls).toEqual([['owned-episode.mp4', 14_400], [original, 14_400]]);
    expect(mocks.queries.find((query) => query.table === 'episodes')?.filters).toEqual(expect.arrayContaining([
      ['id', episodeId], ['title_id', titleId],
    ]));
  });

  it.each(['titles', 'episodes'])('does no privileged work while the %s authorization read is still pending', async (table) => {
    let release!: () => void;
    mocks.gate = { table, promise: new Promise<void>((resolve) => { release = resolve; }) };
    const pending = request(`type=tv&titleId=${titleId}&episodeId=${episodeId}`);
    try {
      await vi.waitFor(() => expect(mocks.queries.some((query) => query.scope === 'public' && query.table === table)).toBe(true));
      expectNoPrivilegedAccess();
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.commerce).not.toHaveBeenCalled();
      release();
      expect((await pending).status).toBe(200);
      expect(mocks.events.slice(0, 4)).toEqual(['public:titles', 'public:episodes', 'service', 'service:media_sources']);
    } finally {
      release();
      await pending;
    }
  });

  it('never signs an unregistered transcode input supplied as a path or reference by the caller', async () => {
    mocks.rows.media_sources = [source({ id: 'hls', kind: 'hls', reference: 'hls/public-series/master.m3u8' })];
    const response = await request(`type=tv&titleId=${titleId}&path=hls/public-series/input.mp4&reference=private/input.mp4`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].url).toBe('https://app.example/api/media/hls/public-series/master.m3u8');
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('preserves registered remote native URLs without attempting storage signing', async () => {
    mocks.rows.media_sources = [source({ url: 'https://licensed.example/public-film.mp4', reference: null })];
    const response = await request(`type=tv&titleId=${titleId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).sources[0].url).toBe('https://licensed.example/public-film.mp4');
    expect(mocks.events.slice(0, 3)).toEqual(['public:titles', 'service', 'service:media_sources']);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it.each([['not-a-uuid', undefined], [titleId, ''], [titleId, `${episodeId},episode_id.not.is.null`]])('protects direct helper callers from forged IDs: %s / %s', async (title, episode) => {
    await expect(resolveNativeSources(title!, episode)).rejects.toMatchObject({ status: 404 });
    expectNoPrivilegedAccess();
    expect(mocks.publicClient).not.toHaveBeenCalled();
  });

  it('does not cache publication authorization across native helper calls', async () => {
    expect(await resolveNativeSources(titleId)).toHaveLength(1);
    mocks.service.mockClear();
    mocks.sign.mockClear();
    mocks.queries.length = 0;
    mocks.rows.titles![0]!.visibility = 'private';
    await expect(resolveNativeSources(titleId)).rejects.toMatchObject({ status: 404 });
    expectNoPrivilegedAccess();
  });

  it('rejects wrong episode ownership for direct helper callers, including an episode attached to a movie', async () => {
    await expect(resolveNativeSources(titleId, otherEpisodeId)).rejects.toMatchObject({ status: 404 });
    mocks.rows.titles![0]!.type = 'movie';
    await expect(resolveNativeSources(titleId, episodeId)).rejects.toMatchObject({ status: 404 });
    expectNoPrivilegedAccess();
  });

  it.each(['titles', 'episodes'])('fails closed on %s lookup errors, without leaking diagnostics or doing privileged work', async (table) => {
    mocks.errors[table] = 'PRIVATE backend diagnostic';
    const response = await request(`type=tv&titleId=${titleId}&episodeId=${episodeId}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ sources: [], error: 'playback-unavailable' });
    expectNoPrivilegedAccess();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('PRIVATE');
  });

  it.each(['factory', 'titles', 'episodes'])('fails closed when public authorization throws at %s', async (stage) => {
    if (stage === 'factory') mocks.publicClient.mockImplementation(() => { throw new Error('PRIVATE configuration detail'); });
    else mocks.throwLookup = stage;
    const response = await request(`type=tv&titleId=${titleId}&episodeId=${episodeId}`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE');
    expectNoPrivilegedAccess();
  });

  it('keeps the actual external playback fallback when a public title has no working native source', async () => {
    for (const scenario of ['empty', 'read-error', 'sign-error']) {
      mocks.rows.media_sources = scenario === 'empty' ? [] : [source()];
      mocks.errors = scenario === 'read-error' ? { media_sources: 'PRIVATE source diagnostic' } : {};
      mocks.sign.mockResolvedValue({ data: null, error: { message: 'PRIVATE signing diagnostic' } });
      const response = await request(`type=tv&titleId=${titleId}&tmdbId=1396&season=1&episode=1`);
      expect(response.status).toBe(200);
      expect((await response.json()).sources).toEqual([{ id: 'server-1', label: 'Server 1', kind: 'embed',
        url: 'https://player.example/watch', consentRequired: true }]);
      expect(mocks.resolve).toHaveBeenLastCalledWith({ titleId, type: 'tv', tmdbId: '1396', season: 1, episode: 1 });
    }
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('PRIVATE');
  });

  it('retains provider fallback on a native service outage only after public authorization', async () => {
    mocks.service.mockImplementation(() => { throw new Error('PRIVATE service configuration'); });
    const response = await request(`type=tv&titleId=${titleId}&episodeId=${episodeId}&tmdbId=1396`);
    expect(response.status).toBe(200);
    expect((await response.json()).sources).toHaveLength(1);
    expect(mocks.events).toEqual(['public:titles', 'public:episodes']);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it.each([true, false])('leaves TMDB/IMDb-only playback independent of local catalog availability=%s', async (configured) => {
    mocks.features.supabaseConfigured = configured;
    for (const query of ['type=movie&tmdbId=27205', 'type=tv&tmdbId=1396&season=0&episode=1', 'type=movie&imdbId=tt1375666']) {
      const response = await request(query, 'editor');
      expect(response.status).toBe(200);
      expect((await response.json()).sources).toHaveLength(1);
      const values = Object.fromEntries(new URLSearchParams(query));
      expect(mocks.resolve).toHaveBeenLastCalledWith({ titleId: '', ...values,
        ...(values.season ? { season: Number(values.season), episode: Number(values.episode) } : {}) });
    }
    expect(mocks.publicClient).not.toHaveBeenCalled();
    expectNoPrivilegedAccess();
  });
});

describe('public episode ID lookup used by native playback', () => {
  it('uses the anonymous client and requires the episode to belong to the selected title and season', async () => {
    expect(await findEpisodeId(titleId, 1, 1)).toBe(episodeId);
    expect(mocks.server).not.toHaveBeenCalled();
    expectNoPrivilegedAccess();
    mocks.rows.episodes![0]!.title_id = otherTitleId;
    expect(await findEpisodeId(titleId, 1, 1)).toBeNull();
  });

  it.each(['tmdb:tv:1396', 'not-a-uuid'])('does not turn a non-stored catalog identity into a native episode: %s', async (id) => {
    expect(await findEpisodeId(id, 1, 1)).toBeNull();
    expect(mocks.publicClient).not.toHaveBeenCalled();
    expectNoPrivilegedAccess();
  });
});
