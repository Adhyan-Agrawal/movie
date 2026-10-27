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
 * anonymous visitors go through password sign-in, while authenticated callers
 * without permission receive a clear 403 before protected rendering starts.
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
  'plans.manage',
  'billing.read',
] as const;

function signIn(request: NextRequest, previous?: NextResponse): NextResponse {
  const destination = new URL('/signin', request.url);
  destination.searchParams.set('next', request.nextUrl.pathname);
  const response = NextResponse.redirect(destination, request.method === 'GET' || request.method === 'HEAD' ? 307 : 303);
  for (const cookie of previous?.cookies.getAll() ?? []) response.cookies.set(cookie);
  return response;
}

function denyAdmin(request: NextRequest, previous?: NextResponse): NextResponse {
  const response = NextResponse.rewrite(new URL('/access-denied', request.url), { status: 403 });
  for (const cookie of previous?.cookies.getAll() ?? []) response.cookies.set(cookie);
  return response;
}

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const adminRequest = request.nextUrl.pathname === '/admin' || request.nextUrl.pathname.startsWith('/admin/');

  // Supabase not configured — nothing to refresh, and every admin check fails closed.
  if (!url || !anonKey) {
    if (adminRequest) return signIn(request);
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

  // Admin gate runs before rendering; query parameters never authorize entry.
  if (adminRequest) {
    if (!userId) return signIn(request, response);
    let authorized = false;
    if (userId) {
      try {
        const { data: account, error: accountError } = await supabase.from('accounts')
          .select('is_suspended').eq('id', userId).maybeSingle();
        if (accountError || !account || account.is_suspended) return denyAdmin(request, response);
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
      return denyAdmin(request, response);
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/media|api/vidnest|api/playback).*)'],
};
