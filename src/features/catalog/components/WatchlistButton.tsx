'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';

/**
 * Optimistic watchlist toggle (Spec Section 4). Local state only for now —
 * `aria-pressed` reflects membership for assistive tech. Persistence is a TODO:
 * once auth + `watchlist_items` exist (Section 7, Phase 3) this fires a mutation
 * and rolls back + toasts on failure.
 */
export function WatchlistButton({
  titleName,
  initialInWatchlist = false,
  size = 'lg',
  className,
}: {
  titleName: string;
  initialInWatchlist?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const [inList, setInList] = useState(initialInWatchlist);

  return (
    <button
      type="button"
      onClick={() => setInList((v) => !v)}
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
  );
}
