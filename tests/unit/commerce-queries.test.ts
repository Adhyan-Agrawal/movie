import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ identity: vi.fn(), service: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/features/commerce/auth', () => ({ commerceIdentity: mocks.identity }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
import { getPlaybackCommerceContext, getVastConfiguration, getViewerEntitlements, invalidatePlaybackPolicy } from '@/features/commerce/queries';
import { DEFAULT_VAST_CONFIGURATION, FREE_ENTITLEMENTS } from '@/features/commerce/types';

const config = { ...DEFAULT_VAST_CONFIGURATION, enabled: true, tagUrl: 'https://ads.example.com/tag?secret=private', allowedHosts: ['ads.example.com'] };
function entitlements(data: unknown, error: unknown = null) {
  const rpc = vi.fn(() => ({ abortSignal: vi.fn().mockResolvedValue({ data, error }) }));
  return { user: { id: 'account' }, db: { rpc } };
}
function configuration(value: unknown = config, error: unknown = null, isPublic = false) {
  const query = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { value, is_public: isPublic }, error }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.abortSignal.mockReturnValue(query);
  return { from: vi.fn(() => query) };
}
beforeEach(() => { vi.clearAllMocks(); invalidatePlaybackPolicy(); mocks.identity.mockResolvedValue(entitlements(FREE_ENTITLEMENTS)); mocks.service.mockReturnValue(configuration()); });
afterEach(() => { vi.useRealTimers(); });

describe('commerce playback reads', () => {
  it('permits configured scheduling only after free entitlement resolution', async () => {
    const context = await getPlaybackCommerceContext();
    expect(context.entitlements).toEqual(FREE_ENTITLEMENTS); expect(context.ads.enabled).toBe(true);
    expect(context.ads).not.toHaveProperty('tagUrl'); expect(context.ads).not.toHaveProperty('allowedHosts');
  });
  it('suppresses ads for an active ad-free account', async () => {
    mocks.identity.mockResolvedValue(entitlements({ resolved: true, adFree: true, maxProfiles: 4, status: 'active', planName: 'Premium' }));
    const context = await getPlaybackCommerceContext();
    expect(context.entitlements.adFree).toBe(true); expect(context.ads.enabled).toBe(false);
  });
  it('degrades missing migration to unresolved entitlements and no ad flash', async () => {
    mocks.identity.mockResolvedValue(entitlements(null, { code: 'PGRST202' }));
    const context = await getPlaybackCommerceContext();
    expect(context.entitlements.resolved).toBe(false); expect(context.entitlements.status).toBe('unavailable'); expect(context.ads.enabled).toBe(false);
  });
  it('never treats network/auth failure as a known free account', async () => {
    mocks.identity.mockRejectedValue(new Error('network'));
    expect((await getPlaybackCommerceContext()).ads.enabled).toBe(false);
    expect((await getViewerEntitlements()).resolved).toBe(false);
  });
  it('rejects malformed entitlement output', async () => {
    mocks.identity.mockResolvedValue(entitlements({ resolved: true, adFree: false, maxProfiles: -1, status: 'free' }));
    expect((await getViewerEntitlements()).resolved).toBe(false);
  });
  it('does not cross-cache paid and free request identities', async () => {
    mocks.identity.mockResolvedValueOnce(entitlements({ resolved: true, adFree: true, maxProfiles: 4, status: 'active' }))
      .mockResolvedValueOnce(entitlements(FREE_ENTITLEMENTS));
    const a = new Request('https://app.example.com', { headers: { authorization: 'Bearer a' } });
    const b = new Request('https://app.example.com', { headers: { authorization: 'Bearer b' } });
    expect((await getPlaybackCommerceContext(a)).ads.enabled).toBe(false);
    expect((await getPlaybackCommerceContext(b)).ads.enabled).toBe(true);
    expect(mocks.identity).toHaveBeenNthCalledWith(1, a); expect(mocks.identity).toHaveBeenNthCalledWith(2, b);
    expect(mocks.service).toHaveBeenCalledTimes(1);
  });
  it('returns validated full VAST config only from the server accessor', async () => {
    expect(await getVastConfiguration()).toEqual(config);
    expect(JSON.stringify((await getPlaybackCommerceContext()).ads)).not.toContain('private');
  });
  it.each([configuration({ ...config, tagUrl: 'http://127.0.0.1/tag' }), configuration(config, { message: 'unavailable' }), configuration(config, null, true)])('disables malformed, failed, or mistakenly public VAST config', async (db) => {
    mocks.service.mockReturnValue(db);
    expect((await getVastConfiguration()).enabled).toBe(false);
    expect((await getVastConfiguration()).tagUrl).toBe('');
  });
  it('caches scheduling briefly but never caches provider secrets', async () => {
    vi.useFakeTimers();
    expect((await getPlaybackCommerceContext()).ads.enabled).toBe(true);
    mocks.service.mockReturnValue(configuration(DEFAULT_VAST_CONFIGURATION));
    expect((await getPlaybackCommerceContext()).ads.enabled).toBe(true);
    vi.advanceTimersByTime(15001);
    expect((await getPlaybackCommerceContext()).ads.enabled).toBe(false);
    expect(mocks.identity).toHaveBeenCalledTimes(3);
  });
  it('bounds an unverifiable identity wait and cleans up its deadline', async () => {
    vi.useFakeTimers(); mocks.identity.mockReturnValue(new Promise(() => {}));
    const result = getViewerEntitlements();
    await vi.advanceTimersByTimeAsync(2001);
    expect((await result).resolved).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
