import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getUser: vi.fn(), from: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createClient }));
import { middleware } from '@/middleware';

const user = { id: 'viewer', email: 'viewer@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' };
function request(path: string, method = 'GET') {
  return new NextRequest(`https://lumora.example.test${path}`, {
    method, headers: { cookie: 'sb-fixture-auth-token=synthetic-old-session', authorization: 'Bearer synthetic-viewer-token' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon-key');
  mocks.createClient.mockReturnValue({ auth: { getUser: mocks.getUser }, from: mocks.from });
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('session middleware boundaries', () => {
  it.each(['/api/catalog?limit=10', '/api/trailer?tmdbId=27205', '/api/subtitles?format=vtt', '/api/episode-navigation?season=1', '/api/watch-party'])(
    'never refreshes or attaches session cookies to the session-independent metadata/capability endpoint %s', async (path) => {
    const response = await middleware(request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.cookies.getAll()).toEqual([]);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it.each(['/api/catalog', '/api/trailer', '/api/subtitles', '/api/episode-navigation', '/api/watch-party'])(
    'keeps HEAD metadata reads free of Supabase traffic for %s', async (path) => {
    await middleware(request(path, 'HEAD'));
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('leaves guest room POST authentication to its own signed-ticket and exact-origin handler', async () => {
    const response = await middleware(request('/api/watch-party', 'POST'));
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each(['/logo.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'])(
    'does not create Supabase sessions for the known public static asset %s', async (path) => {
    await middleware(request(path));
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each(['/account/avatar.png', '/admin/logo.png', '/icons/private.png'])(
    'keeps unlisted or account-specific image paths inside their session boundary %s', async (path) => {
    await middleware(request(path));
    expect(mocks.createClient).toHaveBeenCalledOnce();
  });

  it.each(['/api/catalog/private', '/api/trailer/private', '/api/subtitles/private', '/api/watch-party/admin', '/account', '/admin'])('does not widen the refresh bypass to %s', async (path) => {
    await middleware(request(path));
    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.getUser).toHaveBeenCalledOnce();
  });

  it.each(['/api/catalog', '/api/trailer', '/api/subtitles', '/api/episode-navigation'])(
    'does not exempt unsupported metadata POST requests from session refresh at %s', async (path) => {
    await middleware(request(path, 'POST'));
    expect(mocks.createClient).toHaveBeenCalledOnce();
  });

  it('keeps all rotated cookies on both the request and response, including multiple SDK writes', async () => {
    mocks.getUser.mockImplementation(async () => {
      const cookies = mocks.createClient.mock.calls[0]![2].cookies;
      cookies.setAll([{ name: 'sb-fixture-auth-token', value: 'new-session', options: { path: '/', sameSite: 'lax', secure: true } }]);
      cookies.setAll([{ name: 'sb-fixture-auth-token.1', value: '', options: { path: '/', maxAge: 0 } }]);
      return { data: { user: null }, error: null };
    });
    const req = request('/account');
    const response = await middleware(req);
    expect(req.cookies.get('sb-fixture-auth-token')?.value).toBe('new-session');
    expect(response.cookies.get('sb-fixture-auth-token')).toMatchObject({ value: 'new-session', secure: true, sameSite: 'lax' });
    expect(response.cookies.get('sb-fixture-auth-token.1')).toMatchObject({ value: '', maxAge: 0 });
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
  });

  it.each(['construction', 'request'])('does not crash public pages on %s failure but still denies admin entry', async (stage) => {
    const failure = new Error('private provider details');
    if (stage === 'construction') mocks.createClient.mockImplementation(() => { throw failure; });
    else mocks.getUser.mockRejectedValue(failure);
    const publicResponse = await middleware(request('/browse'));
    expect(publicResponse.headers.get('x-middleware-next')).toBe('1');
    const adminResponse = await middleware(request('/admin/users'));
    expect(new URL(adminResponse.headers.get('location')!).pathname).toBe('/signin');
    expect(adminResponse.headers.get('location')).not.toContain(failure.message);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    { data: { user: { ...user, email_confirmed_at: undefined, confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { email_verified: true } } }, error: null },
    { data: { user }, error: { status: 503 } },
  ])('does not grant admin entry from unconfirmed or error-bearing identity results', async (result) => {
    mocks.getUser.mockResolvedValue(result);
    const response = await middleware(request('/admin'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/signin');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('still permits a verified user with real account and permission query results', async () => {
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockImplementation((table: string) => ({ select: () => {
      if (table === 'accounts') return { eq: () => ({ maybeSingle: async () => ({ data: { is_suspended: false }, error: null }) }) };
      if (table === 'account_members') return { eq: async () => ({ data: [{ role_id: 'editor' }] }) };
      if (table === 'role_permissions') return { in: async () => ({ data: [{ permission_id: 'read' }] }) };
      return { in: async () => ({ data: [{ key: 'catalog.read' }] }) };
    } }));
    const response = await middleware(request('/admin'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.from).toHaveBeenCalledWith('accounts');
    expect(mocks.from).toHaveBeenCalledWith('permissions');
  });

  it('carries session-cookie deletion into an admin POST sign-in redirect', async () => {
    mocks.getUser.mockImplementation(async () => {
      mocks.createClient.mock.calls[0]![2].cookies.setAll([
        { name: 'sb-fixture-auth-token', value: '', options: { path: '/', maxAge: 0 } },
      ]);
      return { data: { user: null }, error: null };
    });
    const response = await middleware(request('/admin/users', 'POST'));
    expect(response.status).toBe(303);
    expect(response.cookies.get('sb-fixture-auth-token')).toMatchObject({ value: '', maxAge: 0 });
    expect(new URL(response.headers.get('location')!).searchParams.get('next')).toBe('/admin/users');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });
});
