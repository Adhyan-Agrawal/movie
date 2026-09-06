'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { buttonClasses } from '@/components/ui/Button';

/**
 * Route error boundary (Section 3). Recoverable via reset. Permission denials
 * (Section 8) get a 403-style message instead of the generic failure UI.
 */
export default function HomeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Structured client logging hook (Section 6). Redact anything sensitive.
    console.error('Home route error', { message: error.message, digest: error.digest });
  }, [error]);

  // `PermissionDeniedError` is thrown server-side by requirePermission; its
  // module is server-only (next/headers), so the class can't be imported into
  // this client component — match on the error name instead.
  const permissionDenied = error.name === 'PermissionDeniedError';

  if (permissionDenied) {
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-sm text-content-muted">
          Your account doesn’t have permission to view this page. If you believe this is a mistake, contact a Lumora
          administrator.
        </p>
        <Link href="/" className={buttonClasses({ variant: 'primary' })}>
          Back to home
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-content-muted">
        We couldn’t load this page. This is usually temporary — try again.
      </p>
      <button className={buttonClasses({ variant: 'primary' })} onClick={reset}>
        Try again
      </button>
    </div>
  );
}
