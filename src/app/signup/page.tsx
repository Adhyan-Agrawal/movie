import type { Metadata } from 'next';
import Link from 'next/link';
import { Container } from '@/components/ui/Container';
import { buttonClasses } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { SignUpForm } from '@/features/auth/SignUpForm';

export const metadata: Metadata = {
  title: 'Create account',
  robots: { index: false, follow: false },
};

/** Sign-up route (Spec Section 8). Noindex, centered card, server-action form. */
export default function SignUpPage() {
  return (
    <Container className="pb-16">
      <div className="mx-auto flex max-w-md flex-col gap-6 py-12">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <Link href="/" className="flex items-center gap-2 font-display text-2xl font-bold" aria-label="Lumora home">
            <Logo size={28} />
            <span>Lumora</span>
          </Link>
          <h1 className="text-xl font-semibold text-content">Create your Lumora account</h1>
          <p className="text-sm text-content-muted">
            One account for your profiles, watchlist, and viewing history.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface/40 p-6">
          <SignUpForm />
        </div>

        <Link href="/" className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'self-center' })}>
          Back to home
        </Link>
      </div>
    </Container>
  );
}
