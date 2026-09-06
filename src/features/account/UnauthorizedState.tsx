import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Reusable "not signed in" panel (Section 0: every feature needs an
 * unauthorized state). Auth routes are not built yet, so both actions link to
 * the home route as a safe placeholder.
 */
export function UnauthorizedState({ className }: { className?: string }) {
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
        <Link href="/" className={buttonClasses({ variant: 'primary' })}>
          Sign in
        </Link>
        <Link href="/" className={buttonClasses({ variant: 'ghost' })}>
          Back to home
        </Link>
      </div>
      <p className="text-xs text-content-subtle">Sign-in routes aren’t available in this build yet.</p>
    </div>
  );
}
