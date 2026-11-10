import 'server-only';

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { features, publicEnv } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/types';

export type VerifiedAccountResult =
  | { status: 'authenticated'; user: User; client: SupabaseClient<Database> }
  | { status: 'unauthenticated' | 'unverified' | 'unavailable' };

export function isAuthServiceFailure(error: { status?: number; name?: string }): boolean {
  return !error.status || error.status >= 500 || error.status === 408
    || error.name === 'AuthRetryableFetchError';
}

/** Verify the same client that just established a session, not cookie claims. */
export async function verifyAccount(
  client: SupabaseClient<Database>,
  token?: string,
): Promise<VerifiedAccountResult> {
  try {
    const { data, error } = token ? await client.auth.getUser(token) : await client.auth.getUser();
    if (error) {
      if (error.name === 'AuthSessionMissingError') return { status: 'unauthenticated' };
      if (isAuthServiceFailure(error)) return { status: 'unavailable' };
      if (error.code === 'email_not_confirmed') return { status: 'unverified' };
      if (error.name === 'AuthInvalidJwtError' || [
        'bad_jwt', 'invalid_jwt', 'no_authorization', 'user_not_found', 'session_not_found', 'session_expired',
        'refresh_token_not_found', 'refresh_token_already_used',
      ].includes(error.code ?? '')) return { status: 'unauthenticated' };
      return { status: 'unavailable' };
    }
    if (!data.user) return { status: 'unauthenticated' };
    if (!data.user.id) return { status: 'unavailable' };
    // confirmed_at can refer to a phone; user_metadata is user-editable.
    if (!data.user.email || !data.user.email_confirmed_at) return { status: 'unverified' };
    return { status: 'authenticated', user: data.user, client };
  } catch {
    return { status: 'unavailable' };
  }
}

/** A supplied Authorization header must never fall back to a cookie identity. */
export async function getVerifiedAccount(request?: Request): Promise<VerifiedAccountResult> {
  try {
    if (!features.supabaseConfigured) return { status: 'unavailable' };
    const authorization = request?.headers.get('authorization');
    const token = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i)?.[1];
    if (authorization != null && !token) return { status: 'unauthenticated' };

    const client = token ? createClient<Database>(
      publicEnv.NEXT_PUBLIC_SUPABASE_URL!, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      },
    ) : await getSupabaseServerClient();
    return verifyAccount(client, token);
  } catch {
    return { status: 'unavailable' };
  }
}
