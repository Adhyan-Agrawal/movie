import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Reusable "not signed in" panel (Section 0: every feature needs an
 * unauthorized state). Links to the real sign-in / sign-up routes.
 */
export function UnauthorizedState({ className, next }: { className?: string; next?: string }) {
  const signinHref = next ? `/signin?next=${encodeURIComponent(next)}` : '/signin';

  return (
    <div
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-4 rounded-lg border border-border',
        'bg-surface/40 px-6 py-16 text-center',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="grid h-14 w-14 place-items-center rounded-full border border-border bg-surface-raised text-2xl text-content-subtle"
      >
        🔒
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold">Sign in to continue</h2>
        <p className="max-w-sm text-sm text-content-muted">
          Your profiles, watchlist, history, and preferences live in your Lumora account. Sign in to pick up right
          where you left off.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link href={signinHref} className={buttonClasses({ variant: 'primary' })}>
          Sign in
        </Link>
        <Link href="/signup" className={buttonClasses({ variant: 'secondary' })}>
          Create account
        </Link>
      </div>
    </div>
  );
}
