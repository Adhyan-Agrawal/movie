import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  redirect: vi.fn(), revalidate: vi.fn(), welcome: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({
  features: { supabaseConfigured: true },
  publicEnv: {
    NEXT_PUBLIC_APP_URL: 'https://lumora.example.test',
    NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-key',
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({
  getAll: () => [...mocks.jar].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string, options: { maxAge?: number }) => {
    if (!value || options?.maxAge === 0) mocks.jar.delete(name);
    else mocks.jar.set(name, value);
  },
}) }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/features/email/send', () => ({ sendWelcomeEmail: mocks.welcome }));

import { signInAction, signOutAction, signUpAction } from '@/features/auth/actions';
import { AUTH_INITIAL_STATE } from '@/features/auth/state';
import { getVerifiedAccount } from '@/features/auth/verified-account';
import { GET } from '@/app/auth/callback/route';
import { middleware } from '@/middleware';

const user = {
  id: '123e4567-e89b-42d3-a456-426614174000', aud: 'authenticated',
  email: 'viewer@example.test', email_confirmed_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'email' }, user_metadata: {},
};
const requests: { url: URL; method: string; body: Record<string, string>; authorization: string | null }[] = [];
let token: string;
let signupChallenge: string | undefined;

function form() {
  const data = new FormData();
  data.set('email', user.email); data.set('password', 'synthetic-password');
  data.set('confirm', 'synthetic-password'); data.set('next', '/account/history');
  return data;
}
function response(value: object, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function session() {
  return { access_token: token, refresh_token: 'synthetic-refresh-token', expires_in: 3600, token_type: 'bearer', user };
}

beforeEach(() => {
  vi.resetAllMocks(); mocks.jar.clear(); requests.length = 0; signupChallenge = undefined;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon-key');
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); });
  mocks.welcome.mockResolvedValue(undefined);
  token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({
    sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated',
  })).toString('base64url')}.synthetic-signature`;

  // Real Supabase SDK + SSR cookie adapters, with every HTTP call replaced in-process.
  // No request can fall through to a provider, DNS, or the network.
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://fixture.example.test') throw new Error('Unexpected network boundary');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const authorization = new Headers(init?.headers).get('authorization');
    requests.push({ url, method: init?.method ?? 'GET', body, authorization });
    if (url.pathname === '/auth/v1/signup') {
      signupChallenge = body.code_challenge;
      return response({ user: { ...user, email_confirmed_at: undefined } });
    }
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'pkce') {
        const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
        if (body.auth_code !== 'synthetic-one-use-code' || !signupChallenge || challenge !== signupChallenge) {
          return response({ code: 'bad_code_verifier', msg: 'Invalid confirmation code' }, 400);
        }
      }
      return response(session());
    }
    if (url.pathname === '/auth/v1/user' && authorization === `Bearer ${token}`) return response(user);
    if (url.pathname === '/auth/v1/logout') return response({});
    throw new Error('Unexpected provider operation');
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('offline real-SDK auth cookie lifecycle', () => {
  it('persists password login into request cookies, verifies it on the next request, and removes it on logout', async () => {
    await expect(signInAction(AUTH_INITIAL_STATE, form())).rejects.toThrow('NEXT_REDIRECT:/account/history');
    expect([...mocks.jar.keys()].some((name) => name.startsWith('sb-fixture-auth-token'))).toBe(true);
    expect(await getVerifiedAccount()).toMatchObject({ status: 'authenticated', user: { id: user.id } });
    expect(requests.filter((request) => request.url.pathname === '/auth/v1/user')).toHaveLength(2);

    await expect(signOutAction()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(mocks.jar.size).toBe(0);
    const count = requests.length;
    expect(await getVerifiedAccount()).toEqual({ status: 'unauthenticated' });
    expect(requests).toHaveLength(count);
  });

  it('keeps the PKCE verifier from signup and exchanges the email callback into a verified cookie session', async () => {
    expect(await signUpAction(AUTH_INITIAL_STATE, form())).toMatchObject({ error: null, message: expect.stringContaining('confirmation') });
    expect([...mocks.jar.keys()].some((name) => name.endsWith('-code-verifier'))).toBe(true);
    expect(signupChallenge).toBeTruthy();
    const signup = requests.find((request) => request.url.pathname === '/auth/v1/signup')!;
    expect(signup.url.searchParams.get('redirect_to')).toBe('https://lumora.example.test/auth/callback?next=%2Faccount%2Fhistory');
    expect(await getVerifiedAccount()).toEqual({ status: 'unauthenticated' });

    const callback = 'https://lumora.example.test/auth/callback?code=synthetic-one-use-code&next=%2Faccount%2Fhistory';
    const refresh = await middleware(new NextRequest(callback, { headers: {
      cookie: [...mocks.jar].map(([name, value]) => `${name}=${value}`).join('; '),
    } }));
    for (const cookie of refresh.cookies.getAll()) {
      if (cookie.maxAge === 0) mocks.jar.delete(cookie.name);
      else mocks.jar.set(cookie.name, cookie.value);
    }
    const result = await GET(new Request(callback));
    expect(result.headers.get('location')).toBe('https://lumora.example.test/account/history');
    const exchange = requests.find((request) => request.url.searchParams.get('grant_type') === 'pkce')!;
    expect(createHash('sha256').update(exchange.body.code_verifier!).digest('base64url')).toBe(signupChallenge);
    // The installed SDK also keeps indexed flow slots; this non-opt-in flow consumes the fixed key.
    expect(mocks.jar.has('sb-fixture-auth-token-code-verifier')).toBe(false);
    expect(await getVerifiedAccount()).toMatchObject({ status: 'authenticated', user: { id: user.id } });
    expect(mocks.welcome).not.toHaveBeenCalled();

    const count = requests.length;
    const replay = await GET(new Request('https://lumora.example.test/auth/callback?code=synthetic-one-use-code'));
    expect(new URL(replay.headers.get('location')!).searchParams.get('auth')).toBe('callback');
    expect(requests).toHaveLength(count);
    expect(await getVerifiedAccount()).toMatchObject({ status: 'authenticated', user: { id: user.id } });
  });
});
