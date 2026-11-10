import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: true },
  client: vi.fn(), createClient: vi.fn(), getUser: vi.fn(), getSession: vi.fn(), signOut: vi.fn(),
  from: vi.fn(), service: vi.fn(), redirect: vi.fn(), revalidate: vi.fn(), formAction: vi.fn(),
  formState: { error: null } as { error: string | null; message?: string },
  pending: false,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ features: mocks.features, publicEnv: {} }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.client }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.service }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useActionState: () => [mocks.formState, mocks.formAction, mocks.pending],
}));

import DevicesPage from '@/app/account/devices/page';
import { SessionControlsForm } from '@/features/auth/SessionControlsForm';
import { signOutSessionsAction } from '@/features/auth/session-actions';
import { AUTH_EMAIL_UNVERIFIED, AUTH_INITIAL_STATE, AUTH_SERVICE_UNAVAILABLE } from '@/features/auth/state';

const user = { id: 'viewer', email: 'viewer@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' };
const privateError = 'synthetic private provider response with credentials';

function form(scope = 'others', confirm = 'yes') {
  const data = new FormData();
  data.set('scope', scope);
  data.set('confirm', confirm);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.features.supabaseConfigured = true;
  mocks.formState = { error: null };
  mocks.pending = false;
  mocks.client.mockResolvedValue({
    auth: { getUser: mocks.getUser, getSession: mocks.getSession, signOut: mocks.signOut },
    from: mocks.from,
  });
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); });
});

describe('verified session scope actions', () => {
  it('keeps this session when others is selected, without inventing device data', async () => {
    const data = form();
    data.set('userId', 'another-viewer');
    data.set('deviceId', 'invented-device');
    const state = await signOutSessionsAction(AUTH_INITIAL_STATE, data);
    expect(state.error).toBeNull();
    expect(state.message).toContain('This browser stays signed in.');
    expect(state.message).toContain('access tokens remain valid until they expire');
    expect(mocks.client).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'others' });
    expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.signOut.mock.invocationCallOrder[0]!);
    for (const mock of [mocks.getSession, mocks.from, mocks.service, mocks.createClient, mocks.redirect, mocks.revalidate]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it('signs out globally only when explicitly selected and confirmed, then redirects outside the catch', async () => {
    await expect(signOutSessionsAction(AUTH_INITIAL_STATE, form('global'))).rejects.toThrow('NEXT_REDIRECT:/');
    expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'global' });
    expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith('/', 'layout');
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/');
  });

  it.each(['', 'local', 'GLOBAL', 'all', 'device', 'global\u0000'])('rejects invalid scope %j without authentication work', async (scope) => {
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, form(scope))).toEqual({ error: 'Choose other sessions or all sessions.' });
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(['missing', 'duplicate', 'file'])('rejects a %s scope rather than defaulting globally', async (kind) => {
    const data = form();
    if (kind === 'missing') data.delete('scope');
    if (kind === 'duplicate') data.append('scope', 'global');
    if (kind === 'file') data.set('scope', new Blob(['global']), 'scope.txt');
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, data)).toEqual({ error: 'Choose other sessions or all sessions.' });
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(['others', 'global'])('requires confirmation for %s even when native validation is bypassed', async (scope) => {
    const data = form(scope);
    data.delete('confirm');
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, data)).toEqual({ error: 'Confirm that you want to sign out the selected sessions.' });
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, form(scope, 'false'))).toEqual({ error: 'Confirm that you want to sign out the selected sessions.' });
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(['others', 'global'])('does no backend work for %s when configuration is absent', async (scope) => {
    mocks.features.supabaseConfigured = false;
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, form(scope))).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(['others', 'global'])('rejects signed-out and unconfirmed users before %s mutation', async (scope) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, form(scope))).toEqual({ error: 'Sign in to manage your sessions.' });
    mocks.getUser.mockResolvedValue({ data: { user: { ...user, email_confirmed_at: undefined,
      confirmed_at: user.email_confirmed_at, user_metadata: { email_verified: true } } }, error: null });
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, form(scope))).toEqual({ error: AUTH_EMAIL_UNVERIFIED });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each(['others', 'global'])('rechecks verification on every %s submission', async (scope) => {
    await DevicesPage();
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
    expect(await signOutSessionsAction(AUTH_INITIAL_STATE, form(scope))).toEqual({ error: 'Sign in to manage your sessions.' });
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(['others', 'global'])('sanitizes client, verification, and sign-out failures for %s', async (scope) => {
    for (const failure of ['client', 'verification', 'verification-response', 'sign-out', 'sign-out-response']) {
      mocks.signOut.mockClear();
      if (failure === 'client') mocks.client.mockRejectedValueOnce(new Error(privateError));
      if (failure === 'verification') mocks.getUser.mockRejectedValueOnce(new Error(privateError));
      if (failure === 'verification-response') mocks.getUser.mockResolvedValueOnce({ data: { user }, error: { status: 503, message: privateError } });
      if (failure === 'sign-out') mocks.signOut.mockRejectedValueOnce(new Error(privateError));
      if (failure === 'sign-out-response') mocks.signOut.mockResolvedValueOnce({ error: { status: 503, message: privateError } });
      const state = await signOutSessionsAction({ error: null, message: 'old success' }, form(scope));
      expect(state).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
      expect(JSON.stringify(state)).not.toContain(privateError);
      if (!failure.startsWith('sign-out')) expect(mocks.signOut).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    }
  });
});

