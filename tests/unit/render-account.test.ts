import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const require = createRequire(import.meta.url);
  const react = require(join(dirname(require.resolve('react/package.json')), 'react.react-server.js')) as {
    cache: typeof import('react').cache;
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      A: { getCacheForType: (factory: () => unknown) => unknown } | null;
    };
  };
  return {
    react,
    scopes: new AsyncLocalStorage<{ client: unknown; roots: Map<() => unknown, unknown> }>(),
    features: { supabaseConfigured: true },
    cookies: vi.fn(), serverClient: vi.fn(), bearerClient: vi.fn(),
    redirect: vi.fn(), revalidate: vi.fn(), welcome: vi.fn(),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), cache: mocks.react.cache }));
vi.mock('@/lib/env', () => ({
  features: mocks.features,
  publicEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://lumora.example.test',
  },
}));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.serverClient }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.bearerClient }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/features/email/send', () => ({ sendWelcomeEmail: mocks.welcome }));
vi.mock('@/components/shell/MobileNav', () => ({ MobileNav: () => null }));
vi.mock('@/components/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/shell/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/pwa/InstallPrompt', () => ({ InstallPrompt: () => null }));
vi.mock('@/features/ads/AdSlot', () => ({ AdSlot: () => null }));
vi.mock('@/features/ads/ConsentGate', () => ({ ConsentGate: () => null }));
vi.mock('@/features/account/ViewingPreferencesProvider', () => ({ ViewingPreferencesProvider: () => null }));
vi.mock('@/features/account/AccountNav', () => ({ AccountNav: () => null }));
vi.mock('@/features/account/UnauthorizedState', () => ({ UnauthorizedState: () => null }));
vi.mock('@/features/auth/SignOutButton', () => ({ SignOutButton: () => null }));
vi.mock('@/features/auth/SessionControlsForm', () => ({ SessionControlsForm: () => null }));

import { getRenderAccount } from '@/features/auth/render-account';
import { getVerifiedAccount, verifyAccount } from '@/features/auth/verified-account';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/shell/AppShell';
import AccountLayout from '@/app/account/layout';
import DevicesPage from '@/app/account/devices/page';
import { ViewingPreferencesProvider } from '@/features/account/ViewingPreferencesProvider';
import { UnauthorizedState } from '@/features/account/UnauthorizedState';
import { accountPreferencesSnapshot } from '@/features/account/preference-types';
import { signInAction, signUpAction } from '@/features/auth/actions';
import { AUTH_EMAIL_UNVERIFIED, AUTH_INITIAL_STATE } from '@/features/auth/state';

const viewer = {
  id: '123e4567-e89b-42d3-a456-426614174000', email: 'a@example.test',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  user_metadata: { lumora_preferences_v1_autoplay_previews: false },
};
const other = { ...viewer, id: '123e4567-e89b-42d3-a456-426614174001', email: 'b@example.test' };

function client(user: object | null = viewer, error: object | null = null) {
  return { auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user }, error }),
    getSession: vi.fn(() => { throw new Error('Session claims are not verified identity.'); }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: { user, session: { user } }, error: null }),
    signUp: vi.fn().mockResolvedValue({ data: { user, session: { user } }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  } };
}

function renderRequest<T>(db: ReturnType<typeof client>, read: () => T): T {
  return mocks.scopes.run({ client: db, roots: new Map() }, read);
}

function form() {
  const data = new FormData();
  data.set('email', other.email);
  data.set('password', 'synthetic-passphrase');
  data.set('confirm', 'synthetic-passphrase');
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.features.supabaseConfigured = true;
  // Explicit server-cache dispatcher contract, not a Next request integration or
  // a mock memoizer: real React.cache looks up roots in the current async scope.
  mocks.react.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = {
    getCacheForType(factory) {
      const scope = mocks.scopes.getStore();
      if (!scope) throw new Error('Expected an explicit render request scope.');
      if (!scope.roots.has(factory)) scope.roots.set(factory, factory());
      return scope.roots.get(factory);
    },
  };
  mocks.cookies.mockResolvedValue({ getAll: () => [], set: vi.fn() });
  mocks.serverClient.mockImplementation(() => {
    const scope = mocks.scopes.getStore();
    if (!scope) throw new Error('Expected request-owned client fixture.');
    return scope.client;
  });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); });
  mocks.welcome.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this suite.'); }));
});

