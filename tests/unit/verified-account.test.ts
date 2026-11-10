import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true },
  publicEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://lumora.example.test',
  },
  cookieClient: vi.fn(), bearerClient: vi.fn(), serviceClient: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features, publicEnv: mocks.publicEnv }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.cookieClient }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.serviceClient }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.bearerClient }));

import { getVerifiedAccount } from '@/features/auth/verified-account';
import { GET } from '@/app/auth/callback/route';

const user = { id: 'viewer-a', email: 'viewer@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' };
const privateError = 'private provider response with synthetic credentials';

function client(verifiedUser: object | null = user, error: object | null = null) {
  return { auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: verifiedUser }, error }),
    getSession: vi.fn(() => { throw new Error('Cookie claims are not verified identity.'); }),
    exchangeCodeForSession: vi.fn().mockResolvedValue({ data: { user, session: { user } }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  } };
}
function request(authorization?: string) {
  return new Request('https://lumora.example.test/api/account', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.features.supabaseConfigured = true;
  mocks.publicEnv.NEXT_PUBLIC_APP_URL = 'https://lumora.example.test';
  mocks.cookieClient.mockResolvedValue(client());
  mocks.bearerClient.mockImplementation(() => client());
  mocks.serviceClient.mockImplementation(() => { throw new Error('Service clients cannot authenticate viewers.'); });
});

