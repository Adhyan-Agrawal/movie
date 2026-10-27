import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ identity: vi.fn(), service: vi.fn(), createClient: vi.fn(), invalidate: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/features/commerce/auth', () => ({ commerceIdentity: mocks.identity }));
vi.mock('@/features/commerce/queries', () => ({ invalidatePlaybackPolicy: mocks.invalidate }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('@/lib/env', () => ({ publicEnv: { NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.com', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public' } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
import { listCommercePlans, mutateCommercePlan, mutateCommerceSubscription, saveVastConfiguration, subscriptionMutationSchema } from '@/features/commerce/admin';
import { DEFAULT_VAST_CONFIGURATION } from '@/features/commerce/types';

const actor = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const planId = '00000000-0000-4000-8000-000000000003';
const plan = { slug: 'premium', name: 'Premium', description: '', currency: 'USD', priceMinor: 999,
  billingInterval: 'month', adFree: true, maxProfiles: 4, features: ['No ads'] };
const request = { operation: 'create', plan, reason: 'Publish premium access', password: 'correct-password' };

let rpc: ReturnType<typeof vi.fn>;
let signIn: ReturnType<typeof vi.fn>;
let signOut: ReturnType<typeof vi.fn>;
function identity(allowed = true, suspended = false) {
  const accountQuery = { select: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { is_suspended: suspended }, error: null }) };
  accountQuery.select.mockReturnValue(accountQuery); accountQuery.eq.mockReturnValue(accountQuery); accountQuery.abortSignal.mockReturnValue(accountQuery);
  return { user: { id: actor, email: 'admin@example.com' }, db: {
    rpc: vi.fn(() => ({ abortSignal: vi.fn().mockResolvedValue({ data: allowed, error: null }) })),
    from: vi.fn(() => accountQuery),
  } };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.identity.mockResolvedValue(identity());
  rpc = vi.fn().mockResolvedValue({ data: planId, error: null }); mocks.service.mockReturnValue({ rpc });
  signIn = vi.fn().mockResolvedValue({ data: { user: { id: actor }, session: { access_token: 'ephemeral' } }, error: null });
  signOut = vi.fn().mockResolvedValue({ error: null });
  mocks.createClient.mockReturnValue({ auth: { signInWithPassword: signIn, signOut } });
});

describe('sensitive commerce mutations', () => {
  it('re-verifies the administrator before invoking one transactional audit RPC', async () => {
    expect(await mutateCommercePlan(request)).toBe(planId);
    expect(signIn).toHaveBeenCalledWith({ email: 'admin@example.com', password: 'correct-password' });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('commerce_manage_plan', { p_actor: actor, p_operation: 'create', p_id: null, p_payload: plan, p_reason: request.reason });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('correct-password');
  });
  it('denies viewers before attempting password verification or service writes', async () => {
    mocks.identity.mockResolvedValue(identity(false));
    await expect(mutateCommercePlan(request)).rejects.toMatchObject({ status: 403 });
    expect(signIn).not.toHaveBeenCalled(); expect(mocks.service).not.toHaveBeenCalled();
  });
  it('denies suspended administrators even if their permission remains assigned', async () => {
    mocks.identity.mockResolvedValue(identity(true, true));
    await expect(mutateCommercePlan(request)).rejects.toMatchObject({ status: 403 });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('denies anonymous mutation callers', async () => {
    mocks.identity.mockResolvedValue({ user: null, db: {} });
    await expect(mutateCommercePlan(request)).rejects.toMatchObject({ status: 401 });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('failed reauthentication cannot activate access', async () => {
    signIn.mockResolvedValue({ data: { user: null, session: null }, error: new Error('bad password') });
    await expect(mutateCommercePlan(request)).rejects.toThrow('verification failed');
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('reauthenticated user must match the actual request actor', async () => {
    signIn.mockResolvedValue({ data: { user: { id: accountId }, session: null }, error: null });
    await expect(mutateCommercePlan(request)).rejects.toThrow('verification failed');
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('requires a reason and rejects attacker-supplied actor/provider data', async () => {
    await expect(mutateCommercePlan({ ...request, reason: '' })).rejects.toMatchObject({ status: 400 });
    await expect(mutateCommercePlan({ ...request, actorId: accountId })).rejects.toMatchObject({ status: 400 });
    await expect(mutateCommercePlan({ ...request, paymentProvider: 'fake' })).rejects.toMatchObject({ status: 400 });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('does not report success when the transactional RPC fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'private database detail' } });
    await expect(mutateCommercePlan(request)).rejects.toMatchObject({ status: 409 });
    await expect(mutateCommercePlan(request)).rejects.not.toThrow('private database detail');
  });
  it('supports only explicit manual grants with a finite expiry', async () => {
    const accessUntil = new Date(Date.now() + 86400000).toISOString();
    await mutateCommerceSubscription({ operation: 'grant', accountId, planId, accessUntil, reason: 'Customer support exception', password: 'correct-password' });
    expect(rpc).toHaveBeenCalledWith('commerce_manage_subscription', { p_actor: actor, p_operation: 'grant', p_account: accountId,
      p_plan: planId, p_subscription: null, p_access_until: accessUntil, p_reason: 'Customer support exception' });
    expect(subscriptionMutationSchema.safeParse({ operation: 'grant', accountId, planId, reason: 'Manual exception', password: 'pw' }).success).toBe(false);
    expect(subscriptionMutationSchema.safeParse({ operation: 'activate_payment', accountId, planId, accessUntil, reason: 'Fake checkout', password: 'pw' }).success).toBe(false);
  });
  it('rejects expired grants and unsupported payment activation before service access', async () => {
    await expect(mutateCommerceSubscription({ operation: 'grant', accountId, planId, accessUntil: '2000-01-01T00:00:00Z', reason: 'Old exception', password: 'pw' })).rejects.toMatchObject({ status: 400 });
    await expect(mutateCommerceSubscription({ operation: 'checkout', accountId, planId, reason: 'Fake checkout', password: 'pw' })).rejects.toMatchObject({ status: 400 });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('VAST changes require ads.manage, validated config and one audited RPC', async () => {
    const current = identity(); mocks.identity.mockResolvedValue(current);
    await saveVastConfiguration(DEFAULT_VAST_CONFIGURATION, 'Disable playback advertising', 'pw');
    expect(current.db.rpc).toHaveBeenCalledWith('has_permission', { perm_key: 'ads.manage' });
    expect(rpc).toHaveBeenCalledWith('commerce_save_vast', { p_actor: actor, p_config: DEFAULT_VAST_CONFIGURATION, p_reason: 'Disable playback advertising' });
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
  it('unsafe VAST config never reaches service storage', async () => {
    await expect(saveVastConfiguration({ ...DEFAULT_VAST_CONFIGURATION, enabled: true, tagUrl: 'http://127.0.0.1/tag' }, 'Change advertising', 'pw')).rejects.toMatchObject({ status: 400 });
    expect(mocks.service).not.toHaveBeenCalled();
  });
});

describe('public plan response', () => {
  it('does not read personal identity and exposes only public plan DTO fields', async () => {
    const raw = { ...plan, id: planId, version: 1, status: 'published', published_at: '2026-01-01T00:00:00Z',
      price_minor: 999, billing_interval: 'month', ad_free: true, max_profiles: 4,
      secret_provider_key: 'server-secret', created_at: '', updated_at: '' };
    const query = { select: vi.fn(), order: vi.fn(), limit: vi.fn(), eq: vi.fn(), abortSignal: vi.fn().mockResolvedValue({ data: [raw], error: null }) };
    for (const method of [query.select, query.order, query.limit, query.eq]) method.mockReturnValue(query);
    mocks.createClient.mockReturnValue({ from: vi.fn(() => query) });
    const result = await listCommercePlans();
    expect(result.resolved).toBe(true); expect(result.plans[0]!.priceMinor).toBe(999);
    expect(query.eq).toHaveBeenCalledWith('status', 'published'); expect(mocks.identity).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('server-secret');
    expect(result.plans[0]).not.toHaveProperty('created_at');
  });
});
