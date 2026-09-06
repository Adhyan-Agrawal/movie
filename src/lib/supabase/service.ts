import { createClient } from '@supabase/supabase-js';

import { publicEnv, serverEnv } from '@/lib/env';
import type { Database } from './types';

/**
 * Service-role Supabase client (Section 6) — SERVER ONLY.
 *
 * WARNING: this client authenticates with the service-role key and therefore
 * BYPASSES Row Level Security. Use it only for trusted background work —
 * webhooks, scheduled jobs, imports, health checks — never in response to
 * unvalidated user input, and never in a client bundle. Prefer the RLS-scoped
 * `./server` client for anything acting on behalf of a user.
 *
 * The `server-only` package is not installed in this project, so we use a
 * runtime guard: importing this module in the browser throws immediately.
 */
if (typeof window !== 'undefined') {
  throw new Error(
    'src/lib/supabase/service.ts is server-only and must never be imported ' +
      'into a client bundle (it holds a service-role key that bypasses RLS).',
  );
}

/**
 * Concrete (non-overloaded) wrapper around `createClient` so we can name the
 * exact returned client type. This avoids a `SupabaseClient` generic-arity
 * mismatch between the installed `@supabase/supabase-js` type overloads.
 */
function makeServiceClient(url: string, serviceRoleKey: string) {
  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export type SupabaseServiceClient = ReturnType<typeof makeServiceClient>;

let cached: SupabaseServiceClient | undefined;

/**
 * Returns a memoised service-role client. Throws with a descriptive message if
 * the URL or service-role key is missing.
 */
export function getSupabaseServiceClient(): SupabaseServiceClient {
  if (cached) return cached;

  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is required for the service client.');
  }

  const serviceRoleKey = serverEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. The service-role client cannot be ' +
        'created; use it only where a service key is intentionally provisioned.',
    );
  }

  cached = makeServiceClient(url, serviceRoleKey);
  return cached;
}