describe('verified, request-scoped account identities', () => {
  it('provider-verifies SSR cookies and returns that exact user-scoped client', async () => {
    const db = client();
    mocks.cookieClient.mockResolvedValue(db);
    expect(await getVerifiedAccount()).toEqual({ status: 'authenticated', user, client: db });
    expect(db.auth.getUser).toHaveBeenCalledExactlyOnceWith();
    expect(db.auth.getSession).not.toHaveBeenCalled();
    expect(mocks.bearerClient).not.toHaveBeenCalled();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it('provider-verifies an explicit Bearer and binds every database request to that token, not web cookies', async () => {
    const db = client();
    mocks.bearerClient.mockReturnValue(db);
    expect(await getVerifiedAccount(request('Bearer fixture.jwt.token'))).toEqual({ status: 'authenticated', user, client: db });
    expect(db.auth.getUser).toHaveBeenCalledExactlyOnceWith('fixture.jwt.token');
    expect(mocks.bearerClient).toHaveBeenCalledExactlyOnceWith('https://project.example.test', 'synthetic-public-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: 'Bearer fixture.jwt.token' } },
    });
    expect(mocks.cookieClient).not.toHaveBeenCalled();
  });

  it.each(['', 'Basic fixture', 'Bearer', 'Bearer token extra', 'Bearer a,b', 'Bearer a\tb'])('rejects malformed authorization without a cookie fallback: %s', async (authorization) => {
    expect(await getVerifiedAccount(request(authorization))).toEqual({ status: 'unauthenticated' });
    expect(mocks.cookieClient).not.toHaveBeenCalled();
    expect(mocks.bearerClient).not.toHaveBeenCalled();
  });

  it('does not turn an invalid Bearer into the valid cookie account', async () => {
    mocks.bearerClient.mockReturnValue(client(null, { status: 403, code: 'bad_jwt' }));
    expect(await getVerifiedAccount(request('Bearer invalid'))).toEqual({ status: 'unauthenticated' });
    expect(mocks.cookieClient).not.toHaveBeenCalled();
  });

  it.each(['session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'invalid_jwt'])('treats provider-declared invalid sessions as signed out, not a service outage: %s', async (code) => {
    mocks.cookieClient.mockResolvedValue(client(null, { status: 400, code }));
    expect(await getVerifiedAccount()).toEqual({ status: 'unauthenticated' });
  });

  it('does not authenticate a malformed provider user without an identity', async () => {
    mocks.cookieClient.mockResolvedValue(client({ ...user, id: '' }));
    expect(await getVerifiedAccount()).toEqual({ status: 'unavailable' });
  });

  it.each([
    { ...user, email_confirmed_at: undefined, user_metadata: { email_verified: true, confirmed: true } },
    { ...user, email_confirmed_at: undefined, phone_confirmed_at: '2026-01-01T00:00:00Z', confirmed_at: '2026-01-01T00:00:00Z' },
    { ...user, email: undefined },
  ])('does not accept metadata, phone confirmation, or missing email as verified email', async (unverified) => {
    mocks.cookieClient.mockResolvedValue(client(unverified));
    expect(await getVerifiedAccount()).toEqual({ status: 'unverified' });
  });

  it('distinguishes no session from provider uncertainty and malformed service configuration', async () => {
    mocks.cookieClient.mockResolvedValue(client(null, { name: 'AuthSessionMissingError' }));
    expect(await getVerifiedAccount()).toEqual({ status: 'unauthenticated' });
    mocks.cookieClient.mockResolvedValue(client(null));
    expect(await getVerifiedAccount()).toEqual({ status: 'unauthenticated' });
    for (const error of [
      { status: 503, message: privateError }, { name: 'AuthRetryableFetchError', message: privateError },
      { status: 401, message: privateError }, { status: 429, code: 'over_request_rate_limit' },
    ]) {
      mocks.cookieClient.mockResolvedValue(client(user, error));
      expect(await getVerifiedAccount()).toEqual({ status: 'unavailable' });
    }
    mocks.cookieClient.mockRejectedValue(new Error(privateError));
    expect(await getVerifiedAccount()).toEqual({ status: 'unavailable' });
  });

  it('does no provider work without real configuration', async () => {
    mocks.features.supabaseConfigured = false;
    expect(await getVerifiedAccount(request('Bearer token'))).toEqual({ status: 'unavailable' });
    expect(mocks.cookieClient).not.toHaveBeenCalled();
    expect(mocks.bearerClient).not.toHaveBeenCalled();
  });

  it('never shares user-scoped clients or identities across web or Bearer requests', async () => {
    const other = { ...user, id: 'viewer-b', email: 'b@example.test' };
    const a = client(user); const b = client(other);
    mocks.cookieClient.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    expect(await getVerifiedAccount()).toEqual({ status: 'authenticated', user, client: a });
    expect(await getVerifiedAccount()).toEqual({ status: 'authenticated', user: other, client: b });
    mocks.bearerClient.mockReturnValueOnce(a).mockReturnValueOnce(b);
    expect(await getVerifiedAccount(request('Bearer account-a'))).toEqual({ status: 'authenticated', user, client: a });
    expect(await getVerifiedAccount(request('Bearer account-b'))).toEqual({ status: 'authenticated', user: other, client: b });
    expect(a.auth.getUser).toHaveBeenLastCalledWith('account-a');
    expect(b.auth.getUser).toHaveBeenLastCalledWith('account-b');
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});

describe('email confirmation callback', () => {
  it('exchanges the code, verifies the resulting account, and redirects without leaking code or request-host headers', async () => {
    const db = client(); mocks.cookieClient.mockResolvedValue(db);
    const response = await GET(new Request('https://lumora.example.test/auth/callback?code=one-use-code&next=%2Faccount%2Fhistory', {
      headers: { host: 'evil.example.test', 'x-forwarded-host': 'evil.example.test' },
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://lumora.example.test/account/history');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(db.auth.exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith('one-use-code');
    expect(db.auth.getUser).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example.test', '//evil.example.test', '/a/..//evil.example.test', '/auth/callback', '/signin'])('never redirects a confirmed session to an unsafe destination: %s', async (next) => {
    const response = await GET(new Request(`https://lumora.example.test/auth/callback?code=fixture&next=${encodeURIComponent(next)}`));
    expect(response.headers.get('location')).toBe('https://lumora.example.test/account');
  });

  it.each(['', '?code=', '?code=a&code=b', '?error=access_denied&error_description=private', '?code=valid&error=denied'])('rejects missing, ambiguous, or provider-rejected callbacks before touching a session: %s', async (query) => {
    const response = await GET(new Request(`https://lumora.example.test/auth/callback${query}`));
    expect(new URL(response.headers.get('location')!).searchParams.get('auth')).toBe('callback');
    expect(mocks.cookieClient).not.toHaveBeenCalled();
  });

  it('does not accept an existing valid cookie identity after a bad or reused confirmation code', async () => {
    const db = client(); mocks.cookieClient.mockResolvedValue(db);
    db.auth.exchangeCodeForSession.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, code: 'bad_code_verifier', message: privateError } });
    const response = await GET(new Request('https://lumora.example.test/auth/callback?code=expired'));
    const location = response.headers.get('location')!;
    expect(new URL(location).searchParams.get('auth')).toBe('callback');
    expect(location).not.toContain(privateError);
    expect(db.auth.getUser).not.toHaveBeenCalled();
    expect(db.auth.signOut).not.toHaveBeenCalled();
  });

  it.each(['exchange', 'verification', 'construction'])('reports %s provider failure without claiming confirmation succeeded', async (stage) => {
    const db = client(); mocks.cookieClient.mockResolvedValue(db);
    if (stage === 'exchange') db.auth.exchangeCodeForSession.mockRejectedValue(new Error(privateError));
    if (stage === 'verification') db.auth.getUser.mockRejectedValue(new Error(privateError));
    if (stage === 'construction') mocks.cookieClient.mockRejectedValue(new Error(privateError));
    const response = await GET(new Request('https://lumora.example.test/auth/callback?code=fixture'));
    expect(new URL(response.headers.get('location')!).searchParams.get('auth')).toBe('unavailable');
    expect(response.headers.get('location')).not.toContain(privateError);
  });

  it('rejects unconfirmed email after exchange and clears only that newly issued local session', async () => {
    const db = client({ ...user, email_confirmed_at: undefined }); mocks.cookieClient.mockResolvedValue(db);
    const response = await GET(new Request('https://lumora.example.test/auth/callback?code=fixture'));
    expect(new URL(response.headers.get('location')!).searchParams.get('auth')).toBe('unverified');
    expect(db.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  });

  it('does not accept a callback identity different from the exchanged user', async () => {
    mocks.cookieClient.mockResolvedValue(client({ ...user, id: 'different-viewer' }));
    const response = await GET(new Request('https://lumora.example.test/auth/callback?code=fixture'));
    expect(new URL(response.headers.get('location')!).searchParams.get('auth')).toBe('unavailable');
  });

  it('performs no exchange without configured Supabase or a safe canonical origin', async () => {
    mocks.features.supabaseConfigured = false;
    const response = await GET(new Request('https://lumora.example.test/auth/callback?code=fixture'));
    expect(new URL(response.headers.get('location')!).searchParams.get('auth')).toBe('unavailable');
    mocks.publicEnv.NEXT_PUBLIC_APP_URL = 'https://user:password@example.test';
    expect((await GET(new Request('https://lumora.example.test/auth/callback?code=fixture'))).status).toBe(503);
    expect(mocks.cookieClient).not.toHaveBeenCalled();
  });
});
