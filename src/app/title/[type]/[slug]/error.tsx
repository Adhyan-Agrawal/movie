'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';

/** Title-scoped error boundary (Section 3). Recoverable via reset. */
export default function TitleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Structured client logging hook (Section 6). Redact anything sensitive.
    console.error('Title detail route error', { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">This title didn’t load</h1>
      <p className="text-sm text-content-muted">
        Something went wrong while loading this title. This is usually temporary — try again.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button className={buttonClasses({ variant: 'primary' })} onClick={reset}>
          Try again
        </button>
        <Link href="/browse" className={buttonClasses({ variant: 'secondary' })}>
          Browse the catalog
        </Link>
      </div>
    </div>
  );
}
