import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { publicEnv } from '@/lib/env';
import type { Database } from './types';

type CookieMethods = NonNullable<Parameters<typeof createServerClient>[2]>['cookies'];

/**
 * Concrete (non-overloaded) wrapper around `createServerClient` so we can name
 * the exact returned client type. This avoids a `SupabaseClient` generic-arity
 * mismatch between the installed `@supabase/ssr` and `@supabase/supabase-js`.
 */
function makeServerClient(url: string, anonKey: string, cookieMethods: CookieMethods) {
  return createServerClient<Database>(url, anonKey, { cookies: cookieMethods });
}

export type SupabaseServerClient = ReturnType<typeof makeServerClient>;

/**
 * Server Supabase client (Section 6).
 *
 * Wired to Next's request cookies so the user's session travels with server
 * components, route handlers, and server actions. In Next 15 `cookies()` is
 * async, so this factory is async too. Uses the public anon key — RLS still
 * applies, scoped to the signed-in user. For privileged jobs that must bypass
 * RLS use `./service` instead.
 */
export async function getSupabaseServerClient(): Promise<SupabaseServerClient> {
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY before using the server client.',
    );
  }

  const cookieStore = await cookies();

  return makeServerClient(url, anonKey, {
    getAll() {
      return cookieStore.getAll();
    },
    setAll(cookiesToSet) {
      try {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      } catch {
        // `setAll` was called from a Server Component where the cookie store is
        // read-only. Session refresh is handled by middleware instead; this is
        // safe to ignore per the Supabase SSR guidance.
      }
    },
  });
}
