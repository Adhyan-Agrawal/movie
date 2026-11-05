import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  configured: { supabaseConfigured: true },
  serverClient: vi.fn(),
  serviceClient: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  from: vi.fn(),
  welcome: vi.fn(),
  redirect: vi.fn(),
  formAction: vi.fn(),
  formState: { error: null } as { error: string | null; message?: string },
  searchParams: new URLSearchParams(),
}));

vi.mock('@/lib/env', () => ({ features: mocks.configured }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.serverClient }));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: mocks.serviceClient }));
vi.mock('@/features/email/send', () => ({ sendWelcomeEmail: mocks.welcome }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useSearchParams: () => mocks.searchParams }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useActionState: () => [mocks.formState, mocks.formAction, false],
}));

import { signInAction, signOutAction, signUpAction } from '@/features/auth/actions';
import { AUTH_INITIAL_STATE, AUTH_SERVICE_UNAVAILABLE } from '@/features/auth/state';
import { SignInForm } from '@/features/auth/SignInForm';
import { SignUpForm } from '@/features/auth/SignUpForm';

const upstreamDetails = 'private upstream body: service_key=synthetic-secret https://private.example.test';
const user = { id: 'synthetic-viewer' };
const session = { user };

function form(values: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    email: 'viewer@example.test',
    password: 'synthetic-passphrase',
    confirm: 'synthetic-passphrase',
    ...values,
  })) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured.supabaseConfigured = true;
  mocks.formState = { error: null };
  mocks.searchParams = new URLSearchParams();
  mocks.serverClient.mockResolvedValue({
    auth: { signInWithPassword: mocks.signIn, signUp: mocks.signUp, signOut: mocks.signOut },
    from: mocks.from,
  });
  mocks.serviceClient.mockImplementation(() => { throw new Error(upstreamDetails); });
  mocks.signIn.mockResolvedValue({ data: { user, session }, error: null });
  mocks.signUp.mockResolvedValue({ data: { user, session: null }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.welcome.mockResolvedValue(undefined);
  mocks.redirect.mockImplementation((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); });
});

