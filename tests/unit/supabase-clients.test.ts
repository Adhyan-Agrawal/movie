import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publicEnv: { NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-key' },
  cookies: vi.fn(), createServerClient: vi.fn(), createClient: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ publicEnv: mocks.publicEnv }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));

import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabasePublicClient } from '@/lib/supabase/public';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'synthetic-public-anon-key';
  mocks.publicEnv.NEXT_PUBLIC_SUPABASE_URL = 'https://project.example.test';
});

describe('Supabase client session boundaries', () => {
  it('creates anonymous clients with no cookies, token refresh, persistence, or cross-request reuse', () => {
    const a = {}; const b = {};
    mocks.createClient.mockReturnValueOnce(a).mockReturnValueOnce(b);
    expect(getSupabasePublicClient()).toBe(a);
    expect(getSupabasePublicClient()).toBe(b);
    expect(mocks.createClient).toHaveBeenCalledTimes(2);
    for (const call of mocks.createClient.mock.calls) expect(call).toEqual([
      'https://project.example.test', 'synthetic-public-anon-key',
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    ]);
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it('reads only the current request cookies and propagates every session cookie and its expiry options', async () => {
    const getAll = vi.fn().mockReturnValue([{ name: 'sb-fixture-auth-token', value: 'synthetic-session-a' }]);
    const set = vi.fn();
    mocks.cookies.mockResolvedValue({ getAll, set });
    mocks.createServerClient.mockReturnValue({});
    await getSupabaseServerClient();
    const [url, key, options] = mocks.createServerClient.mock.calls[0]!;
    expect(url).toBe('https://project.example.test');
    expect(key).toBe('synthetic-public-anon-key');
    expect(options.cookies.getAll()).toEqual([{ name: 'sb-fixture-auth-token', value: 'synthetic-session-a' }]);
    options.cookies.setAll([
      { name: 'sb-fixture-auth-token.0', value: 'chunk-a', options: { path: '/', sameSite: 'lax', secure: true } },
      { name: 'sb-fixture-auth-token.1', value: '', options: { path: '/', maxAge: 0 } },
    ]);
    expect(set).toHaveBeenNthCalledWith(1, 'sb-fixture-auth-token.0', 'chunk-a', { path: '/', sameSite: 'lax', secure: true });
    expect(set).toHaveBeenNthCalledWith(2, 'sb-fixture-auth-token.1', '', { path: '/', maxAge: 0 });
  });

  it('does not share server clients or cookie stores between different request owners', async () => {
    const a = { getAll: () => [{ name: 'session', value: 'a' }], set: vi.fn() };
    const b = { getAll: () => [{ name: 'session', value: 'b' }], set: vi.fn() };
    mocks.cookies.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    mocks.createServerClient.mockImplementation((_url, _key, options) => options.cookies);
    const ca: any = await getSupabaseServerClient(); const cb: any = await getSupabaseServerClient();
    expect(ca).not.toBe(cb);
    expect(ca.getAll()).toEqual(a.getAll()); expect(cb.getAll()).toEqual(b.getAll());
    cb.setAll([{ name: 'session', value: '', options: { maxAge: 0 } }]);
    expect(b.set).toHaveBeenCalledOnce(); expect(a.set).not.toHaveBeenCalled();
  });

  it('fails before constructing either client when public configuration is missing', async () => {
    mocks.publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY = '';
    expect(() => getSupabasePublicClient()).toThrow('Supabase is not configured');
    await expect(getSupabaseServerClient()).rejects.toThrow('Supabase is not configured');
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });
});
