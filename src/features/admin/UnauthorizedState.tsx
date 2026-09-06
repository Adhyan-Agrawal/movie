import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Server-rendered "no admin access" panel (Section 8). Rendered by the admin
 * layout when the caller holds none of the console permissions — including
 * anonymous visitors and the Supabase-unconfigured mock mode. Follows the
 * account area's UnauthorizedState pattern, but keeps 403 semantics: it never
 * enumerates which permissions guard the console.
 */
export function AdminUnauthorizedState({ className }: { className?: string }) {
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
        <h2 className="text-lg font-semibold">Admin access required</h2>
        <p className="max-w-sm text-sm text-content-muted">
          The Lumora admin console is restricted to authorized staff accounts. Sign in with an account that has been
          granted admin access to continue.
        </p>
      </div>
      <Link href="/" className={buttonClasses({ variant: 'primary' })}>
        Back to home
      </Link>
    </div>
  );
}
