import Link from 'next/link';
import { cn } from '@/lib/cn';

/**
 * Next/previous episode navigation for the watch page (Spec Section 9).
 *
 * Server-rendered: prev/next are plain internal links computed from the real
 * episode index, so they work without JS and never duplicate the player's
 * state. Rendered only for TV titles that are deep-linked into a specific
 * episode; the buttons render disabled at the first/last episode.
 */

export interface EpisodeNavTarget {
  season: number;
  episode: number;
  /** Short label for the aria-live region, e.g. "S1 E2". */
  label: string;
}

const navClasses =
  'flex h-11 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors ' +
  'disabled:cursor-not-allowed';

const enabledClasses = 'border-border bg-surface/60 text-content hover:border-border-strong hover:bg-surface-raised';
const disabledClasses = 'pointer-events-none border-border bg-surface/30 text-content-subtle';

function NavLink({
  direction,
  target,
  baseHref,
}: {
  direction: 'prev' | 'next';
  target: EpisodeNavTarget | undefined;
  baseHref: string;
}) {
  const className = cn(navClasses, target ? enabledClasses : disabledClasses);
  const label = direction === 'prev' ? 'Previous' : 'Next';
  const targetLabel = target?.label ?? 'none available';

  if (!target) {
    return (
      <span aria-label={`${label} episode (${targetLabel})`} className={className} role="button" aria-disabled="true">
        {direction === 'prev' ? (
          <>
            <span aria-hidden="true">←</span> {label}
          </>
        ) : (
          <>
            {label} <span aria-hidden="true">→</span>
          </>
        )}
      </span>
    );
  }

  return (
    <Link
      aria-label={`${label} episode (${targetLabel})`}
      href={`${baseHref}?season=${target.season}&episode=${target.episode}`}
      className={className}
    >
      {direction === 'prev' ? (
        <>
          <span aria-hidden="true">←</span> {label}
        </>
      ) : (
        <>
          {label} <span aria-hidden="true">→</span>
        </>
      )}
    </Link>
  );
}

export function EpisodeNavLinks({
  baseHref,
  current,
  previous,
  next,
}: {
  /** e.g. `/watch/tv/{slug}` — season/episode params are appended. */
  baseHref: string;
  current: EpisodeNavTarget;
  previous?: EpisodeNavTarget;
  next?: EpisodeNavTarget;
}) {
  return (
    <nav aria-label="Episode navigation" className="flex items-center gap-2">
      <NavLink direction="prev" target={previous} baseHref={baseHref} />
      <span
        aria-hidden="true"
        className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-content-muted"
      >
        {current.label}
      </span>
      <NavLink direction="next" target={next} baseHref={baseHref} />
    </nav>
  );
}
