import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session-refresh + admin-gate middleware (Spec Sections 6, 8).
 *
 * Session refresh: Server Components cannot write cookies, so the server
 * Supabase client (`src/lib/supabase/server.ts`) intentionally swallows cookie
 * writes and relies on THIS middleware to rotate the auth session. On every
 * matched request we construct a request-scoped Supabase client, call
 * `getUser()` to refresh an expiring access token, and forward any refreshed
 * auth cookies onto both the request and the response.
 *
 * Admin gate: /admin is authorized HERE, before any rendering starts, so that
 * unauthorized requests get a genuine HTTP 404. (A `notFound()` thrown inside
 * the admin layout still renders the not-found UI, but the segment has a
 * `loading.tsx` streaming boundary — the 200 status is already sent by the time
 * the check resolves, and a 200 would confirm the console exists.) We rewrite
 * to an unmatched path instead of redirecting, so the URL stays `/admin` and
 * the response is indistinguishable from a route that never existed.
 *
 * If Supabase isn't configured (mock mode), every admin check fails closed.
 */

/** Any one of these grants console entry — mirrors ADMIN_PERMISSIONS in the admin layout. */
const ADMIN_PERMISSION_KEYS = [
  'catalog.read',
  'users.read',
  'settings.manage',
  'analytics.read',
  'audit.read',
  'provider.manage',
  'ads.manage',
  'roles.manage',
] as const;

/** An unmatched path: rewriting here yields the standard 404 + not-found page. */
const NOT_FOUND_PATH = '/-not-found';

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Supabase not configured — nothing to refresh, and every admin check fails closed.
  if (!url || !anonKey) {
    if (request.nextUrl.pathname.startsWith('/admin')) {
      return NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url));
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Write to the request (for this pass) and re-create the response so the
        // refreshed cookies are sent to the browser.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() triggers the token refresh + setAll() above when needed.
  // Never throw out of middleware — a transient auth error must not 500 the app.
  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch {
    // Ignore; the request proceeds unauthenticated and downstream RLS/guards apply.
  }

  // Admin gate (runs BEFORE rendering, so the 404 status is never streamed away).
  if (request.nextUrl.pathname.startsWith('/admin')) {
    let authorized = false;
    if (userId) {
      try {
        // Same 3-step resolution as `hasPermission` in check.ts (flat queries —
        // the nested-select type shape doesn't match PostgREST's embed output).
        // Runs under RLS with the user's session (self-readable memberships).
        const { data: memberships } = await supabase
          .from('account_members')
          .select('role_id')
          .eq('account_id', userId);
        const roleIds = (memberships ?? []).map((m) => m.role_id);

        if (roleIds.length > 0) {
          const { data: grants } = await supabase
            .from('role_permissions')
            .select('permission_id')
            .in('role_id', roleIds);
          const permissionIds = [...new Set((grants ?? []).map((g) => g.permission_id))];

          if (permissionIds.length > 0) {
            const { data: perms } = await supabase
              .from('permissions')
              .select('key')
              .in('id', permissionIds);
            const keys = new Set((perms ?? []).map((p) => p.key));
            authorized = ADMIN_PERMISSION_KEYS.some((k) => keys.has(k));
          }
        }
      } catch {
        authorized = false;
      }
    }
    if (!authorized) {
      return NextResponse.rewrite(new URL(NOT_FOUND_PATH, request.url));
    }
  }

  return response;
}

export const config = {
  /**
   * Run on everything except Next internals and the favicon. This canonical
   * matcher (no file-extension `$`-anchored alternation) avoids a Next 15
   * build-time page-collection bug that surfaced as PageNotFoundError on nested
   * routes. Static assets under _next are already excluded; other public files
   * are cheap to pass through and never carry an auth session.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
