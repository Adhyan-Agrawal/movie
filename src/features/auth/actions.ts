'use server';

import { redirect } from 'next/navigation';
import { features } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { sendWelcomeEmail } from '@/features/email/send';
import { AUTH_SERVICE_UNAVAILABLE, type AuthActionState } from './state';
import { safeAuthReturnPath } from './return-path';

/**
 * The configured web backend is still Supabase. Never substitute a local D1
 * worker or administratively confirm email addresses when it is unavailable.
 * Only return application-owned messages, not upstream errors or credentials.
 */

function isServiceFailure(error: { status?: number; name?: string }): boolean {
  return error.status === undefined || error.status === 0 || error.status >= 500
    || error.name === 'AuthRetryableFetchError';
}

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
    if (!features.supabaseConfigured) return { error: AUTH_SERVICE_UNAVAILABLE };
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (isServiceFailure(error)) return { error: AUTH_SERVICE_UNAVAILABLE };
      if (error.code === 'email_not_confirmed') return { error: 'Confirm your email before signing in.' };
      return {
        error: error.status === 429
          ? 'Too many sign-in attempts. Please wait and try again.'
          : 'The email or password is incorrect.',
      };
    }
    if (!data.user || !data.session) return { error: AUTH_SERVICE_UNAVAILABLE };
  } catch {
    return { error: AUTH_SERVICE_UNAVAILABLE };
  }

  // Only allow internal redirect targets (never an arbitrary absolute URL).
  const safeNext = safeAuthReturnPath(next);
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
    if (!features.supabaseConfigured) return { error: AUTH_SERVICE_UNAVAILABLE };
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      if (isServiceFailure(error)) return { error: AUTH_SERVICE_UNAVAILABLE };
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

    // A welcome email is not verification and must not delay an established session.
    void sendWelcomeEmail({ email }).catch(() => {});
  } catch {
    return { error: AUTH_SERVICE_UNAVAILABLE };
  }

  redirect('/account');
}

/** Sign out and return to home. Safe to call even without a session. */
export async function signOutAction(): Promise<void> {
  let destination = '/';
  try {
    if (!features.supabaseConfigured) {
      destination = '/signin?auth=unavailable';
    } else {
      const supabase = await getSupabaseServerClient();
      const { error } = await supabase.auth.signOut();
      if (error) destination = '/signin?auth=unavailable';
    }
  } catch {
    destination = '/signin?auth=unavailable';
  }
  // Keep the existing form action's void contract without implying a failed logout succeeded.
  redirect(destination);
}
