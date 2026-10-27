import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cookieFactory: vi.fn(), createClient: vi.fn(), configured: { supabaseConfigured: true } }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.configured, publicEnv: { NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.com', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public' } }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.cookieFactory }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
import { commerceIdentity } from '@/features/commerce/auth';

function client(user: { id: string } | null, error: { name: string } | null = null) {
  return { auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error }) } };
}

beforeEach(() => { vi.clearAllMocks(); mocks.configured.supabaseConfigured = true; });

describe('request-scoped commerce identity', () => {
  it('uses and verifies web cookies when no bearer is supplied', async () => {
    const db = client({ id: 'web' }); mocks.cookieFactory.mockResolvedValue(db);
    expect((await commerceIdentity()).user?.id).toBe('web');
    expect(db.auth.getUser).toHaveBeenCalledWith();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it('validates Android bearer with getUser(token) and sends it to RLS queries', async () => {
    const db = client({ id: 'android' }); mocks.createClient.mockReturnValue(db);
    expect((await commerceIdentity(new Request('https://app.example.com', { headers: { authorization: 'Bearer valid.jwt.token' } }))).user?.id).toBe('android');
    expect(db.auth.getUser).toHaveBeenCalledWith('valid.jwt.token');
    expect(mocks.createClient.mock.calls[0]![2].global.headers.Authorization).toBe('Bearer valid.jwt.token');
    expect(mocks.cookieFactory).not.toHaveBeenCalled();
  });
  it.each(['Basic abc', 'Bearer', 'Bearer bad token', 'Bearer token\tother'])('never falls back to cookies for malformed authorization %s', async (authorization) => {
    await expect(commerceIdentity(new Request('https://app.example.com', { headers: { authorization } }))).rejects.toThrow();
    expect(mocks.cookieFactory).not.toHaveBeenCalled();
  });
  it('denies an invalid or expired bearer without accepting cookie identity', async () => {
    mocks.createClient.mockReturnValue(client(null, { name: 'AuthApiError' }));
    await expect(commerceIdentity(new Request('https://app.example.com', { headers: { authorization: 'Bearer expired' } }))).rejects.toThrow();
    expect(mocks.cookieFactory).not.toHaveBeenCalled();
  });
  it('distinguishes verified missing web session from auth/network uncertainty', async () => {
    mocks.cookieFactory.mockResolvedValue(client(null, { name: 'AuthSessionMissingError' }));
    expect((await commerceIdentity()).user).toBeNull();
    mocks.cookieFactory.mockResolvedValue(client(null, { name: 'AuthRetryableFetchError' }));
    await expect(commerceIdentity()).rejects.toThrow('Unable to verify');
  });
  it('does not create a service-role identity or share clients across requests', async () => {
    mocks.createClient.mockReturnValueOnce(client({ id: 'a' })).mockReturnValueOnce(client({ id: 'b' }));
    const a = await commerceIdentity(new Request('https://app.example.com', { headers: { authorization: 'Bearer account-a' } }));
    const b = await commerceIdentity(new Request('https://app.example.com', { headers: { authorization: 'Bearer account-b' } }));
    expect(a.user?.id).toBe('a'); expect(b.user?.id).toBe('b'); expect(a.db).not.toBe(b.db);
  });
  it('fails closed when Supabase is unconfigured', async () => {
    mocks.configured.supabaseConfigured = false;
    await expect(commerceIdentity()).rejects.toThrow('unavailable');
  });
});
