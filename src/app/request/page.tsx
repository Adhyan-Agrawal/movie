import type { Metadata } from 'next';
import Link from 'next/link';
import { Container } from '@/components/ui/Container';
import { buttonClasses } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { RequestForm } from '@/features/catalog/components/RequestForm';

export const metadata: Metadata = {
  title: 'Request a title',
  robots: { index: false, follow: false },
};

/**
 * Request-a-title route (Spec Section 4). Noindex, centered card mirroring the
 * sign-up page structure. The form needs a signed-in session; the action tells
 * anonymous visitors to sign in rather than blocking the route itself.
 */
export default function RequestPage() {
  return (
    <Container className="pb-16">
      <div className="mx-auto flex max-w-md flex-col gap-6 py-12">
        <div className="flex flex-col items-center gap-1.5 text-center">
          <Link href="/" className="flex items-center gap-2 font-display text-2xl font-bold" aria-label="Lumora home">
            <Logo size={28} />
            <span>Lumora</span>
          </Link>
          <h1 className="text-xl font-semibold text-content">Request a movie or series</h1>
          <p className="text-sm text-content-muted">Can&apos;t find something? Tell us and we&apos;ll add it.</p>
        </div>

        <div className="rounded-lg border border-border bg-surface/40 p-6">
          <RequestForm />
        </div>

        <Link
          href="/search"
          className={buttonClasses({ variant: 'ghost', size: 'sm', className: 'self-center' })}
        >
          Back to search
        </Link>
      </div>
    </Container>
  );
}
