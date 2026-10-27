import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { features, publicEnv } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/supabase/types';

/** Authorization headers take precedence: a bad bearer never falls back to cookies. */
export async function commerceIdentity(request?: Request) {
  if (!features.supabaseConfigured) throw new Error('Commerce is unavailable.');
  const authorization = request?.headers.get('authorization');
  const token = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i)?.[1];
  if (authorization !== null && authorization !== undefined && !token) throw new Error('Invalid authorization.');
  const db = token ? createClient<Database>(publicEnv.NEXT_PUBLIC_SUPABASE_URL!, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  }) : await getSupabaseServerClient();
  const { data, error } = token ? await db.auth.getUser(token) : await db.auth.getUser();
  if (error) {
    if (!token && error.name === 'AuthSessionMissingError') return { db, user: null };
    throw new Error('Unable to verify viewer identity.');
  }
  if (token && !data.user) throw new Error('Invalid authorization.');
  return { db, user: data.user };
}
