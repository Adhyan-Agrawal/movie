import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export const metadata: Metadata = { title: 'Watchlist' };

export default function WatchlistPage() {
  // Watchlist persistence isn't wired yet — honest empty state, no mock titles.
  return (
    <section aria-labelledby="watchlist-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id="watchlist-heading" className="text-lg font-semibold">
          Your watchlist
        </h2>
        <p className="text-sm text-content-muted">Titles you save to watch later.</p>
      </div>

      <EmptyState
        icon="＋"
        title="Your watchlist is empty"
        description="Your watchlist is empty — browse the catalog to add titles."
        action={
          <Link href="/browse" className={buttonClasses({ variant: 'primary' })}>
            Browse the catalog
          </Link>
        }
      />
    </section>
  );
}