describe('session control UI', () => {
  it('offers only explicit others/global controls and an unchecked confirmation after verification', async () => {
    const html = renderToStaticMarkup(await DevicesPage());
    expect(html).toContain('No device list to show');
    expect(html).toMatch(/<button\b(?=[^>]*name="scope")(?=[^>]*value="others")[^>]*>/);
    expect(html).toMatch(/<button\b(?=[^>]*name="scope")(?=[^>]*value="global")[^>]*>/);
    expect(html).toContain('Sign out other sessions');
    expect(html).toContain('Sign out everywhere');
    expect(html).toContain('name="confirm"');
    expect(html).toContain('required=""');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('access tokens remain valid until they expire');
    expect(html).toContain('cannot target an individual device');
    expect(html).not.toContain('controls yet');
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each(['unauthenticated', 'unverified', 'unavailable'])('does not render mutation controls for %s accounts', async (status) => {
    if (status === 'unavailable') mocks.features.supabaseConfigured = false;
    else mocks.getUser.mockResolvedValue({ data: { user: status === 'unauthenticated' ? null : { ...user, email_confirmed_at: undefined } }, error: null });
    const html = renderToStaticMarkup(await DevicesPage());
    expect(html).not.toContain('<form');
    expect(html).not.toContain('name="scope"');
    expect(html).toContain(status === 'unavailable' ? 'Accounts are unavailable' : status === 'unverified' ? 'Confirm your email' : 'Sign in to continue');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('disables all mutation inputs and announces pending status without stale success', () => {
    mocks.pending = true;
    mocks.formState = { error: null, message: 'old success' };
    const html = renderToStaticMarkup(createElement(SessionControlsForm));
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('role="status"');
    expect(html).toContain('Updating sessions...');
    expect(html).not.toContain('old success');
  });

  it('renders action errors as alerts and successful requests as status messages', async () => {
    mocks.formState = await signOutSessionsAction(AUTH_INITIAL_STATE, form());
    expect(renderToStaticMarkup(createElement(SessionControlsForm))).toContain('role="status"');
    mocks.formState = { error: AUTH_SERVICE_UNAVAILABLE };
    const html = renderToStaticMarkup(createElement(SessionControlsForm));
    expect(html).toContain('role="alert"');
    expect(html).toContain(AUTH_SERVICE_UNAVAILABLE);
    expect(html).not.toContain('role="status"');
  });
});
