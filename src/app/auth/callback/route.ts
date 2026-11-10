import { NextResponse } from 'next/server';
import { features, publicEnv } from '@/lib/env';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { authCallbackUrl, safeAuthReturnPath } from '@/features/auth/return-path';
import { isAuthServiceFailure, verifyAccount } from '@/features/auth/verified-account';
import { AUTH_CONFIGURATION_UNAVAILABLE } from '@/features/auth/state';

export const dynamic = 'force-dynamic';

/** Supabase's PKCE confirmation exchange writes the session through SSR cookies. */
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
  const callback = authCallbackUrl(publicEnv.NEXT_PUBLIC_APP_URL);
  if (!callback) return NextResponse.json({ error: AUTH_CONFIGURATION_UNAVAILABLE }, { status: 503, headers });

  const params = new URL(request.url).searchParams;
  const next = safeAuthReturnPath(params.get('next') ?? undefined);
  const finish = (auth?: 'callback' | 'unavailable' | 'unverified') => {
    const destination = new URL(auth ? '/signin' : next, callback.origin);
    if (auth) {
      destination.searchParams.set('auth', auth);
      destination.searchParams.set('next', next);
    }
    return NextResponse.redirect(destination, { status: 303, headers });
  };
  if (!features.supabaseConfigured) return finish('unavailable');
  const codes = params.getAll('code');
  if (params.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 2048) return finish('callback');

  try {
    const client = await getSupabaseServerClient();
    const { data, error } = await client.auth.exchangeCodeForSession(codes[0]);
    if (error) return finish(isAuthServiceFailure(error) || [401, 403, 429].includes(error.status ?? 0) ? 'unavailable' : 'callback');
    if (!data.user || !data.session) return finish('unavailable');
    const account = await verifyAccount(client);
    if (account.status === 'unverified') {
      const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
      return finish(signOutError ? 'unavailable' : 'unverified');
    }
    if (account.status !== 'authenticated' || account.user.id !== data.user.id) return finish('unavailable');
    return finish();
  } catch {
    return finish('unavailable');
  }
}
