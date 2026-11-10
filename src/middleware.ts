import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/supabase/types';

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

// These endpoints authenticate their own capabilities/origins or serve public metadata.
// Refreshing account sessions here would add Supabase traffic and contaminate cacheable responses.
const SESSION_INDEPENDENT_READS = new Set([
  '/api/catalog', '/api/trailer', '/api/subtitles', '/api/episode-navigation', '/api/watch-party',
  '/logo.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png',
]);

function sessionIndependent(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  return ((request.method === 'GET' || request.method === 'HEAD') && SESSION_INDEPENDENT_READS.has(pathname))
    || (request.method === 'POST' && pathname === '/api/watch-party');
}

function protectSessionResponse(response: NextResponse): void {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
}

function signIn(request: NextRequest, previous?: NextResponse): NextResponse {
  const destination = new URL('/signin', request.url);
  destination.searchParams.set('next', request.nextUrl.pathname);
  const response = NextResponse.redirect(destination, request.method === 'GET' || request.method === 'HEAD' ? 307 : 303);
  for (const cookie of previous?.cookies.getAll() ?? []) response.cookies.set(cookie);
  protectSessionResponse(response);
  return response;
}

function denyAdmin(request: NextRequest, previous?: NextResponse): NextResponse {
  const response = NextResponse.rewrite(new URL('/access-denied', request.url), { status: 403 });
  for (const cookie of previous?.cookies.getAll() ?? []) response.cookies.set(cookie);
  protectSessionResponse(response);
  return response;
}

export async function middleware(request: NextRequest) {
  if (sessionIndependent(request)) return NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const adminRequest = request.nextUrl.pathname === '/admin' || request.nextUrl.pathname.startsWith('/admin/');

  // Supabase not configured — nothing to refresh, and every admin check fails closed.
  if (!url || !anonKey) {
    if (adminRequest) return signIn(request);
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  let supabase: SupabaseClient<Database> | null = null;
  let userId: string | null = null;
  try {
    supabase = createServerClient<Database>(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Preserve earlier writes if the SDK rotates cookies more than once.
          const previousCookies = response.cookies.getAll();
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const cookie of previousCookies) response.cookies.set(cookie);
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          protectSessionResponse(response);
        },
      },
    });
    // getUser refreshes expiring cookies and verifies identity with the provider.
    const { data, error } = await supabase.auth.getUser();
    if (!error && data.user?.email && data.user.email_confirmed_at) userId = data.user.id;
  } catch {
    // Invalid configuration or an outage must not crash public browsing.
    // Admin remains denied, and account pages report their own truthful status.
  }

  // Admin gate runs before rendering; query parameters never authorize entry.
  if (adminRequest) {
    if (!userId || !supabase) return signIn(request, response);
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