describe('unavailable web authentication', () => {
  it('does no client, database, authentication, or email work when configuration is absent', async () => {
    mocks.configured.supabaseConfigured = false;
    await expect(signInAction(AUTH_INITIAL_STATE, form())).resolves.toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    await expect(signUpAction(AUTH_INITIAL_STATE, form())).resolves.toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    await expect(signOutAction()).rejects.toThrow('NEXT_REDIRECT:/signin?auth=unavailable');

    for (const mock of [mocks.serverClient, mocks.serviceClient, mocks.from, mocks.signIn, mocks.signUp, mocks.signOut, mocks.welcome]) {
      expect(mock).not.toHaveBeenCalled();
    }
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/signin?auth=unavailable');
  });

  it.each([signInAction, signUpAction])('sanitizes a client construction failure', async (action) => {
    mocks.serverClient.mockRejectedValue(new Error(upstreamDetails));
    const result = await action(AUTH_INITIAL_STATE, form());
    expect(result).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    expect(JSON.stringify(result)).not.toContain(upstreamDetails);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it.each([
    ['sign-in', signInAction, mocks.signIn],
    ['sign-up', signUpAction, mocks.signUp],
  ] as const)('sanitizes a rejected %s network request', async (_name, action, request) => {
    request.mockRejectedValue(new Error(upstreamDetails));
    expect(await action(AUTH_INITIAL_STATE, form())).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.welcome).not.toHaveBeenCalled();
  });

  it.each([
    { status: 503, name: 'AuthApiError' },
    { status: 0, name: 'AuthRetryableFetchError' },
    { status: undefined, name: 'AuthUnknownError' },
  ])('handles returned service failures without exposing their body: $name/$status', async (error) => {
    const response = { data: { user: null, session: null }, error: { ...error, message: upstreamDetails } };
    mocks.signIn.mockResolvedValue(response);
    mocks.signUp.mockResolvedValue(response);
    expect(await signInAction(AUTH_INITIAL_STATE, form())).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    expect(await signUpAction(AUTH_INITIAL_STATE, form())).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each(['client', 'request', 'response'])('does not imply successful logout on a %s failure', async (failure) => {
    if (failure === 'client') mocks.serverClient.mockRejectedValue(new Error(upstreamDetails));
    if (failure === 'request') mocks.signOut.mockRejectedValue(new Error(upstreamDetails));
    if (failure === 'response') mocks.signOut.mockResolvedValue({ error: { status: 503, message: upstreamDetails } });
    await expect(signOutAction()).rejects.toThrow('NEXT_REDIRECT:/signin?auth=unavailable');
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/signin?auth=unavailable');
  });

  it('renders an application-owned logout failure message, never arbitrary query text', () => {
    mocks.searchParams = new URLSearchParams({ auth: 'unavailable', error: upstreamDetails });
    const html = renderToStaticMarkup(createElement(SignInForm));
    expect(html).toContain('role="alert"');
    expect(html).toContain(AUTH_SERVICE_UNAVAILABLE);
    expect(html).not.toContain(upstreamDetails);

    mocks.searchParams = new URLSearchParams({ auth: upstreamDetails });
    expect(renderToStaticMarkup(createElement(SignInForm))).not.toContain('role="alert"');
  });
});

describe('configured web authentication', () => {
  it.each(['/account', '/admin?tab=users', 'https://external.example.test'])('keeps the successful sign-in redirect outside the catch: %s', async (next) => {
    const destination = next.startsWith('/') ? next : '/account';
    await expect(signInAction(AUTH_INITIAL_STATE, form({ email: ' viewer@example.test ', next })))
      .rejects.toThrow(`NEXT_REDIRECT:${destination}`);
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith({ email: 'viewer@example.test', password: 'synthetic-passphrase' });
  });

  it('requires an actual session before redirecting after sign-in', async () => {
    mocks.signIn.mockResolvedValue({ data: { user, session: null }, error: null });
    expect(await signInAction(AUTH_INITIAL_STATE, form())).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('does not administratively confirm an unverified address or retry sign-in', async () => {
    mocks.signIn.mockResolvedValue({ error: { status: 400, code: 'email_not_confirmed', message: upstreamDetails } });
    expect(await signInAction(AUTH_INITIAL_STATE, form())).toEqual({ error: 'Confirm your email before signing in.' });
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('keeps incorrect credentials and rate limits sanitized', async () => {
    mocks.signIn.mockResolvedValue({ error: { status: 400, code: 'invalid_credentials', message: upstreamDetails } });
    expect(await signInAction(AUTH_INITIAL_STATE, form())).toEqual({ error: 'The email or password is incorrect.' });
    mocks.signIn.mockResolvedValue({ error: { status: 429, message: upstreamDetails } });
    expect(await signInAction(AUTH_INITIAL_STATE, form())).toEqual({ error: 'Too many sign-in attempts. Please wait and try again.' });
  });

  it('uses normal signup without service-role auto-confirm or a fabricated session', async () => {
    const result = await signUpAction(AUTH_INITIAL_STATE, form());
    expect(result).toEqual({
      error: null,
      message: 'Follow the email confirmation instructions before signing in. Account access is not active yet.',
    });
    expect(mocks.signUp).toHaveBeenCalledExactlyOnceWith({ email: 'viewer@example.test', password: 'synthetic-passphrase' });
    expect(mocks.serviceClient).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.welcome).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();

    mocks.formState = result;
    const html = renderToStaticMarkup(createElement(SignUpForm));
    expect(html).toContain('role="status"');
    expect(html).toContain('Account access is not active yet.');
  });

  it('sanitizes signup rejection and rate limits', async () => {
    mocks.signUp.mockResolvedValue({ error: { status: 400, message: upstreamDetails } });
    expect(await signUpAction(AUTH_INITIAL_STATE, form())).toEqual({ error: 'We could not create your account. Check your details and try again.' });
    mocks.signUp.mockResolvedValue({ error: { status: 429, message: upstreamDetails } });
    expect(await signUpAction(AUTH_INITIAL_STATE, form())).toEqual({ error: 'Too many account creation attempts. Please wait and try again.' });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('does not claim signup success when the provider returned no user', async () => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: null });
    expect(await signUpAction(AUTH_INITIAL_STATE, form())).toEqual({ error: AUTH_SERVICE_UNAVAILABLE });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('preserves an established signup session and redirect when welcome email fails', async () => {
    mocks.signUp.mockResolvedValue({ data: { user, session }, error: null });
    mocks.welcome.mockRejectedValue(new Error(upstreamDetails));
    await expect(signUpAction(AUTH_INITIAL_STATE, form())).rejects.toThrow('NEXT_REDIRECT:/account');
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/account');
    expect(mocks.welcome).toHaveBeenCalledExactlyOnceWith({ email: 'viewer@example.test' });
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });

  it('preserves the successful logout redirect without swallowing it', async () => {
    await expect(signOutAction()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('validates inputs without backend work', async () => {
    expect(await signInAction(AUTH_INITIAL_STATE, form({ email: '' }))).toEqual({ error: 'Enter your email and password.' });
    expect(await signUpAction(AUTH_INITIAL_STATE, form({ confirm: 'different' }))).toEqual({ error: 'Passwords do not match.' });
    expect(await signUpAction(AUTH_INITIAL_STATE, form({ password: 'short', confirm: 'short' }))).toEqual({ error: 'Password must be at least 6 characters.' });
    expect(mocks.serverClient).not.toHaveBeenCalled();
    expect(mocks.serviceClient).not.toHaveBeenCalled();
  });
});
