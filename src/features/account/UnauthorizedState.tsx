import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { ACCOUNT_SERVICES_UNAVAILABLE } from './availability';
import { AUTH_EMAIL_UNVERIFIED } from '@/features/auth/state';

/**
 * Reusable "not signed in" panel (Section 0: every feature needs an
 * unauthorized state). Links to the real sign-in / sign-up routes.
 */
export function UnauthorizedState({ className, next, unavailable = false, unverified = false }: { className?: string; next?: string; unavailable?: boolean; unverified?: boolean }) {
  const signinHref = next ? `/signin?next=${encodeURIComponent(next)}` : '/signin';
  const signupHref = next ? `/signup?next=${encodeURIComponent(next)}` : '/signup';

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
        <h2 className="text-lg font-semibold">{unavailable ? 'Accounts are unavailable' : unverified ? 'Confirm your email' : 'Sign in to continue'}</h2>
        <p className="max-w-sm text-sm text-content-muted">
          {unavailable ? ACCOUNT_SERVICES_UNAVAILABLE : unverified ? AUTH_EMAIL_UNVERIFIED : 'Your profiles, watchlist, history, and preferences live in your Lumora account. Sign in to pick up right where you left off.'}
        </p>
      </div>
      {unavailable ? <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>Browse titles</Link> : <div className="flex flex-wrap items-center justify-center gap-2">
        <Link href={signinHref} className={buttonClasses({ variant: 'primary' })}>
          Sign in
        </Link>
        <Link href={signupHref} className={buttonClasses({ variant: 'secondary' })}>
          Create account
        </Link>
      </div>}
    </div>
  );
}
