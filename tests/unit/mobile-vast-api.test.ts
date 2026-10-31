import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn() }));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabase: { auth: { getSession: mock.getSession } } }));
import { fetchVastCreative } from '../../mobile/src/lib/api';

const origin = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').replace(/\/$/, '');
const creative = { id: 'fixture', mediaUrl: 'https://ads.example.com/ad.mp4', durationSeconds: 30, skipAfterSeconds: 5,
  tracking: { impression: ['https://ads.example.com/impression'] }, clickThrough: 'https://ads.example.com/details', clickTracking: ['https://ads.example.com/click'] };
const response = (ad: unknown = creative) => new Response(JSON.stringify({ creative: ad }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mock.fetch);
  mock.getSession.mockResolvedValue({ data: { session: { access_token: 'fixture-bearer' } }, error: null });
  mock.fetch.mockImplementation(async () => response());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Native VAST opt-in and public API boundary', () => {
  it('does not access auth or request anything without separate explicit advertising opt-in', async () => {
    expect(await fetchVastCreative(false)).toBeNull();
    expect(mock.getSession).not.toHaveBeenCalled();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('requests the existing web origin with consent=1 and bearer, never a client-side tag or secret', async () => {
    expect(await fetchVastCreative(true)).toEqual(creative);
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(`${origin}/api/vast?consent=1`, {
      signal: expect.any(AbortSignal), headers: { Authorization: 'Bearer fixture-bearer' }, credentials: 'omit', redirect: 'error',
    });
  });

  it('keeps anonymous requests credential-free and leaves eligibility validation to the server', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mock.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await fetchVastCreative(true)).toBeNull();
    expect(mock.fetch.mock.calls[0]?.[1].headers).toEqual({});
  });

  it('fails closed on uncertain auth without falling back to an anonymous ad', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: new Error('unavailable') });
    expect(await fetchVastCreative(true)).toBeNull();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it.each([204, 401, 403, 500])('returns no creative for HTTP %s', async (status) => {
    mock.fetch.mockResolvedValue(new Response(null, { status }));
    expect(await fetchVastCreative(true)).toBeNull();
  });

  it.each([null, {}, { ...creative, id: '' }, { ...creative, mediaUrl: 'http://ads.example.com/ad.mp4' },
    { ...creative, mediaUrl: 'https://u:p@ads.example.com/ad.mp4' }, { ...creative, durationSeconds: 0 },
    { ...creative, durationSeconds: 601 }, { ...creative, durationSeconds: '30' }, { ...creative, skipAfterSeconds: undefined },
    { ...creative, skipAfterSeconds: 31 }, { ...creative, tracking: [] }])('ignores a malformed creative %j', async (value) => {
    mock.fetch.mockResolvedValue(response(value));
    expect(await fetchVastCreative(true)).toBeNull();
  });

  it('returns only concrete public fields and bounded deduped HTTPS event/click arrays', async () => {
    mock.fetch.mockResolvedValue(response({ ...creative, skipAfterSeconds: null, tagUrl: 'private-tag', providerSecret: 'not-public',
      clickThrough: 'javascript:alert(1)', clickTracking: ['http://ads.example.com/no', 'https://ads.example.com/click', 'https://ads.example.com/click'],
      tracking: { impression: ['https://ads.example.com/impression', 'https://ads.example.com/impression', 123, 'http://ads.example.com/no'],
        error: Array.from({ length: 30 }, (_, n) => `https://ads.example.com/error/${n}`), unsupported: ['https://ads.example.com/no'] } }));
    const ad = await fetchVastCreative(true);
    expect(ad?.tracking.impression).toEqual(['https://ads.example.com/impression']);
    expect(ad?.tracking.error).toHaveLength(20);
    expect(ad?.clickTracking).toEqual(['https://ads.example.com/click']);
    expect(ad?.clickThrough).toBeUndefined();
    expect(ad?.skipAfterSeconds).toBeNull();
    expect(Object.keys(ad!).sort()).toEqual(['clickTracking', 'durationSeconds', 'id', 'mediaUrl', 'skipAfterSeconds', 'tracking']);
  });

  it('handles offline and invalid JSON as no-fill without throwing', async () => {
    mock.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('<html>unavailable</html>'));
    expect(await fetchVastCreative(true)).toBeNull();
    expect(await fetchVastCreative(true)).toBeNull();
  });

  it('ignores pre-cancelled requests without auth/network access', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await fetchVastCreative(true, controller.signal)).toBeNull();
    expect(mock.getSession).not.toHaveBeenCalled();
  });

  it('returns promptly on background/navigation cancellation even if fetch ignores abort', async () => {
    mock.fetch.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = fetchVastCreative(true, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toBeNull();
    expect(mock.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('deadlines stalled auth and prevents late lookup from starting a request', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    mock.getSession.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = fetchVastCreative(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
    resolve({ data: { session: { access_token: 'late-token' } }, error: null });
    await Promise.resolve();
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('deadlines a stalled response without leaving retry timers behind', async () => {
    vi.useFakeTimers();
    mock.fetch.mockImplementation(() => new Promise(() => {}));
    const pending = fetchVastCreative(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
