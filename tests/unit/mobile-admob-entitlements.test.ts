import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ getSession: vi.fn(), fetch: vi.fn(), url: 'https://lumora.example/api/account/subscription' }));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabase: { auth: { getSession: mock.getSession } } }));
vi.mock('../../mobile/src/lib/api', () => ({ sameOriginPlaybackUrl: () => mock.url }));
import { fetchAdMobEntitlements } from '../../mobile/src/ads/entitlements';

const entitlements = { resolved: true, adFree: false, status: 'free', maxProfiles: 1 };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', mock.fetch);
  mock.url = 'https://lumora.example/api/account/subscription';
  mock.getSession.mockResolvedValue({ data: { session: { user: { id: 'viewer' }, access_token: 'test-bearer' } }, error: null });
  mock.fetch.mockImplementation(async () => new Response(JSON.stringify({ entitlements })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('AdMob signed-in entitlement boundary', () => {
  it('uses the existing web API and bearer, omits cookies and refuses redirects', async () => {
    expect(await fetchAdMobEntitlements()).toEqual({ accountId: 'viewer', entitlements });
    expect(mock.fetch).toHaveBeenCalledExactlyOnceWith(mock.url, { signal: expect.any(AbortSignal), credentials: 'omit',
      redirect: 'error', headers: { Authorization: 'Bearer test-bearer' } });
  });
  it.each([null, { user: { id: 'viewer' } }, { user: {}, access_token: 'test-bearer' }])('never fetches private entitlements for absent/incomplete sessions %j', async (session) => {
    mock.getSession.mockResolvedValue({ data: { session }, error: null });
    expect(await fetchAdMobEntitlements()).toBeNull();
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('fails closed on session errors and insecure API URLs', async () => {
    mock.getSession.mockResolvedValueOnce({ data: { session: null }, error: new Error('offline') });
    expect(await fetchAdMobEntitlements()).toBeNull();
    mock.url = 'http://lumora.example/api/account/subscription';
    expect(await fetchAdMobEntitlements()).toBeNull();
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])('does not invent ad eligibility after HTTP %s', async (status) => {
    mock.fetch.mockResolvedValue(new Response(null, { status }));
    expect(await fetchAdMobEntitlements()).toEqual({ accountId: 'viewer', entitlements: null });
  });
  it.each([undefined, { ...entitlements, resolved: false }, { ...entitlements, adFree: 'false' },
    { ...entitlements, status: 'unavailable' }, { ...entitlements, maxProfiles: 0 }])('discards uncertain/malformed entitlement DTO %j', async (value) => {
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ entitlements: value })));
    expect(await fetchAdMobEntitlements()).toEqual({ accountId: 'viewer', entitlements: null });
  });
  it('preserves ad-free status rather than overriding it for SDK testing', async () => {
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ entitlements: { ...entitlements, adFree: true } })));
    expect((await fetchAdMobEntitlements())?.entitlements?.adFree).toBe(true);
  });
  it('cancels promptly even if fetch does not implement AbortSignal', async () => {
    mock.fetch.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = fetchAdMobEntitlements(controller.signal);
    await Promise.resolve(); controller.abort();
    expect(await pending).toBeNull();
    expect(mock.fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
  it('deadlines stalled auth without sending a late request', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    mock.getSession.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = fetchAdMobEntitlements();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBeNull();
    resolve({ data: { session: { user: { id: 'viewer' }, access_token: 'late-token' } }, error: null });
    await Promise.resolve(); expect(mock.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('handles offline/invalid JSON without throwing or allowing ads', async () => {
    mock.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('not-json'));
    expect(await fetchAdMobEntitlements()).toBeNull();
    expect(await fetchAdMobEntitlements()).toBeNull();
  });
});
