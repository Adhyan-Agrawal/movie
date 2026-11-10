import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true },
  publicClient: vi.fn(), server: vi.fn(), service: vi.fn(), download: vi.fn(),
  title: {} as Record<string, unknown> | null,
  source: {} as Record<string, unknown> | null,
  episode: {} as Record<string, unknown> | null,
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/supabase/public', () => ({ getSupabasePublicClient: mocks.publicClient }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.server }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));

const titleId = '00000000-0000-4000-8000-000000000001';
const episodeId = '00000000-0000-4000-8000-000000000002';
const root = 'hls/public-film';
const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';

function from(table: string) {
  const record = { table, filters: [] as Array<[string, unknown]> };
  mocks.queries.push(record);
  let row = table === 'titles' ? mocks.title : table === 'episodes' ? mocks.episode : mocks.source;
  const query = {
    select: () => query,
    eq(key: string, value: unknown) { record.filters.push([key, value]); if (row?.[key] !== value) row = null; return query; },
    is(key: string, value: unknown) { return query.eq(key, value); },
    or() { if (row?.published_at && Date.parse(String(row.published_at)) > Date.now()) row = null; return query; },
    abortSignal: () => query,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return query;
}

async function request(path: string[], viewer = 'anonymous', query = '') {
  const { GET } = await import('@/app/api/media/[...path]/route');
  return GET(new NextRequest(`https://app.example/api/media/${path.join('/')}${query}`, {
    headers: viewer === 'anonymous' ? {} : { cookie: `session=${viewer}`, authorization: `Bearer ${viewer}` },
  }), { params: Promise.resolve({ path }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is disabled in this suite'); }));
  mocks.features.supabaseConfigured = true;
  mocks.queries.length = 0;
  mocks.title = { id: titleId, slug: 'public-film', status: 'published', visibility: 'public', published_at: null };
  mocks.episode = { id: episodeId, title_id: titleId };
  mocks.source = { id: 'source-id', title_id: titleId, episode_id: null, kind: 'hls', enabled: true,
    url: null, reference: `${root}/master.m3u8`, provider_id: null, geo_policy: { mode: 'allow', regions: [] } };
  mocks.publicClient.mockReturnValue({ from });
  mocks.server.mockImplementation(() => { throw new Error('Private session client must not be consulted'); });
  mocks.download.mockImplementation(() => Object.assign(Promise.resolve({ data: new Blob([playlist]), error: null }), {
    asStream: async () => ({ data: new Blob([playlist]).stream(), error: null }),
  }));
  mocks.service.mockReturnValue({ from, storage: { from: () => ({ download: mocks.download }) } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('private storage public HLS boundary', () => {
  it.each(['master.m3u8', '1080/index.m3u8', '720/index.m3u8', '480/seg_0000.ts'])('preserves short public caching for registered generated output %s', async (file) => {
    const response = await request(`${root}/${file}`.split('/'), 'editor');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(playlist);
    expect(response.headers.get('cache-control')).toContain('public');
    expect(response.headers.get('cache-control')).not.toMatch(/immutable|stale-while-revalidate|86400|604800/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mocks.publicClient).toHaveBeenCalledOnce();
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.queries.find((query) => query.table === 'media_sources')?.filters).toEqual(expect.arrayContaining([
      ['title_id', titleId], ['reference', `${root}/master.m3u8`], ['kind', 'hls'], ['enabled', true], ['episode_id', null],
    ]));
    expect(mocks.download).toHaveBeenCalledWith(`${root}/${file}`, expect.anything(), expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  });

  it.each(['anonymous', 'member', 'editor'])('denies private, draft, archived and future titles for %s before storage access', async (viewer) => {
    for (const fields of [{ visibility: 'private' }, { status: 'draft' }, { status: 'archived' }, { published_at: '2099-01-01T00:00:00Z' }]) {
      mocks.title = { id: titleId, slug: 'public-film', status: 'published', visibility: 'public', published_at: null, ...fields };
      const response = await request(`${root}/master.m3u8`.split('/'), viewer);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it.each([
    'media/title/title/original.mp4', 'hls/public-film/original.mp4', 'hls/public-film/private.json',
    'hls/public-film/private.m3u8', 'hls/public-film/480/private.ts', 'hls/public-film-evil/master.m3u8',
  ])('denies raw uploads, unrelated objects and prefix confusion: %s', async (path) => {
    const response = await request(path.split('/'), 'editor');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each([
    ['hls', '..', 'master.m3u8'], ['hls', '.', 'master.m3u8'], ['hls', '%2e%2e', 'master.m3u8'],
    ['hls', '%252e%252e', 'master.m3u8'], ['hls', 'public-film%2fprivate', 'master.m3u8'],
    ['hls', 'public-film\\private', 'master.m3u8'], ['hls', 'public-film/private', 'master.m3u8'],
    ['hls', '%', 'master.m3u8'], ['hls', 'public-film', 'master.m3u8\u0000'],
  ].map((path) => [path.join(' / '), path] as const))('rejects malformed or ambiguous segments without a decode exception: %s', async (_name, path) => {
    const response = await request([...path]);
    expect([400, 404]).toContain(response.status);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each([
    null, { enabled: false }, { kind: 'mp4' }, { reference: 'hls/another-film/master.m3u8' },
    { title_id: 'another-title' }, { episode_id: episodeId }, { url: 'https://external.example/master.m3u8' },
    { provider_id: 'external-provider' }, { geo_policy: { mode: 'allow', regions: ['US'] } },
    { geo_policy: null }, { geo_policy: { mode: 'deny', regions: ['US'] } },
  ])('requires the exact enabled storage-backed title source: %j', async (fields) => {
    mocks.source = fields === null ? null : { ...mocks.source, ...fields };
    const response = await request(`${root}/480/seg_0000.ts`.split('/'));
    expect(response.status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('keeps episode trees distinct and verifies their parent title', async () => {
    const episodeRoot = `${root}/episodes/${episodeId}`;
    mocks.source = { ...mocks.source, episode_id: episodeId, reference: `${episodeRoot}/master.m3u8` };
    expect((await request(`${episodeRoot}/480/seg_0000.ts`.split('/'))).status).toBe(200);
    mocks.download.mockClear();
    mocks.episode = { id: episodeId, title_id: 'another-title' };
    expect((await request(`${episodeRoot}/480/seg_0000.ts`.split('/'), 'editor')).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('rechecks publication and source revocation on later origin requests', async () => {
    expect((await request(`${root}/master.m3u8`.split('/'), 'editor')).status).toBe(200);
    mocks.source = { ...mocks.source, enabled: false };
    expect((await request(`${root}/master.m3u8`.split('/'))).status).toBe(404);
    mocks.source = { ...mocks.source, enabled: true };
    mocks.title = { ...mocks.title, visibility: 'private' };
    expect((await request(`${root}/master.m3u8`.split('/'))).status).toBe(404);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['master.m3u8', 512 * 1024], ['480/seg_0000.ts', 16 * 1024 * 1024],
  ] as const)('bounds %s before returning a cacheable response', async (file, limit) => {
    const cancel = vi.fn();
    mocks.download.mockReturnValue({ asStream: async () => ({ data: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); }, cancel,
    }), error: null }) });
    const response = await request(`${root}/${file}`.split('/'));
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a stalled storage body at the request deadline instead of caching a partial success', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const cancel = vi.fn();
    let started!: () => void;
    const opened = new Promise<void>((resolve) => { started = resolve; });
    mocks.download.mockReturnValue({ asStream: async () => ({ data: new ReadableStream({
      start: started, cancel,
    }), error: null }) });
    const pending = request(`${root}/master.m3u8`.split('/'));
    await opened;
    deadline.abort();
    const response = await pending;
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([null, new Blob([]).stream()])('does not cache an absent or empty body', async (data) => {
    mocks.download.mockReturnValue({ asStream: async () => ({ data, error: null }) });
    const response = await request(`${root}/master.m3u8`.split('/'));
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each([404, 403, 500])('does not publish storage error details or cache storage failure %i', async (status) => {
    mocks.download.mockReturnValue({ asStream: async () => ({ data: null, error: { status, message: 'PRIVATE storage diagnostic' } }) });
    const response = await request(`${root}/master.m3u8`.split('/'));
    expect(response.status).toBe(status === 404 ? 404 : 502);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).not.toContain('PRIVATE');
  });

  it('fails closed on configuration and lookup failure without cacheable errors or private diagnostics', async () => {
    mocks.features.supabaseConfigured = false;
    const unavailable = await request(`${root}/master.m3u8`.split('/'));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('cache-control')).toContain('no-store');
    mocks.features.supabaseConfigured = true;
    mocks.publicClient.mockImplementation(() => { throw new Error('PRIVATE backend credential'); });
    const failed = await request(`${root}/master.m3u8`.split('/'));
    expect(failed.status).toBe(502);
    expect(failed.headers.get('cache-control')).toContain('no-store');
    expect(await failed.text()).not.toContain('PRIVATE');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('PRIVATE');
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
