'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { features, publicEnv } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { sendWelcomeEmail } from '@/features/email/send';
import { AUTH_CONFIGURATION_UNAVAILABLE, AUTH_EMAIL_UNVERIFIED, AUTH_SERVICE_UNAVAILABLE, type AuthActionState } from './state';
import { authCallbackUrl, safeAuthReturnPath } from './return-path';
import { isAuthServiceFailure, verifyAccount } from './verified-account';

/**
 * The configured web backend is still Supabase. Never substitute a local D1
 * worker or administratively confirm email addresses when it is unavailable.
 * Only return application-owned messages, not upstream errors or credentials.
 */

/** Sign in with email + password. Redirects to `next` (or /account) on success. */
export async function signInAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '') || '/account';

  if (!email || !password) {
    return { error: 'Enter your email and password.' };
  }

  try {
    if (!features.supabaseConfigured) return { error: AUTH_CONFIGURATION_UNAVAILABLE };
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (isAuthServiceFailure(error)) return { error: AUTH_SERVICE_UNAVAILABLE };
      if (error.code === 'email_not_confirmed') return { error: AUTH_EMAIL_UNVERIFIED };
      if (error.status === 429) return { error: 'Too many sign-in attempts. Please wait and try again.' };
      if (error.code === 'email_provider_disabled') return { error: 'Email sign-in is disabled by the account provider.' };
      return { error: error.code === 'invalid_credentials' ? 'The email or password is incorrect.' : AUTH_SERVICE_UNAVAILABLE };
    }
    if (!data.user || !data.session) return { error: AUTH_SERVICE_UNAVAILABLE };
    const account = await verifyAccount(supabase);
    if (account.status === 'unverified') {
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      return { error: signOutError ? AUTH_SERVICE_UNAVAILABLE : AUTH_EMAIL_UNVERIFIED };
    }
    if (account.status !== 'authenticated' || account.user.id !== data.user.id) return { error: AUTH_SERVICE_UNAVAILABLE };
  } catch {
    return { error: AUTH_SERVICE_UNAVAILABLE };
  }

  // Only allow internal redirect targets (never an arbitrary absolute URL).
  const safeNext = safeAuthReturnPath(next);
  revalidatePath('/', 'layout');
  redirect(safeNext);
}

/** Sign up without overriding the configured provider's verification policy. */
export async function signUpAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const next = safeAuthReturnPath(String(formData.get('next') ?? ''));

  if (!email || !password) {
    return { error: 'Enter your email and a password.' };
  }
  if (password !== confirm) {
    return { error: 'Passwords do not match.' };
  }
  if (password.length < 6) {
    return { error: 'Password must be at least 6 characters.' };
  }

  try {
    if (!features.supabaseConfigured) return { error: AUTH_CONFIGURATION_UNAVAILABLE };
    const callback = authCallbackUrl(publicEnv.NEXT_PUBLIC_APP_URL, next);
    if (!callback) return { error: AUTH_CONFIGURATION_UNAVAILABLE };
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callback.href } });
    if (error) {
      if (isAuthServiceFailure(error) || error.status === 401) return { error: AUTH_SERVICE_UNAVAILABLE };
      if (error.code === 'signup_disabled' || error.code === 'email_provider_disabled') return { error: 'Account creation is disabled by the account provider.' };
      return {
        error: error.status === 429
          ? 'Too many account creation attempts. Please wait and try again.'
          : 'We could not create your account. Check your details and try again.',
      };
    }
    if (!data.user) return { error: AUTH_SERVICE_UNAVAILABLE };
    if (!data.session) {
      return {
        error: null,
        message: 'Follow the email confirmation instructions before signing in. Account access is not active yet.',
      };
    }

    const account = await verifyAccount(supabase);
    if (account.status === 'unverified') {
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      return { error: signOutError ? AUTH_SERVICE_UNAVAILABLE : AUTH_EMAIL_UNVERIFIED };
    }
    if (account.status !== 'authenticated' || account.user.id !== data.user.id) return { error: AUTH_SERVICE_UNAVAILABLE };

    // A welcome email is not verification and must not delay an established session.
    void sendWelcomeEmail({ email: account.user.email! }).catch(() => {});
  } catch {
    return { error: AUTH_SERVICE_UNAVAILABLE };
  }

  revalidatePath('/', 'layout');
  redirect(next);
}

/** Sign out only this session and return home. Safe even without a session. */
export async function signOutAction(): Promise<void> {
  let destination = '/';
  try {
    if (!features.supabaseConfigured) {
      destination = '/signin?auth=unavailable';
    } else {
      const supabase = await getSupabaseServerClient();
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) destination = '/signin?auth=unavailable';
    }
  } catch {
    destination = '/signin?auth=unavailable';
  }
  // Keep the existing form action's void contract without implying a failed logout succeeded.
  if (destination === '/') revalidatePath('/', 'layout');
  redirect(destination);
}
