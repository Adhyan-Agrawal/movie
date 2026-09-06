import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { MediaCard } from '@/features/catalog/components/MediaCard';
import { listWatchlistTitles } from '@/features/watchlist/queries';

export const metadata: Metadata = { title: 'Watchlist' };

/** Account watchlist (Spec Sections 4, 8): the signed-in viewer's saved titles. */
export default async function WatchlistPage() {
  const titles = await listWatchlistTitles();

  return (
    <section aria-labelledby="watchlist-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="watchlist-heading" className="text-lg font-semibold">
          Your watchlist
        </h2>
        <p className="text-sm text-content-muted">
          Titles you save to watch later{titles.length ? ` — ${titles.length} saved` : ''}.
        </p>
      </div>

      {titles.length === 0 ? (
        <EmptyState
          icon="＋"
          title="Your watchlist is empty"
          description="Browse the catalog and tap Watchlist on any title to save it here."
          action={
            <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
              Browse the catalog
            </Link>
          }
        />
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {titles.map((title) => (
            <li key={title.id}>
              <MediaCard title={title} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
