'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';

/**
 * Watch route error boundary (Spec Section 3). Recoverable via `reset`. This
 * catches failures while preparing the player shell; provider-level failures
 * are handled in-surface by PlayerShell's unavailable state instead.
 */
export default function WatchError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Structured client logging (Spec Section 6). Redact anything sensitive.
    console.error('Watch route error', { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <Container className="py-16">
      <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
        <div aria-hidden="true" className="text-3xl text-danger">
          ⚠
        </div>
        <h1 className="text-xl font-semibold">We couldn’t start playback</h1>
        <p className="text-sm text-content-muted">
          Something went wrong preparing the player. This is usually temporary — try again.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button type="button" className={buttonClasses({ variant: 'primary' })} onClick={reset}>
            Try again
          </button>
          <Link href="/" className={buttonClasses({ variant: 'secondary' })}>
            Back to home
          </Link>
        </div>
      </div>
    </Container>
  );
}
