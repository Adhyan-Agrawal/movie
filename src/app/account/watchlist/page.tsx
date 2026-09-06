import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { MediaCard } from '@/features/catalog/components/MediaCard';
import { getTitleById } from '@/features/catalog/queries';
import type { Title } from '@/features/catalog/types';
import { MOCK_WATCHLIST_IDS } from '@/features/account/mock';

export const metadata: Metadata = { title: 'Watchlist' };

export default async function WatchlistPage() {
  const resolved = await Promise.all(MOCK_WATCHLIST_IDS.map((id) => getTitleById(id)));
  const titles = resolved.filter((title): title is Title => title !== null);

  return (
    <section aria-labelledby="watchlist-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="watchlist-heading" className="text-lg font-semibold">
          Your watchlist
        </h2>
        <p className="text-sm text-content-muted">
          {titles.length} {titles.length === 1 ? 'title' : 'titles'} saved to watch later.
        </p>
      </div>

      {titles.length === 0 ? (
        <EmptyState
          icon="＋"
          title="Your watchlist is empty"
          description="Add movies and shows to keep track of what you want to watch."
          action={
            <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
              Browse the catalog
            </Link>
          }
        />
      ) : (
        <div className="flex flex-wrap gap-4">
          {titles.map((title) => (
            <MediaCard key={title.id} title={title} />
          ))}
        </div>
      )}
    </section>
  );
}
