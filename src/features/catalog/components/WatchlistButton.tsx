'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import { toggleWatchlistAction } from '@/features/watchlist/actions';

/**
 * Watchlist toggle (Spec Section 4). Optimistic UI backed by the real
 * `watchlists`/`watchlist_items` tables through a permission-scoped server
 * action; rolls back on failure. Anonymous viewers get a sign-in link (the
 * watchlist is an authenticated feature — Section 8).
 */
export function WatchlistButton({
  titleId,
  titleName,
  initialInWatchlist = false,
  size = 'lg',
  className,
}: {
  titleId: string;
  titleName: string;
  initialInWatchlist?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const [inList, setInList] = useState(initialInWatchlist);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const pathname = usePathname();

  function toggle() {
    const target = !inList;
    setInList(target); // optimistic
    setNeedsSignIn(false);
    setFailed(false);
    startTransition(async () => {
      const result = await toggleWatchlistAction(titleId, !target);
      if (!result.ok) {
        setInList(!target); // roll back
        if (!result.signedIn) setNeedsSignIn(true);
        else setFailed(true);
      } else {
        setInList(result.inWatchlist);
      }
    });
  }

  const signinHref = `/signin?next=${encodeURIComponent(pathname)}`;

  return (
    <span className="relative inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={inList}
        aria-label={inList ? `Remove ${titleName} from your watchlist` : `Add ${titleName} to your watchlist`}
        className={cn(
          buttonClasses({ variant: 'secondary', size }),
          inList && 'border-primary/50 text-content',
          className,
        )}
      >
        <span aria-hidden="true">{inList ? '✓' : '+'}</span>
        {inList ? 'In Watchlist' : 'Watchlist'}
      </button>
      {needsSignIn ? (
        <span className="text-xs text-content-muted" role="status">
          <Link href={signinHref} className="text-primary hover:underline">
            Sign in
          </Link>{' '}
          to save titles to your watchlist.
        </span>
      ) : null}
      {failed ? (
        <span className="text-xs text-danger" role="alert">
          Couldn&apos;t update your watchlist. Try again.
        </span>
      ) : null}
    </span>
  );
}
