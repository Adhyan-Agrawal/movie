import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { MediaCard } from './MediaCard';
import type { Title } from '../types';

/**
 * Responsive results grid (Section 4: browse "result counts, reset, no-result
 * guidance"). Renders a polite live region announcing the total match count and
 * an accessible {@link EmptyState} with a Reset action when nothing matches.
 *
 * `titles` is the current page slice; `totalCount` is the full match count so
 * the announced number reflects every result, not just the visible page.
 */
export function TitleGrid({
  titles,
  totalCount,
  resetHref,
}: {
  titles: Title[];
  totalCount: number;
  resetHref: string;
}) {
  return (
    <section aria-labelledby="results-heading" className="flex flex-col gap-4">
      <h2 id="results-heading" className="sr-only">
        Results
      </h2>
      <p role="status" aria-live="polite" className="text-sm text-content-muted">
        {totalCount === 0
          ? 'No titles match these filters'
          : `${totalCount} ${totalCount === 1 ? 'title' : 'titles'}`}
      </p>

      {titles.length === 0 ? (
        <EmptyState
          icon="✧"
          title="No titles match these filters"
          description="Try a different genre, decade, or rating — or reset to see the full catalog."
          action={
            <Link href={resetHref} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              Reset filters
            </Link>
          }
        />
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {titles.map((title) => (
            <li key={title.id}>
              {/* Override MediaCard's fixed track width so cards fill the grid cell. */}
              <MediaCard title={title} className="w-full sm:w-full md:w-full" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
