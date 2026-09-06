import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session-refresh middleware (Spec Section 6).
 *
 * Server Components cannot write cookies, so the server Supabase client
 * (`src/lib/supabase/server.ts`) intentionally swallows cookie writes and
 * relies on THIS middleware to rotate the auth session. On every matched
 * request we construct a request-scoped Supabase client, call `getUser()` to
 * refresh an expiring access token, and forward any refreshed auth cookies onto
 * both the request (for downstream Server Components in the same pass) and the
 * response (so the browser stores them).
 *
 * If Supabase isn't configured yet (local UI work), we no-op and pass through.
 *
 * NOTE: this does not yet enforce route authorization — protected admin/account
 * routes gate via `requirePermission` in their own server components + RLS. This
 * middleware only keeps the session fresh.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Supabase not configured — nothing to refresh.
  if (!url || !anonKey) {
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
  try {
    await supabase.auth.getUser();
  } catch {
    // Ignore; the request proceeds unauthenticated and downstream RLS/guards apply.
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
