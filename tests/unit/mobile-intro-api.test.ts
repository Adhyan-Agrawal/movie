import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabase: { auth: { getSession: mock.getSession } } }));
import { fetchIntroCatalog, resolvePlaybackDetails } from '../../mobile/src/lib/api';

const origin = new URL(process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').origin;
const url = `${origin}/api/intro?tmdbId=123&type=tv&season=1&episode=2`;
const source = { id: 'direct', label: 'Direct', kind: 'hls', consentRequired: false, url: '/api/vidnest?token=fixture' };
const response = (intro: unknown) => new Response(JSON.stringify({ intro }));

beforeEach(() => {
  vi.clearAllMocks();
  mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mock.fetch.mockImplementation(async () => response({ startSeconds: 0, endSeconds: 55.125 }));
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Android optional intro bridge contract', () => {
  it('normalizes the optional URL without fetching metadata or delaying source resolution', async () => {
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ sources: [source], introCatalogUrl: '/api/intro?token=fixture' })));
    const bridge = await resolvePlaybackDetails({ type: 'tv', tmdbId: '123', season: 1, episode: 2 });
    expect(bridge.introCatalogUrl).toBe(`${origin}/api/intro?token=fixture`);
    expect(bridge.sources[0]?.url).toBe(`${origin}${source.url}`);
    expect(mock.fetch).toHaveBeenCalledOnce();
  });

  it('keeps existing playback sources when the optional intro contract is absent', async () => {
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ sources: [source] })));
    const bridge = await resolvePlaybackDetails({ type: 'movie', tmdbId: '123' });
    expect(bridge.introCatalogUrl).toBeUndefined();
    expect(bridge.sources).toHaveLength(1);
  });

  it.each(['https://foreign.example/intro', '//foreign.example/intro', 'javascript:alert(1)',
    `${origin.replace('://', '://user:password@')}/api/intro`, 42, { path: '/api/intro' }])
  ('rejects unsafe or non-string bridge intro URL %j without failing playback', async (introCatalogUrl) => {
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ sources: [source], introCatalogUrl })));
    const bridge = await resolvePlaybackDetails({ type: 'movie', tmdbId: '123' });
    expect(bridge.introCatalogUrl).toBeUndefined();
    expect(bridge.sources).toHaveLength(1);
  });
});

describe('Android bounded intro catalog fetch', () => {
  it.each([{ startSeconds: 0, endSeconds: 55.125 }, { startSeconds: 0.125, endSeconds: 0.375 }])
  ('returns exact zero/fractional bounds with no extra provider fields %j', async (intro) => {
    mock.fetch.mockResolvedValue(response({ ...intro, provider: 'private', skipped: true }));
    expect(await fetchIntroCatalog(url)).toEqual(intro);
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(url, { signal: expect.any(AbortSignal), credentials: 'omit', redirect: 'error' });
    expect(mock.getSession).not.toHaveBeenCalled();
  });

  it.each([null, {}, [], 1, 'intro', { startSeconds: -1, endSeconds: 5 }, { startSeconds: 5, endSeconds: 5 },
    { startSeconds: 5, endSeconds: 4 }, { startSeconds: '0', endSeconds: 5 }, { startSeconds: 0, endSeconds: '5' },
    { startSeconds: null, endSeconds: 5 }, { startSeconds: 0, endSeconds: null }, { startSeconds: NaN, endSeconds: 5 },
    { startSeconds: 0, endSeconds: Infinity }])('ignores null/malformed markers %j', async (intro) => {
    mock.fetch.mockResolvedValue(response(intro));
    expect(await fetchIntroCatalog(url)).toBeNull();
  });

  it.each([204, 404, 429, 500])('ignores provider/no-fill HTTP %s', async (status) => {
    mock.fetch.mockResolvedValue(new Response(null, { status }));
    expect(await fetchIntroCatalog(url)).toBeNull();
  });

  it('treats offline, bad JSON and a missing envelope as no intro, never a playback error', async () => {
    mock.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('<html>unavailable</html>'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ bounds: { startSeconds: 0, endSeconds: 5 } })));
    expect(await fetchIntroCatalog(url)).toBeNull();
    expect(await fetchIntroCatalog(url)).toBeNull();
    expect(await fetchIntroCatalog(url)).toBeNull();
  });

  it('does not start unsafe or pre-aborted requests', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await fetchIntroCatalog(url, controller.signal)).toBeNull();
    expect(await fetchIntroCatalog('https://foreign.example/intro')).toBeNull();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin final response if native transport follows a redirect despite the request option', async () => {
    mock.fetch.mockResolvedValue({ ok: true, url: 'https://foreign.example/intro', json: vi.fn(async () => ({ intro: { startSeconds: 0, endSeconds: 5 } })) });
    expect(await fetchIntroCatalog(url)).toBeNull();
  });

  it('deadlines stalled fetches even when native transport ignores abort', async () => {
    vi.useFakeTimers();
    mock.fetch.mockImplementation(() => new Promise(() => {}));
    const pending = fetchIntroCatalog(url);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(mock.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('covers the response body with the same deadline', async () => {
    vi.useFakeTimers();
    mock.fetch.mockResolvedValue({ ok: true, url, json: () => new Promise(() => {}) });
    const pending = fetchIntroCatalog(url);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns immediately on abort and ignores a late response body', async () => {
    let finish!: (body: unknown) => void;
    mock.fetch.mockResolvedValue({ ok: true, url, json: () => new Promise((resolve) => { finish = resolve; }) });
    const controller = new AbortController();
    const pending = fetchIntroCatalog(url, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toBeNull();
    finish({ intro: { startSeconds: 0, endSeconds: 5 } });
    await Promise.resolve();
    expect(mock.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
});
