'use server';

import { redirect } from 'next/navigation';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Auth server actions (Spec Section 8). These run on the server with the
 * SSR-aware Supabase client, so session cookies are written correctly during
 * the action (server actions CAN set cookies, unlike Server Components) and
 * refreshed by middleware on subsequent navigations.
 *
 * Validation is minimal by design for this slice: Supabase enforces the email
 * format and password strength server-side; we surface its errors verbatim
 * (they never contain secrets) through useActionState on the client.
 */

export interface AuthActionState {
  /** Human-readable error from Supabase (or a generic fallback). null = success. */
  error: string | null;
}

export const AUTH_INITIAL_STATE: AuthActionState = { error: null };

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

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message };
  }

  // Only allow internal redirect targets (never an arbitrary absolute URL).
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/account';
  redirect(safeNext);
}

/**
 * Sign up with email + password. Supabase sends a confirmation email when the
 * project requires it; when email confirmation is off, the session is
 * established immediately. Either way the account/profile rows are created by
 * the `handle_new_user()` trigger on first sign-in.
 */
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

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return { error: error.message };
  }

  // Email-confirmation flow: session absent until the user confirms.
  if (!data.session) {
    redirect(`/signin?confirmed=1&email=${encodeURIComponent(email)}`);
  }
  redirect('/account');
}

/** Sign out and return to home. Safe to call even without a session. */
export async function signOutAction(): Promise<void> {
  const supabase = await getSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/');
}
