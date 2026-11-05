'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/cn';
import { setRatingAction, removeRatingAction } from '@/features/catalog/ratings-actions';
import { ACCOUNT_SERVICES_UNAVAILABLE } from '@/features/account/availability';

/**
 * Community rating + per-viewer rating control (Spec Sections 4, 7).
 *
 * Five star buttons map to a 1–10 scale (each star = 2 points) so the control
 * stays compact; the aggregate shows the community average and count. Signed-in
 * viewers can rate / change / clear; signed-out visitors see the aggregate and
 * a hint to sign in. Uses server actions — no client database access.
 */

const STARS = [1, 2, 3, 4, 5];

export function RatingControl({
  titleId,
  initialMyRating,
  average,
  count,
  available = true,
}: {
  titleId: string;
  initialMyRating: number | null;
  average: number | null;
  count: number;
  available?: boolean;
}) {
  const [myRating, setMyRating] = useState<number | null>(initialMyRating);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function set(value: number) {
    if (!available || pending) return;
    startTransition(async () => {
      try {
      const result = await setRatingAction(titleId, value);
      if (result.ok) {
        setMyRating(value);
        setMessage(null);
      } else {
        setMessage(result.message ?? 'Could not save your rating.');
      }
      } catch { setMessage(ACCOUNT_SERVICES_UNAVAILABLE); }
    });
  }

  function clear() {
    if (!available || pending) return;
    startTransition(async () => {
      try {
      const result = await removeRatingAction(titleId);
      if (result.ok) setMyRating(null);
      else setMessage(result.message ?? 'Could not remove your rating.');
      } catch { setMessage(ACCOUNT_SERVICES_UNAVAILABLE); }
    });
  }

  const filledStars = myRating != null ? Math.round(myRating / 2) : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-content">
          {average != null ? (
            <>
              <span aria-hidden="true">★</span> {average.toFixed(1)}
            </>
          ) : (
            <span className="text-content-muted">Not rated yet</span>
          )}
        </span>
        <span className="text-xs text-content-muted">
          {count} rating{count === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Rate this title out of 10">
        {STARS.map((star) => {
          const value = star * 2;
          return (
            <button
              key={star}
              type="button"
              disabled={pending || !available}
              title={!available ? ACCOUNT_SERVICES_UNAVAILABLE : undefined}
              onClick={() => set(value)}
              aria-label={`Rate ${value} out of 10`}
              aria-pressed={myRating === value}
              className={cn(
                'grid h-8 w-8 place-items-center rounded text-lg transition-colors',
                'disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                star <= filledStars
                  ? 'text-primary hover:text-primary'
                  : 'text-content-subtle hover:text-content-muted',
              )}
            >
              ★
            </button>
          );
        })}
        {myRating != null ? (
          <span className="ml-1 text-xs text-content-muted" aria-hidden="true">
            Your rating: {myRating}/10
          </span>
        ) : null}
      </div>

      {message ? (
        <p role="alert" className="text-xs text-danger">
          {message}
        </p>
      ) : null}
      {!available ? <p role="status" className="text-xs text-content-muted">Personal ratings unavailable.</p> : null}

      {myRating != null ? (
        <button
          type="button"
          onClick={clear}
          disabled={pending || !available}
          className="self-start text-xs text-content-muted underline-offset-2 hover:text-content hover:underline"
        >
          Clear my rating
        </button>
      ) : null}
    </div>
  );
}