afterEach(() => {
  mocks.react.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = null;
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('render-only auth under the React server-cache request contract', () => {
  it('deduplicates concurrent AppShell, account layout, and devices readers while preserving preferences', async () => {
    const db = client();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    db.auth.getUser.mockImplementationOnce(async () => {
      await gate;
      return { data: { user: viewer }, error: null };
    });
    await renderRequest(db, async () => {
      const readers = Promise.all([
        AppShell({ children: 'PUBLIC_CHILD' }),
        AccountLayout({ children: 'PRIVATE_CHILD' }),
        DevicesPage(),
      ]);
      const first = getRenderAccount();
      expect(getRenderAccount()).toBe(first);
      expectTypeOf(getRenderAccount).parameters.toEqualTypeOf<[]>();
      await vi.waitFor(() => expect(db.auth.getUser).toHaveBeenCalledExactlyOnceWith());
      finish();
      const [shell, layout, devices] = await readers;
      expect(shell.type).toBe(ViewingPreferencesProvider);
      expect(shell.props).toMatchObject({
        mode: 'account', initialPreferences: accountPreferencesSnapshot(viewer.id, viewer.user_metadata),
      });
      expect(layout.props.children[0].props.description).toBe(`Signed in as ${viewer.email}`);
      expect(devices.type).toBe('section');
      await expect(first).resolves.toEqual({ status: 'authenticated', user: viewer, client: db });
      expect(mocks.cookies).toHaveBeenCalledTimes(1);
      expect(mocks.serverClient).toHaveBeenCalledTimes(1);
      expect(mocks.serverClient.mock.calls[0]?.slice(0, 2)).toEqual([
        'https://project.example.test', 'synthetic-public-anon-key',
      ]);
      expect(db.auth.getSession).not.toHaveBeenCalled();
    });
  });

  it('isolates overlapping requests with different verified users and RLS clients', async () => {
    const a = client(); const b = client(other);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    a.auth.getUser.mockImplementationOnce(async () => {
      await gate;
      return { data: { user: viewer }, error: null };
    });
    const pendingA = renderRequest(a, () => getRenderAccount());
    const [firstB, secondB] = await renderRequest(b, () => Promise.all([getRenderAccount(), getRenderAccount()]));
    expect(firstB).toEqual({ status: 'authenticated', user: other, client: b });
    expect(secondB).toBe(firstB);
    finish();
    await expect(pendingA).resolves.toEqual({ status: 'authenticated', user: viewer, client: a });
    expect(a.auth.getUser).toHaveBeenCalledExactlyOnceWith();
    expect(b.auth.getUser).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.serverClient).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 'unauthenticated', user: null, error: null },
    { status: 'unverified', user: { ...viewer, email_confirmed_at: undefined, confirmed_at: viewer.email_confirmed_at,
      user_metadata: { email_verified: true } }, error: null },
    { status: 'unavailable', user: viewer, error: { status: 503 } },
  ])('keeps $status fail-closed within a render but verifies anew on the next request', async ({ status, user, error }) => {
    const denied = client(user, error);
    await renderRequest(denied, async () => {
      const [shell, layout, devices] = await Promise.all([
        AppShell({ children: 'PUBLIC_CHILD' }), AccountLayout({ children: 'PRIVATE_CHILD' }), DevicesPage(),
      ]);
      expect(await getRenderAccount()).toEqual({ status });
      expect(shell.props.mode).toBe(status === 'unauthenticated' ? 'guest' : 'unavailable');
      expect(shell.props.initialPreferences).toBeNull();
      expect(layout.props.children[1].props.children.type).toBe(UnauthorizedState);
      expect(devices.type).toBe(UnauthorizedState);
      expect(denied.auth.getUser).toHaveBeenCalledExactlyOnceWith();
    });
    const fresh = client(other);
    await expect(renderRequest(fresh, () => getRenderAccount()))
      .resolves.toEqual({ status: 'authenticated', user: other, client: fresh });
    expect(mocks.serverClient).toHaveBeenCalledTimes(2);
  });

  it('does not memoize outside a React server-cache dispatcher', async () => {
    mocks.react.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = null;
    const db = client();
    await renderRequest(db, async () => {
      const first = getRenderAccount(); const second = getRenderAccount();
      expect(first).not.toBe(second);
      await Promise.all([first, second]);
    });
    expect(db.auth.getUser).toHaveBeenCalledTimes(2);
    expect(mocks.serverClient).toHaveBeenCalledTimes(2);
  });

  it('leaves the general cookie client factory and direct verification uncached even inside a render scope', async () => {
    const db = client();
    await renderRequest(db, async () => {
      const rendered = await getRenderAccount();
      await Promise.all([getSupabaseServerClient(), getSupabaseServerClient()]);
      const fresh = client(other);
      mocks.scopes.getStore()!.client = fresh;
      const direct = await getVerifiedAccount();
      expect(direct).toEqual({ status: 'authenticated', user: other, client: fresh });
      await verifyAccount(fresh as unknown as Parameters<typeof verifyAccount>[0]);
      await verifyAccount(fresh as unknown as Parameters<typeof verifyAccount>[0]);
      expect(fresh.auth.getUser).toHaveBeenCalledTimes(3);
      expect(mocks.serverClient).toHaveBeenCalledTimes(4);
      expect(mocks.cookies).toHaveBeenCalledTimes(4);
      await expect(getRenderAccount()).resolves.toBe(rendered);
    });
  });

  it('never lets a primed cookie render cache override Bearer precedence or cache Request verification', async () => {
    const cookie = client(); const bearer = client(other);
    mocks.bearerClient.mockReturnValue(bearer);
    await renderRequest(cookie, async () => {
      const rendered = await getRenderAccount();
      const request = new Request('https://lumora.example.test/api/account', { headers: { authorization: 'Bearer fixture-b' } });
      for (const result of await Promise.all([getVerifiedAccount(request), getVerifiedAccount(request)])) {
        expect(result).toEqual({ status: 'authenticated', user: other, client: bearer });
      }
      expect(bearer.auth.getUser).toHaveBeenCalledTimes(2);
      expect(bearer.auth.getUser).toHaveBeenLastCalledWith('fixture-b');
      expect(mocks.bearerClient.mock.calls[0]?.[2]).toMatchObject({
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: 'Bearer fixture-b' } },
      });
      const malformed = new Request(request.url, { headers: { authorization: 'Bearer token extra' } });
      await expect(getVerifiedAccount(malformed)).resolves.toEqual({ status: 'unauthenticated' });
      expect(mocks.bearerClient).toHaveBeenCalledTimes(2);
      mocks.bearerClient.mockReturnValue(client(null, { status: 403, code: 'bad_jwt' }));
      await expect(getVerifiedAccount(request)).resolves.toEqual({ status: 'unauthenticated' });
      expect(cookie.auth.getUser).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.cookies).toHaveBeenCalledTimes(1);
      await expect(getRenderAccount()).resolves.toBe(rendered);
    });
  });

  it.each([signInAction, signUpAction])('verifies a fresh action identity after a primed render without reusing that render client: %s', async (action) => {
    const before = client(); const after = client(other);
    await renderRequest(before, async () => {
      const rendered = await getRenderAccount();
      mocks.scopes.getStore()!.client = after;
      await expect(action(AUTH_INITIAL_STATE, form())).rejects.toThrow('NEXT_REDIRECT:/account');
      expect(after.auth.getUser).toHaveBeenCalledExactlyOnceWith();
      expect(before.auth.getUser).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.serverClient).toHaveBeenCalledTimes(2);
      await expect(getRenderAccount()).resolves.toBe(rendered);
    });
    await expect(renderRequest(after, () => getRenderAccount()))
      .resolves.toEqual({ status: 'authenticated', user: other, client: after });
    expect(after.auth.getUser).toHaveBeenCalledTimes(2);
  });

  it.each([signInAction, signUpAction])('rejects an unconfirmed action identity despite a confirmed cached render: %s', async (action) => {
    const before = client();
    const after = client({ ...other, email_confirmed_at: undefined, confirmed_at: other.email_confirmed_at,
      user_metadata: { email_verified: true } });
    await renderRequest(before, async () => {
      await getRenderAccount();
      mocks.scopes.getStore()!.client = after;
      await expect(action(AUTH_INITIAL_STATE, form())).resolves.toEqual({ error: AUTH_EMAIL_UNVERIFIED });
      expect(after.auth.getUser).toHaveBeenCalledExactlyOnceWith();
      expect(after.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
      expect(before.auth.signOut).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.welcome).not.toHaveBeenCalled();
    });
  });
});
