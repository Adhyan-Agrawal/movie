import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Container } from '@/components/ui/Container';
import { buttonClasses } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { SignInForm } from '@/features/auth/SignInForm';
import { features } from '@/lib/env';
import { ACCOUNT_SERVICES_UNAVAILABLE } from '@/features/account/availability';
import { getVerifiedAccount } from '@/features/auth/verified-account';
import { safeAuthReturnPath } from '@/features/auth/return-path';
import { AUTH_EMAIL_UNVERIFIED, AUTH_SERVICE_UNAVAILABLE } from '@/features/auth/state';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

/**
 * Sign-in route (Spec Section 8). Auth surfaces are noindex and render a
 * centered card; the form is a client component backed by a server action.
 * `?next=` (internal paths only — enforced in the action) bounces the user back
 * to where they were sent from (e.g. the account unauthorized state).
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; confirmed?: string | string[]; email?: string | string[]; auth?: string | string[] }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeAuthReturnPath(first(params.next));
  const confirmed = first(params.confirmed);
  const email = first(params.email);
  const account = await getVerifiedAccount();
  // Do not hide a failed logout or callback behind an existing session redirect.
  if (account.status === 'authenticated' && !['unavailable', 'callback', 'unverified'].includes(first(params.auth) ?? '')) redirect(next);
  const initialError = account.status === 'unverified' ? AUTH_EMAIL_UNVERIFIED
    : account.status === 'unavailable' ? AUTH_SERVICE_UNAVAILABLE : undefined;

  return (
    <Container className="pb-16">
      <div className="mx-auto flex max-w-md flex-col gap-6 py-12">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <Link href="/" className="flex items-center gap-2 font-display text-2xl font-bold" aria-label="Lumora home">
            <Logo size={28} />
            <span>Lumora</span>
          </Link>
          <h1 className="text-xl font-semibold text-content">{features.supabaseConfigured ? 'Sign in to Lumora' : 'Accounts are unavailable'}</h1>
          <p className="text-sm text-content-muted">
            {features.supabaseConfigured ? 'Your profiles, watchlist, and history - right where you left off.' : 'Public browsing and guest playback remain available.'}
          </p>
        </div>

        {features.supabaseConfigured && confirmed ? (
          <p role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            Check <span className="font-semibold">{email ?? 'your inbox'}</span> to confirm your email, then sign
            in.
          </p>
        ) : null}

        <div className="rounded-lg border border-border bg-surface/40 p-6">
          {features.supabaseConfigured ? <SignInForm next={next} initialError={initialError} /> : <p role="status" className="text-sm leading-relaxed text-content-muted">{ACCOUNT_SERVICES_UNAVAILABLE}</p>}
        </div>

        <Link href="/" className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'self-center' })}>
          Back to home
        </Link>
      </div>
    </Container>
  );
}
