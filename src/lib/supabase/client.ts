import { createBrowserClient } from '@supabase/ssr';

import { features, publicEnv } from '@/lib/env';
import type { Database } from './types';

/**
 * Browser Supabase client (Section 6).
 *
 * Safe to import into client components. It uses only the *public* anon key and
 * URL. When Supabase is not configured the app runs in mock mode, so callers
 * should check {@link isSupabaseConfigured} first; calling the factory while
 * unconfigured throws a clear, descriptive error rather than constructing a
 * broken client.
 */

/** True when the public Supabase env vars are present (drives mock-mode fallback). */
export const isSupabaseConfigured: boolean = features.supabaseConfigured;

/**
 * Concrete (non-overloaded) wrapper around `createBrowserClient` so we can name
 * the exact returned client type. This avoids a `SupabaseClient` generic-arity
 * mismatch between the installed `@supabase/ssr` and `@supabase/supabase-js`.
 */
function makeBrowserClient(url: string, anonKey: string) {
  return createBrowserClient<Database>(url, anonKey);
}

export type SupabaseBrowserClient = ReturnType<typeof makeBrowserClient>;

let cached: SupabaseBrowserClient | undefined;

/**
 * Returns a memoised browser client. Throws if Supabase is unconfigured.
 */
export function getSupabaseBrowserClient(): SupabaseBrowserClient {
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local, or gate this call behind ' +
        '`isSupabaseConfigured` to keep mock mode working.',
    );
  }

  if (cached) return cached;
  cached = makeBrowserClient(url, anonKey);
  return cached;
}
