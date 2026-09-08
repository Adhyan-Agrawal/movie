'use server';

import { redirect } from 'next/navigation';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { sendWelcomeEmail } from '@/features/email/send';
import type { AuthActionState } from './state';

/**
 * Auth server actions (Spec Section 8). These run on the server with the
 * SSR-aware Supabase client, so session cookies are written correctly during
 * the action (server actions CAN set cookies, unlike Server Components) and
 * refreshed by middleware on subsequent navigations.
 *
 * EMAIL / SMTP-FREE MODE: this project has no SMTP configured. Supabase's
 * normal email-confirmation flow is therefore unusable twice over — the
 * confirmation email never arrives, AND the free-tier auth-email quota
 * (~2/hour) rate-limits `auth.signUp` after a couple of attempts. So sign-ups
 * are created through the service-role admin API with `email_confirm: true`,
 * which sends NO email at all, followed by a direct sign-in. The service key
 * never leaves the server. When SMTP is configured later, switch back to
 * `supabase.auth.signUp` + the confirmation redirect flow.
 *
 * Validation is minimal by design for this slice: Supabase enforces the email
 * format and password strength server-side; we surface its errors verbatim
 * (they never contain secrets) through useActionState on the client.
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

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // SMTP-free mode: accounts created before this flow may be unconfirmed.
    // Confirm server-side via the service role and retry once (no email sent).
    if (error.message.toLowerCase().includes('email not confirmed')) {
      const admin = getSupabaseServiceClient();
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const user = (list?.users ?? []).find((u) => u.email === email);
      if (!user) return { error: 'Invalid login credentials.' };
      const { error: confirmErr } = await admin.auth.admin.updateUserById(user.id, {
        email_confirm: true,
      });
      if (confirmErr) return { error: confirmErr.message };
      const { error: retryErr } = await supabase.auth.signInWithPassword({ email, password });
      if (retryErr) return { error: retryErr.message };
    } else {
      return { error: error.message };
    }
  }

  // Only allow internal redirect targets (never an arbitrary absolute URL).
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/account';
  redirect(safeNext);
}

/**
 * Sign up with email + password (SMTP-free: the account is created + confirmed
 * via the service role — no email is sent — and the session established
 * immediately). The `handle_new_user()` trigger creates the accounts/profiles
 * rows.
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

  // Service-role creation with email_confirm — sends no confirmation email
  // (unlike anon signUp, which is rate-limited by the email quota).
  const admin = getSupabaseServiceClient();
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) {
    // Surface the admin API's message ("A user with this email address has
    // already been registered", etc.) — it contains no secrets.
    return { error: createErr.message };
  }

  // Sign the new user straight in (sets the session cookies).
  const supabase = await getSupabaseServerClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) return { error: signInErr.message };

  // Best-effort welcome email (Spec Section 10). Intentionally NOT awaited: a
  // slow or misconfigured SMTP relay must never delay the signup response.
  // sendWelcomeEmail catches its own errors and no-ops when SMTP is unset.
  void sendWelcomeEmail({ email });

  redirect('/account');
}

/** Sign out and return to home. Safe to call even without a session. */
export async function signOutAction(): Promise<void> {
  const supabase = await getSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/');
}
