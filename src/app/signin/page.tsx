import type { Metadata } from 'next';
import Link from 'next/link';
import { Container } from '@/components/ui/Container';
import { buttonClasses } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { SignInForm } from '@/features/auth/SignInForm';

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
  searchParams: Promise<{ next?: string | string[]; confirmed?: string | string[]; email?: string | string[] }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = first(params.next);
  const confirmed = first(params.confirmed);
  const email = first(params.email);

  return (
    <Container className="pb-16">
      <div className="mx-auto flex max-w-md flex-col gap-6 py-12">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <Link href="/" className="flex items-center gap-2 font-display text-2xl font-bold" aria-label="Lumora home">
            <Logo size={28} />
            <span>Lumora</span>
          </Link>
          <h1 className="text-xl font-semibold text-content">Sign in to Lumora</h1>
          <p className="text-sm text-content-muted">
            Your profiles, watchlist, and history — right where you left off.
          </p>
        </div>

        {confirmed ? (
          <p role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
            Check <span className="font-semibold">{email ?? 'your inbox'}</span> to confirm your email, then sign
            in.
          </p>
        ) : null}

        <div className="rounded-lg border border-border bg-surface/40 p-6">
          <SignInForm next={next} />
        </div>

        <Link href="/" className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'self-center' })}>
          Back to home
        </Link>
      </div>
    </Container>
  );
}
